//! Collectors for dynamic-import wrapper bindings.

use std::collections::HashMap;

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};

use super::super::wrappers_rewrite::{
    extract_dynamic_import_module_ids_from_expr, extract_dynamic_import_module_ids_from_function,
    extract_dynamic_import_object_wrapper_from_callable_expr,
    extract_dynamic_import_object_wrapper_from_function, extract_dynamic_import_object_wrappers,
};
use super::super::wrappers_types::{DynamicImportObjectWrapper, DynamicImportWrappers};
use crate::transpile::identity::{BindingKey, BindingKeyMap, ModuleIdentity};

pub(crate) fn collect_dynamic_import_wrappers(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> DynamicImportWrappers {
    let mut collector = DynamicImportWrapperCollector {
        identity,
        wrappers: DynamicImportWrappers::default(),
    };
    collector.visit_program(program);

    let mut wrappers = collector.wrappers;
    let mut object_function_wrappers = HashMap::new();
    loop {
        let mut collector = DynamicImportObjectFunctionCollector {
            object_function_wrappers: object_function_wrappers.clone(),
            wrappers: DynamicImportWrappers {
                object_function_wrappers: object_function_wrappers.clone(),
                ..wrappers.clone()
            },
            identity,
        };
        collector.visit_program(program);
        if collector.object_function_wrappers == object_function_wrappers {
            wrappers.object_function_wrappers = collector.object_function_wrappers;
            return wrappers;
        }
        object_function_wrappers = collector.object_function_wrappers;
    }
}

struct DynamicImportWrapperCollector<'a> {
    wrappers: DynamicImportWrappers,
    identity: &'a ModuleIdentity,
}

impl DynamicImportWrapperCollector<'_> {
    fn collect_function_declaration(&mut self, function: &Function<'_>) {
        let Some(binding) = &function.id else {
            return;
        };
        if let Some(module_ids) =
            extract_dynamic_import_module_ids_from_function(function, self.identity)
        {
            self.wrappers
                .function_wrappers
                .insert(self.identity.key_of_binding(binding), module_ids);
        }
    }
}

impl<'a> Visit<'a> for DynamicImportWrapperCollector<'_> {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        match statement {
            Statement::FunctionDeclaration(function) => {
                self.collect_function_declaration(function);
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(Declaration::FunctionDeclaration(function)) = &export.declaration {
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
                self.wrappers
                    .function_wrappers
                    .insert(self.identity.key_of_binding(binding), module_ids);
            } else if let Some(object_wrappers) =
                extract_dynamic_import_object_wrappers(initializer, self.identity)
            {
                self.wrappers
                    .object_wrappers
                    .insert(self.identity.key_of_binding(binding), object_wrappers);
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

struct DynamicImportObjectFunctionCollector<'a> {
    object_function_wrappers: BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: DynamicImportWrappers,
    identity: &'a ModuleIdentity,
}

impl DynamicImportObjectFunctionCollector<'_> {
    fn insert_wrapper(&mut self, binding: BindingKey, wrapper: DynamicImportObjectWrapper) {
        self.wrappers
            .object_function_wrappers
            .insert(binding, wrapper.clone());
        self.object_function_wrappers.insert(binding, wrapper);
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
            self.insert_wrapper(self.identity.key_of_binding(binding), wrapper);
        }
    }
}

impl<'a> Visit<'a> for DynamicImportObjectFunctionCollector<'_> {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        match statement {
            Statement::FunctionDeclaration(function) => {
                self.collect_function_declaration(function);
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(Declaration::FunctionDeclaration(function)) = &export.declaration {
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
                self.insert_wrapper(self.identity.key_of_binding(binding), wrapper);
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}
