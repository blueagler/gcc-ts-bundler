//! Statement-level type-metadata delivery.

use std::collections::HashSet;

use oxc_ast::ast::*;
use oxc_codegen::{Codegen, Gen};

use super::super::identity::ModuleIdentity;
use super::super::lowering::closure_input_codegen_options;
use super::super::nocollapse::NocollapseAssignments;
use super::super::type_metadata::{
    annotation_target_label, compose_annotations, insert_before_class_member,
    insert_before_object_member, is_class_declaration_text, merge_jsdoc_blocks,
    render_class_field_declaration, render_template,
};
use super::bind::declared_statement_ids;
use super::prepare::PreparedTypeMetadata;
use crate::closure_metadata::{ClosureAnnotation, ClosureAnnotationTarget, TypeMetadataDiagnostic};

struct RenderedMemberAnnotation {
    annotation: ClosureAnnotation,
    target: String,
    text: String,
}

impl PreparedTypeMetadata {
    pub(crate) fn render_statement_with_nocollapse(
        &mut self,
        identity: &ModuleIdentity,
        mut statement: Statement<'_>,
        tags: &[&str],
        nocollapse_assignments: Option<&NocollapseAssignments>,
    ) -> std::result::Result<String, String> {
        let binding_ids = declared_statement_ids(&statement, identity);
        if binding_ids.len() > 1 {
            let mut had_metadata = false;
            for binding in &binding_ids {
                had_metadata |= self.binding_annotations.remove(binding).is_some();
                had_metadata |= self.member_annotations.remove(binding).is_some();
            }
            if had_metadata {
                self.delivery
                    .diagnostics
                    .push(TypeMetadataDiagnostic::delivery(
                        &self.metadata,
                        "annotation-target-not-found",
                        None,
                        Some("multi-declarator statement".to_string()),
                    ));
            }
            return Ok(format!(
                "{}{}",
                compose_annotations(tags, None),
                print_statement(&statement)
            ));
        }

        let annotation_owner = binding_ids.first().copied();
        let binding_annotations = annotation_owner
            .as_ref()
            .and_then(|binding| self.binding_annotations.remove(binding))
            .unwrap_or_default();
        let member_annotations = annotation_owner
            .as_ref()
            .and_then(|binding| self.member_annotations.remove(binding))
            .unwrap_or_default();

        let mut binding_blocks = Vec::new();
        for annotation in binding_annotations {
            let target = annotation_target_label(&annotation.target);
            let rendered = render_template(
                &self.metadata,
                &annotation.template,
                &annotation.references,
                &self.symbols_by_id,
                &self.symbol_resolutions,
                Some(target),
            );
            self.delivery.counts.unresolvedTypeReferenceCount += rendered.unresolved_count;
            self.delivery.diagnostics.extend(rendered.diagnostics);
            if annotation.type_bearing {
                self.delivery.counts.annotationCount += 1;
            }
            binding_blocks.push(rendered.text);
        }

        let rendered_members = member_annotations
            .into_iter()
            .map(|annotation| {
                let target = annotation_target_label(&annotation.target);
                let rendered = render_template(
                    &self.metadata,
                    &annotation.template,
                    &annotation.references,
                    &self.symbols_by_id,
                    &self.symbol_resolutions,
                    Some(target.clone()),
                );
                self.delivery.counts.unresolvedTypeReferenceCount += rendered.unresolved_count;
                self.delivery.diagnostics.extend(rendered.diagnostics);
                RenderedMemberAnnotation {
                    annotation,
                    target,
                    text: rendered.text,
                }
            })
            .collect::<Vec<_>>();

        remove_bound_valueless_class_fields(&mut statement, &rendered_members);
        let owner_name = annotation_owner.map(|binding| identity.symbol(binding).to_string());
        let mut code = print_statement(&statement);
        if let Some(nocollapse_assignments) = nocollapse_assignments {
            code = nocollapse_assignments.annotate_rendered_statement(&statement, code)?;
        }
        let mut after = Vec::new();
        for rendered in rendered_members {
            let ClosureAnnotationTarget::Member {
                member_kind,
                member_name,
                is_static,
                ..
            } = &rendered.annotation.target
            else {
                continue;
            };
            let delivered = if member_kind == "field" && is_class_declaration_text(&code) {
                if let Some(owner_name) = owner_name.as_deref() {
                    after.push(render_class_field_declaration(
                        owner_name,
                        member_name,
                        *is_static,
                        &rendered.text,
                    ));
                    true
                } else {
                    false
                }
            } else if is_class_declaration_text(&code) {
                insert_before_class_member(
                    &mut code,
                    member_kind,
                    member_name,
                    *is_static,
                    &rendered.text,
                )
            } else {
                insert_before_object_member(&mut code, member_kind, member_name, &rendered.text)
            };
            if delivered {
                if rendered.annotation.type_bearing {
                    self.delivery.counts.memberAnnotationCount += 1;
                }
            } else {
                self.delivery
                    .diagnostics
                    .push(TypeMetadataDiagnostic::delivery(
                        &self.metadata,
                        "member-target-not-found",
                        None,
                        Some(rendered.target),
                    ));
            }
        }

        let typed = merge_jsdoc_blocks(&binding_blocks);
        let prefix = compose_annotations(tags, typed.as_deref());
        if after.is_empty() {
            Ok(format!("{prefix}{code}"))
        } else {
            Ok(format!("{prefix}{code}\n{}", after.join("\n")))
        }
    }
}

fn remove_bound_valueless_class_fields(
    statement: &mut Statement<'_>,
    members: &[RenderedMemberAnnotation],
) {
    let Statement::ClassDeclaration(class) = statement else {
        return;
    };
    let fields = members
        .iter()
        .filter_map(|rendered| match &rendered.annotation.target {
            ClosureAnnotationTarget::Member {
                member_kind,
                member_name,
                is_static,
                ..
            } if member_kind == "field" => Some((member_name.as_str(), *is_static)),
            _ => None,
        })
        .collect::<HashSet<_>>();
    if fields.is_empty() {
        return;
    }
    class.body.body.retain(|element| {
        let ClassElement::PropertyDefinition(property) = element else {
            return true;
        };
        if property.value.is_some() {
            return true;
        }
        let Some(name) = property_key_to_string(&property.key) else {
            return true;
        };
        !fields.contains(&(name.as_str(), property.r#static))
    });
}

fn property_key_to_string(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

fn print_statement(statement: &Statement<'_>) -> String {
    let mut codegen = Codegen::new().with_options(closure_input_codegen_options());
    statement.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
}
