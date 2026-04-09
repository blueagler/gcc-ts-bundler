use super::*;

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

#[cfg(test)]
pub(super) fn render_externs(
    export_names: &BTreeSet<String>,
    enum_externs: &BTreeMap<String, BTreeSet<String>>,
) -> String {
    let mut lines = vec!["/** @externs */".to_string()];
    let mut all_names = export_names.clone();
    for member_names in enum_externs.values() {
        all_names.extend(member_names.iter().cloned());
    }
    if all_names.is_empty() {
        lines.push(String::new());
        return lines.join("\n");
    }

    for name in all_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("Object.prototype.{name};"));
        } else {
            lines.push(format!("Object.prototype[{name:?}];"));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

pub(super) fn render_generated_externs(
    global_property_names: &HashSet<String>,
    static_property_names: &HashSet<String>,
) -> String {
    let mut lines = vec!["/** @externs */".to_string()];
    let mut global_names = global_property_names.iter().cloned().collect::<Vec<_>>();
    global_names.sort();
    for name in global_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("Window.prototype.{name};"));
        } else {
            lines.push(format!("Window.prototype[{name:?}];"));
        }
    }
    let mut static_names = static_property_names.iter().cloned().collect::<Vec<_>>();
    static_names.sort();
    for name in static_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("Function.prototype.{name};"));
        } else {
            lines.push(format!("Function.prototype[{name:?}];"));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

pub(super) fn collect_static_property_names(
    file_names: &[String],
) -> std::result::Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        match get_or_parse_cached_module(&file_path) {
            Ok(module) => {
                let mut collector = StaticPropertyNameCollector::default();
                module.visit_with(&mut collector);
                names.extend(collector.names);
            }
            Err(_) => {
                let source_text =
                    fs::read_to_string(file_name).map_err(|error| error.to_string())?;
                names.extend(collect_static_property_names_from_text(&source_text));
            }
        }
    }
    Ok(names)
}

pub(super) fn collect_preserved_property_names(
    file_names: &[String],
    global_property_names: &HashSet<String>,
    static_property_names: &HashSet<String>,
) -> std::result::Result<HashSet<String>, String> {
    let mut names = global_property_names.clone();
    names.extend(static_property_names.iter().cloned());
    names.extend(collect_platform_callback_property_names(file_names)?);
    names.extend(collect_reflective_property_names(file_names)?);
    names.extend(collect_string_defined_property_hazards(file_names)?);
    Ok(names)
}

fn collect_platform_callback_property_names(
    file_names: &[String],
) -> std::result::Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        let module = get_or_parse_cached_module(&file_path)?;
        let mut collector = PlatformCallbackNameCollector::default();
        module.visit_with(&mut collector);
        names.extend(collector.names);
    }
    Ok(names)
}

fn collect_reflective_property_names(
    file_names: &[String],
) -> std::result::Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        let module = get_or_parse_cached_module(&file_path)?;
        let mut collector = ReflectivePropertyNameCollector::default();
        module.visit_with(&mut collector);
        names.extend(collector.names);
    }
    Ok(names)
}

fn collect_string_defined_property_hazards(
    file_names: &[String],
) -> std::result::Result<HashSet<String>, String> {
    let mut defined_names = HashSet::new();
    let mut accessed_names = HashSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        let module = get_or_parse_cached_module(&file_path)?;
        let mut collector = StringDefinedPropertyHazardCollector::default();
        module.visit_with(&mut collector);
        defined_names.extend(collector.defined_names);
        accessed_names.extend(collector.accessed_names);
    }
    Ok(defined_names
        .intersection(&accessed_names)
        .cloned()
        .collect())
}

pub(super) fn collect_static_property_names_from_text(source_text: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    for (_, property_name) in collect_class_static_assignments(source_text) {
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

#[derive(Default)]
pub(super) struct StaticPropertyNameCollector {
    class_name_stack: Vec<Option<String>>,
    pub(super) names: HashSet<String>,
    static_context_depth: usize,
}

impl StaticPropertyNameCollector {
    fn with_static_context<F>(&mut self, callback: F)
    where
        F: FnOnce(&mut Self),
    {
        self.static_context_depth += 1;
        callback(self);
        self.static_context_depth -= 1;
    }

    fn current_class_name(&self) -> Option<&str> {
        self.class_name_stack
            .last()
            .and_then(|name| name.as_deref())
    }

    fn insert_prop_name(&mut self, prop_name: Option<String>) {
        if let Some(prop_name) = prop_name {
            if is_hard_static_interop_name(&prop_name) {
                self.names.insert(prop_name);
            }
        }
    }
}

impl Visit for StaticPropertyNameCollector {
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

    fn visit_class_member(&mut self, member: &swc_core::ecma::ast::ClassMember) {
        match member {
            swc_core::ecma::ast::ClassMember::ClassProp(prop) => {
                if prop.is_static {
                    self.insert_prop_name(prop_name_to_string(&prop.key));
                }
                prop.visit_children_with(self);
            }
            swc_core::ecma::ast::ClassMember::Method(method) => {
                if method.is_static {
                    self.insert_prop_name(prop_name_to_string(&method.key));
                }
                if method.is_static {
                    self.with_static_context(|collector| method.function.visit_with(collector));
                } else {
                    method.visit_children_with(self);
                }
            }
            swc_core::ecma::ast::ClassMember::PrivateMethod(method) => {
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
                self.insert_prop_name(member_prop_name(&member_expr.prop));
            }
        }
        member_expr.visit_children_with(self);
    }
}

#[derive(Default)]
struct PlatformCallbackNameCollector {
    names: HashSet<String>,
}

impl PlatformCallbackNameCollector {
    fn insert_prop_name(&mut self, prop_name: Option<String>) {
        if let Some(prop_name) = prop_name {
            if is_hard_platform_callback_name(&prop_name) {
                self.names.insert(prop_name);
            }
        }
    }
}

impl Visit for PlatformCallbackNameCollector {
    fn visit_class_member(&mut self, member: &swc_core::ecma::ast::ClassMember) {
        match member {
            swc_core::ecma::ast::ClassMember::Method(method) => {
                self.insert_prop_name(prop_name_to_string(&method.key));
                method.visit_children_with(self);
            }
            swc_core::ecma::ast::ClassMember::ClassProp(prop) => {
                self.insert_prop_name(prop_name_to_string(&prop.key));
                prop.visit_children_with(self);
            }
            _ => member.visit_children_with(self),
        }
    }

    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        self.insert_prop_name(member_prop_name(&member_expr.prop));
        member_expr.visit_children_with(self);
    }

    fn visit_super_prop_expr(&mut self, super_prop: &SuperPropExpr) {
        match &super_prop.prop {
            SuperProp::Ident(ident) => {
                self.insert_prop_name(Some(ident.sym.to_string()));
            }
            SuperProp::Computed(computed) => {
                if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &*computed.expr {
                    self.insert_prop_name(Some(value.value.to_string_lossy().to_string()));
                }
            }
        }
        super_prop.visit_children_with(self);
    }
}

#[derive(Default)]
struct ReflectivePropertyNameCollector {
    names: HashSet<String>,
}

impl ReflectivePropertyNameCollector {
    fn insert(&mut self, property_name: &str) {
        if is_valid_js_identifier(property_name) {
            self.names.insert(property_name.to_string());
        }
    }
}

#[derive(Default)]
struct StringDefinedPropertyHazardCollector {
    accessed_names: HashSet<String>,
    defined_names: HashSet<String>,
}

impl StringDefinedPropertyHazardCollector {
    fn insert_accessed(&mut self, property_name: &str) {
        if is_valid_js_identifier(property_name) {
            self.accessed_names.insert(property_name.to_string());
        }
    }

    fn insert_defined(&mut self, property_name: Option<String>) {
        if let Some(property_name) = property_name {
            if is_valid_js_identifier(&property_name) {
                self.defined_names.insert(property_name);
            }
        }
    }
}

impl Visit for StringDefinedPropertyHazardCollector {
    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        if let MemberProp::Ident(prop_ident) = &member_expr.prop {
            self.insert_accessed(prop_ident.sym.as_ref());
        }
        member_expr.visit_children_with(self);
    }

    fn visit_super_prop_expr(&mut self, super_prop: &SuperPropExpr) {
        if let SuperProp::Ident(prop_ident) = &super_prop.prop {
            self.insert_accessed(prop_ident.sym.as_ref());
        }
        super_prop.visit_children_with(self);
    }

    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        if declarator.init.is_some() {
            collect_pattern_property_reads(&declarator.name, &mut self.accessed_names);
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
                    self.insert_defined(string_defined_prop_name(&key_value.key));
                }
                swc_core::ecma::ast::Prop::Getter(getter) => {
                    self.insert_defined(string_defined_prop_name(&getter.key));
                }
                swc_core::ecma::ast::Prop::Setter(setter) => {
                    self.insert_defined(string_defined_prop_name(&setter.key));
                }
                swc_core::ecma::ast::Prop::Method(method) => {
                    self.insert_defined(string_defined_prop_name(&method.key));
                }
                _ => {}
            }
        }
        object_lit.visit_children_with(self);
    }

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        if let Callee::Expr(callee_expr) = &call_expr.callee {
            match &**callee_expr {
                Expr::Ident(ident) if ident.sym == *"__publicField" && call_expr.args.len() >= 2 => {
                    if let Some(ExprOrSpread { expr, .. }) = call_expr.args.get(1) {
                        self.insert_defined(string_literal_expr_name(expr));
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
                        (Some("Reflect"), Some("defineProperty")) => Some(1usize),
                        _ => None,
                    };
                    if let Some(index) = string_arg_index {
                        if let Some(ExprOrSpread { expr, .. }) = call_expr.args.get(index) {
                            self.insert_defined(string_literal_expr_name(expr));
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
        Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => template
            .quasis
            .first()
            .map(|quasi| quasi.raw.to_string()),
        _ => None,
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

impl Visit for ReflectivePropertyNameCollector {
    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        if let MemberProp::Computed(computed) = &member_expr.prop {
            if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &*computed.expr {
                self.insert(&value.value.to_string_lossy());
            }
        }
        member_expr.visit_children_with(self);
    }

    fn visit_prop_name(&mut self, prop_name: &PropName) {
        if let PropName::Str(value) = prop_name {
            self.insert(&value.value.to_string_lossy());
        }
        prop_name.visit_children_with(self);
    }

    fn visit_bin_expr(&mut self, bin_expr: &BinExpr) {
        if bin_expr.op == swc_core::ecma::ast::BinaryOp::In {
            if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &*bin_expr.left {
                self.insert(&value.value.to_string_lossy());
            }
        }
        bin_expr.visit_children_with(self);
    }

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        match &call_expr.callee {
            Callee::Expr(callee_expr) => match &**callee_expr {
                Expr::Ident(ident) if ident.sym == *"JSCompiler_renameProperty" => {
                    if let Some(ExprOrSpread { expr, .. }) = call_expr.args.first() {
                        if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &**expr {
                            self.insert(&value.value.to_string_lossy());
                        }
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
                            if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &**expr {
                                self.insert(&value.value.to_string_lossy());
                            }
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
        call_expr.visit_children_with(self);
    }
}

pub(super) fn is_valid_js_identifier(name: &str) -> bool {
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

pub(super) fn collect_names_from_files(
    file_names: &[String],
    collect_names: fn(&str) -> HashSet<String>,
) -> std::result::Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let source_text = fs::read_to_string(file_name).map_err(|error| error.to_string())?;
        names.extend(collect_names(&source_text));
    }
    Ok(names)
}

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

pub(super) fn prop_name_to_string(prop_name: &PropName) -> Option<String> {
    match prop_name {
        PropName::Ident(ident) => Some(ident.sym.to_string()),
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Num(value) => Some(value.value.to_string()),
        _ => None,
    }
}
