use oxc_allocator::{Allocator, TakeIn, Vec as ArenaVec};
use oxc_ast::ast::{
    AssignmentTarget, BindingPattern, Declaration, Expression, IdentifierReference,
    ModuleExportName, Program, Statement, TSNamespaceDeclarationBody, VariableDeclaration,
    VariableDeclarationKind,
};
use oxc_ast::builder::AstBuilder;
use oxc_semantic::Scoping;
use oxc_span::Span;
use oxc_syntax::{
    operator::{AssignmentOperator, LogicalOperator},
    symbol::SymbolId,
};
use std::collections::HashSet;

/// Authored identity from the pre-transform scoping the transformer consumes.
/// Capture after merge: merged namespaces still have redeclarations on this model.
pub(super) struct StableLiteralNamespace {
    symbol: SymbolId,
    span: Span,
}

fn namespace_literal(expression: &Expression<'_>) -> bool {
    matches!(
        expression.get_inner_expression(),
        Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::StringLiteral(_)
    )
}

fn reference_symbol(reference: &IdentifierReference<'_>, scoping: &Scoping) -> Option<SymbolId> {
    scoping
        .get_reference(reference.reference_id.get()?)
        .symbol_id()
}

/// Replacing the IIFE parameter with the outer binding is only sound if even an
/// inherited setter calling arbitrary module callbacks cannot reassign it.
/// A parser's module SourceType alone is insufficient: script globals can be
/// changed by code outside this file. Require an authored ESM marker as well.
pub(super) fn stable_literal_namespaces(
    program: &Program<'_>,
    scoping: &Scoping,
) -> Vec<StableLiteralNamespace> {
    let mut candidates = Vec::new();
    if !program.source_type.is_module()
        || scoping.root_scope_flags().contains_direct_eval()
        || !program.body.iter().any(|statement| {
            matches!(
                statement,
                Statement::ImportDeclaration(_)
                    | Statement::ExportDeclaration(_)
                    | Statement::ExportNamedDeclaration(_)
                    | Statement::ExportDefaultDeclaration(_)
                    | Statement::ExportFromDeclaration(_)
                    | Statement::ExportAllDeclaration(_)
            )
        })
    {
        return candidates;
    }
    for statement in &program.body {
        let Statement::TSNamespaceDeclaration(namespace) = statement else {
            continue;
        };
        let Some(symbol) = namespace.id.symbol_id.get() else {
            continue;
        };
        let TSNamespaceDeclarationBody::TSModuleBlock(body) = &namespace.body else {
            continue;
        };
        if namespace.declare
            || scoping.symbol_scope_id(symbol) != scoping.root_scope_id()
            || !scoping.symbol_redeclarations(symbol).is_empty()
            || scoping
                .get_resolved_references(symbol)
                .any(|reference| reference.flags().is_write())
            || !body.directives.is_empty()
            || body.body.is_empty()
            || !body.body.iter().all(|statement| {
                let Statement::ExportDeclaration(export) = statement else {
                    return false;
                };
                let Declaration::VariableDeclaration(declaration) = &export.declaration else {
                    return false;
                };
                !declaration.declare
                    && declaration.kind == VariableDeclarationKind::Const
                    && !declaration.declarations.is_empty()
                    && declaration.declarations.iter().all(|declarator| {
                        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                            return false;
                        };
                        binding.symbol_id.get().is_some_and(|local| {
                            scoping.symbol_redeclarations(local).is_empty()
                                && scoping.get_resolved_reference_ids(local).is_empty()
                        }) && declarator.init.as_ref().is_some_and(namespace_literal)
                    })
            })
            || program.body.iter().any(|statement| match statement {
                Statement::ExportNamedDeclaration(export) => {
                    export.specifiers.iter().any(|specifier| {
                        let ModuleExportName::IdentifierReference(local) = &specifier.local else {
                            return true;
                        };
                        reference_symbol(local, scoping).is_none_or(|exported| exported == symbol)
                    })
                }
                Statement::ExportDefaultDeclaration(export) => export
                    .declaration
                    .as_expression()
                    .is_some_and(|expression| match expression.get_inner_expression() {
                        Expression::Identifier(ident) => reference_symbol(ident, scoping)
                            .is_none_or(|exported| exported == symbol),
                        _ => false,
                    }),
                _ => false,
            })
        {
            continue;
        }
        candidates.push(StableLiteralNamespace {
            symbol,
            span: namespace.span,
        });
    }
    candidates
}

/// Check the entire generated shape before moving any node. The sole permitted
/// write to the outer SymbolId is the generated `N = {}` initialization, and
/// every body write must target the generated parameter's SymbolId.
fn literal_namespace_call(
    statement: &Statement<'_>,
    previous: &Statement<'_>,
    candidate: &StableLiteralNamespace,
    scoping: &Scoping,
) -> bool {
    let Statement::VariableDeclaration(declaration) = previous else {
        return false;
    };
    if declaration.kind != VariableDeclarationKind::Var
        || declaration.declare
        || declaration.declarations.len() != 1
    {
        return false;
    }
    let declarator = &declaration.declarations[0];
    if declarator.init.is_some()
        || !matches!(&declarator.id, BindingPattern::BindingIdentifier(binding)
            if binding.symbol_id.get() == Some(candidate.symbol))
    {
        return false;
    }
    let Statement::ExpressionStatement(statement) = statement else {
        return false;
    };
    let Expression::CallExpression(call) = &statement.expression else {
        return false;
    };
    if call.span != candidate.span || call.optional || call.arguments.len() != 1 {
        return false;
    }
    let Expression::FunctionExpression(function) = call.callee.without_parentheses() else {
        return false;
    };
    if function.id.is_some()
        || function.r#async
        || function.generator
        || function.params.rest.is_some()
        || function.params.items.len() != 1
    {
        return false;
    }
    let parameter = &function.params.items[0];
    let BindingPattern::BindingIdentifier(parameter_binding) = &parameter.pattern else {
        return false;
    };
    let Some(parameter_symbol) = parameter_binding.symbol_id.get() else {
        return false;
    };
    let Some(function_scope) = function.scope_id.get() else {
        return false;
    };
    let Some(body) = &function.body else {
        return false;
    };
    if parameter.initializer.is_some()
        || !parameter.decorators.is_empty()
        || parameter_symbol == candidate.symbol
        || scoping.symbol_scope_id(parameter_symbol) != function_scope
        || scoping.symbol_scope_id(candidate.symbol) != scoping.root_scope_id()
        || scoping.scope_parent_id(function_scope) != Some(scoping.root_scope_id())
        || !body.directives.is_empty()
        || body.statements.is_empty()
    {
        return false;
    }
    let Some(Expression::LogicalExpression(initialization)) = call.arguments[0].as_expression()
    else {
        return false;
    };
    let Expression::Identifier(read) = &initialization.left else {
        return false;
    };
    let Expression::AssignmentExpression(assignment) = initialization.right.without_parentheses()
    else {
        return false;
    };
    let AssignmentTarget::AssignmentTargetIdentifier(write) = &assignment.left else {
        return false;
    };
    let Some(write_id) = write.reference_id.get() else {
        return false;
    };
    if initialization.operator != LogicalOperator::Or
        || assignment.operator != AssignmentOperator::Assign
        || reference_symbol(read, scoping) != Some(candidate.symbol)
        || reference_symbol(write, scoping) != Some(candidate.symbol)
        || !scoping.get_reference(write_id).flags().is_write()
        || !matches!(&assignment.right, Expression::ObjectExpression(object) if object.properties.is_empty())
        || scoping
            .get_resolved_reference_ids(candidate.symbol)
            .iter()
            .any(|&id| id != write_id && scoping.get_reference(id).flags().is_write())
    {
        return false;
    }
    let mut writes = 0;
    for statement in &body.statements {
        let Statement::VariableDeclaration(declaration) = statement else {
            return false;
        };
        if declaration.declare
            || declaration.kind != VariableDeclarationKind::Const
            || declaration.declarations.is_empty()
        {
            return false;
        }
        for declarator in &declaration.declarations {
            let BindingPattern::BindingIdentifier(local) = &declarator.id else {
                return false;
            };
            let Some(local_symbol) = local.symbol_id.get() else {
                return false;
            };
            let Some(Expression::AssignmentExpression(assignment)) = &declarator.init else {
                return false;
            };
            let object = match &assignment.left {
                AssignmentTarget::StaticMemberExpression(member)
                    if !member.optional && member.property.name == local.name =>
                {
                    &member.object
                }
                AssignmentTarget::ComputedMemberExpression(member)
                    if !member.optional
                        && matches!(&member.expression, Expression::StringLiteral(key)
                            if key.value.as_str() == local.name.as_str()) =>
                {
                    &member.object
                }
                _ => return false,
            };
            let Expression::Identifier(object) = object else {
                return false;
            };
            if assignment.operator != AssignmentOperator::Assign
                || !namespace_literal(&assignment.right)
                || reference_symbol(object, scoping) != Some(parameter_symbol)
                || scoping.symbol_scope_id(local_symbol) != function_scope
                || !scoping.symbol_redeclarations(local_symbol).is_empty()
                || !scoping.get_resolved_reference_ids(local_symbol).is_empty()
            {
                return false;
            }
            writes += 1;
        }
    }
    scoping.get_resolved_reference_ids(parameter_symbol).len() == writes
        && scoping
            .get_resolved_references(parameter_symbol)
            .all(|reference| !reference.flags().is_write())
}

/// Keep the original var declaration and initialization expression at their
/// original position, then emit every assignment in order. No property write
/// disappears, including writes intercepted by Object.prototype setters.
pub(super) fn flatten_literal_namespaces<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    scoping: &Scoping,
    candidates: &[StableLiteralNamespace],
) -> bool {
    if candidates.is_empty() {
        return false;
    }
    let mut matches = Vec::new();
    for (index, pair) in program.body.windows(2).enumerate() {
        if candidates
            .iter()
            .any(|candidate| literal_namespace_call(&pair[1], &pair[0], candidate, scoping))
        {
            matches.push(index + 1);
        }
    }
    if matches.is_empty() {
        return false;
    }
    let builder = AstBuilder::new(allocator);
    let mut statements = ArenaVec::with_capacity_in(program.body.len(), &allocator);
    let mut matches = matches.into_iter().peekable();
    for (index, statement) in program.body.take_in(&allocator).into_iter().enumerate() {
        if matches.peek() != Some(&index) {
            statements.push(statement);
            continue;
        }
        matches.next();
        let Statement::ExpressionStatement(statement) = statement else {
            unreachable!();
        };
        let Expression::CallExpression(mut call) = statement.unbox().expression else {
            unreachable!();
        };
        let initialization = call.arguments.remove(0).into_expression();
        let Expression::LogicalExpression(logical) = &initialization else {
            unreachable!();
        };
        let Expression::Identifier(outer) = &logical.left else {
            unreachable!();
        };
        let name = outer.name;
        statements.push(Statement::new_expression_statement(
            call.span,
            initialization,
            &builder,
        ));
        let Expression::FunctionExpression(function) = call.unbox().callee.into_inner_expression()
        else {
            unreachable!();
        };
        let Some(body) = function.unbox().body else {
            unreachable!();
        };
        for statement in body.unbox().statements {
            let Statement::VariableDeclaration(declaration) = statement else {
                unreachable!();
            };
            for declarator in declaration.unbox().declarations {
                let Some(mut expression) = declarator.init else {
                    unreachable!();
                };
                let Expression::AssignmentExpression(assignment) = &mut expression else {
                    unreachable!();
                };
                let object = match &mut assignment.left {
                    AssignmentTarget::StaticMemberExpression(member) => &mut member.object,
                    AssignmentTarget::ComputedMemberExpression(member) => &mut member.object,
                    _ => unreachable!(),
                };
                let Expression::Identifier(object) = object else {
                    unreachable!();
                };
                object.name = name;
                object.reference_id.set(None);
                statements.push(Statement::new_expression_statement(
                    declarator.span,
                    expression,
                    &builder,
                ));
            }
        }
    }
    program.body = statements;
    true
}

/// TypeScript declaration merging: two `namespace A { … }` blocks are one
/// namespace, and a member declared in either is visible from both.
///
/// Neither front end implements that. swc's `strip` qualifies a member reference
/// only inside the block that declares it, and **oxc's transformer has the same
/// gap** (measured: the merged block emits a bare `Inner` that throws
/// `ReferenceError: Inner is not defined`). So the owned pre-lowering merge that
/// fixed it on swc is needed here too, and this is that pass on the oxc AST.
///
/// Conservative in exactly the same way: a group merges only when it cannot
/// reorder observable work — every block agrees on the `export` modifier,
/// `declare`/qualified-name forms are skipped, and only declarations may sit
/// between the blocks.
pub(super) fn merge_namespace_blocks<'a>(statements: &mut ArenaVec<'a, Statement<'a>>) {
    fn block_info(statement: &Statement<'_>) -> Option<(String, bool)> {
        let (declaration, exported) = match statement {
            Statement::TSNamespaceDeclaration(declaration) => (&**declaration, false),
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::TSNamespaceDeclaration(declaration) => (&**declaration, true),
                _ => return None,
            },
            _ => return None,
        };
        if declaration.declare {
            return None;
        }
        match &declaration.body {
            TSNamespaceDeclarationBody::TSModuleBlock(_) => {
                Some((declaration.id.name.to_string(), exported))
            }
            TSNamespaceDeclarationBody::TSNamespaceDeclaration(_) => None,
        }
    }

    fn block_mut<'a, 'b>(
        statement: &'b mut Statement<'a>,
    ) -> Option<&'b mut ArenaVec<'a, Statement<'a>>> {
        let declaration = match statement {
            Statement::TSNamespaceDeclaration(declaration) => &mut **declaration,
            Statement::ExportDeclaration(export) => match &mut export.declaration {
                Declaration::TSNamespaceDeclaration(declaration) => &mut **declaration,
                _ => return None,
            },
            _ => return None,
        };
        match &mut declaration.body {
            TSNamespaceDeclarationBody::TSModuleBlock(block) => Some(&mut block.body),
            TSNamespaceDeclarationBody::TSNamespaceDeclaration(_) => None,
        }
    }

    /// True when moving a namespace body across this item cannot change what
    /// runs first.
    ///
    /// Note `is_declaration()` alone is wrong here: `export function f() {}` is a
    /// *module* declaration, so the first version of this gate silently refused
    /// to merge across any exported declaration (finding 6's tri-split). An
    /// `export default <expr>` stays disqualifying because it evaluates.
    fn order_neutral(statement: &Statement<'_>) -> bool {
        if matches!(statement, Statement::ExportDefaultDeclaration(_)) {
            return false;
        }
        statement.is_declaration()
            || statement.is_module_declaration()
            || matches!(statement, Statement::EmptyStatement(_))
    }

    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, statement) in statements.iter().enumerate() {
        let Some((name, _)) = block_info(statement) else {
            continue;
        };
        match groups.iter_mut().find(|(known, _)| *known == name) {
            Some((_, indexes)) => indexes.push(index),
            None => groups.push((name, vec![index])),
        }
    }

    let mut absorbed = HashSet::new();
    for (_, indexes) in groups {
        if indexes.len() < 2 {
            continue;
        }
        let exported = block_info(&statements[indexes[0]]).map(|(_, exported)| exported);
        if !indexes
            .iter()
            .all(|index| block_info(&statements[*index]).map(|(_, e)| e) == exported)
        {
            continue;
        }
        let first = indexes[0];
        let last = *indexes.last().unwrap_or(&first);
        if !(first + 1..last)
            .all(|index| indexes.contains(&index) || order_neutral(&statements[index]))
        {
            continue;
        }
        let mut moved: Vec<Statement<'a>> = Vec::new();
        for index in indexes.iter().skip(1) {
            let Some(body) = block_mut(&mut statements[*index]) else {
                continue;
            };
            moved.extend(body.drain(..));
            absorbed.insert(*index);
        }
        if let Some(body) = block_mut(&mut statements[first]) {
            for statement in moved {
                body.push(statement);
            }
        }
    }

    if !absorbed.is_empty() {
        let mut index = 0;
        statements.retain(|_| {
            let keep = !absorbed.contains(&index);
            index += 1;
            keep
        });
    }

    // Recurse after merging: a nested namespace split across two *parent* blocks
    // only becomes a sibling pair once the outer merge has happened.
    for statement in statements.iter_mut() {
        if let Some(body) = block_mut(statement) {
            merge_namespace_blocks(body);
        }
    }
}

/// Names oxc will lower onto a binding of its own: TS enums and namespaces.
///
/// Collected from the *pre*-transform AST, because after lowering there is
/// nothing left to distinguish the generated binding from an authored one.
pub(super) fn hoisted_lowering_names(program: &Program<'_>) -> HashSet<String> {
    fn record(statement: &Statement<'_>, names: &mut HashSet<String>) {
        match statement {
            Statement::TSEnumDeclaration(declaration) => {
                names.insert(declaration.id.name.to_string());
            }
            Statement::TSNamespaceDeclaration(declaration) => {
                names.insert(declaration.id.name.to_string());
            }
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::TSEnumDeclaration(declaration) => {
                    names.insert(declaration.id.name.to_string());
                }
                Declaration::TSNamespaceDeclaration(declaration) => {
                    names.insert(declaration.id.name.to_string());
                }
                _ => {}
            },
            _ => {}
        }
    }

    let mut names = HashSet::new();
    for statement in &program.body {
        record(statement, &mut names);
    }
    names
}

/// Restores `var` semantics for the bindings oxc lowers TS constructs onto.
///
/// `tsc` emits `export var Kind;` for an exported enum and `export var Outer;`
/// for an exported namespace. oxc emits `export let` for both, and `let` has a
/// temporal dead zone: a value-position read that runs before the declaration
/// throws `ReferenceError: Cannot access 'Kind' before initialization` instead
/// of reading `undefined` — and `typeof` does not protect against it either
/// (OX-D3 audit §7, with an executing repro; pinned by the risk-6 test in
/// `test/oxc-migration-safety.test.mjs` and by a cargo regression).
///
/// This is a divergence from tsc's *emit contract*, not a style difference, so
/// the lowering is ours: keep oxc's object-construction shape, take back the
/// binding kind.
pub(super) fn force_var_for_lowered_declarations(
    program: &mut Program<'_>,
    names: &HashSet<String>,
) {
    fn fix(declaration: &mut VariableDeclaration<'_>, names: &HashSet<String>) {
        if declaration.kind == VariableDeclarationKind::Var {
            return;
        }
        let lowered = declaration.declarations.iter().any(|declarator| {
            declarator
                .id
                .get_binding_identifier()
                .is_some_and(|binding| names.contains(binding.name.as_str()))
        });
        if lowered {
            declaration.kind = VariableDeclarationKind::Var;
        }
    }

    for statement in &mut program.body {
        match statement {
            Statement::VariableDeclaration(declaration) => fix(declaration, names),
            Statement::ExportDeclaration(export) => {
                if let Declaration::VariableDeclaration(declaration) = &mut export.declaration {
                    fix(declaration, names);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod namespace_shapes {
    //! Namespace shapes against what the OX-A end-to-end test requires.
    //!
    //! The swc side needed an owned pre-strip pass here: `strip` qualifies a
    //! member reference only inside the block that declares it, so a *merged*
    //! second `namespace A { … }` block emitted bare reads that Closure rejected
    //! (JSC_UNDEFINED_VARIABLE). Whether oxc has the same gap is measured, not
    //! assumed.
    use super::super::executing::run_emitted;

    /// The nesting the OX-A test exercises: three levels, a sibling reference
    /// inside a namespace, and an alias out of the middle of the chain.
    #[test]
    fn a_nested_namespace_chain_executes() -> Result<(), Box<dyn std::error::Error>> {
        let probe = run_emitted("lowering", concat!(
        "export namespace Outer {\n",
        "  export const version = 3;\n",
        "  export namespace Inner {\n",
        "    export const tag = 'INNER';\n",
        "    export function twice(value: number): number { return value * 2; }\n",
        "    export namespace Deep {\n",
        "      export function thrice(value: number): number { return twice(value) + value; }\n",
        "    }\n",
        "  }\n",
        "  export function describe(): string { return `${version}:${Inner.tag}`; }\n",
        "}\n",
        "export const probe = [Outer.version, Outer.Inner.tag, Outer.Inner.twice(4), Outer.Inner.Deep.thrice(4), Outer.describe()].join('|');\n",
    ))?;
        assert_eq!(probe, "\"3|INNER|8|12|3:INNER\"");
        Ok(())
    }

    /// Declaration merging: the case that needed the owned pre-strip merge on
    /// swc. The second block's body must see the first block's members.
    #[test]
    fn merged_declaration_blocks_execute() -> Result<(), Box<dyn std::error::Error>> {
        let probe = run_emitted(
            "lowering",
            concat!(
                "export namespace Outer {\n",
                "  export const version = 3;\n",
                "  export namespace Inner {\n",
                "    export function twice(value: number): number { return value * 2; }\n",
                "  }\n",
                "}\n",
                "export namespace Outer {\n",
                "  export function versionTwice(): number { return Inner.twice(version); }\n",
                "}\n",
                "export const probe = [Outer.version, Outer.versionTwice()].join('|');\n",
            ),
        )?;
        assert_eq!(probe, "\"3|6\"");
        Ok(())
    }
}

#[cfg(test)]
mod namespace_merge_guards {
    //! The conservative gate, same as the swc pass: merging must not reorder
    //! observable work, and must not guess on a mixed group.
    use super::super::lower_with_oxc;
    use std::path::Path;

    #[test]
    fn a_statement_between_blocks_blocks_the_merge() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower_with_oxc(
        Path::new("m.ts"),
        "export namespace A { export const v = 1; }\nconsole.log('between');\nexport namespace A { export function r(): number { return 7; } }\n",
    )?;
        // Two IIFEs still, in source order: the console.log did not move.
        let between = code
            .find("between")
            .ok_or("intervening statement missing")?;
        let second = code
            .rfind("A ||")
            .or_else(|| code.rfind("A)"))
            .ok_or("second namespace block missing")?;
        assert!(between < second, "{code}");
        Ok(())
    }

    #[test]
    fn a_nested_split_merges_one_level_down() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower_with_oxc(
        Path::new("m.ts"),
        "export namespace O { export namespace I { export const a = 1; } }\nexport function between(): number { return 1; }\nexport namespace O { export namespace I { export const b = 2; } }\n",
    )?;
        // One IIFE per namespace, not two: the inner pair became siblings only
        // after the outer merge, which is why the pass recurses afterwards.
        assert_eq!(code.matches("(O ||").count(), 1, "{code}");
        Ok(())
    }
}
