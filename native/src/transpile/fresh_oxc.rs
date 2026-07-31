//! Oxc counterpart of `fresh.rs`'s read-only identifier collectors.

#![allow(dead_code)]

use std::collections::HashSet;

use oxc_ast::ast::{
    BindingIdentifier, BindingPattern, FormalParameters, IdentifierReference, JSXElementName,
    JSXMemberExpression, JSXMemberExpressionObject, ModuleExportName, Program, PropertyKey,
    TSCallSignatureDeclaration, TSConstructSignatureDeclaration, TSConstructorType,
    TSEnumMemberName, TSFunctionType, TSGlobalDeclaration, TSImportTypeQualifier,
    TSIndexSignatureName, TSMethodSignature, TSNamedTupleMember, TSNamespaceExportDeclaration,
    TSPropertySignature, TSThisParameter, TSTypePredicateName,
};
use oxc_ast_visit::{walk, Visit, VisitJs};

use super::identity_oxc::{BindingKeySet, ModuleIdentity};

#[derive(Clone, Debug, Default)]
pub(crate) struct FreshNameAllocator {
    used: HashSet<String>,
}

impl FreshNameAllocator {
    pub(crate) fn from_program(program: &Program<'_>, identity: &ModuleIdentity) -> Self {
        let mut collector = IdentifierNameCollector {
            excluded_ids: None,
            excluded_global_names: None,
            identity,
            names: HashSet::new(),
        };
        collector.visit_program(program);
        Self {
            used: collector.names,
        }
    }

    pub(crate) fn from_program_excluding(
        program: &Program<'_>,
        identity: &ModuleIdentity,
        excluded_ids: &BindingKeySet,
    ) -> Self {
        let mut collector = IdentifierNameCollector {
            excluded_ids: Some(excluded_ids),
            excluded_global_names: None,
            identity,
            names: HashSet::new(),
        };
        collector.visit_program(program);
        Self {
            used: collector.names,
        }
    }

    pub(crate) fn from_program_excluding_synthesized_globals(
        program: &Program<'_>,
        identity: &ModuleIdentity,
        excluded_global_names: &HashSet<String>,
    ) -> Self {
        let mut collector = IdentifierNameCollector {
            excluded_global_names: Some(excluded_global_names),
            excluded_ids: None,
            identity,
            names: HashSet::new(),
        };
        collector.visit_program(program);
        Self {
            used: collector.names,
        }
    }

    pub(crate) fn fresh(&mut self, preferred: &str) -> String {
        if self.used.insert(preferred.to_string()) {
            return preferred.to_string();
        }
        let mut suffix = 1usize;
        loop {
            let candidate = format!("{preferred}_{suffix}");
            if self.used.insert(candidate.clone()) {
                return candidate;
            }
            suffix += 1;
        }
    }
}

pub(crate) fn collect_lexical_binding_names(program: &Program<'_>) -> HashSet<String> {
    let mut collector = LexicalBindingNameCollector::default();
    VisitJs::visit_program(&mut collector, program);
    let mut type_collector = TypeLexicalBindingNameCollector::default();
    Visit::visit_program(&mut type_collector, program);
    collector.names.extend(type_collector.names);
    collector.names
}

struct IdentifierNameCollector<'a> {
    excluded_ids: Option<&'a BindingKeySet>,
    excluded_global_names: Option<&'a HashSet<String>>,
    identity: &'a ModuleIdentity,
    names: HashSet<String>,
}

impl IdentifierNameCollector<'_> {
    fn excluded_global_reference(&self, identifier: &IdentifierReference<'_>) -> bool {
        self.identity.is_synthesized_reference(identifier)
            && self
                .excluded_global_names
                .is_some_and(|excluded| excluded.contains(identifier.name.as_str()))
    }

    fn excluded_reference(&self, identifier: &IdentifierReference<'_>) -> bool {
        self.excluded_ids.is_some_and(|excluded| {
            self.identity
                .key_of_reference(identifier)
                .is_some_and(|key| excluded.contains(&key))
        })
    }

    fn excluded_binding(&self, identifier: &BindingIdentifier<'_>) -> bool {
        self.excluded_ids
            .is_some_and(|excluded| excluded.contains(&self.identity.key_of_binding(identifier)))
    }

    fn collect_jsx_member_expression(&mut self, member: &JSXMemberExpression<'_>) {
        match &member.object {
            JSXMemberExpressionObject::IdentifierReference(identifier) => {
                self.visit_identifier_reference(identifier);
            }
            JSXMemberExpressionObject::MemberExpression(member) => {
                self.collect_jsx_member_expression(member);
            }
            JSXMemberExpressionObject::ThisExpression(_) => {}
        }
        self.names.insert(member.property.name.to_string());
    }
}

impl<'a> Visit<'a> for IdentifierNameCollector<'_> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        // `as const` is a dedicated node in swc, but oxc exposes its pseudo-type
        // as an unresolved reference named `const`. It is not an identifier the
        // source can collide with.
        if identifier.name == "const" && self.identity.is_global(identifier) {
            return;
        }
        if !self.excluded_global_reference(identifier) && !self.excluded_reference(identifier) {
            self.names.insert(identifier.name.to_string());
        }
    }

    fn visit_binding_identifier(&mut self, identifier: &BindingIdentifier<'a>) {
        if !self.excluded_binding(identifier) {
            self.names.insert(identifier.name.to_string());
        }
    }

    fn visit_module_export_name(&mut self, name: &ModuleExportName<'a>) {
        match name {
            ModuleExportName::IdentifierName(identifier) => {
                self.names.insert(identifier.name.to_string());
            }
            ModuleExportName::IdentifierReference(identifier) => {
                self.visit_identifier_reference(identifier);
            }
            ModuleExportName::StringLiteral(_) => {}
        }
    }

    fn visit_ts_global_declaration(&mut self, declaration: &TSGlobalDeclaration<'a>) {
        self.names.insert("global".to_string());
        walk::walk_ts_global_declaration(self, declaration);
    }

    fn visit_ts_enum_member_name(&mut self, name: &TSEnumMemberName<'a>) {
        if let TSEnumMemberName::Identifier(identifier) = name {
            self.names.insert(identifier.name.to_string());
        }
    }

    fn visit_ts_named_tuple_member(&mut self, member: &TSNamedTupleMember<'a>) {
        self.names.insert(member.label.name.to_string());
        walk::walk_ts_named_tuple_member(self, member);
    }

    fn visit_ts_property_signature(&mut self, signature: &TSPropertySignature<'a>) {
        if let PropertyKey::StaticIdentifier(identifier) = &signature.key {
            self.names.insert(identifier.name.to_string());
        }
        walk::walk_ts_property_signature(self, signature);
    }

    fn visit_ts_method_signature(&mut self, signature: &TSMethodSignature<'a>) {
        if let PropertyKey::StaticIdentifier(identifier) = &signature.key {
            self.names.insert(identifier.name.to_string());
        }
        walk::walk_ts_method_signature(self, signature);
    }

    fn visit_ts_type_predicate_name(&mut self, name: &TSTypePredicateName<'a>) {
        if let TSTypePredicateName::Identifier(identifier) = name {
            self.names.insert(identifier.name.to_string());
        }
    }

    fn visit_ts_import_type_qualifier(&mut self, qualifier: &TSImportTypeQualifier<'a>) {
        match qualifier {
            TSImportTypeQualifier::Identifier(identifier) => {
                self.names.insert(identifier.name.to_string());
            }
            TSImportTypeQualifier::QualifiedName(_) => {
                walk::walk_ts_import_type_qualifier(self, qualifier);
            }
        }
    }

    fn visit_ts_namespace_export_declaration(
        &mut self,
        declaration: &TSNamespaceExportDeclaration<'a>,
    ) {
        self.names.insert(declaration.id.name.to_string());
    }

    fn visit_ts_this_parameter(&mut self, parameter: &TSThisParameter<'a>) {
        self.names.insert("this".to_string());
        walk::walk_ts_this_parameter(self, parameter);
    }

    fn visit_jsx_element_name(&mut self, name: &JSXElementName<'a>) {
        match name {
            JSXElementName::Identifier(identifier) => {
                self.names.insert(identifier.name.to_string());
            }
            JSXElementName::IdentifierReference(identifier) => {
                self.visit_identifier_reference(identifier);
            }
            JSXElementName::NamespacedName(name) => {
                self.names.insert(name.namespace.name.to_string());
                self.names.insert(name.name.name.to_string());
            }
            JSXElementName::MemberExpression(member) => {
                self.collect_jsx_member_expression(member);
            }
            JSXElementName::ThisExpression(_) => {}
        }
    }
}

#[derive(Default)]
struct LexicalBindingNameCollector {
    names: HashSet<String>,
}

impl<'a> VisitJs<'a> for LexicalBindingNameCollector {
    fn visit_binding_identifier(&mut self, binding: &BindingIdentifier<'a>) {
        self.names.insert(binding.name.to_string());
    }
}

#[derive(Default)]
struct TypeLexicalBindingNameCollector {
    names: HashSet<String>,
}

impl TypeLexicalBindingNameCollector {
    fn collect_formal_parameters(&mut self, parameters: &FormalParameters<'_>) {
        for parameter in &parameters.items {
            self.collect_pattern(&parameter.pattern);
        }
        if let Some(rest) = &parameters.rest {
            self.collect_pattern(&rest.rest.argument);
        }
    }

    fn collect_pattern(&mut self, pattern: &BindingPattern<'_>) {
        match pattern {
            BindingPattern::BindingIdentifier(binding) => {
                self.names.insert(binding.name.to_string());
            }
            BindingPattern::ObjectPattern(object) => {
                for property in &object.properties {
                    self.collect_pattern(&property.value);
                }
                if let Some(rest) = &object.rest {
                    self.collect_pattern(&rest.argument);
                }
            }
            BindingPattern::ArrayPattern(array) => {
                for element in array.elements.iter().flatten() {
                    self.collect_pattern(element);
                }
                if let Some(rest) = &array.rest {
                    self.collect_pattern(&rest.argument);
                }
            }
            BindingPattern::AssignmentPattern(assignment) => {
                self.collect_pattern(&assignment.left);
            }
        }
    }
}

impl<'a> Visit<'a> for TypeLexicalBindingNameCollector {
    fn visit_ts_method_signature(&mut self, signature: &TSMethodSignature<'a>) {
        self.collect_formal_parameters(&signature.params);
        walk::walk_ts_method_signature(self, signature);
    }

    fn visit_ts_call_signature_declaration(&mut self, signature: &TSCallSignatureDeclaration<'a>) {
        self.collect_formal_parameters(&signature.params);
        walk::walk_ts_call_signature_declaration(self, signature);
    }

    fn visit_ts_construct_signature_declaration(
        &mut self,
        signature: &TSConstructSignatureDeclaration<'a>,
    ) {
        self.collect_formal_parameters(&signature.params);
        walk::walk_ts_construct_signature_declaration(self, signature);
    }

    fn visit_ts_function_type(&mut self, function: &TSFunctionType<'a>) {
        self.collect_formal_parameters(&function.params);
        walk::walk_ts_function_type(self, function);
    }

    fn visit_ts_constructor_type(&mut self, function: &TSConstructorType<'a>) {
        self.collect_formal_parameters(&function.params);
        walk::walk_ts_constructor_type(self, function);
    }

    fn visit_ts_index_signature_name(&mut self, name: &TSIndexSignatureName<'a>) {
        self.names.insert(name.name.to_string());
        walk::walk_ts_index_signature_name(self, name);
    }

    fn visit_ts_named_tuple_member(&mut self, member: &TSNamedTupleMember<'a>) {
        self.names.insert(member.label.name.to_string());
        walk::walk_ts_named_tuple_member(self, member);
    }

    fn visit_ts_this_parameter(&mut self, parameter: &TSThisParameter<'a>) {
        self.names.insert("this".to_string());
        walk::walk_ts_this_parameter(self, parameter);
    }
}
