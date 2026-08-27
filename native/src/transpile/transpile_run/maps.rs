use std::collections::HashMap;
use std::path::Path;

use super::super::imports_exports::resolved_import_key;
use super::super::napi::{ExternalBoundaryInput, ResolvedImportInput};

pub(crate) fn index_resolved_imports(
    resolved_imports: Vec<ResolvedImportInput>,
) -> HashMap<String, String> {
    resolved_imports
        .into_iter()
        .map(|resolved| {
            (
                resolved_import_key(Path::new(&resolved.importerFilePath), &resolved.specifier),
                resolved.moduleId,
            )
        })
        .collect()
}

pub(crate) fn index_external_specifiers(
    external_boundaries: Vec<ExternalBoundaryInput>,
) -> HashMap<String, String> {
    external_boundaries
        .into_iter()
        .map(|boundary| {
            (
                resolved_import_key(Path::new(&boundary.importerFilePath), &boundary.specifier),
                boundary.specifier,
            )
        })
        .collect()
}
