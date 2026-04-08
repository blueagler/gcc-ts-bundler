#![allow(non_snake_case)]

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};

use napi_derive::napi;
use serde_json::Value;
use sha2::{Digest, Sha256};
use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{Visit, VisitWith};

use crate::commonjs::{analyze_commonjs_module, CommonJsAnalysis};
use crate::module_cache::{get_or_parse_cached_module, parse_and_cache_module};
use crate::pathing::to_goog_module_id;

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
#[derive(Clone, Debug)]
pub struct LazyImportEntry {
    pub importerFilePath: String,
    pub moduleId: String,
    pub specifier: String,
    pub targetPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Debug)]
pub struct ResolveGraphOutput {
    pub entries: Vec<EntryExportMetadata>,
    pub fileHashes: Vec<FileHashEntry>,
    pub graph: Vec<DependencyGraphEntry>,
    pub lazyImports: Vec<LazyImportEntry>,
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
    let mut commonjs_cache = HashMap::<PathBuf, CommonJsAnalysis>::new();
    let mut file_hashes = BTreeMap::new();
    let mut graph = BTreeMap::new();
    let mut lazy_imports = BTreeMap::<String, LazyImportEntry>::new();
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

        let module = parse_and_cache_module(&current_file, &contents)?;
        let commonjs_analysis = analyze_commonjs_module(&module);
        if commonjs_analysis.has_commonjs {
            validate_commonjs_usage(&current_file, &commonjs_analysis, &context)?;
        }
        commonjs_cache.insert(current_file.clone(), commonjs_analysis.clone());

        let specifiers = if commonjs_analysis.has_commonjs {
            commonjs_analysis.dependencies.clone()
        } else {
            extract_dependencies(&module)
        };
        let lazy_specifiers = if commonjs_analysis.has_commonjs {
            Vec::new()
        } else {
            collect_dynamic_import_specifiers(&module)?
        };

        let mut dependencies = BTreeSet::new();
        for specifier in specifiers {
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
        for specifier in lazy_specifiers {
            if let Some(resolved) = resolve_module_specifier(&specifier, &current_file, &context)? {
                consulted_package_jsons.extend(resolved.package_json_files.iter().cloned());
                if let Some(package_alias) = resolved.package_alias.clone() {
                    package_aliases.insert(
                        format!("{}\0{}", package_alias.packageName, package_alias.subpath),
                        package_alias,
                    );
                }
                pending.push(resolved.path.clone());
                let key = format!("{}\0{}", current_file.to_string_lossy(), specifier);
                lazy_imports.insert(
                    key,
                    LazyImportEntry {
                        importerFilePath: current_file.to_string_lossy().to_string(),
                        moduleId: to_goog_module_id(&resolved.path, context.workspace_dir),
                        specifier,
                        targetPath: resolved.path.to_string_lossy().to_string(),
                    },
                );
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
        .map(|entry| {
            collect_exports(
                entry,
                &mut commonjs_cache,
                &mut module_cache,
                &mut export_cache,
                &context,
            )
        })
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
        lazyImports: lazy_imports.into_values().collect(),
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
    commonjs_cache: &mut HashMap<PathBuf, CommonJsAnalysis>,
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

    let commonjs_analysis = commonjs_cache
        .get(file_path)
        .cloned()
        .unwrap_or_else(|| analyze_commonjs_module(&module));
    commonjs_cache.insert(file_path.clone(), commonjs_analysis.clone());
    if commonjs_analysis.has_commonjs {
        if let Some(specifier) = commonjs_analysis.proxy_export {
            if let Some(resolved) = resolve_module_specifier(&specifier, file_path, context)? {
                let metadata = collect_exports(
                    &resolved.path,
                    commonjs_cache,
                    module_cache,
                    export_cache,
                    context,
                )?;
                export_cache.insert(file_path.clone(), metadata.clone());
                return Ok(metadata);
            }
        }

        let metadata = EntryExportMetadata {
            exportNames: commonjs_analysis.export_names,
            hasDefaultExport: commonjs_analysis.has_default_export,
            sourcePath: file_path.to_string_lossy().to_string(),
        };
        export_cache.insert(file_path.clone(), metadata.clone());
        return Ok(metadata);
    }

    let mut export_names = BTreeSet::new();
    let mut has_default_export = false;

    for item in module.body.iter() {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
                match &export_decl.decl {
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
                }
            }
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
                        let target_exports = collect_exports(
                            &resolved.path,
                            commonjs_cache,
                            module_cache,
                            export_cache,
                            context,
                        )?;
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
                                named_specifier
                                    .exported
                                    .as_ref()
                                    .unwrap_or(&named_specifier.orig),
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

                if let Some(resolved) = resolve_module_specifier(
                    &export_all.src.value.to_string_lossy(),
                    file_path,
                    context,
                )? {
                    let target_exports = collect_exports(
                        &resolved.path,
                        commonjs_cache,
                        module_cache,
                        export_cache,
                        context,
                    )?;
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

fn collect_dynamic_import_specifiers(module: &Module) -> std::result::Result<Vec<String>, String> {
    let mut collector = DynamicImportCallCollector {
        errors: Vec::new(),
        specifiers: Vec::new(),
    };
    module.visit_with(&mut collector);
    if !collector.errors.is_empty() {
        return Err(collector.errors.join("\n"));
    }
    Ok(collector.specifiers)
}

struct DynamicImportCallCollector {
    errors: Vec<String>,
    specifiers: Vec<String>,
}

impl Visit for DynamicImportCallCollector {
    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        call_expr.visit_children_with(self);

        let Callee::Import(_) = &call_expr.callee else {
            return;
        };
        if call_expr.args.len() != 1 {
            self.errors
                .push("import() requires exactly one string literal argument".to_string());
            return;
        }
        match &*call_expr.args[0].expr {
            Expr::Lit(Lit::Str(string)) => {
                self.specifiers
                    .push(string.value.to_string_lossy().to_string());
            }
            Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => {
                self.specifiers.push(template.quasis[0].raw.to_string());
            }
            _ => self
                .errors
                .push("import() requires a string literal module specifier".to_string()),
        }
    }
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
    let allow_commonjs = !importer.starts_with(context.src_dir);
    let base = normalize_path(&importer_dir.join(specifier));
    resolve_module_base(
        &base,
        allow_commonjs,
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
    let package_dir =
        find_package_dir(importer, &package_import.package_name).ok_or_else(|| {
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
        let prefer_development_exports =
            package_prefers_development(package_json, package_dir, &package_import.package_name)?;
        if let Some(exports) = package_json.get("exports") {
            if let Some(target) = select_package_export_target(
                exports,
                package_dir,
                &package_import.subpath,
                &package_import.package_name,
                prefer_development_exports,
            )? {
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
        } else if let Some(target) = resolve_browser_subpath(package_json, &package_import.subpath)?
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

    resolve_package_local_path(
        package_dir,
        &package_import.subpath,
        importer,
        &package_import.package_name,
        context,
    )?
    .ok_or_else(|| {
        format!(
            "Failed to resolve package import \"{}\" from {}",
            format_package_specifier(package_import),
            importer.to_string_lossy()
        )
    })
}

fn select_package_export_target(
    exports: &Value,
    package_dir: &Path,
    subpath: &str,
    package_name: &str,
    prefer_development_exports: bool,
) -> std::result::Result<Option<String>, String> {
    let default_target = resolve_package_exports_with_conditions(
        exports,
        subpath,
        package_name,
        &["browser", "import", "default"],
    )?;
    let development_target = resolve_package_exports_with_conditions(
        exports,
        subpath,
        package_name,
        &["browser", "development", "import", "default"],
    )?;

    match (default_target, development_target) {
        (Some(default_target), Some(development_target))
            if development_target != default_target
                && (prefer_development_exports
                    || should_prefer_development_target(
                        package_dir,
                        &default_target,
                        &development_target,
                    )?) =>
        {
            Ok(Some(development_target))
        }
        (Some(default_target), _) => Ok(Some(default_target)),
        (None, Some(development_target)) => Ok(Some(development_target)),
        (None, None) => Ok(None),
    }
}

fn package_prefers_development(
    package_json: &Value,
    package_dir: &Path,
    package_name: &str,
) -> std::result::Result<bool, String> {
    let Some(exports) = package_json.get("exports") else {
        return Ok(false);
    };

    let default_target = resolve_package_exports_with_conditions(
        exports,
        ".",
        package_name,
        &["browser", "import", "default"],
    )?;
    let development_target = resolve_package_exports_with_conditions(
        exports,
        ".",
        package_name,
        &["browser", "development", "import", "default"],
    )?;

    match (default_target, development_target) {
        (Some(default_target), Some(development_target))
            if development_target != default_target =>
        {
            should_prefer_development_target(package_dir, &default_target, &development_target)
        }
        _ => Ok(false),
    }
}

fn resolve_package_exports_with_conditions(
    exports: &Value,
    subpath: &str,
    package_name: &str,
    preferred_conditions: &[&str],
) -> std::result::Result<Option<String>, String> {
    match exports {
        Value::String(_) | Value::Array(_) => {
            if subpath == "." {
                resolve_export_target_value(exports, package_name, preferred_conditions)
            } else {
                Ok(None)
            }
        }
        Value::Object(object) => {
            if object.keys().any(|key| key.starts_with('.')) {
                if let Some(value) = object.get(subpath) {
                    return resolve_export_target_value(value, package_name, preferred_conditions);
                }

                if let Some((pattern, value)) = match_exports_pattern(object, subpath) {
                    if let Some(target) =
                        resolve_export_target_value(value, package_name, preferred_conditions)?
                    {
                        let capture = extract_pattern_capture(pattern, subpath);
                        return Ok(Some(target.replace('*', &capture)));
                    }
                }

                Ok(None)
            } else if subpath == "." {
                resolve_export_target_value(exports, package_name, preferred_conditions)
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
    preferred_conditions: &[&str],
) -> std::result::Result<Option<String>, String> {
    match value {
        Value::String(target) => Ok(Some(target.clone())),
        Value::Array(values) => {
            for value in values {
                if let Some(target) =
                    resolve_export_target_value(value, package_name, preferred_conditions)?
                {
                    return Ok(Some(target));
                }
            }
            Ok(None)
        }
        Value::Object(object) => {
            for condition in preferred_conditions {
                if let Some(value) = object.get(*condition) {
                    return resolve_export_target_value(value, package_name, preferred_conditions);
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

fn should_prefer_development_target(
    package_dir: &Path,
    default_target: &str,
    development_target: &str,
) -> std::result::Result<bool, String> {
    if !default_target.starts_with("./") || !development_target.starts_with("./") {
        return Ok(false);
    }

    let default_path = package_dir.join(default_target.trim_start_matches("./"));
    let development_path = package_dir.join(development_target.trim_start_matches("./"));
    if !default_path.exists() || !development_path.exists() {
        return Ok(false);
    }

    let default_source = fs::read_to_string(&default_path).map_err(|error| error.to_string())?;
    let development_source =
        fs::read_to_string(&development_path).map_err(|error| error.to_string())?;
    let development_path_name = development_path.to_string_lossy();
    let default_path_name = default_path.to_string_lossy();

    Ok((contains_closure_protocol_hints(&development_source)
        && !contains_closure_protocol_hints(&default_source))
        || (default_path_name.contains("/production/")
            && development_path_name.contains("/development/"))
        || (looks_minified_source(&default_source) && !looks_minified_source(&development_source)))
}

fn contains_closure_protocol_hints(source: &str) -> bool {
    source.contains("JSCompiler_renameProperty(") || source.contains("@nocollapse")
}

fn looks_minified_source(source: &str) -> bool {
    let newline_count = source.bytes().filter(|byte| *byte == b'\n').count();
    let longest_line = source.lines().map(str::len).max().unwrap_or(0);
    newline_count <= 3 && longest_line > 2000
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
    if is_package_relative_target(target) {
        let normalized_target = target.strip_prefix("./").unwrap_or(target);
        let base = normalize_path(&package_dir.join(normalized_target));
        return resolve_module_base(
            &base,
            true,
            package_dir,
            &format!("package \"{package_name}\" target \"{target}\""),
            importer,
        );
    }

    Err(format!(
        "Unsupported export target \"{target}\" in package \"{package_name}\""
    ))
}

fn is_package_relative_target(target: &str) -> bool {
    !target.is_empty()
        && !target.starts_with('/')
        && !target.starts_with("../")
        && !target.contains(':')
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
        normalize_path(&package_dir.join(subpath.trim_start_matches("./")))
    };

    resolve_module_base(
        &base,
        true,
        package_dir,
        &format!("package \"{package_name}\""),
        importer,
    )
}

fn resolve_module_base(
    base: &Path,
    allow_commonjs: bool,
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

        validate_candidate(
            &candidate,
            allow_commonjs,
            allowed_root,
            description,
            importer,
        )?;
        return Ok(Some(candidate));
    }

    Ok(None)
}

fn validate_candidate(
    candidate: &Path,
    allow_commonjs: bool,
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
        "cjs" | "cts" if allow_commonjs => Ok(()),
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

fn validate_commonjs_usage(
    file_path: &Path,
    analysis: &CommonJsAnalysis,
    context: &ResolveContext,
) -> std::result::Result<(), String> {
    if !is_package_source_file(file_path, context) {
        return Err(format!(
            "CommonJS is only supported for package sources under node_modules: {}",
            file_path.to_string_lossy()
        ));
    }

    if let Some(reason) = analysis.unsupported.first() {
        return Err(format!(
            "Unsupported CommonJS pattern in {}: {}",
            file_path.to_string_lossy(),
            reason,
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
    serde_json::from_str(&contents).map_err(|error| format!("{}: {error}", path.to_string_lossy()))
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
        candidates.extend(rewrite_extension_candidates(base));
    } else {
        candidates.push(base.to_path_buf());
        for extension in [
            ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts", ".json", ".node",
        ] {
            candidates.push(PathBuf::from(format!(
                "{}{}",
                base.to_string_lossy(),
                extension
            )));
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

fn rewrite_extension_candidates(base: &Path) -> Vec<PathBuf> {
    let Some(extension) = base.extension().and_then(|value| value.to_str()) else {
        return Vec::new();
    };

    let alternates: &[&str] = match extension {
        "js" => &["ts", "tsx", "mts", "jsx", "mjs"],
        "jsx" => &["tsx", "ts", "js", "mjs"],
        "mjs" => &["mts", "ts", "js", "jsx"],
        _ => &[],
    };

    alternates
        .iter()
        .map(|alternate| base.with_extension(alternate))
        .collect()
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

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(_) | Component::Prefix(_) | Component::RootDir => {
                normalized.push(component.as_os_str());
            }
        }
    }

    normalized
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
        temp_dir.write(
            "src/index.ts",
            "import pkg from \"demo-pkg\";\nexport default pkg;\n",
        );
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
        temp_dir.write(
            "node_modules/demo-pkg/dist/features/button.js",
            "export default 1;\n",
        );

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
        temp_dir.write(
            "src/index.ts",
            "import pkg from \"demo-pkg\";\nexport default pkg;\n",
        );
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
    fn resolves_package_relative_module_field_without_dot_prefix() {
        let temp_dir = TestDir::new();
        temp_dir.write(
            "src/index.ts",
            "import pkg from \"demo-pkg\";\nexport default pkg;\n",
        );
        temp_dir.write(
            "node_modules/demo-pkg/package.json",
            r#"{"name":"demo-pkg","module":"es/index.js","main":"lib/index.js"}"#,
        );
        temp_dir.write("node_modules/demo-pkg/es/index.js", "export default 1;\n");
        temp_dir.write(
            "node_modules/demo-pkg/lib/index.js",
            "module.exports = 2;\n",
        );

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
            .any(|path| path.ends_with("node_modules/demo-pkg/es/index.js")));
    }

    #[test]
    fn tracks_package_json_hash_changes() {
        let temp_dir = TestDir::new();
        temp_dir.write(
            "src/index.ts",
            "import pkg from \"demo-pkg\";\nexport default pkg;\n",
        );
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
    fn rejects_unsupported_commonjs_package_patterns() {
        let temp_dir = TestDir::new();
        temp_dir.write(
            "src/index.ts",
            "import pkg from \"demo-pkg\";\nexport default pkg;\n",
        );
        temp_dir.write(
            "node_modules/demo-pkg/package.json",
            r#"{"name":"demo-pkg","main":"./index.cjs"}"#,
        );
        temp_dir.write(
            "node_modules/demo-pkg/index.cjs",
            "module.exports = require(name);\n",
        );

        let error = resolve_graph(
            vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            "esm-only".to_string(),
        )
        .unwrap_err();

        assert!(error.contains("Unsupported CommonJS"));
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

    #[test]
    fn resolves_js_specifier_to_ts_source() {
        let temp_dir = TestDir::new();
        temp_dir.write("src/index.ts", "export { value } from \"./support.js\";\n");
        temp_dir.write("src/support.ts", "export const value = 1;\n");

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
            .any(|path| path.ends_with("src/support.ts")));
    }
}
