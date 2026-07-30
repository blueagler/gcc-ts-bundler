//! Pre-Closure pooling of TypeScript/tslib lowering helpers.
//!
//! TypeScript's decorator and private-field lowering inlines a fixed set of
//! helper functions (`__esDecorate`, `__runInitializers`, ...) into **every**
//! file that needs them. Scope hoisting then suffixes each copy with the
//! module ordinal, so a program with N decorated modules carries N byte-
//! identical function bodies under N distinct names, and Closure — which does
//! not merge distinct top-level functions — ships all of them.
//!
//! The fix is provenance, not pattern matching: these declarations arrive with
//! the exact names TypeScript gave them, before any optimization. A hoisted
//! module therefore renames such a declaration to a *content-addressed*
//! canonical name (`__esDecorate$$hDEADBEEF`) instead of an ordinal-suffixed
//! one, and hands the declaration itself up to the transpile driver, which
//! emits exactly one copy for the whole program.
//!
//! Content addressing is what makes this sound. Two modules collapse onto one
//! name only when their helper bodies are byte-identical, so an application
//! function that happens to share a helper's *name* but not its *body* keeps a
//! private declaration and is never substituted. Nothing inspects optimizer
//! output, and nothing guesses at a function's meaning from its shape.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use swc_core::ecma::ast::{Decl, Expr, ModuleItem, Stmt};

/// Helper names emitted by the TypeScript compiler's downlevel lowering and by
/// `tslib`. The list is closed on purpose: it is a provenance claim about who
/// wrote the declaration, not a heuristic about what the body does.
const SHARED_HELPER_BASE_NAMES: &[&str] = &[
    "__addDisposableResource",
    "__assign",
    "__asyncDelegator",
    "__asyncGenerator",
    "__asyncValues",
    "__await",
    "__awaiter",
    "__classPrivateFieldGet",
    "__classPrivateFieldIn",
    "__classPrivateFieldSet",
    "__createBinding",
    "__decorate",
    "__disposeResources",
    "__esDecorate",
    "__extends",
    "__generator",
    "__importDefault",
    "__importStar",
    "__makeTemplateObject",
    "__metadata",
    "__param",
    "__propKey",
    "__read",
    "__rest",
    "__runInitializers",
    "__setFunctionName",
    "__spreadArray",
    "__values",
];

pub(super) fn is_shared_helper_base_name(name: &str) -> bool {
    SHARED_HELPER_BASE_NAMES.binary_search(&name).is_ok()
}

/// Content-addressed program-wide name for a lowering helper.
///
/// Modules collapse onto a single declaration exactly when their helper bodies
/// are identical, which is the only case where sharing is meaning-preserving.
pub(super) fn canonical_shared_helper_name(base_name: &str, body_source: &str) -> String {
    let mut hasher = DefaultHasher::new();
    base_name.hash(&mut hasher);
    body_source.hash(&mut hasher);
    format!("{base_name}$$h{:016x}", hasher.finish())
}

/// A lowering-helper declaration lifted out of a module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SharedHelperDeclaration {
    /// Content-addressed name every referencing module now uses.
    pub(super) canonical_name: String,
    /// Printed `var <canonical_name> = function ...;` statement.
    pub(super) text: String,
}

/// The initializer source a helper declaration is content-addressed by, when
/// the declaration is a poolable lowering helper.
///
/// Only single-declarator `var`/`let`/`const` statements bound to a function
/// or arrow expression qualify: that is the exact shape TypeScript emits, and
/// restricting to it keeps ordinary application declarations out of the pool.
pub(super) fn helper_initializer_source(
    declaration: &swc_core::ecma::ast::VarDecl,
    print_expression: impl Fn(&Expr) -> std::result::Result<String, String>,
) -> Option<std::result::Result<String, String>> {
    let [declarator] = declaration.decls.as_slice() else {
        return None;
    };
    let swc_core::ecma::ast::Pat::Ident(binding) = &declarator.name else {
        return None;
    };
    if !is_shared_helper_base_name(binding.id.sym.as_ref()) {
        return None;
    }
    let initializer = declarator.init.as_deref()?;
    if !is_helper_initializer(initializer) {
        return None;
    }
    Some(print_expression(initializer))
}

/// TypeScript writes a lowering helper either bare or behind its ambient
/// reuse guard, `var __x = (this && this.__x) || function (...) {...};`.
/// Both forms qualify; the content address covers the whole initializer, so a
/// guarded copy never collapses onto an unguarded one.
fn is_helper_initializer(initializer: &Expr) -> bool {
    match initializer {
        Expr::Fn(_) | Expr::Arrow(_) => true,
        Expr::Bin(binary) => {
            binary.op == swc_core::ecma::ast::BinaryOp::LogicalOr
                && is_helper_initializer(&binary.right)
        }
        Expr::Paren(paren) => is_helper_initializer(&paren.expr),
        _ => false,
    }
}

/// Removes the module's pooled helper declarations, returning them in source
/// order. Runs after top-level renaming, so the declarations already carry
/// their canonical names.
pub(super) fn take_shared_helper_declarations(
    module: &mut swc_core::ecma::ast::Module,
    canonical_names: &std::collections::HashSet<String>,
    print_item: impl Fn(ModuleItem) -> std::result::Result<String, String>,
) -> std::result::Result<Vec<SharedHelperDeclaration>, String> {
    if canonical_names.is_empty() {
        return Ok(Vec::new());
    }
    let mut taken = Vec::new();
    let mut kept = Vec::with_capacity(module.body.len());
    for item in std::mem::take(&mut module.body) {
        let Some(name) = pooled_declaration_name(&item, canonical_names) else {
            kept.push(item);
            continue;
        };
        taken.push(SharedHelperDeclaration {
            canonical_name: name,
            text: print_item(item)?.trim().to_string(),
        });
    }
    module.body = kept;
    Ok(taken)
}

fn pooled_declaration_name(
    item: &ModuleItem,
    canonical_names: &std::collections::HashSet<String>,
) -> Option<String> {
    let ModuleItem::Stmt(Stmt::Decl(Decl::Var(declaration))) = item else {
        return None;
    };
    let [declarator] = declaration.decls.as_slice() else {
        return None;
    };
    let swc_core::ecma::ast::Pat::Ident(binding) = &declarator.name else {
        return None;
    };
    let name = binding.id.sym.as_ref();
    canonical_names.contains(name).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_bodies_share_a_name_and_different_bodies_do_not() {
        let shared_left =
            canonical_shared_helper_name("__runInitializers", "function(a){return a}");
        let shared_right =
            canonical_shared_helper_name("__runInitializers", "function(a){return a}");
        let other = canonical_shared_helper_name("__runInitializers", "function(a){return a+1}");
        assert_eq!(shared_left, shared_right);
        assert_ne!(shared_left, other);
    }

    #[test]
    fn only_known_lowering_helper_names_are_poolable() {
        assert!(is_shared_helper_base_name("__esDecorate"));
        assert!(is_shared_helper_base_name("__setFunctionName"));
        // The user function from the miscompilation repro.
        assert!(!is_shared_helper_base_name("labelize"));
        assert!(!is_shared_helper_base_name("applyAll"));
        assert!(!is_shared_helper_base_name("__notAHelper"));
    }

    #[test]
    fn shared_helper_base_names_are_sorted_for_binary_search() {
        let mut sorted = SHARED_HELPER_BASE_NAMES.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, SHARED_HELPER_BASE_NAMES);
    }
}

/// Property names that TypeScript's decorator lowering embeds as **string
/// literals** in `__esDecorate` metadata (`{kind, name, access:{has, get, set}}`).
///
/// A decorator receives its target's property key as data, so the literal has
/// to keep matching the property after renaming. The old pipeline achieved
/// that by rewriting the literals in Closure's *output* using the
/// property-renaming report — which cannot tell a metadata key from a network
/// JSON key and silently corrupted both. Preserving the handful of decorated
/// member names instead makes the literals correct by construction.
///
/// The scan is provenance-scoped: it only reads calls to the helper name
/// TypeScript itself emitted, in text TypeScript itself produced.
pub(super) fn collect_decorator_metadata_property_names(
    lowered_source: &swc_core::ecma::ast::Module,
) -> std::collections::BTreeSet<String> {
    let mut collector = DecoratorMetadataNames {
        names: Default::default(),
    };
    swc_core::ecma::visit::VisitWith::visit_with(lowered_source, &mut collector);
    collector.names
}

struct DecoratorMetadataNames {
    names: std::collections::BTreeSet<String>,
}

impl swc_core::ecma::visit::Visit for DecoratorMetadataNames {
    fn visit_call_expr(&mut self, call: &swc_core::ecma::ast::CallExpr) {
        swc_core::ecma::visit::VisitWith::visit_children_with(call, self);
        let swc_core::ecma::ast::Callee::Expr(callee) = &call.callee else {
            return;
        };
        let Expr::Ident(identifier) = &**callee else {
            return;
        };
        // Legacy (`experimentalDecorators`) lowering used by TypeScript,
        // esbuild, oxc, and SWC passes the decorated member name as a string
        // literal in the third argument: `__decorateClass([...], Proto,
        // "count", void 0)`. Lit's `@property count` reaches the runtime only
        // through that literal, so the name must survive renaming.
        if is_legacy_decorator_helper_name(identifier.sym.as_ref()) {
            if let Some(name_argument) = call.args.get(2) {
                if let Expr::Lit(swc_core::ecma::ast::Lit::Str(literal)) = &*name_argument.expr {
                    self.names
                        .insert(literal.value.to_string_lossy().to_string());
                }
            }
            return;
        }
        if identifier.sym.as_ref() != "__esDecorate" {
            return;
        }
        let Some(context_argument) = call.args.get(3) else {
            return;
        };
        let Expr::Object(object) = &*context_argument.expr else {
            return;
        };
        for property in &object.props {
            let swc_core::ecma::ast::PropOrSpread::Prop(property) = property else {
                continue;
            };
            let swc_core::ecma::ast::Prop::KeyValue(key_value) = &**property else {
                continue;
            };
            if property_key_name(&key_value.key).as_deref() != Some("name") {
                continue;
            }
            if let Expr::Lit(swc_core::ecma::ast::Lit::Str(literal)) = &*key_value.value {
                self.names
                    .insert(literal.value.to_string_lossy().to_string());
            }
        }
    }
}

/// Recognises the legacy decorator helper each toolchain emits under its own
/// name: TypeScript `__decorate`, esbuild `__decorateClass`, oxc `_decorate`,
/// SWC `_ts_decorate`.
fn is_legacy_decorator_helper_name(name: &str) -> bool {
    let trimmed = name.trim_start_matches('_');
    let trimmed = trimmed.strip_prefix("ts_").unwrap_or(trimmed);
    trimmed.starts_with("decorate")
}

fn property_key_name(key: &swc_core::ecma::ast::PropName) -> Option<String> {
    match key {
        swc_core::ecma::ast::PropName::Ident(identifier) => {
            Some(identifier.sym.as_ref().to_string())
        }
        swc_core::ecma::ast::PropName::Str(literal) => {
            Some(literal.value.to_string_lossy().to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod matcher_tests {
    use super::*;
    use crate::module_cache::parse_module;
    use std::path::PathBuf;

    #[test]
    fn matches_the_typescript_lowering_helper_shape() {
        let module = parse_module(
            &PathBuf::from("m.js"),
            concat!(
                "var __esDecorate = (this && this.__esDecorate) || function (a, b) { return a; };\n",
                "var __runInitializers = function(a){return a};\n",
                "var other = function(a){return a};\n",
                "var labelize = function(t,l,p){return Object.defineProperty(t,\"name\",{value:p+l})};\n",
            ),
        )
        .expect("parse");
        let mut matched = Vec::new();
        for item in &module.body {
            let ModuleItem::Stmt(Stmt::Decl(Decl::Var(declaration))) = item else {
                continue;
            };
            if let Some(source) =
                helper_initializer_source(declaration, |expression| Ok(format!("{expression:?}")))
            {
                matched.push(source.expect("print"));
            }
        }
        // Both helper forms match; ordinary application declarations, including
        // the `labelize` function the old fingerprint matcher destroyed, do not.
        assert_eq!(matched.len(), 2, "{matched:?}");
    }
}
