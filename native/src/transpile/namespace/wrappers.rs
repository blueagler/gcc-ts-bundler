use super::*;

#[derive(Clone, Debug, Default)]
pub(super) struct DynamicImportWrappers {
    pub(super) function_wrappers: HashMap<Id, BTreeSet<String>>,
    pub(super) object_wrappers: HashMap<Id, BTreeMap<String, BTreeSet<String>>>,
}

pub(super) fn resolve_dynamic_import_module_ids(
    expr: &Expr,
    carriers: &HashMap<Id, BTreeSet<String>>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<BTreeSet<String>> {
    match expr {
        Expr::Ident(ident) => carriers.get(&ident.to_id()).cloned(),
        Expr::Call(call_expr) => {
            resolve_dynamic_import_call_module_ids(call_expr, carriers, dynamic_import_wrappers)
        }
        Expr::Paren(paren) => {
            resolve_dynamic_import_module_ids(&paren.expr, carriers, dynamic_import_wrappers)
        }
        _ => None,
    }
}

pub(super) fn collect_dynamic_import_promise_carriers(
    module: &Module,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> HashMap<Id, BTreeSet<String>> {
    let mut collector = PromiseCarrierCollector {
        carriers: HashMap::new(),
        dynamic_import_wrappers: dynamic_import_wrappers.clone(),
    };
    module.visit_with(&mut collector);
    collector.carriers
}

#[derive(Clone)]
struct PromiseCarrierCollector {
    carriers: HashMap<Id, BTreeSet<String>>,
    dynamic_import_wrappers: DynamicImportWrappers,
}

impl PromiseCarrierCollector {
    fn module_ids_for_promise_expr(&self, expr: &Expr) -> Option<BTreeSet<String>> {
        resolve_dynamic_import_module_ids(expr, &self.carriers, &self.dynamic_import_wrappers)
    }
}

impl Visit for PromiseCarrierCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);
        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(init) = declarator.init.as_deref() else {
            return;
        };
        if let Some(module_ids) = self.module_ids_for_promise_expr(init) {
            self.carriers.insert(binding.id.to_id(), module_ids);
        }
    }

    fn visit_assign_expr(&mut self, assign_expr: &swc_core::ecma::ast::AssignExpr) {
        assign_expr.visit_children_with(self);
        let Some(module_ids) = self.module_ids_for_promise_expr(&assign_expr.right) else {
            return;
        };
        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Ident(binding),
        ) = &assign_expr.left
        else {
            return;
        };
        self.carriers.insert(binding.id.to_id(), module_ids);
    }

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        call_expr.visit_children_with(self);
        if call_expr.args.len() < 2 {
            return;
        }
        let Some(module_ids) = self.module_ids_for_promise_expr(&call_expr.args[1].expr) else {
            return;
        };
        let Expr::Ident(carrier_ident) = &*call_expr.args[0].expr else {
            return;
        };
        self.carriers.insert(carrier_ident.to_id(), module_ids);
    }
}

pub(super) fn collect_dynamic_import_wrappers(module: &Module) -> DynamicImportWrappers {
    let mut collector = DynamicImportWrapperCollector::default();
    module.visit_with(&mut collector);
    collector.wrappers
}

#[derive(Default)]
struct DynamicImportWrapperCollector {
    wrappers: DynamicImportWrappers,
}

impl Visit for DynamicImportWrapperCollector {
    fn visit_fn_decl(&mut self, function_decl: &swc_core::ecma::ast::FnDecl) {
        if let Some(module_ids) =
            extract_dynamic_import_module_ids_from_function(&function_decl.function)
        {
            self.wrappers
                .function_wrappers
                .insert(function_decl.ident.to_id(), module_ids);
        }
        function_decl.visit_children_with(self);
    }

    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        let Pat::Ident(binding) = &declarator.name else {
            declarator.visit_children_with(self);
            return;
        };
        if let Some(init) = declarator.init.as_deref() {
            if let Some(module_ids) = extract_dynamic_import_module_ids_from_expr(init) {
                self.wrappers
                    .function_wrappers
                    .insert(binding.id.to_id(), module_ids);
            } else if let Some(object_wrappers) = extract_dynamic_import_object_wrappers(init) {
                self.wrappers
                    .object_wrappers
                    .insert(binding.id.to_id(), object_wrappers);
            }
        }
        declarator.visit_children_with(self);
    }
}

fn extract_dynamic_import_module_ids_from_function(
    function: &swc_core::ecma::ast::Function,
) -> Option<BTreeSet<String>> {
    if !function.params.is_empty() {
        return None;
    }
    let body = function.body.as_ref()?;
    if body.stmts.len() != 1 {
        return None;
    }
    let Stmt::Return(return_stmt) = &body.stmts[0] else {
        return None;
    };
    let argument = return_stmt.arg.as_deref()?;
    extract_dynamic_import_module_ids_from_expr(argument)
}

fn extract_dynamic_import_module_ids_from_expr(expr: &Expr) -> Option<BTreeSet<String>> {
    match expr {
        Expr::Arrow(arrow) => extract_dynamic_import_module_ids_from_arrow(arrow),
        Expr::Fn(function_expr) => {
            extract_dynamic_import_module_ids_from_function(&function_expr.function)
        }
        Expr::Call(call_expr) => dynamic_import_module_ids_from_call(call_expr),
        Expr::Paren(paren) => extract_dynamic_import_module_ids_from_expr(&paren.expr),
        _ => None,
    }
}

fn extract_dynamic_import_module_ids_from_arrow(arrow: &ArrowExpr) -> Option<BTreeSet<String>> {
    if !arrow.params.is_empty() {
        return None;
    }
    match &*arrow.body {
        BlockStmtOrExpr::Expr(expr) => extract_dynamic_import_module_ids_from_expr(expr),
        BlockStmtOrExpr::BlockStmt(block) => {
            if block.stmts.len() != 1 {
                return None;
            }
            let Stmt::Return(return_stmt) = &block.stmts[0] else {
                return None;
            };
            let argument = return_stmt.arg.as_deref()?;
            extract_dynamic_import_module_ids_from_expr(argument)
        }
    }
}

fn extract_dynamic_import_object_wrappers(
    expr: &Expr,
) -> Option<BTreeMap<String, BTreeSet<String>>> {
    let Expr::Object(object) = expr else {
        return None;
    };
    let mut wrappers = BTreeMap::new();
    for prop in &object.props {
        let swc_core::ecma::ast::PropOrSpread::Prop(prop) = prop else {
            return None;
        };
        let swc_core::ecma::ast::Prop::KeyValue(key_value) = &**prop else {
            return None;
        };
        let prop_name = prop_name_to_string(&key_value.key)?;
        let module_ids = extract_dynamic_import_module_ids_from_expr(&key_value.value)?;
        wrappers.insert(prop_name, module_ids);
    }
    (!wrappers.is_empty()).then_some(wrappers)
}

pub(super) fn dynamic_import_module_ids_from_call(
    call_expr: &CallExpr,
) -> Option<BTreeSet<String>> {
    let Callee::Expr(callee_expr) = &call_expr.callee else {
        return None;
    };
    let Expr::Ident(callee_ident) = &**callee_expr else {
        return None;
    };
    if callee_ident.sym != *"__dynamicImport" || call_expr.args.len() != 1 {
        return None;
    }
    let Expr::Lit(Lit::Str(module_id)) = &*call_expr.args[0].expr else {
        return None;
    };
    Some(BTreeSet::from([module_id
        .value
        .to_string_lossy()
        .to_string()]))
}

fn resolve_dynamic_import_call_module_ids(
    call_expr: &CallExpr,
    carriers: &HashMap<Id, BTreeSet<String>>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<BTreeSet<String>> {
    if let Some(module_ids) = dynamic_import_module_ids_from_call(call_expr) {
        return Some(module_ids);
    }

    let Callee::Expr(callee_expr) = &call_expr.callee else {
        return None;
    };

    match &**callee_expr {
        Expr::Ident(ident) if call_expr.args.is_empty() => dynamic_import_wrappers
            .function_wrappers
            .get(&ident.to_id())
            .cloned(),
        Expr::Member(member) if call_expr.args.is_empty() => {
            collect_member_wrapper_module_ids(member, dynamic_import_wrappers)
        }
        _ if call_expr.args.len() == 1 => {
            let Expr::Ident(carrier_ident) = &*call_expr.args[0].expr else {
                return None;
            };
            carriers.get(&carrier_ident.to_id()).cloned()
        }
        _ => None,
    }
}

fn collect_member_wrapper_module_ids(
    member: &MemberExpr,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<BTreeSet<String>> {
    let Expr::Ident(object_ident) = &*member.obj else {
        return None;
    };
    let wrapper_map = dynamic_import_wrappers
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
