use std::collections::HashMap;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{Program, Statement};

use super::super::fresh::FreshNameAllocator;
use super::super::identity::{BindingKeyMap, ModuleIdentity};
use super::super::imports_exports::ImportBindingSlotAlias;
use super::super::type_metadata::RuntimeTypeName;
use super::super::TranspileContext;
use super::imports::{
    apply_import_binding_rewrites, convert_bundler_import_decl, ImportBindingRewrite,
};

pub(crate) struct RuntimeImportBindings {
    pub(crate) plan_lines: Vec<Vec<String>>,
    pub(crate) slot_aliases: HashMap<String, ImportBindingSlotAlias>,
}

pub(super) struct RuntimeImportInput<'i> {
    pub(super) file_path: &'i Path,
    pub(super) identity: &'i ModuleIdentity,
    pub(super) context: &'i TranspileContext,
    pub(super) require_name: &'i str,
}

pub(super) fn prepare_runtime_import_bindings<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    input: &RuntimeImportInput<'_>,
    fresh_names: &mut FreshNameAllocator,
    runtime_type_names: &mut BindingKeyMap<RuntimeTypeName>,
) -> std::result::Result<RuntimeImportBindings, String> {
    let RuntimeImportInput {
        file_path,
        identity,
        context,
        require_name,
    } = *input;
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
                context,
                &mut import_counter,
                fresh_names,
                require_name,
            ))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut plan_lines = Vec::with_capacity(import_plans.len());
    let mut all_rewrites = Vec::new();
    for plan in import_plans {
        plan_lines.push(plan.lines);
        all_rewrites.extend(plan.binding_rewrites);
    }
    remap_runtime_type_names(runtime_type_names, &all_rewrites);
    apply_import_binding_rewrites(allocator, program, identity, &all_rewrites);
    let slot_aliases = all_rewrites
        .into_iter()
        .map(|rewrite| (rewrite.local_name, rewrite.slot_alias))
        .collect();
    Ok(RuntimeImportBindings {
        plan_lines,
        slot_aliases,
    })
}

fn remap_runtime_type_names(
    runtime_type_names: &mut BindingKeyMap<RuntimeTypeName>,
    rewrites: &[ImportBindingRewrite],
) {
    for rewrite in rewrites {
        if let Some(name) = runtime_type_names.get_mut(&rewrite.binding_id) {
            *name = RuntimeTypeName::Unresolved("registry-slot-is-not-a-type-name");
        }
    }
}
