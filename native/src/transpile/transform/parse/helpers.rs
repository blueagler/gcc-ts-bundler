use std::collections::HashSet;

use oxc_ast::ast::{
    ArrowFunctionExpression, BindingPattern, Expression, Function, FunctionType, ModuleExportName,
    ObjectPattern, PropertyKey, Statement, VariableDeclarator,
};
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;

pub(crate) struct ThrowEditCollector<'a> {
    pub(crate) edits: Vec<(usize, usize, String)>,
    pub(crate) source: &'a str,
}

impl<'a> Visit<'a> for ThrowEditCollector<'_> {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        if let Statement::ThrowStatement(throw_statement) = statement {
            let argument = &self.source[throw_statement.argument.span().start as usize
                ..throw_statement.argument.span().end as usize];
            self.edits.push((
                throw_statement.span.start as usize,
                throw_statement.span.end as usize,
                format!("(() => {{ throw {argument}; }})();"),
            ));
        }
        walk::walk_statement(self, statement);
    }
}

pub(crate) struct ComponentParamEditCollector<'a, 'u> {
    pub(crate) edits: Vec<(usize, usize, String)>,
    pub(crate) source: &'a str,
    pub(crate) used: &'u mut HashSet<String>,
}

impl ComponentParamEditCollector<'_, '_> {
    fn rewrite_function(&mut self, function: &Function<'_>) {
        let Some(parameter) = function.params.items.first() else {
            return;
        };
        let BindingPattern::ObjectPattern(pattern) = &parameter.pattern else {
            return;
        };
        let Some(body) = &function.body else {
            return;
        };
        let props = fresh_name(self.used, "__props");
        let setup = component_setup(self.source, pattern, &props);
        self.edits.push((
            pattern.span.start as usize,
            pattern.span.end as usize,
            props.clone(),
        ));
        self.edits.push((
            body.span.start as usize + 1,
            body.span.start as usize + 1,
            format!("\n{setup}\n"),
        ));
    }

    fn rewrite_arrow(&mut self, arrow: &ArrowFunctionExpression<'_>) {
        let Some(parameter) = arrow.params.items.first() else {
            return;
        };
        let BindingPattern::ObjectPattern(pattern) = &parameter.pattern else {
            return;
        };
        let props = fresh_name(self.used, "__props");
        let setup = component_setup(self.source, pattern, &props);
        self.edits.push((
            pattern.span.start as usize,
            pattern.span.end as usize,
            props,
        ));
        if let Some(expression) = arrow.get_expression() {
            let expression_text =
                &self.source[expression.span().start as usize..expression.span().end as usize];
            self.edits.push((
                arrow.body.span.start as usize,
                arrow.body.span.end as usize,
                format!("{{\n{setup}\nreturn {expression_text};\n}}"),
            ));
        } else {
            self.edits.push((
                arrow.body.span.start as usize + 1,
                arrow.body.span.start as usize + 1,
                format!("\n{setup}\n"),
            ));
        }
    }
}

impl<'a> Visit<'a> for ComponentParamEditCollector<'_, '_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        if function.r#type == FunctionType::FunctionDeclaration
            && function
                .id
                .as_ref()
                .is_some_and(|identifier| is_component_name(identifier.name.as_str()))
        {
            self.rewrite_function(function);
        }
        walk::walk_function(self, function, flags);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(binding) = &declarator.id {
            if is_component_name(binding.name.as_str()) {
                if let Some(initializer) = &declarator.init {
                    match initializer.without_parentheses() {
                        Expression::FunctionExpression(function) => self.rewrite_function(function),
                        Expression::ArrowFunctionExpression(arrow) => self.rewrite_arrow(arrow),
                        _ => {}
                    }
                }
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

fn is_component_name(name: &str) -> bool {
    name.chars()
        .next()
        .is_some_and(|character| character.is_ascii_uppercase())
}

fn component_setup(source: &str, pattern: &ObjectPattern<'_>, props: &str) -> String {
    let mut lines = Vec::new();
    let mut omitted = Vec::new();
    for property in &pattern.properties {
        let key = match &property.key {
            PropertyKey::StaticIdentifier(identifier) => identifier.name.as_str(),
            PropertyKey::StringLiteral(literal) => literal.value.as_str(),
            _ => {
                return format!(
                    "const {} = {props};",
                    quoted_object_pattern(source, pattern)
                );
            }
        };
        let BindingPattern::BindingIdentifier(binding) = &property.value else {
            return format!(
                "const {} = {props};",
                quoted_object_pattern(source, pattern)
            );
        };
        omitted.push(key.to_string());
        lines.push(format!(
            "const {} = {props}[goog.reflect.objectProperty({key:?}, {props})];",
            binding.name
        ));
    }
    if let Some(rest) = &pattern.rest {
        let BindingPattern::BindingIdentifier(binding) = &rest.argument else {
            return format!(
                "const {} = {props};",
                quoted_object_pattern(source, pattern)
            );
        };
        let guard = omitted
            .iter()
            .map(|key| format!("key !== goog.reflect.objectProperty({key:?}, {props})"))
            .collect::<Vec<_>>()
            .join(" && ");
        lines.push(format!("const {} = {{}};", binding.name));
        lines.push(format!(
            "for (const key in {props}) {{ if ({}) {}[key] = {props}[key]; }}",
            if guard.is_empty() { "true" } else { &guard },
            binding.name
        ));
    }
    lines.join("\n")
}

fn quoted_object_pattern(source: &str, pattern: &ObjectPattern<'_>) -> String {
    let start = pattern.span.start as usize;
    let end = pattern.span.end as usize;
    let mut output = source[start..end].to_string();
    let mut edits = Vec::new();
    collect_pattern_key_edits(source, pattern, start, &mut edits);
    edits.sort_by_key(|(start, _, _)| *start);
    for (edit_start, edit_end, replacement) in edits.into_iter().rev() {
        output.replace_range(edit_start..edit_end, &replacement);
    }
    output
}

fn collect_pattern_key_edits(
    source: &str,
    pattern: &ObjectPattern<'_>,
    base: usize,
    edits: &mut Vec<(usize, usize, String)>,
) {
    for property in &pattern.properties {
        if let PropertyKey::StaticIdentifier(identifier) = &property.key {
            let replacement = if property.shorthand {
                let value = &source
                    [property.value.span().start as usize..property.value.span().end as usize];
                format!("{:?}: {value}", identifier.name.as_str())
            } else {
                format!("{:?}", identifier.name.as_str())
            };
            let span = if property.shorthand {
                property.span
            } else {
                identifier.span
            };
            edits.push((
                span.start as usize - base,
                span.end as usize - base,
                replacement,
            ));
        }
        if let BindingPattern::ObjectPattern(nested) = &property.value {
            collect_pattern_key_edits(source, nested, base, edits);
        }
    }
}

pub(crate) fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

pub(crate) fn fresh_name(used: &mut HashSet<String>, preferred: &str) -> String {
    if used.insert(preferred.to_string()) {
        return preferred.to_string();
    }
    for suffix in 1usize.. {
        let candidate = format!("{preferred}_{suffix}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}
