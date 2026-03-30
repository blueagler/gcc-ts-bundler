#![allow(non_snake_case)]

use std::fs;
use std::path::PathBuf;

use napi_derive::napi;

#[allow(non_snake_case)]
#[napi(object)]
pub struct ShimEntry {
    pub exportNames: Vec<String>,
    pub hasDefaultExport: bool,
    pub importPath: String,
    pub shimPath: String,
}

pub fn write_entry_shims(entries: Vec<ShimEntry>) -> std::result::Result<Vec<String>, String> {
    let mut written_files = Vec::new();

    for entry in entries {
        let mut lines = Vec::new();
        lines.push(format!("import * as __entry from {:?};", entry.importPath));
        lines.push(String::new());
        lines.push("((globalThis as Record<string, unknown>)[\"GCC\"] =".to_string());
        lines.push("  (globalThis as Record<string, unknown>)[\"GCC\"] || {});".to_string());

        for export_name in entry.exportNames {
            lines.push(format!(
                "(((globalThis as Record<string, unknown>)[\"GCC\"]) as Record<string, unknown>)[{:?}] = __entry.{};",
                export_name, export_name
            ));
        }

        if entry.hasDefaultExport {
            lines.push(
                "(((globalThis as Record<string, unknown>)[\"GCC\"]) as Record<string, unknown>)[\"__DEFAULT_EXPORT__\"] = __entry.default;".to_string(),
            );
        }

        let shim_path = PathBuf::from(&entry.shimPath);
        if let Some(parent) = shim_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&shim_path, format!("{}\n", lines.join("\n")))
            .map_err(|error| error.to_string())?;
        written_files.push(entry.shimPath);
    }

    Ok(written_files)
}
