use std::collections::HashSet;

use swc_core::common::{sync::Lrc, SourceMap};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::visit::{Visit, VisitWith};

pub(super) fn helper_slot_expr(helper_alias: &str, slot: usize) -> Expr {
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

pub(super) fn helper_alias_decl(runtime_alias: &str, helper_alias: &str) -> Stmt {
    Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span: Default::default(),
        ctxt: Default::default(),
        declare: false,
        kind: VarDeclKind::Var,
        decls: vec![
            VarDeclarator {
                span: Default::default(),
                name: Pat::Ident(BindingIdent {
                    id: Ident::new(runtime_alias.into(), Default::default(), Default::default()),
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
                    id: Ident::new(helper_alias.into(), Default::default(), Default::default()),
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

pub(super) fn next_available_alias(names: &HashSet<String>, candidates: &[&str]) -> String {
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

pub(super) fn collect_function_scope_names(block: &BlockStmt, names: &mut HashSet<String>) {
    let mut collector = FunctionScopeNameCollector { names };
    block.visit_with(&mut collector);
}

pub(super) fn collect_module_scope_names(module: &Module, names: &mut HashSet<String>) {
    let mut collector = FunctionScopeNameCollector { names };
    module.visit_with(&mut collector);
}

pub(super) fn collect_binding_names_from_pat(pattern: &Pat, names: &mut HashSet<String>) {
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

pub(super) fn print_module_minified(module: &Module) -> std::result::Result<String, String> {
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

pub(super) fn print_function_decl_minified(
    function_decl: &FnDecl,
) -> std::result::Result<String, String> {
    print_module_minified(&Module {
        span: Default::default(),
        body: vec![ModuleItem::Stmt(Stmt::Decl(Decl::Fn(
            function_decl.clone(),
        )))],
        shebang: None,
    })
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
