use std::collections::HashMap;

use oxc_ast::ast::{
    Declaration, ExportDefaultDeclarationKind, ModuleExportName, VariableDeclarationKind,
};
use oxc_codegen::{Codegen, Gen};

use super::super::super::imports_exports::BundlerExportSlotMode;
use super::super::super::lowering::closure_input_codegen_options;
use super::super::super::{render_live_export_slot_with, render_static_export_slot_with};
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
    modes: &HashMap<String, BundlerExportSlotMode>,
) -> Result<BundlerExportSlotMode, String> {
    Ok(match declaration {
        Declaration::FunctionDeclaration(_) | Declaration::ClassDeclaration(_) => {
            BundlerExportSlotMode::Static
        }
        Declaration::VariableDeclaration(declaration)
            if declaration.kind == VariableDeclarationKind::Const =>
        {
            let mut all_static = true;
            for declarator in &declaration.declarations {
                all_static &= binding_names_with_ids(&declarator.id)?
                    .iter()
                    .all(|(_, name)| modes.get(name) == Some(&BundlerExportSlotMode::Static));
            }
            if all_static {
                BundlerExportSlotMode::Static
            } else {
                BundlerExportSlotMode::Live
            }
        }
        _ => BundlerExportSlotMode::Live,
    })
}

pub(crate) fn exported_decl_names(declaration: &Declaration<'_>) -> Result<Vec<String>, String> {
    Ok(match declaration {
        Declaration::VariableDeclaration(declaration) => {
            let mut names = Vec::new();
            for declarator in &declaration.declarations {
                names.extend(
                    binding_names_with_ids(&declarator.id)?
                        .into_iter()
                        .map(|(_, name)| name),
                );
            }
            names
        }
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
    })
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
