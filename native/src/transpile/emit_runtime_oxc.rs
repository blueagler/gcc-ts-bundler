//! Oxc counterparts of `emit_runtime.rs`'s identity-based export readers.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};

use super::identity_oxc::{BindingKey, BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::imports_exports::BundlerExportSlotMode;

pub(crate) fn collect_local_export_modes(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> HashMap<String, BundlerExportSlotMode> {
    let mut candidates = BindingKeyMap::<(String, BundlerExportSlotMode)>::new();
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(declaration) => {
                for specifier in declaration.specifiers.iter().flatten() {
                    let local = match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(specifier) => &specifier.local,
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                            &specifier.local
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                            &specifier.local
                        }
                    };
                    candidates.insert(
                        identity.key_of_binding(local),
                        (local.name.to_string(), BundlerExportSlotMode::Live),
                    );
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    collect_declaration_candidates(declaration, identity, &mut candidates);
                }
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    if let Some(binding) = &function.id {
                        candidates.insert(
                            identity.key_of_binding(binding),
                            (binding.name.to_string(), BundlerExportSlotMode::Static),
                        );
                    }
                }
                ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                    if let Some(binding) = &class.id {
                        candidates.insert(
                            identity.key_of_binding(binding),
                            (binding.name.to_string(), BundlerExportSlotMode::Static),
                        );
                    }
                }
                _ => {}
            },
            Statement::VariableDeclaration(declaration) => {
                collect_variable_candidates(declaration, identity, &mut candidates)
            }
            Statement::FunctionDeclaration(function) => {
                if let Some(binding) = &function.id {
                    candidates.insert(
                        identity.key_of_binding(binding),
                        (binding.name.to_string(), BundlerExportSlotMode::Static),
                    );
                }
            }
            Statement::ClassDeclaration(class) => {
                if let Some(binding) = &class.id {
                    candidates.insert(
                        identity.key_of_binding(binding),
                        (binding.name.to_string(), BundlerExportSlotMode::Static),
                    );
                }
            }
            _ => {}
        }
    }

    let tracked = candidates.keys().copied().collect();
    let reassigned = collect_reassigned_binding_ids(program, identity, tracked);
    candidates
        .into_iter()
        .map(|(binding, (name, mode))| {
            let mode = if reassigned.contains(&binding) {
                BundlerExportSlotMode::Live
            } else {
                mode
            };
            (name, mode)
        })
        .collect()
}

fn collect_declaration_candidates(
    declaration: &Declaration<'_>,
    identity: &ModuleIdentity,
    candidates: &mut BindingKeyMap<(String, BundlerExportSlotMode)>,
) {
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            collect_variable_candidates(declaration, identity, candidates);
        }
        Declaration::FunctionDeclaration(function) => {
            if let Some(binding) = &function.id {
                candidates.insert(
                    identity.key_of_binding(binding),
                    (binding.name.to_string(), BundlerExportSlotMode::Static),
                );
            }
        }
        Declaration::ClassDeclaration(class) => {
            if let Some(binding) = &class.id {
                candidates.insert(
                    identity.key_of_binding(binding),
                    (binding.name.to_string(), BundlerExportSlotMode::Static),
                );
            }
        }
        _ => {}
    }
}

fn collect_variable_candidates(
    declaration: &VariableDeclaration<'_>,
    identity: &ModuleIdentity,
    candidates: &mut BindingKeyMap<(String, BundlerExportSlotMode)>,
) {
    let mode = if declaration.kind == VariableDeclarationKind::Const {
        BundlerExportSlotMode::Static
    } else {
        BundlerExportSlotMode::Live
    };
    for declarator in &declaration.declarations {
        for (binding, name) in binding_names_with_ids(&declarator.id, identity) {
            candidates.insert(binding, (name, mode));
        }
    }
}

pub(crate) fn binding_names_with_ids(
    pattern: &BindingPattern<'_>,
    identity: &ModuleIdentity,
) -> Vec<(BindingKey, String)> {
    match pattern {
        BindingPattern::BindingIdentifier(binding) => {
            vec![(identity.key_of_binding(binding), binding.name.to_string())]
        }
        BindingPattern::ArrayPattern(array) => {
            let mut bindings = array
                .elements
                .iter()
                .flatten()
                .flat_map(|element| binding_names_with_ids(element, identity))
                .collect::<Vec<_>>();
            if let Some(rest) = &array.rest {
                bindings.extend(binding_names_with_ids(&rest.argument, identity));
            }
            bindings
        }
        BindingPattern::ObjectPattern(object) => {
            let mut bindings = object
                .properties
                .iter()
                .flat_map(|property| binding_names_with_ids(&property.value, identity))
                .collect::<Vec<_>>();
            if let Some(rest) = &object.rest {
                bindings.extend(binding_names_with_ids(&rest.argument, identity));
            }
            bindings
        }
        BindingPattern::AssignmentPattern(assignment) => {
            binding_names_with_ids(&assignment.left, identity)
        }
    }
}

pub(crate) fn collect_reassigned_binding_ids(
    program: &Program<'_>,
    identity: &ModuleIdentity,
    tracked: BindingKeySet,
) -> BindingKeySet {
    let mut collector = ReassignedBindingCollector {
        identity,
        reassigned: HashSet::new(),
        tracked,
    };
    collector.visit_program(program);
    collector.reassigned
}

struct ReassignedBindingCollector<'a> {
    identity: &'a ModuleIdentity,
    reassigned: BindingKeySet,
    tracked: BindingKeySet,
}

impl ReassignedBindingCollector<'_> {
    fn note_reference(&mut self, identifier: &IdentifierReference<'_>) {
        let Some(binding) = self.identity.key_of_reference(identifier) else {
            return;
        };
        if self.tracked.contains(&binding) {
            self.reassigned.insert(binding);
        }
    }

    fn note_expression_target(&mut self, expression: &Expression<'_>) {
        if let Expression::Identifier(identifier) = expression.without_parentheses() {
            self.note_reference(identifier);
        }
    }

    fn note_simple_target(&mut self, target: &SimpleAssignmentTarget<'_>) {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) => {
                self.note_reference(identifier);
            }
            SimpleAssignmentTarget::TSAsExpression(expression) => {
                self.note_expression_target(&expression.expression);
            }
            SimpleAssignmentTarget::TSSatisfiesExpression(expression) => {
                self.note_expression_target(&expression.expression);
            }
            SimpleAssignmentTarget::TSNonNullExpression(expression) => {
                self.note_expression_target(&expression.expression);
            }
            SimpleAssignmentTarget::TSTypeAssertion(expression) => {
                self.note_expression_target(&expression.expression);
            }
            _ => {}
        }
    }

    fn note_target(&mut self, target: &AssignmentTarget<'_>) {
        if let Some(simple) = target.as_simple_assignment_target() {
            self.note_simple_target(simple);
            return;
        }
        match target {
            AssignmentTarget::ArrayAssignmentTarget(array) => {
                for element in array.elements.iter().flatten() {
                    self.note_maybe_default_target(element);
                }
                if let Some(rest) = &array.rest {
                    self.note_target(&rest.target);
                }
            }
            AssignmentTarget::ObjectAssignmentTarget(object) => {
                for property in &object.properties {
                    match property {
                        AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                            self.note_reference(&property.binding);
                        }
                        AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                            self.note_maybe_default_target(&property.binding);
                        }
                    }
                }
                if let Some(rest) = &object.rest {
                    self.note_target(&rest.target);
                }
            }
            _ => {}
        }
    }

    fn note_maybe_default_target(&mut self, target: &AssignmentTargetMaybeDefault<'_>) {
        match target {
            AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) => {
                self.note_target(&default.binding);
            }
            _ => self.note_target(target.to_assignment_target()),
        }
    }
}

impl<'a> Visit<'a> for ReassignedBindingCollector<'_> {
    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        walk::walk_assignment_expression(self, assignment);
        self.note_target(&assignment.left);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        walk::walk_update_expression(self, update);
        self.note_simple_target(&update.argument);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;

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

    fn swc_modes(source: &str) -> HashMap<String, BundlerExportSlotMode> {
        super::super::emit_runtime::resolved_local_export_modes_for_test(source)
    }

    #[test]
    fn local_export_modes_and_reassignments_match_resolved_swc() {
        let source = r#"
import imported from "./dep.js";
const stable = 1;
let live = 1;
var dynamic = 1;
const [arrayValue, ...arrayRest] = values;
const { first: objectValue, nested: { value: nestedValue }, ...objectRest } = object;
function stableFn() {}
function reassignedFn() {}
class StableClass {}
class ReassignedClass {}
function shadowed() {}
function inner(shadowed) { shadowed = 1; }
export const exported = 1;
export default function DefaultFn() {}
[arrayValue, ...arrayRest] = nextValues;
({ first: objectValue, nested: { value: nestedValue }, ...objectRest } = nextObject);
reassignedFn = () => {};
ReassignedClass = class {};
exported++;
"#;
        let allocator = Allocator::default();
        let (program, identity) = parse(&allocator, source);
        let oxc = collect_local_export_modes(&program, &identity);
        assert_eq!(oxc, swc_modes(source));
        assert_eq!(
            oxc,
            HashMap::from([
                ("DefaultFn".to_string(), BundlerExportSlotMode::Static),
                ("ReassignedClass".to_string(), BundlerExportSlotMode::Live),
                ("StableClass".to_string(), BundlerExportSlotMode::Static),
                ("arrayRest".to_string(), BundlerExportSlotMode::Live),
                ("arrayValue".to_string(), BundlerExportSlotMode::Live),
                ("dynamic".to_string(), BundlerExportSlotMode::Live),
                ("exported".to_string(), BundlerExportSlotMode::Live),
                ("imported".to_string(), BundlerExportSlotMode::Live),
                ("live".to_string(), BundlerExportSlotMode::Live),
                ("inner".to_string(), BundlerExportSlotMode::Static),
                ("nestedValue".to_string(), BundlerExportSlotMode::Live),
                ("objectRest".to_string(), BundlerExportSlotMode::Live),
                ("objectValue".to_string(), BundlerExportSlotMode::Live),
                ("reassignedFn".to_string(), BundlerExportSlotMode::Live),
                ("shadowed".to_string(), BundlerExportSlotMode::Static),
                ("stable".to_string(), BundlerExportSlotMode::Static),
                ("stableFn".to_string(), BundlerExportSlotMode::Static),
            ])
        );
    }
}
