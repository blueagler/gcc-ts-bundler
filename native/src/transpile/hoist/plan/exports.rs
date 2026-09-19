//! Export-binding resolution for hoist-plan construction.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::super::super::context::DEFAULT_EXPORT_LOCAL;
use super::super::super::imports_exports::BundlerExportSlotMode;
use super::super::ResolvedExportBinding;
use super::scan::ModuleScan;

pub(super) struct ExportLinkers {
    pub(super) export_bindings: HashMap<String, BTreeMap<String, ResolvedExportBinding>>,
    pub(super) namespace_reexports: HashMap<String, BTreeMap<String, String>>,
}

pub(super) fn resolve_all_export_linkers(scans: &HashMap<String, ModuleScan>) -> ExportLinkers {
    let mut memo = HashMap::<(String, String), Option<ResolvedExportBinding>>::new();
    let mut export_bindings = HashMap::new();
    let mut namespace_reexports = HashMap::new();
    for module_id in scans.keys() {
        let mut export_names = BTreeSet::new();
        collect_export_names(module_id, scans, &mut export_names, &mut BTreeSet::new());
        let mut bindings = BTreeMap::new();
        let mut targets = BTreeMap::new();
        for export_name in &export_names {
            let mut visiting = BTreeSet::new();
            if let Some(binding) =
                resolve_export_binding(module_id, export_name, scans, &mut memo, &mut visiting)
            {
                bindings.insert(export_name.clone(), binding);
            }
            if let Some(target) =
                resolve_namespace_reexport(module_id, export_name, scans, &mut BTreeSet::new())
            {
                targets.insert(export_name.clone(), target);
            }
        }
        export_bindings.insert(module_id.clone(), bindings);
        namespace_reexports.insert(module_id.clone(), targets);
    }
    ExportLinkers {
        export_bindings,
        namespace_reexports,
    }
}

fn resolve_namespace_reexport(
    module_id: &str,
    export_name: &str,
    scans: &HashMap<String, ModuleScan>,
    visiting: &mut BTreeSet<(String, String)>,
) -> Option<String> {
    let key = (module_id.to_string(), export_name.to_string());
    if !visiting.insert(key.clone()) {
        return None;
    }
    let resolved = (|| {
        let scan = scans.get(module_id)?;
        if let Some(target) = scan.namespace_reexports.get(export_name) {
            return Some(target.clone());
        }
        if let Some((target, original)) = scan.reexports.get(export_name) {
            return resolve_namespace_reexport(target, original, scans, visiting);
        }
        if export_name != "default" {
            for target in &scan.stars {
                if let Some(target) =
                    resolve_namespace_reexport(target, export_name, scans, visiting)
                {
                    return Some(target);
                }
            }
        }
        None
    })();
    visiting.remove(&key);
    resolved
}

fn collect_export_names(
    module_id: &str,
    scans: &HashMap<String, ModuleScan>,
    names: &mut BTreeSet<String>,
    visiting: &mut BTreeSet<String>,
) {
    if !visiting.insert(module_id.to_string()) {
        return;
    }
    let Some(scan) = scans.get(module_id) else {
        return;
    };
    names.extend(scan.own_exports.keys().cloned());
    names.extend(scan.reexports.keys().cloned());
    names.extend(scan.namespace_reexports.keys().cloned());
    for star_target in &scan.stars {
        let mut star_names = BTreeSet::new();
        collect_export_names(star_target, scans, &mut star_names, visiting);
        names.extend(star_names.into_iter().filter(|name| name != "default"));
    }
}

fn resolve_export_binding(
    module_id: &str,
    export_name: &str,
    scans: &HashMap<String, ModuleScan>,
    memo: &mut HashMap<(String, String), Option<ResolvedExportBinding>>,
    visiting: &mut BTreeSet<String>,
) -> Option<ResolvedExportBinding> {
    let key = (module_id.to_string(), export_name.to_string());
    if let Some(memoized) = memo.get(&key) {
        return memoized.clone();
    }
    if !visiting.insert(module_id.to_string()) {
        return None;
    }
    let resolved = (|| {
        let scan = scans.get(module_id)?;
        if let Some(local) = scan.own_exports.get(export_name) {
            return Some(ResolvedExportBinding {
                module_id: module_id.to_string(),
                export_name: export_name.to_string(),
                local_name: local.clone(),
                slot_mode: scan
                    .local_export_modes
                    .get(local)
                    .copied()
                    .unwrap_or_else(|| {
                        if local == DEFAULT_EXPORT_LOCAL {
                            BundlerExportSlotMode::Static
                        } else {
                            BundlerExportSlotMode::Live
                        }
                    }),
            });
        }
        if let Some((target, orig)) = scan.reexports.get(export_name) {
            return resolve_export_binding(target, orig, scans, memo, visiting);
        }
        if export_name != "default" {
            for star_target in &scan.stars {
                if let Some(binding) =
                    resolve_export_binding(star_target, export_name, scans, memo, visiting)
                {
                    return Some(binding);
                }
            }
        }
        None
    })();
    visiting.remove(module_id);
    memo.insert(key, resolved.clone());
    resolved
}
