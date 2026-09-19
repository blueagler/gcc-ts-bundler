use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_ast::ast::{
    BindingIdentifier, ImportDeclaration, ImportDeclarationSpecifier, ImportOrExportKind,
};

use super::super::super::fresh::FreshNameAllocator;
use super::super::super::hoist::HoistPlan;
use super::super::super::identity::{BindingKey, BindingKeySet, ModuleIdentity};
use super::super::super::imports_exports::ImportBindingSlotAlias;
use super::super::super::{
    resolve_module_id_for_specifier, to_bundler_runtime_module_id, TranspileContext,
};
use super::super::import_plan::{ImportBindingRewrite, ImportReplacement};
use super::types::{module_export_name, HoistedImportPlan};

pub(crate) struct HoistedImportPlanner<'a> {
    consumer_module_id: &'a str,
    pub(crate) consumer_ordinal: usize,
    context: &'a TranspileContext,
    pub(crate) fresh_names: FreshNameAllocator,
    lexical_binding_names: &'a HashSet<String>,
    plan: &'a HoistPlan,
    pub(crate) preserved_import_count: usize,
    require_bindings: HashMap<String, String>,
}

impl<'a> HoistedImportPlanner<'a> {
    pub(crate) fn new(
        context: &'a TranspileContext,
        plan: &'a HoistPlan,
        consumer_module_id: &'a str,
        consumer_ordinal: usize,
        lexical_binding_names: &'a HashSet<String>,
        fresh_names: FreshNameAllocator,
    ) -> Self {
        Self {
            consumer_module_id,
            consumer_ordinal,
            context,
            fresh_names,
            lexical_binding_names,
            plan,
            preserved_import_count: 0,
            require_bindings: HashMap::new(),
        }
    }

    pub(crate) fn into_fresh_names(self) -> FreshNameAllocator {
        self.fresh_names
    }

    fn require_binding(&mut self, target_module_id: &str, lines: &mut Vec<String>) -> String {
        if let Some(existing) = self.require_bindings.get(target_module_id) {
            return existing.clone();
        }
        let preferred = format!(
            "__gcc_req_{}_{}",
            self.consumer_ordinal,
            self.require_bindings.len()
        );
        let name = self.fresh_names.fresh(&preferred);
        let runtime_module_id = to_bundler_runtime_module_id(target_module_id);
        lines.push(format!("const {name} = __require({runtime_module_id:?});"));
        self.require_bindings
            .insert(target_module_id.to_string(), name.clone());
        name
    }

    pub(crate) fn plan_import(
        &mut self,
        file_path: &Path,
        import: &ImportDeclaration<'_>,
        direct_namespace_ids: &BindingKeySet,
        used_binding_ids: &BindingKeySet,
    ) -> std::result::Result<HoistedImportPlan, String> {
        let target_module_id =
            resolve_module_id_for_specifier(file_path, import.source.value.as_str(), self.context)?;
        if let Some(preserved) = self.context.preserved_modules.get(&target_module_id) {
            return self.plan_preserved_import(import, preserved);
        }
        let mut lines = Vec::new();
        let mut rewrites = Vec::new();

        if import.import_kind != ImportOrExportKind::Type
            && !self.plan.is_hoisted(&target_module_id)
        {
            let runtime_module_id = to_bundler_runtime_module_id(&target_module_id);
            lines.push(format!("__require({runtime_module_id:?});"));
        }
        let Some(specifiers) = &import.specifiers else {
            return Ok(HoistedImportPlan {
                extern_lines: Vec::new(),
                lines,
                preserved_imports: Vec::new(),
                rewrites,
            });
        };
        for specifier in specifiers {
            match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named)
                    if import.import_kind == ImportOrExportKind::Type
                        || named.import_kind == ImportOrExportKind::Type => {}
                ImportDeclarationSpecifier::ImportSpecifier(named)
                    if !used_binding_ids
                        .contains(&ModuleIdentity::key_of_binding(&named.local)?) => {}
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default)
                    if import.import_kind == ImportOrExportKind::Type
                        || !used_binding_ids
                            .contains(&ModuleIdentity::key_of_binding(&default.local)?) => {}
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace)
                    if import.import_kind == ImportOrExportKind::Type
                        || !used_binding_ids
                            .contains(&ModuleIdentity::key_of_binding(&namespace.local)?) => {}
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    let imported_name = module_export_name(&named.imported);
                    self.plan_named_binding(
                        &target_module_id,
                        &imported_name,
                        &named.local,
                        &mut lines,
                        &mut rewrites,
                    )?;
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    self.plan_named_binding(
                        &target_module_id,
                        "default",
                        &default.local,
                        &mut lines,
                        &mut rewrites,
                    )?;
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    if direct_namespace_ids
                        .contains(&ModuleIdentity::key_of_binding(&namespace.local)?)
                    {
                        continue;
                    }
                    let object_name = self.fresh_names.fresh(&format!(
                        "__gcc_ns_{}_{}",
                        self.consumer_ordinal, namespace.local.name
                    ));
                    let runtime_module_id = to_bundler_runtime_module_id(&target_module_id);
                    lines.push(format!(
                        "const {object_name} = __require({runtime_module_id:?},true);"
                    ));
                    rewrites.push(ImportBindingRewrite {
                        binding_id: ModuleIdentity::key_of_binding(&namespace.local)?,
                        replacement: ImportReplacement::Name(object_name),
                    });
                }
            }
        }
        Ok(HoistedImportPlan {
            extern_lines: Vec::new(),
            lines,
            preserved_imports: Vec::new(),
            rewrites,
        })
    }

    fn plan_named_binding(
        &mut self,
        target_module_id: &str,
        imported_name: &str,
        local: &BindingIdentifier<'_>,
        lines: &mut Vec<String>,
        rewrites: &mut Vec<ImportBindingRewrite>,
    ) -> std::result::Result<(), String> {
        let binding_id = ModuleIdentity::key_of_binding(local)?;
        if let Some(binding) = self.plan.resolve_export(target_module_id, imported_name) {
            let direct_name = self.plan.direct_binding_name(binding);
            if self
                .plan
                .is_direct_binding(self.consumer_module_id, binding)
                && direct_name
                    .as_ref()
                    .is_some_and(|name| !self.lexical_binding_names.contains(name))
            {
                let direct_name = direct_name
                    .ok_or_else(|| format!("Missing hoist ordinal for {}", binding.module_id))?;
                rewrites.push(ImportBindingRewrite {
                    binding_id,
                    replacement: ImportReplacement::Name(direct_name),
                });
                return Ok(());
            }
            let binding = binding.clone();
            let owner_slots = self
                .context
                .bundler_module_slots
                .get(&binding.module_id)
                .ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slots for {}",
                        binding.module_id
                    )
                })?;
            let owner_slot = owner_slots.slot_for(&binding.export_name).ok_or_else(|| {
                format!(
                    "Missing bundler-runtime export slot for {} in {}",
                    binding.export_name, binding.module_id
                )
            })?;
            let object_name = self.require_binding(&binding.module_id, lines);
            rewrites.push(slot_rewrite(binding_id, &object_name, owner_slot));
            return Ok(());
        }

        let target_slots = self
            .context
            .bundler_module_slots
            .get(target_module_id)
            .ok_or_else(|| {
                format!("Missing bundler-runtime export slots for {target_module_id}")
            })?;
        let slot = target_slots.slot_for(imported_name).ok_or_else(|| {
            format!("Missing bundler-runtime export slot for imported name {imported_name}")
        })?;
        let object_name = self.require_binding(target_module_id, lines);
        rewrites.push(slot_rewrite(binding_id, &object_name, slot));
        Ok(())
    }
}

fn slot_rewrite(binding_id: BindingKey, object_name: &str, slot: usize) -> ImportBindingRewrite {
    let alias = ImportBindingSlotAlias {
        source_object_name: object_name.to_string(),
        source_slot: slot,
    };
    ImportBindingRewrite {
        binding_id,
        replacement: ImportReplacement::Slot(alias),
    }
}
