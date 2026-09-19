//! Oxc bundler-runtime emitter and identity-based export readers.

mod assemble;
mod bindings;
mod exports;
mod import_plans;
mod imports;
mod statements;
mod type_prelude;

#[cfg(test)]
mod tests;

pub(crate) use bindings::{
    binding_names_with_ids, collect_local_export_modes, collect_reassigned_binding_ids,
};

use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;

use super::identity::ModuleIdentity;
use super::nocollapse::NocollapseAssignments;
use super::type_metadata::TypeMetadataDelivery;
use super::type_metadata_oxc::{runtime_type_names_from_program, BoundTypeMetadata};
use super::{to_bundler_runtime_module_id, to_goog_module_id, TranspileContext};
use crate::closure_metadata::ClosureFileMetadata;

use self::assemble::assemble_runtime_module_text;
use self::exports::{RuntimeBindingNames, RuntimeExportInput};
use self::import_plans::{prepare_runtime_import_bindings, RuntimeImportInput};
use self::statements::{emit_runtime_statements, RuntimeStatementInput};
use self::type_prelude::emit_runtime_type_prelude;

#[derive(Debug)]
pub(crate) struct RuntimeEmit {
    pub(crate) code: String,
    pub(crate) reifications: Vec<super::namespace::flow::NamespaceReification>,
    pub(crate) type_metadata: TypeMetadataDelivery,
}

pub(crate) fn emit_bundler_runtime_module_text<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<RuntimeEmit, String> {
    let bound = BoundTypeMetadata::bind(program, file_metadata, context.type_metadata_enabled)?;
    let nocollapse_assignments = NocollapseAssignments::collect(program);
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let runtime_module_id = to_bundler_runtime_module_id(&module_id);
    let current_slots = context
        .bundler_module_slots
        .get(&module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;

    let reifications = super::namespace::flow::rewrite_bundler_runtime_namespace_usage(
        allocator, program, identity, file_path, context,
    )?;
    let (runtime_names, mut fresh_names) =
        RuntimeBindingNames::allocate(allocator, program, identity);
    let mut output = Vec::new();
    let mut runtime_type_names = runtime_type_names_from_program(program, &bound)?;
    let import_bindings = prepare_runtime_import_bindings(
        allocator,
        program,
        &RuntimeImportInput {
            file_path,
            identity,
            context,
            require_name: &runtime_names.require,
        },
        &mut fresh_names,
        &mut runtime_type_names,
    )?;
    let local_export_modes = collect_local_export_modes(program, identity)?;
    let mut import_plan_lines = import_bindings.plan_lines.into_iter();
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, None);

    emit_runtime_type_prelude(
        &mut type_metadata,
        current_slots,
        &runtime_names,
        &module_id,
        &mut output,
    )?;

    let body = std::mem::replace(&mut program.body, oxc_allocator::Vec::new_in(&allocator));
    emit_runtime_statements(
        body,
        &RuntimeStatementInput {
            exports: RuntimeExportInput {
                file_path,
                context,
                current_slots,
                names: &runtime_names,
            },
            identity,
            module_id: &module_id,
            local_export_modes: &local_export_modes,
            import_binding_slot_aliases: &import_bindings.slot_aliases,
            nocollapse_assignments: &nocollapse_assignments,
        },
        &mut type_metadata,
        &mut fresh_names,
        &mut import_plan_lines,
        &mut output,
    )?;
    let source = assemble_runtime_module_text(
        &runtime_module_id,
        &module_id,
        context,
        current_slots,
        &runtime_names,
        commonjs_export_name,
        output,
    )?;
    Ok(RuntimeEmit {
        code: source,
        reifications,
        type_metadata: type_metadata.finish(),
    })
}
