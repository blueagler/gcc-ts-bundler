use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use crate::closure_metadata::{closure_metadata_key, ClosureAnnotationTarget, ClosureFileMetadata};
use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;
use oxc_syntax::scope::ScopeFlags;

const HARD_PLATFORM_CALLBACK_PROPERTY_NAMES: &[&str] = &[
    "adoptedCallback",
    "attributeChangedCallback",
    "connectedCallback",
    "disconnectedCallback",
    "formAssociatedCallback",
    "formDisabledCallback",
    "formResetCallback",
    "formStateRestoreCallback",
];
const HARD_STATIC_INTEROP_PROPERTY_NAMES: &[&str] = &["formAssociated", "observedAttributes"];

fn is_hard_platform_callback_name(name: &str) -> bool {
    HARD_PLATFORM_CALLBACK_PROPERTY_NAMES.contains(&name)
}

fn is_hard_static_interop_name(name: &str) -> bool {
    HARD_STATIC_INTEROP_PROPERTY_NAMES.contains(&name)
}

#[derive(Default)]
pub(crate) struct ExternPropertyAnalysis {
    pub(crate) program_declared_names: HashSet<String>,
    pub(crate) explicit_extern_property_names: HashSet<String>,
    pub(crate) preserved_property_names: HashSet<String>,
    pub(crate) static_property_names: HashSet<String>,
}

#[derive(Default)]
struct ParsedExternFileAnalysis {
    accessed_hazard_names: HashSet<String>,
    callback_record_names: HashSet<String>,
    constructor_read_names: HashSet<String>,
    defined_hazard_names: HashSet<String>,
    platform_callback_names: HashSet<String>,
    proven_definition_names: HashSet<String>,
    proven_monomorphic_access_names: HashSet<String>,
    reflective_property_names: HashSet<String>,
    static_assigned_names: HashSet<String>,
    static_property_names: HashSet<String>,
    unproven_definition_names: HashSet<String>,
    unproven_monomorphic_access_names: HashSet<String>,
}

pub(crate) fn collect_extern_property_names_with_externs(
    file_names: &[String],
    extern_file_names: &[String],
    file_metadata: &HashMap<String, ClosureFileMetadata>,
) -> Result<ExternPropertyAnalysis, String> {
    let retained_sources = file_names
        .iter()
        .filter(|file_name| !file_name.ends_with(".d.ts"))
        .map(|file_name| {
            fs::read_to_string(file_name)
                .map(|source| (PathBuf::from(file_name), source))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let allocator = Allocator::default();
    let mut programs = Vec::new();
    let mut preserved_property_names = HashSet::new();
    let mut static_property_names = HashSet::new();

    for (path, source) in &retained_sources {
        match parse_program(&allocator, path, source) {
            Ok(program) => {
                let metadata = file_metadata.get(&closure_metadata_key(path));
                let mut collector = ExternPropertyCollector::new(metadata);
                collector.visit_program(&program);
                let analysis = collector.finish();
                static_property_names.extend(analysis.static_property_names.iter().cloned());
                preserved_property_names.extend(analysis.platform_callback_names);
                preserved_property_names.extend(analysis.reflective_property_names);
                let is_proven_monomorphic = |name: &String| {
                    analysis.proven_definition_names.contains(name)
                        && analysis.proven_monomorphic_access_names.contains(name)
                        && !analysis.unproven_definition_names.contains(name)
                        && !analysis.unproven_monomorphic_access_names.contains(name)
                };
                preserved_property_names.extend(
                    analysis
                        .defined_hazard_names
                        .intersection(&analysis.accessed_hazard_names)
                        .filter(|name| !is_proven_monomorphic(name))
                        .cloned(),
                );
                preserved_property_names.extend(
                    analysis
                        .callback_record_names
                        .iter()
                        .filter(|name| !is_proven_monomorphic(name))
                        .cloned(),
                );
                preserved_property_names.extend(
                    analysis
                        .constructor_read_names
                        .intersection(&analysis.static_assigned_names)
                        .cloned(),
                );
                programs.push(program);
            }
            Err(_) => {
                static_property_names.extend(collect_static_property_names_from_text(source));
            }
        }
    }

    preserved_property_names.extend(collect_custom_element_surface_names(&programs));
    let explicit_extern_property_names = collect_explicit_extern_property_names(extern_file_names)?;
    preserved_property_names.extend(explicit_extern_property_names.iter().cloned());
    preserved_property_names.extend(static_property_names.iter().cloned());
    let program_declared_names = collect_program_declared_names(&programs);

    Ok(ExternPropertyAnalysis {
        program_declared_names,
        explicit_extern_property_names,
        preserved_property_names,
        static_property_names,
    })
}

fn parse_program<'a>(
    allocator: &'a Allocator,
    path: &Path,
    source: &'a str,
) -> Result<Program<'a>, String> {
    let source_type = SourceType::from_path(path).map_err(|error| error.to_string())?;
    let parsed = Parser::new(allocator, source, source_type).parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(format!("{}: {}", path.display(), error.message));
    }
    Ok(parsed.program)
}

fn collect_explicit_extern_property_names(
    extern_file_names: &[String],
) -> Result<HashSet<String>, String> {
    let retained_sources = extern_file_names
        .iter()
        .map(|file_name| {
            fs::read_to_string(file_name)
                .map(|source| (PathBuf::from(file_name), source))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let allocator = Allocator::default();
    let mut property_names = HashSet::new();
    for (path, source) in &retained_sources {
        let program = parse_program(&allocator, path, source)?;
        let mut collector = ExplicitExternPropertyCollector::default();
        collector.visit_program(&program);
        property_names.extend(collector.property_names);
    }
    Ok(property_names)
}

pub(crate) fn collect_static_property_names_from_text(source_text: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    for (_, property_name) in super::super::collect_class_static_assignments(source_text) {
        if is_hard_static_interop_name(&property_name) {
            names.insert(property_name);
        }
    }
    if let Ok(regex) =
        regex::Regex::new(r"\bstatic\s+(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|\()")
    {
        for captures in regex.captures_iter(source_text) {
            if let Some(capture) = captures.get(1) {
                let property_name = capture.as_str();
                if is_hard_static_interop_name(property_name) {
                    names.insert(property_name.to_string());
                }
            }
        }
    }
    names
}

pub(crate) fn is_valid_js_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

fn property_key_to_string(key: &PropertyKey<'_>, computed: bool) -> Option<String> {
    if computed {
        return None;
    }
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
        PropertyKey::StringLiteral(value) => Some(value.value.to_string()),
        PropertyKey::NumericLiteral(value) => Some(value.value.to_string()),
        _ => None,
    }
}

#[derive(Default)]
struct ExternPropertyCollector {
    accessed_hazard_names: HashSet<String>,
    callback_record_names: HashSet<String>,
    class_name_stack: Vec<Option<String>>,
    constructor_read_names: HashSet<String>,
    defined_hazard_names: HashSet<String>,
    function_depth: usize,
    instance_this_depth: Option<usize>,
    nominal_member_names: HashMap<String, HashSet<String>>,
    platform_callback_names: HashSet<String>,
    proven_definition_names: HashSet<String>,
    proven_monomorphic_access_names: HashSet<String>,
    reflective_property_names: HashSet<String>,
    static_assigned_names: HashSet<String>,
    static_context_depth: usize,
    static_property_names: HashSet<String>,
    unproven_definition_names: HashSet<String>,
    unproven_monomorphic_access_names: HashSet<String>,
}

impl ExternPropertyCollector {
    fn new(metadata: Option<&ClosureFileMetadata>) -> Self {
        let mut nominal_member_names = HashMap::<String, HashSet<String>>::new();
        if let Some(metadata) = metadata {
            for annotation in &metadata.annotations {
                let ClosureAnnotationTarget::Member {
                    member_name,
                    owner_binding_name,
                    is_static: false,
                    ..
                } = &annotation.target
                else {
                    continue;
                };
                nominal_member_names
                    .entry(owner_binding_name.clone())
                    .or_default()
                    .insert(member_name.clone());
            }
        }
        Self {
            nominal_member_names,
            ..Self::default()
        }
    }

    fn finish(self) -> ParsedExternFileAnalysis {
        ParsedExternFileAnalysis {
            accessed_hazard_names: self.accessed_hazard_names,
            callback_record_names: self.callback_record_names,
            constructor_read_names: self.constructor_read_names,
            defined_hazard_names: self.defined_hazard_names,
            platform_callback_names: self.platform_callback_names,
            proven_definition_names: self.proven_definition_names,
            proven_monomorphic_access_names: self.proven_monomorphic_access_names,
            reflective_property_names: self.reflective_property_names,
            static_assigned_names: self.static_assigned_names,
            static_property_names: self.static_property_names,
            unproven_definition_names: self.unproven_definition_names,
            unproven_monomorphic_access_names: self.unproven_monomorphic_access_names,
        }
    }

    fn current_class_name(&self) -> Option<&str> {
        self.class_name_stack
            .last()
            .and_then(|name| name.as_deref())
    }

    fn is_proven_monomorphic_receiver(
        &self,
        receiver: &Expression<'_>,
        property_name: &str,
    ) -> bool {
        matches!(
            receiver.without_parentheses(),
            Expression::ThisExpression(_)
        ) && self.instance_this_depth == Some(self.function_depth)
            && self
                .current_class_name()
                .and_then(|class_name| self.nominal_member_names.get(class_name))
                .is_some_and(|names| names.contains(property_name))
    }

    fn insert_accessed_hazard_name(&mut self, property_name: &str, proven: bool) {
        if !is_valid_js_identifier(property_name) {
            return;
        }
        self.accessed_hazard_names.insert(property_name.to_string());
        if proven {
            self.proven_monomorphic_access_names
                .insert(property_name.to_string());
        } else {
            self.unproven_monomorphic_access_names
                .insert(property_name.to_string());
        }
    }

    fn insert_defined_hazard_name(&mut self, property_name: Option<String>, proven: bool) {
        let Some(property_name) = property_name.filter(|name| is_valid_js_identifier(name)) else {
            return;
        };
        self.defined_hazard_names.insert(property_name.clone());
        if proven {
            self.proven_definition_names.insert(property_name);
        } else {
            self.unproven_definition_names.insert(property_name);
        }
    }

    fn insert_platform_callback_name(&mut self, property_name: Option<String>) {
        if let Some(property_name) =
            property_name.filter(|name| is_hard_platform_callback_name(name))
        {
            self.platform_callback_names.insert(property_name);
        }
    }

    fn insert_reflective_name(&mut self, property_name: &str) {
        if is_valid_js_identifier(property_name) {
            self.reflective_property_names
                .insert(property_name.to_string());
        }
    }

    fn insert_static_name(&mut self, property_name: Option<String>) {
        if let Some(property_name) = property_name.filter(|name| is_hard_static_interop_name(name))
        {
            self.static_property_names.insert(property_name);
        }
    }
}

impl<'a> Visit<'a> for ExternPropertyCollector {
    fn visit_class(&mut self, class: &Class<'a>) {
        self.class_name_stack.push(
            class
                .id
                .as_ref()
                .map(|identifier| identifier.name.to_string()),
        );
        walk::walk_class(self, class);
        self.class_name_stack.pop();
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        self.function_depth += 1;
        walk::walk_function(self, function, flags);
        self.function_depth -= 1;
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if let Some(member) = assignment.left.as_member_expression() {
            if matches!(
                member.object().without_parentheses(),
                Expression::Identifier(_)
            ) {
                if let MemberExpression::StaticMemberExpression(member) = member {
                    let property_name = member.property.name.as_str();
                    if is_valid_js_identifier(property_name) {
                        self.static_assigned_names.insert(property_name.to_string());
                    }
                }
            }
        }
        walk::walk_assignment_expression(self, assignment);
    }

    fn visit_property_definition(&mut self, property: &PropertyDefinition<'a>) {
        let property_name = property_key_to_string(&property.key, property.computed);
        self.insert_platform_callback_name(property_name.clone());
        if !property.decorators.is_empty() && is_public_accessibility(property.accessibility) {
            if let Some(property_name) = &property_name {
                self.insert_reflective_name(property_name);
            }
        }
        if property.r#static {
            self.insert_static_name(property_name.clone());
            if let Some(property_name) = property_name.filter(|name| is_valid_js_identifier(name)) {
                self.static_assigned_names.insert(property_name);
            }
        }
        walk::walk_property_definition(self, property);
    }

    fn visit_method_definition(&mut self, method: &MethodDefinition<'a>) {
        let property_name = property_key_to_string(&method.key, method.computed);
        self.insert_platform_callback_name(property_name.clone());
        if !method.decorators.is_empty() && is_public_accessibility(method.accessibility) {
            if let Some(property_name) = &property_name {
                self.insert_reflective_name(property_name);
            }
        }
        if method.r#static {
            self.insert_static_name(property_name);
            self.static_context_depth += 1;
            self.visit_function(&method.value, ScopeFlags::Function);
            self.static_context_depth -= 1;
        } else {
            let previous_instance_this_depth = self.instance_this_depth;
            self.instance_this_depth = Some(self.function_depth + 1);
            walk::walk_method_definition(self, method);
            self.instance_this_depth = previous_instance_this_depth;
        }
    }

    fn visit_accessor_property(&mut self, accessor: &AccessorProperty<'a>) {
        let property_name = property_key_to_string(&accessor.key, accessor.computed);
        self.insert_platform_callback_name(property_name.clone());
        if !accessor.decorators.is_empty() && is_public_accessibility(accessor.accessibility) {
            if let Some(property_name) = &property_name {
                self.insert_reflective_name(property_name);
            }
        }
        if accessor.r#static {
            self.insert_static_name(property_name.clone());
            if let Some(property_name) = property_name.filter(|name| is_valid_js_identifier(name)) {
                self.static_assigned_names.insert(property_name);
            }
        }
        walk::walk_accessor_property(self, accessor);
    }

    fn visit_member_expression(&mut self, member: &MemberExpression<'a>) {
        let object = member.object().without_parentheses();
        let is_super = matches!(object, Expression::Super(_));
        match member {
            MemberExpression::StaticMemberExpression(member) => {
                let property_name = member.property.name.as_str();
                self.insert_platform_callback_name(Some(property_name.to_string()));
                let proven = self.is_proven_monomorphic_receiver(&member.object, property_name);
                self.insert_accessed_hazard_name(property_name, proven);
                if let Some(object_member) = member.object.as_member_expression() {
                    if object_member.static_property_name() == Some("constructor")
                        && is_valid_js_identifier(property_name)
                    {
                        self.constructor_read_names
                            .insert(property_name.to_string());
                    }
                }
            }
            MemberExpression::ComputedMemberExpression(member) => {
                if let Some(property_name) = string_literal_expr_name(&member.expression) {
                    if is_super {
                        self.insert_platform_callback_name(Some(property_name.clone()));
                    }
                    self.insert_reflective_name(&property_name);
                }
            }
            MemberExpression::PrivateFieldExpression(_) => {}
        }

        if self.static_context_depth > 0 {
            let is_static_target = match object {
                Expression::ThisExpression(_) => true,
                Expression::Identifier(identifier) => self
                    .current_class_name()
                    .is_some_and(|class_name| identifier.name == class_name),
                _ => false,
            };
            if is_static_target {
                self.insert_static_name(member.static_property_name().map(str::to_string));
            }
        }
        walk::walk_member_expression(self, member);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if declarator.init.is_some() {
            let mut property_names = HashSet::new();
            collect_pattern_property_reads(&declarator.id, &mut property_names);
            for property_name in property_names {
                self.insert_accessed_hazard_name(&property_name, false);
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }

    fn visit_object_expression(&mut self, object: &ObjectExpression<'a>) {
        for property in &object.properties {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                continue;
            };
            let property_name = string_defined_prop_name(&property.key);
            self.insert_defined_hazard_name(property_name.clone(), false);
            if let Some(property_name) = property_name {
                self.insert_reflective_name(&property_name);
            }
        }
        walk::walk_object_expression(self, object);
    }

    fn visit_property_key(&mut self, property_key: &PropertyKey<'a>) {
        if let PropertyKey::StringLiteral(value) = property_key {
            self.insert_reflective_name(value.value.as_str());
        }
        walk::walk_property_key(self, property_key);
    }

    fn visit_binary_expression(&mut self, binary: &BinaryExpression<'a>) {
        if binary.operator == BinaryOperator::In {
            if let Expression::StringLiteral(value) = binary.left.without_parentheses() {
                self.insert_reflective_name(value.value.as_str());
            }
        }
        walk::walk_binary_expression(self, binary);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        collect_call_record_contract_names(call, &mut self.callback_record_names);
        match call.callee.without_parentheses() {
            Expression::Identifier(identifier)
                if identifier.name == "JSCompiler_renameProperty" =>
            {
                if let Some(expression) = call.arguments.first().and_then(Argument::as_expression) {
                    if let Some(property_name) = string_literal_expr_name(expression) {
                        self.insert_reflective_name(&property_name);
                    }
                }
            }
            Expression::Identifier(identifier)
                if identifier.name == "__publicField" && call.arguments.len() >= 2 =>
            {
                if let Some(expression) = call.arguments.get(1).and_then(Argument::as_expression) {
                    let property_name = string_literal_expr_name(expression);
                    let proven = property_name.as_deref().is_some_and(|property_name| {
                        call.arguments
                            .first()
                            .and_then(Argument::as_expression)
                            .is_some_and(|receiver| {
                                self.is_proven_monomorphic_receiver(receiver, property_name)
                            })
                    });
                    self.insert_defined_hazard_name(property_name, proven);
                }
            }
            expression if expression.is_member_expression() => {
                let member = expression.to_member_expression();
                let object_name = match member.object().without_parentheses() {
                    Expression::Identifier(identifier) => Some(identifier.name.as_str()),
                    _ => None,
                };
                let method_name = member.static_property_name();
                let string_arg_index = match (object_name, method_name) {
                    (Some("Object"), Some("defineProperty" | "hasOwn")) => Some(1),
                    (
                        Some("Reflect"),
                        Some("defineProperty" | "deleteProperty" | "get" | "has" | "set"),
                    ) => Some(1),
                    _ => None,
                };
                if let Some(index) = string_arg_index {
                    if let Some(expression) =
                        call.arguments.get(index).and_then(Argument::as_expression)
                    {
                        let string_name = string_literal_expr_name(expression);
                        if let Some(property_name) = &string_name {
                            self.insert_reflective_name(property_name);
                        }
                        if matches!(
                            (object_name, method_name),
                            (Some("Object"), Some("defineProperty"))
                                | (Some("Reflect"), Some("defineProperty"))
                        ) {
                            self.insert_defined_hazard_name(string_name, false);
                        }
                    }
                }
            }
            _ => {}
        }
        walk::walk_call_expression(self, call);
    }
}

fn string_defined_prop_name(property_key: &PropertyKey<'_>) -> Option<String> {
    match property_key {
        PropertyKey::StringLiteral(value) => Some(value.value.to_string()),
        PropertyKey::TemplateLiteral(template) => string_literal_template_name(template),
        _ => None,
    }
}

fn string_literal_expr_name(expression: &Expression<'_>) -> Option<String> {
    match expression.without_parentheses() {
        Expression::StringLiteral(value) => Some(value.value.to_string()),
        Expression::TemplateLiteral(template) => string_literal_template_name(template),
        _ => None,
    }
}

fn string_literal_template_name(template: &TemplateLiteral<'_>) -> Option<String> {
    if !template.expressions.is_empty() || template.quasis.len() != 1 {
        return None;
    }
    template
        .quasis
        .first()
        .map(|quasi| quasi.value.cooked.unwrap_or(quasi.value.raw).to_string())
}

fn is_public_accessibility(accessibility: Option<TSAccessibility>) -> bool {
    !matches!(
        accessibility,
        Some(TSAccessibility::Private | TSAccessibility::Protected)
    )
}

fn collect_call_record_contract_names(call: &CallExpression<'_>, names: &mut HashSet<String>) {
    for argument in &call.arguments {
        let Some(Expression::ObjectExpression(object)) = argument
            .as_expression()
            .map(Expression::without_parentheses)
        else {
            continue;
        };
        let declared = collect_nested_record_names(object);
        if declared.is_empty() {
            continue;
        }
        let accessed = collect_object_callback_parameter_accesses(object);
        names.extend(declared.intersection(&accessed).cloned());
    }
}

fn collect_nested_record_names(object: &ObjectExpression<'_>) -> HashSet<String> {
    let mut names = HashSet::new();
    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            continue;
        };
        if property.method || property.kind != PropertyKind::Init {
            continue;
        }
        match property.value.without_parentheses() {
            Expression::ObjectExpression(record) => {
                names.extend(object_literal_direct_keys(record))
            }
            Expression::ArrayExpression(record) => {
                for element in &record.elements {
                    let Some(expression) = element.as_expression() else {
                        continue;
                    };
                    if let Some(name) = string_literal_expr_name(expression) {
                        if is_valid_js_identifier(&name) {
                            names.insert(name);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    names
}

fn object_literal_direct_keys(object: &ObjectExpression<'_>) -> HashSet<String> {
    object
        .properties
        .iter()
        .filter_map(|property| match property {
            ObjectPropertyKind::ObjectProperty(property) => property.key.static_name(),
            ObjectPropertyKind::SpreadProperty(_) => None,
        })
        .map(|name| name.into_owned())
        .filter(|name| is_valid_js_identifier(name))
        .collect()
}

fn collect_object_callback_parameter_accesses(object: &ObjectExpression<'_>) -> HashSet<String> {
    let mut names = HashSet::new();
    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            continue;
        };
        match property.value.without_parentheses() {
            Expression::FunctionExpression(function) => {
                let mut collector = CallbackParameterMemberCollector {
                    names: HashSet::new(),
                    parameters: formal_parameter_binding_names(&function.params),
                };
                collector.visit_function(function, ScopeFlags::Function);
                names.extend(collector.names);
            }
            Expression::ArrowFunctionExpression(function) => {
                let mut collector = CallbackParameterMemberCollector {
                    names: HashSet::new(),
                    parameters: formal_parameter_binding_names(&function.params),
                };
                collector.visit_arrow_function_expression(function);
                names.extend(collector.names);
            }
            _ => {}
        }
    }
    names
}

fn formal_parameter_binding_names(parameters: &FormalParameters<'_>) -> HashSet<String> {
    let mut names = parameters
        .items
        .iter()
        .flat_map(|parameter| pattern_binding_names(&parameter.pattern))
        .collect::<HashSet<_>>();
    if let Some(rest) = &parameters.rest {
        names.extend(pattern_binding_names(&rest.rest.argument));
    }
    names
}

fn pattern_binding_names(pattern: &BindingPattern<'_>) -> Vec<String> {
    match pattern {
        BindingPattern::BindingIdentifier(binding) => vec![binding.name.to_string()],
        BindingPattern::ArrayPattern(array) => {
            let mut names = array
                .elements
                .iter()
                .flatten()
                .flat_map(pattern_binding_names)
                .collect::<Vec<_>>();
            if let Some(rest) = &array.rest {
                names.extend(pattern_binding_names(&rest.argument));
            }
            names
        }
        BindingPattern::ObjectPattern(object) => {
            let mut names = object
                .properties
                .iter()
                .flat_map(|property| pattern_binding_names(&property.value))
                .collect::<Vec<_>>();
            if let Some(rest) = &object.rest {
                names.extend(pattern_binding_names(&rest.argument));
            }
            names
        }
        BindingPattern::AssignmentPattern(assignment) => pattern_binding_names(&assignment.left),
    }
}

struct CallbackParameterMemberCollector {
    names: HashSet<String>,
    parameters: HashSet<String>,
}

impl<'a> Visit<'a> for CallbackParameterMemberCollector {
    fn visit_member_expression(&mut self, member: &MemberExpression<'a>) {
        let object_matches = match member.object().without_parentheses() {
            Expression::Identifier(identifier) => {
                self.parameters.contains(identifier.name.as_str())
            }
            Expression::ThisExpression(_) => true,
            _ => false,
        };
        if object_matches {
            if let Some(name) = member
                .static_property_name()
                .filter(|name| is_valid_js_identifier(name))
            {
                self.names.insert(name.to_string());
            }
        }
        walk::walk_member_expression(self, member);
    }
}

#[derive(Default)]
struct ClassSurfaceFact {
    names: HashSet<String>,
    properties: HashSet<String>,
    registered: bool,
    super_name: Option<String>,
}

fn collect_custom_element_surface_names(programs: &[Program<'_>]) -> HashSet<String> {
    let mut facts = Vec::new();
    for program in programs {
        collect_program_class_surface_facts(program, &mut facts);
    }

    let mut facts_by_name: HashMap<String, Vec<usize>> = HashMap::new();
    let mut pending = VecDeque::new();
    for (index, fact) in facts.iter().enumerate() {
        if fact.registered {
            pending.push_back(index);
        }
        for name in &fact.names {
            if name != "default" {
                facts_by_name.entry(name.clone()).or_default().push(index);
            }
        }
    }

    let mut visited = HashSet::new();
    let mut properties = HashSet::new();
    while let Some(index) = pending.pop_front() {
        if !visited.insert(index) {
            continue;
        }
        let fact = &facts[index];
        properties.extend(fact.properties.iter().cloned());
        if let Some(super_name) = &fact.super_name {
            if let Some(super_facts) = facts_by_name.get(super_name) {
                pending.extend(super_facts.iter().copied());
            }
        }
    }
    properties
}

fn collect_program_class_surface_facts(program: &Program<'_>, facts: &mut Vec<ClassSurfaceFact>) {
    let import_aliases = collect_program_import_aliases(program);
    let export_aliases = collect_program_export_aliases(program);
    let mut registrations = CustomElementRegistrationCollector::default();
    registrations.visit_program(program);

    for statement in &program.body {
        match statement {
            Statement::ClassDeclaration(class) => push_class_surface_fact(
                class
                    .id
                    .as_ref()
                    .map(|id| id.name.to_string())
                    .unwrap_or_default(),
                class,
                &import_aliases,
                &export_aliases,
                &registrations.class_names,
                None,
                facts,
            ),
            Statement::VariableDeclaration(declaration) => collect_variable_class_surface_facts(
                declaration,
                &import_aliases,
                &export_aliases,
                &registrations.class_names,
                facts,
            ),
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    collect_decl_class_surface_facts(
                        declaration,
                        &import_aliases,
                        &export_aliases,
                        &registrations.class_names,
                        facts,
                    );
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                if let ExportDefaultDeclarationKind::ClassDeclaration(class) = &export.declaration {
                    let local_name = class
                        .id
                        .as_ref()
                        .map(|identifier| identifier.name.to_string())
                        .unwrap_or_else(|| "default".to_string());
                    push_class_surface_fact(
                        local_name,
                        class,
                        &import_aliases,
                        &export_aliases,
                        &registrations.class_names,
                        Some("default"),
                        facts,
                    );
                }
            }
            _ => {}
        }
    }
}

fn collect_decl_class_surface_facts(
    declaration: &Declaration<'_>,
    import_aliases: &HashMap<String, String>,
    export_aliases: &HashMap<String, HashSet<String>>,
    registrations: &HashSet<String>,
    facts: &mut Vec<ClassSurfaceFact>,
) {
    match declaration {
        Declaration::ClassDeclaration(class) => push_class_surface_fact(
            class
                .id
                .as_ref()
                .map(|id| id.name.to_string())
                .unwrap_or_default(),
            class,
            import_aliases,
            export_aliases,
            registrations,
            None,
            facts,
        ),
        Declaration::VariableDeclaration(declaration) => collect_variable_class_surface_facts(
            declaration,
            import_aliases,
            export_aliases,
            registrations,
            facts,
        ),
        _ => {}
    }
}

fn collect_variable_class_surface_facts(
    declaration: &VariableDeclaration<'_>,
    import_aliases: &HashMap<String, String>,
    export_aliases: &HashMap<String, HashSet<String>>,
    registrations: &HashSet<String>,
    facts: &mut Vec<ClassSurfaceFact>,
) {
    for declarator in &declaration.declarations {
        let (BindingPattern::BindingIdentifier(binding), Some(initializer)) =
            (&declarator.id, &declarator.init)
        else {
            continue;
        };
        let Expression::ClassExpression(class) = initializer.without_parentheses() else {
            continue;
        };
        push_class_surface_fact(
            binding.name.to_string(),
            class,
            import_aliases,
            export_aliases,
            registrations,
            None,
            facts,
        );
    }
}

fn push_class_surface_fact(
    local_name: String,
    class: &Class<'_>,
    import_aliases: &HashMap<String, String>,
    export_aliases: &HashMap<String, HashSet<String>>,
    registrations: &HashSet<String>,
    extra_export: Option<&str>,
    facts: &mut Vec<ClassSurfaceFact>,
) {
    let mut names = HashSet::from([local_name.clone()]);
    if let Some(aliases) = export_aliases.get(&local_name) {
        names.extend(aliases.iter().cloned());
    }
    if let Some(extra_export) = extra_export {
        names.insert(extra_export.to_string());
    }
    let super_name = class
        .super_class
        .as_ref()
        .and_then(class_reference_name)
        .map(|name| import_aliases.get(&name).cloned().unwrap_or(name));
    facts.push(ClassSurfaceFact {
        names,
        properties: collect_class_surface_properties(class),
        registered: registrations.contains(&local_name)
            || class.decorators.iter().any(is_custom_element_decorator),
        super_name,
    });
}

fn collect_program_import_aliases(program: &Program<'_>) -> HashMap<String, String> {
    let mut aliases = HashMap::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        for specifier in import.specifiers.iter().flatten() {
            match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    aliases.insert(
                        named.local.name.to_string(),
                        module_export_name(&named.imported),
                    );
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    aliases.insert(default.local.name.to_string(), "default".to_string());
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    aliases.insert(
                        namespace.local.name.to_string(),
                        namespace.local.name.to_string(),
                    );
                }
            }
        }
    }
    aliases
}

fn collect_program_export_aliases(program: &Program<'_>) -> HashMap<String, HashSet<String>> {
    let mut aliases: HashMap<String, HashSet<String>> = HashMap::new();
    for statement in &program.body {
        let Statement::ExportNamedDeclaration(export) = statement else {
            continue;
        };
        if export.source.is_some() {
            continue;
        }
        for specifier in &export.specifiers {
            aliases
                .entry(module_export_name(&specifier.local))
                .or_default()
                .insert(module_export_name(&specifier.exported));
        }
    }
    aliases
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(value) => value.value.to_string(),
    }
}

fn class_reference_name(expression: &Expression<'_>) -> Option<String> {
    match expression.without_parentheses() {
        Expression::Identifier(identifier) => Some(identifier.name.to_string()),
        expression if expression.is_member_expression() => expression
            .to_member_expression()
            .static_property_name()
            .map(str::to_string),
        _ => None,
    }
}

fn collect_class_surface_properties(class: &Class<'_>) -> HashSet<String> {
    let mut properties = HashSet::new();
    let mut non_public = HashSet::new();
    for member in &class.body.body {
        match member {
            ClassElement::PropertyDefinition(property) => {
                if let Some(name) = public_property_name(&property.key) {
                    if is_public_accessibility(property.accessibility) {
                        properties.insert(name);
                    } else {
                        non_public.insert(name);
                    }
                }
                if property.r#static {
                    if let Some(Expression::ObjectExpression(metadata)) =
                        property.value.as_ref().map(Expression::without_parentheses)
                    {
                        properties.extend(object_literal_direct_keys(metadata));
                    }
                }
            }
            ClassElement::MethodDefinition(method) => {
                if let Some(name) = public_property_name(&method.key) {
                    if is_public_accessibility(method.accessibility) {
                        properties.insert(name);
                    } else {
                        non_public.insert(name);
                    }
                }
            }
            ClassElement::AccessorProperty(accessor) => {
                if let Some(name) = public_property_name(&accessor.key) {
                    if is_public_accessibility(accessor.accessibility) {
                        properties.insert(name);
                    } else {
                        non_public.insert(name);
                    }
                }
                if accessor.r#static {
                    if let Some(Expression::ObjectExpression(metadata)) =
                        accessor.value.as_ref().map(Expression::without_parentheses)
                    {
                        properties.extend(object_literal_direct_keys(metadata));
                    }
                }
            }
            _ => {}
        }
    }

    let mut collector = ThisMemberCollector::default();
    for member in &class.body.body {
        collector.visit_class_element(member);
    }
    properties.extend(collector.names);
    properties.retain(|name| is_public_surface_name(name) && !non_public.contains(name));
    properties
}

fn public_property_name(name: &PropertyKey<'_>) -> Option<String> {
    name.static_name().map(|name| name.into_owned())
}

fn is_public_surface_name(name: &str) -> bool {
    name != "constructor"
        && !name.starts_with('_')
        && !name.starts_with('$')
        && is_valid_js_identifier(name)
}

#[derive(Default)]
struct ThisMemberCollector {
    names: HashSet<String>,
}

impl<'a> Visit<'a> for ThisMemberCollector {
    fn visit_class(&mut self, _class: &Class<'a>) {}

    fn visit_member_expression(&mut self, member: &MemberExpression<'a>) {
        if matches!(
            member.object().without_parentheses(),
            Expression::ThisExpression(_)
        ) {
            if let Some(name) = member.static_property_name() {
                self.names.insert(name.to_string());
            }
        }
        walk::walk_member_expression(self, member);
    }
}

#[derive(Default)]
struct CustomElementRegistrationCollector {
    class_names: HashSet<String>,
}

impl<'a> Visit<'a> for CustomElementRegistrationCollector {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if is_custom_elements_define_call(call)
            && call
                .arguments
                .first()
                .and_then(Argument::as_expression)
                .and_then(string_literal_expr_name)
                .is_some_and(|name| name.contains('-'))
        {
            if let Some(Expression::Identifier(class_name)) = call
                .arguments
                .get(1)
                .and_then(Argument::as_expression)
                .map(Expression::without_parentheses)
            {
                self.class_names.insert(class_name.name.to_string());
            }
        }
        walk::walk_call_expression(self, call);
    }
}

fn is_custom_elements_define_call(call: &CallExpression<'_>) -> bool {
    let Some(member) = call.callee.without_parentheses().as_member_expression() else {
        return false;
    };
    if member.static_property_name() != Some("define") {
        return false;
    }
    match member.object().without_parentheses() {
        Expression::Identifier(identifier) => identifier.name == "customElements",
        expression if expression.is_member_expression() => {
            expression.to_member_expression().static_property_name() == Some("customElements")
        }
        _ => false,
    }
}

fn is_custom_element_decorator(decorator: &Decorator<'_>) -> bool {
    let Expression::CallExpression(call) = decorator.expression.without_parentheses() else {
        return false;
    };
    call.arguments
        .first()
        .and_then(Argument::as_expression)
        .and_then(string_literal_expr_name)
        .is_some_and(|name| name.contains('-'))
}

#[derive(Default)]
struct ExplicitExternPropertyCollector {
    property_names: HashSet<String>,
}

impl<'a> Visit<'a> for ExplicitExternPropertyCollector {
    fn visit_member_expression(&mut self, member: &MemberExpression<'a>) {
        if is_explicit_extern_target(member.object()) {
            if let Some(property_name) = member.static_property_name() {
                if property_name != "prototype" && is_valid_js_identifier(property_name) {
                    self.property_names.insert(property_name.to_string());
                }
            }
        }
        walk::walk_member_expression(self, member);
    }
}

fn is_explicit_extern_target(expression: &Expression<'_>) -> bool {
    match expression.without_parentheses() {
        Expression::Identifier(_) => true,
        expression if expression.is_member_expression() => {
            let member = expression.to_member_expression();
            matches!(
                member.object().without_parentheses(),
                Expression::Identifier(_)
            ) && member.static_property_name() == Some("prototype")
        }
        _ => false,
    }
}

fn collect_pattern_property_reads(pattern: &BindingPattern<'_>, names: &mut HashSet<String>) {
    match pattern {
        BindingPattern::ObjectPattern(object) => {
            for property in &object.properties {
                if let Some(property_name) = property.key.static_name() {
                    if is_valid_js_identifier(property_name.as_ref()) {
                        names.insert(property_name.into_owned());
                    }
                }
                collect_pattern_property_reads(&property.value, names);
            }
            if let Some(rest) = &object.rest {
                collect_pattern_property_reads(&rest.argument, names);
            }
        }
        BindingPattern::ArrayPattern(array) => {
            for element in array.elements.iter().flatten() {
                collect_pattern_property_reads(element, names);
            }
            if let Some(rest) = &array.rest {
                collect_pattern_property_reads(&rest.argument, names);
            }
        }
        BindingPattern::AssignmentPattern(assignment) => {
            collect_pattern_property_reads(&assignment.left, names);
        }
        BindingPattern::BindingIdentifier(_) => {}
    }
}

fn collect_program_declared_names(programs: &[Program<'_>]) -> HashSet<String> {
    let mut names = HashSet::new();
    for program in programs {
        for statement in &program.body {
            match statement {
                Statement::VariableDeclaration(declaration) if !declaration.declare => {
                    for declarator in &declaration.declarations {
                        if let BindingPattern::BindingIdentifier(binding) = &declarator.id {
                            names.insert(binding.name.to_string());
                        }
                    }
                }
                Statement::FunctionDeclaration(function) if !function.declare => {
                    if let Some(identifier) = &function.id {
                        names.insert(identifier.name.to_string());
                    }
                }
                Statement::ClassDeclaration(class) if !class.declare => {
                    if let Some(identifier) = &class.id {
                        names.insert(identifier.name.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::closure_metadata::ClosureAnnotation;

    use super::*;

    static NEXT_FIXTURE_ID: AtomicUsize = AtomicUsize::new(0);

    fn analyze_fixture(source: &str, typed_member: Option<(&str, &str)>) -> ExternPropertyAnalysis {
        let fixture_id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gcc-ts-bundler-extern-analysis-{}-{fixture_id}.js",
            std::process::id()
        ));
        fs::write(&path, source).unwrap();
        let file_name = path.to_string_lossy().to_string();
        let mut metadata_by_file = HashMap::new();
        if let Some((owner_binding_name, member_name)) = typed_member {
            metadata_by_file.insert(
                closure_metadata_key(&path),
                ClosureFileMetadata {
                    ambient_globals: Vec::new(),
                    annotations: vec![ClosureAnnotation {
                        references: Vec::new(),
                        target: ClosureAnnotationTarget::Member {
                            member_kind: "field".to_string(),
                            member_name: member_name.to_string(),
                            owner_binding_name: owner_binding_name.to_string(),
                            is_static: false,
                        },
                        template: "/** @type {number} */\n".to_string(),
                        type_bearing: true,
                    }],
                    declarations: Vec::new(),
                    decorated_output_text: None,
                    diagnostics: Vec::new(),
                    enums: Vec::new(),
                    external_global_member_accesses: Vec::new(),
                    external_owned_member_accesses: Vec::new(),
                    erased_const_enums: Vec::new(),
                    file_path: file_name.clone(),
                    runtime_module_id: None,
                    source_file_path: file_name.clone(),
                    symbols: Vec::new(),
                },
            );
        }
        let analysis =
            collect_extern_property_names_with_externs(&[file_name], &[], &metadata_by_file)
                .unwrap();
        fs::remove_file(path).unwrap();
        analysis
    }

    #[test]
    fn untyped_class_member_hazard_remains_pinned() {
        let analysis = analyze_fixture(
            r#"class Box {
                constructor() { __publicField(this, "value", 1); }
                read() { return this.value; }
            }"#,
            None,
        );

        assert!(analysis.preserved_property_names.contains("value"));
    }

    #[test]
    fn metadata_backed_monomorphic_class_member_is_not_pinned() {
        let analysis = analyze_fixture(
            r#"class Box {
                constructor() { __publicField(this, "value", 1); }
                read() { return this.value; }
            }"#,
            Some(("Box", "value")),
        );

        assert!(!analysis.preserved_property_names.contains("value"));
    }

    #[test]
    fn structural_object_member_remains_pinned() {
        let analysis = analyze_fixture(
            r#"const box = { value: 1 };
            consume(box.value);"#,
            None,
        );

        assert!(analysis.preserved_property_names.contains("value"));
    }

    #[test]
    fn one_unknown_receiver_keeps_a_typed_member_pinned() {
        let analysis = analyze_fixture(
            r#"class Box {
                constructor() { __publicField(this, "value", 1); }
                read(other) { return this.value + other.value; }
            }"#,
            Some(("Box", "value")),
        );

        assert!(analysis.preserved_property_names.contains("value"));
    }
}
