use super::*;

/// Producer side of the CommonJS export ABI.
///
/// `quoted` is the shared verdict from `cjs_opacity::OpaqueCommonJs`, not a
/// local choice: the two consumer sites read the same value for the same
/// package, because quoting one side while another renames resolves to
/// `undefined` at runtime.
pub(super) struct CommonJsRewriteVisitor {
    module_exports_expr: Box<Expr>,
    quoted: bool,
    require_bindings: HashMap<String, String>,
    commonjs_object_bindings: HashSet<String>,
}

impl CommonJsRewriteVisitor {
    pub(super) fn new(
        require_bindings: HashMap<String, String>,
        quoted: bool,
    ) -> std::result::Result<Self, String> {
        let commonjs_object_bindings = require_bindings.values().cloned().collect::<HashSet<_>>();
        Ok(Self {
            module_exports_expr: parse_expr("module[\"exports\"]")?,
            quoted,
            require_bindings,
            commonjs_object_bindings,
        })
    }
}

impl VisitMut for CommonJsRewriteVisitor {
    fn visit_mut_assign_expr(&mut self, expression: &mut swc_core::ecma::ast::AssignExpr) {
        expression.visit_mut_children_with(self);

        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Member(member),
        ) = &mut expression.left
        else {
            return;
        };

        // The `exports` slot on the scratch `module` object is always quoted,
        // independently of the export-name verdict: `var module = {}` types the
        // object as empty, and a dotted write to it is a checkTypes mismatch.
        // Only the names *inside* the export object follow the verdict.
        if is_module_exports_member_expr(member) {
            quote_commonjs_export_member(member);
            return;
        }
        if !self.quoted {
            return;
        }
        if is_commonjs_export_member_expr(member) {
            quote_commonjs_export_member(member);
            if let Expr::Object(object) = &mut *expression.right {
                quote_commonjs_export_object(object);
            }
        }
    }

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        match expr {
            // The export slot is spelled the same way everywhere, whatever the
            // export-name verdict is: see `visit_mut_assign_expr`.
            Expr::Member(member_expr) if is_module_exports_member_expr(member_expr) => {
                quote_commonjs_export_member(member_expr);
            }
            Expr::Member(member_expr)
                if self.quoted
                    && !member_expr.prop.is_computed()
                    && matches!(&*member_expr.obj, Expr::Ident(ident) if self.commonjs_object_bindings.contains(ident.sym.as_ref())) =>
            {
                if let MemberProp::Ident(ident) = &member_expr.prop {
                    member_expr.prop = create_string_computed_prop(ident.sym.as_ref());
                }
            }
            Expr::Member(member_expr)
                if self.quoted && is_commonjs_export_member_expr(member_expr) =>
            {
                quote_commonjs_export_member(member_expr);
            }
            Expr::Call(call_expr) => {
                if let Some(specifier) = require_call_specifier(call_expr) {
                    if let Some(binding_name) = self.require_bindings.get(&specifier) {
                        *expr =
                            *parse_expr(binding_name).expect("valid require binding identifier");
                    }
                }
            }
            Expr::Ident(ident) if ident.sym == *"exports" => {
                *expr = *self.module_exports_expr.clone();
            }
            _ => {}
        }
    }

    fn visit_mut_var_declarator(&mut self, declarator: &mut VarDeclarator) {
        declarator.visit_mut_children_with(self);

        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(init) = &declarator.init else {
            return;
        };
        let Expr::Ident(ident) = &**init else {
            return;
        };
        if self.commonjs_object_bindings.contains(ident.sym.as_ref()) {
            self.commonjs_object_bindings
                .insert(binding.id.sym.to_string());
        }
    }

    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        stmt.visit_mut_children_with(self);

        match stmt {
            Stmt::Expr(ExprStmt { expr, .. }) => {
                if matches!(&**expr, Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) if value.value == *"use strict")
                {
                    *stmt = Stmt::Empty(EmptyStmt {
                        span: Default::default(),
                    });
                    return;
                }

                if matches!(&**expr, Expr::Call(call_expr) if object_define_property_es_module(call_expr))
                {
                    *stmt = Stmt::Empty(EmptyStmt {
                        span: Default::default(),
                    });
                }
            }
            Stmt::If(if_stmt) => match evaluate_boolean_expr(&if_stmt.test) {
                Some(true) => {
                    *stmt = *if_stmt.cons.clone();
                }
                Some(false) => {
                    *stmt = if_stmt
                        .alt
                        .as_ref()
                        .map(|alt| *alt.clone())
                        .unwrap_or(Stmt::Empty(EmptyStmt {
                            span: Default::default(),
                        }));
                }
                None => {}
            },
            _ => {}
        }
    }
}

pub(super) fn is_commonjs_export_member_expr(member_expr: &MemberExpr) -> bool {
    matches!(
        &*member_expr.obj,
        Expr::Ident(ident) if ident.sym == *"exports"
    ) || matches!(
        &*member_expr.obj,
        Expr::Member(member) if is_module_exports_member_expr(member)
    )
}

pub(super) fn quote_commonjs_export_member(member_expr: &mut MemberExpr) {
    if let MemberProp::Ident(ident) = &member_expr.prop {
        member_expr.prop = create_string_computed_prop(ident.sym.as_ref());
    }
}

pub(super) fn quote_commonjs_export_object(object: &mut swc_core::ecma::ast::ObjectLit) {
    for property in &mut object.props {
        let swc_core::ecma::ast::PropOrSpread::Prop(prop) = property else {
            continue;
        };
        match &mut **prop {
            swc_core::ecma::ast::Prop::KeyValue(key_value) => {
                key_value.key = quote_commonjs_prop_name(key_value.key.clone());
            }
            swc_core::ecma::ast::Prop::Shorthand(ident) => {
                let key = quote_commonjs_prop_name(PropName::Ident(ident.clone().into()));
                **prop = swc_core::ecma::ast::Prop::KeyValue(swc_core::ecma::ast::KeyValueProp {
                    key,
                    value: Box::new(Expr::Ident(ident.clone())),
                });
            }
            _ => {}
        }
    }
}

pub(super) fn quote_commonjs_prop_name(prop_name: PropName) -> PropName {
    match prop_name {
        PropName::Ident(ident) => {
            PropName::Computed(create_string_computed_name(ident.sym.as_ref()))
        }
        PropName::Num(number) => {
            PropName::Computed(create_string_computed_name(&number.value.to_string()))
        }
        other => other,
    }
}

pub(super) fn create_string_computed_prop(property_name: &str) -> MemberProp {
    MemberProp::Computed(create_string_computed_name(property_name))
}

pub(super) fn create_string_computed_super_prop(property_name: &str) -> SuperProp {
    SuperProp::Computed(create_string_computed_name(property_name))
}

pub(super) fn create_string_computed_name(
    property_name: &str,
) -> swc_core::ecma::ast::ComputedPropName {
    swc_core::ecma::ast::ComputedPropName {
        span: Default::default(),
        expr: Box::new(Expr::Lit(Lit::Str(Str {
            span: Default::default(),
            value: property_name.into(),
            raw: None,
        }))),
    }
}

/// Recognises the export slot in either spelling. The rewriter canonicalises
/// `exports` to `module["exports"]`, so a recogniser that only matched the
/// dotted form would stop seeing the slot the moment it had been rewritten.
pub(super) fn is_module_exports_member_expr(member_expr: &MemberExpr) -> bool {
    if !matches!(&*member_expr.obj, Expr::Ident(module_ident) if module_ident.sym == *"module") {
        return false;
    }
    match &member_expr.prop {
        MemberProp::Ident(exports_ident) => exports_ident.sym == *"exports",
        MemberProp::Computed(computed) => {
            matches!(&*computed.expr, Expr::Lit(Lit::Str(value)) if value.value == *"exports")
        }
        MemberProp::PrivateName(_) => false,
    }
}

pub(super) fn parse_expr(source: &str) -> std::result::Result<Box<Expr>, String> {
    let mut items = parse_module_items(&format!("{source};"))?;
    let Some(ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. }))) = items.pop() else {
        return Err("Expected expression snippet".to_string());
    };
    Ok(expr)
}

pub(super) fn object_define_property_es_module(call_expr: &CallExpr) -> bool {
    let Callee::Expr(callee) = &call_expr.callee else {
        return false;
    };
    let Expr::Member(member) = &**callee else {
        return false;
    };
    let MemberProp::Ident(ident) = &member.prop else {
        return false;
    };
    if ident.sym != *"defineProperty" || call_expr.args.len() < 2 {
        return false;
    }
    matches!(&*member.obj, Expr::Ident(object_ident) if object_ident.sym == *"Object")
        && matches!(&*call_expr.args[0].expr, Expr::Ident(exports_ident) if exports_ident.sym == *"exports")
        && matches!(&*call_expr.args[1].expr, Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) if value.value == *"__esModule")
}

pub(super) fn require_call_specifier(expression: &CallExpr) -> Option<String> {
    let Callee::Expr(callee) = &expression.callee else {
        return None;
    };
    let Expr::Ident(ident) = &**callee else {
        return None;
    };
    if ident.sym != *"require" || expression.args.len() != 1 {
        return None;
    }

    match &*expression.args[0].expr {
        Expr::Lit(swc_core::ecma::ast::Lit::Str(string)) => {
            Some(string.value.to_string_lossy().to_string())
        }
        Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => {
            Some(template.quasis[0].raw.to_string())
        }
        _ => None,
    }
}
