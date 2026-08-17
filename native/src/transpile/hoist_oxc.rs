//! Oxc counterparts of `hoist.rs`'s identity-based usage readers.

use std::collections::{BTreeSet, HashMap, HashSet};

use oxc_ast::ast::*;
use oxc_ast_visit::{walk_js, Visit, VisitJs};

use super::identity_oxc::{BindingKey, BindingKeyMap, BindingKeySet, ModuleIdentity};

/// Binding ids referenced outside import declarations and source-less named
/// exports. This is the fact the hoist planner uses to prune unused imports.
pub(crate) fn collect_used_binding_ids(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> BindingKeySet {
    let mut collector = UsedBindingCollector {
        identity,
        used: HashSet::new(),
    };
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(_) => {}
            Statement::ExportNamedDeclaration(export)
                if export.source.is_none() && export.declaration.is_none() => {}
            _ => collector.visit_statement(statement),
        }
    }
    collector.used
}

struct UsedBindingCollector<'a> {
    identity: &'a ModuleIdentity,
    used: BindingKeySet,
}

impl<'a> Visit<'a> for UsedBindingCollector<'_> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if let Some(key) = self.identity.key_of_reference(identifier) {
            self.used.insert(key);
        }
    }
}

#[derive(Debug)]
pub(crate) struct NamespaceUsage {
    disqualified: BindingKeySet,
    members: BindingKeyMap<BTreeSet<String>>,
}

impl NamespaceUsage {
    pub(crate) fn member_only_usage(&self, binding: BindingKey) -> Option<BTreeSet<String>> {
        if self.disqualified.contains(&binding) {
            return None;
        }
        Some(self.members.get(&binding).cloned().unwrap_or_default())
    }
}

/// Records, for every namespace import binding, which members are accessed and
/// whether the binding ever escapes as a value.
pub(crate) fn scan_namespace_usage(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> NamespaceUsage {
    let mut candidates = HashSet::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(declaration) = statement else {
            continue;
        };
        for specifier in declaration.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) = specifier {
                candidates.insert(identity.key_of_binding(&specifier.local));
            }
        }
    }
    let mut scanner = NamespaceMemberScanner {
        candidates,
        finite_property_bindings: super::namespace::flow_oxc::collect_finite_property_bindings(
            program, identity,
        ),
        identity,
        usage: NamespaceUsage {
            disqualified: HashSet::new(),
            members: HashMap::new(),
        },
    };
    VisitJs::visit_program(&mut scanner, program);
    scanner.usage
}

struct NamespaceMemberScanner<'a> {
    candidates: BindingKeySet,
    finite_property_bindings: BindingKeyMap<Vec<String>>,
    identity: &'a ModuleIdentity,
    usage: NamespaceUsage,
}

impl NamespaceMemberScanner<'_> {
    fn object_key(&self, object: &Expression<'_>) -> Option<BindingKey> {
        let Expression::Identifier(identifier) = object else {
            return None;
        };
        self.identity.key_of_reference(identifier)
    }
}

impl<'a> VisitJs<'a> for NamespaceMemberScanner<'_> {
    fn visit_static_member_expression(&mut self, member: &StaticMemberExpression<'a>) {
        if let Some(binding) = self.object_key(&member.object) {
            if self.candidates.contains(&binding) {
                if member.optional {
                    self.usage.disqualified.insert(binding);
                } else {
                    self.usage
                        .members
                        .entry(binding)
                        .or_default()
                        .insert(member.property.name.to_string());
                }
                return;
            }
        }
        walk_js::walk_static_member_expression(self, member);
    }

    fn visit_computed_member_expression(&mut self, member: &ComputedMemberExpression<'a>) {
        if let Some(binding) = self.object_key(&member.object) {
            if self.candidates.contains(&binding) {
                if member.optional {
                    self.usage.disqualified.insert(binding);
                    self.visit_expression(&member.expression);
                    return;
                }
                let names = super::namespace::flow_oxc::finite_property_names(&member.expression)
                    .or_else(|| {
                        let Expression::Identifier(identifier) = &member.expression else {
                            return None;
                        };
                        self.identity
                            .key_of_reference(identifier)
                            .and_then(|key| self.finite_property_bindings.get(&key).cloned())
                    });
                if let Some(names) = names {
                    self.usage.members.entry(binding).or_default().extend(names);
                } else {
                    self.usage.disqualified.insert(binding);
                }
                self.visit_expression(&member.expression);
                return;
            }
        }
        walk_js::walk_computed_member_expression(self, member);
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if let Some(binding) = self.identity.key_of_reference(identifier) {
            if self.candidates.contains(&binding) {
                self.usage.disqualified.insert(binding);
            }
        }
    }
}
