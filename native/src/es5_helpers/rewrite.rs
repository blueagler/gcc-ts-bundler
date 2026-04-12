use std::collections::{BTreeSet, HashMap, HashSet};

use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{VisitMut, VisitMutWith};

use super::kinds::SharedEs5HelperKind;
use super::utils::{
    collect_binding_names_from_pat, collect_function_scope_names, collect_module_scope_names,
    global_this_expr, helper_alias_decl, helper_slot_expr, next_available_alias,
    print_function_decl_minified,
};

pub(super) struct Es5HelperChunkRewriter {
    pub(super) changed: bool,
    pub(super) helper_kinds: BTreeSet<SharedEs5HelperKind>,
    shared_module_aliases: Option<(String, String)>,
    module_alias_used: Vec<bool>,
}

impl Es5HelperChunkRewriter {
    pub(super) fn new() -> Self {
        Self {
            changed: false,
            helper_kinds: BTreeSet::new(),
            shared_module_aliases: None,
            module_alias_used: Vec::new(),
        }
    }

    fn rewrite_block_stmt(&mut self, block: &mut BlockStmt, mut names: HashSet<String>) {
        collect_function_scope_names(block, &mut names);
        let (runtime_alias, helper_alias, insert_local_alias) =
            if let Some((shared_runtime_alias, shared_helper_alias)) =
                self.shared_module_aliases.as_ref()
            {
                if !names.contains(shared_runtime_alias) && !names.contains(shared_helper_alias) {
                    (
                        shared_runtime_alias.clone(),
                        shared_helper_alias.clone(),
                        false,
                    )
                } else {
                    let runtime_alias =
                        next_available_alias(&names, &["G", "$G", "G$", "_G", "__G"]);
                    names.insert(runtime_alias.clone());
                    let helper_alias =
                        next_available_alias(&names, &["_", "$", "$_", "_$", "__"]);
                    (runtime_alias, helper_alias, true)
                }
            } else {
                let runtime_alias = next_available_alias(&names, &["G", "$G", "G$", "_G", "__G"]);
                names.insert(runtime_alias.clone());
                let helper_alias = next_available_alias(&names, &["_", "$", "$_", "_$", "__"]);
                (runtime_alias, helper_alias, true)
            };
        let helper_bindings = block
            .stmts
            .iter()
            .enumerate()
            .filter_map(|(index, stmt)| {
                let Stmt::Decl(Decl::Fn(fn_decl)) = stmt else {
                    return None;
                };
                classify_shared_es5_helper(fn_decl)
                    .map(|kind| (index, fn_decl.ident.sym.to_string(), kind))
            })
            .collect::<Vec<_>>();

        let removed_indices = helper_bindings
            .iter()
            .map(|(index, _, _)| *index)
            .collect::<HashSet<_>>();
        block.stmts = block
            .stmts
            .iter()
            .enumerate()
            .filter_map(|(index, stmt)| (!removed_indices.contains(&index)).then_some(stmt.clone()))
            .collect();

        let mut current_scope_names = names.clone();
        let mut helper_name_to_kind = HashMap::new();
        for (_, helper_name, kind) in &helper_bindings {
            current_scope_names.remove(helper_name);
            helper_name_to_kind.insert(helper_name.clone(), *kind);
        }
        if !current_scope_names.contains("ta") {
            helper_name_to_kind.insert("ta".to_string(), SharedEs5HelperKind::ClosureTemplateObject);
        }
        if !current_scope_names.contains("qa") {
            helper_name_to_kind.insert("qa".to_string(), SharedEs5HelperKind::ClosureInherits);
        }
        let mut rewriter = HelperReferenceRewriter {
            helper_alias,
            helper_name_to_kind,
            scope_stack: Vec::new(),
            rewritten_helper_kinds: BTreeSet::new(),
            rewrite_closure_global: !current_scope_names.contains("ha"),
            rewrote_closure_global: false,
        };
        rewriter.scope_stack.push(current_scope_names);
        block.visit_mut_with(&mut rewriter);
        rewriter.scope_stack.pop();
        if rewriter.rewritten_helper_kinds.is_empty() && !rewriter.rewrote_closure_global {
            return;
        }

        if insert_local_alias {
            block
                .stmts
                .insert(0, helper_alias_decl(&runtime_alias, &rewriter.helper_alias));
        } else if let Some(module_alias_used) = self.module_alias_used.last_mut() {
            *module_alias_used = true;
        }
        self.helper_kinds.extend(rewriter.rewritten_helper_kinds);
        self.changed = true;
    }

    fn rewrite_module_items(
        &mut self,
        module: &mut Module,
        helper_alias: &str,
    ) -> BTreeSet<SharedEs5HelperKind> {
        if module
            .body
            .iter()
            .any(|item| matches!(item, ModuleItem::ModuleDecl(_)))
        {
            return BTreeSet::new();
        }

        let helper_bindings = module
            .body
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                let ModuleItem::Stmt(Stmt::Decl(Decl::Fn(fn_decl))) = item else {
                    return None;
                };
                classify_shared_es5_helper(fn_decl)
                    .map(|kind| (index, fn_decl.ident.sym.to_string(), kind))
            })
            .collect::<Vec<_>>();

        let removed_indices = helper_bindings
            .iter()
            .map(|(index, _, _)| *index)
            .collect::<HashSet<_>>();
        module.body = module
            .body
            .iter()
            .enumerate()
            .filter_map(|(index, item)| (!removed_indices.contains(&index)).then_some(item.clone()))
            .collect();

        let mut module_scope_names = HashSet::new();
        collect_module_scope_names(module, &mut module_scope_names);

        let mut helper_name_to_kind = HashMap::new();
        for (_, helper_name, kind) in helper_bindings {
            helper_name_to_kind.insert(helper_name, kind);
        }
        if !module_scope_names.contains("ta") {
            helper_name_to_kind.insert("ta".to_string(), SharedEs5HelperKind::ClosureTemplateObject);
        }
        if !module_scope_names.contains("qa") {
            helper_name_to_kind.insert("qa".to_string(), SharedEs5HelperKind::ClosureInherits);
        }
        let mut rewriter = TopLevelHelperReferenceRewriter {
            helper_alias: helper_alias.to_string(),
            helper_name_to_kind,
            rewritten_helper_kinds: BTreeSet::new(),
            rewrite_closure_global: !module_scope_names.contains("ha"),
            rewrote_closure_global: false,
        };
        module.visit_mut_with(&mut rewriter);
        if rewriter.rewrote_closure_global {
            self.changed = true;
        }
        rewriter.rewritten_helper_kinds
    }
}

impl VisitMut for Es5HelperChunkRewriter {
    fn visit_mut_module(&mut self, module: &mut Module) {
        let mut names = HashSet::new();
        collect_module_scope_names(module, &mut names);
        let runtime_alias = next_available_alias(&names, &["G", "$G", "G$", "_G", "__G"]);
        names.insert(runtime_alias.clone());
        let helper_alias = next_available_alias(&names, &["_", "$", "$_", "_$", "__"]);
        let previous_aliases = self
            .shared_module_aliases
            .replace((runtime_alias.clone(), helper_alias.clone()));
        self.module_alias_used.push(false);
        let top_level_helper_kinds = self.rewrite_module_items(module, &helper_alias);
        if !top_level_helper_kinds.is_empty() {
            if let Some(module_alias_used) = self.module_alias_used.last_mut() {
                *module_alias_used = true;
            }
            self.helper_kinds.extend(top_level_helper_kinds);
            self.changed = true;
        }
        for item in &mut module.body {
            item.visit_mut_children_with(self);
        }
        let should_insert_module_alias = self.module_alias_used.pop().unwrap_or(false);
        self.shared_module_aliases = previous_aliases;
        if should_insert_module_alias {
            module
                .body
                .insert(0, ModuleItem::Stmt(helper_alias_decl(&runtime_alias, &helper_alias)));
        }
    }

    fn visit_mut_function(&mut self, function: &mut Function) {
        if let Some(body) = function.body.as_mut() {
            let mut current_scope_names = HashSet::new();
            for param in &function.params {
                collect_binding_names_from_pat(&param.pat, &mut current_scope_names);
            }
            self.rewrite_block_stmt(body, current_scope_names);
            for stmt in &mut body.stmts {
                stmt.visit_mut_children_with(self);
            }
        }
    }
}

struct HelperReferenceRewriter {
    helper_alias: String,
    helper_name_to_kind: HashMap<String, SharedEs5HelperKind>,
    rewritten_helper_kinds: BTreeSet<SharedEs5HelperKind>,
    scope_stack: Vec<HashSet<String>>,
    rewrite_closure_global: bool,
    rewrote_closure_global: bool,
}

impl HelperReferenceRewriter {
    fn is_shadowed(&self, name: &str) -> bool {
        self.scope_stack
            .iter()
            .rev()
            .any(|scope| scope.contains(name))
    }
}

struct TopLevelHelperReferenceRewriter {
    helper_alias: String,
    helper_name_to_kind: HashMap<String, SharedEs5HelperKind>,
    rewritten_helper_kinds: BTreeSet<SharedEs5HelperKind>,
    rewrite_closure_global: bool,
    rewrote_closure_global: bool,
}

impl VisitMut for TopLevelHelperReferenceRewriter {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        match expr {
            Expr::Fn(fn_expr) => {
                self.visit_mut_fn_expr(fn_expr);
                return;
            }
            Expr::Arrow(arrow) => {
                self.visit_mut_arrow_expr(arrow);
                return;
            }
            _ => {}
        }
        expr.visit_mut_children_with(self);
        let Expr::Ident(ident) = expr else {
            return;
        };
        let helper_name = ident.sym.to_string();
        if self.rewrite_closure_global && helper_name == "ha" {
            self.rewrote_closure_global = true;
            *expr = global_this_expr();
            return;
        }
        let Some(kind) = self.helper_name_to_kind.get(&helper_name).copied() else {
            return;
        };
        self.rewritten_helper_kinds.insert(kind);
        *expr = helper_slot_expr(&self.helper_alias, kind.slot());
    }

    fn visit_mut_function(&mut self, _: &mut Function) {}
    fn visit_mut_fn_expr(&mut self, _: &mut FnExpr) {}
    fn visit_mut_fn_decl(&mut self, _: &mut FnDecl) {}
    fn visit_mut_arrow_expr(&mut self, _: &mut ArrowExpr) {}
}

impl VisitMut for HelperReferenceRewriter {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        match expr {
            Expr::Fn(fn_expr) => {
                self.visit_mut_fn_expr(fn_expr);
                return;
            }
            Expr::Arrow(arrow) => {
                self.visit_mut_arrow_expr(arrow);
                return;
            }
            _ => {}
        }
        expr.visit_mut_children_with(self);
        let Expr::Ident(ident) = expr else {
            return;
        };
        let helper_name = ident.sym.to_string();
        if self.rewrite_closure_global && helper_name == "ha" && !self.is_shadowed(&helper_name) {
            self.rewrote_closure_global = true;
            *expr = global_this_expr();
            return;
        }
        let Some(kind) = self.helper_name_to_kind.get(&helper_name).copied() else {
            return;
        };
        if self.is_shadowed(&helper_name) {
            return;
        }
        self.rewritten_helper_kinds.insert(kind);
        *expr = helper_slot_expr(&self.helper_alias, kind.slot());
    }

    fn visit_mut_function(&mut self, function: &mut Function) {
        let mut scope = HashSet::new();
        collect_function_scope(function, &mut scope);
        self.scope_stack.push(scope);
        function.visit_mut_children_with(self);
        self.scope_stack.pop();
    }

    fn visit_mut_fn_expr(&mut self, function_expr: &mut FnExpr) {
        let mut scope = HashSet::new();
        if let Some(ident) = function_expr.ident.as_ref() {
            scope.insert(ident.sym.to_string());
        }
        collect_function_scope(&function_expr.function, &mut scope);
        self.scope_stack.push(scope);
        if let Some(ident) = function_expr.ident.as_mut() {
            ident.visit_mut_children_with(self);
        }
        function_expr.function.visit_mut_children_with(self);
        self.scope_stack.pop();
    }

    fn visit_mut_fn_decl(&mut self, function_decl: &mut FnDecl) {
        let mut scope = HashSet::new();
        scope.insert(function_decl.ident.sym.to_string());
        collect_function_scope(&function_decl.function, &mut scope);
        self.scope_stack.push(scope);
        function_decl.function.visit_mut_children_with(self);
        self.scope_stack.pop();
    }

    fn visit_mut_arrow_expr(&mut self, arrow: &mut ArrowExpr) {
        let mut scope = HashSet::new();
        for param in &arrow.params {
            collect_binding_names_from_pat(param, &mut scope);
        }
        if let BlockStmtOrExpr::BlockStmt(body) = &*arrow.body {
            collect_function_scope_names(body, &mut scope);
        }
        self.scope_stack.push(scope);
        arrow.visit_mut_children_with(self);
        self.scope_stack.pop();
    }
}

fn collect_function_scope(function: &Function, names: &mut HashSet<String>) {
    for param in &function.params {
        collect_binding_names_from_pat(&param.pat, names);
    }
    if let Some(body) = function.body.as_ref() {
        collect_function_scope_names(body, names);
    }
}

fn classify_shared_es5_helper(fn_decl: &FnDecl) -> Option<SharedEs5HelperKind> {
    let printed = print_function_decl_minified(fn_decl).ok()?;
    if printed.contains("Cannot add initializers after decoration has completed") {
        return Some(SharedEs5HelperKind::EsDecorate);
    }
    if printed.contains("Cannot write private member to an object whose class did not declare it") {
        return Some(SharedEs5HelperKind::ClassPrivateFieldSet);
    }
    if printed.contains("Cannot read private member from an object whose class did not declare it") {
        return Some(SharedEs5HelperKind::ClassPrivateFieldGet);
    }
    if printed.contains("Object.defineProperty(") && printed.contains(",\"name\",") {
        return Some(SharedEs5HelperKind::SetFunctionName);
    }
    if printed.contains("arguments.length>2") && printed.contains(".call(") {
        return Some(SharedEs5HelperKind::RunInitializers);
    }
    None
}
