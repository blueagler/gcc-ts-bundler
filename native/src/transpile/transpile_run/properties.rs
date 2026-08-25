use std::collections::HashSet;

use crate::closure_metadata::ClosureFileMetadata;

use super::super::napi::ClassMapCallInput;
use super::super::transpile_plan::{
    collect_decorated_metadata_property_names, collect_pair_array_property_names,
    collect_prelowered_decorator_property_names,
};

pub(crate) fn extend_preserved_property_names(
    preserved_property_names: &mut HashSet<String>,
    compiled_file_names: &[String],
    class_map_calls: &[ClassMapCallInput],
    file_metadata: &std::collections::HashMap<String, ClosureFileMetadata>,
    preserves_node_import_meta: bool,
    type_inference_disabled: bool,
) -> std::result::Result<(), String> {
    // Decorator metadata carries property keys as string literals; preserving
    // those keys keeps the literals valid instead of rewriting Closure output.
    preserved_property_names.extend(collect_decorated_metadata_property_names(file_metadata)?);
    // Inputs can also arrive already lowered by another tool (Vite lowers
    // `experimentalDecorators` before this stage sees the module), in which
    // case there is no decorator metadata and the literals live in the source
    // itself: `__decorateClass([property(...)], MyElement.prototype, "count")`.
    preserved_property_names.extend(collect_prelowered_decorator_property_names(
        compiled_file_names,
    )?);
    // `classMapCalls` rules with `keySource: "pairArray"` pin keys that a
    // helper splats onto a target by string while the runtime reads them as
    // dot properties.
    preserved_property_names.extend(collect_pair_array_property_names(
        compiled_file_names,
        class_map_calls,
    )?);
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
