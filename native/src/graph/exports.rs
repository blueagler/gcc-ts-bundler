use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::deps::parse_scanned_module;
use super::package_resolver::resolve_module_specifier;
use super::{EntryExportMetadata, ResolveContext};
use crate::commonjs::{analyze_commonjs_source, CommonJsAnalysis};
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, Expression,
    ImportDeclarationSpecifier, ImportOrExportKind, ModuleExportName, Program, Statement,
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
    let commonjs_analysis = if let Some(existing) = commonjs_cache.get(file_path) {
        existing.clone()
    } else {
        let analysis = analyze_commonjs_source(file_path, &source)?;
        commonjs_cache.insert(file_path.clone(), analysis.clone());
        analysis
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
            const_enum_export_names: Vec::new(),
            export_names: commonjs_analysis.export_names,
            has_default_export: commonjs_analysis.has_default_export,
            source_path: file_path.to_string_lossy().to_string(),
        };
        export_cache.insert(file_path.clone(), metadata.clone());
        return Ok(metadata);
    }

    let allocator = Allocator::default();
    let program = parse_scanned_module(&allocator, file_path, &source)?;
    let local_const_enums = collect_local_const_enums(&program, file_path, context)?;
    let mut export_names = BTreeSet::new();
    let mut const_enum_export_names = BTreeSet::new();
    let mut star_const_enum_export_names = BTreeSet::new();
    let mut explicit_export_names = BTreeSet::new();
    let mut has_default_export = false;

    for statement in &program.body {
        match statement {
            Statement::ExportDeclaration(export) => {
                collect_declaration_names(&export.declaration, &mut export_names);
                collect_declaration_names(&export.declaration, &mut explicit_export_names);
                if let Declaration::TSEnumDeclaration(declaration) = &export.declaration {
                    if declaration.r#const {
                        const_enum_export_names.insert(declaration.id.name.to_string());
                    }
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                for specifier in &export.specifiers {
                    if specifier.export_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    let exported_name = export_name(&specifier.exported);
                    explicit_export_names.insert(exported_name.clone());
                    if local_const_enums.contains(&export_name(&specifier.local)) {
                        const_enum_export_names.insert(exported_name.clone());
                    }
                    if exported_name == "default" {
                        has_default_export = true;
                    } else {
                        export_names.insert(exported_name);
                    }
                }
            }
            Statement::ExportFromDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(resolved) =
                    resolve_module_specifier(export.source.value.as_str(), file_path, context)?
                {
                    let target_exports =
                        collect_exports(&resolved.path, commonjs_cache, export_cache, context)?;
                    for specifier in &export.specifiers {
                        if specifier.export_kind == ImportOrExportKind::Type {
                            continue;
                        }
                        let imported_name = export_name(&specifier.local);
                        let exported_name = export_name(&specifier.exported);
                        let has_export = if imported_name == "default" {
                            target_exports.has_default_export
                        } else {
                            target_exports.export_names.contains(&imported_name)
                        };
                        if !has_export {
                            continue;
                        }
                        explicit_export_names.insert(exported_name.clone());
                        if target_exports
                            .const_enum_export_names
                            .contains(&imported_name)
                        {
                            const_enum_export_names.insert(exported_name.clone());
                        }
                        if exported_name == "default" {
                            has_default_export = true;
                        } else {
                            export_names.insert(exported_name);
                        }
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                if let Some(Expression::Identifier(identifier)) = export.declaration.as_expression()
                {
                    if local_const_enums.contains(identifier.name.as_str()) {
                        const_enum_export_names.insert("default".to_string());
                    }
                }
                if !matches!(
                    export.declaration,
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(_)
                ) {
                    has_default_export = true;
                }
            }
            Statement::TSExportAssignment(export) => {
                if let Expression::Identifier(identifier) = &export.expression {
                    if local_const_enums.contains(identifier.name.as_str()) {
                        const_enum_export_names.insert("default".to_string());
                    }
                }
                has_default_export = true;
            }
            Statement::ExportAllDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(exported) = &export.exported {
                    let name = export_name(exported);
                    explicit_export_names.insert(name.clone());
                    export_names.insert(name);
                    continue;
                }
                if let Some(resolved) =
                    resolve_module_specifier(export.source.value.as_str(), file_path, context)?
                {
                    let target_exports =
                        collect_exports(&resolved.path, commonjs_cache, export_cache, context)?;
                    export_names.extend(target_exports.export_names);
                    star_const_enum_export_names.extend(
                        target_exports
                            .const_enum_export_names
                            .into_iter()
                            .filter(|name| name != "default"),
                    );
                }
            }
            _ => {}
        }
    }

    const_enum_export_names.extend(
        star_const_enum_export_names
            .into_iter()
            .filter(|name| !explicit_export_names.contains(name)),
    );
    let metadata = EntryExportMetadata {
        const_enum_export_names: const_enum_export_names.into_iter().collect(),
        export_names: export_names.into_iter().collect(),
        has_default_export,
        source_path: file_path.to_string_lossy().to_string(),
    };
    export_cache.insert(file_path.clone(), metadata.clone());
    Ok(metadata)
}

/// Const enums remain semantic exports even when the invocation erases their
/// runtime objects. Track their owning declarations through local import aliases
/// before collecting public names; the resolver applies the compiler options.
fn collect_local_const_enums(
    program: &Program<'_>,
    file_path: &Path,
    context: &ResolveContext,
) -> std::result::Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    let mut exported_locals = BTreeSet::new();
    for statement in &program.body {
        match statement {
            Statement::TSEnumDeclaration(declaration) if declaration.r#const => {
                names.insert(declaration.id.name.to_string());
            }
            Statement::ExportDeclaration(export) => {
                if let Declaration::TSEnumDeclaration(declaration) = &export.declaration {
                    if declaration.r#const {
                        names.insert(declaration.id.name.to_string());
                    }
                }
            }
            Statement::ExportNamedDeclaration(export)
                if export.export_kind != ImportOrExportKind::Type =>
            {
                for specifier in &export.specifiers {
                    if specifier.export_kind != ImportOrExportKind::Type {
                        exported_locals.insert(export_name(&specifier.local));
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                if let Some(Expression::Identifier(identifier)) = export.declaration.as_expression()
                {
                    exported_locals.insert(identifier.name.to_string());
                }
            }
            Statement::TSExportAssignment(export) => {
                if let Expression::Identifier(identifier) = &export.expression {
                    exported_locals.insert(identifier.name.to_string());
                }
            }
            _ => {}
        }
    }
    if exported_locals.is_empty() {
        return Ok(names);
    }
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let aliases = import
            .specifiers
            .iter()
            .flatten()
            .filter_map(|specifier| match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named)
                    if named.import_kind != ImportOrExportKind::Type
                        && exported_locals.contains(named.local.name.as_str()) =>
                {
                    Some((named.local.name.as_str(), export_name(&named.imported)))
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default)
                    if exported_locals.contains(default.local.name.as_str()) =>
                {
                    Some((default.local.name.as_str(), "default".to_string()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        if aliases.is_empty() {
            continue;
        }
        if let Some(resolved) =
            resolve_module_specifier(import.source.value.as_str(), file_path, context)?
        {
            for (local, imported) in aliases {
                if is_const_enum_export(&resolved.path, &imported, context, &mut HashSet::new())? {
                    names.insert(local.to_string());
                }
            }
        }
    }
    Ok(names)
}

/// Follow the selected binding rather than collecting every export of an
/// imported module. Ordinary import cycles may re-export unrelated names;
/// only a cycle in this exact alias chain means there is no enum declaration.
fn is_const_enum_export(
    file_path: &Path,
    name: &str,
    context: &ResolveContext,
    visiting: &mut HashSet<(PathBuf, String)>,
) -> std::result::Result<bool, String> {
    let key = (file_path.to_path_buf(), name.to_string());
    if !visiting.insert(key.clone()) {
        return Ok(false);
    }
    let source = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    let allocator = Allocator::default();
    let program = parse_scanned_module(&allocator, file_path, &source)?;
    let mut local = None;
    let mut forwarded = None;
    let mut explicit = false;
    for statement in &program.body {
        match statement {
            Statement::ExportDeclaration(export) => {
                let mut declared = BTreeSet::new();
                collect_declaration_names(&export.declaration, &mut declared);
                if declared.contains(name) {
                    local = Some(name.to_string());
                    explicit = true;
                    break;
                }
            }
            Statement::ExportNamedDeclaration(export)
                if export.export_kind != ImportOrExportKind::Type =>
            {
                if let Some(specifier) = export.specifiers.iter().find(|specifier| {
                    specifier.export_kind != ImportOrExportKind::Type
                        && export_name(&specifier.exported) == name
                }) {
                    local = Some(export_name(&specifier.local));
                    explicit = true;
                    break;
                }
            }
            Statement::ExportFromDeclaration(export)
                if export.export_kind != ImportOrExportKind::Type =>
            {
                if let Some(specifier) = export.specifiers.iter().find(|specifier| {
                    specifier.export_kind != ImportOrExportKind::Type
                        && export_name(&specifier.exported) == name
                }) {
                    forwarded = Some((export.source.value.as_str(), export_name(&specifier.local)));
                    explicit = true;
                    break;
                }
            }
            Statement::ExportDefaultDeclaration(export) if name == "default" => {
                if let Some(Expression::Identifier(identifier)) = export.declaration.as_expression()
                {
                    local = Some(identifier.name.to_string());
                }
                explicit = true;
                break;
            }
            Statement::TSExportAssignment(export) if name == "default" => {
                if let Expression::Identifier(identifier) = &export.expression {
                    local = Some(identifier.name.to_string());
                }
                explicit = true;
                break;
            }
            Statement::ExportAllDeclaration(export)
                if export
                    .exported
                    .as_ref()
                    .is_some_and(|exported| export_name(exported) == name) =>
            {
                explicit = true;
                break;
            }
            _ => {}
        }
    }
    let mut is_const = false;
    if let Some(local) = local {
        for statement in &program.body {
            match statement {
                Statement::TSEnumDeclaration(declaration) => {
                    is_const |= declaration.r#const && declaration.id.name.as_str() == local;
                }
                Statement::ExportDeclaration(export) => {
                    if let Declaration::TSEnumDeclaration(declaration) = &export.declaration {
                        is_const |= declaration.r#const && declaration.id.name.as_str() == local;
                    }
                }
                Statement::ImportDeclaration(import)
                    if import.import_kind != ImportOrExportKind::Type =>
                {
                    for specifier in import.specifiers.iter().flatten() {
                        let imported = match specifier {
                            ImportDeclarationSpecifier::ImportSpecifier(named)
                                if named.import_kind != ImportOrExportKind::Type
                                    && named.local.name.as_str() == local =>
                            {
                                export_name(&named.imported)
                            }
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(default)
                                if default.local.name.as_str() == local =>
                            {
                                "default".to_string()
                            }
                            _ => continue,
                        };
                        forwarded = Some((import.source.value.as_str(), imported));
                    }
                }
                _ => {}
            }
        }
    }
    if let Some((source, imported)) = forwarded {
        if let Some(resolved) = resolve_module_specifier(source, file_path, context)? {
            is_const = is_const_enum_export(&resolved.path, &imported, context, visiting)?;
        }
    } else if !explicit && name != "default" {
        for statement in &program.body {
            if let Statement::ExportAllDeclaration(export) = statement {
                if export.export_kind == ImportOrExportKind::Type || export.exported.is_some() {
                    continue;
                }
                if let Some(resolved) =
                    resolve_module_specifier(export.source.value.as_str(), file_path, context)?
                {
                    if is_const_enum_export(&resolved.path, name, context, visiting)? {
                        is_const = true;
                        break;
                    }
                }
            }
        }
    }
    visiting.remove(&key);
    Ok(is_const)
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
        Declaration::TSNamespaceDeclaration(declaration) => {
            names.insert(declaration.id.name.to_string());
        }
        Declaration::TSTypeAliasDeclaration(_)
        | Declaration::TSInterfaceDeclaration(_)
        | Declaration::TSExternalModuleDeclaration(_)
        | Declaration::TSGlobalDeclaration(_)
        | Declaration::TSImportEqualsDeclaration(_) => {}
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
