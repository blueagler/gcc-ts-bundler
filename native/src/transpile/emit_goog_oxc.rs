//! Oxc text-assembly core for `emit_goog.rs`.
//!
//! Type-metadata statement decoration remains owned by the later
//! `type_metadata` slice; this module ports the module/import/export assembly,
//! live-binding rewrite, and every direct statement/expression print to oxc.

#![allow(dead_code)]

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, FromIn, Vec as ArenaVec};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_codegen::{Codegen, Gen};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{SourceType, SPAN};
use oxc_str::Ident;

use super::emit::EmittedProgram;
use super::emit_runtime_oxc::{binding_names_with_ids, collect_reassigned_binding_ids};
use super::fresh_oxc::FreshNameAllocator;
use super::identity_oxc::{BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::lowering_oxc::closure_input_codegen_options;
use super::nocollapse_oxc::NocollapseAssignments;
use super::type_metadata_oxc::{runtime_type_names_from_program, BoundTypeMetadata};
use super::{
    apply_js_compat_text_fixes, is_valid_js_identifier, live_export_accessor_name, member_access,
    resolve_module_id_for_specifier, resolve_relative_module, to_goog_module_id, TranspileContext,
};
use crate::closure_metadata::ClosureFileMetadata;

pub(crate) fn emit_goog_module_program<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    let live_imported_ids = collect_live_imported_binding_ids(program, identity, file_path);
    if !live_imported_ids.is_empty() {
        LiveImportCallRewriter::new(allocator, identity, live_imported_ids.clone())
            .visit_program(program);
    }
    let live_imported_locals = live_imported_ids
        .iter()
        .map(|binding| identity.symbol(*binding).to_string())
        .collect::<HashSet<_>>();
    let live_exports = live_export_bindings(file_path);
    let bound = BoundTypeMetadata::bind(
        program,
        identity,
        file_metadata,
        context.type_metadata_enabled,
    );
    let nocollapse_assignments = NocollapseAssignments::collect(program);
    let runtime_type_names = runtime_type_names_from_program(program, identity, &bound);
    let mut fresh_names = FreshNameAllocator::from_program(program, identity);
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, None);
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let mut output = vec![format!("goog.module({module_id:?});")];
    output.extend(type_metadata.take_declaration_lines());
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for declaration in enum_declarations {
        let emitted_name = type_metadata.enum_name(&declaration);
        output.push(super::render_closure_enum(&declaration, &emitted_name));
        type_metadata.count_enum();
        if declaration.exported {
            output.push(format!(
                "exports.{} = {};",
                declaration.binding_name, emitted_name
            ));
        }
    }
    let mut import_counter = 0usize;
    let mut export_counter = 0usize;
    let body = std::mem::replace(&mut program.body, ArenaVec::new_in(&allocator));
    for statement in body {
        match statement {
            Statement::ImportDeclaration(import) => output.extend(convert_import_decl(
                file_path,
                &import,
                identity,
                context,
                &mut import_counter,
                &mut fresh_names,
                &live_imported_ids,
            )?),
            Statement::ExportNamedDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = export.declaration {
                    let exported_names = exported_decl_names(&declaration, identity);
                    output.push(type_metadata.render_statement_with_nocollapse(
                        identity,
                        declaration.into(),
                        &[],
                        Some(&nocollapse_assignments),
                    )?);
                    for export_name in exported_names {
                        output.push(format!("exports.{export_name} = {export_name};"));
                    }
                } else {
                    output.extend(convert_named_export(
                        file_path,
                        &export,
                        context,
                        &mut export_counter,
                        &mut fresh_names,
                        &live_imported_locals,
                    )?);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let export = export.unbox();
                let local_name = default_declaration_name(&export.declaration)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        fresh_names.fresh(&format!("__goog_default_export_{export_counter}"))
                    });
                export_counter += 1;
                match export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function)
                        if function.id.is_some() =>
                    {
                        output.push(type_metadata.render_statement_with_nocollapse(
                            identity,
                            Statement::FunctionDeclaration(function),
                            &[],
                            Some(&nocollapse_assignments),
                        )?);
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) if class.id.is_some() => {
                        output.push(type_metadata.render_statement_with_nocollapse(
                            identity,
                            Statement::ClassDeclaration(class),
                            &[],
                            Some(&nocollapse_assignments),
                        )?);
                    }
                    declaration => {
                        let printed = print_node(&declaration);
                        output.push(format!(
                            "const {local_name} = {};",
                            printed.trim().trim_end_matches(';')
                        ));
                    }
                }
                output.push(format!("exports.default = {local_name};"));
            }
            Statement::ExportAllDeclaration(export) => output.extend(convert_export_all(
                file_path,
                &export,
                context,
                &mut export_counter,
                &mut fresh_names,
            )?),
            statement if statement.is_typescript_syntax() => {}
            statement => output.push(type_metadata.render_statement_with_nocollapse(
                identity,
                statement,
                &[],
                Some(&nocollapse_assignments),
            )?),
        }
    }
    if let Some(export_name) = commonjs_export_name {
        output.push(format!("exports.{export_name} = {export_name};"));
        output.push(format!("exports.default = {export_name};"));
    }
    output.extend(render_live_export_accessors(&live_exports));
    Ok(EmittedProgram {
        code: apply_js_compat_text_fixes(
            output
                .into_iter()
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        shared_helpers: Vec::new(),
        reflective_property_names: Default::default(),
        type_metadata: type_metadata.finish(),
    })
}

#[cfg(test)]
pub(crate) fn emit_goog_module_text<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    emit_goog_module_program(
        allocator,
        file_path,
        program,
        identity,
        context,
        None,
        commonjs_export_name,
    )
    .map(|emitted| emitted.code)
}

fn print_node(node: &impl Gen) -> String {
    let mut codegen = Codegen::new().with_options(closure_input_codegen_options());
    node.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
}

fn print_declaration(declaration: &Declaration<'_>) -> String {
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            format!(
                "{};",
                print_node(declaration.as_ref()).trim_end_matches(';')
            )
        }
        Declaration::FunctionDeclaration(function) => print_node(function.as_ref()),
        Declaration::ClassDeclaration(class) => print_node(class.as_ref()),
        _ => String::new(),
    }
}

fn default_declaration_name<'a>(
    declaration: &'a ExportDefaultDeclarationKind<'_>,
) -> Option<&'a str> {
    match declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
            function.id.as_ref().map(|id| id.name.as_str())
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            class.id.as_ref().map(|id| id.name.as_str())
        }
        _ => None,
    }
}

fn exported_decl_names(declaration: &Declaration<'_>, identity: &ModuleIdentity) -> Vec<String> {
    match declaration {
        Declaration::VariableDeclaration(declaration) => declaration
            .declarations
            .iter()
            .flat_map(|declarator| binding_names_with_ids(&declarator.id, identity))
            .map(|(_, name)| name)
            .collect(),
        Declaration::FunctionDeclaration(function) => {
            function.id.iter().map(|id| id.name.to_string()).collect()
        }
        Declaration::ClassDeclaration(class) => {
            class.id.iter().map(|id| id.name.to_string()).collect()
        }
        _ => Vec::new(),
    }
}

fn convert_import_decl(
    file_path: &Path,
    import: &ImportDeclaration<'_>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    import_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    live_imported_ids: &BindingKeySet,
) -> std::result::Result<Vec<String>, String> {
    let module_id =
        resolve_module_id_for_specifier(file_path, import.source.value.as_str(), context)?;
    let Some(specifiers) = &import.specifiers else {
        return Ok(vec![format!("goog.require({module_id:?});")]);
    };
    if specifiers.is_empty() {
        return Ok(vec![format!("goog.require({module_id:?});")]);
    }

    let mut value = Vec::new();
    let mut types = Vec::new();
    for specifier in specifiers {
        let is_type = import.import_kind == ImportOrExportKind::Type
            || matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(named)
                if named.import_kind == ImportOrExportKind::Type);
        if is_type {
            types.push(specifier);
        } else {
            value.push(specifier);
        }
    }

    let mut lines = Vec::new();
    if !value.is_empty() {
        let local_name = fresh_names.fresh(&format!("__goog_import_{}", *import_counter));
        *import_counter += 1;
        lines.push(format!("const {local_name} = goog.require({module_id:?});"));
        lines.extend(bind_import_specifiers(
            &local_name,
            &value,
            identity,
            live_imported_ids,
        ));
    }
    if !types.is_empty() {
        let local_name = fresh_names.fresh(&format!("__goog_type_{}", *import_counter));
        *import_counter += 1;
        lines.push(format!(
            "const {local_name} = goog.requireType({module_id:?});"
        ));
        lines.extend(bind_import_specifiers(
            &local_name,
            &types,
            identity,
            &HashSet::new(),
        ));
    }
    Ok(lines)
}

fn bind_import_specifiers(
    require_name: &str,
    specifiers: &[&ImportDeclarationSpecifier<'_>],
    identity: &ModuleIdentity,
    live_imported_ids: &BindingKeySet,
) -> Vec<String> {
    specifiers
        .iter()
        .map(|specifier| match specifier {
            ImportDeclarationSpecifier::ImportSpecifier(named) => {
                let local = named.local.name.as_str();
                let imported = module_export_name(&named.imported);
                let property = if live_imported_ids.contains(&identity.key_of_binding(&named.local))
                {
                    live_export_accessor_name(&imported)
                } else {
                    imported
                };
                format!(
                    "const {local} = {};",
                    member_access(require_name, &property)
                )
            }
            ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => format!(
                "const {} = {};",
                default.local.name,
                member_access(require_name, "default")
            ),
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                format!("const {} = {require_name};", namespace.local.name)
            }
        })
        .collect()
}

fn convert_named_export(
    file_path: &Path,
    export: &ExportNamedDeclaration<'_>,
    context: &TranspileContext,
    export_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    live_imported_locals: &HashSet<String>,
) -> std::result::Result<Vec<String>, String> {
    if export.export_kind == ImportOrExportKind::Type {
        return Ok(Vec::new());
    }
    let mut lines = Vec::new();
    if let Some(source) = &export.source {
        let require_name = fresh_names.fresh(&format!("__goog_export_{}", *export_counter));
        *export_counter += 1;
        let module_id = resolve_module_id_for_specifier(file_path, source.value.as_str(), context)?;
        lines.push(format!(
            "const {require_name} = goog.require({module_id:?});"
        ));
        for specifier in &export.specifiers {
            if specifier.export_kind == ImportOrExportKind::Type {
                continue;
            }
            lines.push(format!(
                "exports.{} = {};",
                module_export_name(&specifier.exported),
                member_access(&require_name, &module_export_name(&specifier.local))
            ));
        }
        return Ok(lines);
    }

    for specifier in &export.specifiers {
        if specifier.export_kind == ImportOrExportKind::Type {
            continue;
        }
        let local = module_export_name(&specifier.local);
        let value = if live_imported_locals.contains(&local) {
            format!("{local}()")
        } else {
            local
        };
        lines.push(format!(
            "exports.{} = {value};",
            module_export_name(&specifier.exported)
        ));
    }
    Ok(lines)
}

fn convert_export_all(
    file_path: &Path,
    export: &ExportAllDeclaration<'_>,
    context: &TranspileContext,
    export_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
) -> std::result::Result<Vec<String>, String> {
    if export.export_kind == ImportOrExportKind::Type {
        return Ok(Vec::new());
    }
    let prefix = if export.exported.is_some() {
        "__goog_export_"
    } else {
        "__goog_export_all_"
    };
    let require_name = fresh_names.fresh(&format!("{prefix}{}", *export_counter));
    *export_counter += 1;
    let module_id =
        resolve_module_id_for_specifier(file_path, export.source.value.as_str(), context)?;
    let mut lines = vec![format!(
        "const {require_name} = goog.require({module_id:?});"
    )];
    if let Some(exported) = &export.exported {
        lines.push(format!(
            "exports.{} = {require_name};",
            module_export_name(exported)
        ));
    } else {
        lines.push(format!(
            "for (const key in {require_name}) {{ if (key !== \"default\") {{ exports[key] = {require_name}[key]; }} }}"
        ));
    }
    Ok(lines)
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(string) => string.value.to_string(),
    }
}

pub(crate) fn live_export_bindings(file_path: &Path) -> BTreeMap<String, String> {
    let Ok(source) = std::fs::read_to_string(file_path) else {
        return BTreeMap::new();
    };
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path)
        .unwrap_or_default()
        .with_module(true);
    let parsed = Parser::new(&allocator, &source, source_type).parse();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return BTreeMap::new();
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_enum_eval(true)
        .build(&parsed.program);
    if !semantic.diagnostics.is_empty() {
        return BTreeMap::new();
    }
    let identity = ModuleIdentity::new(semantic.semantic.into_scoping());
    live_export_bindings_of_program(&parsed.program, &identity)
}

fn live_export_bindings_of_program(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> BTreeMap<String, String> {
    let mut declared = BindingKeyMap::<String>::new();
    let mut exported = BindingKeyMap::<(String, String)>::new();
    for statement in &program.body {
        let (declaration, is_exported) = match statement {
            Statement::VariableDeclaration(declaration) => (declaration.as_ref(), false),
            Statement::ExportNamedDeclaration(export) => {
                let Some(Declaration::VariableDeclaration(declaration)) = &export.declaration
                else {
                    continue;
                };
                (declaration.as_ref(), true)
            }
            _ => continue,
        };
        if declaration.kind == VariableDeclarationKind::Const || declaration.declare {
            continue;
        }
        for declarator in &declaration.declarations {
            for (binding, name) in binding_names_with_ids(&declarator.id, identity) {
                if is_exported {
                    exported.insert(binding, (name.clone(), name));
                } else {
                    declared.insert(binding, name);
                }
            }
        }
    }

    for statement in &program.body {
        let Statement::ExportNamedDeclaration(export) = statement else {
            continue;
        };
        if export.source.is_some() {
            continue;
        }
        for specifier in &export.specifiers {
            let ModuleExportName::IdentifierReference(local) = &specifier.local else {
                continue;
            };
            let Some(binding) = identity.key_of_reference(local) else {
                continue;
            };
            let Some(local_name) = declared.get(&binding) else {
                continue;
            };
            exported.insert(
                binding,
                (module_export_name(&specifier.exported), local_name.clone()),
            );
        }
    }
    if exported.is_empty() {
        return BTreeMap::new();
    }

    let reassigned =
        collect_reassigned_binding_ids(program, identity, exported.keys().copied().collect());
    exported
        .into_iter()
        .filter(|(binding, (export_name, _))| {
            reassigned.contains(binding) && is_valid_js_identifier(export_name)
        })
        .map(|(_, value)| value)
        .collect()
}

fn collect_live_imported_binding_ids(
    program: &Program<'_>,
    identity: &ModuleIdentity,
    file_path: &Path,
) -> BindingKeySet {
    let mut ids = HashSet::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let specifier_text = import.source.value.as_str();
        if !specifier_text.starts_with('.') {
            continue;
        }
        let Some(target_path) = resolve_relative_module(file_path, specifier_text) else {
            continue;
        };
        let live = live_export_bindings(&target_path);
        if live.is_empty() {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier else {
                continue;
            };
            if named.import_kind == ImportOrExportKind::Type {
                continue;
            }
            let imported_name = module_export_name(&named.imported);
            if live.contains_key(&imported_name) {
                ids.insert(identity.key_of_binding(&named.local));
            }
        }
    }
    ids
}

fn render_live_export_accessors(bindings: &BTreeMap<String, String>) -> Vec<String> {
    bindings
        .iter()
        .map(|(export_name, local_name)| {
            format!(
                "exports.{} = function() {{ return {local_name}; }};",
                live_export_accessor_name(export_name)
            )
        })
        .collect()
}

struct LiveImportCallRewriter<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    identity: &'i ModuleIdentity,
    bindings: BindingKeySet,
}

impl<'a, 'i> LiveImportCallRewriter<'a, 'i> {
    fn new(
        allocator: &'a Allocator,
        identity: &'i ModuleIdentity,
        bindings: BindingKeySet,
    ) -> Self {
        Self {
            allocator,
            builder: AstBuilder::new(allocator),
            identity,
            bindings,
        }
    }

    fn is_live(&self, identifier: &IdentifierReference<'_>) -> bool {
        self.identity
            .key_of_reference(identifier)
            .is_some_and(|binding| self.bindings.contains(&binding))
    }

    fn call(&self, name: &str) -> Expression<'a> {
        let name: Ident<'a> = Ident::from_in(name, self.allocator);
        Expression::new_call_expression(
            SPAN,
            Expression::new_identifier(SPAN, name, &self.builder),
            None::<oxc_allocator::Box<'a, TSTypeParameterInstantiation<'a>>>,
            ArenaVec::new_in(&self.allocator),
            false,
            &self.builder,
        )
    }
}

impl<'a> VisitMut<'a> for LiveImportCallRewriter<'a, '_> {
    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        if property.shorthand
            && matches!(&property.value, Expression::Identifier(identifier) if self.is_live(identifier))
        {
            property.shorthand = false;
        }
        walk_mut::walk_object_property(self, property);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::Identifier(identifier) = expression else {
            return;
        };
        if self.is_live(identifier) {
            *expression = self.call(identifier.name.as_str());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use super::super::ChunkMode;

    fn parse<'a>(allocator: &'a Allocator, source: &'a str) -> (Program<'a>, ModuleIdentity) {
        let parsed = Parser::new(allocator, source, SourceType::mjs()).parse();
        assert!(
            !parsed.panicked && parsed.diagnostics.is_empty(),
            "{:?}",
            parsed.diagnostics
        );
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .with_enum_eval(true)
            .build(&parsed.program);
        let identity = ModuleIdentity::new(semantic.semantic.into_scoping());
        (parsed.program, identity)
    }

    fn context(workspace_dir: &Path) -> TranspileContext {
        TranspileContext {
            bundler_module_slots: HashMap::new(),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: ChunkMode::Off,
            class_map_calls: Vec::new(),
            pure_callees: HashSet::new(),
            commonjs_specifiers: HashSet::new(),
            opaque_commonjs: Default::default(),
            file_metadata: HashMap::new(),
            hoist_plan: None,
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            package_aliases: Vec::new(),
            resolved_module_ids: HashMap::new(),
            preserved_property_names: HashSet::new(),
            static_property_names: HashSet::new(),
            type_metadata_enabled: false,
            vendor_module_ids: HashSet::new(),
            workspace_dir: workspace_dir.to_path_buf(),
        }
    }

    #[test]
    fn goog_text_preserves_live_binding_contract() {
        let root = std::env::temp_dir().join(format!("gcc-emit-goog-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let dep = root.join("dep.js");
        let entry = root.join("entry.js");
        std::fs::write(
            &dep,
            "export let changing = 1; changing++; export const fixed = 2; export default 3;",
        )
        .unwrap();
        let source = r#"
            import value, { changing as live, fixed } from "./dep.js";
            import * as ns from "./dep.js";
            const object = { live };
            function shadow(live) { return live; }
            export function helper() { return shadow(live); }
            export class Box {}
            export const total = live + fixed + value + ns.fixed;
            export { live as snapshot };
            export { fixed as remote } from "./dep.js";
            export * as everything from "./dep.js";
            export * from "./dep.js";
            export default function named() { return object.live; }
        "#;
        std::fs::write(&entry, source).unwrap();

        let allocator = Allocator::default();
        let (mut program, identity) = parse(&allocator, source);
        let oxc = emit_goog_module_text(
            &allocator,
            &entry,
            &mut program,
            &identity,
            &context(&root),
            None,
        )
        .unwrap();
        assert!(oxc.contains("const live = __goog_import_0.__gccLive_changing;"));
        assert!(oxc.contains("const object = { live: live() };"));
        assert!(oxc.contains("exports.snapshot = live();"));
        assert!(oxc.contains("function shadow(live)"));
        assert!(oxc.contains("return live;"));
        assert!(oxc.contains("exports.helper = helper;"));
        assert!(oxc.contains("exports.Box = Box;"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn anonymous_default_forms_are_exported() {
        let root =
            std::env::temp_dir().join(format!("gcc-emit-goog-default-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("entry.js");
        for source in [
            "export default () => 1;",
            "export default function() { return 2; }",
            "export default class { method() { return 3; } }",
        ] {
            std::fs::write(&entry, source).unwrap();
            let allocator = Allocator::default();
            let (mut program, identity) = parse(&allocator, source);
            let oxc = emit_goog_module_text(
                &allocator,
                &entry,
                &mut program,
                &identity,
                &context(&root),
                None,
            )
            .unwrap();
            assert!(oxc.contains("exports.default ="), "source: {source}\n{oxc}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn statement_printing_keeps_only_the_allowed_pure_annotation() {
        let root =
            std::env::temp_dir().join(format!("gcc-emit-goog-comments-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("entry.js");
        let source = r#"
            /** @const HOSTILE */ const value = 1;
            /*#__PURE__*/ make();
            function make() { return value; }
        "#;
        std::fs::write(&entry, source).unwrap();
        let allocator = Allocator::default();
        let (mut program, identity) = parse(&allocator, source);
        let oxc = emit_goog_module_text(
            &allocator,
            &entry,
            &mut program,
            &identity,
            &context(&root),
            None,
        )
        .unwrap();
        assert!(!oxc.contains("HOSTILE"), "{oxc}");
        assert!(oxc.contains("@__PURE__"), "{oxc}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn live_export_facts_cover_aliases_and_invalidations() {
        let source = r#"
            let direct = 0, local = 1, stable = 2;
            export { local as renamed, stable };
            export let exported = 3;
            direct += 1;
            local++;
            exported = 4;
            export { direct as "not-valid-name" };
        "#;
        let allocator = Allocator::default();
        let (program, identity) = parse(&allocator, source);
        let oxc = live_export_bindings_of_program(&program, &identity);
        assert_eq!(
            oxc,
            BTreeMap::from([
                ("exported".to_string(), "exported".to_string()),
                ("renamed".to_string(), "local".to_string()),
            ])
        );
    }
}
