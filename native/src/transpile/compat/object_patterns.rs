use super::*;

pub(crate) struct ObjectPatternParamVisitor {
    fresh_names: FreshNameAllocator,
}

impl ObjectPatternParamVisitor {
    pub(crate) fn new(fresh_names: FreshNameAllocator) -> Self {
        Self { fresh_names }
    }
}
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
                    rewrite_function_like_component(
                        &mut function_decl.function,
                        &mut self.fresh_names,
                    );
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
                                Expr::Arrow(arrow) => {
                                    rewrite_arrow_component(arrow, &mut self.fresh_names)
                                }
                                Expr::Fn(function_expr) => rewrite_function_like_component(
                                    &mut function_expr.function,
                                    &mut self.fresh_names,
                                ),
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
                    rewrite_function_like_component(
                        &mut function_decl.function,
                        &mut self.fresh_names,
                    );
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
                            Expr::Arrow(arrow) => {
                                rewrite_arrow_component(arrow, &mut self.fresh_names)
                            }
                            Expr::Fn(function_expr) => rewrite_function_like_component(
                                &mut function_expr.function,
                                &mut self.fresh_names,
                            ),
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

fn rewrite_function_like_component(
    function: &mut swc_core::ecma::ast::Function,
    fresh_names: &mut FreshNameAllocator,
) {
    let Some(first_param) = function.params.first_mut() else {
        return;
    };
    let Pat::Object(object_pat) = &first_param.pat else {
        return;
    };

    let props_ident = create_ident(&fresh_names.fresh("__props"));
    let setup_stmts = build_component_prop_setup(object_pat, props_ident.sym.as_ref())
        .unwrap_or_else(|| {
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

fn rewrite_arrow_component(arrow: &mut ArrowExpr, fresh_names: &mut FreshNameAllocator) {
    let Some(first_param) = arrow.params.first_mut() else {
        return;
    };
    let Pat::Object(object_pat) = first_param else {
        return;
    };

    let props_ident = create_ident(&fresh_names.fresh("__props"));
    let setup_stmts = build_component_prop_setup(object_pat, props_ident.sym.as_ref())
        .unwrap_or_else(|| {
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
            *arrow.body = BlockStmtOrExpr::BlockStmt(BlockStmt {
                span: Default::default(),
                ctxt: Default::default(),
                stmts: setup_stmts.into_iter().chain([return_stmt]).collect(),
            });
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
                    assign.key.sym.as_ref(),
                    assign.key.sym.as_ref(),
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
                    binding.id.sym.as_ref(),
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
