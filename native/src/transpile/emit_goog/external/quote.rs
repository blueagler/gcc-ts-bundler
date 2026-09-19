//! Quote member accesses that cross an external module boundary.

use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ChainElement, Expression, ImportDeclarationSpecifier, ImportOrExportKind, Program, Statement,
    VariableDeclarator,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk, Visit, VisitMut};
use oxc_span::GetSpan;

use super::super::super::identity::{BindingKeySet, ModuleIdentity};
use super::super::super::{resolved_import_key, TranspileContext};
use super::identity::ExternalBoundaryEvidence;
use crate::closure_metadata::ClosureFileMetadata;

pub(crate) fn quote_external_boundary_accesses<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    evidence: ExternalBoundaryEvidence,
) -> Result<(), String> {
    let external_root_starts = file_metadata
        .map(|metadata| {
            metadata
                .external_global_member_accesses
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let external_member_starts = file_metadata
        .map(|metadata| {
            metadata
                .external_global_member_accesses
                .iter()
                .chain(
                    (evidence == ExternalBoundaryEvidence::All)
                        .then_some(metadata.external_owned_member_accesses.as_slice())
                        .into_iter()
                        .flatten(),
                )
                .copied()
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let mut candidates = BindingKeySet::default();
    if evidence == ExternalBoundaryEvidence::All {
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            if !context
                .external_specifiers
                .contains_key(&resolved_import_key(
                    file_path,
                    import.source.value.as_str(),
                ))
            {
                continue;
            }
            if import.import_kind == ImportOrExportKind::Type {
                continue;
            }
            for specifier in import.specifiers.iter().flatten() {
                match specifier {
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                        candidates.insert(ModuleIdentity::key_of_binding(&default.local)?);
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                        candidates.insert(ModuleIdentity::key_of_binding(&namespace.local)?);
                    }
                    ImportDeclarationSpecifier::ImportSpecifier(named)
                        if named.import_kind != ImportOrExportKind::Type =>
                    {
                        candidates.insert(ModuleIdentity::key_of_binding(&named.local)?);
                    }
                    ImportDeclarationSpecifier::ImportSpecifier(_) => {}
                }
            }
        }
    }
    if candidates.is_empty() && external_member_starts.is_empty() {
        return Ok(());
    }
    loop {
        let mut collector = ExternalDerivedBindingCollector {
            candidates: &mut candidates,
            changed: false,
            error: None,
            external_root_starts: &external_root_starts,
            identity,
        };
        collector.visit_program(program);
        if let Some(error) = collector.error {
            return Err(error);
        }
        if !collector.changed {
            break;
        }
    }
    ExternalBoundaryAccessQuoter {
        allocator,
        builder: AstBuilder::new(allocator),
        candidates,
        external_member_starts,
        external_root_starts,
        identity,
    }
    .visit_program(program);
    Ok(())
}

pub(crate) struct ExternalBoundaryAccessQuoter<'a, 'b> {
    pub(crate) allocator: &'a Allocator,
    pub(crate) builder: AstBuilder<'a>,
    pub(crate) candidates: BindingKeySet,
    pub(crate) external_member_starts: HashSet<u32>,
    pub(crate) external_root_starts: HashSet<u32>,
    pub(crate) identity: &'b ModuleIdentity,
}

impl ExternalBoundaryAccessQuoter<'_, '_> {
    pub(crate) fn is_external_boundary_value(&self, expression: &Expression<'_>) -> bool {
        is_external_boundary_value(
            expression,
            &self.candidates,
            &self.external_root_starts,
            self.identity,
        )
    }
}

struct ExternalDerivedBindingCollector<'b> {
    candidates: &'b mut BindingKeySet,
    changed: bool,
    error: Option<String>,
    external_root_starts: &'b HashSet<u32>,
    identity: &'b ModuleIdentity,
}

impl<'a> Visit<'a> for ExternalDerivedBindingCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if self.error.is_some() {
            return;
        }
        if declarator.init.as_ref().is_some_and(|initializer| {
            is_external_boundary_value(
                initializer,
                self.candidates,
                self.external_root_starts,
                self.identity,
            )
        }) {
            if let Some(binding) = declarator.id.get_binding_identifier() {
                match ModuleIdentity::key_of_binding(binding) {
                    Ok(binding) => self.changed |= self.candidates.insert(binding),
                    Err(error) => {
                        self.error = Some(error);
                        return;
                    }
                }
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

fn is_external_boundary_value(
    expression: &Expression<'_>,
    candidates: &BindingKeySet,
    external_member_starts: &HashSet<u32>,
    identity: &ModuleIdentity,
) -> bool {
    let recurse = |expression| {
        is_external_boundary_value(expression, candidates, external_member_starts, identity)
    };
    match expression {
        Expression::Identifier(identifier) => identity
            .key_of_reference(identifier)
            .is_some_and(|binding| candidates.contains(&binding)),
        Expression::StaticMemberExpression(member) => {
            // Object.assign returns its first argument. Treating the method as
            // an opaque boundary quotes result reads but not the copied writes.
            !(member.property.name == "assign"
                && matches!(&member.object, Expression::Identifier(object)
                    if object.name == "Object" && identity.key_of_reference(object).is_none()))
                && (external_member_starts.contains(&member.property.span.start)
                    || recurse(&member.object))
        }
        Expression::ComputedMemberExpression(member) => {
            external_member_starts.contains(&member.expression.span().start)
                || recurse(&member.object)
        }
        Expression::AssignmentExpression(assignment) => recurse(&assignment.right),
        Expression::AwaitExpression(awaited) => recurse(&awaited.argument),
        Expression::CallExpression(call) => recurse(&call.callee),
        Expression::ConditionalExpression(conditional) => {
            recurse(&conditional.consequent) || recurse(&conditional.alternate)
        }
        Expression::LogicalExpression(logical) => recurse(&logical.left) || recurse(&logical.right),
        Expression::NewExpression(constructor) => recurse(&constructor.callee),
        Expression::ParenthesizedExpression(parenthesized) => recurse(&parenthesized.expression),
        Expression::SequenceExpression(sequence) => {
            sequence.expressions.last().is_some_and(recurse)
        }
        Expression::TaggedTemplateExpression(tagged) => recurse(&tagged.tag),
        Expression::TSAsExpression(expression) => recurse(&expression.expression),
        Expression::TSSatisfiesExpression(expression) => recurse(&expression.expression),
        Expression::TSTypeAssertion(expression) => recurse(&expression.expression),
        Expression::TSNonNullExpression(expression) => recurse(&expression.expression),
        Expression::TSInstantiationExpression(expression) => recurse(&expression.expression),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => {
                external_member_starts.contains(&member.property.span.start)
                    || recurse(&member.object)
            }
            ChainElement::ComputedMemberExpression(member) => {
                external_member_starts.contains(&member.expression.span().start)
                    || recurse(&member.object)
            }
            ChainElement::CallExpression(call) => recurse(&call.callee),
            ChainElement::TSNonNullExpression(expression) => recurse(&expression.expression),
            ChainElement::PrivateFieldExpression(_) => false,
        },
        _ => false,
    }
}
