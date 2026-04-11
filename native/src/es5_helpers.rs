use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;

use napi_derive::napi;
use swc_core::common::{sync::Lrc, SourceMap};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::visit::{Visit, VisitMut, VisitMutWith, VisitWith};

use crate::module_cache::parse_module;

#[napi(object)]
pub struct Es5HelperRewriteOutput {
    pub code: String,
    #[napi(js_name = "helperKeys")]
    pub helper_keys: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum SharedEs5HelperKind {
    ClassPrivateFieldSet,
    ClassPrivateFieldGet,
    SetFunctionName,
    RunInitializers,
    EsDecorate,
    ClosureTemplateObject,
    ClosureInherits,
}

impl SharedEs5HelperKind {
    fn key(self) -> &'static str {
        match self {
            Self::ClassPrivateFieldSet => "class-private-field-set",
            Self::ClassPrivateFieldGet => "class-private-field-get",
            Self::SetFunctionName => "set-function-name",
            Self::RunInitializers => "run-initializers",
            Self::EsDecorate => "es-decorate",
            Self::ClosureTemplateObject => "closure-template-object",
            Self::ClosureInherits => "closure-inherits",
        }
    }

    fn slot(self) -> usize {
        match self {
            Self::ClassPrivateFieldSet => 0,
            Self::ClassPrivateFieldGet => 1,
            Self::SetFunctionName => 2,
            Self::RunInitializers => 3,
            Self::EsDecorate => 4,
            Self::ClosureTemplateObject => 5,
            Self::ClosureInherits => 6,
        }
    }
}

pub fn rewrite_bundler_runtime_es5_helpers(
    code: String,
) -> std::result::Result<Es5HelperRewriteOutput, String> {
    let mut module = parse_module(&PathBuf::from("bundler-runtime-es5.js"), &code)?;
    let mut rewriter = Es5HelperChunkRewriter {
        changed: false,
        helper_kinds: BTreeSet::new(),
        shared_module_aliases: None,
        module_alias_used: Vec::new(),
    };
    module.visit_mut_with(&mut rewriter);
    let rewritten_code = if rewriter.changed {
        print_module_minified(&module)?
    } else {
        code
    };
    Ok(Es5HelperRewriteOutput {
        code: rewritten_code,
        helper_keys: rewriter
            .helper_kinds
            .into_iter()
            .map(|kind| kind.key().to_string())
            .collect(),
    })
}

struct Es5HelperChunkRewriter {
    changed: bool,
    helper_kinds: BTreeSet<SharedEs5HelperKind>,
    shared_module_aliases: Option<(String, String)>,
    module_alias_used: Vec<bool>,
}

impl Es5HelperChunkRewriter {
    fn rewrite_block_stmt(
        &mut self,
        block: &mut BlockStmt,
        mut names: HashSet<String>,
    ) {
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
                let runtime_alias =
                    next_available_alias(&names, &["G", "$G", "G$", "_G", "__G"]);
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
                classify_shared_es5_helper(fn_decl).map(|kind| (index, fn_decl.ident.sym.to_string(), kind))
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

impl Es5HelperChunkRewriter {
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
            helper_name_to_kind.insert(
                "ta".to_string(),
                SharedEs5HelperKind::ClosureTemplateObject,
            );
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

fn helper_slot_expr(helper_alias: &str, slot: usize) -> Expr {
    Expr::Member(MemberExpr {
        span: Default::default(),
        obj: Box::new(Expr::Ident(Ident::new(
            helper_alias.into(),
            Default::default(),
            Default::default(),
        ))),
        prop: MemberProp::Computed(ComputedPropName {
            span: Default::default(),
            expr: Box::new(Expr::Lit(Lit::Num(Number {
                span: Default::default(),
                value: slot as f64,
                raw: None,
            }))),
        }),
    })
}

fn global_this_expr() -> Expr {
    Expr::Ident(Ident::new(
        "globalThis".into(),
        Default::default(),
        Default::default(),
    ))
}

fn helper_alias_decl(runtime_alias: &str, helper_alias: &str) -> Stmt {
    Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span: Default::default(),
        ctxt: Default::default(),
        declare: false,
        kind: VarDeclKind::Var,
        decls: vec![
            VarDeclarator {
                span: Default::default(),
                name: Pat::Ident(BindingIdent {
                    id: Ident::new(
                        runtime_alias.into(),
                        Default::default(),
                        Default::default(),
                    ),
                    type_ann: None,
                }),
                init: Some(Box::new(Expr::Member(MemberExpr {
                    span: Default::default(),
                    obj: Box::new(Expr::Ident(Ident::new(
                        "globalThis".into(),
                        Default::default(),
                        Default::default(),
                    ))),
                    prop: MemberProp::Ident(IdentName::new("__g".into(), Default::default())),
                }))),
                definite: false,
            },
            VarDeclarator {
                span: Default::default(),
                name: Pat::Ident(BindingIdent {
                    id: Ident::new(
                        helper_alias.into(),
                        Default::default(),
                        Default::default(),
                    ),
                    type_ann: None,
                }),
                init: Some(Box::new(Expr::Member(MemberExpr {
                    span: Default::default(),
                    obj: Box::new(Expr::Ident(Ident::new(
                        runtime_alias.into(),
                        Default::default(),
                        Default::default(),
                    ))),
                    prop: MemberProp::Ident(IdentName::new("_".into(), Default::default())),
                }))),
                definite: false,
            },
        ],
        ..Default::default()
    })))
}

fn next_available_alias(names: &HashSet<String>, candidates: &[&str]) -> String {
    for candidate in candidates {
        if !names.contains(*candidate) {
            return (*candidate).to_string();
        }
    }
    let mut suffix = 0usize;
    loop {
        let candidate = format!("__{suffix}");
        if !names.contains(&candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

fn collect_function_scope_names(block: &BlockStmt, names: &mut HashSet<String>) {
    let mut collector = FunctionScopeNameCollector { names };
    block.visit_with(&mut collector);
}

fn collect_module_scope_names(module: &Module, names: &mut HashSet<String>) {
    let mut collector = FunctionScopeNameCollector { names };
    module.visit_with(&mut collector);
}

struct FunctionScopeNameCollector<'a> {
    names: &'a mut HashSet<String>,
}

impl Visit for FunctionScopeNameCollector<'_> {
    fn visit_function(&mut self, _: &Function) {}

    fn visit_arrow_expr(&mut self, _: &ArrowExpr) {}

    fn visit_fn_decl(&mut self, fn_decl: &FnDecl) {
        self.names.insert(fn_decl.ident.sym.to_string());
    }

    fn visit_class_decl(&mut self, class_decl: &ClassDecl) {
        self.names.insert(class_decl.ident.sym.to_string());
    }

    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        collect_binding_names_from_pat(&declarator.name, self.names);
        declarator.visit_children_with(self);
    }
}

fn collect_binding_names_from_pat(pattern: &Pat, names: &mut HashSet<String>) {
    match pattern {
        Pat::Ident(binding) => {
            names.insert(binding.id.sym.to_string());
        }
        Pat::Array(array) => {
            for element in array.elems.iter().flatten() {
                collect_binding_names_from_pat(element, names);
            }
        }
        Pat::Assign(assign) => collect_binding_names_from_pat(&assign.left, names),
        Pat::Object(object) => {
            for prop in &object.props {
                match prop {
                    ObjectPatProp::Assign(assign) => {
                        names.insert(assign.key.sym.to_string());
                    }
                    ObjectPatProp::KeyValue(key_value) => {
                        collect_binding_names_from_pat(&key_value.value, names);
                    }
                    ObjectPatProp::Rest(rest) => collect_binding_names_from_pat(&rest.arg, names),
                }
            }
        }
        Pat::Rest(rest) => collect_binding_names_from_pat(&rest.arg, names),
        _ => {}
    }
}

fn print_module_minified(module: &Module) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: CodegenConfig::default().with_minify(true),
            cm,
            comments: None,
            wr: writer,
        };
        emitter
            .emit_module(module)
            .map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

fn print_function_decl_minified(function_decl: &FnDecl) -> std::result::Result<String, String> {
    print_module_minified(&Module {
        span: Default::default(),
        body: vec![ModuleItem::Stmt(Stmt::Decl(Decl::Fn(function_decl.clone())))],
        shebang: None,
    })
}

#[cfg(test)]
mod tests {
    use super::rewrite_bundler_runtime_es5_helpers;

    #[test]
    fn rewrites_shared_es5_helper_families() {
        let code = r#"
          (function(global){global.__g=global.__g||{};}).call(this, globalThis);
          M("m0", function(a){
            function e(u,w,C,z,g){if(z==="m")throw new TypeError("Private method is not writable");if(z==="a"&&!g)throw new TypeError("Private accessor was defined without a setter");if(typeof w==="function"?u!==w||!g:!w.has(u))throw new TypeError("Cannot write private member to an object whose class did not declare it");return z==="a"?g.call(u,C):g?g.value=C:w.set(u,C),C;}
            function l(u,w,C,z){if(C==="a"&&!z)throw new TypeError("Private accessor was defined without a getter");if(typeof w==="function"?u!==w||!z:!w.has(u))throw new TypeError("Cannot read private member from an object whose class did not declare it");return C==="m"?z:C==="a"?z.call(u):z?z.value:w.get(u);}
            function n(u,w,C){typeof w==="symbol"&&(w=w.description?"[".concat(w.description,"]"):"");return Object.defineProperty(u,"name",{configurable:!0,value:C?"".concat(C," ",w):w});}
            function r(u,w,C){for(var z=arguments.length>2,g=0;g<w.length;g++)C=z?w[g].call(u,C):w[g].call(u);return z?C:void 0;}
            function q(u,w,C,z,g,c){function k(Q){if(Q!==void 0&&typeof Q!=="function")throw new TypeError("Function expected");return Q;}var p=z.kind,t=p==="getter"?"get":p==="setter"?"set":"value";u=!w&&u?z["static"]?u:u.prototype:null;w=w||(u?Object.getOwnPropertyDescriptor(u,z.name):{});for(var m,A=!1,G=C.length-1;G>=0;G--){m={};for(var E in z)m[E]=E==="access"?{}:z[E];for(E in z.access)m.access[E]=z.access[E];m.addInitializer=function(Q){if(A)throw new TypeError("Cannot add initializers after decoration has completed");c.push(k(Q||null));};var K=(0,C[G])(p==="accessor"?{get:w.get,set:w.set}:w[t],m);if(p==="accessor"){if(K!==void 0){if(K===null||typeof K!=="object")throw new TypeError("Object expected");if(m=k(K.get))w.get=m;if(m=k(K.set))w.set=m;(m=k(K.init))&&g.unshift(m);}}else if(m=k(K))p==="field"?g.unshift(m):w[t]=m;}u&&Object.defineProperty(u,z.name,w);A=!0;}
            var P = new WeakMap;
            n(foo, "Foo");
            q(foo, null, [], {kind:"method", name:"bar", access:{}}, [], []);
            r(foo, []);
            e(foo, P, 1, "f");
            l(foo, P, "f");
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(rewritten.code.contains("var G=globalThis.__g,_=G._;"));
        assert!(rewritten.helper_keys.contains(&"es-decorate".to_string()));
        assert!(rewritten.helper_keys.contains(&"run-initializers".to_string()));
        assert!(rewritten.helper_keys.contains(&"set-function-name".to_string()));
        assert!(rewritten.helper_keys.contains(&"class-private-field-get".to_string()));
        assert!(rewritten.helper_keys.contains(&"class-private-field-set".to_string()));
        assert!(!rewritten
            .code
            .contains("Cannot add initializers after decoration has completed"));
    }

    #[test]
    fn rewrites_shared_closure_support_references() {
        let code = r#"
          M("m0", function(a){
            var tpl = ta(["x"]);
            function Child() { return Parent.apply(this, arguments) || this; }
            qa(Child, Parent);
            ha.Object.defineProperties(Child.prototype, {});
            return tpl;
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(rewritten.code.contains("var G=globalThis.__g,_=G._;"));
        assert!(rewritten
            .helper_keys
            .contains(&"closure-template-object".to_string()));
        assert!(rewritten
            .helper_keys
            .contains(&"closure-inherits".to_string()));
        assert!(!rewritten.code.contains("ta(["));
        assert!(!rewritten.code.contains("qa(Child,Parent)"));
        assert!(rewritten
            .code
            .contains("globalThis.Object.defineProperties"));
    }

    #[test]
    fn leaves_shadowed_short_local_names_alone() {
        let code = r#"
          M("m0", function(a){
            function render(){
              var tpl = 0, ta = 1, qa = 2, ha = {};
              x(ta, qa, ha);
            }
            render();
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(!rewritten.code.contains("var G=globalThis.__g,_=G._;"));
        assert!(rewritten.code.contains("x(ta, qa, ha)"));
        assert!(!rewritten.code.contains("_[5]"));
        assert!(!rewritten.code.contains("_[6]"));
    }

    #[test]
    fn rewrites_top_level_closure_global_without_helper_slot() {
        let code = r#"
          M("m0", function(a){
            function Child() {}
            ha.Object.defineProperties(Child.prototype, {});
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(!rewritten.helper_keys.contains(&"closure-global".to_string()));
        assert!(rewritten
            .code
            .contains("globalThis.Object.defineProperties"));
        assert!(!rewritten.code.contains("ha.Object.defineProperties"));
    }

    #[test]
    fn leaves_shadowed_nested_function_params_alone() {
        let code = r#"
          M("m0", function(a){
            p(0, {
              children: function(ha){
                var ia = q();
                k(ha, ia);
              }
            });
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(rewritten.code.contains("k(ha, ia)"));
    }
}
