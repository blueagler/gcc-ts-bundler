use super::*;

/// The one decision that the three CommonJS export-ABI emission sites share.
///
/// The ABI is written by the producer (`CommonJsRewriteVisitor`) and read at two
/// consumer sites (`CommonJsNamespaceAccessVisitor` and the named-import
/// destructure lowering). Quoting a name on one side while another side renames
/// it resolves to `undefined` at runtime, so all three read this verdict and
/// none of them decides locally.
///
/// Granularity is the package directory, not the individual file: a package's
/// export surface is assembled across its internal `require()` graph
/// (`react/index.js` -> `react/cjs/react.production.js`), and a consumer names
/// only the package. Widening a file's verdict to its package is the
/// fail-closed direction and needs no resolver.
#[derive(Debug, Default)]
pub(super) struct OpaqueCommonJs {
    package_keys: HashSet<String>,
    specifiers: HashSet<String>,
}

impl OpaqueCommonJs {
    /// Producer side: may this file's `exports.foo = …` be renameable?
    pub(super) fn file_is_opaque(&self, file_path: &Path) -> bool {
        package_key(file_path)
            .map(|key| self.package_keys.contains(&key))
            .unwrap_or(true)
    }

    /// Consumer side: may `ns.foo` on this specifier be renameable?
    pub(super) fn specifier_is_opaque(&self, specifier: &str) -> bool {
        self.specifiers.contains(specifier)
    }
}

/// Groups a file with the package that owns it. `None` for first-party sources,
/// which are never CommonJS-normalized.
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
        let Some(key) = package_key(&file_path) else {
            // First-party code still consumes CommonJS packages, so it is
            // scanned for namespace reflection below even though it owns no
            // CommonJS export surface itself.
            let module = parse_source_file(&file_path)?;
            mark_reflecting_imports(
                &module,
                commonjs_specifiers,
                &mut package_keys,
                package_aliases,
            );
            continue;
        };
        let module = parse_source_file(&file_path)?;
        let analysis = analyze_commonjs_module(&module);
        if should_normalize_commonjs(&file_path, &analysis) && analysis.exports_are_opaque {
            package_keys.insert(key);
        }
        mark_reflecting_imports(
            &module,
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

/// A module that reads an imported CommonJS namespace's keys as data pins that
/// package's whole surface.
fn mark_reflecting_imports(
    module: &Module,
    commonjs_specifiers: &HashSet<String>,
    package_keys: &mut HashSet<String>,
    package_aliases: &[PackageAliasInput],
) {
    for item in &module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import)) = item else {
            continue;
        };
        let specifier = import.src.value.to_string_lossy().to_string();
        if !commonjs_specifiers.contains(&specifier) {
            continue;
        }
        let bindings = import
            .specifiers
            .iter()
            .map(|entry| match entry {
                ImportSpecifier::Named(named) => named.local.sym.to_string(),
                ImportSpecifier::Default(default) => default.local.sym.to_string(),
                ImportSpecifier::Namespace(namespace) => namespace.local.sym.to_string(),
            })
            .collect::<std::collections::BTreeSet<_>>();
        if crate::commonjs::commonjs_namespace_is_opaque(module, &bindings) {
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
        let module = parse_module(Path::new("/tmp/probe.js"), source).unwrap();
        analyze_commonjs_module(&module)
    }

    #[test]
    fn object_keys_over_own_exports_through_module_slot_is_opaque() {
        let analysis =
            analyze("exports.alpha = 1;\nmodule.exports.names = Object.keys(exports);\n");
        assert!(analysis.exports_are_opaque);
    }

    #[test]
    fn plain_named_exports_are_transparent() {
        let analysis = analyze("exports.alpha = 1;\nmodule.exports.beta = 2;\n");
        assert!(!analysis.exports_are_opaque);
    }

    #[test]
    fn string_literal_export_keys_are_transparent() {
        let analysis = analyze("exports[\"alpha\"] = 1;\n");
        assert!(!analysis.exports_are_opaque);
    }

    #[test]
    fn proxy_reexport_is_transparent() {
        let analysis = analyze("module.exports = require(\"./inner.js\");\n");
        assert!(!analysis.exports_are_opaque);
    }

    #[test]
    fn object_keys_over_own_exports_is_opaque() {
        let analysis = analyze("exports.alpha = 1;\nvar names = Object.keys(exports);\n");
        assert!(analysis.exports_are_opaque);
    }

    #[test]
    fn for_in_over_own_exports_is_opaque() {
        let analysis =
            analyze("exports.alpha = 1;\nfor (var key in exports) { console.log(key); }\n");
        assert!(analysis.exports_are_opaque);
    }

    #[test]
    fn computed_export_read_is_opaque() {
        let analysis = analyze("exports.alpha = 1;\nfunction get(k) { return exports[k]; }\n");
        assert!(analysis.exports_are_opaque);
    }

    #[test]
    fn escaping_export_object_is_opaque() {
        let analysis = analyze("exports.alpha = 1;\nregister(module.exports);\n");
        assert!(analysis.exports_are_opaque);
    }

    #[test]
    fn umd_style_exports_probe_is_opaque() {
        let analysis = analyze("if (typeof exports === \"object\") { exports.alpha = 1; }\n");
        assert!(analysis.exports_are_opaque);
    }

    #[test]
    fn namespace_consumer_reflection_is_detected() {
        let module = parse_module(
            Path::new("/tmp/consumer.js"),
            "import * as ns from \"pkg\";\nexport const keys = Object.keys(ns);\nfor (const k in ns) { console.log(ns[k]); }\n",
        )
        .unwrap();
        let bindings = std::collections::BTreeSet::from(["ns".to_string()]);
        assert!(crate::commonjs::commonjs_namespace_is_opaque(
            &module, &bindings
        ));
    }

    #[test]
    fn namespace_consumer_static_access_is_transparent() {
        let module = parse_module(
            Path::new("/tmp/consumer.js"),
            "import * as ns from \"pkg\";\nexport const value = ns.alpha + ns[\"beta\"];\nuse(ns);\n",
        )
        .unwrap();
        let bindings = std::collections::BTreeSet::from(["ns".to_string()]);
        assert!(!crate::commonjs::commonjs_namespace_is_opaque(
            &module, &bindings
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
