//! Collectors for dynamic-import wrapper bindings.

use std::collections::HashMap;

use oxc_ast::ast::{
    BindingIdentifier, BindingPattern, Declaration, Function, Program, Statement,
    VariableDeclarator,
};
use oxc_ast_visit::{walk, Visit};

use super::super::wrappers_rewrite::{
    extract_dynamic_import_module_ids_from_expr, extract_dynamic_import_module_ids_from_function,
    extract_dynamic_import_object_wrapper_from_callable_expr,
    extract_dynamic_import_object_wrapper_from_function, extract_dynamic_import_object_wrappers,
};
use super::super::wrappers_types::{DynamicImportObjectWrapper, DynamicImportWrappers};
use crate::transpile::identity::{BindingKeyMap, ModuleIdentity};

pub(crate) fn collect_dynamic_import_wrappers(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> Result<DynamicImportWrappers, String> {
    let mut collector = DynamicImportWrapperCollector {
        identity,
        wrappers: DynamicImportWrappers::default(),
        error: None,
    };
    collector.visit_program(program);
    if let Some(error) = collector.error {
        return Err(error);
    }

    let mut wrappers = collector.wrappers;
    let mut object_function_wrappers = HashMap::new();
    loop {
        let mut collector = DynamicImportObjectFunctionCollector {
            object_factories: object_function_wrappers.clone(),
            wrappers: DynamicImportWrappers {
                object_factories: object_function_wrappers.clone(),
                ..wrappers.clone()
            },
            identity,
            error: None,
        };
        collector.visit_program(program);
        if let Some(error) = collector.error {
            return Err(error);
        }
        if collector.object_factories == object_function_wrappers {
            wrappers.object_factories = collector.object_factories;
            return Ok(wrappers);
        }
        object_function_wrappers = collector.object_factories;
    }
}

struct DynamicImportWrapperCollector<'a> {
    wrappers: DynamicImportWrappers,
    identity: &'a ModuleIdentity,
    error: Option<String>,
}

impl DynamicImportWrapperCollector<'_> {
    fn collect_function_declaration(&mut self, function: &Function<'_>) {
        let Some(binding) = &function.id else {
            return;
        };
        if let Some(module_ids) =
            extract_dynamic_import_module_ids_from_function(function, self.identity)
        {
            match ModuleIdentity::key_of_binding(binding) {
                Ok(binding) => {
                    self.wrappers.functions.insert(binding, module_ids);
                }
                Err(error) => {
                    self.error.get_or_insert(error);
                }
            }
        }
    }
}

impl<'a> Visit<'a> for DynamicImportWrapperCollector<'_> {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        match statement {
            Statement::FunctionDeclaration(function) => {
                self.collect_function_declaration(function);
            }
            Statement::ExportDeclaration(export) => {
                if let Declaration::FunctionDeclaration(function) = &export.declaration {
                    self.collect_function_declaration(function);
                }
            }
            _ => {}
        }
        walk::walk_statement(self, statement);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            walk::walk_variable_declarator(self, declarator);
            return;
        };
        if let Some(initializer) = &declarator.init {
            if let Some(module_ids) =
                extract_dynamic_import_module_ids_from_expr(initializer, self.identity)
            {
                match ModuleIdentity::key_of_binding(binding) {
                    Ok(binding) => {
                        self.wrappers.functions.insert(binding, module_ids);
                    }
                    Err(error) => {
                        self.error.get_or_insert(error);
                    }
                }
            } else if let Some(object_wrappers) =
                extract_dynamic_import_object_wrappers(initializer, self.identity)
            {
                match ModuleIdentity::key_of_binding(binding) {
                    Ok(binding) => {
                        self.wrappers.objects.insert(binding, object_wrappers);
                    }
                    Err(error) => {
                        self.error.get_or_insert(error);
                    }
                }
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

struct DynamicImportObjectFunctionCollector<'a> {
    object_factories: BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: DynamicImportWrappers,
    identity: &'a ModuleIdentity,
    error: Option<String>,
}

impl DynamicImportObjectFunctionCollector<'_> {
    fn insert_wrapper(
        &mut self,
        binding: &BindingIdentifier<'_>,
        wrapper: DynamicImportObjectWrapper,
    ) {
        let binding = match ModuleIdentity::key_of_binding(binding) {
            Ok(binding) => binding,
            Err(error) => {
                self.error.get_or_insert(error);
                return;
            }
        };
        self.wrappers
            .object_factories
            .insert(binding, wrapper.clone());
        self.object_factories.insert(binding, wrapper);
    }

    fn collect_function_declaration(&mut self, function: &Function<'_>) {
        let Some(binding) = &function.id else {
            return;
        };
        if let Some(wrapper) = extract_dynamic_import_object_wrapper_from_function(
            function,
            &self.wrappers,
            self.identity,
        ) {
            self.insert_wrapper(binding, wrapper);
        }
    }
}

impl<'a> Visit<'a> for DynamicImportObjectFunctionCollector<'_> {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        match statement {
            Statement::FunctionDeclaration(function) => {
                self.collect_function_declaration(function);
            }
            Statement::ExportDeclaration(export) => {
                if let Declaration::FunctionDeclaration(function) = &export.declaration {
                    self.collect_function_declaration(function);
                }
            }
            _ => {}
        }
        walk::walk_statement(self, statement);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            walk::walk_variable_declarator(self, declarator);
            return;
        };
        if let Some(initializer) = &declarator.init {
            if let Some(wrapper) = extract_dynamic_import_object_wrapper_from_callable_expr(
                initializer,
                &self.wrappers,
                self.identity,
            ) {
                self.insert_wrapper(binding, wrapper);
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}
