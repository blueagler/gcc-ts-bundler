//! Statement/expression print and export declaration names.

use oxc_ast::ast::*;
use oxc_codegen::{Codegen, Gen};

use super::super::super::emit_runtime::binding_names_with_ids;
use super::super::super::identity::ModuleIdentity;
use super::super::super::lowering::closure_input_codegen_options;

pub(crate) fn print_node(node: &impl Gen) -> String {
    let mut codegen = Codegen::new().with_options(closure_input_codegen_options());
    node.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
}

pub(crate) fn default_declaration_name<'a>(
    declaration: &'a ExportDefaultDeclarationKind<'_>,
) -> Option<&'a str> {
    match declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
            function.id.as_ref().map(|id| id.name.as_str())
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            class.id.as_ref().map(|id| id.name.as_str())
        }
        _ => None,
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
        Declaration::FunctionDeclaration(function) => {
            function.id.iter().map(|id| id.name.to_string()).collect()
        }
        Declaration::ClassDeclaration(class) => {
            class.id.iter().map(|id| id.name.to_string()).collect()
        }
        _ => Vec::new(),
    }
}
