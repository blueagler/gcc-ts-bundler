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
    calls: HashMap<String, Vec<(usize, Option<regex::Regex>)>>,
    /// local import binding name -> imported export name, so compiler
    /// aliases like `_createElementVNode` still match the configured callee.
    import_aliases: HashMap<String, String>,
}

impl ClassMapCallCompatVisitor {
    pub(crate) fn new(
        calls: &[ClassMapCallInput],
        import_aliases: HashMap<String, String>,
    ) -> Self {
        let mut grouped: HashMap<String, Vec<(usize, Option<regex::Regex>)>> = HashMap::new();
        for call in calls {
            let key_pattern = call
                .keyPattern
                .as_deref()
                .and_then(|pattern| regex::Regex::new(pattern).ok());
            grouped
                .entry(call.callee.clone())
                .or_default()
                .push((call.argIndex as usize, key_pattern));
        }
        Self {
            calls: grouped,
            import_aliases,
        }
    }
}

pub(crate) fn collect_import_alias_names(module: &Module) -> HashMap<String, String> {
    let mut aliases = HashMap::new();
    for item in &module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) = item
        else {
            continue;
        };
        for specifier in &import_decl.specifiers {
            if let ImportSpecifier::Named(named) = specifier {
                let imported = named
                    .imported
                    .as_ref()
                    .map(module_export_name_to_string)
                    .unwrap_or_else(|| named.local.sym.to_string());
                aliases.insert(named.local.sym.to_string(), imported);
            }
        }
    }
    aliases
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
        let callee_name = self
            .import_aliases
            .get(callee.sym.as_ref())
            .map(String::as_str)
            .unwrap_or(callee.sym.as_ref());
        let Some(arg_rules) = self.calls.get(callee_name) else {
            return;
        };
        for (arg_index, key_pattern) in arg_rules {
            let Some(class_map) = call.args.get_mut(*arg_index) else {
                continue;
            };
            let Expr::Object(class_map) = class_map.expr.as_mut() else {
                continue;
            };
            quote_object_literal_keys(class_map, key_pattern.as_ref());
        }
    }
}

fn quote_object_literal_keys(
    class_map: &mut swc_core::ecma::ast::ObjectLit,
    key_pattern: Option<&regex::Regex>,
) {
    let matches_pattern = |name: &str| {
        key_pattern
            .map(|pattern| pattern.is_match(name))
            .unwrap_or(true)
    };
    let prop_name_matches = |prop_name: &PropName| match prop_name {
        PropName::Ident(ident) => matches_pattern(ident.sym.as_ref()),
        PropName::Num(_) => key_pattern.is_none(),
        _ => false,
    };
    for property in &mut class_map.props {
        let PropOrSpread::Prop(property) = property else {
            continue;
        };
        match property.as_mut() {
            Prop::Shorthand(ident) => {
                if matches_pattern(ident.sym.as_ref()) {
                    **property = Prop::KeyValue(KeyValueProp {
                        key: quote_prop_name(PropName::Ident(ident.clone().into())),
                        value: Box::new(Expr::Ident(ident.clone())),
                    });
                }
            }
            Prop::KeyValue(property) => {
                if prop_name_matches(&property.key) {
                    property.key = quote_prop_name(property.key.clone());
                }
            }
            Prop::Getter(property) => {
                if prop_name_matches(&property.key) {
                    property.key = quote_prop_name(property.key.clone());
                }
            }
            Prop::Setter(property) => {
                if prop_name_matches(&property.key) {
                    property.key = quote_prop_name(property.key.clone());
                }
            }
            Prop::Method(property) => {
                if prop_name_matches(&property.key) {
                    property.key = quote_prop_name(property.key.clone());
                }
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
    // Member expressions appear both as `Expr::Member` and as assignment
    // targets (`SimpleAssignTarget::Member`); this hook covers every
    // position, so static writes (`Klass.opts = ...`) get quoted too.
    fn visit_mut_member_expr(&mut self, member: &mut swc_core::ecma::ast::MemberExpr) {
        member.visit_mut_children_with(self);

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

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        if let Expr::SuperProp(super_prop) = expr {
            let SuperProp::Ident(prop_ident) = &super_prop.prop else {
                return;
            };
            if !self.property_names.contains(prop_ident.sym.as_ref()) {
                return;
            }

            super_prop.prop = create_string_computed_super_prop(prop_ident.sym.as_ref());
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

    /// A quoted class field without an initializer (`["id"];`) crashes
    /// Closure with an internal compiler error in ConvertToDottedProperties,
    /// so quoting adds the semantically identical explicit `void 0`.
    fn visit_mut_class_prop(&mut self, class_prop: &mut swc_core::ecma::ast::ClassProp) {
        class_prop.visit_mut_children_with(self);

        let quoted_key = matches!(class_prop.key, PropName::Str(_) | PropName::Computed(_));
        if class_prop.value.is_none() && quoted_key {
            class_prop.value = Some(Box::new(Expr::Unary(swc_core::ecma::ast::UnaryExpr {
                arg: Box::new(Expr::Lit(Lit::Num(swc_core::ecma::ast::Number {
                    raw: None,
                    span: Default::default(),
                    value: 0.0,
                }))),
                op: swc_core::ecma::ast::UnaryOp::Void,
                span: Default::default(),
            })));
        }
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
