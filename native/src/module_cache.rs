//! The parse core: every AST this crate's transpile pipeline sees is produced
//! here.
//!
//! # Two entry points, deliberately named apart
//!
//! * [`parse_source_file`] — a real file on disk, read and parsed. Used by the
//!   main pipeline and by the cross-module reads (`enums`, `emit_goog`'s live
//!   exports, `externs::analysis`, `cjs_opacity`, `context`'s export slots).
//! * [`parse_module`] — a string this crate *generated* (a runtime helper, a
//!   compat snippet, a metadata template). The path argument is a label for
//!   error messages, not a file.
//!
//! They are separate because they diverge in the oxc port: a generated snippet
//! is parsed to be spliced into the module being emitted, so it must be on the
//! same AST stack as the emitter, whereas an analysis-only read of another file
//! returns facts (values, names, booleans) and can move stacks on its own. That
//! is the same property that made the three islands portable in isolation
//! (`/tmp/gcc-oxb-islands.md`) and it is what the port can exploit next; see
//! `/tmp/gcc-oxd1.md` for the site-by-site taxonomy.
//!
//! # Why there is no cache here any more
//!
//! There used to be a process-global `HashMap<String, Module>`, keyed by path and
//! validated against `(len, mtime)`, holding owned swc `Module` values across
//! napi invocations. It cannot survive the port: an oxc `Program<'a>` borrows its
//! arena `Allocator`, so caching one means either a self-referential
//! `(Allocator, Program)` per entry or no cache at all, and the O1 report picks
//! re-parsing as the honest answer (`/tmp/gcc-o1-oxc.md` §3).
//!
//! Measured before removing it, it was also not buying what its name implied:
//! every hit returned `module.clone()`, a deep clone of the whole AST, which for
//! our module sizes costs about what parsing again costs. The measurements are in
//! `/tmp/gcc-oxd1.md`; the short version is that a full in-process rebuild loop
//! moved inside noise and an incremental one did not move at all.

use std::path::Path;

use swc_core::common::{sync::Lrc, FileName, SourceMap};
use swc_core::ecma::ast::Module;
use swc_core::ecma::parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax, TsSyntax};

/// Parses source text this crate generated, or text a caller already holds.
///
/// `file_path` selects the syntax (and labels errors); it does not have to exist.
pub fn parse_module(file_path: &Path, source: &str) -> std::result::Result<Module, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(
        FileName::Real(file_path.to_path_buf()).into(),
        source.to_string(),
    );
    let syntax = match file_path.extension().and_then(|ext| ext.to_str()) {
        Some("ts") | Some("mts") | Some("d.ts") => Syntax::Typescript(TsSyntax {
            tsx: false,
            decorators: true,
            dts: file_path.to_string_lossy().ends_with(".d.ts"),
            ..Default::default()
        }),
        Some("tsx") => Syntax::Typescript(TsSyntax {
            tsx: true,
            decorators: true,
            ..Default::default()
        }),
        _ => Syntax::Es(EsSyntax {
            jsx: matches!(
                file_path.extension().and_then(|ext| ext.to_str()),
                Some("jsx")
            ),
            ..Default::default()
        }),
    };

    let lexer = Lexer::new(syntax, Default::default(), StringInput::from(&*fm), None);
    let mut parser = Parser::new_from(lexer);
    parser
        .parse_module()
        .map_err(|error| format!("{}: {}", file_path.to_string_lossy(), error.kind().msg()))
}

/// Reads and parses a file on disk.
///
/// Every call re-reads and re-parses. That is the point: see the module docs.
pub fn parse_source_file(file_path: &Path) -> std::result::Result<Module, String> {
    let source = std::fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    parse_module(file_path, &source)
}
