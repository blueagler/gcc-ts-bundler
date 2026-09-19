use std::collections::HashSet;

use crate::closure_metadata::ClosureFileMetadata;

pub(crate) fn extend_preserved_property_names(
    preserved_property_names: &mut HashSet<String>,
    file_metadata: &std::collections::HashMap<String, ClosureFileMetadata>,
    preserves_node_import_meta: bool,
    type_inference_disabled: bool,
    prelude_property_names: impl IntoIterator<Item = String>,
) {
    // Authored and lowered decorator keys (including metadata-only inputs),
    // plus pair-array classMap keys, come from the analysis prelude.
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
}
