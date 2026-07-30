use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;

use swc_core::ecma::ast::{
    Accessibility, BinExpr, CallExpr, Callee, Class, ClassMember, Decl, Expr, ExprOrSpread,
    ImportSpecifier, Key, MemberExpr, MemberProp, Module, ModuleDecl, ModuleExportName, ModuleItem,
    Pat, Prop, PropName, PropOrSpread, SuperProp, SuperPropExpr, VarDeclarator,
};
use swc_core::ecma::visit::{Visit, VisitWith};

use crate::module_cache::parse_source_file;

const HARD_PLATFORM_CALLBACK_PROPERTY_NAMES: &[&str] = &[
    "adoptedCallback",
    "attributeChangedCallback",
    "connectedCallback",
    "disconnectedCallback",
    "formAssociatedCallback",
    "formDisabledCallback",
    "formResetCallback",
    "formStateRestoreCallback",
];
const HARD_STATIC_INTEROP_PROPERTY_NAMES: &[&str] = &["formAssociated", "observedAttributes"];

fn is_hard_platform_callback_name(name: &str) -> bool {
    HARD_PLATFORM_CALLBACK_PROPERTY_NAMES.contains(&name)
}

fn is_hard_static_interop_name(name: &str) -> bool {
    HARD_STATIC_INTEROP_PROPERTY_NAMES.contains(&name)
}

#[derive(Default)]
pub(crate) struct ExternPropertyAnalysis {
    /// Names the emitted program declares itself. An ambient global that
    /// collides with one of these is program code, not environment, and must
    /// not be re-declared in externs.
    pub(crate) program_declared_names: HashSet<String>,
    pub(crate) explicit_extern_property_names: HashSet<String>,
    pub(crate) preserved_property_names: HashSet<String>,
    pub(crate) static_property_names: HashSet<String>,
}

#[derive(Default)]
struct ParsedExternFileAnalysis {
    accessed_hazard_names: HashSet<String>,
    /// Property names read through `<expr>.constructor.<name>`. Closure's
    /// property collapsing rewrites static assignments (`Klass.x = ...`)
    /// into variables it cannot connect to such dynamic reads, so these
    /// names must stay real (quoted) properties when also assigned
    /// statically anywhere.
    constructor_read_names: HashSet<String>,
    defined_hazard_names: HashSet<String>,
    platform_callback_names: HashSet<String>,
    reflective_property_names: HashSet<String>,
    static_assigned_names: HashSet<String>,
    static_property_names: HashSet<String>,
}

/// The externs-free shorthand. Production always has explicit externs to
/// intersect against, so this exists only to keep the analysis tests from
/// threading an empty slice through every call.
#[cfg(test)]
pub(crate) fn collect_extern_property_names(
    file_names: &[String],
) -> std::result::Result<ExternPropertyAnalysis, String> {
    collect_extern_property_names_with_externs(file_names, &[])
}

pub(crate) fn collect_extern_property_names_with_externs(
    file_names: &[String],
    extern_file_names: &[String],
) -> std::result::Result<ExternPropertyAnalysis, String> {
    let mut preserved_property_names = HashSet::new();
    let mut static_property_names = HashSet::new();
    let mut parsed_modules = Vec::new();

    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        match parse_source_file(&file_path) {
            Ok(module) => {
                let mut collector = ExternPropertyCollector::default();
                module.visit_with(&mut collector);
                let analysis = collector.finish();
                static_property_names.extend(analysis.static_property_names.iter().cloned());
                preserved_property_names.extend(analysis.platform_callback_names);
                preserved_property_names.extend(analysis.reflective_property_names);
                preserved_property_names.extend(
                    analysis
                        .defined_hazard_names
                        .intersection(&analysis.accessed_hazard_names)
                        .cloned(),
                );
                preserved_property_names.extend(
                    analysis
                        .constructor_read_names
                        .intersection(&analysis.static_assigned_names)
                        .cloned(),
                );
                parsed_modules.push(module);
            }
            Err(_) => {
                let source_text =
                    fs::read_to_string(file_name).map_err(|error| error.to_string())?;
                static_property_names.extend(collect_static_property_names_from_text(&source_text));
            }
        }
    }

    preserved_property_names.extend(collect_custom_element_surface_names(&parsed_modules));
    let explicit_extern_property_names = collect_explicit_extern_property_names(extern_file_names)?;
    preserved_property_names.extend(explicit_extern_property_names.iter().cloned());
    preserved_property_names.extend(static_property_names.iter().cloned());
    // A name the program itself declares is program code, not an ambient, and
    // re-declaring it in externs would collide.
    let ambient_global_names = collect_program_declared_names(&parsed_modules);
    Ok(ExternPropertyAnalysis {
        program_declared_names: ambient_global_names,
        explicit_extern_property_names,
        preserved_property_names,
        static_property_names,
    })
}

#[cfg(test)]
pub(crate) fn collect_preserved_property_names(
    file_names: &[String],
    _static_property_names: &HashSet<String>,
) -> std::result::Result<HashSet<String>, String> {
    Ok(collect_extern_property_names(file_names)?.preserved_property_names)
}

fn collect_explicit_extern_property_names(
    extern_file_names: &[String],
) -> std::result::Result<HashSet<String>, String> {
    let mut property_names = HashSet::new();

    for file_name in extern_file_names {
        let file_path = PathBuf::from(file_name);
        let module = parse_source_file(&file_path)?;
        let mut collector = ExplicitExternPropertyCollector::default();
        module.visit_with(&mut collector);
        property_names.extend(collector.property_names);
    }

    Ok(property_names)
}

pub(crate) fn collect_static_property_names_from_text(source_text: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    for (_, property_name) in super::super::collect_class_static_assignments(source_text) {
        if is_hard_static_interop_name(&property_name) {
            names.insert(property_name);
        }
    }
    if let Ok(regex) =
        regex::Regex::new(r"\bstatic\s+(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|\()")
    {
        for captures in regex.captures_iter(source_text) {
            if let Some(capture) = captures.get(1) {
                let property_name = capture.as_str();
                if is_hard_static_interop_name(property_name) {
                    names.insert(property_name.to_string());
                }
            }
        }
    }
    names
}

pub(crate) fn is_valid_js_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

pub(crate) fn prop_name_to_string(prop_name: &PropName) -> Option<String> {
    match prop_name {
        PropName::Ident(ident) => Some(ident.sym.to_string()),
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Num(value) => Some(value.value.to_string()),
        _ => None,
    }
}

#[derive(Default)]
struct ExternPropertyCollector {
    accessed_hazard_names: HashSet<String>,
    class_name_stack: Vec<Option<String>>,
    constructor_read_names: HashSet<String>,
    defined_hazard_names: HashSet<String>,
    platform_callback_names: HashSet<String>,
    reflective_property_names: HashSet<String>,
    static_assigned_names: HashSet<String>,
    static_context_depth: usize,
    static_property_names: HashSet<String>,
}

impl ExternPropertyCollector {
    fn finish(self) -> ParsedExternFileAnalysis {
        ParsedExternFileAnalysis {
            accessed_hazard_names: self.accessed_hazard_names,
            constructor_read_names: self.constructor_read_names,
            defined_hazard_names: self.defined_hazard_names,
            platform_callback_names: self.platform_callback_names,
            reflective_property_names: self.reflective_property_names,
            static_assigned_names: self.static_assigned_names,
            static_property_names: self.static_property_names,
        }
    }

    fn current_class_name(&self) -> Option<&str> {
        self.class_name_stack
            .last()
            .and_then(|name| name.as_deref())
    }

    fn insert_accessed_hazard_name(&mut self, property_name: &str) {
        if is_valid_js_identifier(property_name) {
            self.accessed_hazard_names.insert(property_name.to_string());
        }
    }

    fn insert_defined_hazard_name(&mut self, property_name: Option<String>) {
        if let Some(property_name) = property_name {
            if is_valid_js_identifier(&property_name) {
                self.defined_hazard_names.insert(property_name);
            }
        }
    }

    fn insert_platform_callback_name(&mut self, property_name: Option<String>) {
        if let Some(property_name) = property_name {
            if is_hard_platform_callback_name(&property_name) {
                self.platform_callback_names.insert(property_name);
            }
        }
    }

    fn insert_reflective_name(&mut self, property_name: &str) {
        if is_valid_js_identifier(property_name) {
            self.reflective_property_names
                .insert(property_name.to_string());
        }
    }

    fn insert_static_name(&mut self, property_name: Option<String>) {
        if let Some(property_name) = property_name {
            if is_hard_static_interop_name(&property_name) {
                self.static_property_names.insert(property_name);
            }
        }
    }

    fn with_static_context<F>(&mut self, callback: F)
    where
        F: FnOnce(&mut Self),
    {
        self.static_context_depth += 1;
        callback(self);
        self.static_context_depth -= 1;
    }
}

impl Visit for ExternPropertyCollector {
    fn visit_class_decl(&mut self, class_decl: &swc_core::ecma::ast::ClassDecl) {
        self.class_name_stack
            .push(Some(class_decl.ident.sym.to_string()));
        class_decl.class.visit_with(self);
        self.class_name_stack.pop();
    }

    fn visit_class_expr(&mut self, class_expr: &swc_core::ecma::ast::ClassExpr) {
        self.class_name_stack
            .push(class_expr.ident.as_ref().map(|ident| ident.sym.to_string()));
        class_expr.class.visit_with(self);
        self.class_name_stack.pop();
    }

    fn visit_assign_expr(&mut self, assign_expr: &swc_core::ecma::ast::AssignExpr) {
        if let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Member(member),
        ) = &assign_expr.left
        {
            if member.obj.is_ident() {
                if let MemberProp::Ident(prop_ident) = &member.prop {
                    if is_valid_js_identifier(prop_ident.sym.as_ref()) {
                        self.static_assigned_names
                            .insert(prop_ident.sym.to_string());
                    }
                }
            }
        }
        assign_expr.visit_children_with(self);
    }

    fn visit_class_member(&mut self, member: &ClassMember) {
        match member {
            ClassMember::ClassProp(prop) => {
                let prop_name = prop_name_to_string(&prop.key);
                self.insert_platform_callback_name(prop_name.clone());
                if !prop.decorators.is_empty() && is_public_accessibility(prop.accessibility) {
                    if let Some(property_name) = &prop_name {
                        self.insert_reflective_name(property_name);
                    }
                }
                if prop.is_static {
                    self.insert_static_name(prop_name.clone());
                    if let Some(prop_name) = prop_name {
                        if is_valid_js_identifier(&prop_name) {
                            self.static_assigned_names.insert(prop_name);
                        }
                    }
                }
                prop.visit_children_with(self);
            }
            ClassMember::Method(method) => {
                let prop_name = prop_name_to_string(&method.key);
                self.insert_platform_callback_name(prop_name.clone());
                if !method.function.decorators.is_empty()
                    && is_public_accessibility(method.accessibility)
                {
                    if let Some(property_name) = &prop_name {
                        self.insert_reflective_name(property_name);
                    }
                }
                if method.is_static {
                    self.insert_static_name(prop_name);
                    self.with_static_context(|collector| method.function.visit_with(collector));
                } else {
                    method.visit_children_with(self);
                }
            }
            ClassMember::AutoAccessor(accessor) => {
                let prop_name = match &accessor.key {
                    Key::Public(key) => prop_name_to_string(key),
                    Key::Private(_) => None,
                };
                self.insert_platform_callback_name(prop_name.clone());
                if !accessor.decorators.is_empty()
                    && is_public_accessibility(accessor.accessibility)
                {
                    if let Some(property_name) = &prop_name {
                        self.insert_reflective_name(property_name);
                    }
                }
                if accessor.is_static {
                    self.insert_static_name(prop_name.clone());
                    if let Some(prop_name) = prop_name {
                        if is_valid_js_identifier(&prop_name) {
                            self.static_assigned_names.insert(prop_name);
                        }
                    }
                }
                accessor.visit_children_with(self);
            }
            ClassMember::PrivateMethod(method) => {
                if method.is_static {
                    self.with_static_context(|collector| method.function.visit_with(collector));
                } else {
                    method.visit_children_with(self);
                }
            }
            _ => member.visit_children_with(self),
        }
    }

    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        match &member_expr.prop {
            MemberProp::Ident(prop_ident) => {
                let property_name = prop_ident.sym.as_ref();
                self.insert_platform_callback_name(Some(property_name.to_string()));
                self.insert_accessed_hazard_name(property_name);
                if let Expr::Member(object_member) = &*member_expr.obj {
                    if matches!(
                        &object_member.prop,
                        MemberProp::Ident(object_prop) if object_prop.sym.as_ref() == "constructor"
                    ) && is_valid_js_identifier(property_name)
                    {
                        self.constructor_read_names
                            .insert(property_name.to_string());
                    }
                }
            }
            MemberProp::Computed(computed) => {
                if let Some(property_name) = string_literal_expr_name(&computed.expr) {
                    self.insert_reflective_name(&property_name);
                }
            }
            MemberProp::PrivateName(_) => {}
        }

        if self.static_context_depth > 0 {
            let is_static_target = match &*member_expr.obj {
                Expr::This(_) => true,
                Expr::Ident(ident) => self
                    .current_class_name()
                    .map(|class_name| ident.sym.as_ref() == class_name)
                    .unwrap_or(false),
                _ => false,
            };
            if is_static_target {
                self.insert_static_name(member_prop_name(&member_expr.prop));
            }
        }
        member_expr.visit_children_with(self);
    }

    fn visit_super_prop_expr(&mut self, super_prop: &SuperPropExpr) {
        match &super_prop.prop {
            SuperProp::Ident(ident) => {
                let property_name = ident.sym.as_ref();
                self.insert_platform_callback_name(Some(property_name.to_string()));
                self.insert_accessed_hazard_name(property_name);
            }
            SuperProp::Computed(computed) => {
                if let Some(property_name) = string_literal_expr_name(&computed.expr) {
                    self.insert_platform_callback_name(Some(property_name.clone()));
                    self.insert_reflective_name(&property_name);
                }
            }
        }
        super_prop.visit_children_with(self);
    }

    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        if declarator.init.is_some() {
            collect_pattern_property_reads(&declarator.name, &mut self.accessed_hazard_names);
        }
        declarator.visit_children_with(self);
    }

    fn visit_object_lit(&mut self, object_lit: &swc_core::ecma::ast::ObjectLit) {
        for prop in &object_lit.props {
            let swc_core::ecma::ast::PropOrSpread::Prop(prop) = prop else {
                continue;
            };
            match prop.as_ref() {
                swc_core::ecma::ast::Prop::KeyValue(key_value) => {
                    let property_name = string_defined_prop_name(&key_value.key);
                    self.insert_defined_hazard_name(property_name.clone());
                    if let Some(property_name) = property_name {
                        self.insert_reflective_name(&property_name);
                    }
                }
                swc_core::ecma::ast::Prop::Getter(getter) => {
                    let property_name = string_defined_prop_name(&getter.key);
                    self.insert_defined_hazard_name(property_name.clone());
                    if let Some(property_name) = property_name {
                        self.insert_reflective_name(&property_name);
                    }
                }
                swc_core::ecma::ast::Prop::Setter(setter) => {
                    let property_name = string_defined_prop_name(&setter.key);
                    self.insert_defined_hazard_name(property_name.clone());
                    if let Some(property_name) = property_name {
                        self.insert_reflective_name(&property_name);
                    }
                }
                swc_core::ecma::ast::Prop::Method(method) => {
                    let property_name = string_defined_prop_name(&method.key);
                    self.insert_defined_hazard_name(property_name.clone());
                    if let Some(property_name) = property_name {
                        self.insert_reflective_name(&property_name);
                    }
                }
                _ => {}
            }
        }
        object_lit.visit_children_with(self);
    }

    fn visit_prop_name(&mut self, prop_name: &PropName) {
        if let PropName::Str(value) = prop_name {
            self.insert_reflective_name(&value.value.to_string_lossy());
        }
        prop_name.visit_children_with(self);
    }

    fn visit_bin_expr(&mut self, bin_expr: &BinExpr) {
        if bin_expr.op == swc_core::ecma::ast::BinaryOp::In {
            if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &*bin_expr.left {
                self.insert_reflective_name(&value.value.to_string_lossy());
            }
        }
        bin_expr.visit_children_with(self);
    }

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        collect_call_record_contract_names(call_expr, &mut self.reflective_property_names);
        if let Callee::Expr(callee_expr) = &call_expr.callee {
            match &**callee_expr {
                Expr::Ident(ident) if ident.sym == *"JSCompiler_renameProperty" => {
                    if let Some(ExprOrSpread { expr, .. }) = call_expr.args.first() {
                        if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &**expr {
                            self.insert_reflective_name(&value.value.to_string_lossy());
                        }
                    }
                }
                Expr::Ident(ident)
                    if ident.sym == *"__publicField" && call_expr.args.len() >= 2 =>
                {
                    if let Some(ExprOrSpread { expr, .. }) = call_expr.args.get(1) {
                        self.insert_defined_hazard_name(string_literal_expr_name(expr));
                    }
                }
                Expr::Member(member) => {
                    let method_name = member_prop_name(&member.prop);
                    let object_name = match &*member.obj {
                        Expr::Ident(ident) => Some(ident.sym.as_ref()),
                        _ => None,
                    };
                    let string_arg_index = match (object_name, method_name.as_deref()) {
                        (Some("Object"), Some("defineProperty")) => Some(1usize),
                        (Some("Object"), Some("hasOwn")) => Some(1usize),
                        (Some("Reflect"), Some("defineProperty")) => Some(1usize),
                        (Some("Reflect"), Some("deleteProperty")) => Some(1usize),
                        (Some("Reflect"), Some("get")) => Some(1usize),
                        (Some("Reflect"), Some("has")) => Some(1usize),
                        (Some("Reflect"), Some("set")) => Some(1usize),
                        _ => None,
                    };
                    if let Some(index) = string_arg_index {
                        if let Some(ExprOrSpread { expr, .. }) = call_expr.args.get(index) {
                            let string_name = string_literal_expr_name(expr);
                            if let Some(property_name) = string_name.clone() {
                                self.insert_reflective_name(&property_name);
                            }
                            if matches!(
                                (object_name, method_name.as_deref()),
                                (Some("Object"), Some("defineProperty"))
                                    | (Some("Reflect"), Some("defineProperty"))
                            ) {
                                self.insert_defined_hazard_name(string_name);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        call_expr.visit_children_with(self);
    }
}

fn string_defined_prop_name(prop_name: &PropName) -> Option<String> {
    match prop_name {
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Computed(computed) => string_literal_expr_name(&computed.expr),
        _ => None,
    }
}

fn string_literal_expr_name(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) => {
            Some(value.value.to_string_lossy().to_string())
        }
        Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => {
            template.quasis.first().map(|quasi| {
                quasi
                    .cooked
                    .as_ref()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_else(|| quasi.raw.to_string())
            })
        }
        Expr::Paren(parenthesized) => string_literal_expr_name(&parenthesized.expr),
        _ => None,
    }
}

fn member_prop_name(prop: &MemberProp) -> Option<String> {
    match prop {
        MemberProp::Ident(ident) => Some(ident.sym.to_string()),
        MemberProp::Computed(computed) => string_literal_expr_name(&computed.expr),
        MemberProp::PrivateName(_) => None,
    }
}
fn is_public_accessibility(accessibility: Option<Accessibility>) -> bool {
    !matches!(
        accessibility,
        Some(Accessibility::Private | Accessibility::Protected)
    )
}

/// A call argument shaped like `{ schema: { key: ... }, use(value) {
/// return value.key; } }` proves that `key` crosses a runtime record boundary.
/// Vue's compiled `defineComponent({ props: { msg: {} }, setup(props) {
/// props.msg } })` is one instance of this framework-neutral evidence.
fn collect_call_record_contract_names(call: &CallExpr, names: &mut HashSet<String>) {
    for argument in &call.args {
        let Expr::Object(object) = unwrap_parenthesized_expr(&argument.expr) else {
            continue;
        };
        let declared = collect_nested_record_names(object);
        if declared.is_empty() {
            continue;
        }
        let accessed = collect_object_callback_parameter_accesses(object);
        names.extend(declared.intersection(&accessed).cloned());
    }
}

fn collect_nested_record_names(object: &swc_core::ecma::ast::ObjectLit) -> HashSet<String> {
    let mut names = HashSet::new();
    for property in &object.props {
        let PropOrSpread::Prop(property) = property else {
            continue;
        };
        let Prop::KeyValue(property) = property.as_ref() else {
            continue;
        };
        match unwrap_parenthesized_expr(&property.value) {
            Expr::Object(record) => names.extend(object_literal_direct_keys(record)),
            Expr::Array(record) => {
                for element in record.elems.iter().flatten() {
                    if let Some(name) = string_literal_expr_name(&element.expr) {
                        if is_valid_js_identifier(&name) {
                            names.insert(name);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    names
}

fn object_literal_direct_keys(object: &swc_core::ecma::ast::ObjectLit) -> HashSet<String> {
    let mut names = HashSet::new();
    for property in &object.props {
        let PropOrSpread::Prop(property) = property else {
            continue;
        };
        let name = match property.as_ref() {
            Prop::Shorthand(ident) => Some(ident.sym.to_string()),
            Prop::KeyValue(property) => public_prop_name(&property.key),
            Prop::Getter(property) => public_prop_name(&property.key),
            Prop::Setter(property) => public_prop_name(&property.key),
            Prop::Method(property) => public_prop_name(&property.key),
            Prop::Assign(property) => Some(property.key.sym.to_string()),
        };
        if let Some(name) = name {
            if is_valid_js_identifier(&name) {
                names.insert(name);
            }
        }
    }
    names
}

fn collect_object_callback_parameter_accesses(
    object: &swc_core::ecma::ast::ObjectLit,
) -> HashSet<String> {
    let mut names = HashSet::new();
    for property in &object.props {
        let PropOrSpread::Prop(property) = property else {
            continue;
        };
        match property.as_ref() {
            Prop::Method(method) => {
                let parameters = method
                    .function
                    .params
                    .iter()
                    .flat_map(|parameter| pattern_binding_names(&parameter.pat))
                    .collect::<HashSet<_>>();
                let mut collector = CallbackParameterMemberCollector {
                    names: HashSet::new(),
                    parameters,
                };
                method.function.visit_with(&mut collector);
                names.extend(collector.names);
            }
            Prop::KeyValue(property) => match unwrap_parenthesized_expr(&property.value) {
                Expr::Fn(function) => {
                    let parameters = function
                        .function
                        .params
                        .iter()
                        .flat_map(|parameter| pattern_binding_names(&parameter.pat))
                        .collect::<HashSet<_>>();
                    let mut collector = CallbackParameterMemberCollector {
                        names: HashSet::new(),
                        parameters,
                    };
                    function.function.visit_with(&mut collector);
                    names.extend(collector.names);
                }
                Expr::Arrow(function) => {
                    let parameters = function
                        .params
                        .iter()
                        .flat_map(pattern_binding_names)
                        .collect::<HashSet<_>>();
                    let mut collector = CallbackParameterMemberCollector {
                        names: HashSet::new(),
                        parameters,
                    };
                    function.visit_with(&mut collector);
                    names.extend(collector.names);
                }
                _ => {}
            },
            _ => {}
        }
    }
    names
}

fn pattern_binding_names(pattern: &Pat) -> Vec<String> {
    match pattern {
        Pat::Ident(binding) => vec![binding.id.sym.to_string()],
        Pat::Array(array) => array
            .elems
            .iter()
            .flatten()
            .flat_map(pattern_binding_names)
            .collect(),
        Pat::Object(object) => object
            .props
            .iter()
            .flat_map(|property| match property {
                swc_core::ecma::ast::ObjectPatProp::KeyValue(property) => {
                    pattern_binding_names(&property.value)
                }
                swc_core::ecma::ast::ObjectPatProp::Assign(property) => {
                    vec![property.key.sym.to_string()]
                }
                swc_core::ecma::ast::ObjectPatProp::Rest(property) => {
                    pattern_binding_names(&property.arg)
                }
            })
            .collect(),
        Pat::Assign(assign) => pattern_binding_names(&assign.left),
        Pat::Rest(rest) => pattern_binding_names(&rest.arg),
        _ => Vec::new(),
    }
}

struct CallbackParameterMemberCollector {
    names: HashSet<String>,
    parameters: HashSet<String>,
}

impl Visit for CallbackParameterMemberCollector {
    fn visit_member_expr(&mut self, member: &MemberExpr) {
        let object_matches = match unwrap_parenthesized_expr(&member.obj) {
            Expr::Ident(ident) => self.parameters.contains(ident.sym.as_ref()),
            Expr::This(_) => true,
            _ => false,
        };
        if object_matches {
            if let Some(name) = member_prop_name(&member.prop) {
                if is_valid_js_identifier(&name) {
                    self.names.insert(name);
                }
            }
        }
        member.visit_children_with(self);
    }
}

fn unwrap_parenthesized_expr(mut expression: &Expr) -> &Expr {
    while let Expr::Paren(parenthesized) = expression {
        expression = &parenthesized.expr;
    }
    expression
}

#[derive(Default)]
struct ClassSurfaceFact {
    names: HashSet<String>,
    properties: HashSet<String>,
    registered: bool,
    super_name: Option<String>,
}

/// Custom-element instances are acquired by tag name outside the compiled
/// program, so their public instance/prototype surface cannot safely rename.
/// Follow named superclass aliases across the input graph; ordinary
/// unregistered classes remain fully renamable.
fn collect_custom_element_surface_names(modules: &[Module]) -> HashSet<String> {
    let mut facts = Vec::new();
    for module in modules {
        collect_module_class_surface_facts(module, &mut facts);
    }

    let mut facts_by_name: HashMap<String, Vec<usize>> = HashMap::new();
    let mut pending = VecDeque::new();
    for (index, fact) in facts.iter().enumerate() {
        if fact.registered {
            pending.push_back(index);
        }
        for name in &fact.names {
            if name != "default" {
                facts_by_name.entry(name.clone()).or_default().push(index);
            }
        }
    }

    let mut visited = HashSet::new();
    let mut properties = HashSet::new();
    while let Some(index) = pending.pop_front() {
        if !visited.insert(index) {
            continue;
        }
        let fact = &facts[index];
        properties.extend(fact.properties.iter().cloned());
        if let Some(super_name) = &fact.super_name {
            if let Some(super_facts) = facts_by_name.get(super_name) {
                pending.extend(super_facts.iter().copied());
            }
        }
    }
    properties
}

fn collect_module_class_surface_facts(module: &Module, facts: &mut Vec<ClassSurfaceFact>) {
    let import_aliases = collect_module_import_aliases(module);
    let export_aliases = collect_module_export_aliases(module);
    let mut registrations = CustomElementRegistrationCollector::default();
    module.visit_with(&mut registrations);

    for item in &module.body {
        match item {
            ModuleItem::Stmt(swc_core::ecma::ast::Stmt::Decl(declaration)) => {
                collect_decl_class_surface_facts(
                    declaration,
                    &import_aliases,
                    &export_aliases,
                    &registrations.class_names,
                    facts,
                );
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export)) => {
                collect_decl_class_surface_facts(
                    &export.decl,
                    &import_aliases,
                    &export_aliases,
                    &registrations.class_names,
                    facts,
                );
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(export)) => {
                if let swc_core::ecma::ast::DefaultDecl::Class(class) = &export.decl {
                    let local_name = class
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| "default".to_string());
                    push_class_surface_fact(
                        local_name,
                        &class.class,
                        &import_aliases,
                        &export_aliases,
                        &registrations.class_names,
                        Some("default"),
                        facts,
                    );
                }
            }
            _ => {}
        }
    }
}

fn collect_decl_class_surface_facts(
    declaration: &Decl,
    import_aliases: &HashMap<String, String>,
    export_aliases: &HashMap<String, HashSet<String>>,
    registrations: &HashSet<String>,
    facts: &mut Vec<ClassSurfaceFact>,
) {
    match declaration {
        Decl::Class(class) => push_class_surface_fact(
            class.ident.sym.to_string(),
            &class.class,
            import_aliases,
            export_aliases,
            registrations,
            None,
            facts,
        ),
        Decl::Var(declaration) => {
            for declarator in &declaration.decls {
                let (Pat::Ident(binding), Some(initializer)) = (&declarator.name, &declarator.init)
                else {
                    continue;
                };
                let Expr::Class(class) = unwrap_parenthesized_expr(initializer) else {
                    continue;
                };
                push_class_surface_fact(
                    binding.id.sym.to_string(),
                    &class.class,
                    import_aliases,
                    export_aliases,
                    registrations,
                    None,
                    facts,
                );
            }
        }
        _ => {}
    }
}

fn push_class_surface_fact(
    local_name: String,
    class: &Class,
    import_aliases: &HashMap<String, String>,
    export_aliases: &HashMap<String, HashSet<String>>,
    registrations: &HashSet<String>,
    extra_export: Option<&str>,
    facts: &mut Vec<ClassSurfaceFact>,
) {
    let mut names = HashSet::from([local_name.clone()]);
    if let Some(aliases) = export_aliases.get(&local_name) {
        names.extend(aliases.iter().cloned());
    }
    if let Some(extra_export) = extra_export {
        names.insert(extra_export.to_string());
    }
    let super_name = class
        .super_class
        .as_deref()
        .and_then(class_reference_name)
        .map(|name| import_aliases.get(&name).cloned().unwrap_or(name));
    facts.push(ClassSurfaceFact {
        names,
        properties: collect_class_surface_properties(class),
        registered: registrations.contains(&local_name)
            || class.decorators.iter().any(is_custom_element_decorator),
        super_name,
    });
}

fn collect_module_import_aliases(module: &Module) -> HashMap<String, String> {
    let mut aliases = HashMap::new();
    for item in &module.body {
        let ModuleItem::ModuleDecl(ModuleDecl::Import(import)) = item else {
            continue;
        };
        for specifier in &import.specifiers {
            match specifier {
                ImportSpecifier::Named(named) => {
                    aliases.insert(
                        named.local.sym.to_string(),
                        named
                            .imported
                            .as_ref()
                            .map(module_export_name)
                            .unwrap_or_else(|| named.local.sym.to_string()),
                    );
                }
                ImportSpecifier::Default(default) => {
                    aliases.insert(default.local.sym.to_string(), "default".to_string());
                }
                ImportSpecifier::Namespace(namespace) => {
                    aliases.insert(
                        namespace.local.sym.to_string(),
                        namespace.local.sym.to_string(),
                    );
                }
            }
        }
    }
    aliases
}

fn collect_module_export_aliases(module: &Module) -> HashMap<String, HashSet<String>> {
    let mut aliases: HashMap<String, HashSet<String>> = HashMap::new();
    for item in &module.body {
        let ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(export)) = item else {
            continue;
        };
        if export.src.is_some() {
            continue;
        }
        for specifier in &export.specifiers {
            let swc_core::ecma::ast::ExportSpecifier::Named(named) = specifier else {
                continue;
            };
            let local_name = module_export_name(&named.orig);
            let exported_name = named
                .exported
                .as_ref()
                .map(module_export_name)
                .unwrap_or_else(|| local_name.clone());
            aliases.entry(local_name).or_default().insert(exported_name);
        }
    }
    aliases
}

fn module_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(ident) => ident.sym.to_string(),
        ModuleExportName::Str(value) => value.value.to_string_lossy().to_string(),
    }
}

fn class_reference_name(expression: &Expr) -> Option<String> {
    match unwrap_parenthesized_expr(expression) {
        Expr::Ident(ident) => Some(ident.sym.to_string()),
        Expr::Member(member) => member_prop_name(&member.prop),
        _ => None,
    }
}

fn collect_class_surface_properties(class: &Class) -> HashSet<String> {
    let mut properties = HashSet::new();
    let mut non_public = HashSet::new();
    for member in &class.body {
        match member {
            ClassMember::ClassProp(property) => {
                if let Some(name) = public_prop_name(&property.key) {
                    if is_public_accessibility(property.accessibility) {
                        properties.insert(name);
                    } else {
                        non_public.insert(name);
                    }
                }
                if property.is_static {
                    if let Some(value) = &property.value {
                        if let Expr::Object(metadata) = unwrap_parenthesized_expr(value) {
                            properties.extend(object_literal_direct_keys(metadata));
                        }
                    }
                }
            }
            ClassMember::Method(method) => {
                if let Some(name) = public_prop_name(&method.key) {
                    if is_public_accessibility(method.accessibility) {
                        properties.insert(name);
                    } else {
                        non_public.insert(name);
                    }
                }
            }
            ClassMember::AutoAccessor(accessor) => {
                if let Key::Public(key) = &accessor.key {
                    if let Some(name) = public_prop_name(key) {
                        if is_public_accessibility(accessor.accessibility) {
                            properties.insert(name);
                        } else {
                            non_public.insert(name);
                        }
                    }
                }
                if accessor.is_static {
                    if let Some(value) = &accessor.value {
                        if let Expr::Object(metadata) = unwrap_parenthesized_expr(value) {
                            properties.extend(object_literal_direct_keys(metadata));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut collector = ThisMemberCollector::default();
    for member in &class.body {
        member.visit_with(&mut collector);
    }
    properties.extend(collector.names);
    properties.retain(|name| is_public_surface_name(name) && !non_public.contains(name));
    properties
}

fn public_prop_name(name: &PropName) -> Option<String> {
    match name {
        PropName::Ident(ident) => Some(ident.sym.to_string()),
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Computed(computed) => string_literal_expr_name(&computed.expr),
        _ => None,
    }
}

fn is_public_surface_name(name: &str) -> bool {
    name != "constructor"
        && !name.starts_with('_')
        && !name.starts_with('$')
        && is_valid_js_identifier(name)
}

#[derive(Default)]
struct ThisMemberCollector {
    names: HashSet<String>,
}

impl Visit for ThisMemberCollector {
    fn visit_class(&mut self, _class: &Class) {
        // A nested class has its own `this` surface.
    }

    fn visit_member_expr(&mut self, member: &MemberExpr) {
        if matches!(unwrap_parenthesized_expr(&member.obj), Expr::This(_)) {
            if let Some(name) = member_prop_name(&member.prop) {
                self.names.insert(name);
            }
        }
        member.visit_children_with(self);
    }
}

#[derive(Default)]
struct CustomElementRegistrationCollector {
    class_names: HashSet<String>,
}

impl Visit for CustomElementRegistrationCollector {
    fn visit_call_expr(&mut self, call: &CallExpr) {
        if is_custom_elements_define_call(call)
            && call
                .args
                .first()
                .and_then(|argument| string_literal_expr_name(&argument.expr))
                .is_some_and(|name| name.contains('-'))
        {
            if let Some(ExprOrSpread { expr, .. }) = call.args.get(1) {
                if let Expr::Ident(class_name) = unwrap_parenthesized_expr(expr) {
                    self.class_names.insert(class_name.sym.to_string());
                }
            }
        }
        call.visit_children_with(self);
    }
}

fn is_custom_elements_define_call(call: &CallExpr) -> bool {
    let Callee::Expr(callee) = &call.callee else {
        return false;
    };
    let Expr::Member(define) = unwrap_parenthesized_expr(callee) else {
        return false;
    };
    if member_prop_name(&define.prop).as_deref() != Some("define") {
        return false;
    }
    match unwrap_parenthesized_expr(&define.obj) {
        Expr::Ident(ident) => ident.sym == *"customElements",
        Expr::Member(member) => member_prop_name(&member.prop).as_deref() == Some("customElements"),
        _ => false,
    }
}

fn is_custom_element_decorator(decorator: &swc_core::ecma::ast::Decorator) -> bool {
    let Expr::Call(call) = unwrap_parenthesized_expr(&decorator.expr) else {
        return false;
    };
    call.args
        .first()
        .and_then(|argument| string_literal_expr_name(&argument.expr))
        .is_some_and(|name| name.contains('-'))
}

#[derive(Default)]
struct ExplicitExternPropertyCollector {
    property_names: HashSet<String>,
}

impl Visit for ExplicitExternPropertyCollector {
    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        if is_explicit_extern_target(&member_expr.obj) {
            if let Some(property_name) = member_prop_name(&member_expr.prop) {
                if property_name != "prototype" && is_valid_js_identifier(&property_name) {
                    self.property_names.insert(property_name);
                }
            }
        }
        member_expr.visit_children_with(self);
    }
}

fn is_explicit_extern_target(expr: &Expr) -> bool {
    match expr {
        Expr::Ident(_) => true,
        Expr::Member(member) => matches!(
            (&*member.obj, &member.prop),
            (Expr::Ident(_), MemberProp::Ident(ident)) if ident.sym == *"prototype"
        ),
        Expr::Paren(paren) => is_explicit_extern_target(&paren.expr),
        _ => false,
    }
}

fn collect_pattern_property_reads(pattern: &Pat, names: &mut HashSet<String>) {
    match pattern {
        Pat::Object(object) => {
            for prop in &object.props {
                match prop {
                    swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                        if let Some(property_name) = prop_name_to_string(&key_value.key) {
                            if is_valid_js_identifier(&property_name) {
                                names.insert(property_name);
                            }
                        }
                        collect_pattern_property_reads(&key_value.value, names);
                    }
                    swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                        names.insert(assign.key.sym.to_string());
                    }
                    swc_core::ecma::ast::ObjectPatProp::Rest(rest) => {
                        collect_pattern_property_reads(&rest.arg, names);
                    }
                }
            }
        }
        Pat::Array(array) => {
            for element in array.elems.iter().flatten() {
                collect_pattern_property_reads(element, names);
            }
        }
        Pat::Assign(assign) => collect_pattern_property_reads(&assign.left, names),
        Pat::Rest(rest) => collect_pattern_property_reads(&rest.arg, names),
        _ => {}
    }
}

#[cfg(test)]
pub(crate) fn collect_program_declared_names_for_test(
    modules: &[swc_core::ecma::ast::Module],
) -> HashSet<String> {
    collect_program_declared_names(modules)
}

fn collect_program_declared_names(modules: &[swc_core::ecma::ast::Module]) -> HashSet<String> {
    let mut names = HashSet::new();
    for module in modules {
        for item in &module.body {
            let swc_core::ecma::ast::ModuleItem::Stmt(swc_core::ecma::ast::Stmt::Decl(declaration)) =
                item
            else {
                continue;
            };
            match declaration {
                // `declare` emits no runtime binding, so an ambient
                // declaration does not make the name program-declared: a
                // reference to it still has to resolve from the environment.
                // Counting it here suppressed the extern the reference needs.
                swc_core::ecma::ast::Decl::Var(var_decl) if !var_decl.declare => {
                    for declarator in &var_decl.decls {
                        if let swc_core::ecma::ast::Pat::Ident(binding) = &declarator.name {
                            names.insert(binding.id.sym.to_string());
                        }
                    }
                }
                swc_core::ecma::ast::Decl::Fn(fn_decl) if !fn_decl.declare => {
                    names.insert(fn_decl.ident.sym.to_string());
                }
                swc_core::ecma::ast::Decl::Class(class_decl) if !class_decl.declare => {
                    names.insert(class_decl.ident.sym.to_string());
                }
                _ => {}
            }
        }
    }
    names
}
