use std::collections::HashSet;

use crate::closure_metadata::ClosureFileMetadata;

use super::super::transpile_plan::collect_decorated_metadata_property_names;

pub(crate) fn extend_preserved_property_names(
    preserved_property_names: &mut HashSet<String>,
    file_metadata: &std::collections::HashMap<String, ClosureFileMetadata>,
    preserves_node_import_meta: bool,
    type_inference_disabled: bool,
    prelude_property_names: impl IntoIterator<Item = String>,
) -> std::result::Result<(), String> {
    // Decorator metadata carries property keys as string literals; preserving
    // those keys keeps the literals valid instead of rewriting Closure output.
    preserved_property_names.extend(collect_decorated_metadata_property_names(file_metadata)?);
    // Prelowered decorator keys and pair-array classMap keys come from the
    // fused analysis prelude, which parsed each file once.
    preserved_property_names.extend(prelude_property_names);
    if preserves_node_import_meta {
        // `import.meta` is a host-provided Node ESM object. Quote its standard
        // `url` member before Closure so the envelope contract survives ADVANCED.
        preserved_property_names.insert("url".to_string());
    }
    if type_inference_disabled {
        // The escape hatch omits @enum metadata, so keep emitted TS enum keys stable.
        preserved_property_names.extend(
            file_metadata
                .values()
                .flat_map(|metadata| metadata.enums.iter())
                .flat_map(|enum_decl| enum_decl.members.iter())
                .map(|member| member.name.clone()),
        );
    }
    Ok(())
}
