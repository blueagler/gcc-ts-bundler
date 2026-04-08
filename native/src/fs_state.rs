#![allow(non_snake_case)]

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use napi_derive::napi;

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone)]
pub struct FileStateEntry {
    pub exists: bool,
    pub filePath: String,
    pub mtimeMs: f64,
    pub size: f64,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone)]
pub struct PublishedOutputEntry {
    pub name: String,
    pub size: f64,
}

pub fn collect_file_states(file_paths: Vec<String>) -> Vec<FileStateEntry> {
    file_paths
        .into_iter()
        .map(|file_path| collect_file_state(&file_path))
        .collect()
}

pub fn match_file_states(expected: Vec<FileStateEntry>) -> bool {
    expected.into_iter().all(|entry| {
        let current = collect_file_state(&entry.filePath);
        current.exists == entry.exists
            && (!entry.exists || (current.size == entry.size && current.mtimeMs == entry.mtimeMs))
    })
}

pub fn collect_published_output_stats(file_paths: Vec<String>) -> Vec<PublishedOutputEntry> {
    let mut by_name = BTreeMap::new();
    for file_path in file_paths {
        let state = collect_file_state(&file_path);
        if !state.exists {
            continue;
        }

        let name = Path::new(&file_path)
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or(file_path);
        by_name.insert(name, state.size);
    }

    by_name
        .into_iter()
        .map(|(name, size)| PublishedOutputEntry { name, size })
        .collect()
}

pub fn published_outputs_match(output_files: Vec<String>, out_dir: String) -> bool {
    let snapshots = collect_published_output_stats(output_files.clone());
    if !published_output_snapshot_matches(snapshots.clone(), out_dir.clone()) {
        return false;
    }

    output_files.into_iter().all(|output_file| {
        let output_name = match Path::new(&output_file).file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => return false,
        };
        let source = collect_file_state(&output_file);
        let destination =
            collect_file_state(&Path::new(&out_dir).join(output_name).to_string_lossy());
        source.exists && destination.exists && source.size == destination.size
    })
}

pub fn published_output_snapshot_matches(
    published_outputs: Vec<PublishedOutputEntry>,
    out_dir: String,
) -> bool {
    let Ok(mut out_entries) = fs::read_dir(&out_dir) else {
        return false;
    };

    let mut actual_entries = Vec::new();
    while let Some(Ok(entry)) = out_entries.next() {
        actual_entries.push(entry.file_name().to_string_lossy().to_string());
    }
    actual_entries.sort();

    let expected_entries = published_outputs
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    if actual_entries != expected_entries {
        return false;
    }

    published_outputs.into_iter().all(|entry| {
        let state = collect_file_state(&Path::new(&out_dir).join(&entry.name).to_string_lossy());
        state.exists && state.size == entry.size
    })
}

fn collect_file_state(file_path: &str) -> FileStateEntry {
    let path = Path::new(file_path);
    match fs::metadata(path) {
        Ok(metadata) => {
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as f64)
                .unwrap_or(0.0);

            FileStateEntry {
                exists: true,
                filePath: file_path.to_string(),
                mtimeMs: mtime_ms,
                size: metadata.len() as f64,
            }
        }
        Err(_) => FileStateEntry {
            exists: false,
            filePath: file_path.to_string(),
            mtimeMs: 0.0,
            size: 0.0,
        },
    }
}
