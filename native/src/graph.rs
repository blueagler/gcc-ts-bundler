#![allow(non_snake_case)]

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use serde_json::Value;
use sha2::{Digest, Sha256};
use swc_core::ecma::ast::*;

use crate::module_cache::{get_or_parse_cached_module, parse_and_cache_module};

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct EntryExportMetadata {
    pub exportNames: Vec<String>,
    pub hasDefaultExport: bool,
    pub sourcePath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Debug)]
pub struct FileHashEntry {
    pub filePath: String,
    pub hash: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Debug)]
pub struct DependencyGraphEntry {
    pub dependencies: Vec<String>,
    pub filePath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PackageAliasEntry {
    pub packageName: String,
    pub subpath: String,
    pub targetPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Debug)]
pub struct ResolveGraphOutput {
    pub entries: Vec<EntryExportMetadata>,
    pub fileHashes: Vec<FileHashEntry>,
    pub graph: Vec<DependencyGraphEntry>,
    pub packageAliases: Vec<PackageAliasEntry>,
    pub packageJsonFiles: Vec<String>,
    pub sourceFiles: Vec<String>,
    pub trackedFiles: Vec<String>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum PackageMode {
    EsmOnly,
    Off,
}

struct ResolveContext<'a> {
    package_mode: PackageMode,
    src_dir: &'a Path,
    workspace_dir: &'a Path,
}

struct ResolvedModule {
    package_alias: Option<PackageAliasEntry>,
    package_json_files: Vec<PathBuf>,
    path: PathBuf,
}

struct PackageImport {
    package_name: String,
    subpath: String,
}

pub fn resolve_graph(
    entries: Vec<String>,
    src_dir: String,
    workspace_dir: String,
    package_mode: String,
) -> std::result::Result<ResolveGraphOutput, String> {
    let src_dir = PathBuf::from(src_dir);
    let workspace_dir = PathBuf::from(workspace_dir);
    let entries: Vec<PathBuf> = entries.into_iter().map(PathBuf::from).collect();
    let context = ResolveContext {
        package_mode: PackageMode::parse(&package_mode)?,
        src_dir: &src_dir,
        workspace_dir: &workspace_dir,
    };

    let mut consulted_package_jsons = BTreeSet::new();
    let mut file_hashes = BTreeMap::new();
    let mut graph = BTreeMap::new();
    let mut module_cache = HashMap::new();
    let mut package_aliases = BTreeMap::<String, PackageAliasEntry>::new();
    let mut pending = entries.clone();
    let mut visited = BTreeSet::new();

    while let Some(current_file) = pending.pop() {
        if visited.contains(&current_file) {
            continue;
        }

        visited.insert(current_file.clone());
        let contents = fs::read_to_string(&current_file).map_err(|error| error.to_string())?;
        let relative = path_relative_to(&current_file, context.workspace_dir);
        file_hashes.insert(relative, hash_content(&contents));

        if is_package_source_file(&current_file, &context) {
            validate_package_source(&current_file, &contents)?;
        }

        let module = parse_and_cache_module(&current_file, &contents)?;
        let mut dependencies = BTreeSet::new();
        for specifier in extract_dependencies(&module) {
            if let Some(resolved) = resolve_module_specifier(&specifier, &current_file, &context)? {
                consulted_package_jsons.extend(resolved.package_json_files.iter().cloned());
                if let Some(package_alias) = resolved.package_alias {
                    package_aliases.insert(
                        format!("{}\0{}", package_alias.packageName, package_alias.subpath),
                        package_alias,
                    );
                }
                dependencies.insert(resolved.path);
            }
        }

        graph.insert(
            current_file.to_string_lossy().to_string(),
            dependencies
                .iter()
                .map(|dependency| dependency.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
        );

        module_cache.insert(current_file.clone(), module);
        pending.extend(dependencies.into_iter());
    }

    for package_json_file in &consulted_package_jsons {
        let contents = fs::read_to_string(package_json_file).map_err(|error| error.to_string())?;
        let relative = path_relative_to(package_json_file, context.workspace_dir);
        file_hashes.insert(relative, hash_content(&contents));
    }

    let mut export_cache = HashMap::<PathBuf, EntryExportMetadata>::new();
    let entries_metadata = entries
        .iter()
        .map(|entry| collect_exports(entry, &mut module_cache, &mut export_cache, &context))
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let package_json_files = consulted_package_jsons
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let source_files = visited
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let tracked_files = source_files
        .iter()
        .cloned()
        .chain(package_json_files.iter().cloned())
        .collect::<Vec<_>>();

    Ok(ResolveGraphOutput {
        entries: entries_metadata,
        fileHashes: file_hashes
            .into_iter()
            .map(|(file_path, hash)| FileHashEntry {
                filePath: file_path,
                hash,
            })
            .collect(),
        graph: graph
            .into_iter()
            .map(|(file_path, dependencies)| DependencyGraphEntry {
                dependencies,
                filePath: file_path,
            })
            .collect(),
        packageAliases: package_aliases.into_values().collect(),
        packageJsonFiles: package_json_files,
        sourceFiles: source_files,
        trackedFiles: tracked_files,
    })
}

impl PackageMode {
    fn parse(value: &str) -> std::result::Result<Self, String> {
        match value {
            "esm-only" => Ok(Self::EsmOnly),
            "off" => Ok(Self::Off),
            _ => Err(format!("Unsupported package mode: {value}")),
        }
    }
}

fn collect_exports(
    file_path: &PathBuf,
    module_cache: &mut HashMap<PathBuf, Module>,
    export_cache: &mut HashMap<PathBuf, EntryExportMetadata>,
    context: &ResolveContext,
) -> std::result::Result<EntryExportMetadata, String> {
    if let Some(existing) = export_cache.get(file_path) {
        return Ok(existing.clone());
    }

    let module = if let Some(existing) = module_cache.get(file_path) {
        existing.clone()
    } else {
        let parsed = get_or_parse_cached_module(file_path)?;
        module_cache.insert(file_path.clone(), parsed.clone());
        parsed
    };

    let mut export_names = BTreeSet::new();
    let mut has_default_export = false;

    for item in module.body.iter() {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => match &export_decl.decl {
                Decl::Class(class_decl) => {
                    export_names.insert(class_decl.ident.sym.to_string());
                }
                Decl::Fn(fn_decl) => {
                    export_names.insert(fn_decl.ident.sym.to_string());
                }
                Decl::Var(var_decl) => {
                    for declarator in &var_decl.decls {
                        collect_pattern_idents(&declarator.name, &mut export_names);
                    }
                }
                Decl::TsEnum(enum_decl) => {
                    export_names.insert(enum_decl.id.sym.to_string());
                }
                _ => {}
            },
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_))
            | ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(_)) => {
                has_default_export = true;
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                if named.type_only {
                    continue;
                }

                if let Some(src) = &named.src {
                    if let Some(resolved) =
                        resolve_module_specifier(&src.value.to_string_lossy(), file_path, context)?
                    {
                        let target_exports =
                            collect_exports(&resolved.path, module_cache, export_cache, context)?;
                        for specifier in &named.specifiers {
                            if let ExportSpecifier::Named(named_specifier) = specifier {
                                let exported_name = export_name_from_module_export_name(
                                    named_specifier
                                        .exported
                                        .as_ref()
                                        .unwrap_or(&named_specifier.orig),
                                );
                                if exported_name != "default" {
                                    export_names.insert(exported_name);
                                }
                            }
                        }
                        if target_exports.hasDefaultExport
                            && named.specifiers.iter().any(|specifier| match specifier {
                                ExportSpecifier::Named(named_specifier) => {
                                    export_name_from_module_export_name(
                                        named_specifier
                                            .exported
                                            .as_ref()
                                            .unwrap_or(&named_specifier.orig),
                                    ) == "default"
                                }
                                _ => false,
                            })
                        {
                            has_default_export = true;
                        }
                    }
                } else {
                    for specifier in &named.specifiers {
                        if let ExportSpecifier::Named(named_specifier) = specifier {
                            let exported_name = export_name_from_module_export_name(
                                named_specifier.exported.as_ref().unwrap_or(&named_specifier.orig),
                            );
                            if exported_name == "default" {
                                has_default_export = true;
                            } else {
                                export_names.insert(exported_name);
                            }
                        }
                    }
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportAll(export_all)) => {
                if export_all.type_only {
                    continue;
                }

                if let Some(resolved) =
                    resolve_module_specifier(&export_all.src.value.to_string_lossy(), file_path, context)?
                {
                    let target_exports =
                        collect_exports(&resolved.path, module_cache, export_cache, context)?;
                    for export_name in target_exports.exportNames {
                        export_names.insert(export_name);
                    }
                }
            }
            _ => {}
        }
    }

    let metadata = EntryExportMetadata {
        exportNames: export_names.into_iter().collect(),
        hasDefaultExport: has_default_export,
        sourcePath: file_path.to_string_lossy().to_string(),
    };
    export_cache.insert(file_path.clone(), metadata.clone());
    Ok(metadata)
}

fn collect_pattern_idents(pattern: &Pat, out: &mut BTreeSet<String>) {
    match pattern {
        Pat::Ident(ident) => {
            out.insert(ident.id.sym.to_string());
        }
        Pat::Array(array) => {
            for element in &array.elems {
                if let Some(pattern) = element {
                    collect_pattern_idents(pattern, out);
                }
            }
        }
        Pat::Object(object) => {
            for property in &object.props {
                match property {
                    ObjectPatProp::Assign(assign) => {
                        out.insert(assign.key.sym.to_string());
                    }
                    ObjectPatProp::KeyValue(key_value) => {
                        collect_pattern_idents(&key_value.value, out);
                    }
                    ObjectPatProp::Rest(rest) => {
                        collect_pattern_idents(&rest.arg, out);
                    }
                }
            }
        }
        Pat::Rest(rest) => collect_pattern_idents(&rest.arg, out),
        Pat::Assign(assign) => collect_pattern_idents(&assign.left, out),
        _ => {}
    }
}

fn extract_dependencies(module: &Module) -> Vec<String> {
    let mut dependencies = Vec::new();

    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(import_decl)) => {
                if !import_decl.type_only {
                    dependencies.push(import_decl.src.value.to_string_lossy().to_string());
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                if !named.type_only {
                    if let Some(src) = &named.src {
                        dependencies.push(src.value.to_string_lossy().to_string());
                    }
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportAll(export_all)) => {
                if !export_all.type_only {
                    dependencies.push(export_all.src.value.to_string_lossy().to_string());
                }
            }
            _ => {}
        }
    }

    dependencies
}

fn resolve_module_specifier(
    specifier: &str,
    importer: &Path,
    context: &ResolveContext,
) -> std::result::Result<Option<ResolvedModule>, String> {
    if is_node_builtin(specifier) {
        return Err(format!(
            "Unsupported Node builtin import \"{specifier}\" in {}",
            importer.to_string_lossy()
        ));
    }

    if specifier.starts_with('.') {
        return resolve_relative_module(specifier, importer, context).map(Some);
    }

    if !is_bare_package_specifier(specifier) {
        return Err(format!(
            "Unsupported non-relative import \"{specifier}\" in {}",
            importer.to_string_lossy()
        ));
    }

    match context.package_mode {
        PackageMode::Off => Err(format!(
            "Package import \"{specifier}\" is not allowed when packages.mode is off"
        )),
        PackageMode::EsmOnly => resolve_package_import(specifier, importer, context).map(Some),
    }
}

fn resolve_relative_module(
    specifier: &str,
    importer: &Path,
    context: &ResolveContext,
) -> std::result::Result<ResolvedModule, String> {
    let importer_dir = importer.parent().ok_or_else(|| {
        format!(
            "Cannot resolve import \"{specifier}\" from {}",
            importer.to_string_lossy()
        )
    })?;
    let allowed_root = if importer.starts_with(context.src_dir) {
        context.src_dir
    } else {
        context.workspace_dir
    };
    let base = importer_dir.join(specifier);
    resolve_module_base(
        &base,
        allowed_root,
        &format!("import \"{specifier}\""),
        importer,
    )?
    .map(|path| ResolvedModule {
        package_alias: None,
        package_json_files: Vec::new(),
        path,
    })
    .ok_or_else(|| {
        format!(
            "Failed to resolve import \"{specifier}\" from {}",
            importer.to_string_lossy()
        )
    })
}

fn resolve_package_import(
    specifier: &str,
    importer: &Path,
    context: &ResolveContext,
) -> std::result::Result<ResolvedModule, String> {
    let package_import = parse_package_import(specifier)?;
    let package_dir = find_package_dir(importer, &package_import.package_name).ok_or_else(|| {
        format!(
            "Failed to resolve package \"{}\" from {}",
            package_import.package_name,
            importer.to_string_lossy()
        )
    })?;
    let package_json_path = package_dir.join("package.json");
    let mut package_json_files = Vec::new();
    let package_json = if package_json_path.exists() {
        package_json_files.push(package_json_path.clone());
        Some(read_package_json(&package_json_path)?)
    } else {
        None
    };

    let path = resolve_package_path(
        &package_import,
        &package_dir,
        package_json.as_ref(),
        importer,
        context,
    )?;
    Ok(ResolvedModule {
        package_alias: Some(PackageAliasEntry {
            packageName: package_import.package_name.clone(),
            subpath: package_import.subpath.clone(),
            targetPath: path.to_string_lossy().to_string(),
        }),
        package_json_files,
        path,
    })
}

fn resolve_package_path(
    package_import: &PackageImport,
    package_dir: &Path,
    package_json: Option<&Value>,
    importer: &Path,
    context: &ResolveContext,
) -> std::result::Result<PathBuf, String> {
    if let Some(package_json) = package_json {
        if let Some(exports) = package_json.get("exports") {
            if let Some(target) =
                resolve_package_exports(exports, &package_import.subpath, &package_import.package_name)?
            {
                if let Some(path) = resolve_package_target(
                    &target,
                    package_dir,
                    importer,
                    &package_import.package_name,
                    context,
                )? {
                    return Ok(path);
                }
            }
        }

        if package_import.subpath == "." {
            for field_name in ["browser", "module", "main"] {
                if let Some(target) = package_json.get(field_name).and_then(Value::as_str) {
                    if let Some(path) = resolve_package_target(
                        target,
                        package_dir,
                        importer,
                        &package_import.package_name,
                        context,
                    )? {
                        return Ok(path);
                    }
                }
            }
        } else if let Some(target) = resolve_browser_subpath(package_json, &package_import.subpath)? {
            if let Some(path) = resolve_package_target(
                &target,
                package_dir,
                importer,
                &package_import.package_name,
                context,
            )? {
                return Ok(path);
            }
        }
    }

    resolve_package_local_path(package_dir, &package_import.subpath, importer, &package_import.package_name, context)?
        .ok_or_else(|| {
            format!(
                "Failed to resolve package import \"{}\" from {}",
                format_package_specifier(package_import),
                importer.to_string_lossy()
            )
        })
}

fn resolve_package_exports(
    exports: &Value,
    subpath: &str,
    package_name: &str,
) -> std::result::Result<Option<String>, String> {
    match exports {
        Value::String(_) | Value::Array(_) => {
            if subpath == "." {
                resolve_export_target_value(exports, package_name)
            } else {
                Ok(None)
            }
        }
        Value::Object(object) => {
            if object.keys().any(|key| key.starts_with('.')) {
                if let Some(value) = object.get(subpath) {
                    return resolve_export_target_value(value, package_name);
                }

                if let Some((pattern, value)) = match_exports_pattern(object, subpath) {
                    if let Some(target) = resolve_export_target_value(value, package_name)? {
                        let capture = extract_pattern_capture(pattern, subpath);
                        return Ok(Some(target.replace('*', &capture)));
                    }
                }

                Ok(None)
            } else if subpath == "." {
                resolve_export_target_value(exports, package_name)
            } else {
                Ok(None)
            }
        }
        _ => Ok(None),
    }
}

fn resolve_export_target_value(
    value: &Value,
    package_name: &str,
) -> std::result::Result<Option<String>, String> {
    match value {
        Value::String(target) => Ok(Some(target.clone())),
        Value::Array(values) => {
            for value in values {
                if let Some(target) = resolve_export_target_value(value, package_name)? {
                    return Ok(Some(target));
                }
            }
            Ok(None)
        }
        Value::Object(object) => {
            for condition in ["browser", "import", "default"] {
                if let Some(value) = object.get(condition) {
                    return resolve_export_target_value(value, package_name);
                }
            }
            Ok(None)
        }
        Value::Bool(false) | Value::Null => Err(format!(
            "Package \"{package_name}\" disables this export for browser-safe ESM bundling"
        )),
        _ => Ok(None),
    }
}

fn resolve_browser_subpath(
    package_json: &Value,
    subpath: &str,
) -> std::result::Result<Option<String>, String> {
    let Some(browser_field) = package_json.get("browser") else {
        return Ok(None);
    };

    let Value::Object(object) = browser_field else {
        return Ok(None);
    };

    for key in [subpath.to_string(), format!("{subpath}.js")] {
        if let Some(value) = object.get(&key) {
            return match value {
                Value::String(target) => Ok(Some(target.clone())),
                Value::Bool(false) | Value::Null => Err(format!(
                    "Package subpath \"{subpath}\" is disabled by the browser field"
                )),
                _ => Ok(None),
            };
        }
    }

    Ok(None)
}

fn resolve_package_target(
    target: &str,
    package_dir: &Path,
    importer: &Path,
    package_name: &str,
    _context: &ResolveContext,
) -> std::result::Result<Option<PathBuf>, String> {
    if target.starts_with("./") {
        let base = package_dir.join(target.trim_start_matches("./"));
        return resolve_module_base(
            &base,
            package_dir,
            &format!("package \"{package_name}\" target \"{target}\""),
            importer,
        );
    }

    Err(format!(
        "Unsupported export target \"{target}\" in package \"{package_name}\""
    ))
}

fn resolve_package_local_path(
    package_dir: &Path,
    subpath: &str,
    importer: &Path,
    package_name: &str,
    _context: &ResolveContext,
) -> std::result::Result<Option<PathBuf>, String> {
    let base = if subpath == "." {
        package_dir.to_path_buf()
    } else {
        package_dir.join(subpath.trim_start_matches("./"))
    };

    resolve_module_base(
        &base,
        package_dir,
        &format!("package \"{package_name}\""),
        importer,
    )
}

fn resolve_module_base(
    base: &Path,
    allowed_root: &Path,
    description: &str,
    importer: &Path,
) -> std::result::Result<Option<PathBuf>, String> {
    for candidate in module_candidates(base) {
        if !candidate.exists() {
            continue;
        }
        if candidate.is_dir() {
            continue;
        }

        validate_candidate(&candidate, allowed_root, description, importer)?;
        return Ok(Some(candidate));
    }

    Ok(None)
}

fn validate_candidate(
    candidate: &Path,
    allowed_root: &Path,
    description: &str,
    importer: &Path,
) -> std::result::Result<(), String> {
    if !candidate.starts_with(allowed_root) {
        return Err(format!(
            "{} escapes the allowed root from {}",
            description,
            importer.to_string_lossy()
        ));
    }

    let Some(extension) = candidate.extension().and_then(|value| value.to_str()) else {
        return Ok(());
    };
    match extension {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "mts" => Ok(()),
        "cjs" | "cts" => Err(format!(
            "Unsupported CommonJS module {} referenced by {}",
            candidate.to_string_lossy(),
            importer.to_string_lossy()
        )),
        "json" => Err(format!(
            "Unsupported JSON module {} referenced by {}",
            candidate.to_string_lossy(),
            importer.to_string_lossy()
        )),
        "node" => Err(format!(
            "Unsupported native addon {} referenced by {}",
            candidate.to_string_lossy(),
            importer.to_string_lossy()
        )),
        _ => Err(format!(
            "Unsupported module {} referenced by {}",
            candidate.to_string_lossy(),
            importer.to_string_lossy()
        )),
    }
}

fn validate_package_source(file_path: &Path, source: &str) -> std::result::Result<(), String> {
    if source.contains("module.exports")
        || source.contains("exports.")
        || source.contains("exports[")
        || source.contains("require(")
    {
        return Err(format!(
            "Unsupported CommonJS syntax in package source {}",
            file_path.to_string_lossy()
        ));
    }

    Ok(())
}

fn parse_package_import(specifier: &str) -> std::result::Result<PackageImport, String> {
    if specifier.starts_with('@') {
        let mut segments = specifier.split('/');
        let scope = segments
            .next()
            .ok_or_else(|| format!("Invalid package specifier \"{specifier}\""))?;
        let name = segments
            .next()
            .ok_or_else(|| format!("Invalid package specifier \"{specifier}\""))?;
        let package_name = format!("{scope}/{name}");
        let remainder = segments.collect::<Vec<_>>().join("/");
        Ok(PackageImport {
            package_name,
            subpath: if remainder.is_empty() {
                ".".to_string()
            } else {
                format!("./{remainder}")
            },
        })
    } else {
        let mut segments = specifier.split('/');
        let package_name = segments
            .next()
            .ok_or_else(|| format!("Invalid package specifier \"{specifier}\""))?
            .to_string();
        let remainder = segments.collect::<Vec<_>>().join("/");
        Ok(PackageImport {
            package_name,
            subpath: if remainder.is_empty() {
                ".".to_string()
            } else {
                format!("./{remainder}")
            },
        })
    }
}

fn find_package_dir(importer: &Path, package_name: &str) -> Option<PathBuf> {
    let mut current = importer.parent();

    while let Some(directory) = current {
        let candidate = directory.join("node_modules").join(package_name);
        if candidate.exists() {
            return Some(candidate);
        }
        current = directory.parent();
    }

    None
}

fn read_package_json(path: &Path) -> std::result::Result<Value, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("{}: {error}", path.to_string_lossy()))
}

fn match_exports_pattern<'a>(
    object: &'a serde_json::Map<String, Value>,
    subpath: &str,
) -> Option<(&'a str, &'a Value)> {
    object
        .iter()
        .filter_map(|(pattern, value)| {
            if !pattern.contains('*') || !subpath.starts_with("./") {
                return None;
            }
            let prefix = pattern.split('*').next()?;
            let suffix = pattern.split('*').nth(1)?;
            if subpath.starts_with(prefix) && subpath.ends_with(suffix) {
                Some((pattern.as_str(), value))
            } else {
                None
            }
        })
        .max_by_key(|(pattern, _)| pattern.len())
}

fn extract_pattern_capture(pattern: &str, subpath: &str) -> String {
    let prefix = pattern.split('*').next().unwrap_or_default();
    let suffix = pattern.split('*').nth(1).unwrap_or_default();
    subpath
        .trim_start_matches(prefix)
        .trim_end_matches(suffix)
        .to_string()
}

fn format_package_specifier(package_import: &PackageImport) -> String {
    if package_import.subpath == "." {
        package_import.package_name.clone()
    } else {
        format!(
            "{}/{}",
            package_import.package_name,
            package_import.subpath.trim_start_matches("./")
        )
    }
}

fn is_bare_package_specifier(specifier: &str) -> bool {
    !specifier.starts_with('/') && !specifier.contains(':')
}

fn is_node_builtin(specifier: &str) -> bool {
    if specifier.starts_with("node:") {
        return true;
    }
    if specifier.starts_with('@') {
        return false;
    }

    let root = specifier.split('/').next().unwrap_or(specifier);
    matches!(
        root,
        "_http_agent"
            | "_http_client"
            | "_http_common"
            | "_http_incoming"
            | "_http_outgoing"
            | "_http_server"
            | "_stream_duplex"
            | "_stream_passthrough"
            | "_stream_readable"
            | "_stream_transform"
            | "_stream_wrap"
            | "_stream_writable"
            | "_tls_common"
            | "_tls_wrap"
            | "assert"
            | "async_hooks"
            | "buffer"
            | "child_process"
            | "cluster"
            | "console"
            | "constants"
            | "crypto"
            | "dgram"
            | "diagnostics_channel"
            | "dns"
            | "domain"
            | "events"
            | "fs"
            | "http"
            | "http2"
            | "https"
            | "inspector"
            | "module"
            | "net"
            | "os"
            | "path"
            | "perf_hooks"
            | "process"
            | "punycode"
            | "querystring"
            | "readline"
            | "repl"
            | "stream"
            | "string_decoder"
            | "sys"
            | "timers"
            | "tls"
            | "trace_events"
            | "tty"
            | "url"
            | "util"
            | "v8"
            | "vm"
            | "worker_threads"
            | "zlib"
    )
}

fn is_package_source_file(file_path: &Path, context: &ResolveContext) -> bool {
    file_path.starts_with(context.workspace_dir.join("node_modules"))
}

fn module_candidates(base: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if base.extension().is_some() {
        candidates.push(base.to_path_buf());
    } else {
        candidates.push(base.to_path_buf());
        for extension in [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mjs",
            ".mts",
            ".cjs",
            ".cts",
            ".json",
            ".node",
        ] {
            candidates.push(PathBuf::from(format!("{}{}", base.to_string_lossy(), extension)));
        }
        for extension in [
            "index.ts",
            "index.tsx",
            "index.js",
            "index.jsx",
            "index.mjs",
            "index.mts",
            "index.cjs",
            "index.cts",
            "index.json",
            "index.node",
        ] {
            candidates.push(base.join(extension));
        }
    }
    candidates
}

fn export_name_from_module_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(ident) => ident.sym.to_string(),
        ModuleExportName::Str(string) => string.value.to_string_lossy().to_string(),
    }
}

fn path_relative_to(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let suffix = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("gcc-ts-bundler-native-{unique}-{suffix}"));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn join(&self, relative: &str) -> PathBuf {
            self.path.join(relative)
        }

        fn write(&self, relative: &str, contents: &str) {
            let file_path = self.join(relative);
            if let Some(parent) = file_path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(file_path, contents).unwrap();
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn resolves_package_root_from_exports_browser_condition() {
        let temp_dir = TestDir::new();
        temp_dir.write("src/index.ts", "import pkg from \"demo-pkg\";\nexport default pkg;\n");
        temp_dir.write(
            "node_modules/demo-pkg/package.json",
            r#"{"name":"demo-pkg","exports":{"browser":"./browser.js","import":"./import.js"}}"#,
        );
        temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n");
        temp_dir.write("node_modules/demo-pkg/import.js", "export default 2;\n");

        let result = resolve_graph(
            vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            "esm-only".to_string(),
        )
        .unwrap();

        assert!(result
            .sourceFiles
            .iter()
            .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
    }

    #[test]
    fn resolves_package_subpath_from_exports_pattern() {
        let temp_dir = TestDir::new();
        temp_dir.write(
            "src/index.ts",
            "import feature from \"demo-pkg/features/button\";\nexport default feature;\n",
        );
        temp_dir.write(
            "node_modules/demo-pkg/package.json",
            r#"{"name":"demo-pkg","exports":{"./features/*":{"browser":"./dist/features/*.js"}}}"#,
        );
        temp_dir.write("node_modules/demo-pkg/dist/features/button.js", "export default 1;\n");

        let result = resolve_graph(
            vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            "esm-only".to_string(),
        )
        .unwrap();

        assert!(result
            .sourceFiles
            .iter()
            .any(|path| path.ends_with("node_modules/demo-pkg/dist/features/button.js")));
    }

    #[test]
    fn falls_back_to_browser_then_module_then_main() {
        let temp_dir = TestDir::new();
        temp_dir.write("src/index.ts", "import pkg from \"demo-pkg\";\nexport default pkg;\n");
        temp_dir.write(
            "node_modules/demo-pkg/package.json",
            r#"{"name":"demo-pkg","browser":"./browser.js","module":"./module.js","main":"./main.cjs"}"#,
        );
        temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n");
        temp_dir.write("node_modules/demo-pkg/module.js", "export default 2;\n");
        temp_dir.write("node_modules/demo-pkg/main.cjs", "module.exports = 3;\n");

        let result = resolve_graph(
            vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            "esm-only".to_string(),
        )
        .unwrap();

        assert!(result
            .sourceFiles
            .iter()
            .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
    }

    #[test]
    fn tracks_package_json_hash_changes() {
        let temp_dir = TestDir::new();
        temp_dir.write("src/index.ts", "import pkg from \"demo-pkg\";\nexport default pkg;\n");
        temp_dir.write(
            "node_modules/demo-pkg/package.json",
            r#"{"name":"demo-pkg","module":"./index.js"}"#,
        );
        temp_dir.write("node_modules/demo-pkg/index.js", "export default 1;\n");

        let first = resolve_graph(
            vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            "esm-only".to_string(),
        )
        .unwrap();
        temp_dir.write(
            "node_modules/demo-pkg/package.json",
            r#"{"name":"demo-pkg","module":"./index.js","version":"2.0.0"}"#,
        );
        let second = resolve_graph(
            vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            "esm-only".to_string(),
        )
        .unwrap();

        let first_hash = first
            .fileHashes
            .iter()
            .find(|entry| entry.filePath == "node_modules/demo-pkg/package.json")
            .unwrap()
            .hash
            .clone();
        let second_hash = second
            .fileHashes
            .iter()
            .find(|entry| entry.filePath == "node_modules/demo-pkg/package.json")
            .unwrap()
            .hash
            .clone();

        assert_ne!(first_hash, second_hash);
    }

    #[test]
    fn rejects_commonjs_package_entrypoints() {
        let temp_dir = TestDir::new();
        temp_dir.write("src/index.ts", "import pkg from \"demo-pkg\";\nexport default pkg;\n");
        temp_dir.write(
            "node_modules/demo-pkg/package.json",
            r#"{"name":"demo-pkg","main":"./index.cjs"}"#,
        );
        temp_dir.write("node_modules/demo-pkg/index.cjs", "module.exports = 1;\n");

        let error = resolve_graph(
            vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            "esm-only".to_string(),
        )
        .unwrap_err();

        assert!(error.contains("CommonJS"));
    }

    #[test]
    fn rejects_node_builtin_imports() {
        let temp_dir = TestDir::new();
        temp_dir.write(
            "src/index.ts",
            "import { join } from \"node:path\";\nexport default join;\n",
        );

        let error = resolve_graph(
            vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            "esm-only".to_string(),
        )
        .unwrap_err();

        assert!(error.contains("Node builtin"));
    }
}
