use super::*;
mod commonjs;
mod object_patterns;
mod properties;

pub(super) use self::commonjs::{
    create_ident, create_rename_property_expr, rewrite_commonjs_imports,
    CommonJsNamespaceAccessVisitor, GoogModuleThrowRewriteVisitor,
};
pub(super) use self::object_patterns::ObjectPatternParamVisitor;
pub(crate) use self::properties::{
    collect_class_static_assignments, collect_pair_array_class_map_property_names, quote_prop_name,
    validate_class_map_calls,
    ClassMapCallCompatVisitor, PreservedPropertyCompatVisitor,
};

fn collect_import_alias_names(module: &Module) -> BindingKeyMap<String> {
    module
        .body
        .iter()
        .filter_map(|item| {
            let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import)) = item
            else {
                return None;
            };
            Some(import)
        })
        .flat_map(|import| import.specifiers.iter())
        .filter_map(|specifier| {
            let ImportSpecifier::Named(named) = specifier else {
                return None;
            };
            let imported = named
                .imported
                .as_ref()
                .map(module_export_name_to_string)
                .unwrap_or_else(|| named.local.sym.to_string());
            Some((BindingKey::of(&named.local), imported))
        })
        .collect()
}

pub(super) fn apply_program_compat_transforms(program: &mut Program, context: &TranspileContext) {
    // Alias metadata must be captured while imports and their resolver Ids still
    // exist; CommonJS lowering replaces the declarations below.
    let import_aliases = if context.class_map_calls.is_empty() {
        HashMap::new()
    } else {
        match &*program {
            Program::Module(module) => collect_import_alias_names(module),
            _ => HashMap::new(),
        }
    };
    let mut fresh_names = FreshNameAllocator::from_program(program);
    let mut commonjs_namespace_bindings = HashSet::new();
    if let Program::Module(module) = program {
        commonjs_namespace_bindings = rewrite_commonjs_imports(
            module,
            &context.commonjs_specifiers,
            &context.opaque_commonjs,
            &mut fresh_names,
        );
    }

    if !commonjs_namespace_bindings.is_empty() {
        program.visit_mut_with(&mut CommonJsNamespaceAccessVisitor::new(
            commonjs_namespace_bindings,
        ));
    }
    if !context.class_map_calls.is_empty() {
        let mut visitor =
            ClassMapCallCompatVisitor::new(&context.class_map_calls, import_aliases, program);
        program.visit_mut_with(&mut visitor);
    }
    if !context.preserved_property_names.is_empty() {
        program.visit_mut_with(&mut PreservedPropertyCompatVisitor::new(
            context.preserved_property_names.clone(),
        ));
    }
    if context.chunk_mode != ChunkMode::BundlerRuntime {
        program.visit_mut_with(&mut GoogModuleThrowRewriteVisitor);
    }
    program.visit_mut_with(&mut ObjectPatternParamVisitor::new(fresh_names));
}

pub(super) fn apply_file_compat_transforms(
    program: &mut Program,
    file_path: &Path,
    context: &TranspileContext,
) {
    apply_program_compat_transforms(program, context);
    // Both chunked modes address lazy modules through the shared runtime's
    // graph-derived module id; only unchunked output leaves `import()` alone.
    let rewrite_dynamic_imports = !matches!(context.chunk_mode, ChunkMode::Off);
    if rewrite_dynamic_imports {
        if let Some(lazy_imports) = context
            .lazy_imports_by_file
            .get(&file_path.to_string_lossy().to_string())
        {
            program.visit_mut_with(&mut DynamicImportRewriteVisitor::new(
                file_path,
                lazy_imports,
            ));
        }
    }
    program.visit_mut_with(&mut DirectoryModuleSpecifierVisitor);
}
