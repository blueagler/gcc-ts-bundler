// Owned lowering: const-enum inlining and erasure.
//
// Oxc can optimize local enums, but its isolated-module preservation and export
// policies differ from this pipeline's cross-file erasure contract. Collect
// values before lowering, inline only references to the selected root binding,
// and erase the lowered const-enum objects.

use oxc_allocator::Allocator;
use oxc_ast::ast::{Declaration, Expression, Program, Statement, TSEnumMemberName, UnaryOperator};
#[cfg(test)]
use oxc_span::SourceType;
use oxc_syntax::number::NumberBase;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum EnumValue {
    Number(f64),
    String(String),
}

pub(crate) type EnumValues = HashMap<String, HashMap<String, EnumValue>>;

/// `enum name -> member name -> value`, for enums whose members all fold.
fn collect_enum_values_where(program: &Program<'_>, only_const: bool) -> EnumValues {
    let mut enums = HashMap::new();
    for statement in &program.body {
        let declaration = match statement {
            Statement::TSEnumDeclaration(declaration) => Some(&**declaration),
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::TSEnumDeclaration(declaration) => Some(&**declaration),
                _ => None,
            },
            _ => None,
        };
        let Some(declaration) = declaration else {
            continue;
        };
        if only_const && !declaration.r#const {
            continue;
        }
        let mut members = HashMap::new();
        let mut next_number = 0f64;
        let mut auto_numbering = true;
        for member in &declaration.body.members {
            let name = match &member.id {
                TSEnumMemberName::Identifier(id) => id.name.to_string(),
                TSEnumMemberName::String(literal) => literal.value.to_string(),
                _ => continue,
            };
            let value = match &member.initializer {
                Some(initializer) => {
                    let Some(value) =
                        fold_enum_initializer(initializer, &declaration.id.name, &members)
                    else {
                        auto_numbering = false;
                        continue;
                    };
                    if let EnumValue::Number(number) = value {
                        next_number = number + 1.0;
                        auto_numbering = true;
                    } else {
                        auto_numbering = false;
                    }
                    value
                }
                None if auto_numbering => {
                    let value = EnumValue::Number(next_number);
                    next_number += 1.0;
                    value
                }
                None => continue,
            };
            members.insert(name, value);
        }
        if !members.is_empty() {
            enums.insert(declaration.id.name.to_string(), members);
        }
    }
    enums
}

pub(crate) fn collect_enum_values(program: &Program<'_>) -> EnumValues {
    collect_enum_values_where(program, false)
}

pub(crate) fn collect_const_enum_values(program: &Program<'_>) -> EnumValues {
    collect_enum_values_where(program, true)
}

pub(crate) fn remove_enum_declarations(program: &mut Program<'_>, names: &HashSet<String>) {
    if names.is_empty() {
        return;
    }
    program.body.retain(|statement| {
        let name = match statement {
            Statement::TSEnumDeclaration(declaration) => Some(declaration.id.name.as_str()),
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::TSEnumDeclaration(declaration) => Some(declaration.id.name.as_str()),
                _ => None,
            },
            _ => None,
        };
        name.is_none_or(|name| !names.contains(name))
    });
}

/// The TypeScript constant-expression grammar, matching `enums.rs`'s folder.
fn fold_enum_initializer(
    expression: &Expression<'_>,
    enum_name: &str,
    already: &HashMap<String, EnumValue>,
) -> Option<EnumValue> {
    let fold = |inner| fold_enum_initializer(inner, enum_name, already);
    match expression {
        Expression::NumericLiteral(literal) => Some(EnumValue::Number(literal.value)),
        Expression::StringLiteral(literal) => Some(EnumValue::String(literal.value.to_string())),
        // `Down = 1 + Up`: a bare reference to an earlier member.
        Expression::Identifier(identifier) => already.get(identifier.name.as_str()).cloned(),
        // `Down = 1 + Dir.Up`: the same thing, qualified.
        Expression::StaticMemberExpression(member) => {
            let Expression::Identifier(object) = &member.object else {
                return None;
            };
            if object.name != enum_name {
                return None;
            }
            already.get(member.property.name.as_str()).cloned()
        }
        Expression::ParenthesizedExpression(parenthesized) => fold(&parenthesized.expression),
        Expression::UnaryExpression(unary) => {
            let EnumValue::Number(value) = fold(&unary.argument)? else {
                return None;
            };
            match unary.operator {
                UnaryOperator::UnaryNegation => Some(EnumValue::Number(-value)),
                UnaryOperator::UnaryPlus => Some(EnumValue::Number(value)),
                UnaryOperator::BitwiseNot => Some(EnumValue::Number(f64::from(!to_int32(value)))),
                _ => None,
            }
        }
        Expression::BinaryExpression(binary) => {
            let EnumValue::Number(left) = fold(&binary.left)? else {
                return None;
            };
            let EnumValue::Number(right) = fold(&binary.right)? else {
                return None;
            };
            let folded = match binary.operator {
                oxc_ast::ast::BinaryOperator::Addition => left + right,
                oxc_ast::ast::BinaryOperator::Subtraction => left - right,
                oxc_ast::ast::BinaryOperator::Multiplication => left * right,
                oxc_ast::ast::BinaryOperator::Division => left / right,
                oxc_ast::ast::BinaryOperator::Remainder => left % right,
                oxc_ast::ast::BinaryOperator::Exponential => left.powf(right),
                oxc_ast::ast::BinaryOperator::BitwiseOR => {
                    f64::from(to_int32(left) | to_int32(right))
                }
                oxc_ast::ast::BinaryOperator::BitwiseAnd => {
                    f64::from(to_int32(left) & to_int32(right))
                }
                oxc_ast::ast::BinaryOperator::BitwiseXOR => {
                    f64::from(to_int32(left) ^ to_int32(right))
                }
                oxc_ast::ast::BinaryOperator::ShiftLeft => {
                    f64::from(to_int32(left) << (to_uint32(right) & 31))
                }
                oxc_ast::ast::BinaryOperator::ShiftRight => {
                    f64::from(to_int32(left) >> (to_uint32(right) & 31))
                }
                oxc_ast::ast::BinaryOperator::ShiftRightZeroFill => {
                    f64::from(to_uint32(left) >> (to_uint32(right) & 31))
                }
                _ => return None,
            };
            Some(EnumValue::Number(folded))
        }
        _ => None,
    }
}

fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() {
        return 0;
    }
    (value.trunc().rem_euclid(4_294_967_296.0)) as u32
}

fn to_int32(value: f64) -> i32 {
    to_uint32(value) as i32
}

/// Rewrites `Dir.Up` reads to their folded literal, and drops the runtime object
/// oxc emitted for the const enum.
pub(super) struct ConstEnumInliner<'a, 'v> {
    pub(super) allocator: &'a Allocator,
    pub(super) builder: oxc_ast::builder::AstBuilder<'a>,
    pub(super) values: &'v EnumValues,
    pub(super) scoping: &'v mut oxc_semantic::Scoping,
}

impl<'a> oxc_ast_visit::VisitMut<'a> for ConstEnumInliner<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        oxc_ast_visit::walk_mut::walk_expression(self, expression);
        let Expression::StaticMemberExpression(member) = expression else {
            return;
        };
        let Expression::Identifier(object) = &member.object else {
            return;
        };
        let Some(members) = self.values.get(object.name.as_str()) else {
            return;
        };
        let Some(reference_id) = object.reference_id.get() else {
            return;
        };
        let symbol_id = self.scoping.get_reference(reference_id).symbol_id();
        // Metadata-selected enums may already have been erased before semantic
        // analysis; only their unresolved reads qualify. Local/imported enums
        // must resolve to the actual root binding, never a shadowing parameter.
        if symbol_id != self.scoping.get_root_binding(object.name) {
            return;
        }
        let Some(value) = members.get(member.property.name.as_str()) else {
            return;
        };
        if symbol_id.is_some() {
            self.scoping.delete_reference(reference_id);
        } else {
            self.scoping
                .delete_root_unresolved_reference(object.name, reference_id);
        }
        *expression = match value {
            EnumValue::Number(number) => {
                // Negative values are a unary expression, not a literal.
                if *number < 0.0 {
                    let literal = Expression::new_numeric_literal(
                        oxc_span::SPAN,
                        -number,
                        None,
                        NumberBase::Decimal,
                        &self.builder,
                    );
                    Expression::new_unary_expression(
                        oxc_span::SPAN,
                        UnaryOperator::UnaryNegation,
                        literal,
                        &self.builder,
                    )
                } else {
                    Expression::new_numeric_literal(
                        oxc_span::SPAN,
                        *number,
                        None,
                        NumberBase::Decimal,
                        &self.builder,
                    )
                }
            }
            EnumValue::String(text) => {
                let value: oxc_str::Str<'a> =
                    oxc_allocator::FromIn::from_in(text.as_str(), self.allocator);
                Expression::new_string_literal(oxc_span::SPAN, value, None, &self.builder)
            }
        };
    }
}

/// Drops the lowered runtime object for every const enum we inlined.
///
/// TypeScript erases a `const enum`; oxc emits the object anyway, and leaving it
/// would ship bytes no legal program can reach *and* make the erased value
/// observable (`import * as m; m.ConstEnum` would return an object where `tsc`
/// gives `undefined`) -- the divergence the tsickle export corpus caught.
pub(super) fn erase_const_enum_objects(program: &mut Program<'_>, inlined: &EnumValues) {
    program.body.retain(|statement| {
        let declared = match statement {
            Statement::VariableDeclaration(declaration) => declaration
                .declarations
                .first()
                .and_then(|declarator| declarator.id.get_binding_identifier())
                .map(|binding| binding.name.to_string()),
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::VariableDeclaration(declaration) => declaration
                    .declarations
                    .first()
                    .and_then(|declarator| declarator.id.get_binding_identifier())
                    .map(|binding| binding.name.to_string()),
                _ => None,
            },
            _ => None,
        };
        declared.is_none_or(|name| !inlined.contains_key(&name))
    });
}

#[cfg(test)]
mod const_enums {
    use super::{collect_const_enum_values, Allocator, EnumValue, SourceType};

    /// The values OXD0 pinned on the swc folder, re-asserted on this one. The
    /// two folders must agree: a disagreement is the silent-divergence class the
    /// safety net exists for.
    #[test]
    fn constant_expression_members_fold_to_the_same_values_as_the_swc_folder(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let allocator = Allocator::default();
        let source = "const enum Dir { Up = 1, Down = 1 + Up, Both = Down << 2, Neg = -Down, Mask = Both | Dir.Up, Half = (Both + 2) / 5, Next }\n";
        let parsed = oxc_parser::Parser::new(&allocator, source, SourceType::ts()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let values = collect_const_enum_values(&parsed.program);
        let dir = values.get("Dir").ok_or("Dir did not fold")?;

        // Up=1, Down=2, Both=8, Neg=-2, Mask=9, Half=2, Next=3 -- auto-numbering
        // resumes from the folded value, exactly as TypeScript does.
        assert_eq!(dir.get("Up"), Some(&EnumValue::Number(1.0)));
        assert_eq!(dir.get("Down"), Some(&EnumValue::Number(2.0)));
        assert_eq!(dir.get("Both"), Some(&EnumValue::Number(8.0)));
        assert_eq!(dir.get("Neg"), Some(&EnumValue::Number(-2.0)));
        assert_eq!(dir.get("Mask"), Some(&EnumValue::Number(9.0)));
        assert_eq!(dir.get("Half"), Some(&EnumValue::Number(2.0)));
        assert_eq!(dir.get("Next"), Some(&EnumValue::Number(3.0)));
        Ok(())
    }

    #[test]
    fn string_members_fold() -> Result<(), Box<dyn std::error::Error>> {
        let allocator = Allocator::default();
        let parsed =
            oxc_parser::Parser::new(&allocator, "const enum L { S = \"s\" }\n", SourceType::ts())
                .parse();
        let values = collect_const_enum_values(&parsed.program);
        assert_eq!(
            values.get("L").and_then(|members| members.get("S")),
            Some(&EnumValue::String("s".to_string()))
        );
        Ok(())
    }

    #[test]
    fn a_plain_enum_is_not_a_const_enum() -> Result<(), Box<dyn std::error::Error>> {
        let allocator = Allocator::default();
        let parsed =
            oxc_parser::Parser::new(&allocator, "enum Plain { A = 1 }\n", SourceType::ts()).parse();
        assert!(collect_const_enum_values(&parsed.program).is_empty());
        Ok(())
    }
}

#[cfg(test)]
mod const_enum_end_to_end {
    //! The gate for "enum inlining ours end-to-end": emit through the real oxc
    //! pipeline and run it. A const enum has no runtime object, so if the reads
    //! were not inlined this throws instead of returning values.
    use super::super::executing::run_emitted;

    #[test]
    fn const_enum_reads_inline_and_the_object_is_erased() -> Result<(), Box<dyn std::error::Error>>
    {
        let probe = run_emitted("lowering", concat!(
        "const enum Dir { Up = 1, Down = 1 + Up, Both = Down << 2, Neg = -Down, Mask = Both | Dir.Up, Half = (Both + 2) / 5, Next }\n",
        "const enum L { S = \"s\" }\n",
        "export const probe = [Dir.Up, Dir.Down, Dir.Both, Dir.Neg, Dir.Mask, Dir.Half, Dir.Next, L.S, typeof Dir].join(\"|\");\n",
    ))?;
        // Values identical to the swc pipeline's, and `typeof Dir` proves the
        // runtime object is gone rather than merely unused.
        assert_eq!(probe, "\"1|2|8|-2|9|2|3|s|undefined\"");
        Ok(())
    }
}
