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
