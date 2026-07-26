use super::*;
mod commonjs;
mod object_patterns;
mod properties;

pub(super) use self::commonjs::{
    create_ident, create_rename_property_expr, rewrite_commonjs_imports,
    CommonJsNamespaceAccessVisitor, GoogModuleThrowRewriteVisitor,
};
pub(super) use self::object_patterns::ObjectPatternParamVisitor;
pub(super) use self::properties::{
    collect_class_static_assignments, quote_prop_name, PreservedPropertyCompatVisitor,
};

pub(super) fn apply_program_compat_transforms(program: &mut Program, context: &TranspileContext) {
    let mut commonjs_namespace_bindings = HashSet::new();
    if let Program::Module(module) = program {
        commonjs_namespace_bindings =
            rewrite_commonjs_imports(module, &context.commonjs_specifiers);
    }

    if !commonjs_namespace_bindings.is_empty() {
        program.visit_mut_with(&mut CommonJsNamespaceAccessVisitor::new(
            commonjs_namespace_bindings,
        ));
    }
    if !context.preserved_property_names.is_empty() {
        program.visit_mut_with(&mut PreservedPropertyCompatVisitor::new(
            context.preserved_property_names.clone(),
        ));
    }
    if context.chunk_mode != ChunkMode::BundlerRuntime {
        program.visit_mut_with(&mut GoogModuleThrowRewriteVisitor);
    }
    program.visit_mut_with(&mut ObjectPatternParamVisitor::default());
}

pub(super) fn apply_file_compat_transforms(
    program: &mut Program,
    file_path: &Path,
    context: &TranspileContext,
) {
    apply_program_compat_transforms(program, context);
    let dynamic_import_target = match context.chunk_mode {
        ChunkMode::BundlerRuntime => Some(DynamicImportTarget::BundlerRuntime),
        ChunkMode::Split => Some(DynamicImportTarget::SplitRegistry),
        ChunkMode::Off => None,
    };
    if let Some(target) = dynamic_import_target {
        if let Some(lazy_imports) = context
            .lazy_imports_by_file
            .get(&file_path.to_string_lossy().to_string())
        {
            program.visit_mut_with(&mut DynamicImportRewriteVisitor::new(
                file_path,
                lazy_imports,
                target,
            ));
        }
    }
}
