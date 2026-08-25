//! Rewrite entry for bundler-runtime namespace usage.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::VisitMut;

use super::super::flow_helpers::{
    collect_finite_property_bindings, HoistNamespaceInfo, NamespaceReification,
};
use super::super::flow_visitors::BundlerRuntimeNamespaceVisitor;
use super::super::wrappers::{
    collect_dynamic_import_object_carriers, collect_dynamic_import_promise_carriers,
    collect_dynamic_import_wrappers,
};
use crate::transpile::identity::ModuleIdentity;
use crate::transpile::TranspileContext;

pub(crate) fn rewrite_namespace_usage<'a, 'i>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &'i ModuleIdentity,
    file_path: &Path,
    context: &'i TranspileContext,
    hoist: Option<HoistNamespaceInfo<'i>>,
) -> std::result::Result<Vec<NamespaceReification>, String> {
    let wrappers = collect_dynamic_import_wrappers(program, identity);
    let object_carriers = collect_dynamic_import_object_carriers(program, &wrappers, identity);
    let promise_carriers =
        collect_dynamic_import_promise_carriers(program, &object_carriers, &wrappers, identity);
    let mut visitor = BundlerRuntimeNamespaceVisitor {
        allocator,
        builder: AstBuilder::new(allocator),
        context,
        direct_namespace_targets: HashMap::new(),
        errors: Vec::new(),
        file_path: file_path.to_path_buf(),
        finite_property_bindings: collect_finite_property_bindings(program, identity),
        hoist,
        identity,
        namespace_bindings: HashMap::new(),
        object_carriers,
        promise_carriers,
        reifications: BTreeMap::new(),
        wrappers,
    };
    visitor.visit_program(program);
    if visitor.errors.is_empty() {
        Ok(visitor
            .reifications
            .into_iter()
            .map(|(module_id, warning)| NamespaceReification { module_id, warning })
            .collect())
    } else {
        Err(visitor.errors.join("\n"))
    }
}
