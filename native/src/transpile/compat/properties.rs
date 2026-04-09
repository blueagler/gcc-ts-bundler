use super::*;

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

pub(crate) struct StaticPropertyCompatVisitor {
    property_names: HashSet<String>,
}

impl StaticPropertyCompatVisitor {
    pub(crate) fn new(property_names: HashSet<String>) -> Self {
        Self { property_names }
    }
}

impl VisitMut for StaticPropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
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
}

pub(crate) struct InstanceMethodCompatVisitor {
    method_names: HashSet<String>,
}

impl InstanceMethodCompatVisitor {
    pub(crate) fn new(method_names: HashSet<String>) -> Self {
        Self { method_names }
    }
}

impl VisitMut for InstanceMethodCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        match expr {
            Expr::Member(member) => {
                if member.prop.is_computed() {
                    return;
                }
                let Expr::This(_) = &*member.obj else {
                    return;
                };
                let MemberProp::Ident(prop_ident) = &member.prop else {
                    return;
                };
                if !self.method_names.contains(prop_ident.sym.as_ref()) {
                    return;
                }

                member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
            }
            Expr::SuperProp(super_prop) => {
                let SuperProp::Ident(prop_ident) = &super_prop.prop else {
                    return;
                };
                if !self.method_names.contains(prop_ident.sym.as_ref()) {
                    return;
                }

                super_prop.prop = create_string_computed_super_prop(prop_ident.sym.as_ref());
            }
            _ => {}
        }
    }
}

pub(crate) fn collect_global_this_aliases(program: &Program) -> HashSet<String> {
    let mut collector = GlobalThisAliasCollector {
        aliases: HashSet::from(["globalThis".to_string()]),
    };
    program.visit_with(&mut collector);
    collector.aliases
}

struct GlobalThisAliasCollector {
    aliases: HashSet<String>,
}

impl Visit for GlobalThisAliasCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);

        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(init) = &declarator.init else {
            return;
        };
        let Expr::Ident(ident) = &**init else {
            return;
        };
        if self.aliases.contains(ident.sym.as_ref()) {
            self.aliases.insert(binding.id.sym.to_string());
        }
    }
}

pub(crate) struct GlobalThisPropertyCompatVisitor {
    aliases: HashSet<String>,
    property_names: HashSet<String>,
}

impl GlobalThisPropertyCompatVisitor {
    pub(crate) fn new(property_names: HashSet<String>, aliases: HashSet<String>) -> Self {
        Self {
            aliases,
            property_names,
        }
    }
}

impl VisitMut for GlobalThisPropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        };
        let Expr::Ident(object_ident) = &*member.obj else {
            return;
        };
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if self.aliases.contains(object_ident.sym.as_ref())
            && self.property_names.contains(prop_ident.sym.as_ref())
        {
            member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
        }
    }
}

pub(crate) struct ConstantLikePropertyCompatVisitor;
pub(crate) struct InternalProtocolMemberCompatVisitor;
pub(crate) struct UppercaseStaticMemberCompatVisitor;
pub(crate) struct DerivedClassMethodKeyCompatVisitor;

fn is_internal_protocol_name(name: &str) -> bool {
    name.starts_with('_') || name.contains('$')
}

impl VisitMut for InternalProtocolMemberCompatVisitor {
    fn visit_mut_member_expr(&mut self, member: &mut MemberExpr) {
        member.visit_mut_children_with(self);

        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_internal_protocol_name(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_internal_protocol_name(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }

    fn visit_mut_prop_name(&mut self, prop_name: &mut PropName) {
        prop_name.visit_mut_children_with(self);

        let PropName::Ident(ident) = prop_name else {
            return;
        };
        if !is_internal_protocol_name(ident.sym.as_ref()) {
            return;
        }

        *prop_name = PropName::Str(Str {
            span: Default::default(),
            value: ident.sym.to_string().into(),
            raw: None,
        });
    }

    fn visit_mut_class(&mut self, class: &mut swc_core::ecma::ast::Class) {
        class.visit_mut_children_with(self);
        for member in &mut class.body {
            match member {
                swc_core::ecma::ast::ClassMember::Method(method)
                    if prop_name_to_string(&method.key)
                        .map(|name| is_internal_protocol_name(&name))
                        .unwrap_or(false) =>
                {
                    method.key = quote_prop_name(method.key.clone());
                }
                swc_core::ecma::ast::ClassMember::ClassProp(prop)
                    if prop_name_to_string(&prop.key)
                        .map(|name| is_internal_protocol_name(&name))
                        .unwrap_or(false) =>
                {
                    prop.key = quote_prop_name(prop.key.clone());
                }
                _ => {}
            }
        }
    }
}

impl VisitMut for ConstantLikePropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_constant_like_property_name(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }

    fn visit_mut_prop_name(&mut self, prop_name: &mut PropName) {
        prop_name.visit_mut_children_with(self);

        let PropName::Ident(ident) = prop_name else {
            return;
        };
        if !is_constant_like_property_name(ident.sym.as_ref()) {
            return;
        }

        *prop_name = PropName::Str(Str {
            span: Default::default(),
            value: ident.sym.to_string().into(),
            raw: None,
        });
    }
}

impl VisitMut for UppercaseStaticMemberCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let Expr::Ident(object_ident) = &*member.obj else {
            return;
        };
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_component_like_name(object_ident.sym.as_ref())
            || !is_component_like_name(prop_ident.sym.as_ref())
        {
            return;
        }

        member.prop = MemberProp::Computed(swc_core::ecma::ast::ComputedPropName {
            span: Default::default(),
            expr: Box::new(Expr::Lit(Lit::Str(Str {
                span: Default::default(),
                value: prop_ident.sym.to_string().into(),
                raw: None,
            }))),
        });
    }
}

impl VisitMut for DerivedClassMethodKeyCompatVisitor {
    fn visit_mut_class(&mut self, class: &mut swc_core::ecma::ast::Class) {
        class.visit_mut_children_with(self);
        if class.super_class.is_none() {
            return;
        }
        for member in &mut class.body {
            match member {
                swc_core::ecma::ast::ClassMember::Method(method) => {
                    method.key = quote_prop_name(method.key.clone());
                }
                swc_core::ecma::ast::ClassMember::PrivateMethod(_) => {}
                swc_core::ecma::ast::ClassMember::ClassProp(prop) => {
                    if !prop.is_static {
                        prop.key = quote_prop_name(prop.key.clone());
                    }
                }
                _ => {}
            }
        }
    }
}

fn is_component_like_name(value: &str) -> bool {
    value
        .chars()
        .next()
        .map(|character| character.is_ascii_uppercase())
        .unwrap_or(false)
}

fn is_constant_like_property_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_uppercase() {
        return false;
    }
    value.chars().all(|character| {
        character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
    })
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
