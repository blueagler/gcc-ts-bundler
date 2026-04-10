use super::*;

#[derive(Clone, Debug, Default)]
pub(crate) struct DynamicImportWrappers {
    pub(crate) function_wrappers: HashMap<Id, BTreeSet<String>>,
    pub(crate) object_wrappers: HashMap<Id, DynamicImportObjectWrapper>,
}

pub(crate) type DynamicImportObjectWrapper = BTreeMap<String, BTreeSet<String>>;

pub(crate) fn resolve_dynamic_import_module_ids(
    expr: &Expr,
    carriers: &HashMap<Id, BTreeSet<String>>,
    object_carriers: &HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<BTreeSet<String>> {
    resolve_dynamic_import_module_ids_with_options(
        expr,
        carriers,
        object_carriers,
        dynamic_import_wrappers,
        true,
    )
}

fn resolve_dynamic_import_module_ids_strict(
    expr: &Expr,
    carriers: &HashMap<Id, BTreeSet<String>>,
    object_carriers: &HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<BTreeSet<String>> {
    resolve_dynamic_import_module_ids_with_options(
        expr,
        carriers,
        object_carriers,
        dynamic_import_wrappers,
        false,
    )
}

fn resolve_dynamic_import_module_ids_with_options(
    expr: &Expr,
    carriers: &HashMap<Id, BTreeSet<String>>,
    object_carriers: &HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
    allow_passthrough_calls: bool,
) -> Option<BTreeSet<String>> {
    match expr {
        Expr::Ident(ident) => carriers.get(&ident.to_id()).cloned(),
        Expr::Call(call_expr) => resolve_dynamic_import_call_module_ids(
            call_expr,
            carriers,
            object_carriers,
            dynamic_import_wrappers,
            allow_passthrough_calls,
        ),
        Expr::Paren(paren) => resolve_dynamic_import_module_ids_with_options(
            &paren.expr,
            carriers,
            object_carriers,
            dynamic_import_wrappers,
            allow_passthrough_calls,
        ),
        Expr::Cond(cond) => merge_dynamic_import_module_ids(
            resolve_dynamic_import_module_ids_with_options(
                &cond.cons,
                carriers,
                object_carriers,
                dynamic_import_wrappers,
                allow_passthrough_calls,
            ),
            resolve_dynamic_import_module_ids_with_options(
                &cond.alt,
                carriers,
                object_carriers,
                dynamic_import_wrappers,
                allow_passthrough_calls,
            ),
        ),
        _ => None,
    }
}

pub(crate) fn collect_dynamic_import_promise_carriers(
    module: &Module,
    object_carriers: &HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> HashMap<Id, BTreeSet<String>> {
    let mut collector = PromiseCarrierCollector {
        carriers: HashMap::new(),
        object_carriers: object_carriers.clone(),
        dynamic_import_wrappers: dynamic_import_wrappers.clone(),
    };
    module.visit_with(&mut collector);
    collector.carriers
}

pub(crate) fn collect_dynamic_import_object_carriers(
    module: &Module,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> HashMap<Id, DynamicImportObjectWrapper> {
    let mut collector = ObjectCarrierCollector {
        carriers: HashMap::new(),
        dynamic_import_wrappers: dynamic_import_wrappers.clone(),
    };
    module.visit_with(&mut collector);
    collector.carriers
}

#[derive(Clone)]
struct PromiseCarrierCollector {
    carriers: HashMap<Id, BTreeSet<String>>,
    object_carriers: HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: DynamicImportWrappers,
}

impl PromiseCarrierCollector {
    fn module_ids_for_promise_expr(&self, expr: &Expr) -> Option<BTreeSet<String>> {
        resolve_dynamic_import_module_ids_strict(
            expr,
            &self.carriers,
            &self.object_carriers,
            &self.dynamic_import_wrappers,
        )
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

#[derive(Clone)]
struct ObjectCarrierCollector {
    carriers: HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: DynamicImportWrappers,
}

impl ObjectCarrierCollector {
    fn object_wrapper_for_expr(&self, expr: &Expr) -> Option<DynamicImportObjectWrapper> {
        resolve_dynamic_import_object_wrapper(expr, &self.carriers, &self.dynamic_import_wrappers)
    }
}

impl Visit for ObjectCarrierCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);
        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(init) = declarator.init.as_deref() else {
            return;
        };
        let Some(wrapper) = self.object_wrapper_for_expr(init) else {
            return;
        };
        self.carriers.insert(binding.id.to_id(), wrapper);
    }

    fn visit_assign_expr(&mut self, assign_expr: &swc_core::ecma::ast::AssignExpr) {
        assign_expr.visit_children_with(self);
        let Some(wrapper) = self.object_wrapper_for_expr(&assign_expr.right) else {
            return;
        };
        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Ident(binding),
        ) = &assign_expr.left
        else {
            return;
        };
        self.carriers.insert(binding.id.to_id(), wrapper);
    }

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        call_expr.visit_children_with(self);
        if call_expr.args.len() < 2 {
            return;
        }
        let Some(wrapper) = self.object_wrapper_for_expr(&call_expr.args[1].expr) else {
            return;
        };
        let Expr::Ident(carrier_ident) = &*call_expr.args[0].expr else {
            return;
        };
        self.carriers.insert(carrier_ident.to_id(), wrapper);
    }
}

pub(crate) fn collect_dynamic_import_wrappers(module: &Module) -> DynamicImportWrappers {
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

fn extract_dynamic_import_object_wrappers(expr: &Expr) -> Option<DynamicImportObjectWrapper> {
    match expr {
        Expr::Object(object) => extract_dynamic_import_object_wrappers_from_object(object),
        Expr::Array(array) => extract_dynamic_import_object_wrappers_from_array(array),
        Expr::Paren(paren) => extract_dynamic_import_object_wrappers(&paren.expr),
        _ => None,
    }
}

pub(crate) fn dynamic_import_module_ids_from_call(
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
    object_carriers: &HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
    allow_passthrough_calls: bool,
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
            collect_member_wrapper_module_ids(member, object_carriers, dynamic_import_wrappers)
        }
        _ if allow_passthrough_calls && call_expr.args.len() == 1 => merge_dynamic_import_module_ids(
            resolve_dynamic_import_module_ids_with_options(
                &call_expr.args[0].expr,
                carriers,
                object_carriers,
                dynamic_import_wrappers,
                allow_passthrough_calls,
            ),
            resolve_dynamic_import_object_wrapper(
                &call_expr.args[0].expr,
                object_carriers,
                dynamic_import_wrappers,
            )
            .and_then(|wrapper| collect_wrapper_module_ids(&wrapper)),
        ),
        Expr::Member(member) => {
            if let Some(wrapper) = resolve_dynamic_import_object_wrapper(
                &member.obj,
                object_carriers,
                dynamic_import_wrappers,
            ) {
                if call_expr.args.is_empty() {
                    let prop_name = member_prop_name(&member.prop)?;
                    return wrapper.get(&prop_name).cloned();
                }
            }
            None
        }
        _ => None,
    }
}

fn collect_member_wrapper_module_ids(
    member: &MemberExpr,
    object_carriers: &HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<BTreeSet<String>> {
    let wrapper_map =
        resolve_dynamic_import_object_wrapper(&member.obj, object_carriers, dynamic_import_wrappers)?;
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

pub(crate) fn resolve_dynamic_import_object_wrapper(
    expr: &Expr,
    object_carriers: &HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<DynamicImportObjectWrapper> {
    match expr {
        Expr::Ident(ident) => object_carriers
            .get(&ident.to_id())
            .cloned()
            .or_else(|| dynamic_import_wrappers.object_wrappers.get(&ident.to_id()).cloned()),
        Expr::Call(call_expr) => resolve_dynamic_import_object_wrapper_from_call(
            call_expr,
            object_carriers,
            dynamic_import_wrappers,
        ),
        Expr::Member(member) => resolve_dynamic_import_object_wrapper_from_member(
            member,
            object_carriers,
            dynamic_import_wrappers,
        ),
        Expr::Paren(paren) => {
            resolve_dynamic_import_object_wrapper(&paren.expr, object_carriers, dynamic_import_wrappers)
        }
        Expr::Cond(cond) => merge_object_wrappers(
            resolve_dynamic_import_object_wrapper(
                &cond.cons,
                object_carriers,
                dynamic_import_wrappers,
            ),
            resolve_dynamic_import_object_wrapper(
                &cond.alt,
                object_carriers,
                dynamic_import_wrappers,
            ),
        ),
        Expr::Bin(bin)
            if matches!(
                bin.op,
                swc_core::ecma::ast::BinaryOp::LogicalOr
                    | swc_core::ecma::ast::BinaryOp::LogicalAnd
                    | swc_core::ecma::ast::BinaryOp::NullishCoalescing
            ) =>
        {
            merge_object_wrappers(
                resolve_dynamic_import_object_wrapper(
                    &bin.left,
                    object_carriers,
                    dynamic_import_wrappers,
                ),
                resolve_dynamic_import_object_wrapper(
                    &bin.right,
                    object_carriers,
                    dynamic_import_wrappers,
                ),
            )
        }
        _ => None,
    }
}

fn resolve_dynamic_import_object_wrapper_from_call(
    call_expr: &CallExpr,
    object_carriers: &HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<DynamicImportObjectWrapper> {
    let Callee::Expr(callee_expr) = &call_expr.callee else {
        return None;
    };
    match &**callee_expr {
        Expr::Member(member) => {
            let wrapper = resolve_dynamic_import_object_wrapper(
                &member.obj,
                object_carriers,
                dynamic_import_wrappers,
            );
            if let Some(wrapper) = wrapper {
                let prop_name = member_prop_name(&member.prop)?;
                if matches!(prop_name.as_str(), "find" | "at") {
                    return Some(wrapper);
                }
            }
            if call_expr.args.len() == 1 {
                resolve_dynamic_import_object_wrapper(
                    &call_expr.args[0].expr,
                    object_carriers,
                    dynamic_import_wrappers,
                )
            } else {
                None
            }
        }
        _ if call_expr.args.len() == 1 => resolve_dynamic_import_object_wrapper(
            &call_expr.args[0].expr,
            object_carriers,
            dynamic_import_wrappers,
        ),
        _ => None,
    }
}

fn resolve_dynamic_import_object_wrapper_from_member(
    member: &MemberExpr,
    object_carriers: &HashMap<Id, DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<DynamicImportObjectWrapper> {
    let wrapper = resolve_dynamic_import_object_wrapper(
        &member.obj,
        object_carriers,
        dynamic_import_wrappers,
    )?;
    match &member.prop {
        MemberProp::Computed(computed)
            if matches!(&*computed.expr, Expr::Lit(Lit::Num(_)) | Expr::Lit(Lit::Str(_))) =>
        {
            Some(wrapper)
        }
        _ => None,
    }
}

fn extract_dynamic_import_object_wrappers_from_object(
    object: &swc_core::ecma::ast::ObjectLit,
) -> Option<DynamicImportObjectWrapper> {
    let mut wrappers = BTreeMap::new();
    for prop in &object.props {
        let swc_core::ecma::ast::PropOrSpread::Prop(prop) = prop else {
            continue;
        };
        let swc_core::ecma::ast::Prop::KeyValue(key_value) = prop.as_ref() else {
            continue;
        };
        let Some(prop_name) = prop_name_to_string(&key_value.key) else {
            continue;
        };
        let Some(module_ids) = extract_dynamic_import_module_ids_from_expr(&key_value.value) else {
            continue;
        };
        wrappers.insert(prop_name, module_ids);
    }
    (!wrappers.is_empty()).then_some(wrappers)
}

fn extract_dynamic_import_object_wrappers_from_array(
    array: &swc_core::ecma::ast::ArrayLit,
) -> Option<DynamicImportObjectWrapper> {
    let mut merged = BTreeMap::new();
    for element in array.elems.iter().flatten() {
        let Some(wrapper) = extract_dynamic_import_object_wrappers(&element.expr) else {
            continue;
        };
        merge_wrapper_map_into(&mut merged, wrapper);
    }
    (!merged.is_empty()).then_some(merged)
}

fn collect_wrapper_module_ids(wrapper: &DynamicImportObjectWrapper) -> Option<BTreeSet<String>> {
    let mut module_ids = BTreeSet::new();
    for ids in wrapper.values() {
        module_ids.extend(ids.iter().cloned());
    }
    (!module_ids.is_empty()).then_some(module_ids)
}

fn merge_dynamic_import_module_ids(
    left: Option<BTreeSet<String>>,
    right: Option<BTreeSet<String>>,
) -> Option<BTreeSet<String>> {
    match (left, right) {
        (Some(mut left), Some(right)) => {
            left.extend(right);
            Some(left)
        }
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn merge_object_wrappers(
    left: Option<DynamicImportObjectWrapper>,
    right: Option<DynamicImportObjectWrapper>,
) -> Option<DynamicImportObjectWrapper> {
    match (left, right) {
        (Some(mut left), Some(right)) => {
            merge_wrapper_map_into(&mut left, right);
            Some(left)
        }
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn merge_wrapper_map_into(
    target: &mut DynamicImportObjectWrapper,
    wrapper: DynamicImportObjectWrapper,
) {
    for (prop_name, module_ids) in wrapper {
        target.entry(prop_name).or_default().extend(module_ids);
    }
}
