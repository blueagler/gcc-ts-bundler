use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::closure_metadata::{closure_metadata_key, TypeMetadataCounts};

use super::super::PrepareClosureJobsInput;

pub(super) fn property_renaming_report_path(
    raw_dir: &Path,
    compilation_level: &str,
) -> Option<String> {
    (compilation_level == "ADVANCED").then(|| {
        raw_dir
            .join("property-renaming-report.txt")
            .to_string_lossy()
            .to_string()
    })
}

pub(super) fn aggregate_type_metadata(
    input: &PrepareClosureJobsInput,
    actual_js_inputs: impl IntoIterator<Item = String>,
) -> std::result::Result<(TypeMetadataCounts, bool), String> {
    let actual_inputs = actual_js_inputs
        .into_iter()
        .map(|path| closure_metadata_key(Path::new(&path)))
        .collect::<HashSet<_>>();
    let mut metadata_by_file = HashMap::new();
    for metadata in &input.typeMetadata {
        let key = closure_metadata_key(Path::new(&metadata.emittedFile));
        if metadata_by_file.insert(key.clone(), metadata).is_some() {
            return Err(format!("Duplicate emitted type metadata for {key}"));
        }
    }

    let mut counts = TypeMetadataCounts::default();
    for path in actual_inputs {
        if let Some(metadata) = metadata_by_file.get(&path) {
            counts.add_assign(&metadata.counts);
        }
    }
    let has_type_metadata = counts.has_type_metadata();
    Ok((counts, has_type_metadata))
}
