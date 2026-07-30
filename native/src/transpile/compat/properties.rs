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
/// that must match runtime strings. Rules can also follow immutable object
/// bindings and values produced by another literal-gated configured call.
pub(crate) struct ClassMapCallCompatVisitor {
    calls: HashMap<String, Vec<ClassMapCallRule>>,
    /// local import binding Id -> imported export name, so compiler aliases
    /// still match configured callees without matching same-spelled shadows.
    import_aliases: HashMap<Id, String>,
    /// Immutable bindings proven to carry a value created from a literal
    /// contract (for example `const button = createElement("button")`).
    literal_contract_bindings: HashSet<Id>,
    /// Immutable object bindings passed to configured calls. Vue hoists static
    /// DOM props into module-level constants before calling its vnode helpers.
    object_binding_rules: HashMap<Id, Vec<ClassMapCallRule>>,
}

fn compile_optional_pattern(
    callee: &str,
    field: &str,
    pattern: Option<&str>,
) -> std::result::Result<Option<regex::Regex>, String> {
    pattern
        .map(|pattern| {
            regex::Regex::new(pattern).map_err(|error| {
                format!(
                    "Invalid compat.classMapCalls rule for callee {callee:?}: {field} uses unsupported regex syntax: {error}"
                )
            })
        })
        .transpose()
}

pub(crate) fn validate_class_map_calls(
    calls: &[ClassMapCallInput],
) -> std::result::Result<(), String> {
    for call in calls {
        compile_optional_pattern(&call.callee, "keyPattern", call.keyPattern.as_deref())?;
        compile_optional_pattern(
            &call.callee,
            "keyExcludePattern",
            call.keyExcludePattern.as_deref(),
        )?;
        compile_optional_pattern(
            &call.callee,
            "calleeModulePattern",
            call.calleeModulePattern.as_deref(),
        )?;
        parse_key_source(&call.callee, call.keySource.as_deref())?;
    }
    Ok(())
}

/// One configured quoting rule for a call: which argument holds the object
/// literal, which keys it covers, and whether it is gated on another
/// argument carrying literal-contract provenance.
#[derive(Clone)]
struct ClassMapCallRule {
    arg_index: usize,
    key_exclude_pattern: Option<regex::Regex>,
    key_pattern: Option<regex::Regex>,
    string_literal_arg_index: Option<usize>,
}

impl ClassMapCallCompatVisitor {
    pub(crate) fn new(
        calls: &[ClassMapCallInput],
        import_aliases: HashMap<Id, String>,
        program: &Program,
    ) -> Self {
        let mut grouped: HashMap<String, Vec<ClassMapCallRule>> = HashMap::new();
        for call in calls {
            // Pair-array rules pin keys that are already string literals; they
            // are collected as preserved names instead of quoted here.
            if parse_key_source(&call.callee, call.keySource.as_deref())
                .expect("class-map rules were validated")
                == ClassMapKeySource::PairArray
            {
                continue;
            }
            // `transpile_sources` validates these before parallel file work.
            let key_pattern =
                compile_optional_pattern(&call.callee, "keyPattern", call.keyPattern.as_deref())
                    .expect("class-map rules were validated");
            let key_exclude_pattern = compile_optional_pattern(
                &call.callee,
                "keyExcludePattern",
                call.keyExcludePattern.as_deref(),
            )
            .expect("class-map rules were validated");
            grouped
                .entry(call.callee.clone())
                .or_default()
                .push(ClassMapCallRule {
                    arg_index: call.argIndex as usize,
                    key_exclude_pattern,
                    key_pattern,
                    string_literal_arg_index: call
                        .stringLiteralArgIndex
                        .map(|index| index as usize),
                });
        }
        let mut visitor = Self {
            calls: grouped,
            import_aliases,
            literal_contract_bindings: HashSet::new(),
            object_binding_rules: HashMap::new(),
        };
        visitor.literal_contract_bindings = visitor.collect_literal_contract_bindings(program);
        visitor.object_binding_rules = visitor.collect_object_binding_rules(program);
        visitor
    }

    fn collect_literal_contract_bindings(&self, program: &Program) -> HashSet<Id> {
        let mut collector = ConstBindingInitializerCollector::default();
        program.visit_with(&mut collector);
        let mut bindings = HashSet::new();
        loop {
            let mut changed = false;
            for (binding, initializer) in &collector.initializers {
                if !bindings.contains(binding)
                    && self.expr_has_literal_contract(initializer, &bindings)
                {
                    bindings.insert(binding.clone());
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        bindings
    }

    fn collect_object_binding_rules(
        &self,
        program: &Program,
    ) -> HashMap<Id, Vec<ClassMapCallRule>> {
        let mut binding_collector = ConstBindingInitializerCollector::default();
        program.visit_with(&mut binding_collector);
        let const_bindings = binding_collector
            .initializers
            .into_iter()
            .map(|(binding, _)| binding)
            .collect::<HashSet<_>>();
        let mut collector = ObjectBindingEvidenceCollector {
            const_bindings: &const_bindings,
            rules: HashMap::new(),
            visitor: self,
        };
        program.visit_with(&mut collector);
        collector.rules
    }

    fn expr_has_literal_contract(&self, expr: &Expr, bindings: &HashSet<Id>) -> bool {
        let expr = unwrap_transparent_expr(expr);
        match expr {
            Expr::Lit(Lit::Str(_)) => true,
            Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => true,
            Expr::Ident(ident) => bindings.contains(&ident.to_id()),
            Expr::Call(call) => self.call_has_literal_contract(call, bindings),
            _ => false,
        }
    }

    fn call_has_literal_contract(&self, call: &CallExpr, bindings: &HashSet<Id>) -> bool {
        let Some(rules) = self.rules_for_call(call) else {
            return false;
        };
        rules.iter().any(|rule| {
            rule.string_literal_arg_index.is_some_and(|index| {
                call.args
                    .get(index)
                    .is_some_and(|arg| self.expr_has_literal_contract(&arg.expr, bindings))
            })
        })
    }

    fn gate_matches(&self, call: &CallExpr, rule: &ClassMapCallRule) -> bool {
        rule.string_literal_arg_index.is_none_or(|index| {
            call.args.get(index).is_some_and(|arg| {
                self.expr_has_literal_contract(&arg.expr, &self.literal_contract_bindings)
            })
        })
    }

    fn rules_for_call(&self, call: &CallExpr) -> Option<&Vec<ClassMapCallRule>> {
        let Callee::Expr(callee) = &call.callee else {
            return None;
        };
        let (local_name, local_id) = callee_local_binding(callee)?;
        let callee_name = local_id
            .as_ref()
            .and_then(|id| self.import_aliases.get(id))
            .map(String::as_str)
            .unwrap_or(local_name.as_str());
        self.calls.get(callee_name)
    }
}

#[derive(Default)]
struct ConstBindingInitializerCollector {
    initializers: Vec<(Id, Box<Expr>)>,
}

impl Visit for ConstBindingInitializerCollector {
    fn visit_var_decl(&mut self, declaration: &VarDecl) {
        if declaration.kind == VarDeclKind::Const {
            for declarator in &declaration.decls {
                let (Pat::Ident(binding), Some(initializer)) = (&declarator.name, &declarator.init)
                else {
                    continue;
                };
                self.initializers
                    .push((binding.id.to_id(), initializer.clone()));
            }
        }
        declaration.visit_children_with(self);
    }
}

struct ObjectBindingEvidenceCollector<'a> {
    const_bindings: &'a HashSet<Id>,
    rules: HashMap<Id, Vec<ClassMapCallRule>>,
    visitor: &'a ClassMapCallCompatVisitor,
}

impl Visit for ObjectBindingEvidenceCollector<'_> {
    fn visit_call_expr(&mut self, call: &CallExpr) {
        if let Some(rules) = self.visitor.rules_for_call(call) {
            for rule in rules {
                if !self.visitor.gate_matches(call, rule) {
                    continue;
                }
                let Some(argument) = call.args.get(rule.arg_index) else {
                    continue;
                };
                let Expr::Ident(binding) = unwrap_transparent_expr(&argument.expr) else {
                    continue;
                };
                let binding = binding.to_id();
                if self.const_bindings.contains(&binding) {
                    self.rules.entry(binding).or_default().push(rule.clone());
                }
            }
        }
        call.visit_children_with(self);
    }
}

fn unwrap_transparent_expr(mut expr: &Expr) -> &Expr {
    while let Expr::Paren(parenthesized) = expr {
        expr = &parenthesized.expr;
    }
    expr
}

fn object_literal_mut(expr: &mut Expr) -> Option<&mut swc_core::ecma::ast::ObjectLit> {
    match expr {
        Expr::Object(object) => Some(object),
        Expr::Paren(parenthesized) => object_literal_mut(&mut parenthesized.expr),
        _ => None,
    }
}

fn callee_local_binding(callee: &Expr) -> Option<(String, Option<Id>)> {
    match unwrap_transparent_expr(callee) {
        Expr::Ident(ident) => Some((ident.sym.to_string(), Some(ident.to_id()))),
        Expr::Member(member) => {
            let name = match &member.prop {
                MemberProp::Ident(prop) => prop.sym.to_string(),
                // CommonJS namespace access is quoted before this pass runs.
                MemberProp::Computed(computed) => string_literal_expr(&computed.expr)?,
                MemberProp::PrivateName(_) => return None,
            };
            Some((name, None))
        }
        _ => None,
    }
}

fn string_literal_expr(expr: &Expr) -> Option<String> {
    match unwrap_transparent_expr(expr) {
        Expr::Lit(Lit::Str(value)) => Some(value.value.to_string_lossy().to_string()),
        Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => {
            template.quasis.first().map(|quasi| {
                quasi
                    .cooked
                    .as_ref()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_else(|| quasi.raw.to_string())
            })
        }
        _ => None,
    }
}

impl VisitMut for ClassMapCallCompatVisitor {
    fn visit_mut_var_declarator(&mut self, declarator: &mut VarDeclarator) {
        declarator.visit_mut_children_with(self);
        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(rules) = self.object_binding_rules.get(&binding.id.to_id()).cloned() else {
            return;
        };
        let Some(initializer) = &mut declarator.init else {
            return;
        };
        let Some(object) = object_literal_mut(initializer) else {
            return;
        };
        for rule in rules {
            quote_object_literal_keys(
                object,
                rule.key_pattern.as_ref(),
                rule.key_exclude_pattern.as_ref(),
            );
        }
    }

    fn visit_mut_call_expr(&mut self, call: &mut CallExpr) {
        call.visit_mut_children_with(self);
        let Some(rules) = self.rules_for_call(call).cloned() else {
            return;
        };
        for rule in rules {
            if !self.gate_matches(call, &rule) {
                continue;
            }
            let Some(argument) = call.args.get_mut(rule.arg_index) else {
                continue;
            };
            let Some(object) = object_literal_mut(&mut argument.expr) else {
                continue;
            };
            quote_object_literal_keys(
                object,
                rule.key_pattern.as_ref(),
                rule.key_exclude_pattern.as_ref(),
            );
        }
    }
}

fn quote_object_literal_keys(
    class_map: &mut swc_core::ecma::ast::ObjectLit,
    key_pattern: Option<&regex::Regex>,
    key_exclude_pattern: Option<&regex::Regex>,
) {
    let matches_pattern = |name: &str| {
        if key_exclude_pattern.is_some_and(|pattern| pattern.is_match(name)) {
            return false;
        }
        key_pattern
            .map(|pattern| pattern.is_match(name))
            .unwrap_or(true)
    };
    let prop_name_matches = |prop_name: &PropName| match prop_name {
        PropName::Ident(ident) => matches_pattern(ident.sym.as_ref()),
        PropName::Num(_) => key_pattern.is_none() && key_exclude_pattern.is_none(),
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

// ---------------------------------------------------------------------------
// Pair-array key source
// ---------------------------------------------------------------------------

/// The key-source shapes a `classMapCalls` rule can pin.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClassMapKeySource {
    ObjectLiteral,
    PairArray,
}

pub(crate) fn parse_key_source(
    callee: &str,
    value: Option<&str>,
) -> std::result::Result<ClassMapKeySource, String> {
    match value {
        None | Some("objectLiteral") => Ok(ClassMapKeySource::ObjectLiteral),
        Some("pairArray") => Ok(ClassMapKeySource::PairArray),
        Some(other) => Err(format!(
            "Invalid compat.classMapCalls rule for callee {callee:?}: keySource must be \"objectLiteral\" or \"pairArray\", got {other:?}."
        )),
    }
}

/// Local binding -> the export name and module specifier it was imported from.
///
/// Callee spelling is not identity: `_export_sfc` is a local alias for the
/// default export of a virtual module, and bundlers rename such locals freely.
fn collect_import_identities(module: &Module) -> HashMap<Id, (String, String)> {
    let mut identities = HashMap::new();
    for item in &module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import)) = item else {
            continue;
        };
        let specifier_text = import.src.value.to_string_lossy().to_string();
        for specifier in &import.specifiers {
            match specifier {
                ImportSpecifier::Named(named) => {
                    let imported = named
                        .imported
                        .as_ref()
                        .map(module_export_name_to_string)
                        .unwrap_or_else(|| named.local.sym.to_string());
                    identities.insert(named.local.to_id(), (imported, specifier_text.clone()));
                }
                ImportSpecifier::Default(default_specifier) => {
                    identities.insert(
                        default_specifier.local.to_id(),
                        ("default".to_string(), specifier_text.clone()),
                    );
                }
                // A namespace import is not a callee identity: the call goes
                // through a member expression whose property may itself be
                // renamed, so it contributes nothing.
                ImportSpecifier::Namespace(_) => {}
            }
        }
    }
    identities
}

/// Property names pinned by `keySource: "pairArray"` rules in one module.
///
/// Helper functions such as plugin-vue's `_export_sfc(target, [["render", fn]])`
/// splat entries onto a target with `target[key] = value`, i.e. the *definition*
/// uses the string, while the consuming runtime reads `target.render` as a dot
/// property. Renaming only the dot side leaves the target without the member.
/// Every entry must prove its own key: anything irregular contributes nothing.
pub(crate) fn collect_pair_array_class_map_property_names(
    module: &Module,
    calls: &[ClassMapCallInput],
) -> std::result::Result<HashSet<String>, String> {
    let mut rules = Vec::new();
    for call in calls {
        if parse_key_source(&call.callee, call.keySource.as_deref())?
            != ClassMapKeySource::PairArray
        {
            continue;
        }
        let module_pattern = compile_optional_pattern(
            &call.callee,
            "calleeModulePattern",
            call.calleeModulePattern.as_deref(),
        )?;
        let key_pattern =
            compile_optional_pattern(&call.callee, "keyPattern", call.keyPattern.as_deref())?;
        let key_exclude_pattern = compile_optional_pattern(
            &call.callee,
            "keyExcludePattern",
            call.keyExcludePattern.as_deref(),
        )?;
        rules.push((
            call.argIndex as usize,
            call.callee.clone(),
            module_pattern,
            key_pattern,
            key_exclude_pattern,
        ));
    }
    if rules.is_empty() {
        return Ok(HashSet::new());
    }

    let mut collector = PairArrayKeyCollector {
        identities: collect_import_identities(module),
        names: HashSet::new(),
        rules,
    };
    module.visit_with(&mut collector);
    Ok(collector.names)
}

struct PairArrayKeyCollector {
    identities: HashMap<Id, (String, String)>,
    names: HashSet<String>,
    #[allow(clippy::type_complexity)]
    rules: Vec<(
        usize,
        String,
        Option<regex::Regex>,
        Option<regex::Regex>,
        Option<regex::Regex>,
    )>,
}

impl swc_core::ecma::visit::Visit for PairArrayKeyCollector {
    fn visit_call_expr(&mut self, call: &CallExpr) {
        call.visit_children_with(self);
        let Callee::Expr(callee) = &call.callee else {
            return;
        };
        let Expr::Ident(identifier) = &**callee else {
            return;
        };
        let Some((imported_name, specifier)) = self.identities.get(&identifier.to_id()) else {
            return;
        };
        for (arg_index, callee_export, module_pattern, key_pattern, key_exclude_pattern) in
            &self.rules
        {
            if imported_name != callee_export {
                continue;
            }
            if let Some(pattern) = module_pattern {
                if !pattern.is_match(specifier) {
                    continue;
                }
            }
            let Some(argument) = call.args.get(*arg_index) else {
                continue;
            };
            if argument.spread.is_some() {
                continue;
            }
            let Expr::Array(entries) = &*argument.expr else {
                continue;
            };
            for entry in &entries.elems {
                // A hole, a spread, a non-array entry, or an entry whose first
                // element is not a plain string literal proves nothing.
                let Some(entry) = entry else { continue };
                if entry.spread.is_some() {
                    continue;
                }
                let Expr::Array(pair) = &*entry.expr else {
                    continue;
                };
                let Some(Some(first)) = pair.elems.first() else {
                    continue;
                };
                if first.spread.is_some() {
                    continue;
                }
                let Expr::Lit(swc_core::ecma::ast::Lit::Str(key)) = &*first.expr else {
                    continue;
                };
                let key = key.value.to_string_lossy().to_string();
                if key_exclude_pattern
                    .as_ref()
                    .is_some_and(|pattern| pattern.is_match(&key))
                {
                    continue;
                }
                if key_pattern
                    .as_ref()
                    .is_some_and(|pattern| !pattern.is_match(&key))
                {
                    continue;
                }
                self.names.insert(key);
            }
        }
    }
}
