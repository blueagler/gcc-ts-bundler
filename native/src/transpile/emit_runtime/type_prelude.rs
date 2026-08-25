use super::super::emit::render_closure_enum;
use super::super::type_metadata_oxc::PreparedTypeMetadata;
use super::super::{render_static_export_slot_with, BundlerModuleSlots};
use super::exports::RuntimeBindingNames;

pub(crate) fn emit_runtime_type_prelude(
    type_metadata: &mut PreparedTypeMetadata,
    current_slots: &BundlerModuleSlots,
    runtime_names: &RuntimeBindingNames,
    module_id: &str,
    output: &mut Vec<String>,
) -> std::result::Result<(), String> {
    output.extend(type_metadata.take_declaration_lines());
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for declaration in enum_declarations {
        let emitted_name = type_metadata.enum_name(&declaration);
        output.push(render_closure_enum(&declaration, &emitted_name));
        type_metadata.count_enum();
        if declaration.exported {
            let slot = current_slots
                .slot_for(&declaration.binding_name)
                .ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for {} in {}",
                        declaration.binding_name, module_id
                    )
                })?;
            output.push(render_static_export_slot_with(
                &runtime_names.exports,
                slot,
                &emitted_name,
            ));
        }
    }
    Ok(())
}
