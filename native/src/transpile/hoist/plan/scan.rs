//! Module scans for hoist-plan construction.

use super::super::super::*;
use super::super::usage::{collect_used_binding_ids, scan_namespace_usage};
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, ImportDeclarationSpecifier,
    ImportOrExportKind, ModuleExportName, Program as OxcProgram, Statement,
};

pub(super) const DEFAULT_EXPORT_LOCAL: &str = "__gcc_dflt";

#[derive(Clone, Debug, Default)]
pub(crate) struct ModuleScan {
    /// export name -> local top-level binding name
    pub(super) own_exports: BTreeMap<String, String>,
    /// export name -> (target module id, original export name on the target)
    pub(super) reexports: BTreeMap<String, (String, String)>,
    /// export name -> target module whose namespace object is the value
    pub(super) namespace_reexports: BTreeMap<String, String>,
    /// `export * from` targets, in source order
    pub(super) stars: Vec<String>,
    pub(super) import_edges: Vec<ImportEdge>,
    /// `export ... from` targets (execution + facade edges)
    pub(super) reexport_targets: Vec<String>,
    pub(super) scan_failed: bool,
    pub(super) local_export_modes: HashMap<String, BundlerExportSlotMode>,
    /// Local names of top-level declarations from which an assignment to a
    /// top-level binding of the same module is reachable through the
    /// module's internal reference graph (directly, or via helpers the
    /// declaration references).
    pub(super) live_assigners: BTreeSet<String>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct ImportEdge {
    pub(super) named: Vec<String>,
    pub(super) namespace: bool,
    /// Present when every use of the namespace binding is a plain member
    /// access; lists the accessed member names.
    pub(super) namespace_members: Option<BTreeSet<String>>,
    pub(super) target_module_id: String,
    /// Imported names whose local binding is actually referenced in the
    /// module body (as opposed to merely re-exported).
    pub(super) used_named: Vec<String>,
}

pub(super) fn scan_commonjs_module(
    file_path: &Path,
    analysis: &crate::commonjs::CommonJsAnalysis,
    resolution_context: &TranspileContext,
) -> ModuleScan {
    let mut scan = ModuleScan::default();
    scan.own_exports
        .insert("__cjsExports".to_string(), "__cjsExports".to_string());
    scan.own_exports
        .insert("default".to_string(), "__cjsExports".to_string());
    // The normalized CommonJS interop imports use reflection, which requires a
    // real require object; keep CommonJS modules with dependencies in registry form.
    if !analysis.dependencies.is_empty() {
        scan.scan_failed = true;
        for specifier in &analysis.dependencies {
            if let Ok(target) = resolve_module_id_for_specifier(
                file_path,
                &to_emitted_commonjs_specifier(specifier),
                resolution_context,
            ) {
                scan.import_edges.push(ImportEdge {
                    named: Vec::new(),
                    namespace: true,
                    namespace_members: None,
                    target_module_id: target,
                    used_named: Vec::new(),
                });
            }
        }
    }
    scan
}

pub(super) fn scan_esm_program(
    program: &OxcProgram<'_>,
    identity: &super::super::super::identity::ModuleIdentity,
    file_path: &Path,
    resolution_context: &TranspileContext,
) -> ModuleScan {
    let mut scan = ModuleScan::default();
    let mut import_locals = HashMap::<String, Option<(String, String)>>::new();
    let mut namespace_import_locals = HashMap::<String, String>::new();
    let namespace_usage = scan_namespace_usage(program, identity);
    let used_binding_ids = collect_used_binding_ids(program, identity);

    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                if import.import_kind == ImportOrExportKind::Type {
                    continue;
                }
                let Ok(target) = resolve_module_id_for_specifier(
                    file_path,
                    import.source.value.as_str(),
                    resolution_context,
                ) else {
                    scan.scan_failed = true;
                    continue;
                };
                let mut edge = ImportEdge {
                    target_module_id: target.clone(),
                    ..Default::default()
                };
                for specifier in import.specifiers.iter().flatten() {
                    match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(specifier)
                            if specifier.import_kind == ImportOrExportKind::Type => {}
                        ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                            let imported = module_export_name(&specifier.imported);
                            let local = specifier.local.name.to_string();
                            import_locals.insert(local, Some((target.clone(), imported.clone())));
                            if used_binding_ids.contains(&identity.key_of_binding(&specifier.local))
                            {
                                edge.used_named.push(imported.clone());
                            }
                            edge.named.push(imported);
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                            let local = specifier.local.name.to_string();
                            import_locals
                                .insert(local, Some((target.clone(), "default".to_string())));
                            if used_binding_ids.contains(&identity.key_of_binding(&specifier.local))
                            {
                                edge.used_named.push("default".to_string());
                            }
                            edge.named.push("default".to_string());
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                            let local = specifier.local.name.to_string();
                            import_locals.insert(local.clone(), None);
                            namespace_import_locals.insert(local, target.clone());
                            edge.namespace = true;
                            edge.namespace_members = namespace_usage
                                .member_only_usage(identity.key_of_binding(&specifier.local));
                        }
                    }
                }
                scan.import_edges.push(edge);
            }
            Statement::ExportNamedDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = &export.declaration {
                    for name in declaration_names(declaration) {
                        scan.own_exports.insert(name.clone(), name);
                    }
                }
                if let Some(source) = &export.source {
                    let Ok(target) = resolve_module_id_for_specifier(
                        file_path,
                        source.value.as_str(),
                        resolution_context,
                    ) else {
                        scan.scan_failed = true;
                        continue;
                    };
                    scan.reexport_targets.push(target.clone());
                    for specifier in &export.specifiers {
                        if specifier.export_kind == ImportOrExportKind::Type {
                            continue;
                        }
                        scan.reexports.insert(
                            module_export_name(&specifier.exported),
                            (target.clone(), module_export_name(&specifier.local)),
                        );
                    }
                } else {
                    for specifier in &export.specifiers {
                        if specifier.export_kind == ImportOrExportKind::Type {
                            continue;
                        }
                        let local = module_export_name(&specifier.local);
                        let export_name = module_export_name(&specifier.exported);
                        match import_locals.get(&local) {
                            Some(Some((target, imported))) => {
                                scan.reexports
                                    .insert(export_name, (target.clone(), imported.clone()));
                            }
                            Some(None) => {
                                let Some(target) = namespace_import_locals.get(&local) else {
                                    scan.scan_failed = true;
                                    continue;
                                };
                                scan.namespace_reexports.insert(export_name, target.clone());
                            }
                            None => {
                                scan.own_exports.insert(export_name, local);
                            }
                        }
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let local = match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        function.id.as_ref().map(|id| id.name.to_string())
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                        class.id.as_ref().map(|id| id.name.to_string())
                    }
                    _ => None,
                };
                if let Some((target, imported)) =
                    export.declaration.as_expression().and_then(|expression| {
                        let oxc_ast::ast::Expression::Identifier(identifier) = expression else {
                            return None;
                        };
                        import_locals
                            .get(identifier.name.as_str())
                            .and_then(Option::as_ref)
                    })
                {
                    scan.reexports
                        .insert("default".to_string(), (target.clone(), imported.clone()));
                    continue;
                }
                scan.own_exports.insert(
                    "default".to_string(),
                    local.unwrap_or_else(|| DEFAULT_EXPORT_LOCAL.to_string()),
                );
            }
            Statement::TSExportAssignment(_) => {
                scan.own_exports
                    .insert("default".to_string(), DEFAULT_EXPORT_LOCAL.to_string());
            }
            Statement::ExportAllDeclaration(export) => {
                let Ok(target) = resolve_module_id_for_specifier(
                    file_path,
                    export.source.value.as_str(),
                    resolution_context,
                ) else {
                    scan.scan_failed = true;
                    continue;
                };
                scan.reexport_targets.push(target.clone());
                if let Some(exported) = &export.exported {
                    scan.namespace_reexports
                        .insert(module_export_name(exported), target);
                } else {
                    scan.stars.push(target);
                }
            }
            _ => {}
        }
    }
    scan
}

fn declaration_names(declaration: &Declaration<'_>) -> Vec<String> {
    let mut names = Vec::new();
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            for declarator in &declaration.declarations {
                collect_pattern_names(&declarator.id, &mut names);
            }
        }
        Declaration::FunctionDeclaration(function) => {
            if let Some(id) = &function.id {
                names.push(id.name.to_string());
            }
        }
        Declaration::ClassDeclaration(class) => {
            if let Some(id) = &class.id {
                names.push(id.name.to_string());
            }
        }
        Declaration::TSEnumDeclaration(declaration) => {
            names.push(declaration.id.name.to_string());
        }
        Declaration::TSModuleDeclaration(declaration) => {
            if let oxc_ast::ast::TSModuleDeclarationName::Identifier(id) = &declaration.id {
                names.push(id.name.to_string());
            }
        }
        _ => {}
    }
    names
}

fn collect_pattern_names(pattern: &BindingPattern<'_>, names: &mut Vec<String>) {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => names.push(identifier.name.to_string()),
        BindingPattern::ArrayPattern(array) => {
            for pattern in array.elements.iter().flatten() {
                collect_pattern_names(pattern, names);
            }
            if let Some(rest) = &array.rest {
                collect_pattern_names(&rest.argument, names);
            }
        }
        BindingPattern::ObjectPattern(object) => {
            for property in &object.properties {
                collect_pattern_names(&property.value, names);
            }
            if let Some(rest) = &object.rest {
                collect_pattern_names(&rest.argument, names);
            }
        }
        BindingPattern::AssignmentPattern(assignment) => {
            collect_pattern_names(&assignment.left, names);
        }
    }
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

/// Names of top-level declarations from which an assignment to a top-level
/// binding of the same module is reachable. A direct write inside a
/// declaration marks it; a declaration that references a marked declaration
/// (a helper that performs the write, transitively) is marked too, because
/// cross-chunk code motion moves exclusive helpers together with their
/// callers. Writes executed directly at module top level are not attributed:
/// they run during module initialization inside the owner chunk and cannot
/// be moved elsewhere.
pub(super) fn collect_state_writing_declarations(
    semantic: &oxc_semantic::Semantic,
) -> BTreeSet<String> {
    use oxc_ast::AstKind;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let attribute = |node_id| {
        let mut attributed: Option<String> = None;
        for ancestor in nodes.ancestors(node_id) {
            match ancestor.kind() {
                AstKind::Function(function) => {
                    if let Some(id) = &function.id {
                        attributed = Some(id.name.to_string());
                    }
                }
                AstKind::Class(class) => {
                    if let Some(id) = &class.id {
                        attributed = Some(id.name.to_string());
                    }
                }
                AstKind::VariableDeclarator(declarator) => {
                    if let Some(id) = declarator.id.get_binding_identifier() {
                        attributed = Some(id.name.to_string());
                    }
                }
                _ => {}
            }
        }
        attributed
    };
    // Reference graph between top-level declarations, and the declarations
    // containing a direct write to a top-level binding.
    let mut referencers = HashMap::<String, BTreeSet<String>>::new();
    let mut writers = BTreeSet::<String>::new();
    for (name, &symbol_id) in scoping.get_bindings(scoping.root_scope_id()) {
        for reference in scoping.get_resolved_references(symbol_id) {
            let Some(owner) = attribute(reference.node_id()) else {
                continue;
            };
            if reference.flags().is_write() {
                writers.insert(owner.clone());
            }
            if owner.as_str() != name.as_str() {
                referencers
                    .entry(name.to_string())
                    .or_default()
                    .insert(owner);
            }
        }
    }
    // Propagate: anything that references a state-writing declaration is
    // itself capable of carrying the write along under code motion.
    let mut marked = writers;
    let mut worklist: Vec<String> = marked.iter().cloned().collect();
    while let Some(name) = worklist.pop() {
        if let Some(parents) = referencers.get(&name) {
            for parent in parents {
                if marked.insert(parent.clone()) {
                    worklist.push(parent.clone());
                }
            }
        }
    }
    marked
}
