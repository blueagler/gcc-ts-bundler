#![allow(non_snake_case)]

//! The pinned Closure Compiler's syntax contract.
//!
//! Closure is the middle-end in an Oxc envelope. Keep every syntax decision
//! that crosses that boundary here so a compiler bump changes one table, and
//! `test/closure-capabilities.test.mjs` proves the new table against its jar.

#[derive(Clone, Copy, Debug)]
pub(crate) struct ClosureCompilerCapabilities {
    pub compiler_version: &'static str,
    pub private_class_elements: bool,
    pub class_static_blocks: bool,
    pub top_level_await: bool,
    pub prebundle_target: &'static str,
    pub printer_modernization: &'static str,
}

pub(crate) const CLOSURE_COMPILER_CAPABILITIES: ClosureCompilerCapabilities =
    ClosureCompilerCapabilities {
        compiler_version: "20260726.0.0",
        // Probed directly by test/closure-capabilities.test.mjs with
        // --compilation_level WHITESPACE_ONLY --language_in UNSTABLE.
        private_class_elements: false,
        class_static_blocks: true,
        top_level_await: false,
        // This remains ES2021 until the envelope itself changes. It is not a
        // claim that every newer syntax is unsupported.
        prebundle_target: "es2021",
        // Closure optimizes; the Oxc finishing pass modernizes final printing.
        printer_modernization: "Oxc finishing pass",
    };

#[napi_derive::napi(object)]
pub struct ClosureCompilerCapabilitiesOutput {
    pub classStaticBlocks: bool,
    pub compilerVersion: String,
    pub prebundleTarget: String,
    pub privateClassElements: bool,
    pub printerModernization: String,
    pub topLevelAwait: bool,
}

pub(crate) fn closure_compiler_capabilities() -> ClosureCompilerCapabilitiesOutput {
    let capabilities = CLOSURE_COMPILER_CAPABILITIES;
    ClosureCompilerCapabilitiesOutput {
        classStaticBlocks: capabilities.class_static_blocks,
        compilerVersion: capabilities.compiler_version.to_string(),
        prebundleTarget: capabilities.prebundle_target.to_string(),
        privateClassElements: capabilities.private_class_elements,
        printerModernization: capabilities.printer_modernization.to_string(),
        topLevelAwait: capabilities.top_level_await,
    }
}

#[derive(Clone, Copy)]
struct ViteEngineLanguageMinimum {
    version: f64,
    language_out: &'static str,
}

const CHROME_LANGUAGE_MINIMUMS: &[ViteEngineLanguageMinimum] = &[
    ViteEngineLanguageMinimum {
        version: 85.0,
        language_out: "ECMASCRIPT_2021",
    },
    ViteEngineLanguageMinimum {
        version: 80.0,
        language_out: "ECMASCRIPT_2020",
    },
    ViteEngineLanguageMinimum {
        version: 66.0,
        language_out: "ECMASCRIPT_2019",
    },
    ViteEngineLanguageMinimum {
        version: 64.0,
        language_out: "ECMASCRIPT_2018",
    },
    ViteEngineLanguageMinimum {
        version: 55.0,
        language_out: "ECMASCRIPT_2017",
    },
    ViteEngineLanguageMinimum {
        version: 52.0,
        language_out: "ECMASCRIPT_2016",
    },
    ViteEngineLanguageMinimum {
        version: 51.0,
        language_out: "ECMASCRIPT_2015",
    },
];

const FIREFOX_LANGUAGE_MINIMUMS: &[ViteEngineLanguageMinimum] = &[
    ViteEngineLanguageMinimum {
        version: 79.0,
        language_out: "ECMASCRIPT_2021",
    },
    ViteEngineLanguageMinimum {
        version: 78.0,
        language_out: "ECMASCRIPT_2020",
    },
    ViteEngineLanguageMinimum {
        version: 78.0,
        language_out: "ECMASCRIPT_2019",
    },
    ViteEngineLanguageMinimum {
        version: 78.0,
        language_out: "ECMASCRIPT_2018",
    },
    ViteEngineLanguageMinimum {
        version: 52.0,
        language_out: "ECMASCRIPT_2017",
    },
    ViteEngineLanguageMinimum {
        version: 52.0,
        language_out: "ECMASCRIPT_2016",
    },
    ViteEngineLanguageMinimum {
        version: 54.0,
        language_out: "ECMASCRIPT_2015",
    },
];

const SAFARI_LANGUAGE_MINIMUMS: &[ViteEngineLanguageMinimum] = &[
    ViteEngineLanguageMinimum {
        version: 14.0,
        language_out: "ECMASCRIPT_2021",
    },
    ViteEngineLanguageMinimum {
        version: 13.1,
        language_out: "ECMASCRIPT_2020",
    },
    ViteEngineLanguageMinimum {
        version: 11.1,
        language_out: "ECMASCRIPT_2019",
    },
    ViteEngineLanguageMinimum {
        version: 11.1,
        language_out: "ECMASCRIPT_2018",
    },
    ViteEngineLanguageMinimum {
        version: 11.0,
        language_out: "ECMASCRIPT_2017",
    },
    ViteEngineLanguageMinimum {
        version: 10.1,
        language_out: "ECMASCRIPT_2016",
    },
    ViteEngineLanguageMinimum {
        version: 10.0,
        language_out: "ECMASCRIPT_2015",
    },
];

const NODE_LANGUAGE_MINIMUMS: &[ViteEngineLanguageMinimum] = &[
    ViteEngineLanguageMinimum {
        version: 15.0,
        language_out: "ECMASCRIPT_2021",
    },
    ViteEngineLanguageMinimum {
        version: 14.0,
        language_out: "ECMASCRIPT_2020",
    },
    ViteEngineLanguageMinimum {
        version: 10.0,
        language_out: "ECMASCRIPT_2019",
    },
    ViteEngineLanguageMinimum {
        version: 10.0,
        language_out: "ECMASCRIPT_2018",
    },
    ViteEngineLanguageMinimum {
        version: 8.0,
        language_out: "ECMASCRIPT_2017",
    },
    ViteEngineLanguageMinimum {
        version: 7.0,
        language_out: "ECMASCRIPT_2016",
    },
    ViteEngineLanguageMinimum {
        version: 6.0,
        language_out: "ECMASCRIPT_2015",
    },
];

fn engine_language_out(version: f64, minimums: &[ViteEngineLanguageMinimum]) -> &'static str {
    minimums
        .iter()
        .find(|minimum| version >= minimum.version)
        .map_or("ECMASCRIPT5", |minimum| minimum.language_out)
}

pub(crate) fn resolve_vite_target_language_out(target: &str) -> Option<&'static str> {
    let normalized = target.trim().to_ascii_lowercase().replace([' ', '_'], "");
    match normalized.as_str() {
        "baseline-widely-available" => return Some("ECMASCRIPT_2021"),
        "esnext" => return Some("ECMASCRIPT_NEXT"),
        "es3" => return Some("ECMASCRIPT3"),
        "es5" => return Some("ECMASCRIPT5"),
        "es6" => return Some("ECMASCRIPT_2015"),
        _ => {}
    }
    if let Some(year) = normalized.strip_prefix("es20") {
        let year = 2000 + year.parse::<u16>().ok()?;
        return match year {
            2015..=2021 => Some(match year {
                2015 => "ECMASCRIPT_2015",
                2016 => "ECMASCRIPT_2016",
                2017 => "ECMASCRIPT_2017",
                2018 => "ECMASCRIPT_2018",
                2019 => "ECMASCRIPT_2019",
                2020 => "ECMASCRIPT_2020",
                2021 => "ECMASCRIPT_2021",
                _ => unreachable!(),
            }),
            2022.. => Some("STABLE"),
            _ => None,
        };
    }

    for (engine, minimums) in [
        ("chrome", CHROME_LANGUAGE_MINIMUMS),
        ("edge", CHROME_LANGUAGE_MINIMUMS),
        ("firefox", FIREFOX_LANGUAGE_MINIMUMS),
        ("iossaf", SAFARI_LANGUAGE_MINIMUMS),
        ("ios", SAFARI_LANGUAGE_MINIMUMS),
        ("safari", SAFARI_LANGUAGE_MINIMUMS),
        ("node", NODE_LANGUAGE_MINIMUMS),
    ] {
        if let Some(version) = normalized.strip_prefix(engine) {
            let version = version.trim_start_matches(['>', '=']).parse().ok()?;
            return Some(engine_language_out(version, minimums));
        }
    }
    if normalized.starts_with("ie") {
        normalized.strip_prefix("ie")?.parse::<f64>().ok()?;
        return Some("ECMASCRIPT5");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::resolve_vite_target_language_out;

    #[test]
    fn maps_vite_targets_to_their_closure_language_level() {
        for (target, expected) in [
            ("es2015", "ECMASCRIPT_2015"),
            ("es2018", "ECMASCRIPT_2018"),
            ("es2020", "ECMASCRIPT_2020"),
            ("es2022", "STABLE"),
            ("esnext", "ECMASCRIPT_NEXT"),
            ("chrome64", "ECMASCRIPT_2018"),
            ("chrome87", "ECMASCRIPT_2021"),
            ("firefox 78", "ECMASCRIPT_2020"),
            ("safari >= 13.1", "ECMASCRIPT_2020"),
            ("ie11", "ECMASCRIPT5"),
        ] {
            assert_eq!(resolve_vite_target_language_out(target), Some(expected));
        }
        assert_eq!(resolve_vite_target_language_out("last 2 versions"), None);
    }
}
