use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;

use super::super::super::emit::PreservedImportPlan;
use super::super::super::fresh::FreshNameAllocator;
use super::super::super::hoist::{collect_used_binding_ids, HoistPlan};
use super::super::super::identity::{BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::super::super::type_metadata::RuntimeTypeName;
use super::super::super::type_metadata_oxc::{runtime_type_names_from_program, BoundTypeMetadata};
use super::super::super::{is_valid_js_identifier, TranspileContext};
use super::super::imports::HoistedImportPlanner;
use super::rewrites::apply_import_binding_rewrites;

pub(crate) struct PlannedHoistedImports {
    pub(crate) import_lines: Vec<String>,
    pub(crate) preserved_extern_lines: Vec<String>,
    pub(crate) preserved_imports: Vec<PreservedImportPlan>,
    pub(crate) fresh_names: FreshNameAllocator,
    pub(crate) runtime_type_names: BindingKeyMap<RuntimeTypeName>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_hoisted_imports<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    file_path: &Path,
    context: &TranspileContext,
    plan: &HoistPlan,
    module_id: &str,
    ordinal: usize,
    lexical_binding_names: &HashSet<String>,
    fresh_names: FreshNameAllocator,
    direct_namespace_ids: &BindingKeySet,
    bound: &BoundTypeMetadata,
) -> std::result::Result<PlannedHoistedImports, String> {
    let used_binding_ids = collect_used_binding_ids(program, identity);
    let mut import_planner = HoistedImportPlanner::new(
        context,
        plan,
        identity,
        module_id,
        ordinal,
        lexical_binding_names,
        fresh_names,
    );
    let import_plans = program
        .body
        .iter()
        .filter_map(|statement| {
            let Statement::ImportDeclaration(import) = statement else {
                return None;
            };
            Some(import_planner.plan_import(
                file_path,
                import,
                direct_namespace_ids,
                &used_binding_ids,
            ))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let fresh_names = import_planner.into_fresh_names();
    let preserved_extern_lines = import_plans
        .iter()
        .flat_map(|plan| plan.extern_lines.iter().cloned())
        .collect::<Vec<_>>();
    let preserved_imports = import_plans
        .iter()
        .flat_map(|plan| plan.preserved_imports.iter().cloned())
        .collect::<Vec<_>>();
    let all_rewrites = import_plans
        .iter()
        .flat_map(|plan| plan.rewrites.iter().cloned())
        .collect::<Vec<_>>();
    let mut runtime_type_names = runtime_type_names_from_program(program, identity, bound);
    for rewrite in &all_rewrites {
        if !runtime_type_names.contains_key(&rewrite.binding_id) {
            continue;
        }
        runtime_type_names.insert(
            rewrite.binding_id,
            if rewrite.slot_alias().is_some() {
                RuntimeTypeName::Unresolved("registry-slot-is-not-a-type-name")
            } else if is_valid_js_identifier(&rewrite.replacement_code) {
                RuntimeTypeName::Name(rewrite.replacement_code.clone())
            } else {
                RuntimeTypeName::Unresolved("runtime-binding-not-found")
            },
        );
    }
    apply_import_binding_rewrites(allocator, program, identity, &all_rewrites);
    Ok(PlannedHoistedImports {
        import_lines: import_plans
            .iter()
            .flat_map(|import_plan| import_plan.lines.iter().cloned())
            .collect(),
        preserved_extern_lines,
        preserved_imports,
        fresh_names,
        runtime_type_names,
    })
}
