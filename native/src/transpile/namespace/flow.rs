use super::*;

pub(crate) fn rewrite_bundler_runtime_namespace_usage(
    module: &mut Module,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<(), String> {
    let dynamic_import_wrappers = collect_dynamic_import_wrappers(module);
    let promise_carriers =
        collect_dynamic_import_promise_carriers(module, &dynamic_import_wrappers);
    let mut visitor = BundlerRuntimeNamespaceVisitor::new(
        file_path,
        context,
        dynamic_import_wrappers,
        promise_carriers,
    );
    module.visit_mut_with(&mut visitor);
    if visitor.errors.is_empty() {
        Ok(())
    } else {
        Err(visitor.errors.join("\n"))
    }
}

struct BundlerRuntimeNamespaceVisitor<'a> {
    context: &'a TranspileContext,
    dynamic_import_wrappers: DynamicImportWrappers,
    errors: Vec<String>,
    file_path: String,
    namespace_bindings: HashMap<Id, BTreeSet<String>>,
    promise_carriers: HashMap<Id, BTreeSet<String>>,
}

impl<'a> BundlerRuntimeNamespaceVisitor<'a> {
    fn new(
        file_path: &Path,
        context: &'a TranspileContext,
        dynamic_import_wrappers: DynamicImportWrappers,
        promise_carriers: HashMap<Id, BTreeSet<String>>,
    ) -> Self {
        Self {
            context,
            dynamic_import_wrappers,
            errors: Vec::new(),
            file_path: file_path.display().to_string(),
            namespace_bindings: HashMap::new(),
            promise_carriers,
        }
    }

    fn push_error(&mut self, message: impl Into<String>) {
        self.errors
            .push(format!("{}: {}", self.file_path, message.into()));
    }

    fn module_ids_for_promise_expr(&self, expr: &Expr) -> Option<BTreeSet<String>> {
        match expr {
            Expr::Ident(ident) => self.promise_carriers.get(&ident.to_id()).cloned(),
            Expr::Call(call_expr) => {
                if let Some(module_ids) = dynamic_import_module_ids_from_call(call_expr) {
                    return Some(module_ids);
                }
                let Callee::Expr(callee_expr) = &call_expr.callee else {
                    return None;
                };
                match &**callee_expr {
                    Expr::Ident(ident) if call_expr.args.is_empty() => self
                        .dynamic_import_wrappers
                        .function_wrappers
                        .get(&ident.to_id())
                        .cloned(),
                    Expr::Member(member) if call_expr.args.is_empty() => {
                        let Expr::Ident(object_ident) = &*member.obj else {
                            return None;
                        };
                        let wrapper_map = self
                            .dynamic_import_wrappers
                            .object_wrappers
                            .get(&object_ident.to_id())?;
                        let prop_name = member_prop_name(&member.prop);
                        if let Some(prop_name) = prop_name {
                            wrapper_map.get(&prop_name).cloned()
                        } else {
                            let mut module_ids = BTreeSet::new();
                            for ids in wrapper_map.values() {
                                module_ids.extend(ids.iter().cloned());
                            }
                            (!module_ids.is_empty()).then_some(module_ids)
                        }
                    }
                    _ if call_expr.args.len() == 1 => {
                        let Expr::Ident(carrier_ident) = &*call_expr.args[0].expr else {
                            return None;
                        };
                        self.promise_carriers.get(&carrier_ident.to_id()).cloned()
                    }
                    _ => None,
                }
            }
            Expr::Paren(paren) => self.module_ids_for_promise_expr(&paren.expr),
            _ => None,
        }
    }

    fn module_ids_for_namespace_expr(&self, expr: &Expr) -> Option<BTreeSet<String>> {
        match expr {
            Expr::Ident(ident) => self.namespace_bindings.get(&ident.to_id()).cloned(),
            Expr::Await(await_expr) => self.module_ids_for_promise_expr(&await_expr.arg),
            Expr::Call(call_expr) if call_expr.args.len() == 1 => {
                let Expr::Ident(binding_ident) = &*call_expr.args[0].expr else {
                    return None;
                };
                self.namespace_bindings.get(&binding_ident.to_id()).cloned()
            }
            Expr::Paren(paren) => self.module_ids_for_namespace_expr(&paren.expr),
            _ => None,
        }
    }

    fn slot_for_module_ids(
        &self,
        module_ids: &BTreeSet<String>,
        export_name: &str,
    ) -> std::result::Result<usize, String> {
        let mut resolved_slot = None::<usize>;
        for module_id in module_ids {
            let logical_module_id = self
                .context
                .bundler_runtime_logical_ids
                .get(module_id)
                .map(|value| value.as_str())
                .unwrap_or(module_id.as_str());
            let Some(slots) = self.context.bundler_module_slots.get(logical_module_id) else {
                return Err(format!(
                    "Missing bundler-runtime export slot metadata for {}",
                    module_id
                ));
            };
            let Some(slot) = slots.slot_for(export_name) else {
                return Err(format!(
                    "bundler-runtime cannot rewrite namespace access for export {:?} from {}",
                    export_name, module_id
                ));
            };
            if let Some(existing_slot) = resolved_slot {
                if existing_slot != slot {
                    return Err(format!(
                        "bundler-runtime cannot rewrite namespace access for export {:?} because slot assignments diverge across dynamic import targets",
                        export_name
                    ));
                }
            } else {
                resolved_slot = Some(slot);
            }
        }
        resolved_slot.ok_or_else(|| "Missing bundler-runtime namespace slots".to_string())
    }

    fn rewrite_namespace_pattern(
        &mut self,
        pattern: &mut Pat,
        module_ids: &BTreeSet<String>,
    ) -> bool {
        match pattern {
            Pat::Ident(binding) => {
                self.namespace_bindings
                    .insert(binding.id.to_id(), module_ids.clone());
                true
            }
            Pat::Object(object) => {
                for prop in &mut object.props {
                    match prop {
                        swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                            let Some(export_name) = prop_name_to_string(&key_value.key) else {
                                self.push_error(
                                    "bundler-runtime only supports literal namespace destructuring keys",
                                );
                                return false;
                            };
                            let Ok(slot) = self.slot_for_module_ids(module_ids, &export_name)
                            else {
                                self.push_error(format!(
                                    "bundler-runtime cannot destructure namespace export {:?}",
                                    export_name
                                ));
                                return false;
                            };
                            key_value.key = PropName::Num(swc_core::ecma::ast::Number {
                                span: Default::default(),
                                value: slot as f64,
                                raw: None,
                            });
                        }
                        swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                            let export_name = assign.key.sym.to_string();
                            let Ok(slot) = self.slot_for_module_ids(module_ids, &export_name)
                            else {
                                self.push_error(format!(
                                    "bundler-runtime cannot destructure namespace export {:?}",
                                    export_name
                                ));
                                return false;
                            };
                            *prop = swc_core::ecma::ast::ObjectPatProp::KeyValue(
                                swc_core::ecma::ast::KeyValuePatProp {
                                    key: PropName::Num(swc_core::ecma::ast::Number {
                                        span: Default::default(),
                                        value: slot as f64,
                                        raw: None,
                                    }),
                                    value: Box::new(Pat::Ident(BindingIdent {
                                        id: assign.key.clone().into(),
                                        type_ann: None,
                                    })),
                                },
                            );
                        }
                        swc_core::ecma::ast::ObjectPatProp::Rest(_) => {
                            self.push_error(
                                "bundler-runtime does not support namespace rest destructuring",
                            );
                            return false;
                        }
                    }
                }
                true
            }
            _ => {
                self.push_error(
                    "bundler-runtime only supports identifier and object destructuring for namespace values",
                );
                false
            }
        }
    }

    fn promise_module_ids_from_supplier_callback(&self, expr: &Expr) -> Option<BTreeSet<String>> {
        match expr {
            Expr::Arrow(arrow) if arrow.params.is_empty() => match &*arrow.body {
                BlockStmtOrExpr::Expr(body_expr) => self.module_ids_for_promise_expr(body_expr),
                BlockStmtOrExpr::BlockStmt(block) => {
                    if block.stmts.len() != 1 {
                        return None;
                    }
                    let Stmt::Return(return_stmt) = &block.stmts[0] else {
                        return None;
                    };
                    let argument = return_stmt.arg.as_deref()?;
                    self.module_ids_for_promise_expr(argument)
                }
            },
            Expr::Fn(function_expr) if function_expr.function.params.is_empty() => {
                let body = function_expr.function.body.as_ref()?;
                if body.stmts.len() != 1 {
                    return None;
                }
                let Stmt::Return(return_stmt) = &body.stmts[0] else {
                    return None;
                };
                let argument = return_stmt.arg.as_deref()?;
                self.module_ids_for_promise_expr(argument)
            }
            _ => None,
        }
    }

    fn visit_callback_expr_with_namespace_binding(
        &mut self,
        expr: &mut Expr,
        module_ids: &BTreeSet<String>,
        bind_first_param: bool,
    ) {
        match expr {
            Expr::Arrow(arrow) => {
                let target_pattern = if bind_first_param {
                    arrow.params.first_mut()
                } else {
                    arrow.params.last_mut()
                };
                let Some(target_pattern) = target_pattern else {
                    expr.visit_mut_with(self);
                    return;
                };
                let mut inserted = Vec::new();
                if let Pat::Ident(binding) = target_pattern {
                    let binding_id = binding.id.to_id();
                    self.namespace_bindings
                        .insert(binding_id.clone(), module_ids.clone());
                    inserted.push(binding_id);
                } else if !self.rewrite_namespace_pattern(target_pattern, module_ids) {
                    return;
                }
                match &mut *arrow.body {
                    BlockStmtOrExpr::Expr(body_expr) => body_expr.visit_mut_with(self),
                    BlockStmtOrExpr::BlockStmt(block) => block.visit_mut_with(self),
                }
                for binding_id in inserted {
                    self.namespace_bindings.remove(&binding_id);
                }
            }
            Expr::Fn(function_expr) => {
                let target_param = if bind_first_param {
                    function_expr.function.params.first_mut()
                } else {
                    function_expr.function.params.last_mut()
                };
                let Some(target_param) = target_param else {
                    expr.visit_mut_with(self);
                    return;
                };
                let mut inserted = Vec::new();
                if let Pat::Ident(binding) = &mut target_param.pat {
                    let binding_id = binding.id.to_id();
                    self.namespace_bindings
                        .insert(binding_id.clone(), module_ids.clone());
                    inserted.push(binding_id);
                } else if !self.rewrite_namespace_pattern(&mut target_param.pat, module_ids) {
                    return;
                }
                if let Some(body) = &mut function_expr.function.body {
                    body.visit_mut_with(self);
                }
                for binding_id in inserted {
                    self.namespace_bindings.remove(&binding_id);
                }
            }
            _ => expr.visit_mut_with(self),
        }
    }
}

impl VisitMut for BundlerRuntimeNamespaceVisitor<'_> {
    fn visit_mut_module_item(&mut self, item: &mut ModuleItem) {
        if let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) = item {
            let module_id = resolve_module_id_for_specifier(
                Path::new(&self.file_path),
                &import_decl.src.value.to_string_lossy(),
                self.context,
            );
            if let Ok(module_id) = module_id {
                for specifier in &import_decl.specifiers {
                    if let ImportSpecifier::Namespace(namespace_specifier) = specifier {
                        self.namespace_bindings.insert(
                            namespace_specifier.local.to_id(),
                            BTreeSet::from([module_id.clone()]),
                        );
                    }
                }
            }
        }
        item.visit_mut_children_with(self);
    }

    fn visit_mut_var_declarator(&mut self, declarator: &mut VarDeclarator) {
        declarator.visit_mut_children_with(self);

        let Some(init) = declarator.init.as_deref() else {
            return;
        };
        if let Some(module_ids) = self.module_ids_for_namespace_expr(init) {
            let _ = self.rewrite_namespace_pattern(&mut declarator.name, &module_ids);
            return;
        }
        let Some(module_ids) = self.module_ids_for_promise_expr(init) else {
            return;
        };
        let Pat::Ident(binding) = &declarator.name else {
            self.push_error(
                "bundler-runtime only supports binding promise-like import values to identifiers",
            );
            return;
        };
        self.promise_carriers.insert(binding.id.to_id(), module_ids);
    }

    fn visit_mut_member_expr(&mut self, member_expr: &mut MemberExpr) {
        member_expr.obj.visit_mut_with(self);
        match &mut member_expr.prop {
            MemberProp::Computed(computed) => {
                computed.visit_mut_with(self);
            }
            MemberProp::PrivateName(_) => {}
            MemberProp::Ident(_) => {}
        }

        let Some(module_ids) = self.module_ids_for_namespace_expr(&member_expr.obj) else {
            return;
        };

        let Some(export_name) = member_prop_name(&member_expr.prop) else {
            self.push_error("bundler-runtime does not support computed namespace property access");
            return;
        };
        let slot = match self.slot_for_module_ids(&module_ids, &export_name) {
            Ok(slot) => slot,
            Err(message) => {
                self.push_error(message);
                return;
            }
        };
        member_expr.prop = MemberProp::Computed(swc_core::ecma::ast::ComputedPropName {
            span: Default::default(),
            expr: Box::new(Expr::Lit(Lit::Num(swc_core::ecma::ast::Number {
                span: Default::default(),
                value: slot as f64,
                raw: None,
            }))),
        });
    }

    fn visit_mut_call_expr(&mut self, call_expr: &mut CallExpr) {
        let promise_from_then = if let Callee::Expr(callee_expr) = &call_expr.callee {
            if let Expr::Member(member) = &**callee_expr {
                if matches!(member_prop_name(&member.prop).as_deref(), Some("then")) {
                    self.module_ids_for_promise_expr(&member.obj)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        let promise_source_indices = call_expr
            .args
            .iter()
            .enumerate()
            .filter_map(|(index, arg)| {
                self.promise_module_ids_from_supplier_callback(&arg.expr)
                    .map(|module_ids| (index, module_ids))
            })
            .collect::<Vec<_>>();

        match &mut call_expr.callee {
            Callee::Expr(expr) => expr.visit_mut_with(self),
            _ => {}
        }
        for (index, arg) in call_expr.args.iter_mut().enumerate() {
            if index == 0 {
                if let Some(module_ids) = &promise_from_then {
                    self.visit_callback_expr_with_namespace_binding(
                        &mut arg.expr,
                        module_ids,
                        true,
                    );
                    continue;
                }
            }
            if let Some((_, module_ids)) = promise_source_indices
                .iter()
                .find(|(source_index, _)| *source_index != index)
            {
                self.visit_callback_expr_with_namespace_binding(&mut arg.expr, module_ids, false);
                continue;
            }
            arg.expr.visit_mut_with(self);
        }

        if let Callee::Expr(callee_expr) = &call_expr.callee {
            if let Expr::Member(member) = &**callee_expr {
                if matches!(&*member.obj, Expr::Ident(object_ident) if object_ident.sym == *"Object")
                {
                    if let Some(method_name) = member_prop_name(&member.prop) {
                        if matches!(
                            method_name.as_str(),
                            "assign" | "entries" | "keys" | "values"
                        ) {
                            if call_expr.args.iter().any(|arg| {
                                matches!(&*arg.expr, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id()))
                            }) {
                                self.push_error(
                                    "bundler-runtime does not support reflective Object.* operations on module namespace values",
                                );
                            }
                        }
                    }
                }
            }
        }

        let is_namespace_passthrough_call = call_expr.args.len() == 1
            && matches!(
                &*call_expr.args[0].expr,
                Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id())
            );
        if !is_namespace_passthrough_call
            && call_expr.args.iter().any(|arg| {
                matches!(&*arg.expr, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id()))
            })
        {
            self.push_error(
                "bundler-runtime does not support passing module namespace values to calls",
            );
        }
    }

    fn visit_mut_return_stmt(&mut self, return_stmt: &mut swc_core::ecma::ast::ReturnStmt) {
        return_stmt.visit_mut_children_with(self);
        if let Some(argument) = &return_stmt.arg {
            if matches!(&**argument, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id()))
            {
                self.push_error(
                    "bundler-runtime does not support returning module namespace values",
                );
            }
        }
    }

    fn visit_mut_assign_expr(&mut self, assign_expr: &mut swc_core::ecma::ast::AssignExpr) {
        assign_expr.visit_mut_children_with(self);
        if let Some(module_ids) = self.module_ids_for_promise_expr(&assign_expr.right) {
            if let swc_core::ecma::ast::AssignTarget::Simple(
                swc_core::ecma::ast::SimpleAssignTarget::Ident(binding),
            ) = &assign_expr.left
            {
                self.promise_carriers.insert(binding.id.to_id(), module_ids);
                return;
            }
        }
        if matches!(&*assign_expr.right, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id()))
        {
            self.push_error(
                "bundler-runtime does not support reassigning or storing module namespace values",
            );
        }
    }

    fn visit_mut_for_in_stmt(&mut self, for_in_stmt: &mut swc_core::ecma::ast::ForInStmt) {
        for_in_stmt.visit_mut_children_with(self);
        if matches!(&*for_in_stmt.right, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id()))
        {
            self.push_error(
                "bundler-runtime does not support iterating over module namespace values",
            );
        }
    }
}
