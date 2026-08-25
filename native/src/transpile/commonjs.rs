use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};

use crate::commonjs::CommonJsAnalysis;

pub(crate) fn normalize_source(
    file_path: &Path,
    source: &str,
    analysis: &CommonJsAnalysis,
    quoted: bool,
) -> Result<String, String> {
    if let Some(reason) = analysis.unsupported.first() {
        return Err(format!("Unsupported CommonJS pattern: {reason}"));
    }
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path)
        .map_err(|error| error.to_string())?
        .with_module(true);
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", file_path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let require_bindings = analysis
        .dependencies
        .iter()
        .enumerate()
        .map(|(index, specifier)| (specifier.clone(), format!("__cjs_require_{index}")))
        .collect::<HashMap<_, _>>();
    let commonjs_bindings = collect_commonjs_bindings(&parsed.program, &require_bindings);
    let mut collector = SourceEditCollector {
        commonjs_bindings: &commonjs_bindings,
        edits: Vec::new(),
        quoted,
        require_bindings: &require_bindings,
    };
    collector.visit_program(&parsed.program);
    for directive in &parsed.program.directives {
        if directive.directive == "use strict" {
            collector.edits.push((
                directive.span.start as usize,
                directive.span.end as usize,
                String::new(),
            ));
        }
    }
    let mut body = source.to_string();
    collector.edits.sort_by_key(|(start, _, _)| *start);
    collector
        .edits
        .dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
    for (start, end, replacement) in collector.edits.into_iter().rev() {
        if start <= end && end <= body.len() {
            body.replace_range(start..end, &replacement);
        }
    }
    let imports = analysis
        .dependencies
        .iter()
        .enumerate()
        .map(|(index, specifier)| {
            let specifier = super::to_emitted_commonjs_specifier(specifier);
            format!(
                "import * as __cjs_import_{index} from {specifier:?};\nconst __cjs_require_{index} = \"__cjsExports\" in __cjs_import_{index} ? __cjs_import_{index}.__cjsExports : __cjs_import_{index};"
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let body = if uses_top_level_this(&parsed.program) {
        format!("(function () {{\n{body}\n}}).call(module.exports);")
    } else {
        body
    };
    Ok([
        imports,
        "var module = {}; module[\"exports\"] = {};".to_string(),
        body,
        "var __cjsExports = module.exports;".to_string(),
    ]
    .into_iter()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n"))
}

fn collect_commonjs_bindings(
    program: &Program<'_>,
    require_bindings: &HashMap<String, String>,
) -> HashSet<String> {
    let mut bindings = require_bindings.values().cloned().collect::<HashSet<_>>();
    loop {
        let mut changed = false;
        for statement in &program.body {
            let Statement::VariableDeclaration(declaration) = statement else {
                continue;
            };
            for declarator in &declaration.declarations {
                let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                    continue;
                };
                let Some(initializer) = &declarator.init else {
                    continue;
                };
                let carries_commonjs = match initializer.without_parentheses() {
                    Expression::Identifier(identifier) => {
                        bindings.contains(identifier.name.as_str())
                    }
                    Expression::CallExpression(call) => require_specifier(call)
                        .is_some_and(|specifier| require_bindings.contains_key(specifier)),
                    _ => false,
                };
                if carries_commonjs && bindings.insert(binding.name.to_string()) {
                    changed = true;
                }
            }
        }
        if !changed {
            return bindings;
        }
    }
}

type SourceEdit = (usize, usize, String);

struct SourceEditCollector<'a> {
    commonjs_bindings: &'a HashSet<String>,
    edits: Vec<SourceEdit>,
    quoted: bool,
    require_bindings: &'a HashMap<String, String>,
}

impl<'a> Visit<'a> for SourceEditCollector<'_> {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        if let Statement::ExpressionStatement(expression) = statement {
            if matches!(&expression.expression, Expression::StringLiteral(literal) if literal.value == "use strict")
                || matches!(&expression.expression, Expression::CallExpression(call) if object_define_property_es_module(call))
            {
                self.edits.push((
                    statement.span().start as usize,
                    statement.span().end as usize,
                    String::new(),
                ));
                return;
            }
        }
        walk::walk_statement(self, statement);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        self.visit_expression(&assignment.right);
        let Some(simple) = assignment.left.as_simple_assignment_target() else {
            walk::walk_assignment_target(self, &assignment.left);
            return;
        };
        let rendered = match simple {
            SimpleAssignmentTarget::StaticMemberExpression(member) => render_static_member(
                member,
                self.quoted,
                self.require_bindings,
                self.commonjs_bindings,
            ),
            SimpleAssignmentTarget::ComputedMemberExpression(member) => render_computed_member(
                member,
                self.quoted,
                self.require_bindings,
                self.commonjs_bindings,
            ),
            _ => None,
        };
        if let Some(rendered) = rendered {
            self.edits.push((
                simple.span().start as usize,
                simple.span().end as usize,
                rendered,
            ));
            if self.quoted && is_commonjs_export_target(simple) {
                if let Expression::ObjectExpression(object) = &assignment.right {
                    quote_object_literal(object, &mut self.edits);
                }
            }
        } else {
            walk::walk_simple_assignment_target(self, simple);
        }
    }

    fn visit_expression(&mut self, expression: &Expression<'a>) {
        let rendered = match expression {
            Expression::CallExpression(call) => require_specifier(call)
                .and_then(|specifier| self.require_bindings.get(specifier))
                .cloned(),
            Expression::StaticMemberExpression(member) => render_static_member(
                member,
                self.quoted,
                self.require_bindings,
                self.commonjs_bindings,
            ),
            Expression::ComputedMemberExpression(member) => render_computed_member(
                member,
                self.quoted,
                self.require_bindings,
                self.commonjs_bindings,
            ),
            Expression::Identifier(identifier) if identifier.name == "exports" => {
                Some("module[\"exports\"]".to_string())
            }
            _ => None,
        };
        if let Some(rendered) = rendered {
            self.edits.push((
                expression.span().start as usize,
                expression.span().end as usize,
                rendered,
            ));
            return;
        }
        walk::walk_expression(self, expression);
    }
}

fn render_static_member(
    member: &StaticMemberExpression<'_>,
    quoted: bool,
    require_bindings: &HashMap<String, String>,
    commonjs_bindings: &HashSet<String>,
) -> Option<String> {
    render_member(
        &member.object,
        member.property.name.as_str(),
        false,
        quoted,
        require_bindings,
        commonjs_bindings,
    )
}

fn render_computed_member(
    member: &ComputedMemberExpression<'_>,
    quoted: bool,
    require_bindings: &HashMap<String, String>,
    commonjs_bindings: &HashSet<String>,
) -> Option<String> {
    let Expression::StringLiteral(property) = &member.expression else {
        return None;
    };
    render_member(
        &member.object,
        property.value.as_str(),
        true,
        quoted,
        require_bindings,
        commonjs_bindings,
    )
}

fn render_member(
    object: &Expression<'_>,
    property: &str,
    computed: bool,
    quoted: bool,
    require_bindings: &HashMap<String, String>,
    commonjs_bindings: &HashSet<String>,
) -> Option<String> {
    if is_module_identifier(object) && property == "exports" {
        return Some("module[\"exports\"]".to_string());
    }
    if is_commonjs_export_object(object) {
        let property = if computed || quoted {
            format!("[{property:?}]")
        } else {
            format!(".{property}")
        };
        return Some(format!("module[\"exports\"]{property}"));
    }
    let binding = match object.without_parentheses() {
        Expression::Identifier(identifier)
            if commonjs_bindings.contains(identifier.name.as_str()) =>
        {
            Some(identifier.name.to_string())
        }
        Expression::CallExpression(call) => require_specifier(call)
            .and_then(|specifier| require_bindings.get(specifier))
            .cloned(),
        _ => None,
    }?;
    if !quoted || computed {
        return None;
    }
    Some(format!("{binding}[{property:?}]"))
}

fn is_commonjs_export_target(target: &SimpleAssignmentTarget<'_>) -> bool {
    match target {
        SimpleAssignmentTarget::StaticMemberExpression(member) => {
            is_commonjs_export_object(&member.object)
                || (is_module_identifier(&member.object) && member.property.name == "exports")
        }
        SimpleAssignmentTarget::ComputedMemberExpression(member) => {
            is_commonjs_export_object(&member.object)
                || (is_module_identifier(&member.object)
                    && matches!(&member.expression, Expression::StringLiteral(property) if property.value == "exports"))
        }
        _ => false,
    }
}

fn is_commonjs_export_object(expression: &Expression<'_>) -> bool {
    match expression.without_parentheses() {
        Expression::Identifier(identifier) => identifier.name == "exports",
        Expression::StaticMemberExpression(member) => {
            is_module_identifier(&member.object) && member.property.name == "exports"
        }
        Expression::ComputedMemberExpression(member) => {
            is_module_identifier(&member.object)
                && matches!(&member.expression, Expression::StringLiteral(property) if property.value == "exports")
        }
        _ => false,
    }
}

fn is_module_identifier(expression: &Expression<'_>) -> bool {
    matches!(expression.without_parentheses(), Expression::Identifier(identifier) if identifier.name == "module")
}

fn quote_object_literal(object: &ObjectExpression<'_>, edits: &mut Vec<SourceEdit>) {
    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            continue;
        };
        match &property.key {
            PropertyKey::StaticIdentifier(identifier) if property.shorthand => edits.push((
                property.span.start as usize,
                property.span.end as usize,
                format!(
                    "{:?}: {}",
                    identifier.name.as_str(),
                    identifier.name.as_str()
                ),
            )),
            PropertyKey::StaticIdentifier(identifier) => edits.push((
                identifier.span.start as usize,
                identifier.span.end as usize,
                format!("{:?}", identifier.name.as_str()),
            )),
            PropertyKey::NumericLiteral(number) => edits.push((
                number.span.start as usize,
                number.span.end as usize,
                format!("{:?}", number.value.to_string()),
            )),
            _ => {}
        }
    }
}

fn require_specifier<'a>(call: &'a CallExpression<'a>) -> Option<&'a str> {
    if call.arguments.len() != 1 {
        return None;
    }
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    if callee.name != "require" {
        return None;
    }
    match call.arguments[0].as_expression()? {
        Expression::StringLiteral(literal) => Some(literal.value.as_str()),
        Expression::TemplateLiteral(template)
            if template.expressions.is_empty() && template.quasis.len() == 1 =>
        {
            Some(
                template.quasis[0]
                    .value
                    .cooked
                    .as_ref()
                    .unwrap_or(&template.quasis[0].value.raw)
                    .as_str(),
            )
        }
        _ => None,
    }
}

fn object_define_property_es_module(call: &CallExpression<'_>) -> bool {
    if call.arguments.len() < 2 {
        return false;
    }
    let Expression::StaticMemberExpression(callee) = &call.callee else {
        return false;
    };
    if callee.property.name != "defineProperty"
        || !matches!(&callee.object, Expression::Identifier(object) if object.name == "Object")
    {
        return false;
    }
    matches!(call.arguments[0].as_expression(), Some(Expression::Identifier(exports)) if exports.name == "exports")
        && matches!(call.arguments[1].as_expression(), Some(Expression::StringLiteral(name)) if name.value == "__esModule")
}

fn uses_top_level_this(program: &Program<'_>) -> bool {
    struct Finder {
        found: bool,
    }
    impl<'a> Visit<'a> for Finder {
        fn visit_this_expression(&mut self, _: &ThisExpression) {
            self.found = true;
        }
        fn visit_function(&mut self, _: &Function<'a>, _: oxc_syntax::scope::ScopeFlags) {}
        fn visit_class(&mut self, _: &Class<'a>) {}
    }
    let mut finder = Finder { found: false };
    finder.visit_program(program);
    finder.found
}
