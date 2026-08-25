//! Per-chunk scope hoisting for bundler-runtime mode.
//!
//! Modules that live in the same chunk reference each other's top-level
//! bindings directly (renamed with a per-module ordinal suffix) so Closure can
//! inline and rename across the whole chunk. Only cross-chunk edges and
//! dynamic-import targets go through the `__register`/`__require` registry via
//! small export facades.

use super::*;

mod plan;
mod usage;

pub(crate) use plan::build_hoist_plan;
pub(crate) use usage::{collect_used_binding_ids, scan_namespace_usage, NamespaceUsage};

#[derive(Clone, Debug)]
pub(super) struct ResolvedExportBinding {
    pub(super) owner_module_id: String,
    pub(super) owner_export_name: String,
    pub(super) owner_local_name: String,
    pub(super) owner_slot_mode: BundlerExportSlotMode,
}

/// Which export slots a hoisted module's registry factory must expose.
/// `All` keeps the full slot table alive; `Named` prunes registration to the
/// slots required by cross-chunk consumers.
#[derive(Clone, Debug)]
pub(super) enum FacadeSlots {
    All,
    Named(BTreeSet<String>),
}

#[derive(Clone, Debug, Default)]
pub(crate) struct HoistPlan {
    pub(in crate::transpile::hoist) chunk_dependency_closure: Vec<HashSet<usize>>,
    pub(super) export_bindings: HashMap<String, BTreeMap<String, ResolvedExportBinding>>,
    pub(in crate::transpile::hoist) namespace_reexports: HashMap<String, BTreeMap<String, String>>,
    pub(in crate::transpile::hoist) namespace_object_modules: HashSet<String>,
    pub(in crate::transpile::hoist) reified_namespace_modules: HashSet<String>,
    pub(super) facade_slots: HashMap<String, FacadeSlots>,
    pub(super) hoisted_modules: HashSet<String>,
    pub(super) module_chunks: HashMap<String, usize>,
    pub(in crate::transpile::hoist) module_positions: HashMap<String, usize>,
    pub(super) module_ordinals: HashMap<String, usize>,
}

impl HoistPlan {
    pub(super) fn is_hoisted(&self, module_id: &str) -> bool {
        self.hoisted_modules.contains(module_id)
    }

    pub(super) fn chunk_of(&self, module_id: &str) -> Option<usize> {
        self.module_chunks.get(module_id).copied()
    }

    pub(super) fn ordinal_of(&self, module_id: &str) -> Option<usize> {
        self.module_ordinals.get(module_id).copied()
    }

    pub(super) fn resolve_export(
        &self,
        module_id: &str,
        export_name: &str,
    ) -> Option<&ResolvedExportBinding> {
        self.export_bindings.get(module_id)?.get(export_name)
    }

    pub(super) fn resolve_namespace_reexport(
        &self,
        module_id: &str,
        export_name: &str,
    ) -> Option<&str> {
        self.namespace_reexports
            .get(module_id)?
            .get(export_name)
            .map(String::as_str)
    }

    pub(super) fn is_namespace_object_module(&self, module_id: &str) -> bool {
        self.namespace_object_modules.contains(module_id)
    }

    pub(super) fn is_reified_namespace_module(&self, module_id: &str) -> bool {
        self.reified_namespace_modules.contains(module_id)
    }

    /// A resolved binding can be referenced directly only when the loader has
    /// already executed the chunk that owns it: the same chunk, or one this
    /// chunk transitively depends on (dependency chunks are fetched and run
    /// first). Sibling chunks are *not* ordered against each other, so a
    /// binding owned by one lazy chunk and read from another has to go back
    /// through the `__require` registry.
    ///
    /// The plan is built so this never happens; the `debug_assert` says so out
    /// loud in tests, and the release path still falls back to the registry
    /// rather than emitting a reference to a binding that may not exist yet.
    pub(super) fn is_direct_binding(
        &self,
        consumer_module_id: &str,
        binding: &ResolvedExportBinding,
    ) -> bool {
        if !self.is_hoisted(&binding.owner_module_id) {
            return false;
        }
        let Some(owner_chunk) = self.chunk_of(&binding.owner_module_id) else {
            return false;
        };
        let Some(consumer_chunk) = self.chunk_of(consumer_module_id) else {
            // The consumer is not in the chunk graph at all, so there is no
            // ordering to check and nothing new to forbid.
            return true;
        };
        if self.chunk_dependency_closure.is_empty() {
            return true;
        }
        let ordered = owner_chunk == consumer_chunk
            || self
                .chunk_dependency_closure
                .get(consumer_chunk)
                .is_some_and(|dependencies| dependencies.contains(&owner_chunk));
        debug_assert!(
            ordered,
            "direct binding {} (chunk {owner_chunk}) read from {consumer_module_id} (chunk {consumer_chunk}), which does not depend on it",
            binding.owner_module_id,
        );
        ordered
    }

    pub(super) fn direct_binding_name(&self, binding: &ResolvedExportBinding) -> Option<String> {
        let ordinal = self.ordinal_of(&binding.owner_module_id)?;
        Some(suffixed_name(&binding.owner_local_name, ordinal))
    }

    pub(super) fn direct_binding_slot_mode(
        &self,
        consumer_module_id: &str,
        binding: &ResolvedExportBinding,
    ) -> BundlerExportSlotMode {
        let owner_precedes_consumer = self
            .module_positions
            .get(&binding.owner_module_id)
            .zip(self.module_positions.get(consumer_module_id))
            .is_some_and(|(owner, consumer)| owner < consumer);
        if binding.owner_slot_mode == BundlerExportSlotMode::Static
            && self.chunk_of(consumer_module_id) == self.chunk_of(&binding.owner_module_id)
            && owner_precedes_consumer
        {
            BundlerExportSlotMode::Static
        } else {
            BundlerExportSlotMode::Live
        }
    }

    pub(super) fn facade_slots_for(&self, module_id: &str) -> Option<&FacadeSlots> {
        self.facade_slots.get(module_id)
    }
}

pub(super) fn suffixed_name(local_name: &str, ordinal: usize) -> String {
    format!("{local_name}$${ordinal}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn namespace_import_named_export_is_hoistable() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!("gcc-hoist-namespace-{unique}"));
        let src = workspace.join("src");
        fs::create_dir_all(&src).unwrap();
        let util = src.join("util.js");
        let api = src.join("api.js");
        fs::write(
            &util,
            "export const answer = 42;
",
        )
        .unwrap();
        fs::write(
            &api,
            "import * as util from './util.js'; export { util };
",
        )
        .unwrap();

        let files = vec![
            util.to_string_lossy().into_owned(),
            api.to_string_lossy().into_owned(),
        ];
        let chunks = vec![TranspileChunkInput {
            dependencies: Vec::new(),
            files: vec!["src/util.js".to_string(), "src/api.js".to_string()],
            name: "main".to_string(),
        }];
        let plan = build_hoist_plan(
            &files,
            &workspace,
            &[],
            &HashMap::new(),
            &chunks,
            &[],
            &HashMap::new(),
        )
        .unwrap()
        .unwrap();
        let api_id = to_goog_module_id(&api, &workspace);
        assert!(plan.is_hoisted(&api_id));
        fs::remove_dir_all(workspace).unwrap();
    }

    fn namespace_plan(consumer_source: &str) -> (HoistPlan, String) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!("gcc-hoist-reify-{unique}"));
        let src = workspace.join("src");
        fs::create_dir_all(&src).unwrap();
        let target = src.join("graphic.js");
        let consumer = src.join("main.js");
        fs::write(&target, "export class Circle {}\nexport class Arc {}\n").unwrap();
        fs::write(&consumer, consumer_source).unwrap();
        let files = vec![
            target.to_string_lossy().into_owned(),
            consumer.to_string_lossy().into_owned(),
        ];
        let chunks = vec![TranspileChunkInput {
            dependencies: Vec::new(),
            files: vec!["src/graphic.js".to_string(), "src/main.js".to_string()],
            name: "main".to_string(),
        }];
        let plan = build_hoist_plan(
            &files,
            &workspace,
            &[],
            &HashMap::new(),
            &chunks,
            &[],
            &HashMap::new(),
        )
        .unwrap()
        .unwrap();
        let target_id = to_goog_module_id(&target, &workspace);
        fs::remove_dir_all(workspace).unwrap();
        (plan, target_id)
    }

    #[test]
    fn dynamic_namespace_access_reifies_the_target() {
        let (plan, target) = namespace_plan(
            "import * as graphic from './graphic.js';\nconst option = { type: key };\nnew graphic[option.type]();\n",
        );
        assert!(plan.is_reified_namespace_module(&target));
    }

    #[test]
    fn finite_namespace_access_does_not_reify_the_target() {
        let (plan, target) = namespace_plan(
            "import * as graphic from './graphic.js';\nconst type = flag ? 'Circle' : 'Arc';\nnew graphic[type]();\n",
        );
        assert!(!plan.is_namespace_object_module(&target));
    }

    #[test]
    fn namespace_call_argument_reifies_the_target() {
        let (plan, target) =
            namespace_plan("import * as graphic from './graphic.js';\nconsume(graphic);\n");
        assert!(plan.is_reified_namespace_module(&target));
    }
}
