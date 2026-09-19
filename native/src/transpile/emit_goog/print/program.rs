//! goog.module program emit.

use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::{Allocator, Vec as ArenaVec};
use oxc_ast::ast::Program;
use oxc_ast_visit::VisitMut;

use super::super::super::emit::{render_closure_enum, EmittedProgram};
use super::super::super::fresh::FreshNameAllocator;
use super::super::super::hoist::scan_namespace_usage;
use super::super::super::identity::ModuleIdentity;
use super::super::super::nocollapse::NocollapseAssignments;
use super::super::super::type_metadata_oxc::{runtime_type_names_from_program, BoundTypeMetadata};
use super::super::super::{apply_js_compat_text_fixes, to_goog_module_id, TranspileContext};
use super::super::external::{quote_external_boundary_accesses, ExternalBoundaryEvidence};
use super::super::live_bindings::{
    collect_live_imported_binding_ids, render_live_export_accessors, LiveImportCallRewriter,
};
use super::statements::{emit_goog_module_statements, GoogModuleStatementsInput};
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
    quote_external_boundary_accesses(
        allocator,
        file_path,
        program,
        identity,
        context,
        file_metadata,
        ExternalBoundaryEvidence::All,
    )?;
    let namespace_usage = scan_namespace_usage(program, identity)?;
    let live_imported_ids = collect_live_imported_binding_ids(program, file_path, context)?;
    if !live_imported_ids.is_empty() {
        LiveImportCallRewriter::new(allocator, identity, live_imported_ids.clone())
            .visit_program(program);
    }
    let live_imported_locals = live_imported_ids
        .iter()
        .map(|binding| identity.symbol(*binding).to_string())
        .collect::<HashSet<_>>();
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let live_exports = context.goog_live_modules.get(&module_id);
    let bound = BoundTypeMetadata::bind(program, file_metadata, context.type_metadata_enabled)?;
    let nocollapse_assignments = NocollapseAssignments::collect(program);
    let runtime_type_names = runtime_type_names_from_program(program, &bound)?;
    let mut fresh_names = FreshNameAllocator::from_program(program, identity);
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, None);
    let mut output = vec![format!("goog.module({module_id:?});")];
    output.extend(type_metadata.take_declaration_lines());
    let enum_declarations = type_metadata.enum_declarations();
    for declaration in enum_declarations {
        let emitted_name = type_metadata.enum_name(declaration);
        output.push(render_closure_enum(declaration, &emitted_name));
        if declaration.exported {
            output.push(format!(
                "exports.{} = {};",
                declaration.binding_name, emitted_name
            ));
        }
    }
    type_metadata.count_enums(enum_declarations.len());
    let mut preserved_extern_lines = Vec::new();
    let mut preserved_imports = Vec::new();
    let body = std::mem::replace(&mut program.body, ArenaVec::new_in(&allocator));
    emit_goog_module_statements(
        body,
        GoogModuleStatementsInput {
            file_path,
            identity,
            context,
            module_id: &module_id,
            namespace_usage: &namespace_usage,
            live_imported_ids: &live_imported_ids,
            live_imported_locals: &live_imported_locals,
            output: &mut output,
            preserved_extern_lines: &mut preserved_extern_lines,
            preserved_imports: &mut preserved_imports,
            fresh_names: &mut fresh_names,
            type_metadata: &mut type_metadata,
            nocollapse_assignments: &nocollapse_assignments,
        },
    )?;
    if let Some(export_name) = commonjs_export_name {
        output.push(format!("exports.{export_name} = {export_name};"));
        output.push(format!("exports.default = {export_name};"));
    }
    if let Some(live_exports) = live_exports {
        output.extend(render_live_export_accessors(&live_exports.locals));
        if !live_exports.names.is_empty() {
            let slots = context
                .bundler_module_slots
                .get(&module_id)
                .ok_or_else(|| format!("Missing namespace export facts for {module_id}"))?;
            let properties = slots
                .export_names()
                .map(|name| {
                    if live_exports.names.contains(name) {
                        format!(
                            "get {name}() {{ return exports.{}(); }}",
                            super::super::super::live_export_accessor_name(name)
                        )
                    } else {
                        format!("{name}: exports.{name}")
                    }
                })
                .collect::<Vec<_>>();
            output.push(format!(
                "exports.{} = {{{}}};",
                live_exports.namespace_export,
                properties.join(", ")
            ));
        }
    }
    Ok(EmittedProgram {
        code: apply_js_compat_text_fixes(
            output
                .into_iter()
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        preserved_extern_lines,
        preserved_imports,
        shared_helpers: Vec::new(),
        reflective_property_names: Default::default(),
        reifications: Vec::new(),
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
