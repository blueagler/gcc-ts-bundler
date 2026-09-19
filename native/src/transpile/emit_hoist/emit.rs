use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;

use super::super::emit::EmittedProgram;
use super::super::emit_helpers::take_shared_helper_declarations;
use super::super::emit_runtime::collect_local_export_modes;
use super::super::fresh::{collect_lexical_binding_names, FreshNameAllocator};
use super::super::hoist::HoistPlan;
use super::super::identity::ModuleIdentity;
use super::super::nocollapse::NocollapseAssignments;
use super::super::pure_calls::collect_pure_annotated_binding_names;
use super::super::type_metadata_oxc::BoundTypeMetadata;
use super::super::{apply_js_compat_text_fixes, to_goog_module_id, TranspileContext};
use super::assembly::{assemble_hoisted_module_text, HoistedAssemblyOptions};
use super::helpers::collect_direct_safe_namespace_ids;
use super::import_plan::{plan_hoisted_imports, HoistedImportOptions, PlannedHoistedImports};
use super::renames::{apply_top_level_renames, collect_top_level_renames, TopLevelRenames};
use crate::closure_metadata::ClosureFileMetadata;

pub(crate) struct HoistedModuleOptions<'a> {
    pub(crate) context: &'a TranspileContext,
    pub(crate) plan: &'a HoistPlan,
    pub(crate) file_metadata: Option<&'a ClosureFileMetadata>,
    pub(crate) commonjs_export_name: Option<&'a str>,
}

pub(crate) fn emit_hoisted_module_text<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &mut ModuleIdentity,
    options: HoistedModuleOptions<'_>,
) -> std::result::Result<EmittedProgram, String> {
    let HoistedModuleOptions {
        context,
        plan,
        file_metadata,
        commonjs_export_name,
    } = options;
    let bound = BoundTypeMetadata::bind(program, file_metadata, context.type_metadata_enabled)?;
    let nocollapse_assignments = NocollapseAssignments::collect(program);
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let ordinal = plan
        .ordinal_of(&module_id)
        .ok_or_else(|| format!("Missing hoist ordinal for {module_id}"))?;
    // Lowering retains the parser's source text, so ordinary files need no
    // third read just to recover authored PURE comments. Decorator emit uses
    // a different source/path; preserve its existing disk-comment provenance.
    let pure_names = if file_metadata
        .and_then(|metadata| metadata.decorated_output_text.as_deref())
        .is_some()
    {
        std::fs::read_to_string(file_path)
            .map(|source| collect_pure_annotated_binding_names(&source))
            .unwrap_or_default()
    } else {
        collect_pure_annotated_binding_names(program.source_text)
    };
    let local_export_modes = collect_local_export_modes(program, identity)?;

    let TopLevelRenames {
        renames,
        shared_helper_names,
    } = collect_top_level_renames(program, ordinal)?;
    let module_bindings = if context.pin_cross_chunk_assigners {
        renames.values().cloned().collect()
    } else {
        HashSet::new()
    };
    apply_top_level_renames(allocator, program, identity, &renames)?;
    let mut shared_helpers =
        take_shared_helper_declarations(allocator, program, &shared_helper_names);
    let lexical_binding_names = collect_lexical_binding_names(program);
    let fresh_names = FreshNameAllocator::from_program(program, identity);

    let direct_namespace_ids =
        collect_direct_safe_namespace_ids(program, identity, file_path, context, plan)?;
    let reifications = super::super::namespace::flow::rewrite_hoisted_namespace_usage(
        allocator,
        program,
        identity,
        file_path,
        context,
        super::super::namespace::flow::HoistNamespaceInfo {
            plan,
            consumer_module_id: &module_id,
            direct_namespace_ids: &direct_namespace_ids,
            lexical_binding_names: &lexical_binding_names,
        },
    )?;

    let PlannedHoistedImports {
        import_lines,
        preserved_extern_lines,
        preserved_imports,
        mut fresh_names,
        runtime_type_names,
    } = plan_hoisted_imports(
        allocator,
        program,
        identity,
        fresh_names,
        &bound,
        HoistedImportOptions {
            file_path,
            context,
            plan,
            module_id: &module_id,
            ordinal,
            lexical_binding_names: &lexical_binding_names,
            direct_namespace_ids: &direct_namespace_ids,
        },
    )?;
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, Some(ordinal));
    shared_helpers.extend(type_metadata.take_shared_type_declarations());
    let body = assemble_hoisted_module_text(
        allocator,
        program,
        identity,
        &mut type_metadata,
        &mut fresh_names,
        HoistedAssemblyOptions {
            file_path,
            context,
            plan,
            module_id: &module_id,
            ordinal,
            import_lines: &import_lines,
            pure_names: &pure_names,
            module_bindings: &module_bindings,
            nocollapse_assignments: &nocollapse_assignments,
            local_export_modes: &local_export_modes,
            commonjs_export_name,
        },
    )?;

    Ok(EmittedProgram {
        code: apply_js_compat_text_fixes(body),
        preserved_extern_lines,
        preserved_imports,
        reflective_property_names: Default::default(),
        reifications,
        shared_helpers,
        type_metadata: type_metadata.finish(),
    })
}
