use super::*;
use oxc_allocator::Allocator;
use oxc_ast::ast::{ImportDeclarationSpecifier, Program, Statement};
use oxc_parser::Parser;
use oxc_span::SourceType;

/// The one decision shared by the three CommonJS export-ABI emission sites.
#[derive(Debug, Default)]
pub(super) struct OpaqueCommonJs {
    package_keys: HashSet<String>,
    specifiers: HashSet<String>,
}

impl OpaqueCommonJs {
    pub(super) fn file_is_opaque(&self, file_path: &Path) -> bool {
        package_key(file_path)
            .map(|key| self.package_keys.contains(&key))
            .unwrap_or(true)
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

pub(super) fn collect_opaque_commonjs(
    file_names: &[String],
    commonjs_specifiers: &HashSet<String>,
    package_aliases: &[PackageAliasInput],
) -> std::result::Result<OpaqueCommonJs, String> {
    let mut package_keys = HashSet::new();

    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        let source = fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
        let allocator = Allocator::default();
        let program = parse_program(&allocator, &file_path, &source)?;
        if let Some(key) = package_key(&file_path) {
            let analysis = crate::commonjs::analyze_commonjs_program(&program);
            if should_normalize_commonjs(&file_path, &analysis) && analysis.exports_are_opaque {
                package_keys.insert(key);
            }
        }
        mark_reflecting_imports(
            &program,
            commonjs_specifiers,
            &mut package_keys,
            package_aliases,
        );
    }

    let specifiers = commonjs_specifiers
        .iter()
        .filter(|specifier| {
            specifier_package_key(specifier, package_aliases)
                .map(|key| package_keys.contains(&key))
                .unwrap_or(true)
        })
        .cloned()
        .collect();

    Ok(OpaqueCommonJs {
        package_keys,
        specifiers,
    })
}

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
                alias.packageName.clone()
            } else {
                format!(
                    "{}/{}",
                    alias.packageName,
                    alias.subpath.trim_start_matches("./")
                )
            };
            full == specifier
        })
        .and_then(|alias| package_key(Path::new(&alias.targetPath)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analyze(source: &str) -> crate::commonjs::CommonJsAnalysis {
        crate::commonjs::analyze_commonjs_source(Path::new("/tmp/probe.js"), source).unwrap()
    }

    fn namespace_is_opaque(source: &str) -> bool {
        let allocator = Allocator::default();
        let program = parse_program(&allocator, Path::new("/tmp/consumer.js"), source).unwrap();
        crate::commonjs::commonjs_namespace_is_opaque(&program, &BTreeSet::from(["ns".to_string()]))
    }

    #[test]
    fn own_export_reflection_is_fail_closed() {
        assert!(
            analyze("exports.alpha = 1;\nmodule.exports.names = Object.keys(exports);\n")
                .exports_are_opaque
        );
        assert!(!analyze("exports.alpha = 1;\nmodule.exports.beta = 2;\n").exports_are_opaque);
        assert!(!analyze("exports[\"alpha\"] = 1;\n").exports_are_opaque);
        assert!(!analyze("module.exports = require(\"./inner.js\");\n").exports_are_opaque);
        assert!(analyze("exports.alpha = 1;\nfor (var key in exports) {}\n").exports_are_opaque);
        assert!(
            analyze("exports.alpha = 1;\nfunction get(k) { return exports[k]; }\n")
                .exports_are_opaque
        );
        assert!(analyze("exports.alpha = 1;\nregister(module.exports);\n").exports_are_opaque);
        assert!(
            analyze("if (typeof exports === \"object\") { exports.alpha = 1; }\n")
                .exports_are_opaque
        );
    }

    #[test]
    fn namespace_consumer_reflection_is_detected() {
        assert!(namespace_is_opaque(
            "import * as ns from \"pkg\";\nObject.keys(ns);\nfor (const k in ns) {}\n"
        ));
        assert!(!namespace_is_opaque(
            "import * as ns from \"pkg\";\nns.alpha; ns[\"beta\"]; use(ns);\n"
        ));
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
