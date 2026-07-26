use super::*;
use swc_core::ecma::ast::{KeyValueProp, Prop, PropOrSpread};

pub(crate) fn collect_class_static_assignments(source_text: &str) -> Vec<(String, String)> {
    let class_binding_regex = match regex::Regex::new(
        r"\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*class\b|class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b",
    ) {
        Ok(regex) => regex,
        Err(_) => return Vec::new(),
    };
    let assignment_regex =
        match regex::Regex::new(r"([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=") {
            Ok(regex) => regex,
            Err(_) => return Vec::new(),
        };

    let mut class_bindings = HashSet::new();
    for captures in class_binding_regex.captures_iter(source_text) {
        if let Some(capture) = captures.get(1).or_else(|| captures.get(2)) {
            class_bindings.insert(capture.as_str().to_string());
        }
    }

    let mut assignments = Vec::new();
    for captures in assignment_regex.captures_iter(source_text) {
        let class_name = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        let property_name = captures
            .get(2)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        if class_bindings.contains(class_name) {
            assignments.push((class_name.to_string(), property_name.to_string()));
        }
    }

    assignments
}

/// Quotes object-literal keys passed to configured runtime calls (for
/// example a framework's class-map helper) so Closure never renames keys
/// that must match CSS class names at runtime. The call list comes from
/// build options; framework presets supply their runtime's helpers.
pub(crate) struct ClassMapCallCompatVisitor {
    calls: HashMap<String, Vec<usize>>,
}

impl ClassMapCallCompatVisitor {
    pub(crate) fn new(calls: &[ClassMapCallInput]) -> Self {
        let mut grouped: HashMap<String, Vec<usize>> = HashMap::new();
        for call in calls {
            grouped
                .entry(call.callee.clone())
                .or_default()
                .push(call.argIndex as usize);
        }
        Self { calls: grouped }
    }
}

impl VisitMut for ClassMapCallCompatVisitor {
    fn visit_mut_call_expr(&mut self, call: &mut CallExpr) {
        call.visit_mut_children_with(self);

        let Callee::Expr(callee) = &call.callee else {
            return;
        };
        let Expr::Ident(callee) = callee.as_ref() else {
            return;
        };
        let Some(arg_indexes) = self.calls.get(callee.sym.as_ref()) else {
            return;
        };
        for arg_index in arg_indexes {
            let Some(class_map) = call.args.get_mut(*arg_index) else {
                continue;
            };
            let Expr::Object(class_map) = class_map.expr.as_mut() else {
                continue;
            };
            quote_object_literal_keys(class_map);
        }
    }
}

fn quote_object_literal_keys(class_map: &mut swc_core::ecma::ast::ObjectLit) {
    for property in &mut class_map.props {
        let PropOrSpread::Prop(property) = property else {
            continue;
        };
        match property.as_mut() {
            Prop::Shorthand(ident) => {
                *property = Box::new(Prop::KeyValue(KeyValueProp {
                    key: quote_prop_name(PropName::Ident(ident.clone().into())),
                    value: Box::new(Expr::Ident(ident.clone())),
                }));
            }
            Prop::KeyValue(property) => {
                property.key = quote_prop_name(property.key.clone());
            }
            Prop::Getter(property) => {
                property.key = quote_prop_name(property.key.clone());
            }
            Prop::Setter(property) => {
                property.key = quote_prop_name(property.key.clone());
            }
            Prop::Method(property) => {
                property.key = quote_prop_name(property.key.clone());
            }
            Prop::Assign(_) => {}
        }
    }
}

pub(crate) struct PreservedPropertyCompatVisitor {
    property_names: HashSet<String>,
}

impl PreservedPropertyCompatVisitor {
    pub(crate) fn new(property_names: HashSet<String>) -> Self {
        Self { property_names }
    }
}

impl VisitMut for PreservedPropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        match expr {
            Expr::Member(member) => {
                if member.prop.is_computed() {
                    return;
                }
                let MemberProp::Ident(prop_ident) = &member.prop else {
                    return;
                };
                if !self.property_names.contains(prop_ident.sym.as_ref()) {
                    return;
                }

                member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
            }
            Expr::SuperProp(super_prop) => {
                let SuperProp::Ident(prop_ident) = &super_prop.prop else {
                    return;
                };
                if !self.property_names.contains(prop_ident.sym.as_ref()) {
                    return;
                }

                super_prop.prop = create_string_computed_super_prop(prop_ident.sym.as_ref());
            }
            _ => {}
        }
    }

    fn visit_mut_prop(&mut self, prop: &mut Prop) {
        if let Prop::Shorthand(ident) = prop {
            if self.property_names.contains(ident.sym.as_ref()) {
                *prop = Prop::KeyValue(KeyValueProp {
                    key: quote_prop_name(PropName::Ident(ident.clone().into())),
                    value: Box::new(Expr::Ident(ident.clone())),
                });
                return;
            }
        }
        prop.visit_mut_children_with(self);
    }

    fn visit_mut_prop_name(&mut self, prop_name: &mut PropName) {
        prop_name.visit_mut_children_with(self);

        let PropName::Ident(ident) = prop_name else {
            return;
        };
        if !self.property_names.contains(ident.sym.as_ref()) {
            return;
        }

        *prop_name = quote_prop_name(prop_name.clone());
    }
}

pub(crate) fn quote_prop_name(prop_name: PropName) -> PropName {
    match prop_name {
        PropName::Ident(ident) => PropName::Str(Str {
            span: Default::default(),
            value: ident.sym.to_string().into(),
            raw: None,
        }),
        PropName::Num(number) => PropName::Str(Str {
            span: Default::default(),
            value: number.value.to_string().into(),
            raw: None,
        }),
        other => other,
    }
}
