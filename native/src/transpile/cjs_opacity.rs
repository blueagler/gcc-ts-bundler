use super::{should_normalize_commonjs, BTreeSet, HashSet, PackageAliasInput, Path};
#[cfg(test)]
use oxc_allocator::Allocator;
use oxc_ast::ast::{ImportDeclarationSpecifier, Program, Statement};
#[cfg(test)]
use oxc_parser::Parser;
#[cfg(test)]
use oxc_span::SourceType;

/// The one decision shared by the three CommonJS export-ABI emission sites.
#[derive(Debug, Default)]
pub(crate) struct OpaqueCommonJs {
    package_keys: HashSet<String>,
    specifiers: HashSet<String>,
}

impl OpaqueCommonJs {
    pub(super) fn file_is_opaque(&self, file_path: &Path) -> bool {
        package_key(file_path).is_none_or(|key| self.package_keys.contains(&key))
    }

    pub(super) fn specifier_is_opaque(&self, specifier: &str) -> bool {
        self.specifiers.contains(specifier)
    }
}

fn package_key(file_path: &Path) -> Option<String> {
    let text = file_path.to_string_lossy().replace('\\', "/");
    let (_, tail) = text.rsplit_once("/node_modules/")?;
    let mut segments = tail.split('/');
    let first = segments.next()?;
    let name = if first.starts_with('@') {
        format!("{first}/{}", segments.next()?)
    } else {
        first.to_string()
    };
    let head = &text[..text.len() - tail.len()];
    Some(format!("{head}{name}"))
}

/// Package keys this already-parsed file marks opaque (own CJS surface or a
/// reflecting import of a CommonJS namespace).
pub(crate) fn collect_opaque_package_keys_from_program(
    program: &Program<'_>,
    file_path: &Path,
    commonjs_specifiers: &HashSet<String>,
    package_aliases: &[PackageAliasInput],
) -> HashSet<String> {
    let mut package_keys = HashSet::new();
    if let Some(key) = package_key(file_path) {
        let analysis = crate::commonjs::analyze_commonjs_program(program);
        if should_normalize_commonjs(file_path, &analysis) && analysis.exports_are_opaque {
            package_keys.insert(key);
        }
    }
    mark_reflecting_imports(
        program,
        commonjs_specifiers,
        &mut package_keys,
        package_aliases,
    );
    package_keys
}

/// Rebuilds the CommonJS opacity decision from the union of per-file keys.
pub(crate) fn opaque_commonjs_from_package_keys(
    package_keys: HashSet<String>,
    commonjs_specifiers: &HashSet<String>,
    package_aliases: &[PackageAliasInput],
) -> OpaqueCommonJs {
    let specifiers = commonjs_specifiers
        .iter()
        .filter(|specifier| {
            specifier_package_key(specifier, package_aliases)
                .is_none_or(|key| package_keys.contains(&key))
        })
        .cloned()
        .collect();
    OpaqueCommonJs {
        package_keys,
        specifiers,
    }
}

#[cfg(test)]
fn parse_program<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    source: &'a str,
) -> Result<Program<'a>, String> {
    let source_type = SourceType::from_path(file_path)
        .unwrap_or_else(|_| SourceType::mjs())
        .with_module(true);
    let parsed = Parser::new(allocator, source, source_type).parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(format!("{}: {}", file_path.display(), error.message));
    }
    Ok(parsed.program)
}

/// A module that reads an imported CommonJS namespace's keys as data pins that
/// package's whole surface.
fn mark_reflecting_imports(
    program: &Program<'_>,
    commonjs_specifiers: &HashSet<String>,
    package_keys: &mut HashSet<String>,
    package_aliases: &[PackageAliasInput],
) {
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        let specifier = import.source.value.to_string();
        if !commonjs_specifiers.contains(&specifier) {
            continue;
        }
        let bindings = import
            .specifiers
            .iter()
            .flatten()
            .map(|specifier| match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                    specifier.local.name.to_string()
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                    specifier.local.name.to_string()
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                    specifier.local.name.to_string()
                }
            })
            .collect::<BTreeSet<_>>();
        if crate::commonjs::commonjs_namespace_is_opaque(program, &bindings) {
            if let Some(key) = specifier_package_key(&specifier, package_aliases) {
                package_keys.insert(key);
            }
        }
    }
}

fn specifier_package_key(specifier: &str, package_aliases: &[PackageAliasInput]) -> Option<String> {
    package_aliases
        .iter()
        .find(|alias| {
            let full = if alias.subpath == "." {
                alias.package_name.clone()
            } else {
                format!(
                    "{}/{}",
                    alias.package_name,
                    alias.subpath.trim_start_matches("./")
                )
            };
            full == specifier
        })
        .and_then(|alias| package_key(Path::new(&alias.target_path)))
}

#[cfg(test)]
mod tests {
    use super::{package_key, parse_program, Allocator, BTreeSet, Path};

    fn analyze(source: &str) -> Result<crate::commonjs::CommonJsAnalysis, String> {
        crate::commonjs::analyze_commonjs_source(Path::new("/tmp/probe.js"), source)
    }

    fn namespace_is_opaque(source: &str) -> Result<bool, String> {
        let allocator = Allocator::default();
        let program = parse_program(&allocator, Path::new("/tmp/consumer.js"), source)?;
        Ok(crate::commonjs::commonjs_namespace_is_opaque(
            &program,
            &BTreeSet::from(["ns".to_string()]),
        ))
    }

    #[test]
    fn own_export_reflection_is_fail_closed() -> Result<(), String> {
        assert!(
            analyze("exports.alpha = 1;\nmodule.exports.names = Object.keys(exports);\n")?
                .exports_are_opaque
        );
        assert!(!analyze("exports.alpha = 1;\nmodule.exports.beta = 2;\n")?.exports_are_opaque);
        assert!(!analyze("exports[\"alpha\"] = 1;\n")?.exports_are_opaque);
        assert!(!analyze("module.exports = require(\"./inner.js\");\n")?.exports_are_opaque);
        assert!(analyze("exports.alpha = 1;\nfor (var key in exports) {}\n")?.exports_are_opaque);
        assert!(
            analyze("exports.alpha = 1;\nfunction get(k) { return exports[k]; }\n")?
                .exports_are_opaque
        );
        assert!(analyze("exports.alpha = 1;\nregister(module.exports);\n")?.exports_are_opaque);
        assert!(
            analyze("if (typeof exports === \"object\") { exports.alpha = 1; }\n")?
                .exports_are_opaque
        );
        Ok(())
    }

    #[test]
    fn namespace_consumer_reflection_is_detected() -> Result<(), String> {
        assert!(namespace_is_opaque(
            "import * as ns from \"pkg\";\nObject.keys(ns);\nfor (const k in ns) {}\n"
        )?);
        assert!(!namespace_is_opaque(
            "import * as ns from \"pkg\";\nns.alpha; ns[\"beta\"]; use(ns);\n"
        )?);
        Ok(())
    }

    #[test]
    fn package_key_groups_files_by_owning_package() {
        assert_eq!(
            package_key(Path::new("/w/node_modules/react/cjs/react.production.js")),
            Some("/w/node_modules/react".to_string())
        );
        assert_eq!(
            package_key(Path::new("/w/node_modules/@tanstack/store/dist/index.js")),
            Some("/w/node_modules/@tanstack/store".to_string())
        );
        assert_eq!(package_key(Path::new("/w/src/main.ts")), None);
    }
}
