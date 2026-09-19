use std::collections::HashSet;
use std::path::Path;

use oxc_ast::ast::Statement;

use super::super::super::assigners::{assigner_function_name, NOINLINE_TAG};
use super::super::super::hoist::HoistPlan;
use super::super::super::identity::ModuleIdentity;
use super::super::super::nocollapse::NocollapseAssignments;
use super::super::super::type_metadata::PURE_TAG;
use super::super::super::type_metadata_oxc::PreparedTypeMetadata;
use super::super::super::{
    resolve_module_id_for_specifier, to_bundler_runtime_module_id, TranspileContext,
};
use super::super::helpers::is_pure_statement;

pub(super) struct StatementRenderOptions<'a> {
    pub(super) pure_names: &'a HashSet<String>,
    pub(super) module_bindings: &'a HashSet<String>,
    pub(super) context: &'a TranspileContext,
    pub(super) ordinal: usize,
    pub(super) nocollapse_assignments: &'a NocollapseAssignments,
}

pub(super) fn render_hoisted_statement(
    type_metadata: &mut PreparedTypeMetadata<'_>,
    identity: &ModuleIdentity,
    statement: Statement<'_>,
    options: &StatementRenderOptions<'_>,
) -> std::result::Result<String, String> {
    let StatementRenderOptions {
        pure_names,
        module_bindings,
        context,
        ordinal,
        nocollapse_assignments,
    } = *options;
    let mut tags = Vec::new();
    if is_pure_statement(&statement, pure_names, &context.pure_callees, |name| {
        name.strip_suffix(&format!("$${ordinal}"))
            .map(str::to_string)
    }) {
        tags.push(PURE_TAG);
    }
    if assigner_function_name(&statement, module_bindings).is_some() {
        tags.push(NOINLINE_TAG);
    }
    type_metadata.render_statement_with_nocollapse(
        identity,
        statement,
        &tags,
        Some(nocollapse_assignments),
    )
}

pub(crate) fn render_execution_require(
    file_path: &Path,
    specifier: &str,
    context: &TranspileContext,
    plan: &HoistPlan,
) -> std::result::Result<Vec<String>, String> {
    let target_module_id = resolve_module_id_for_specifier(file_path, specifier, context)?;
    if plan.is_hoisted(&target_module_id) {
        return Ok(Vec::new());
    }
    let runtime_module_id = to_bundler_runtime_module_id(&target_module_id);
    Ok(vec![format!("__require({runtime_module_id:?});")])
}
