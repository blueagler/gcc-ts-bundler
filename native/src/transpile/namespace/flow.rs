//! Oxc namespace-slot rewriting for bundler-runtime emission.

use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;

use super::flow_rewrite::rewrite_namespace_usage;
use crate::transpile::identity::ModuleIdentity;
use crate::transpile::TranspileContext;

pub(crate) use super::flow_helpers::{
    collect_finite_property_bindings, finite_property_names, HoistNamespaceInfo,
    NamespaceReification,
};

pub(crate) fn rewrite_bundler_runtime_namespace_usage<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<Vec<NamespaceReification>, String> {
    rewrite_namespace_usage(allocator, program, identity, file_path, context, None)
}

pub(crate) fn rewrite_hoisted_namespace_usage<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    file_path: &Path,
    context: &TranspileContext,
    hoist: HoistNamespaceInfo<'_>,
) -> std::result::Result<Vec<NamespaceReification>, String> {
    rewrite_namespace_usage(
        allocator,
        program,
        identity,
        file_path,
        context,
        Some(hoist),
    )
}
