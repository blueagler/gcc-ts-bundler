//! Direct statement and expression print for goog.module emit.

mod names;
mod program;
mod statements;

pub(crate) use self::names::{default_declaration_name, exported_decl_names, print_node};
pub(crate) use self::program::emit_goog_module_program;

#[cfg(test)]
pub(crate) use self::program::emit_goog_module_text;
