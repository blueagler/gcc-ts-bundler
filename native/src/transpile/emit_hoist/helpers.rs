use std::collections::HashSet;
use std::path::Path;

use oxc_ast::ast::*;
use oxc_codegen::{Codegen, Gen};

use super::super::hoist::{scan_namespace_usage, HoistPlan};
use super::super::identity::{BindingKeySet, ModuleIdentity};
use super::super::lowering::closure_input_codegen_options;
use super::super::{resolve_module_id_for_specifier, to_goog_module_id, TranspileContext};

pub(super) fn collect_direct_safe_namespace_ids(
    program: &Program<'_>,
    identity: &ModuleIdentity,
    file_path: &Path,
    context: &TranspileContext,
    plan: &HoistPlan,
) -> BindingKeySet {
    let consumer_module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let consumer_chunk = plan.chunk_of(&consumer_module_id);
    let usage = scan_namespace_usage(program, identity);
    let mut direct = HashSet::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let Ok(target_module_id) =
            resolve_module_id_for_specifier(file_path, import.source.value.as_str(), context)
        else {
            continue;
        };
        if !plan.is_hoisted(&target_module_id)
            || plan.chunk_of(&target_module_id).is_none()
            || consumer_chunk.is_none()
        {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) = specifier {
                let binding = identity.key_of_binding(&namespace.local);
                if usage.member_only_usage(binding).is_some_and(|members| {
                    members
                        .iter()
                        .all(|member| plan.resolve_export(&target_module_id, member).is_some())
                }) {
                    direct.insert(binding);
                }
            }
        }
    }
    direct
}

pub(super) fn is_pure_statement(
    statement: &Statement<'_>,
    pure_names: &HashSet<String>,
    pure_callees: &HashSet<String>,
    original_name_of: impl Fn(&str) -> Option<String>,
) -> bool {
    if pure_names.is_empty() && pure_callees.is_empty() {
        return false;
    }
    let Statement::VariableDeclaration(declaration) = statement else {
        return false;
    };
    let [declarator] = declaration.declarations.as_slice() else {
        return false;
    };
    let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
        return false;
    };
    let original =
        original_name_of(binding.name.as_str()).unwrap_or_else(|| binding.name.to_string());
    if pure_names.contains(&original) {
        return true;
    }
    let Some(Expression::CallExpression(call)) = &declarator.init else {
        return false;
    };
    let Expression::Identifier(callee) = &call.callee else {
        return false;
    };
    pure_callees.contains(strip_module_ordinal(callee.name.as_str()))
}

fn strip_module_ordinal(name: &str) -> &str {
    let Some((base, ordinal)) = name.rsplit_once("$$") else {
        return name;
    };
    if !ordinal.is_empty() && ordinal.bytes().all(|byte| byte.is_ascii_digit()) {
        base
    } else {
        name
    }
}
pub(super) fn print_node(node: &impl Gen) -> String {
    let mut codegen = Codegen::new().with_options(closure_input_codegen_options());
    node.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
}
