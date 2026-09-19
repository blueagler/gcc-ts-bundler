use std::path::Path;

use oxc_allocator::{Allocator, FromIn};
use oxc_ast::ast::{
    BindingIdentifier, Expression, ImportDeclaration, ImportDeclarationSpecifier,
    ImportOrExportKind, ObjectProperty, Program,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::SPAN;
use oxc_str::Ident;
use oxc_syntax::number::NumberBase;

use super::super::fresh::FreshNameAllocator;
use super::super::identity::{BindingKey, BindingKeyMap, ModuleIdentity};
use super::super::imports_exports::ImportBindingSlotAlias;
use super::super::{
    resolve_module_id_for_specifier, to_bundler_runtime_module_id, BundlerModuleSlots,
    TranspileContext,
};
use super::exports::module_export_name;

#[derive(Debug)]
pub(crate) struct ImportBindingRewrite {
    pub(crate) binding_id: BindingKey,
    pub(crate) local_name: String,
    pub(crate) slot_alias: ImportBindingSlotAlias,
}

pub(crate) struct BundlerImportPlan {
    pub(crate) lines: Vec<String>,
    pub(crate) binding_rewrites: Vec<ImportBindingRewrite>,
}

pub(crate) fn convert_bundler_import_decl(
    file_path: &Path,
    import: &ImportDeclaration<'_>,
    context: &TranspileContext,
    import_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    require_name: &str,
) -> std::result::Result<BundlerImportPlan, String> {
    let module_id =
        resolve_module_id_for_specifier(file_path, import.source.value.as_str(), context)?;
    let runtime_module_id = to_bundler_runtime_module_id(&module_id);
    let Some(specifiers) = &import.specifiers else {
        return Ok(BundlerImportPlan {
            lines: vec![format!("{require_name}({runtime_module_id:?});")],
            binding_rewrites: Vec::new(),
        });
    };
    if specifiers.is_empty() {
        return Ok(BundlerImportPlan {
            lines: vec![format!("{require_name}({runtime_module_id:?});")],
            binding_rewrites: Vec::new(),
        });
    }
    let value_specifiers = specifiers
        .iter()
        .filter(|specifier| {
            import.import_kind != ImportOrExportKind::Type
                && !matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(named)
                    if named.import_kind == ImportOrExportKind::Type)
        })
        .collect::<Vec<_>>();
    if value_specifiers.is_empty() {
        return Ok(BundlerImportPlan {
            lines: Vec::new(),
            binding_rewrites: Vec::new(),
        });
    }

    let local_name = fresh_names.fresh(&format!("__gcc_import_{}", *import_counter));
    *import_counter += 1;
    let mut lines = vec![format!(
        "const {local_name} = {require_name}({runtime_module_id:?});"
    )];
    let target_slots = context
        .bundler_module_slots
        .get(&module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
    let mut binding_rewrites = Vec::new();
    for specifier in value_specifiers {
        match specifier {
            ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                binding_rewrites.push(import_rewrite(
                    &local_name,
                    "default",
                    &default.local,
                    target_slots,
                )?);
            }
            ImportDeclarationSpecifier::ImportSpecifier(named) => {
                binding_rewrites.push(import_rewrite(
                    &local_name,
                    &module_export_name(&named.imported),
                    &named.local,
                    target_slots,
                )?);
            }
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                lines.push(format!(
                    "const {} = {require_name}({runtime_module_id:?},true);",
                    namespace.local.name
                ));
            }
        }
    }
    Ok(BundlerImportPlan {
        lines,
        binding_rewrites,
    })
}

fn import_rewrite(
    source_object_name: &str,
    imported_name: &str,
    local: &BindingIdentifier<'_>,
    target_slots: &BundlerModuleSlots,
) -> std::result::Result<ImportBindingRewrite, String> {
    let slot = target_slots.slot_for(imported_name).ok_or_else(|| {
        format!("Missing bundler-runtime export slot for imported name {imported_name}")
    })?;
    Ok(ImportBindingRewrite {
        binding_id: ModuleIdentity::key_of_binding(local)?,
        local_name: local.name.to_string(),
        slot_alias: ImportBindingSlotAlias {
            source_object_name: source_object_name.to_string(),
            source_slot: slot,
        },
    })
}

pub(crate) fn apply_import_binding_rewrites<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    rewrites: &[ImportBindingRewrite],
) {
    if rewrites.is_empty() {
        return;
    }
    ImportBindingRewriteVisitor {
        allocator,
        builder: AstBuilder::new(allocator),
        identity,
        rewrites: rewrites
            .iter()
            .map(|rewrite| (rewrite.binding_id, &rewrite.slot_alias))
            .collect(),
    }
    .visit_program(program);
}

struct ImportBindingRewriteVisitor<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    identity: &'i ModuleIdentity,
    rewrites: BindingKeyMap<&'i ImportBindingSlotAlias>,
}

impl<'a> ImportBindingRewriteVisitor<'a, '_> {
    fn replacement(&self, alias: &ImportBindingSlotAlias) -> Expression<'a> {
        let object = Expression::new_identifier(
            SPAN,
            Ident::from_in(&alias.source_object_name, self.allocator),
            &self.builder,
        );
        let slot = Expression::new_numeric_literal(
            SPAN,
            alias.source_slot as f64,
            None,
            NumberBase::Decimal,
            &self.builder,
        );
        Expression::new_computed_member_expression(SPAN, object, slot, false, &self.builder)
    }
}

impl<'a> VisitMut<'a> for ImportBindingRewriteVisitor<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::Identifier(identifier) = expression {
            if let Some(binding) = self.identity.key_of_reference(identifier) {
                if let Some(alias) = self.rewrites.get(&binding) {
                    *expression = self.replacement(alias);
                    return;
                }
            }
        }
        walk_mut::walk_expression(self, expression);
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        if property.shorthand {
            if let Expression::Identifier(identifier) = &property.value {
                if let Some(binding) = self.identity.key_of_reference(identifier) {
                    if let Some(alias) = self.rewrites.get(&binding) {
                        property.shorthand = false;
                        property.value = self.replacement(alias);
                        return;
                    }
                }
            }
        }
        walk_mut::walk_object_property(self, property);
    }
}
