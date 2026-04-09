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
    collect_class_static_assignments, collect_global_this_aliases, quote_prop_name,
    ConstantLikePropertyCompatVisitor, DerivedClassMethodKeyCompatVisitor,
    GlobalThisPropertyCompatVisitor, InstanceMethodCompatVisitor,
    InternalProtocolMemberCompatVisitor, StaticPropertyCompatVisitor,
    UppercaseStaticMemberCompatVisitor,
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
    if !context.global_property_names.is_empty() {
        let aliases = collect_global_this_aliases(program);
        program.visit_mut_with(&mut GlobalThisPropertyCompatVisitor::new(
            context.global_property_names.clone(),
            aliases,
        ));
    }
    if !context.static_property_names.is_empty() {
        program.visit_mut_with(&mut StaticPropertyCompatVisitor::new(
            context.static_property_names.clone(),
        ));
    }
    if !context.instance_method_names.is_empty() {
        program.visit_mut_with(&mut InstanceMethodCompatVisitor::new(
            context.instance_method_names.clone(),
        ));
    }
    program.visit_mut_with(&mut InternalProtocolMemberCompatVisitor);
    program.visit_mut_with(&mut DerivedClassMethodKeyCompatVisitor);
    program.visit_mut_with(&mut ConstantLikePropertyCompatVisitor);
    program.visit_mut_with(&mut UppercaseStaticMemberCompatVisitor);
    if context.chunk_mode == ChunkMode::Off {
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
    if context.chunk_mode == ChunkMode::BundlerRuntime {
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
}
