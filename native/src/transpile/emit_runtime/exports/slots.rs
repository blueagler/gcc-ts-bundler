use std::collections::HashMap;

use oxc_ast::ast::*;
use oxc_codegen::{Codegen, Gen};

use super::super::super::identity::ModuleIdentity;
use super::super::super::imports_exports::BundlerExportSlotMode;
use super::super::super::lowering::closure_input_codegen_options;
use super::super::super::{
    is_valid_js_identifier, render_live_export_slot_with, render_static_export_slot_with,
    stable_slot_access, BundlerModuleSlots,
};
use super::super::bindings::binding_names_with_ids;
use super::binding_names::RuntimeBindingNames;

pub(crate) fn render_slot_export(
    names: &RuntimeBindingNames,
    mode: BundlerExportSlotMode,
    slot: usize,
    value: &str,
) -> String {
    match mode {
        BundlerExportSlotMode::Static => {
            render_static_export_slot_with(&names.exports, slot, value)
        }
        BundlerExportSlotMode::Live => {
            render_live_export_slot_with(&names.live, &names.exports, slot, value)
        }
    }
}

pub(crate) fn slot_mode_for_export_decl(
    declaration: &Declaration<'_>,
    identity: &ModuleIdentity,
    modes: &HashMap<String, BundlerExportSlotMode>,
) -> BundlerExportSlotMode {
    match declaration {
        Declaration::FunctionDeclaration(_) | Declaration::ClassDeclaration(_) => {
            BundlerExportSlotMode::Static
        }
        Declaration::VariableDeclaration(declaration)
            if declaration.kind == VariableDeclarationKind::Const =>
        {
            if declaration
                .declarations
                .iter()
                .flat_map(|declarator| binding_names_with_ids(&declarator.id, identity))
                .all(|(_, name)| modes.get(&name) == Some(&BundlerExportSlotMode::Static))
            {
                BundlerExportSlotMode::Static
            } else {
                BundlerExportSlotMode::Live
            }
        }
        _ => BundlerExportSlotMode::Live,
    }
}

pub(crate) fn exported_decl_names(
    declaration: &Declaration<'_>,
    identity: &ModuleIdentity,
) -> Vec<String> {
    match declaration {
        Declaration::VariableDeclaration(declaration) => declaration
            .declarations
            .iter()
            .flat_map(|declarator| binding_names_with_ids(&declarator.id, identity))
            .map(|(_, name)| name)
            .collect(),
        Declaration::FunctionDeclaration(function) => function
            .id
            .iter()
            .map(|binding| binding.name.to_string())
            .collect(),
        Declaration::ClassDeclaration(class) => class
            .id
            .iter()
            .map(|binding| binding.name.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn default_declaration_name<'a>(
    declaration: &'a ExportDefaultDeclarationKind<'_>,
) -> Option<&'a str> {
    match declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
            function.id.as_ref().map(|binding| binding.name.as_str())
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            class.id.as_ref().map(|binding| binding.name.as_str())
        }
        _ => None,
    }
}

pub(crate) fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

pub(crate) fn print_node(node: &impl Gen) -> String {
    let mut codegen = Codegen::new().with_options(closure_input_codegen_options());
    node.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
}

pub(crate) fn indent_block(source: &str) -> String {
    if source.is_empty() {
        return String::new();
    }
    source
        .lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn render_namespace_reexport_object(
    require_name: &str,
    target_slots: &BundlerModuleSlots,
    export_module_id: &str,
) -> std::result::Result<String, String> {
    // Live getters, not a snapshot: the splat path installs `__live` accessors
    // that reread the target slot on every get. A namespace object must do the
    // same, or `ns.foo` would go stale while `export *` stayed live.
    //
    // Keys stay unquoted identifiers so Closure ADVANCED renames them together
    // with every `ns.foo` read. A target export that is not an identifier
    // (`export { x as "a-b" }`) cannot be emitted that way. Quoting would pin
    // the name (stringDefined ∩ dotAccessed). Omitting would drop a name a
    // program can read via `ns["a-b"]`. Error instead.
    let mut properties = Vec::new();
    for export_name in target_slots.export_names() {
        if !is_valid_js_identifier(export_name) {
            return Err(format!(
                "bundler-runtime cannot emit an unquoted namespace key for export {export_name:?} from {export_module_id}"
            ));
        }
        let source_slot = target_slots.slot_for(export_name).ok_or_else(|| {
            format!("Missing bundler-runtime export slot for {export_name} in {export_module_id}")
        })?;
        properties.push(format!(
            "get {export_name}(){{return {};}}",
            stable_slot_access(require_name, source_slot)
        ));
    }
    Ok(format!("{{{}}}", properties.join(",")))
}
