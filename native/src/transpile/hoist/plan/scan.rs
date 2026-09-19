//! Module scans for hoist-plan construction.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use super::super::super::context::{module_export_name, ExportTopology};
use super::super::super::identity::ModuleIdentity;
use super::super::super::imports_exports::BundlerExportSlotMode;
use super::super::super::{
    resolve_module_id_for_specifier, to_emitted_commonjs_specifier, TranspileContext,
};
use super::super::usage::{collect_used_binding_ids, scan_namespace_usage};
use oxc_ast::ast::{
    ImportDeclarationSpecifier, ImportOrExportKind, Program as OxcProgram, Statement,
};

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
    identity: &ModuleIdentity,
    file_path: &Path,
    resolution_context: &TranspileContext,
    topology: ExportTopology,
) -> Result<ModuleScan, String> {
    let mut scan = ModuleScan {
        // Explicit external forwards have no internal binding to hoist.
        scan_failed: topology.explicit.len()
            != topology.locals.len() + topology.forwards.len() + topology.namespaces.len(),
        own_exports: topology.locals,
        reexports: topology.forwards,
        namespace_reexports: topology.namespaces,
        stars: topology.stars,
        ..ModuleScan::default()
    };
    let namespace_usage = scan_namespace_usage(program, identity)?;
    let used_binding_ids = collect_used_binding_ids(program, identity);

    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
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
            target_module_id: target,
            ..Default::default()
        };
        for specifier in import.specifiers.iter().flatten() {
            match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier)
                    if specifier.import_kind == ImportOrExportKind::Type => {}
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                    let imported = module_export_name(&specifier.imported);
                    if used_binding_ids.contains(&ModuleIdentity::key_of_binding(&specifier.local)?)
                    {
                        edge.used_named.push(imported.clone());
                    }
                    edge.named.push(imported);
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                    if used_binding_ids.contains(&ModuleIdentity::key_of_binding(&specifier.local)?)
                    {
                        edge.used_named.push("default".to_string());
                    }
                    edge.named.push("default".to_string());
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                    edge.namespace = true;
                    edge.namespace_members = namespace_usage
                        .member_only_usage(ModuleIdentity::key_of_binding(&specifier.local)?);
                }
            }
        }
        scan.import_edges.push(edge);
    }
    Ok(scan)
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
