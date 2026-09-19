use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{Program, Statement};

use super::super::super::emit::PreservedImportPlan;
use super::super::super::fresh::FreshNameAllocator;
use super::super::super::hoist::{collect_used_binding_ids, HoistPlan};
use super::super::super::identity::{BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::super::super::type_metadata::RuntimeTypeName;
use super::super::super::type_metadata_oxc::{runtime_type_names_from_program, BoundTypeMetadata};
use super::super::super::{is_valid_js_identifier, TranspileContext};
use super::super::imports::HoistedImportPlanner;
use super::rewrites::{apply_import_binding_rewrites, ImportReplacement};

pub(crate) struct PlannedHoistedImports {
    pub(crate) import_lines: Vec<String>,
    pub(crate) preserved_extern_lines: Vec<String>,
    pub(crate) preserved_imports: Vec<PreservedImportPlan>,
    pub(crate) fresh_names: FreshNameAllocator,
    pub(crate) runtime_type_names: BindingKeyMap<RuntimeTypeName>,
}

pub(crate) struct HoistedImportOptions<'a> {
    pub(crate) file_path: &'a Path,
    pub(crate) context: &'a TranspileContext,
    pub(crate) plan: &'a HoistPlan,
    pub(crate) module_id: &'a str,
    pub(crate) ordinal: usize,
    pub(crate) lexical_binding_names: &'a HashSet<String>,
    pub(crate) direct_namespace_ids: &'a BindingKeySet,
}

pub(crate) fn plan_hoisted_imports<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    fresh_names: FreshNameAllocator,
    bound: &BoundTypeMetadata<'_>,
    options: HoistedImportOptions<'_>,
) -> std::result::Result<PlannedHoistedImports, String> {
    let HoistedImportOptions {
        file_path,
        context,
        plan,
        module_id,
        ordinal,
        lexical_binding_names,
        direct_namespace_ids,
    } = options;
    let used_binding_ids = collect_used_binding_ids(program, identity);
    let mut import_planner = HoistedImportPlanner::new(
        context,
        plan,
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
    let mut import_lines = Vec::new();
    let mut preserved_extern_lines = Vec::new();
    let mut preserved_imports = Vec::new();
    let mut all_rewrites = Vec::new();
    for plan in import_plans {
        import_lines.extend(plan.lines);
        preserved_extern_lines.extend(plan.extern_lines);
        preserved_imports.extend(plan.preserved_imports);
        all_rewrites.extend(plan.rewrites);
    }
    let mut runtime_type_names = runtime_type_names_from_program(program, bound)?;
    for rewrite in &all_rewrites {
        if !runtime_type_names.contains_key(&rewrite.binding_id) {
            continue;
        }
        runtime_type_names.insert(
            rewrite.binding_id,
            match &rewrite.replacement {
                ImportReplacement::Slot(_) => {
                    RuntimeTypeName::Unresolved("registry-slot-is-not-a-type-name")
                }
                ImportReplacement::Name(name) if is_valid_js_identifier(name) => {
                    RuntimeTypeName::Name(name.clone())
                }
                ImportReplacement::Name(_) => {
                    RuntimeTypeName::Unresolved("runtime-binding-not-found")
                }
            },
        );
    }
    apply_import_binding_rewrites(allocator, program, identity, &all_rewrites);
    Ok(PlannedHoistedImports {
        import_lines,
        preserved_extern_lines,
        preserved_imports,
        fresh_names,
        runtime_type_names,
    })
}
