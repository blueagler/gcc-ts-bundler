use super::*;
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, ImportOrExportKind,
    ModuleExportName, Statement,
};

pub(super) fn collect_exports(
    file_path: &PathBuf,
    commonjs_cache: &mut HashMap<PathBuf, CommonJsAnalysis>,
    export_cache: &mut HashMap<PathBuf, EntryExportMetadata>,
    context: &ResolveContext,
) -> std::result::Result<EntryExportMetadata, String> {
    if let Some(existing) = export_cache.get(file_path) {
        return Ok(existing.clone());
    }

    let source = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    let commonjs_analysis = match commonjs_cache.get(file_path) {
        Some(existing) => existing.clone(),
        None => {
            let analysis = analyze_commonjs_source(file_path, &source)?;
            commonjs_cache.insert(file_path.clone(), analysis.clone());
            analysis
        }
    };
    if commonjs_analysis.has_commonjs {
        if let Some(specifier) = commonjs_analysis.proxy_export {
            if let Some(resolved) = resolve_module_specifier(&specifier, file_path, context)? {
                let metadata =
                    collect_exports(&resolved.path, commonjs_cache, export_cache, context)?;
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

    let allocator = Allocator::default();
    let program = parse_scanned_module(&allocator, file_path, &source)?;
    let mut export_names = BTreeSet::new();
    let mut has_default_export = false;

    for statement in &program.body {
        match statement {
            Statement::ExportNamedDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = &export.declaration {
                    collect_declaration_names(declaration, &mut export_names);
                }
                if let Some(source) = &export.source {
                    if let Some(resolved) =
                        resolve_module_specifier(source.value.as_str(), file_path, context)?
                    {
                        let target_exports =
                            collect_exports(&resolved.path, commonjs_cache, export_cache, context)?;
                        for specifier in &export.specifiers {
                            if specifier.export_kind == ImportOrExportKind::Type {
                                continue;
                            }
                            let exported_name = export_name(&specifier.exported);
                            if exported_name == "default" {
                                if target_exports.hasDefaultExport {
                                    has_default_export = true;
                                }
                            } else {
                                export_names.insert(exported_name);
                            }
                        }
                    }
                } else {
                    for specifier in &export.specifiers {
                        if specifier.export_kind == ImportOrExportKind::Type {
                            continue;
                        }
                        let exported_name = export_name(&specifier.exported);
                        if exported_name == "default" {
                            has_default_export = true;
                        } else {
                            export_names.insert(exported_name);
                        }
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                if !matches!(
                    export.declaration,
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(_)
                ) {
                    has_default_export = true;
                }
            }
            Statement::TSExportAssignment(_) => {
                has_default_export = true;
            }
            Statement::ExportAllDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(exported) = &export.exported {
                    export_names.insert(export_name(exported));
                    continue;
                }
                if let Some(resolved) =
                    resolve_module_specifier(export.source.value.as_str(), file_path, context)?
                {
                    let target_exports =
                        collect_exports(&resolved.path, commonjs_cache, export_cache, context)?;
                    export_names.extend(target_exports.exportNames);
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

fn collect_declaration_names(declaration: &Declaration<'_>, names: &mut BTreeSet<String>) {
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            for declarator in &declaration.declarations {
                collect_pattern_names(&declarator.id, names);
            }
        }
        Declaration::FunctionDeclaration(declaration) => {
            if let Some(id) = &declaration.id {
                names.insert(id.name.to_string());
            }
        }
        Declaration::ClassDeclaration(declaration) => {
            if let Some(id) = &declaration.id {
                names.insert(id.name.to_string());
            }
        }
        Declaration::TSEnumDeclaration(declaration) => {
            names.insert(declaration.id.name.to_string());
        }
        Declaration::TSModuleDeclaration(declaration) => {
            if let oxc_ast::ast::TSModuleDeclarationName::Identifier(id) = &declaration.id {
                names.insert(id.name.to_string());
            }
        }
        _ => {}
    }
}

fn collect_pattern_names(pattern: &BindingPattern<'_>, names: &mut BTreeSet<String>) {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => {
            names.insert(identifier.name.to_string());
        }
        BindingPattern::ArrayPattern(array) => {
            for pattern in array.elements.iter().flatten() {
                collect_pattern_names(pattern, names);
            }
            if let Some(rest) = &array.rest {
                collect_pattern_names(&rest.argument, names);
            }
        }
        BindingPattern::ObjectPattern(object) => {
            for property in &object.properties {
                collect_pattern_names(&property.value, names);
            }
            if let Some(rest) = &object.rest {
                collect_pattern_names(&rest.argument, names);
            }
        }
        BindingPattern::AssignmentPattern(assignment) => {
            collect_pattern_names(&assignment.left, names);
        }
    }
}

fn export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}
