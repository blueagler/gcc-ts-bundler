//! Facade-slot construction for hoist-plan construction.

use std::collections::{BTreeSet, HashMap};

use super::super::super::LazyImportInput;
use super::super::{FacadeSlots, HoistPlan, ResolvedExportBinding};
use super::scan::ModuleScan;

struct FacadeNeeds<'a> {
    plan: &'a HoistPlan,
    slots: HashMap<String, FacadeSlots>,
    worklist: Vec<(String, Option<String>)>,
}

impl FacadeNeeds<'_> {
    fn need(&mut self, module_id: &str, export_name: &str) {
        if !self.plan.is_hoisted(module_id) {
            return;
        }
        match self
            .slots
            .entry(module_id.to_string())
            .or_insert_with(|| FacadeSlots::Named(BTreeSet::new()))
        {
            FacadeSlots::All => {}
            FacadeSlots::Named(names) => {
                if names.insert(export_name.to_string()) {
                    self.worklist
                        .push((module_id.to_string(), Some(export_name.to_string())));
                }
            }
        }
    }

    fn need_all(&mut self, module_id: &str) {
        if !self.plan.is_hoisted(module_id) {
            return;
        }
        let previous = self.slots.insert(module_id.to_string(), FacadeSlots::All);
        if !matches!(previous, Some(FacadeSlots::All)) {
            self.worklist.push((module_id.to_string(), None));
        }
    }

    fn ensure_registered(&mut self, module_id: &str) {
        if !self.plan.is_hoisted(module_id) {
            return;
        }
        self.slots
            .entry(module_id.to_string())
            .or_insert_with(|| FacadeSlots::Named(BTreeSet::new()));
    }
}

pub(super) fn compute_facade_slots(
    plan: &HoistPlan,
    scans: &HashMap<String, ModuleScan>,
    lazy_imports: &[LazyImportInput],
) -> HashMap<String, FacadeSlots> {
    let mut needs = FacadeNeeds {
        plan,
        slots: HashMap::new(),
        worklist: Vec::new(),
    };

    // Dynamic imports expose namespace values across user and framework
    // boundaries, so keep the complete slot table and the named facade.
    for lazy_import in lazy_imports {
        needs.need_all(&lazy_import.module_id);
    }

    for (module_id, scan) in scans {
        if plan.chunk_of(module_id).is_none() {
            continue;
        }
        let consumer_hoisted = plan.is_hoisted(module_id);
        for edge in &scan.import_edges {
            if edge.namespace {
                if let (Some(members), true) = (&edge.namespace_members, consumer_hoisted) {
                    let direct_namespace = plan.is_hoisted(&edge.target_module_id)
                        && plan.chunk_of(&edge.target_module_id).is_some();
                    if direct_namespace {
                        // Members rewrite to direct bindings, except when
                        // they resolve to a non-hoisted owner, where the
                        // emitter falls back to `__require(owner)[slot]`.
                        for member in members {
                            match plan.resolve_export(&edge.target_module_id, member) {
                                Some(binding) if plan.is_direct_binding(module_id, binding) => {}
                                Some(binding) => {
                                    needs.need(&binding.module_id, &binding.export_name);
                                }
                                None => needs.need(&edge.target_module_id, member),
                            }
                        }
                    } else {
                        for member in members {
                            needs.need(&edge.target_module_id, member);
                        }
                    }
                } else {
                    needs.need_all(&edge.target_module_id);
                }
            }
            if !consumer_hoisted {
                // Registry emission requires the immediate target for every
                // import form, including bare side-effect imports.
                needs.ensure_registered(&edge.target_module_id);
                for imported_name in &edge.named {
                    needs.need(&edge.target_module_id, imported_name);
                }
                continue;
            }
            for imported_name in &edge.used_named {
                match plan.resolve_export(&edge.target_module_id, imported_name) {
                    Some(binding) if plan.is_direct_binding(module_id, binding) => {}
                    Some(binding) => {
                        needs.need(&binding.module_id, &binding.export_name);
                    }
                    None => needs.need(&edge.target_module_id, imported_name),
                }
            }
        }
        if !consumer_hoisted {
            for (target, orig) in scan.reexports.values() {
                needs.need(target, orig);
            }
            for target in scan.namespace_reexports.values() {
                needs.need_all(target);
            }
            for star_target in &scan.stars {
                needs.need_all(star_target);
            }
        }
    }

    // Pin live-assigning exported declarations that are consumed from a
    // different chunk inside their owner chunk. Registering the slot emits
    // an in-chunk reference, so cross-chunk code motion can never relocate
    // a function whose body mutates hoisted module state into its sole
    // consumer chunk, where the assignment would become an illegal
    // ES-module import write. Same-chunk-only or unused assigners are left
    // alone: they either stay put or disappear entirely.
    for (consumer_id, scan) in scans {
        let consumer_chunk = plan.chunk_of(consumer_id);
        if consumer_chunk.is_none() {
            continue;
        }
        for edge in &scan.import_edges {
            let mut names: Vec<&String> = edge.named.iter().collect();
            if let Some(members) = edge.namespace_members.as_ref().filter(|_| edge.namespace) {
                names.extend(members.iter());
            }
            for name in names {
                let Some(binding) = plan.resolve_export(&edge.target_module_id, name) else {
                    continue;
                };
                if plan.chunk_of(&binding.module_id) == consumer_chunk {
                    continue;
                }
                let assigns_live = scans
                    .get(&binding.module_id)
                    .is_some_and(|owner| owner.live_assigners.contains(&binding.local_name));
                if assigns_live {
                    needs.need(&binding.module_id, &binding.export_name);
                }
            }
        }
    }

    // Facade getters of re-exported names reach into their owners at runtime.
    while let Some((module_id, export_name)) = needs.worklist.pop() {
        if let Some(name) = &export_name {
            if let Some(target) = plan.resolve_namespace_reexport(&module_id, name) {
                needs.need_all(target);
            }
        } else if let Some(targets) = plan.namespace_reexports.get(&module_id) {
            for target in targets.values() {
                needs.need_all(target);
            }
        }
        let Some(bindings) = plan.export_bindings.get(&module_id) else {
            continue;
        };
        let names: Vec<(String, ResolvedExportBinding)> = match export_name {
            Some(name) => bindings
                .get(&name)
                .map(|binding| vec![(name, binding.clone())])
                .unwrap_or_default(),
            None => bindings
                .iter()
                .map(|(name, binding)| (name.clone(), binding.clone()))
                .collect(),
        };
        for (_, binding) in names {
            if binding.module_id == module_id {
                continue;
            }
            if plan.is_direct_binding(&module_id, &binding) {
                continue;
            }
            needs.need(&binding.module_id, &binding.export_name);
        }
    }

    needs.slots
}
