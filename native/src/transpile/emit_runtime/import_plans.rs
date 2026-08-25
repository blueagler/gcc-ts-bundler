use std::collections::HashMap;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;

use super::super::fresh::FreshNameAllocator;
use super::super::identity::{BindingKeyMap, ModuleIdentity};
use super::super::imports_exports::ImportBindingSlotAlias;
use super::super::type_metadata::RuntimeTypeName;
use super::super::{is_valid_js_identifier, TranspileContext};
use super::imports::{
    apply_import_binding_rewrites, convert_bundler_import_decl, ImportBindingRewrite,
};

pub(crate) struct RuntimeImportBindings {
    pub(crate) plan_lines: Vec<Vec<String>>,
    pub(crate) binding_rewrites: HashMap<String, String>,
    pub(crate) slot_aliases: HashMap<String, ImportBindingSlotAlias>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_runtime_import_bindings<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    require_name: &str,
    fresh_names: &mut FreshNameAllocator,
    runtime_type_names: &mut BindingKeyMap<RuntimeTypeName>,
) -> std::result::Result<RuntimeImportBindings, String> {
    let mut import_counter = 0usize;
    let import_plans = program
        .body
        .iter()
        .filter_map(|statement| {
            let Statement::ImportDeclaration(import) = statement else {
                return None;
            };
            Some(convert_bundler_import_decl(
                file_path,
                import,
                identity,
                context,
                &mut import_counter,
                fresh_names,
                require_name,
            ))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let binding_rewrites = import_plans
        .iter()
        .flat_map(|plan| {
            plan.binding_rewrites
                .iter()
                .map(|rewrite| (rewrite.local_name.clone(), rewrite.replacement_code.clone()))
        })
        .collect::<HashMap<_, _>>();
    let slot_aliases = import_plans
        .iter()
        .flat_map(|plan| {
            plan.binding_rewrites.iter().filter_map(|rewrite| {
                rewrite
                    .slot_alias
                    .clone()
                    .map(|alias| (rewrite.local_name.clone(), alias))
            })
        })
        .collect::<HashMap<_, _>>();
    let all_rewrites = import_plans
        .iter()
        .flat_map(|plan| plan.binding_rewrites.iter().cloned())
        .collect::<Vec<_>>();
    remap_runtime_type_names(runtime_type_names, &all_rewrites);
    apply_import_binding_rewrites(allocator, program, identity, &all_rewrites);
    Ok(RuntimeImportBindings {
        plan_lines: import_plans.into_iter().map(|plan| plan.lines).collect(),
        binding_rewrites,
        slot_aliases,
    })
}

fn remap_runtime_type_names(
    runtime_type_names: &mut BindingKeyMap<RuntimeTypeName>,
    rewrites: &[ImportBindingRewrite],
) {
    for rewrite in rewrites {
        if !runtime_type_names.contains_key(&rewrite.binding_id) {
            continue;
        }
        runtime_type_names.insert(
            rewrite.binding_id,
            if rewrite.slot_alias.is_some() {
                RuntimeTypeName::Unresolved("registry-slot-is-not-a-type-name")
            } else if is_valid_js_identifier(&rewrite.replacement_code) {
                RuntimeTypeName::Name(rewrite.replacement_code.clone())
            } else {
                RuntimeTypeName::Unresolved("runtime-binding-not-found")
            },
        );
    }
}
