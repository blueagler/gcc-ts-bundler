//! Oxc counterparts of `hoist.rs`'s identity-based usage readers.

#![allow(dead_code)]

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
                if let Expression::StringLiteral(value) = &member.expression {
                    self.usage
                        .members
                        .entry(binding)
                        .or_default()
                        .insert(value.value.to_string());
                    return;
                }
                self.usage.disqualified.insert(binding);
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

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;
    use std::collections::BTreeMap;
    use std::path::Path;

    fn parse<'a>(allocator: &'a Allocator, source: &'a str) -> (Program<'a>, ModuleIdentity) {
        let parsed = oxc_parser::Parser::new(allocator, source, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let identity = ModuleIdentity::new(
            SemanticBuilder::new()
                .with_build_nodes(true)
                .with_enum_eval(true)
                .build(&parsed.program)
                .semantic
                .into_scoping(),
        );
        (parsed.program, identity)
    }

    fn facts(
        program: &Program<'_>,
        identity: &ModuleIdentity,
    ) -> (BTreeSet<String>, BTreeMap<String, Option<BTreeSet<String>>>) {
        let used = collect_used_binding_ids(program, identity);
        let namespace_usage = scan_namespace_usage(program, identity);
        let mut used_imports = BTreeSet::new();
        let mut namespaces = BTreeMap::new();
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            for specifier in import.specifiers.iter().flatten() {
                let local = match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(specifier) => &specifier.local,
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                        &specifier.local
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                        let local = &specifier.local;
                        let binding = identity.key_of_binding(local);
                        namespaces.insert(
                            local.name.to_string(),
                            namespace_usage.member_only_usage(binding),
                        );
                        local
                    }
                };
                if used.contains(&identity.key_of_binding(local)) {
                    used_imports.insert(local.name.to_string());
                }
            }
        }
        (used_imports, namespaces)
    }

    #[test]
    fn used_imports_and_namespace_member_usage_match_swc() {
        let source = r#"
import defaultUsed, { namedUsed, exportOnly, unused } from "./dep.js";
import * as staticNs from "./static.js";
import * as quotedNs from "./quoted.js";
import * as escapedNs from "./escaped.js";
import * as dynamicNs from "./dynamic.js";
import * as unusedNs from "./unused.js";
export { exportOnly };
void defaultUsed;
void namedUsed;
staticNs.foo;
staticNs?.bar;
quotedNs["baz"];
consume(escapedNs);
dynamicNs[key];
"#;
        let allocator = Allocator::default();
        let (program, identity) = parse(&allocator, source);
        let oxc = facts(&program, &identity);
        let swc_module =
            crate::module_cache::parse_module(Path::new("fixture.js"), source).unwrap();
        let swc = super::super::hoist::usage_facts_for_test(&swc_module);
        assert_eq!(oxc, swc);
        assert_eq!(
            oxc.0,
            BTreeSet::from([
                "defaultUsed".to_string(),
                "dynamicNs".to_string(),
                "escapedNs".to_string(),
                "namedUsed".to_string(),
                "quotedNs".to_string(),
                "staticNs".to_string(),
            ])
        );
        assert_eq!(
            oxc.1,
            BTreeMap::from([
                ("dynamicNs".to_string(), None,),
                ("escapedNs".to_string(), None,),
                (
                    "quotedNs".to_string(),
                    Some(BTreeSet::from(["baz".to_string()])),
                ),
                ("staticNs".to_string(), None),
                ("unusedNs".to_string(), Some(BTreeSet::new())),
            ])
        );
    }

    #[test]
    fn type_space_namespace_reference_is_usage_but_not_runtime_escape() {
        let source = r#"
import * as package from "./dep.js";
type Compiler = typeof package.compiler;
"#;
        let path = Path::new("fixture.ts");
        let allocator = Allocator::default();
        let parsed =
            oxc_parser::Parser::new(&allocator, source, SourceType::from_path(path).unwrap())
                .parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let identity = ModuleIdentity::new(
            SemanticBuilder::new()
                .with_build_nodes(true)
                .with_enum_eval(true)
                .build(&parsed.program)
                .semantic
                .into_scoping(),
        );
        let oxc = facts(&parsed.program, &identity);
        let swc_module = crate::module_cache::parse_module(path, source).unwrap();
        let swc = super::super::hoist::usage_facts_for_test(&swc_module);
        assert_eq!(oxc, swc);
        assert_eq!(oxc.0, BTreeSet::from(["package".to_string()]));
        assert_eq!(
            oxc.1,
            BTreeMap::from([("package".to_string(), Some(BTreeSet::new()))])
        );
    }
}
