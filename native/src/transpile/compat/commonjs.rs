use super::*;

/// Consumer side of the CommonJS export ABI: rewrites `ns.foo` on a binding
/// that resolves to a CommonJS module's export object.
///
/// This is the construct that keeps every CommonJS export name in the program
/// un-renameable (react-spa: 72 of 89 invalidation suspects, 2,493 of 2,792
/// cost units). It exists only because the producer writes literal keys, so
/// the two sides are governed by one predicate,
/// `cjs_opacity::OpaqueCommonJs` — see its doc comment for why they can never
/// disagree.
pub(crate) struct CommonJsNamespaceAccessVisitor {
    bindings: BindingKeySet,
}

impl CommonJsNamespaceAccessVisitor {
    pub(crate) fn new(bindings: BindingKeySet) -> Self {
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
        if !self.bindings.contains(&BindingKey::of(&object_ident)) {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }
}

pub(crate) struct GoogModuleThrowRewriteVisitor;

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

pub(crate) fn rewrite_commonjs_imports(
    module: &mut Module,
    commonjs_specifiers: &HashSet<String>,
    opaque_commonjs: &OpaqueCommonJs,
    fresh_names: &mut FreshNameAllocator,
) -> BindingKeySet {
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

        // One decision, consulted here for both consumer sites: the quoted
        // destructure keys below and the `CommonJsNamespaceAccessVisitor`
        // bindings this function returns.
        let quoted = opaque_commonjs.specifier_is_opaque(&specifier);
        let (rewritten_items, bindings) = rewrite_commonjs_import_decl(
            import_decl,
            &specifier,
            quoted,
            &mut import_counter,
            fresh_names,
        );
        if quoted {
            namespace_bindings.extend(bindings);
        }
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
    quoted: bool,
    import_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
) -> (Vec<ModuleItem>, BindingKeySet) {
    let mut default_local: Option<Ident> = None;
    let mut namespace_local: Option<Ident> = None;
    let mut named_bindings: Vec<(String, Ident)> = Vec::new();

    for import_specifier in &import_decl.specifiers {
        match import_specifier {
            ImportSpecifier::Default(default_specifier) => {
                default_local = Some(default_specifier.local.clone());
            }
            ImportSpecifier::Namespace(namespace_specifier) => {
                namespace_local = Some(namespace_specifier.local.clone());
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
                named_bindings.push((imported, named_specifier.local.clone()));
            }
        }
    }

    if namespace_local.is_none() && named_bindings.is_empty() {
        // Default-only import (`import React from "react"`): the declaration
        // needs no rewrite, but the binding must still join the quoted set —
        // CommonJS namespace properties are literal keys, so a renamable
        // `React.forwardRef` read would miss them (the react-spa breakage).
        return (
            Vec::new(),
            default_local
                .into_iter()
                .map(|ident| BindingKey::of(&ident))
                .collect::<HashSet<_>>(),
        );
    }

    let helper_ident = default_local.clone().unwrap_or_else(|| {
        let preferred = format!("__cjs_import_{}", *import_counter);
        *import_counter += 1;
        create_ident(&fresh_names.fresh(&preferred))
    });

    let mut items = vec![create_default_import_item(&helper_ident, specifier)];
    let mut bindings = HashSet::new();
    bindings.insert(BindingKey::of(&helper_ident));

    if let Some(namespace_binding) = namespace_local {
        if BindingKey::of(&namespace_binding) != BindingKey::of(&helper_ident) {
            items.push(create_const_alias_item(&namespace_binding, &helper_ident));
        }
        bindings.insert(BindingKey::of(&namespace_binding));
    }

    if !named_bindings.is_empty() {
        items.push(create_named_destructure_item(
            &helper_ident,
            &named_bindings,
            quoted,
        ));
    }

    (items, bindings)
}

fn create_default_import_item(local: &Ident, specifier: &str) -> ModuleItem {
    ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(ImportDecl {
        specifiers: vec![ImportSpecifier::Default(ImportDefaultSpecifier {
            local: local.clone(),
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

fn create_const_alias_item(local: &Ident, target: &Ident) -> ModuleItem {
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
                    id: local.clone(),
                    type_ann: None,
                }),
                init: Some(Box::new(Expr::Ident(target.clone()))),
            }],
        },
    ))))
}

fn create_named_destructure_item(
    source: &Ident,
    bindings: &[(String, Ident)],
    quoted: bool,
) -> ModuleItem {
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
                        id: local.clone(),
                        type_ann: None,
                    }),
                    init: Some(Box::new(Expr::Member(MemberExpr {
                        span: Default::default(),
                        obj: Box::new(Expr::Ident(source.clone())),
                        // Third access site on the same ABI as the producer
                        // and `CommonJsNamespaceAccessVisitor`; all three read
                        // one predicate so a name is never quoted on one side
                        // and renamed on another.
                        prop: if quoted {
                            create_string_computed_prop(imported)
                        } else {
                            MemberProp::Ident(create_ident(imported).into())
                        },
                    }))),
                })
                .collect(),
        },
    ))))
}

pub(crate) fn create_ident(value: &str) -> Ident {
    Ident::new(value.into(), Default::default(), Default::default())
}

pub(crate) fn create_rename_property_expr(property_name: &str, object_name: &str) -> Expr {
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
