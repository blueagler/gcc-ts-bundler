#![allow(non_snake_case)]

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
            && (!entry.exists
                || (current.size == entry.size && current.mtimeMs == entry.mtimeMs))
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
