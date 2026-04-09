use super::*;

pub(super) fn collect_class_static_assignments(source_text: &str) -> Vec<(String, String)> {
    let class_binding_regex = match regex::Regex::new(
        r"\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*class\b|class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b",
    ) {
        Ok(regex) => regex,
        Err(_) => return Vec::new(),
    };
    let assignment_regex =
        match regex::Regex::new(r"([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=") {
            Ok(regex) => regex,
            Err(_) => return Vec::new(),
        };

    let mut class_bindings = HashSet::new();
    for captures in class_binding_regex.captures_iter(source_text) {
        if let Some(capture) = captures.get(1).or_else(|| captures.get(2)) {
            class_bindings.insert(capture.as_str().to_string());
        }
    }

    let mut assignments = Vec::new();
    for captures in assignment_regex.captures_iter(source_text) {
        let class_name = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        let property_name = captures
            .get(2)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        if class_bindings.contains(class_name) {
            assignments.push((class_name.to_string(), property_name.to_string()));
        }
    }

    assignments
}

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

pub(super) struct StaticPropertyCompatVisitor {
    property_names: HashSet<String>,
}

impl StaticPropertyCompatVisitor {
    pub(super) fn new(property_names: HashSet<String>) -> Self {
        Self { property_names }
    }
}

impl VisitMut for StaticPropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !self.property_names.contains(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }
}

struct InstanceMethodCompatVisitor {
    method_names: HashSet<String>,
}

impl InstanceMethodCompatVisitor {
    fn new(method_names: HashSet<String>) -> Self {
        Self { method_names }
    }
}

impl VisitMut for InstanceMethodCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        match expr {
            Expr::Member(member) => {
                if member.prop.is_computed() {
                    return;
                }
                let Expr::This(_) = &*member.obj else {
                    return;
                };
                let MemberProp::Ident(prop_ident) = &member.prop else {
                    return;
                };
                if !self.method_names.contains(prop_ident.sym.as_ref()) {
                    return;
                }

                member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
            }
            Expr::SuperProp(super_prop) => {
                let SuperProp::Ident(prop_ident) = &super_prop.prop else {
                    return;
                };
                if !self.method_names.contains(prop_ident.sym.as_ref()) {
                    return;
                }

                super_prop.prop = create_string_computed_super_prop(prop_ident.sym.as_ref());
            }
            _ => {}
        }
    }
}

struct GlobalThisAliasCollector {
    aliases: HashSet<String>,
}

impl Visit for GlobalThisAliasCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);

        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(init) = &declarator.init else {
            return;
        };
        let Expr::Ident(ident) = &**init else {
            return;
        };
        if self.aliases.contains(ident.sym.as_ref()) {
            self.aliases.insert(binding.id.sym.to_string());
        }
    }
}

fn collect_global_this_aliases(program: &Program) -> HashSet<String> {
    let mut collector = GlobalThisAliasCollector {
        aliases: HashSet::from(["globalThis".to_string()]),
    };
    program.visit_with(&mut collector);
    collector.aliases
}

struct GlobalThisPropertyCompatVisitor {
    aliases: HashSet<String>,
    property_names: HashSet<String>,
}

impl GlobalThisPropertyCompatVisitor {
    fn new(property_names: HashSet<String>, aliases: HashSet<String>) -> Self {
        Self {
            aliases,
            property_names,
        }
    }
}

impl VisitMut for GlobalThisPropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let Expr::Ident(object_ident) = &*member.obj else {
            return;
        };
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if self.aliases.contains(object_ident.sym.as_ref())
            && self.property_names.contains(prop_ident.sym.as_ref())
        {
            member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
        }
    }
}

struct ConstantLikePropertyCompatVisitor;
struct InternalProtocolMemberCompatVisitor;

fn is_internal_protocol_name(name: &str) -> bool {
    name.starts_with('_') || name.contains('$')
}

impl VisitMut for InternalProtocolMemberCompatVisitor {
    fn visit_mut_member_expr(&mut self, member: &mut MemberExpr) {
        member.visit_mut_children_with(self);

        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_internal_protocol_name(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_internal_protocol_name(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }

    fn visit_mut_prop_name(&mut self, prop_name: &mut PropName) {
        prop_name.visit_mut_children_with(self);

        let PropName::Ident(ident) = prop_name else {
            return;
        };
        if !is_internal_protocol_name(ident.sym.as_ref()) {
            return;
        }

        *prop_name = PropName::Str(Str {
            span: Default::default(),
            value: ident.sym.to_string().into(),
            raw: None,
        });
    }

    fn visit_mut_class(&mut self, class: &mut swc_core::ecma::ast::Class) {
        class.visit_mut_children_with(self);
        for member in &mut class.body {
            match member {
                swc_core::ecma::ast::ClassMember::Method(method)
                    if prop_name_to_string(&method.key)
                        .map(|name| is_internal_protocol_name(&name))
                        .unwrap_or(false) =>
                {
                    method.key = quote_prop_name(method.key.clone());
                }
                swc_core::ecma::ast::ClassMember::ClassProp(prop)
                    if prop_name_to_string(&prop.key)
                        .map(|name| is_internal_protocol_name(&name))
                        .unwrap_or(false) =>
                {
                    prop.key = quote_prop_name(prop.key.clone());
                }
                _ => {}
            }
        }
    }
}

impl VisitMut for ConstantLikePropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_constant_like_property_name(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }

    fn visit_mut_prop_name(&mut self, prop_name: &mut PropName) {
        prop_name.visit_mut_children_with(self);

        let PropName::Ident(ident) = prop_name else {
            return;
        };
        if !is_constant_like_property_name(ident.sym.as_ref()) {
            return;
        }

        *prop_name = PropName::Str(Str {
            span: Default::default(),
            value: ident.sym.to_string().into(),
            raw: None,
        });
    }
}

struct UppercaseStaticMemberCompatVisitor;

impl VisitMut for UppercaseStaticMemberCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let Expr::Ident(object_ident) = &*member.obj else {
            return;
        };
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_component_like_name(object_ident.sym.as_ref())
            || !is_component_like_name(prop_ident.sym.as_ref())
        {
            return;
        }

        member.prop = MemberProp::Computed(swc_core::ecma::ast::ComputedPropName {
            span: Default::default(),
            expr: Box::new(Expr::Lit(Lit::Str(Str {
                span: Default::default(),
                value: prop_ident.sym.to_string().into(),
                raw: None,
            }))),
        });
    }
}

struct DerivedClassMethodKeyCompatVisitor;

impl VisitMut for DerivedClassMethodKeyCompatVisitor {
    fn visit_mut_class(&mut self, class: &mut swc_core::ecma::ast::Class) {
        class.visit_mut_children_with(self);
        if class.super_class.is_none() {
            return;
        }
        for member in &mut class.body {
            match member {
                swc_core::ecma::ast::ClassMember::Method(method) => {
                    method.key = quote_prop_name(method.key.clone());
                }
                swc_core::ecma::ast::ClassMember::PrivateMethod(_) => {}
                swc_core::ecma::ast::ClassMember::ClassProp(prop) => {
                    if !prop.is_static {
                        prop.key = quote_prop_name(prop.key.clone());
                    }
                }
                _ => {}
            }
        }
    }
}

struct CommonJsNamespaceAccessVisitor {
    bindings: HashSet<String>,
}

impl CommonJsNamespaceAccessVisitor {
    fn new(bindings: HashSet<String>) -> Self {
        Self { bindings }
    }
}

impl VisitMut for CommonJsNamespaceAccessVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let Expr::Ident(object_ident) = &*member.obj else {
            return;
        };
        if !self.bindings.contains(object_ident.sym.as_ref()) {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }
}

struct GoogModuleThrowRewriteVisitor;

impl VisitMut for GoogModuleThrowRewriteVisitor {
    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        stmt.visit_mut_children_with(self);

        let Stmt::Throw(throw_stmt) = stmt else {
            return;
        };
        let argument = mem::replace(
            &mut throw_stmt.arg,
            Box::new(Expr::Invalid(Default::default())),
        );
        *stmt = create_throw_iife_statement(argument);
    }
}

fn create_throw_iife_statement(argument: Box<Expr>) -> Stmt {
    let throw_arrow = Expr::Arrow(ArrowExpr {
        span: Default::default(),
        ctxt: Default::default(),
        params: Vec::new(),
        body: Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
            span: Default::default(),
            ctxt: Default::default(),
            stmts: vec![Stmt::Throw(swc_core::ecma::ast::ThrowStmt {
                span: Default::default(),
                arg: argument,
            })],
        })),
        is_async: false,
        is_generator: false,
        return_type: None,
        type_params: None,
    });
    Stmt::Expr(ExprStmt {
        span: Default::default(),
        expr: Box::new(Expr::Call(CallExpr {
            span: Default::default(),
            ctxt: Default::default(),
            callee: Callee::Expr(Box::new(Expr::Paren(swc_core::ecma::ast::ParenExpr {
                span: Default::default(),
                expr: Box::new(throw_arrow),
            }))),
            args: Vec::new(),
            type_args: None,
        })),
    })
}

fn rewrite_commonjs_imports(
    module: &mut Module,
    commonjs_specifiers: &HashSet<String>,
) -> HashSet<String> {
    if commonjs_specifiers.is_empty() {
        return HashSet::new();
    }

    let mut import_counter = 0usize;
    let mut next_body = Vec::with_capacity(module.body.len());
    let mut namespace_bindings = HashSet::new();

    for item in module.body.drain(..) {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) = &item
        else {
            next_body.push(item);
            continue;
        };

        let specifier = import_decl.src.value.to_string_lossy().to_string();
        if !commonjs_specifiers.contains(&specifier) {
            next_body.push(item);
            continue;
        }

        let (rewritten_items, bindings) =
            rewrite_commonjs_import_decl(import_decl, &specifier, &mut import_counter);
        namespace_bindings.extend(bindings);
        if rewritten_items.is_empty() {
            next_body.push(item);
        } else {
            next_body.extend(rewritten_items);
        }
    }

    module.body = next_body;
    namespace_bindings
}

fn rewrite_commonjs_import_decl(
    import_decl: &ImportDecl,
    specifier: &str,
    import_counter: &mut usize,
) -> (Vec<ModuleItem>, HashSet<String>) {
    let mut default_local: Option<String> = None;
    let mut namespace_local: Option<String> = None;
    let mut named_bindings: Vec<(String, String)> = Vec::new();

    for import_specifier in &import_decl.specifiers {
        match import_specifier {
            ImportSpecifier::Default(default_specifier) => {
                default_local = Some(default_specifier.local.sym.to_string());
            }
            ImportSpecifier::Namespace(namespace_specifier) => {
                namespace_local = Some(namespace_specifier.local.sym.to_string());
            }
            ImportSpecifier::Named(named_specifier) => {
                let imported = match &named_specifier.imported {
                    Some(swc_core::ecma::ast::ModuleExportName::Ident(ident)) => {
                        ident.sym.to_string()
                    }
                    Some(swc_core::ecma::ast::ModuleExportName::Str(string)) => {
                        string.value.to_string_lossy().to_string()
                    }
                    None => named_specifier.local.sym.to_string(),
                };
                named_bindings.push((imported, named_specifier.local.sym.to_string()));
            }
        }
    }

    if namespace_local.is_none() && named_bindings.is_empty() {
        return (Vec::new(), HashSet::new());
    }

    let helper_name = default_local.clone().unwrap_or_else(|| {
        let helper = format!("__cjs_import_{import_counter}");
        *import_counter += 1;
        helper
    });

    let mut items = vec![create_default_import_item(&helper_name, specifier)];
    let mut bindings = HashSet::new();
    bindings.insert(helper_name.clone());

    if let Some(namespace_binding) = namespace_local {
        if namespace_binding != helper_name {
            items.push(create_const_alias_item(&namespace_binding, &helper_name));
        }
        bindings.insert(namespace_binding);
    }

    if !named_bindings.is_empty() {
        items.push(create_named_destructure_item(&helper_name, &named_bindings));
    }

    (items, bindings)
}

fn create_default_import_item(local_name: &str, specifier: &str) -> ModuleItem {
    ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(ImportDecl {
        specifiers: vec![ImportSpecifier::Default(ImportDefaultSpecifier {
            local: create_ident(local_name),
            span: Default::default(),
        })],
        src: Box::new(Str {
            span: Default::default(),
            value: specifier.into(),
            raw: None,
        }),
        type_only: false,
        with: None,
        phase: Default::default(),
        span: Default::default(),
    }))
}

fn create_const_alias_item(local_name: &str, target_name: &str) -> ModuleItem {
    ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::Var(Box::new(
        VarDecl {
            kind: VarDeclKind::Const,
            span: Default::default(),
            ctxt: Default::default(),
            declare: false,
            decls: vec![VarDeclarator {
                span: Default::default(),
                definite: false,
                name: Pat::Ident(BindingIdent {
                    id: create_ident(local_name),
                    type_ann: None,
                }),
                init: Some(Box::new(Expr::Ident(create_ident(target_name)))),
            }],
        },
    ))))
}

fn create_named_destructure_item(source_name: &str, bindings: &[(String, String)]) -> ModuleItem {
    ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::Var(Box::new(
        VarDecl {
            kind: VarDeclKind::Const,
            span: Default::default(),
            ctxt: Default::default(),
            declare: false,
            decls: bindings
                .iter()
                .map(|(imported, local)| VarDeclarator {
                    span: Default::default(),
                    definite: false,
                    name: Pat::Ident(BindingIdent {
                        id: create_ident(local),
                        type_ann: None,
                    }),
                    init: Some(Box::new(Expr::Member(MemberExpr {
                        span: Default::default(),
                        obj: Box::new(Expr::Ident(create_ident(source_name))),
                        prop: create_string_computed_prop(imported),
                    }))),
                })
                .collect(),
        },
    ))))
}

pub(super) fn create_ident(value: &str) -> Ident {
    Ident::new(value.into(), Default::default(), Default::default())
}

fn create_rename_property_expr(property_name: &str, object_name: &str) -> Expr {
    create_rename_property_expr_for_object(property_name, Expr::Ident(create_ident(object_name)))
}

fn create_rename_property_expr_for_object(property_name: &str, object_expr: Expr) -> Expr {
    Expr::Call(CallExpr {
        span: Default::default(),
        ctxt: Default::default(),
        callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
            span: Default::default(),
            obj: Box::new(Expr::Member(MemberExpr {
                span: Default::default(),
                obj: Box::new(Expr::Ident(create_ident("goog"))),
                prop: MemberProp::Ident(create_ident("reflect").into()),
            })),
            prop: MemberProp::Ident(create_ident("objectProperty").into()),
        }))),
        args: vec![
            swc_core::ecma::ast::ExprOrSpread {
                spread: None,
                expr: Box::new(Expr::Lit(Lit::Str(Str {
                    span: Default::default(),
                    value: property_name.into(),
                    raw: None,
                }))),
            },
            swc_core::ecma::ast::ExprOrSpread {
                spread: None,
                expr: Box::new(object_expr),
            },
        ],
        type_args: None,
    })
}

#[derive(Default)]
struct ObjectPatternParamVisitor;

impl VisitMut for ObjectPatternParamVisitor {
    fn visit_mut_module_items(&mut self, items: &mut Vec<ModuleItem>) {
        items.visit_mut_children_with(self);

        for item in items {
            let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) =
                item
            else {
                continue;
            };

            match &mut export_decl.decl {
                swc_core::ecma::ast::Decl::Fn(function_decl)
                    if is_component_like_name(function_decl.ident.sym.as_ref()) =>
                {
                    rewrite_function_like_component(&mut function_decl.function);
                }
                swc_core::ecma::ast::Decl::Var(var_decl) => {
                    for declarator in &mut var_decl.decls {
                        let Pat::Ident(binding) = &declarator.name else {
                            continue;
                        };
                        if !is_component_like_name(binding.id.sym.as_ref()) {
                            continue;
                        }
                        if let Some(init) = &mut declarator.init {
                            match &mut **init {
                                Expr::Arrow(arrow) => rewrite_arrow_component(arrow),
                                Expr::Fn(function_expr) => {
                                    rewrite_function_like_component(&mut function_expr.function)
                                }
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        stmt.visit_mut_children_with(self);

        match stmt {
            Stmt::Decl(swc_core::ecma::ast::Decl::Fn(function_decl)) => {
                if is_component_like_name(function_decl.ident.sym.as_ref()) {
                    rewrite_function_like_component(&mut function_decl.function);
                }
            }
            Stmt::Decl(swc_core::ecma::ast::Decl::Var(var_decl)) => {
                for declarator in &mut var_decl.decls {
                    let Pat::Ident(binding) = &declarator.name else {
                        continue;
                    };
                    if !is_component_like_name(binding.id.sym.as_ref()) {
                        continue;
                    }
                    if let Some(init) = &mut declarator.init {
                        match &mut **init {
                            Expr::Arrow(arrow) => rewrite_arrow_component(arrow),
                            Expr::Fn(function_expr) => {
                                rewrite_function_like_component(&mut function_expr.function)
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn is_component_like_name(value: &str) -> bool {
    value
        .chars()
        .next()
        .map(|character| character.is_ascii_uppercase())
        .unwrap_or(false)
}

fn is_constant_like_property_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_uppercase() {
        return false;
    }
    value.chars().all(|character| {
        character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
    })
}

fn rewrite_function_like_component(function: &mut swc_core::ecma::ast::Function) {
    let Some(first_param) = function.params.first_mut() else {
        return;
    };
    let Pat::Object(object_pat) = &first_param.pat else {
        return;
    };

    let props_ident = create_ident("__props");
    let setup_stmts = build_component_prop_setup(object_pat, "__props").unwrap_or_else(|| {
        vec![create_props_destructure_stmt(
            quote_object_pattern_keys(object_pat.clone()),
            &props_ident,
        )]
    });
    first_param.pat = Pat::Ident(BindingIdent {
        id: props_ident.clone(),
        type_ann: None,
    });

    if let Some(body) = &mut function.body {
        body.stmts.splice(0..0, setup_stmts);
    }
}

fn rewrite_arrow_component(arrow: &mut ArrowExpr) {
    let Some(first_param) = arrow.params.first_mut() else {
        return;
    };
    let Pat::Object(object_pat) = first_param else {
        return;
    };

    let props_ident = create_ident("__props");
    let setup_stmts = build_component_prop_setup(object_pat, "__props").unwrap_or_else(|| {
        vec![create_props_destructure_stmt(
            quote_object_pattern_keys(object_pat.clone()),
            &props_ident,
        )]
    });
    *first_param = Pat::Ident(BindingIdent {
        id: props_ident.clone(),
        type_ann: None,
    });

    match &mut *arrow.body {
        BlockStmtOrExpr::BlockStmt(block) => {
            block.stmts.splice(0..0, setup_stmts);
        }
        BlockStmtOrExpr::Expr(expression) => {
            let return_stmt = Stmt::Return(swc_core::ecma::ast::ReturnStmt {
                span: Default::default(),
                arg: Some(expression.clone()),
            });
            arrow.body = Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
                span: Default::default(),
                ctxt: Default::default(),
                stmts: setup_stmts.into_iter().chain([return_stmt]).collect(),
            }));
        }
    }
}

fn create_props_destructure_stmt(
    object_pat: swc_core::ecma::ast::ObjectPat,
    props_ident: &Ident,
) -> Stmt {
    Stmt::Decl(swc_core::ecma::ast::Decl::Var(Box::new(VarDecl {
        kind: VarDeclKind::Const,
        span: Default::default(),
        ctxt: Default::default(),
        declare: false,
        decls: vec![VarDeclarator {
            span: Default::default(),
            definite: false,
            name: Pat::Object(object_pat),
            init: Some(Box::new(Expr::Ident(props_ident.clone()))),
        }],
    })))
}

fn quote_object_pattern_keys(
    object_pat: swc_core::ecma::ast::ObjectPat,
) -> swc_core::ecma::ast::ObjectPat {
    swc_core::ecma::ast::ObjectPat {
        props: object_pat
            .props
            .into_iter()
            .map(|prop| match prop {
                swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                    swc_core::ecma::ast::ObjectPatProp::KeyValue(
                        swc_core::ecma::ast::KeyValuePatProp {
                            key: PropName::Str(Str {
                                span: Default::default(),
                                value: assign.key.sym.to_string().into(),
                                raw: None,
                            }),
                            value: Box::new(match assign.value {
                                Some(value) => Pat::Assign(swc_core::ecma::ast::AssignPat {
                                    span: assign.span,
                                    left: Box::new(Pat::Ident(assign.key)),
                                    right: value,
                                }),
                                None => Pat::Ident(assign.key),
                            }),
                        },
                    )
                }
                swc_core::ecma::ast::ObjectPatProp::KeyValue(mut key_value) => {
                    key_value.key = quote_prop_name(key_value.key);
                    if let Pat::Object(nested) = *key_value.value.clone() {
                        key_value.value = Box::new(Pat::Object(quote_object_pattern_keys(nested)));
                    }
                    swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value)
                }
                other => other,
            })
            .collect(),
        ..object_pat
    }
}

fn build_component_prop_setup(
    object_pat: &swc_core::ecma::ast::ObjectPat,
    props_name: &str,
) -> Option<Vec<Stmt>> {
    let mut statements = Vec::new();
    let mut omitted_keys = Vec::new();
    let mut rest_name: Option<String> = None;

    for prop in &object_pat.props {
        match prop {
            swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                if assign.value.is_some() {
                    return None;
                }
                let key = assign.key.sym.to_string();
                omitted_keys.push(key.clone());
                statements.push(create_component_prop_read_stmt(
                    &assign.key.sym.to_string(),
                    &assign.key.sym.to_string(),
                    props_name,
                ));
            }
            swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                let key = match &key_value.key {
                    PropName::Ident(ident) => ident.sym.to_string(),
                    PropName::Str(value) => value.value.to_string_lossy().to_string(),
                    _ => return None,
                };
                let Pat::Ident(binding) = &*key_value.value else {
                    return None;
                };
                omitted_keys.push(key.clone());
                statements.push(create_component_prop_read_stmt(
                    &key,
                    &binding.id.sym.to_string(),
                    props_name,
                ));
            }
            swc_core::ecma::ast::ObjectPatProp::Rest(rest) => {
                let Pat::Ident(binding) = &*rest.arg else {
                    return None;
                };
                rest_name = Some(binding.id.sym.to_string());
            }
        }
    }

    if let Some(rest_name) = rest_name {
        statements.extend(create_rest_props_stmts(
            &rest_name,
            props_name,
            &omitted_keys,
        )?);
    }

    Some(statements)
}

fn create_component_prop_read_stmt(key: &str, local_name: &str, props_name: &str) -> Stmt {
    Stmt::Decl(swc_core::ecma::ast::Decl::Var(Box::new(VarDecl {
        kind: VarDeclKind::Const,
        span: Default::default(),
        ctxt: Default::default(),
        declare: false,
        decls: vec![VarDeclarator {
            span: Default::default(),
            definite: false,
            name: Pat::Ident(BindingIdent {
                id: create_ident(local_name),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Member(MemberExpr {
                span: Default::default(),
                obj: Box::new(Expr::Ident(create_ident(props_name))),
                prop: MemberProp::Computed(swc_core::ecma::ast::ComputedPropName {
                    span: Default::default(),
                    expr: Box::new(create_rename_property_expr(key, props_name)),
                }),
            }))),
        }],
    })))
}

fn create_rest_props_stmts(
    rest_name: &str,
    props_name: &str,
    omitted_keys: &[String],
) -> Option<Vec<Stmt>> {
    let conditions = omitted_keys
        .iter()
        .map(|key| format!("key !== goog.reflect.objectProperty({key:?}, {props_name})"))
        .collect::<Vec<_>>()
        .join(" && ");
    let guard = if conditions.is_empty() {
        "true".to_string()
    } else {
        conditions
    };
    let snippet = format!(
        "const {rest_name} = /** @dict */ ({{}});\nfor (const key in {props_name}) {{ if ({guard}) {rest_name}[key] = {props_name}[key]; }}"
    );
    let items = parse_module_items(&snippet).ok()?;
    let mut statements = Vec::with_capacity(items.len());
    for item in items {
        let ModuleItem::Stmt(statement) = item else {
            return None;
        };
        statements.push(statement);
    }
    Some(statements)
}

pub(super) fn quote_prop_name(prop_name: PropName) -> PropName {
    match prop_name {
        PropName::Ident(ident) => PropName::Str(Str {
            span: Default::default(),
            value: ident.sym.to_string().into(),
            raw: None,
        }),
        PropName::Num(number) => PropName::Str(Str {
            span: Default::default(),
            value: number.value.to_string().into(),
            raw: None,
        }),
        other => other,
    }
}

