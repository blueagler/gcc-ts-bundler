use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use oxc_allocator::FromIn;
use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::{
    AccessorProperty, Argument, ArrowFunctionExpression, BindingPattern, BindingProperty,
    Expression, Function, FunctionType, ImportDeclarationSpecifier, MethodDefinition,
    ModuleExportName, ObjectPattern, ObjectProperty, PropertyDefinition, PropertyKey,
    SimpleAssignmentTarget, Statement, TSTypeParameterInstantiation, UnaryOperator,
    VariableDeclarator,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SPAN;
use oxc_span::{GetSpan, SourceType};
use oxc_str::Str;
use oxc_syntax::number::NumberBase;

use super::identity_oxc::{BindingKeySet, ModuleIdentity};
use super::lowering_oxc::EnumValue;

use super::emit::EmittedProgram;
use super::{emit_module_program_oxc, ChunkMode, ClosureFileMetadata, TranspileContext};

pub(super) fn transform_source_with_oxc(
    file_path: &Path,
    source: &str,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> Result<EmittedProgram, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path)
        .map_err(|error| error.to_string())?
        .with_module(true);
    let (prepared_source, opaque_commonjs_bindings, source_edits) =
        rewrite_commonjs_import_source(&allocator, source, source_type, context);
    let remapped_file_metadata = file_metadata.cloned().map(|mut metadata| {
        metadata.external_global_member_accesses = metadata
            .external_global_member_accesses
            .into_iter()
            .filter_map(|offset| remap_source_offset(offset, &source_edits))
            .collect();
        metadata.external_owned_member_accesses = metadata
            .external_owned_member_accesses
            .into_iter()
            .filter_map(|offset| remap_source_offset(offset, &source_edits))
            .collect();
        metadata
    });
    let file_metadata = remapped_file_metadata.as_ref();
    let source = prepared_source.as_str();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", file_path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut program = parsed.program;
    rewrite_ts_export_assignments(&allocator, &mut program);
    let mut enum_values = collect_imported_enum_values(file_path, &program);
    let local_enum_values = super::lowering_oxc::collect_enum_values(&program);
    let imported_enum_names = enum_values.keys().cloned().collect::<HashSet<_>>();
    let safe_enums = file_metadata
        .into_iter()
        .flat_map(|metadata| metadata.enums.iter())
        .map(|declaration| declaration.binding_name.clone())
        .collect::<HashSet<_>>();
    if !safe_enums.is_empty() {
        let local_values = super::lowering_oxc::collect_enum_values(&program);
        for name in &safe_enums {
            if let Some(members) = local_values.get(name) {
                enum_values.insert(name.clone(), members.clone());
            }
        }
        super::lowering_oxc::remove_enum_declarations(&mut program, &safe_enums);
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_enum_eval(true)
        .build(&program);
    if !semantic.diagnostics.is_empty() {
        return Err(semantic
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", file_path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let scoping = semantic.semantic.into_scoping();
    let mut identity = super::lowering_oxc::transform_program_with_enum_values(
        &allocator,
        file_path,
        &mut program,
        scoping,
        matches!(
            file_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("jsx" | "tsx")
        ),
        enum_values,
    )?;
    remove_unused_imported_enums(&mut program, &identity, &imported_enum_names);
    quote_runtime_enum_members(&allocator, &mut program, &identity, &local_enum_values);
    quote_opaque_commonjs_members(
        &allocator,
        &mut program,
        &identity,
        &opaque_commonjs_bindings,
    );
    super::js_compat_oxc::apply_program_transforms(&allocator, &mut program, &identity, source);
    rewrite_dynamic_imports(&allocator, &mut program, file_path, context);
    preserve_property_names(&allocator, &mut program, context);
    super::compat_properties_oxc::apply(
        &allocator,
        &mut program,
        &identity,
        &context.class_map_calls,
    );
    emit_module_program_oxc(
        &allocator,
        file_path,
        &mut program,
        &mut identity,
        context,
        file_metadata,
        commonjs_export_name,
    )
}

fn rewrite_ts_export_assignments<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
) {
    let builder = AstBuilder::new(allocator);
    for statement in &mut program.body {
        let Statement::TSExportAssignment(assignment) = statement else {
            continue;
        };
        let span = assignment.span;
        let expression = assignment.expression.take_in(&builder);
        *statement = Statement::new_export_default_declaration(
            span,
            oxc_ast::ast::ExportDefaultDeclarationKind::from(expression),
            &builder,
        );
    }
}

fn quote_runtime_enum_members<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    identity: &ModuleIdentity,
    enum_values: &HashMap<String, HashMap<String, EnumValue>>,
) {
    let mut bindings = HashMap::<super::identity_oxc::BindingKey, HashSet<String>>::new();
    for statement in &program.body {
        let declaration = match statement {
            Statement::VariableDeclaration(declaration) => Some(&**declaration),
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_ref() {
                Some(oxc_ast::ast::Declaration::VariableDeclaration(declaration)) => {
                    Some(&**declaration)
                }
                _ => None,
            },
            _ => None,
        };
        let Some(declaration) = declaration else {
            continue;
        };
        for declarator in &declaration.declarations {
            let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                continue;
            };
            let Some(members) = enum_values.get(binding.name.as_str()) else {
                continue;
            };
            bindings.insert(
                identity.key_of_binding(binding),
                members.keys().cloned().collect(),
            );
        }
    }
    if bindings.is_empty() {
        return;
    }
    struct EnumMemberQuoter<'a, 'i> {
        allocator: &'a Allocator,
        builder: AstBuilder<'a>,
        identity: &'i ModuleIdentity,
        bindings: HashMap<super::identity_oxc::BindingKey, HashSet<String>>,
    }
    impl<'a> VisitMut<'a> for EnumMemberQuoter<'a, '_> {
        fn visit_expression(&mut self, expression: &mut Expression<'a>) {
            walk_mut::walk_expression(self, expression);
            let Expression::StaticMemberExpression(member) = expression else {
                return;
            };
            let Expression::Identifier(object) = &member.object else {
                return;
            };
            let Some(binding) = self.identity.key_of_reference(object) else {
                return;
            };
            let property = member.property.name.to_string();
            if !self
                .bindings
                .get(&binding)
                .is_some_and(|members| members.contains(&property))
            {
                return;
            }
            let object = member.object.take_in(&self.builder);
            let key = Expression::new_string_literal(
                SPAN,
                Str::from_in(&property, self.allocator),
                None,
                &self.builder,
            );
            *expression =
                Expression::new_computed_member_expression(SPAN, object, key, false, &self.builder);
        }
    }
    EnumMemberQuoter {
        allocator,
        builder: AstBuilder::new(allocator),
        identity,
        bindings,
    }
    .visit_program(program);
}

fn remove_unused_imported_enums(
    program: &mut oxc_ast::ast::Program<'_>,
    identity: &ModuleIdentity,
    imported_enum_names: &HashSet<String>,
) {
    if imported_enum_names.is_empty() {
        return;
    }
    let mut references = BindingKeySet::default();
    struct ReferenceCollector<'a> {
        identity: &'a ModuleIdentity,
        references: &'a mut BindingKeySet,
    }
    impl<'a> Visit<'a> for ReferenceCollector<'_> {
        fn visit_identifier_reference(
            &mut self,
            reference: &oxc_ast::ast::IdentifierReference<'a>,
        ) {
            if let Some(key) = self.identity.key_of_reference(reference) {
                self.references.insert(key);
            }
        }
    }
    ReferenceCollector {
        identity,
        references: &mut references,
    }
    .visit_program(program);
    program.body.retain_mut(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return true;
        };
        let Some(specifiers) = import.specifiers.as_mut() else {
            return true;
        };
        specifiers.retain(|specifier| {
            let local = specifier.local();
            !imported_enum_names.contains(local.name.as_str())
                || references.contains(&identity.key_of_binding(local))
        });
        !specifiers.is_empty()
    });
}

fn preserve_property_names<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    context: &TranspileContext,
) {
    if context.preserved_property_names.is_empty() {
        return;
    }
    PreservedPropertyVisitor {
        allocator,
        builder: AstBuilder::new(allocator),
        names: &context.preserved_property_names,
    }
    .visit_program(program);
}

struct PreservedPropertyVisitor<'a, 'n> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    names: &'n HashSet<String>,
}

impl<'a> PreservedPropertyVisitor<'a, '_> {
    fn quote_key(&self, key: &mut PropertyKey<'a>) -> bool {
        let PropertyKey::StaticIdentifier(identifier) = key else {
            return false;
        };
        if !self.names.contains(identifier.name.as_str()) {
            return false;
        }
        *key = PropertyKey::new_string_literal(
            SPAN,
            Str::from_in(identifier.name.as_str(), self.allocator),
            None,
            &self.builder,
        );
        true
    }
}

impl<'a> VisitMut<'a> for PreservedPropertyVisitor<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::StaticMemberExpression(member) = expression else {
            return;
        };
        if !self.names.contains(member.property.name.as_str()) {
            return;
        }
        let property = member.property.name.to_string();
        let optional = member.optional;
        let object = std::mem::replace(
            &mut member.object,
            Expression::new_null_literal(SPAN, &self.builder),
        );
        *expression = Expression::new_computed_member_expression(
            SPAN,
            object,
            Expression::new_string_literal(
                SPAN,
                Str::from_in(&property, self.allocator),
                None,
                &self.builder,
            ),
            optional,
            &self.builder,
        );
    }

    fn visit_simple_assignment_target(&mut self, target: &mut SimpleAssignmentTarget<'a>) {
        if let SimpleAssignmentTarget::StaticMemberExpression(member) = target {
            if self.names.contains(member.property.name.as_str()) {
                let property = member.property.name.to_string();
                let optional = member.optional;
                let object = std::mem::replace(
                    &mut member.object,
                    Expression::new_null_literal(SPAN, &self.builder),
                );
                *target = SimpleAssignmentTarget::new_computed_member_expression(
                    SPAN,
                    object,
                    Expression::new_string_literal(
                        SPAN,
                        Str::from_in(&property, self.allocator),
                        None,
                        &self.builder,
                    ),
                    optional,
                    &self.builder,
                );
                return;
            }
        }
        walk_mut::walk_simple_assignment_target(self, target);
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        walk_mut::walk_object_property(self, property);
        if self.quote_key(&mut property.key) {
            property.computed = false;
            property.shorthand = false;
        }
    }

    fn visit_binding_property(&mut self, property: &mut BindingProperty<'a>) {
        walk_mut::walk_binding_property(self, property);
        if self.quote_key(&mut property.key) {
            property.computed = false;
            property.shorthand = false;
        }
    }

    fn visit_method_definition(&mut self, method: &mut MethodDefinition<'a>) {
        walk_mut::walk_method_definition(self, method);
        if matches!(
            &method.key,
            PropertyKey::StaticIdentifier(identifier) if identifier.name == "constructor"
        ) {
            return;
        }
        if self.quote_key(&mut method.key) {
            method.computed = false;
        }
    }

    fn visit_property_definition(&mut self, property: &mut PropertyDefinition<'a>) {
        walk_mut::walk_property_definition(self, property);
        // A quoted STATIC field crashes Closure: ConvertToDottedProperties
        // reads the value of `static "x" = v` from the wrong child and
        // dereferences null ("Cannot invoke Node.detach() because rightElem is
        // null"). Quoting a class field buys nothing anyway — that same pass
        // converts `"x" = v` straight back to `x = v`, and the extern entry is
        // what keeps the name out of renaming.
        if property.r#static {
            return;
        }
        if self.quote_key(&mut property.key) {
            property.computed = false;
            if property.value.is_none() {
                property.value = Some(Expression::new_unary_expression(
                    SPAN,
                    UnaryOperator::Void,
                    Expression::new_numeric_literal(
                        SPAN,
                        0.0,
                        None,
                        NumberBase::Decimal,
                        &self.builder,
                    ),
                    &self.builder,
                ));
            }
        }
    }

    fn visit_accessor_property(&mut self, property: &mut AccessorProperty<'a>) {
        walk_mut::walk_accessor_property(self, property);
        if self.quote_key(&mut property.key) {
            property.computed = false;
        }
    }
}

fn rewrite_commonjs_import_source(
    allocator: &Allocator,
    source: &str,
    source_type: SourceType,
    context: &TranspileContext,
) -> (String, HashSet<String>, Vec<SourceEdit>) {
    let parsed = Parser::new(allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return (source.to_string(), HashSet::new(), Vec::new());
    }
    let mut used = super::fresh_oxc::collect_lexical_binding_names(&parsed.program);
    let mut component_edits = ComponentParamEditCollector {
        edits: Vec::new(),
        source,
        used: &mut used,
    };
    component_edits.visit_program(&parsed.program);
    let mut throw_edits = ThrowEditCollector {
        edits: Vec::new(),
        source,
    };
    if context.chunk_mode == ChunkMode::Off {
        throw_edits.visit_program(&parsed.program);
    }
    let mut import_counter = 0usize;
    let mut edits = Vec::new();
    edits.extend(component_edits.edits);
    edits.extend(throw_edits.edits);
    let mut opaque_bindings = HashSet::new();
    for statement in &parsed.program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        let specifier = import.source.value.as_str();
        if !context.commonjs_specifiers.contains(specifier) {
            continue;
        }
        let quoted = context.opaque_commonjs.specifier_is_opaque(specifier);
        let mut default_local = None;
        let mut namespace_local = None;
        let mut named = Vec::new();
        for import_specifier in import.specifiers.iter().flatten() {
            match import_specifier {
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    default_local = Some(default.local.name.to_string());
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    namespace_local = Some(namespace.local.name.to_string());
                }
                ImportDeclarationSpecifier::ImportSpecifier(named_specifier) => {
                    named.push((
                        module_export_name(&named_specifier.imported),
                        named_specifier.local.name.to_string(),
                    ));
                }
            }
        }
        if namespace_local.is_none() && named.is_empty() {
            if quoted {
                opaque_bindings.extend(default_local);
            }
            continue;
        }
        let helper = default_local.unwrap_or_else(|| {
            let preferred = format!("__cjs_import_{import_counter}");
            import_counter += 1;
            fresh_name(&mut used, &preferred)
        });
        let mut replacement = vec![format!("import {helper} from {specifier:?};")];
        if quoted {
            opaque_bindings.insert(helper.clone());
        }
        if let Some(namespace) = namespace_local {
            if namespace != helper {
                replacement.push(format!("const {namespace} = {helper};"));
            }
            if quoted {
                opaque_bindings.insert(namespace);
            }
        }
        for (imported, local) in named {
            let access = if quoted {
                format!("{helper}[{imported:?}]")
            } else {
                format!("{helper}.{imported}")
            };
            replacement.push(format!("const {local} = {access};"));
        }
        edits.push((
            import.span.start as usize,
            import.span.end as usize,
            replacement.join("\n"),
        ));
    }
    let mut output = source.to_string();
    edits.sort_by_key(|(start, _, _)| *start);
    let source_edits = edits
        .iter()
        .map(|(start, end, replacement)| SourceEdit {
            end: *end,
            replacement_len: replacement.len(),
            start: *start,
        })
        .collect::<Vec<_>>();
    for (start, end, replacement) in edits.into_iter().rev() {
        output.replace_range(start..end, &replacement);
    }
    (output, opaque_bindings, source_edits)
}

#[derive(Clone, Copy)]
struct SourceEdit {
    end: usize,
    replacement_len: usize,
    start: usize,
}

fn remap_source_offset(offset: u32, edits: &[SourceEdit]) -> Option<u32> {
    let offset = offset as usize;
    let mut delta = 0isize;
    for edit in edits {
        if offset < edit.start {
            break;
        }
        if offset < edit.end {
            return None;
        }
        delta += edit.replacement_len as isize - (edit.end - edit.start) as isize;
    }
    u32::try_from(offset.checked_add_signed(delta)?).ok()
}

struct ThrowEditCollector<'a> {
    edits: Vec<(usize, usize, String)>,
    source: &'a str,
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

struct ComponentParamEditCollector<'a, 'u> {
    edits: Vec<(usize, usize, String)>,
    source: &'a str,
    used: &'u mut HashSet<String>,
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

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

fn fresh_name(used: &mut HashSet<String>, preferred: &str) -> String {
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

fn quote_opaque_commonjs_members<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    identity: &ModuleIdentity,
    names: &HashSet<String>,
) {
    if names.is_empty() {
        return;
    }
    let mut bindings = BindingKeySet::new();
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                for specifier in import.specifiers.iter().flatten() {
                    let local = specifier.local();
                    if names.contains(local.name.as_str()) {
                        bindings.insert(identity.key_of_binding(local));
                    }
                }
            }
            Statement::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    if let BindingPattern::BindingIdentifier(binding) = &declarator.id {
                        if names.contains(binding.name.as_str()) {
                            bindings.insert(identity.key_of_binding(binding));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    OpaqueCommonJsMemberQuoter {
        allocator,
        builder: AstBuilder::new(allocator),
        bindings,
        identity,
    }
    .visit_program(program);
}

struct OpaqueCommonJsMemberQuoter<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    bindings: BindingKeySet,
    identity: &'i ModuleIdentity,
}

impl<'a> VisitMut<'a> for OpaqueCommonJsMemberQuoter<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::StaticMemberExpression(member) = expression else {
            return;
        };
        let Expression::Identifier(object) = &member.object else {
            return;
        };
        if !self
            .identity
            .key_of_reference(object)
            .is_some_and(|binding| self.bindings.contains(&binding))
        {
            return;
        }
        let property = member.property.name.to_string();
        let optional = member.optional;
        let object = std::mem::replace(
            &mut member.object,
            Expression::new_null_literal(SPAN, &self.builder),
        );
        *expression = Expression::new_computed_member_expression(
            SPAN,
            object,
            Expression::new_string_literal(
                SPAN,
                Str::from_in(&property, self.allocator),
                None,
                &self.builder,
            ),
            optional,
            &self.builder,
        );
    }
}

fn rewrite_dynamic_imports<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    file_path: &Path,
    context: &TranspileContext,
) {
    if context.chunk_mode == super::ChunkMode::Off {
        return;
    }
    let Some(imports) = context
        .lazy_imports_by_file
        .get(&file_path.to_string_lossy().to_string())
    else {
        return;
    };
    DynamicImportRewriter {
        allocator,
        builder: AstBuilder::new(allocator),
        imports,
    }
    .visit_program(program);
}

struct DynamicImportRewriter<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    imports: &'i [super::LazyImportInput],
}

impl<'a> VisitMut<'a> for DynamicImportRewriter<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::ImportExpression(import) = expression else {
            return;
        };
        let specifier = match &import.source {
            Expression::StringLiteral(literal) => literal.value.as_str(),
            Expression::TemplateLiteral(template)
                if template.expressions.is_empty() && template.quasis.len() == 1 =>
            {
                template.quasis[0]
                    .value
                    .cooked
                    .as_ref()
                    .unwrap_or(&template.quasis[0].value.raw)
                    .as_str()
            }
            _ => return,
        };
        let Some(lazy_import) = self
            .imports
            .iter()
            .find(|entry| entry.specifier == specifier)
        else {
            return;
        };
        let module_id = Expression::new_string_literal(
            SPAN,
            Str::from_in(
                &super::to_bundler_runtime_module_id(&lazy_import.moduleId),
                self.allocator,
            ),
            None,
            &self.builder,
        );
        *expression = Expression::new_call_expression(
            SPAN,
            Expression::new_identifier(SPAN, "__dynamicImport", &self.builder),
            None::<oxc_allocator::Box<'a, TSTypeParameterInstantiation<'a>>>,
            oxc_allocator::Vec::from_value_in(Argument::from(module_id), &self.allocator),
            false,
            &self.builder,
        );
    }
}

fn collect_imported_enum_values(
    file_path: &Path,
    program: &oxc_ast::ast::Program<'_>,
) -> HashMap<String, HashMap<String, EnumValue>> {
    let mut imported = HashMap::new();
    for statement in &program.body {
        let oxc_ast::ast::Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        let specifier = import.source.value.as_str();
        if !specifier.starts_with('.') {
            continue;
        }
        let Some(resolved_path) = super::resolve_relative_module(file_path, specifier) else {
            continue;
        };
        let mut target_values = enum_values_from_file(&resolved_path);
        if target_values.is_empty() {
            for candidate in enum_metadata_candidate_paths(&resolved_path) {
                target_values = enum_values_from_file(&candidate);
                if !target_values.is_empty() {
                    break;
                }
            }
        }
        let Some(specifiers) = &import.specifiers else {
            continue;
        };
        for specifier in specifiers {
            let oxc_ast::ast::ImportDeclarationSpecifier::ImportSpecifier(named) = specifier else {
                continue;
            };
            let imported_name = match &named.imported {
                oxc_ast::ast::ModuleExportName::IdentifierName(identifier) => {
                    identifier.name.as_str()
                }
                oxc_ast::ast::ModuleExportName::IdentifierReference(identifier) => {
                    identifier.name.as_str()
                }
                oxc_ast::ast::ModuleExportName::StringLiteral(literal) => literal.value.as_str(),
            };
            if let Some(members) = target_values.get(imported_name) {
                imported.insert(named.local.name.to_string(), members.clone());
            }
        }
    }
    imported
}

fn enum_values_from_file(path: &Path) -> HashMap<String, HashMap<String, EnumValue>> {
    let Ok(source) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(source_type) = SourceType::from_path(path) else {
        return HashMap::new();
    };
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &source, source_type.with_module(true)).parse();
    if !parsed.diagnostics.is_empty() {
        return HashMap::new();
    }
    super::lowering_oxc::collect_enum_values(&parsed.program)
}

fn enum_metadata_candidate_paths(resolved_path: &Path) -> Vec<PathBuf> {
    if resolved_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("js")
    {
        return Vec::new();
    }
    let mut candidates = vec![resolved_path.with_extension("d.ts")];
    let resolved = resolved_path.to_string_lossy();
    if resolved.contains("/dist/esm/") {
        let source = resolved.replace("/dist/esm/", "/src/");
        candidates.push(PathBuf::from(&source).with_extension("ts"));
        candidates.push(PathBuf::from(source).with_extension("tsx"));
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_ast::ast::Program;
    use oxc_codegen::Codegen;

    fn lowered(source: &str) -> String {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, SourceType::ts()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program: Program<'_> = parsed.program;
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .with_enum_eval(true)
            .build(&program);
        assert!(
            semantic.diagnostics.is_empty(),
            "{:?}",
            semantic.diagnostics
        );
        let scoping = semantic.semantic.into_scoping();
        super::super::lowering_oxc::transform_program(
            &allocator,
            Path::new("fixture.ts"),
            &mut program,
            scoping,
            false,
        )
        .unwrap();
        Codegen::new().build(&program).code
    }

    #[test]
    fn oxc_codegen_owns_namespace_iife_precedence() {
        let output =
            lowered("namespace Outer { export const x = 1; }\nexport const y = Outer.x;\n");
        assert!(output.contains("(function("), "{output}");
        assert!(output.contains("(Outer = {})"), "{output}");
    }

    #[test]
    fn ordinary_iifes_and_binaries_keep_their_shape() {
        let output =
            lowered("export const a = (function () { return 1; })();\nexport const b = 1 || 2;\n");
        assert!(!output.contains("((function"), "{output}");
        assert!(output.contains("1 || 2"), "{output}");
    }

    #[test]
    fn preserved_static_field_name_stays_dotted() {
        let allocator = Allocator::default();
        let parsed = Parser::new(
            &allocator,
            "class Schema { static warning = 1; rules = null; }",
            SourceType::mjs(),
        )
        .parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        PreservedPropertyVisitor {
            allocator: &allocator,
            builder: AstBuilder::new(&allocator),
            names: &HashSet::from(["warning".to_string(), "rules".to_string()]),
        }
        .visit_program(&mut program);
        let output = Codegen::new().build(&program).code;
        // Quoting the static field is what crashes Closure; the instance field
        // is unaffected.
        assert!(output.contains("static warning = 1"), "{output}");
        assert!(output.contains("\"rules\" = null"), "{output}");
    }

    #[test]
    fn preserved_constructor_name_stays_class_syntax() {
        let allocator = Allocator::default();
        let parsed = Parser::new(
            &allocator,
            "class Child extends Error { constructor() { super('x'); } }",
            SourceType::mjs(),
        )
        .parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        PreservedPropertyVisitor {
            allocator: &allocator,
            builder: AstBuilder::new(&allocator),
            names: &HashSet::from(["constructor".to_string()]),
        }
        .visit_program(&mut program);
        let output = Codegen::new().build(&program).code;
        assert!(output.contains("constructor()"), "{output}");
        assert!(!output.contains("\"constructor\"()"), "{output}");
    }
}
