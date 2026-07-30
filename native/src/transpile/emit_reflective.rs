//! Pre-Closure detection of property names read reflectively through `for...in`.
//!
//! `for (const key in props) { if (key === "variant") ... }` reads a property
//! name as *data*. Closure renames the property but cannot see the comparison,
//! so the literal has to keep matching. The pipeline used to fix that up in
//! Closure's output by respelling string literals from the property-renaming
//! report — which could not distinguish a property key from a network JSON key
//! or a UI label, and silently corrupted both.
//!
//! Deciding it here is easy and sound, because the syntax is still intact: a
//! literal compared against a `for...in` binding, or listed in a filter list
//! tested against one, is a property name. Feeding those names into the
//! preserved-property channel makes Closure leave them alone, so no literal
//! ever needs respelling. Over-approximating costs bytes; it cannot change
//! behaviour, which is the correct direction for this trade.
//!
//! Compiled component frameworks split that shape across two functions in the
//! same module: the exclusion list is an array literal at the **call site**
//! while `keys.includes(key)` lives in the **callee**.
//!
//! ```js
//! function prop(props, key) { return props[key]; }
//! function rest_props(props, keys) {
//!   for (const key in props) { if (keys.includes(key)) continue; ... }
//! }
//! function render(props) {
//!   prop(props, "variant");
//!   rest_props(props, ["$$slots", "$$events", "$$legacy", "variant"]);
//! }
//! ```
//!
//! So parameter positions are classified first: a parameter used as the key of
//! an element access on *another* parameter is a key-read position, and a
//! parameter tested with `.includes(k)` where `k` iterates *another* parameter
//! is an exclusion-list position. Any same-module call that passes string
//! literals into such a position is then passing property names.
//!
//! Everything here is keyed on resolved [`Id`]s rather than spellings, and only
//! literal flows are followed: no name is ever guessed, and a binding that is
//! declared twice or reassigned is dropped from the table entirely.

use std::collections::{BTreeSet, HashMap, HashSet};

use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{Visit, VisitWith};
use super::identity::{BindingKey, BindingKeyMap, BindingKeySet};

pub(super) fn collect_reflective_property_names(program: &Program) -> BTreeSet<String> {
    let mut lists = ReflectiveListBindings {
        lists: HashMap::new(),
    };
    program.visit_with(&mut lists);

    let mut functions = LocalFunctionRoles::default();
    program.visit_with(&mut functions);
    functions.drop_ambiguous_bindings();

    let mut collector = ReflectiveKeys {
        for_in_bindings: HashSet::new(),
        functions,
        lists: lists.lists,
        names: BTreeSet::new(),
    };
    program.visit_with(&mut collector);
    collector.names
}

#[cfg(test)]
pub(super) fn collect_reflective_property_names_for_test(source: &str) -> BTreeSet<String> {
    super::GLOBALS.set(&super::Globals::new(), || {
        let module =
            crate::module_cache::parse_module(std::path::Path::new("fixture.js"), source)
                .expect("swc reflective parity parse");
        let mut program = Program::Module(module);
        super::apply_resolver_and_global_this_compat(&mut program, true)
            .expect("swc reflective parity resolver");
        collect_reflective_property_names(&program)
    })
}

/// What a same-module call passes into a given parameter position.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ParameterRole {
    /// The parameter is used as the key of an element access on another
    /// parameter: `function prop(props, key) { return props[key]; }`.
    KeyRead,
    /// The parameter is tested for membership against a `for...in` key over
    /// another parameter: `if (keys.includes(key)) continue;`.
    ExclusionList,
}

/// `const exclude = ["a", "b"]` / `const exclude = "a b".split(" ")`.
struct ReflectiveListBindings {
    lists: BindingKeyMap<Vec<String>>,
}

impl Visit for ReflectiveListBindings {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);
        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(initializer) = declarator.init.as_deref() else {
            return;
        };
        if let Some(values) = string_list(initializer) {
            self.lists.insert(BindingKey::of_binding(&binding), values);
        }
    }
}

/// Parameter roles for every function bound to a name in this module.
#[derive(Default)]
struct LocalFunctionRoles {
    roles: BindingKeyMap<Vec<Option<ParameterRole>>>,
    /// Names bound more than once, or reassigned: a call through such a name
    /// cannot be attributed to one function body, so it is not attributed at
    /// all.
    ambiguous: BindingKeySet,
}

impl LocalFunctionRoles {
    fn record(&mut self, binding: BindingKey, roles: Vec<Option<ParameterRole>>) {
        if self.roles.insert(binding.clone(), roles).is_some() {
            self.ambiguous.insert(binding);
        }
    }

    fn drop_ambiguous_bindings(&mut self) {
        for binding in &self.ambiguous {
            self.roles.remove(binding);
        }
    }

    fn roles_for(&self, binding: &BindingKey) -> Option<&[Option<ParameterRole>]> {
        self.roles.get(binding).map(Vec::as_slice)
    }
}

impl Visit for LocalFunctionRoles {
    fn visit_fn_decl(&mut self, declaration: &FnDecl) {
        declaration.visit_children_with(self);
        let parameters = declaration
            .function
            .params
            .iter()
            .map(|parameter| binding_id(&parameter.pat))
            .collect::<Vec<_>>();
        if let Some(body) = &declaration.function.body {
            self.record(
                BindingKey::of(&declaration.ident),
                classify_parameters(&parameters, body),
            );
        }
    }

    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);
        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(initializer) = declarator.init.as_deref() else {
            return;
        };
        match initializer {
            Expr::Fn(function) => {
                let parameters = function
                    .function
                    .params
                    .iter()
                    .map(|parameter| binding_id(&parameter.pat))
                    .collect::<Vec<_>>();
                if let Some(body) = &function.function.body {
                    self.record(BindingKey::of_binding(&binding), classify_parameters(&parameters, body));
                }
            }
            Expr::Arrow(arrow) => {
                let parameters = arrow.params.iter().map(binding_id).collect::<Vec<_>>();
                if let BlockStmtOrExpr::BlockStmt(body) = &*arrow.body {
                    self.record(BindingKey::of_binding(&binding), classify_parameters(&parameters, body));
                }
            }
            _ => {}
        }
    }

    fn visit_assign_expr(&mut self, assignment: &AssignExpr) {
        assignment.visit_children_with(self);
        if let AssignTarget::Simple(SimpleAssignTarget::Ident(target)) = &assignment.left {
            self.ambiguous.insert(BindingKey::of_binding(&target));
        }
    }
}

/// Infers each parameter's role from how the function body uses it.
fn classify_parameters(parameters: &[Option<BindingKey>], body: &BlockStmt) -> Vec<Option<ParameterRole>> {
    let indices = parameters
        .iter()
        .enumerate()
        .filter_map(|(index, binding)| binding.clone().map(|binding| (binding, index)))
        .collect::<HashMap<_, _>>();
    if indices.is_empty() {
        return vec![None; parameters.len()];
    }
    let mut scan = ParameterUseScan {
        for_in_keys: Vec::new(),
        parameters: indices,
        roles: vec![None; parameters.len()],
    };
    body.visit_with(&mut scan);
    scan.roles
}

struct ParameterUseScan {
    /// Live `for...in` bindings, each paired with the parameter index it
    /// iterates.
    for_in_keys: Vec<(BindingKey, usize)>,
    parameters: BindingKeyMap<usize>,
    roles: Vec<Option<ParameterRole>>,
}

impl ParameterUseScan {
    fn iterated_parameter(&self, key: &BindingKey) -> Option<usize> {
        self.for_in_keys
            .iter()
            .rev()
            .find_map(|(binding, index)| (binding == key).then_some(*index))
    }
}

impl Visit for ParameterUseScan {
    fn visit_for_in_stmt(&mut self, statement: &ForInStmt) {
        statement.right.visit_with(self);
        let iterated = match &*statement.right {
            Expr::Ident(object) => self.parameters.get(&BindingKey::of(&object)).copied(),
            _ => None,
        };
        let binding = for_in_binding_id(&statement.left);
        let tracked = match (binding, iterated) {
            (Some(binding), Some(iterated)) => {
                self.for_in_keys.push((binding, iterated));
                true
            }
            _ => false,
        };
        statement.body.visit_with(self);
        if tracked {
            self.for_in_keys.pop();
        }
    }

    fn visit_member_expr(&mut self, member: &MemberExpr) {
        member.visit_children_with(self);
        let Expr::Ident(object) = &*member.obj else {
            return;
        };
        let MemberProp::Computed(computed) = &member.prop else {
            return;
        };
        let Expr::Ident(key) = &*computed.expr else {
            return;
        };
        let (Some(object_index), Some(key_index)) = (
            self.parameters.get(&BindingKey::of(&object)).copied(),
            self.parameters.get(&BindingKey::of(&key)).copied(),
        ) else {
            return;
        };
        // `props[props]` proves nothing; the key has to name a *different*
        // parameter than the object it indexes.
        if object_index == key_index {
            return;
        }
        self.roles[key_index] = Some(ParameterRole::KeyRead);
    }

    fn visit_call_expr(&mut self, call: &CallExpr) {
        call.visit_children_with(self);
        let Some(test) = membership_test(call) else {
            return;
        };
        let Expr::Ident(list) = test.list else {
            return;
        };
        let Some(list_index) = self.parameters.get(&BindingKey::of(&list)).copied() else {
            return;
        };
        let Some(iterated_index) = self.iterated_parameter(&test.key) else {
            return;
        };
        if list_index == iterated_index {
            return;
        }
        self.roles[list_index] = Some(ParameterRole::ExclusionList);
    }
}

struct ReflectiveKeys {
    for_in_bindings: BindingKeySet,
    functions: LocalFunctionRoles,
    lists: BindingKeyMap<Vec<String>>,
    names: BTreeSet<String>,
}

impl ReflectiveKeys {
    fn collect_string_list(&mut self, expression: &Expr) {
        let values = match expression {
            Expr::Ident(list) => self.lists.get(&BindingKey::of(&list)).cloned(),
            other => string_list(other),
        };
        self.names.extend(values.unwrap_or_default());
    }

    /// Routes a same-module call's literal arguments through the callee's
    /// inferred parameter roles.
    fn collect_from_local_call(&mut self, call: &CallExpr) {
        let Callee::Expr(callee) = &call.callee else {
            return;
        };
        let Expr::Ident(callee) = &**callee else {
            return;
        };
        let Some(roles) = self.functions.roles_for(&BindingKey::of(&callee)) else {
            return;
        };
        let roles = roles.to_vec();
        for (argument, role) in call.args.iter().zip(roles) {
            if argument.spread.is_some() {
                return;
            }
            match role {
                Some(ParameterRole::KeyRead) => {
                    if let Expr::Lit(Lit::Str(literal)) = &*argument.expr {
                        self.names
                            .insert(literal.value.to_string_lossy().to_string());
                    }
                }
                Some(ParameterRole::ExclusionList) => {
                    self.collect_string_list(&argument.expr);
                }
                None => {}
            }
        }
    }
}

impl Visit for ReflectiveKeys {
    fn visit_for_in_stmt(&mut self, statement: &ForInStmt) {
        let binding = for_in_binding_id(&statement.left);
        if let Some(binding) = binding.clone() {
            self.for_in_bindings.insert(binding);
        }
        statement.visit_children_with(self);
        if let Some(binding) = binding {
            self.for_in_bindings.remove(&binding);
        }
    }

    fn visit_bin_expr(&mut self, expression: &BinExpr) {
        expression.visit_children_with(self);
        if !matches!(
            expression.op,
            BinaryOp::EqEqEq | BinaryOp::NotEqEq | BinaryOp::EqEq | BinaryOp::NotEq
        ) {
            return;
        }
        let (left, right) = (&*expression.left, &*expression.right);
        for (identifier, literal) in [(left, right), (right, left)] {
            let Expr::Ident(identifier) = identifier else {
                continue;
            };
            if !self.for_in_bindings.contains(&BindingKey::of(&identifier)) {
                continue;
            }
            if let Expr::Lit(Lit::Str(literal)) = literal {
                self.names
                    .insert(literal.value.to_string_lossy().to_string());
            }
        }
    }

    fn visit_call_expr(&mut self, call: &CallExpr) {
        call.visit_children_with(self);
        self.collect_from_local_call(call);
        let Some(test) = membership_test(call) else {
            return;
        };
        if !self.for_in_bindings.contains(&test.key) {
            return;
        }
        self.collect_string_list(test.list);
    }
}

/// `<list>.includes(<key>)` / `.indexOf` / `.lastIndexOf` with an identifier
/// argument. The receiver is handed back unresolved so a caller can accept
/// either a named list or an inline `["a", "b"]` / `"a b".split(" ")`.
struct MembershipTest<'a> {
    key: BindingKey,
    list: &'a Expr,
}

fn membership_test(call: &CallExpr) -> Option<MembershipTest<'_>> {
    let Callee::Expr(callee) = &call.callee else {
        return None;
    };
    let Expr::Member(member) = &**callee else {
        return None;
    };
    let MemberProp::Ident(method) = &member.prop else {
        return None;
    };
    if !matches!(method.sym.as_ref(), "includes" | "indexOf" | "lastIndexOf") {
        return None;
    }
    let [argument] = call.args.as_slice() else {
        return None;
    };
    if argument.spread.is_some() {
        return None;
    }
    let Expr::Ident(key) = &*argument.expr else {
        return None;
    };
    Some(MembershipTest {
        key: BindingKey::of(&key),
        list: &member.obj,
    })
}

fn binding_id(pattern: &Pat) -> Option<BindingKey> {
    match pattern {
        Pat::Ident(binding) => Some(BindingKey::of_binding(&binding)),
        _ => None,
    }
}

fn for_in_binding_id(left: &ForHead) -> Option<BindingKey> {
    match left {
        ForHead::VarDecl(declaration) => {
            let [declarator] = declaration.decls.as_slice() else {
                return None;
            };
            binding_id(&declarator.name)
        }
        ForHead::Pat(pattern) => binding_id(pattern),
        ForHead::UsingDecl(_) => None,
    }
}

/// `["a", "b"]` or `"a b".split(" ")`.
fn string_list(expression: &Expr) -> Option<Vec<String>> {
    match expression {
        Expr::Array(array) => {
            let mut values = Vec::with_capacity(array.elems.len());
            for element in &array.elems {
                let element = element.as_ref()?;
                if element.spread.is_some() {
                    return None;
                }
                let Expr::Lit(Lit::Str(literal)) = &*element.expr else {
                    return None;
                };
                values.push(literal.value.to_string_lossy().to_string());
            }
            (!values.is_empty()).then_some(values)
        }
        Expr::Call(call) => {
            let Callee::Expr(callee) = &call.callee else {
                return None;
            };
            let Expr::Member(member) = &**callee else {
                return None;
            };
            let MemberProp::Ident(method) = &member.prop else {
                return None;
            };
            if method.sym.as_ref() != "split" {
                return None;
            }
            let Expr::Lit(Lit::Str(source)) = &*member.obj else {
                return None;
            };
            let [separator] = call.args.as_slice() else {
                return None;
            };
            let Expr::Lit(Lit::Str(separator)) = &*separator.expr else {
                return None;
            };
            let separator = separator.value.to_string_lossy();
            if separator.is_empty() {
                return None;
            }
            let values = source
                .value
                .to_string_lossy()
                .split(separator.as_ref())
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
                .collect::<Vec<_>>();
            (!values.is_empty()).then_some(values)
        }
        Expr::Paren(paren) => string_list(&paren.expr),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module_cache::parse_module;
    use std::path::PathBuf;

    fn collect(source: &str) -> BTreeSet<String> {
        let module = parse_module(&PathBuf::from("m.js"), source).expect("parse");
        collect_reflective_property_names(&Program::Module(module))
    }

    #[test]
    fn collects_keys_compared_against_a_for_in_binding() {
        let names = collect(
            r#"for (const key in attrs) { if (key === "class") { a(key) } else if (key !== "style") { b(key) } }"#,
        );
        assert!(names.contains("class"), "{names:?}");
        assert!(names.contains("style"), "{names:?}");
    }

    #[test]
    fn collects_filter_list_entries_tested_against_a_for_in_binding() {
        let names = collect(
            r#"const exclude = "$$slots $$events variant".split(" ");
               for (const key in props) { if (exclude.includes(key)) continue; use(key) }"#,
        );
        assert!(names.contains("$$slots"), "{names:?}");
        assert!(names.contains("$$events"), "{names:?}");
        assert!(names.contains("variant"), "{names:?}");
    }

    #[test]
    fn collects_inline_array_filter_lists() {
        let names = collect(
            r#"for (const key in props) { if (["a", "b"].indexOf(key) >= 0) continue; use(key) }"#,
        );
        assert_eq!(names, ["a".to_string(), "b".to_string()].into());
    }

    #[test]
    fn ignores_literals_unrelated_to_a_for_in_binding() {
        // The label list and the mode comparison in the miscompilation repro:
        // neither is a property name, and neither may be preserved-by-accident
        // in a way that changes their spelling.
        let names = collect(
            r#"const labels = "variant size".split(" ");
               if (mode === "variant") { render(labels) }"#,
        );
        assert!(names.is_empty(), "{names:?}");
    }

    #[test]
    fn scopes_bindings_to_their_own_loop() {
        let names = collect(
            r#"for (const key in a) { use(key) }
               if (key === "leaked") { use(key) }"#,
        );
        assert!(names.is_empty(), "{names:?}");
    }

    #[test]
    fn collects_cross_function_key_and_exclusion_list_arguments() {
        // The compiled-component shape: the exclusion list is an array literal
        // at the call site, the `includes` test is in the callee, and the two
        // never meet inside one function body.
        let names = collect(
            r#"export function prop(props, key) {
                 return props[key];
               }
               export function rest_props(props, keys) {
                 const next = {};
                 for (const key in props) {
                   if (keys.includes(key)) { continue; }
                   next[key] = props[key];
                 }
                 return next;
               }
               export function render(props) {
                 const variant = prop(props, "variant");
                 const extra = rest_props(props, ["$$slots", "$$events", "$$legacy", "variant"]);
                 return { extra, variant };
               }"#,
        );
        assert!(names.contains("variant"), "{names:?}");
        assert!(names.contains("$$slots"), "{names:?}");
        assert!(names.contains("$$events"), "{names:?}");
        assert!(names.contains("$$legacy"), "{names:?}");
    }

    #[test]
    fn follows_a_named_exclusion_list_into_a_cross_function_call() {
        let names = collect(
            r#"function rest_props(props, keys) {
                 for (const key in props) { if (keys.includes(key)) continue; use(key) }
               }
               const omitted = "a b".split(" ");
               function render(props) { rest_props(props, omitted); }"#,
        );
        assert_eq!(names, ["a".to_string(), "b".to_string()].into());
    }

    #[test]
    fn ignores_calls_through_a_reassigned_binding() {
        // `prop` no longer names one body, so its argument cannot be attributed.
        let names = collect(
            r#"function prop(props, key) { return props[key]; }
               prop = somethingElse;
               function render(props) { prop(props, "variant"); }"#,
        );
        assert!(names.is_empty(), "{names:?}");
    }

    #[test]
    fn ignores_arguments_to_parameters_with_no_reflective_role() {
        // `label` is only ever concatenated; nothing marks it a property name.
        let names = collect(
            r#"function greet(props, label) { return label + props.name; }
               function render(props) { greet(props, "variant"); }"#,
        );
        assert!(names.is_empty(), "{names:?}");
    }
}
