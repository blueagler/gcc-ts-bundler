use super::*;

#[derive(Clone, Debug, Default)]
pub(crate) struct DynamicImportWrappers {
    pub(crate) function_wrappers: BindingKeyMap<BTreeSet<String>>,
    pub(crate) object_wrappers: BindingKeyMap<DynamicImportObjectWrapper>,
    pub(crate) object_function_wrappers: BindingKeyMap<DynamicImportObjectWrapper>,
    pub(crate) loader_ids: BindingKeySet,
}

pub(crate) type DynamicImportObjectWrapper = BTreeMap<String, BTreeSet<String>>;

pub(crate) fn resolve_dynamic_import_module_ids(
    expr: &Expr,
    carriers: &BindingKeyMap<BTreeSet<String>>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
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
    carriers: &BindingKeyMap<BTreeSet<String>>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
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
    carriers: &BindingKeyMap<BTreeSet<String>>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
    allow_passthrough_calls: bool,
) -> Option<BTreeSet<String>> {
    match expr {
        Expr::Ident(ident) => carriers.get(&BindingKey::of(&ident)).cloned(),
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
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> BindingKeyMap<BTreeSet<String>> {
    let storage_cells = collect_flow_storage_cells(module);
    let mut collector = PromiseCarrierCollector {
        carriers: HashMap::new(),
        object_carriers: object_carriers.clone(),
        dynamic_import_wrappers: dynamic_import_wrappers.clone(),
        storage_cells,
    };
    module.visit_with(&mut collector);
    collector.carriers
}

pub(crate) fn collect_dynamic_import_object_carriers(
    module: &Module,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> BindingKeyMap<DynamicImportObjectWrapper> {
    let mut collector = ObjectCarrierCollector {
        carriers: HashMap::new(),
        dynamic_import_wrappers: dynamic_import_wrappers.clone(),
        storage_cells: collect_flow_storage_cells(module),
    };
    module.visit_with(&mut collector);
    collector.carriers
}

fn collect_flow_storage_cells(module: &Module) -> BindingKeySet {
    let mut collector = FlowStorageCellCollector::default();
    module.visit_with(&mut collector);
    let evidenced_initializers = collector
        .initialized_by_call
        .iter()
        .filter_map(|(callee, bindings)| {
            bindings
                .iter()
                .any(|binding| collector.read_by_unary_call.contains(binding))
                .then_some(callee.clone())
        })
        .collect::<HashSet<_>>();
    collector
        .initialized_by_call
        .into_iter()
        .filter(|(callee, _)| evidenced_initializers.contains(callee))
        .flat_map(|(_, bindings)| bindings)
        .collect()
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum FlowCalleeKey {
    Ident(BindingKey),
    Member(BindingKey, String),
}

#[derive(Default)]
struct FlowStorageCellCollector {
    initialized_by_call: HashMap<FlowCalleeKey, BindingKeySet>,
    read_by_unary_call: BindingKeySet,
}

impl Visit for FlowStorageCellCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        if let (Pat::Ident(binding), Some(Expr::Call(call))) =
            (&declarator.name, declarator.init.as_deref())
        {
            if let Some(callee) = flow_callee_key(&call.callee) {
                self.initialized_by_call
                    .entry(callee)
                    .or_default()
                    .insert(BindingKey::of_binding(&binding));
            }
        }
        declarator.visit_children_with(self);
    }

    fn visit_call_expr(&mut self, call: &CallExpr) {
        if call.args.len() == 1 {
            if let Expr::Ident(binding) = &*call.args[0].expr {
                self.read_by_unary_call.insert(BindingKey::of(&binding));
            }
        }
        call.visit_children_with(self);
    }
}

fn flow_callee_key(callee: &Callee) -> Option<FlowCalleeKey> {
    let Callee::Expr(callee) = callee else {
        return None;
    };
    match &**callee {
        Expr::Ident(ident) => Some(FlowCalleeKey::Ident(BindingKey::of(&ident))),
        Expr::Member(member) => {
            let Expr::Ident(object) = &*member.obj else {
                return None;
            };
            let property = match &member.prop {
                MemberProp::Ident(property) => property.sym.to_string(),
                MemberProp::Computed(property) => match &*property.expr {
                    Expr::Lit(Lit::Str(value)) => value.value.to_string_lossy().to_string(),
                    Expr::Lit(Lit::Num(value)) => value.value.to_string(),
                    _ => return None,
                },
                MemberProp::PrivateName(_) => return None,
            };
            Some(FlowCalleeKey::Member(BindingKey::of(&object), property))
        }
        Expr::Paren(paren) => flow_callee_key(&Callee::Expr(paren.expr.clone())),
        _ => None,
    }
}

#[derive(Clone)]
struct PromiseCarrierCollector {
    carriers: BindingKeyMap<BTreeSet<String>>,
    object_carriers: BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: DynamicImportWrappers,
    storage_cells: BindingKeySet,
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
        let binding_id = BindingKey::of_binding(&binding);
        let module_ids = declarator
            .init
            .as_deref()
            .and_then(|init| self.module_ids_for_promise_expr(init));
        if let Some(module_ids) = module_ids {
            self.carriers.insert(binding_id, module_ids);
        } else {
            self.carriers.remove(&binding_id);
        }
    }

    fn visit_assign_expr(&mut self, assign_expr: &swc_core::ecma::ast::AssignExpr) {
        assign_expr.visit_children_with(self);
        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Ident(binding),
        ) = &assign_expr.left
        else {
            remove_assign_target_carriers(&assign_expr.left, &mut self.carriers);
            return;
        };
        let binding_id = BindingKey::of_binding(&binding);
        let module_ids = matches!(assign_expr.op, swc_core::ecma::ast::AssignOp::Assign)
            .then(|| self.module_ids_for_promise_expr(&assign_expr.right))
            .flatten();
        if let Some(module_ids) = module_ids {
            self.carriers.insert(binding_id, module_ids);
        } else {
            self.carriers.remove(&binding_id);
        }
    }

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        call_expr.visit_children_with(self);
        if call_expr.args.len() < 2 {
            return;
        }
        let Expr::Ident(carrier_ident) = &*call_expr.args[0].expr else {
            return;
        };
        let carrier_id = BindingKey::of(&carrier_ident);
        if !self.storage_cells.contains(&carrier_id) {
            return;
        }
        if let Some(module_ids) = self.module_ids_for_promise_expr(&call_expr.args[1].expr) {
            self.carriers.insert(carrier_id, module_ids);
        } else {
            self.carriers.remove(&carrier_id);
        }
    }

    fn visit_update_expr(&mut self, update_expr: &swc_core::ecma::ast::UpdateExpr) {
        update_expr.visit_children_with(self);
        if let Expr::Ident(ident) = &*update_expr.arg {
            self.carriers.remove(&BindingKey::of(&ident));
        }
    }
    fn visit_for_in_stmt(&mut self, statement: &swc_core::ecma::ast::ForInStmt) {
        statement.visit_children_with(self);
        remove_for_head_carriers(&statement.left, &mut self.carriers);
    }

    fn visit_for_of_stmt(&mut self, statement: &swc_core::ecma::ast::ForOfStmt) {
        statement.visit_children_with(self);
        remove_for_head_carriers(&statement.left, &mut self.carriers);
    }
}

#[derive(Clone)]
struct ObjectCarrierCollector {
    carriers: BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: DynamicImportWrappers,
    storage_cells: BindingKeySet,
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
        let binding_id = BindingKey::of_binding(&binding);
        let wrapper = declarator
            .init
            .as_deref()
            .and_then(|init| self.object_wrapper_for_expr(init));
        if let Some(wrapper) = wrapper {
            self.carriers.insert(binding_id, wrapper);
        } else {
            self.carriers.remove(&binding_id);
        }
    }

    fn visit_assign_expr(&mut self, assign_expr: &swc_core::ecma::ast::AssignExpr) {
        assign_expr.visit_children_with(self);
        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Ident(binding),
        ) = &assign_expr.left
        else {
            remove_assign_target_carriers(&assign_expr.left, &mut self.carriers);
            return;
        };
        let binding_id = BindingKey::of_binding(&binding);
        let wrapper = matches!(assign_expr.op, swc_core::ecma::ast::AssignOp::Assign)
            .then(|| self.object_wrapper_for_expr(&assign_expr.right))
            .flatten();
        if let Some(wrapper) = wrapper {
            self.carriers.insert(binding_id, wrapper);
        } else {
            self.carriers.remove(&binding_id);
        }
    }

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        call_expr.visit_children_with(self);
        if call_expr.args.len() < 2 {
            return;
        }
        let Expr::Ident(carrier_ident) = &*call_expr.args[0].expr else {
            return;
        };
        let carrier_id = BindingKey::of(&carrier_ident);
        if !self.storage_cells.contains(&carrier_id) {
            return;
        }
        if let Some(wrapper) = self.object_wrapper_for_expr(&call_expr.args[1].expr) {
            self.carriers.insert(carrier_id, wrapper);
        } else {
            self.carriers.remove(&carrier_id);
        }
    }

    fn visit_update_expr(&mut self, update_expr: &swc_core::ecma::ast::UpdateExpr) {
        update_expr.visit_children_with(self);
        if let Expr::Ident(ident) = &*update_expr.arg {
            self.carriers.remove(&BindingKey::of(&ident));
        }
    }
    fn visit_for_in_stmt(&mut self, statement: &swc_core::ecma::ast::ForInStmt) {
        statement.visit_children_with(self);
        remove_for_head_carriers(&statement.left, &mut self.carriers);
    }

    fn visit_for_of_stmt(&mut self, statement: &swc_core::ecma::ast::ForOfStmt) {
        statement.visit_children_with(self);
        remove_for_head_carriers(&statement.left, &mut self.carriers);
    }
}
pub(crate) fn remove_assign_target_carriers<T>(
    target: &swc_core::ecma::ast::AssignTarget,
    carriers: &mut BindingKeyMap<T>,
) {
    match target {
        swc_core::ecma::ast::AssignTarget::Simple(target) => {
            remove_simple_assign_target_carrier(target, carriers)
        }
        swc_core::ecma::ast::AssignTarget::Pat(swc_core::ecma::ast::AssignTargetPat::Array(
            pattern,
        )) => {
            for element in pattern.elems.iter().flatten() {
                remove_pattern_carriers(element, carriers);
            }
        }
        swc_core::ecma::ast::AssignTarget::Pat(swc_core::ecma::ast::AssignTargetPat::Object(
            pattern,
        )) => {
            remove_object_pattern_carriers(pattern, carriers);
        }
        swc_core::ecma::ast::AssignTarget::Pat(swc_core::ecma::ast::AssignTargetPat::Invalid(
            _,
        )) => {}
    }
}

fn remove_simple_assign_target_carrier<T>(
    target: &swc_core::ecma::ast::SimpleAssignTarget,
    carriers: &mut BindingKeyMap<T>,
) {
    let expression = match target {
        swc_core::ecma::ast::SimpleAssignTarget::Ident(binding) => {
            carriers.remove(&BindingKey::of_binding(&binding));
            return;
        }
        swc_core::ecma::ast::SimpleAssignTarget::Paren(expression) => &expression.expr,
        swc_core::ecma::ast::SimpleAssignTarget::TsAs(expression) => &expression.expr,
        swc_core::ecma::ast::SimpleAssignTarget::TsSatisfies(expression) => &expression.expr,
        swc_core::ecma::ast::SimpleAssignTarget::TsNonNull(expression) => &expression.expr,
        swc_core::ecma::ast::SimpleAssignTarget::TsTypeAssertion(expression) => &expression.expr,
        swc_core::ecma::ast::SimpleAssignTarget::TsInstantiation(expression) => &expression.expr,
        _ => return,
    };
    if let Expr::Ident(ident) = &**expression {
        carriers.remove(&BindingKey::of(&ident));
    }
}

pub(crate) fn remove_for_head_carriers<T>(
    head: &swc_core::ecma::ast::ForHead,
    carriers: &mut BindingKeyMap<T>,
) {
    if let swc_core::ecma::ast::ForHead::Pat(pattern) = head {
        remove_pattern_carriers(pattern, carriers);
    }
}

fn remove_object_pattern_carriers<T>(
    object: &swc_core::ecma::ast::ObjectPat,
    carriers: &mut BindingKeyMap<T>,
) {
    for property in &object.props {
        match property {
            swc_core::ecma::ast::ObjectPatProp::KeyValue(property) => {
                remove_pattern_carriers(&property.value, carriers)
            }
            swc_core::ecma::ast::ObjectPatProp::Assign(property) => {
                carriers.remove(&BindingKey::of(&property.key));
            }
            swc_core::ecma::ast::ObjectPatProp::Rest(property) => {
                remove_pattern_carriers(&property.arg, carriers)
            }
        }
    }
}

fn remove_pattern_carriers<T>(pattern: &Pat, carriers: &mut BindingKeyMap<T>) {
    match pattern {
        Pat::Ident(binding) => {
            carriers.remove(&BindingKey::of_binding(&binding));
        }
        Pat::Array(array) => {
            for element in array.elems.iter().flatten() {
                remove_pattern_carriers(element, carriers);
            }
        }
        Pat::Object(object) => remove_object_pattern_carriers(object, carriers),
        Pat::Assign(assign) => remove_pattern_carriers(&assign.left, carriers),
        Pat::Rest(rest) => remove_pattern_carriers(&rest.arg, carriers),
        Pat::Expr(expr) => {
            if let Expr::Ident(ident) = &**expr {
                carriers.remove(&BindingKey::of(&ident));
            }
        }
        _ => {}
    }
}

pub(crate) fn collect_dynamic_import_wrappers(module: &Module) -> DynamicImportWrappers {
    let mut collector = DynamicImportWrapperCollector {
        wrappers: DynamicImportWrappers {
            loader_ids: collect_dynamic_import_loader_ids(module),
            ..Default::default()
        },
    };
    module.visit_with(&mut collector);

    let mut wrappers = collector.wrappers;
    let mut object_function_wrappers = HashMap::new();

    loop {
        let mut collector = DynamicImportObjectFunctionCollector {
            object_function_wrappers: object_function_wrappers.clone(),
            dynamic_import_wrappers: DynamicImportWrappers {
                object_function_wrappers: object_function_wrappers.clone(),
                ..wrappers.clone()
            },
        };
        module.visit_with(&mut collector);
        if collector.object_function_wrappers == object_function_wrappers {
            wrappers.object_function_wrappers = collector.object_function_wrappers;
            return wrappers;
        }
        object_function_wrappers = collector.object_function_wrappers;
    }
}

#[derive(Default)]
struct DynamicImportLoaderCollector {
    called_ids: BindingKeySet,
    declared_ids: BindingKeySet,
}

fn collect_dynamic_import_loader_ids(module: &Module) -> BindingKeySet {
    let mut collector = DynamicImportLoaderCollector::default();
    module.visit_with(&mut collector);
    collector
        .called_ids
        .difference(&collector.declared_ids)
        .cloned()
        .collect()
}

impl DynamicImportLoaderCollector {
    fn declare(&mut self, ident: &Ident) {
        if ident.sym == *"__dynamicImport" {
            self.declared_ids.insert(BindingKey::of(&ident));
        }
    }
}

impl Visit for DynamicImportLoaderCollector {
    fn visit_binding_ident(&mut self, binding: &BindingIdent) {
        self.declare(&binding.id);
        binding.visit_children_with(self);
    }

    fn visit_fn_decl(&mut self, declaration: &swc_core::ecma::ast::FnDecl) {
        self.declare(&declaration.ident);
        declaration.function.visit_with(self);
    }

    fn visit_fn_expr(&mut self, expression: &swc_core::ecma::ast::FnExpr) {
        if let Some(ident) = &expression.ident {
            self.declare(ident);
        }
        expression.function.visit_with(self);
    }

    fn visit_class_decl(&mut self, declaration: &swc_core::ecma::ast::ClassDecl) {
        self.declare(&declaration.ident);
        declaration.class.visit_with(self);
    }

    fn visit_class_expr(&mut self, expression: &swc_core::ecma::ast::ClassExpr) {
        if let Some(ident) = &expression.ident {
            self.declare(ident);
        }
        expression.class.visit_with(self);
    }

    fn visit_import_default_specifier(&mut self, specifier: &ImportDefaultSpecifier) {
        self.declare(&specifier.local);
    }

    fn visit_import_named_specifier(
        &mut self,
        specifier: &swc_core::ecma::ast::ImportNamedSpecifier,
    ) {
        self.declare(&specifier.local);
    }

    fn visit_import_star_as_specifier(
        &mut self,
        specifier: &swc_core::ecma::ast::ImportStarAsSpecifier,
    ) {
        self.declare(&specifier.local);
    }

    fn visit_call_expr(&mut self, call: &CallExpr) {
        if let Callee::Expr(callee) = &call.callee {
            if let Expr::Ident(ident) = &**callee {
                if ident.sym == *"__dynamicImport" {
                    self.called_ids.insert(BindingKey::of(&ident));
                }
            }
        }
        call.visit_children_with(self);
    }
}

#[derive(Default)]
struct DynamicImportWrapperCollector {
    wrappers: DynamicImportWrappers,
}

impl Visit for DynamicImportWrapperCollector {
    fn visit_fn_decl(&mut self, function_decl: &swc_core::ecma::ast::FnDecl) {
        if let Some(module_ids) = extract_dynamic_import_module_ids_from_function(
            &function_decl.function,
            &self.wrappers.loader_ids,
        ) {
            self.wrappers
                .function_wrappers
                .insert(BindingKey::of(&function_decl.ident), module_ids);
        }
        function_decl.visit_children_with(self);
    }

    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        let Pat::Ident(binding) = &declarator.name else {
            declarator.visit_children_with(self);
            return;
        };
        if let Some(init) = declarator.init.as_deref() {
            if let Some(module_ids) =
                extract_dynamic_import_module_ids_from_expr(init, &self.wrappers.loader_ids)
            {
                self.wrappers
                    .function_wrappers
                    .insert(BindingKey::of_binding(&binding), module_ids);
            } else if let Some(object_wrappers) =
                extract_dynamic_import_object_wrappers(init, &self.wrappers.loader_ids)
            {
                self.wrappers
                    .object_wrappers
                    .insert(BindingKey::of_binding(&binding), object_wrappers);
            }
        }
        declarator.visit_children_with(self);
    }
}

struct DynamicImportObjectFunctionCollector {
    object_function_wrappers: BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: DynamicImportWrappers,
}

impl DynamicImportObjectFunctionCollector {
    fn insert_wrapper(&mut self, id: BindingKey, wrapper: DynamicImportObjectWrapper) {
        self.dynamic_import_wrappers
            .object_function_wrappers
            .insert(id.clone(), wrapper.clone());
        self.object_function_wrappers.insert(id, wrapper);
    }
}

impl Visit for DynamicImportObjectFunctionCollector {
    fn visit_fn_decl(&mut self, function_decl: &swc_core::ecma::ast::FnDecl) {
        if let Some(wrapper) = extract_dynamic_import_object_wrapper_from_function(
            &function_decl.function,
            &self.dynamic_import_wrappers,
        ) {
            self.insert_wrapper(BindingKey::of(&function_decl.ident), wrapper);
        }
        function_decl.visit_children_with(self);
    }

    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        let Pat::Ident(binding) = &declarator.name else {
            declarator.visit_children_with(self);
            return;
        };
        if let Some(init) = declarator.init.as_deref() {
            if let Some(wrapper) = extract_dynamic_import_object_wrapper_from_callable_expr(
                init,
                &self.dynamic_import_wrappers,
            ) {
                self.insert_wrapper(BindingKey::of_binding(&binding), wrapper);
            }
        }
        declarator.visit_children_with(self);
    }
}

fn extract_dynamic_import_module_ids_from_function(
    function: &swc_core::ecma::ast::Function,
    loader_ids: &BindingKeySet,
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
    extract_dynamic_import_module_ids_from_expr(argument, loader_ids)
}

fn extract_dynamic_import_module_ids_from_expr(
    expr: &Expr,
    loader_ids: &BindingKeySet,
) -> Option<BTreeSet<String>> {
    match expr {
        Expr::Arrow(arrow) => extract_dynamic_import_module_ids_from_arrow(arrow, loader_ids),
        Expr::Fn(function_expr) => {
            extract_dynamic_import_module_ids_from_function(&function_expr.function, loader_ids)
        }
        Expr::Call(call_expr) => dynamic_import_module_ids_from_call(call_expr, loader_ids),
        Expr::Paren(paren) => extract_dynamic_import_module_ids_from_expr(&paren.expr, loader_ids),
        _ => None,
    }
}

fn extract_dynamic_import_module_ids_from_arrow(
    arrow: &ArrowExpr,
    loader_ids: &BindingKeySet,
) -> Option<BTreeSet<String>> {
    if !arrow.params.is_empty() {
        return None;
    }
    match &*arrow.body {
        BlockStmtOrExpr::Expr(expr) => {
            extract_dynamic_import_module_ids_from_expr(expr, loader_ids)
        }
        BlockStmtOrExpr::BlockStmt(block) => {
            if block.stmts.len() != 1 {
                return None;
            }
            let Stmt::Return(return_stmt) = &block.stmts[0] else {
                return None;
            };
            let argument = return_stmt.arg.as_deref()?;
            extract_dynamic_import_module_ids_from_expr(argument, loader_ids)
        }
    }
}

fn extract_dynamic_import_object_wrappers(
    expr: &Expr,
    loader_ids: &BindingKeySet,
) -> Option<DynamicImportObjectWrapper> {
    match expr {
        Expr::Object(object) => {
            extract_dynamic_import_object_wrappers_from_object(object, loader_ids)
        }
        Expr::Array(array) => extract_dynamic_import_object_wrappers_from_array(array, loader_ids),
        Expr::Paren(paren) => extract_dynamic_import_object_wrappers(&paren.expr, loader_ids),
        _ => None,
    }
}

fn extract_dynamic_import_object_wrapper_from_callable_expr(
    expr: &Expr,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<DynamicImportObjectWrapper> {
    match expr {
        Expr::Arrow(arrow) => {
            extract_dynamic_import_object_wrapper_from_arrow(arrow, dynamic_import_wrappers)
        }
        Expr::Fn(function_expr) => extract_dynamic_import_object_wrapper_from_function(
            &function_expr.function,
            dynamic_import_wrappers,
        ),
        Expr::Paren(paren) => extract_dynamic_import_object_wrapper_from_callable_expr(
            &paren.expr,
            dynamic_import_wrappers,
        ),
        _ => None,
    }
}

fn extract_dynamic_import_object_wrapper_from_function(
    function: &swc_core::ecma::ast::Function,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<DynamicImportObjectWrapper> {
    let body = function.body.as_ref()?;
    let argument = extract_wrapper_return_argument(&body.stmts)?;
    let object_carriers = HashMap::new();
    resolve_dynamic_import_object_wrapper(argument, &object_carriers, dynamic_import_wrappers)
}

fn extract_dynamic_import_object_wrapper_from_arrow(
    arrow: &ArrowExpr,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<DynamicImportObjectWrapper> {
    let object_carriers = HashMap::new();
    match &*arrow.body {
        BlockStmtOrExpr::Expr(expr) => {
            resolve_dynamic_import_object_wrapper(expr, &object_carriers, dynamic_import_wrappers)
        }
        BlockStmtOrExpr::BlockStmt(block) => {
            let argument = extract_wrapper_return_argument(&block.stmts)?;
            resolve_dynamic_import_object_wrapper(
                argument,
                &object_carriers,
                dynamic_import_wrappers,
            )
        }
    }
}

fn extract_wrapper_return_argument(statements: &[Stmt]) -> Option<&Expr> {
    let (return_stmt, prelude) = statements.split_last()?;
    if !prelude.iter().all(is_wrapper_prelude_statement) {
        return None;
    }
    let Stmt::Return(return_stmt) = return_stmt else {
        return None;
    };
    return_stmt.arg.as_deref()
}

fn is_wrapper_prelude_statement(statement: &Stmt) -> bool {
    let Stmt::Decl(swc_core::ecma::ast::Decl::Var(var_decl)) = statement else {
        return false;
    };
    var_decl
        .decls
        .iter()
        .all(|declarator| declarator.init.is_none())
}

pub(crate) fn dynamic_import_module_ids_from_call(
    call_expr: &CallExpr,
    loader_ids: &BindingKeySet,
) -> Option<BTreeSet<String>> {
    let Callee::Expr(callee_expr) = &call_expr.callee else {
        return None;
    };
    let Expr::Ident(callee_ident) = &**callee_expr else {
        return None;
    };
    if !loader_ids.contains(&BindingKey::of(&callee_ident)) || call_expr.args.len() != 1 {
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
    carriers: &BindingKeyMap<BTreeSet<String>>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
    allow_passthrough_calls: bool,
) -> Option<BTreeSet<String>> {
    if let Some(module_ids) =
        dynamic_import_module_ids_from_call(call_expr, &dynamic_import_wrappers.loader_ids)
    {
        return Some(module_ids);
    }

    let Callee::Expr(callee_expr) = &call_expr.callee else {
        return None;
    };

    match &**callee_expr {
        Expr::Ident(ident) if call_expr.args.is_empty() => dynamic_import_wrappers
            .function_wrappers
            .get(&BindingKey::of(&ident))
            .cloned(),
        Expr::Member(member) if call_expr.args.is_empty() => {
            collect_member_wrapper_module_ids(member, object_carriers, dynamic_import_wrappers)
        }
        _ if allow_passthrough_calls && call_expr.args.len() == 1 => {
            merge_dynamic_import_module_ids(
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
            )
        }
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
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<BTreeSet<String>> {
    let wrapper_map = resolve_dynamic_import_object_wrapper(
        &member.obj,
        object_carriers,
        dynamic_import_wrappers,
    )?;
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
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<DynamicImportObjectWrapper> {
    match expr {
        Expr::Ident(ident) => object_carriers.get(&BindingKey::of(&ident)).cloned().or_else(|| {
            dynamic_import_wrappers
                .object_wrappers
                .get(&BindingKey::of(&ident))
                .cloned()
        }),
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
        Expr::Paren(paren) => resolve_dynamic_import_object_wrapper(
            &paren.expr,
            object_carriers,
            dynamic_import_wrappers,
        ),
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
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<DynamicImportObjectWrapper> {
    let Callee::Expr(callee_expr) = &call_expr.callee else {
        return None;
    };
    match &**callee_expr {
        Expr::Ident(ident) => dynamic_import_wrappers
            .object_function_wrappers
            .get(&BindingKey::of(&ident))
            .cloned()
            .or_else(|| {
                if call_expr.args.len() == 1 {
                    resolve_dynamic_import_object_wrapper(
                        &call_expr.args[0].expr,
                        object_carriers,
                        dynamic_import_wrappers,
                    )
                } else {
                    None
                }
            }),
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
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> Option<DynamicImportObjectWrapper> {
    let wrapper = resolve_dynamic_import_object_wrapper(
        &member.obj,
        object_carriers,
        dynamic_import_wrappers,
    )?;
    match &member.prop {
        MemberProp::Computed(computed)
            if matches!(
                &*computed.expr,
                Expr::Lit(Lit::Num(_)) | Expr::Lit(Lit::Str(_))
            ) =>
        {
            Some(wrapper)
        }
        _ => None,
    }
}

fn extract_dynamic_import_object_wrappers_from_object(
    object: &swc_core::ecma::ast::ObjectLit,
    loader_ids: &BindingKeySet,
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
        let Some(module_ids) =
            extract_dynamic_import_module_ids_from_expr(&key_value.value, loader_ids)
        else {
            continue;
        };
        wrappers.insert(prop_name, module_ids);
    }
    (!wrappers.is_empty()).then_some(wrappers)
}

fn extract_dynamic_import_object_wrappers_from_array(
    array: &swc_core::ecma::ast::ArrayLit,
    loader_ids: &BindingKeySet,
) -> Option<DynamicImportObjectWrapper> {
    let mut merged = BTreeMap::new();
    for element in array.elems.iter().flatten() {
        let Some(wrapper) = extract_dynamic_import_object_wrappers(&element.expr, loader_ids)
        else {
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
