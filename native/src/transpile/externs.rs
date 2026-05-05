mod analysis;
mod render;

#[cfg(test)]
use super::*;

pub(super) use self::analysis::collect_extern_property_names_with_externs;
#[cfg(test)]
pub(super) use self::analysis::{
    collect_extern_property_names, collect_preserved_property_names,
    collect_static_property_names_from_text,
};
pub(super) use self::analysis::{
    is_valid_js_identifier, prop_name_to_string, ExternPropertyAnalysis,
};
#[cfg(test)]
pub(super) use self::render::render_externs;
pub(super) use self::render::render_generated_externs;

#[cfg(test)]
pub(super) fn collect_commonjs_extern_names(
    module: &Module,
    analysis: &crate::commonjs::CommonJsAnalysis,
) -> Vec<String> {
    let mut externs = analysis
        .export_names
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let object_bindings = collect_top_level_object_bindings(module);

    for item in &module.body {
        let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = item else {
            continue;
        };
        let Expr::Assign(assign) = &**expr else {
            continue;
        };
        if assign.op != swc_core::ecma::ast::AssignOp::Assign {
            continue;
        }
        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Member(member),
        ) = &assign.left
        else {
            continue;
        };
        if !is_commonjs_export_member_expr(member) && !is_module_exports_member_expr(member) {
            continue;
        }
        let Expr::Ident(ident) = &*assign.right else {
            continue;
        };
        if let Some(bound_props) = object_bindings.get(ident.sym.as_ref()) {
            externs.extend(bound_props.iter().cloned());
        }
    }

    externs.into_iter().collect()
}

#[cfg(test)]
pub(super) fn collect_top_level_object_bindings(
    module: &Module,
) -> HashMap<String, BTreeSet<String>> {
    let mut bindings = HashMap::new();

    for item in &module.body {
        let ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::Var(var_decl))) = item else {
            continue;
        };
        for declarator in &var_decl.decls {
            let Pat::Ident(binding) = &declarator.name else {
                continue;
            };
            let Some(init) = &declarator.init else {
                continue;
            };
            let Expr::Object(object) = &**init else {
                continue;
            };
            let props = object_literal_prop_names(object);
            if !props.is_empty() {
                bindings.insert(binding.id.sym.to_string(), props);
            }
        }
    }

    bindings
}

#[cfg(test)]
pub(super) fn collect_protocol_extern_names(module: &Module) -> BTreeSet<String> {
    let mut collector = ProtocolExternCollector::default();
    module.visit_with(&mut collector);
    collector.names
}

#[cfg(test)]
pub(super) fn collect_enum_extern_names(module: &Module) -> BTreeSet<String> {
    collect_enum_extern_specs(module)
        .into_values()
        .flatten()
        .collect()
}

#[cfg(test)]
pub(super) fn collect_enum_extern_specs(module: &Module) -> BTreeMap<String, BTreeSet<String>> {
    let mut collector = EnumExternCollector::default();
    module.visit_with(&mut collector);
    collector.enums
}

#[cfg(test)]
#[derive(Default)]
struct EnumExternCollector {
    enums: BTreeMap<String, BTreeSet<String>>,
}

#[cfg(test)]
impl Visit for EnumExternCollector {
    fn visit_ts_enum_decl(&mut self, enum_decl: &swc_core::ecma::ast::TsEnumDecl) {
        let enum_name = enum_decl.id.sym.to_string();
        let entry = self.enums.entry(enum_name).or_default();
        for member in &enum_decl.members {
            match &member.id {
                TsEnumMemberId::Ident(ident) => {
                    entry.insert(ident.sym.to_string());
                }
                TsEnumMemberId::Str(value) => {
                    entry.insert(value.value.to_string_lossy().to_string());
                }
            }
        }
        enum_decl.visit_children_with(self);
    }
}

#[cfg(test)]
#[derive(Default)]
struct ProtocolExternCollector {
    names: BTreeSet<String>,
}

#[cfg(test)]
impl Visit for ProtocolExternCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);

        let Pat::Object(object_pat) = &declarator.name else {
            return;
        };
        let Some(init) = &declarator.init else {
            return;
        };
        let Expr::Ident(ident) = &**init else {
            return;
        };
        if !is_protocol_object_name(ident.sym.as_ref()) {
            return;
        }
        for prop in &object_pat.props {
            match prop {
                swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                    self.names.insert(assign.key.sym.to_string());
                }
                swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                    if let Some(name) = prop_name_to_string(&key_value.key) {
                        self.names.insert(name);
                    }
                }
                swc_core::ecma::ast::ObjectPatProp::Rest(_) => {}
            }
        }
    }

    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        member_expr.visit_children_with(self);

        let Expr::Ident(ident) = &*member_expr.obj else {
            return;
        };
        if !is_protocol_object_name(ident.sym.as_ref()) {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member_expr.prop else {
            return;
        };
        self.names.insert(prop_ident.sym.to_string());
    }
}

#[cfg(test)]
fn is_protocol_object_name(value: &str) -> bool {
    matches!(
        value,
        "config" | "configs" | "options" | "option" | "opts" | "factory" | "factories"
    )
}

#[cfg(test)]
pub(super) fn object_literal_prop_names(
    object: &swc_core::ecma::ast::ObjectLit,
) -> BTreeSet<String> {
    let mut props = BTreeSet::new();
    for property in &object.props {
        let swc_core::ecma::ast::PropOrSpread::Prop(prop) = property else {
            continue;
        };
        match &**prop {
            swc_core::ecma::ast::Prop::KeyValue(key_value) => {
                if let Some(name) = prop_name_to_string(&key_value.key) {
                    props.insert(name);
                }
            }
            swc_core::ecma::ast::Prop::Shorthand(ident) => {
                props.insert(ident.sym.to_string());
            }
            swc_core::ecma::ast::Prop::Method(method) => {
                if let Some(name) = prop_name_to_string(&method.key) {
                    props.insert(name);
                }
            }
            swc_core::ecma::ast::Prop::Getter(getter) => {
                if let Some(name) = prop_name_to_string(&getter.key) {
                    props.insert(name);
                }
            }
            swc_core::ecma::ast::Prop::Setter(setter) => {
                if let Some(name) = prop_name_to_string(&setter.key) {
                    props.insert(name);
                }
            }
            _ => {}
        }
    }
    props
}
