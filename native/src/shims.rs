use std::fs;
use std::path::PathBuf;

use napi_derive::napi;

#[napi(object)]
pub struct ShimEntry {
    #[napi(js_name = "constEnumExportNames")]
    pub const_enum_export_names: Vec<String>,
    #[napi(js_name = "exportNames")]
    pub export_names: Vec<String>,
    #[napi(js_name = "hasDefaultExport")]
    pub has_default_export: bool,
    #[napi(js_name = "importPath")]
    pub import_path: String,
    #[napi(js_name = "shimPath")]
    pub shim_path: String,
}

pub fn write_entry_shims(entries: Vec<ShimEntry>) -> std::result::Result<Vec<String>, String> {
    let mut written_files = Vec::new();

    for entry in entries {
        let lines = render_shim_lines(&entry);

        let shim_path = PathBuf::from(&entry.shim_path);
        if let Some(parent) = shim_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&shim_path, format!("{}\n", lines.join("\n")))
            .map_err(|error| error.to_string())?;
        written_files.push(entry.shim_path);
    }

    Ok(written_files)
}

fn render_shim_lines(entry: &ShimEntry) -> Vec<String> {
    if entry.export_names.is_empty() && !entry.has_default_export {
        return vec![format!("import {:?};", entry.import_path)];
    }

    let mut lines = Vec::new();
    let mut imports = entry
        .export_names
        .iter()
        .enumerate()
        .filter(|(_, name)| !entry.const_enum_export_names.contains(name))
        .map(|(index, name)| format!("{name} as __entry_{index}"))
        .collect::<Vec<_>>();
    let const_enum_default = entry
        .const_enum_export_names
        .iter()
        .any(|name| name == "default");
    if entry.has_default_export && !const_enum_default {
        imports.push("default as __entry_default".to_string());
    }
    if !imports.is_empty() {
        lines.push(format!(
            "import {{ {} }} from {:?};",
            imports.join(", "),
            entry.import_path
        ));
    }
    if !entry.const_enum_export_names.is_empty() {
        lines.push(format!(
            "import * as __entry_namespace from {:?};",
            entry.import_path
        ));
    }
    lines.push(String::new());
    lines.push("((globalThis as Record<string, unknown>)[\"GCC\"] =".to_string());
    lines.push(
        "  (globalThis as Record<string, unknown>)[\"GCC\"] || {\"__gccBindingProtocol__\": 1});"
            .to_string(),
    );

    for (index, export_name) in entry.export_names.iter().enumerate() {
        // A preserved const enum has a runtime namespace property, but TypeScript
        // still forbids using its typed binding as a value. Transport only that
        // runtime property; ordinary exports keep their typed live getters.
        let value = if entry.const_enum_export_names.contains(export_name) {
            format!("(__entry_namespace as Record<string, unknown>)[{export_name:?}]")
        } else {
            format!("__entry_{index}")
        };
        lines.push(format!(
            "(((globalThis as Record<string, unknown>)[\"GCC\"]) as Record<string, unknown>)[{:?}] = () => {value};",
            format!("__gccBinding_{export_name}")
        ));
    }

    if entry.has_default_export {
        let value = if const_enum_default {
            "(__entry_namespace as Record<string, unknown>)[\"default\"]"
        } else {
            "__entry_default"
        };
        lines.push(format!(
            "(((globalThis as Record<string, unknown>)[\"GCC\"]) as Record<string, unknown>)[\"__gccBinding___DEFAULT_EXPORT__\"] = () => {value};"
        ));
    }

    lines
}

#[cfg(test)]
mod tests {
    use super::{render_shim_lines, ShimEntry};

    #[test]
    fn skips_gcc_bootstrap_when_entry_has_no_exports() {
        let lines = render_shim_lines(&ShimEntry {
            const_enum_export_names: Vec::new(),
            export_names: Vec::new(),
            has_default_export: false,
            import_path: "./entry".to_string(),
            shim_path: "unused.ts".to_string(),
        });

        assert_eq!(lines, vec!["import \"./entry\";".to_string()]);
    }
}
