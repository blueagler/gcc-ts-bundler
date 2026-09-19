use std::cmp::Ordering;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use napi_derive::napi;

#[napi(object)]
#[derive(Clone)]
pub struct FileStateEntry {
    pub exists: bool,
    #[napi(js_name = "filePath")]
    pub file_path: String,
    #[napi(js_name = "mtimeMs")]
    pub mtime_ms: f64,
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
        let current = collect_file_state(&entry.file_path);
        // Cache identity uses exact IEEE equality: signed zero matches, NaN does not.
        current.exists == entry.exists
            && (!entry.exists
                || (current.size.partial_cmp(&entry.size) == Some(Ordering::Equal)
                    && current.mtime_ms.partial_cmp(&entry.mtime_ms) == Some(Ordering::Equal)))
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
                .map_or(0.0, |duration| duration.as_secs_f64() * 1000.0);

            FileStateEntry {
                exists: true,
                file_path: file_path.to_string(),
                mtime_ms,
                size: metadata.len() as f64,
            }
        }
        Err(_) => FileStateEntry {
            exists: false,
            file_path: file_path.to_string(),
            mtime_ms: 0.0,
            size: 0.0,
        },
    }
}
