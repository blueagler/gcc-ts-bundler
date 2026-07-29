#![allow(non_snake_case)]

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

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
        let destination = Path::new(&out_dir).join(output_name);
        let source = collect_file_state(&output_file);
        let destination_state = collect_file_state(&destination.to_string_lossy());
        let hashes_match = match (hash_file(Path::new(&output_file)), hash_file(&destination)) {
            (Some(source_hash), Some(destination_hash)) => source_hash == destination_hash,
            _ => false,
        };
        source.exists
            && destination_state.exists
            && source.size == destination_state.size
            && hashes_match
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
                .map(|duration| duration.as_secs_f64() * 1000.0)
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

fn hash_file(file_path: &Path) -> Option<Vec<u8>> {
    let mut file = fs::File::open(file_path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Some(hasher.finalize().to_vec())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn published_outputs_compare_content_not_only_size() {
        let root = std::env::temp_dir().join(format!(
            "gcc-ts-bundler-fs-state-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos(),
        ));
        let out_dir = root.join("out");
        fs::create_dir_all(&out_dir).expect("create test output directory");
        let source = root.join("bundle.js");
        let published = out_dir.join("bundle.js");
        fs::write(&source, "AAAA").expect("write source");
        fs::write(&published, "BBBB").expect("write tampered output");

        assert!(!published_outputs_match(
            vec![source.to_string_lossy().to_string()],
            out_dir.to_string_lossy().to_string(),
        ));
        fs::write(&published, "AAAA").expect("write matching output");
        assert!(published_outputs_match(
            vec![source.to_string_lossy().to_string()],
            out_dir.to_string_lossy().to_string(),
        ));

        fs::remove_dir_all(root).expect("remove test directory");
    }
}
