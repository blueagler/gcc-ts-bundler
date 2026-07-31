//! Shared naming for pooled TypeScript/tslib lowering helpers.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

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

pub(super) fn canonical_shared_helper_name(base_name: &str, body_source: &str) -> String {
    let mut hasher = DefaultHasher::new();
    base_name.hash(&mut hasher);
    body_source.hash(&mut hasher);
    format!("{base_name}$$h{:016x}", hasher.finish())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SharedHelperDeclaration {
    pub(super) canonical_name: String,
    pub(super) text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_names_are_closed_sorted_and_content_addressed() {
        let mut sorted = SHARED_HELPER_BASE_NAMES.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, SHARED_HELPER_BASE_NAMES);
        assert!(is_shared_helper_base_name("__esDecorate"));
        assert!(!is_shared_helper_base_name("labelize"));
        assert_eq!(
            canonical_shared_helper_name("__runInitializers", "function(a){return a}"),
            canonical_shared_helper_name("__runInitializers", "function(a){return a}")
        );
        assert_ne!(
            canonical_shared_helper_name("__runInitializers", "function(a){return a}"),
            canonical_shared_helper_name("__runInitializers", "function(a){return a+1}")
        );
    }
}
