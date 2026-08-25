// M3 groundwork: the comments policy that replaces `pure_calls.rs`
//
// swc has no comment store, so nothing a source file wrote could ever reach
// Closure — and `pure_calls.rs` exists only to recover the one comment that
// carries meaning, by *scanning the source text* for `/*#__PURE__*/` and
// re-attaching an equivalent annotation after the fact.
//
// oxc preserves comments, which turns that from a workaround into a hazard: a
// source `@const`, `@type` cast, `@license` or `@suppress` forwarded into a
// goog.module is read by Closure as a real annotation and silently changes type
// checking, renaming and output preservation (OX-A risk 5). The policy is
// therefore explicit and closed: **drop every comment except the PURE
// annotation**, which is the one this pipeline actually needs.
//
// With the annotation surviving codegen natively, `pure_calls.rs`'s text scan
// has nothing left to do.

#[cfg(test)]
use oxc_codegen::Codegen;
#[cfg(test)]
use oxc_span::SourceType;

pub(crate) fn closure_input_codegen_options() -> oxc_codegen::CodegenOptions {
    oxc_codegen::CodegenOptions {
        comments: oxc_codegen::CommentOptions {
            // Prose, and anything Closure would mistake for an annotation.
            normal: false,
            // The hostile set: `@const`, `@type`, `@nocollapse`, `@suppress`.
            jsdoc: false,
            // `/*#__PURE__*/` -- the allowed one.
            annotation: true,
            // `@license`/`@preserve` must not pin dead text into the bundle.
            legal: oxc_codegen::LegalComment::None,
        },
        ..oxc_codegen::CodegenOptions::default()
    }
}

#[cfg(test)]
mod comments_policy {
    use super::*;

    fn emit(source: &str) -> String {
        let allocator = oxc_allocator::Allocator::default();
        let parsed = oxc_parser::Parser::new(&allocator, source, SourceType::ts()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        Codegen::new()
            .with_options(closure_input_codegen_options())
            .build(&parsed.program)
            .code
    }

    /// The OX-A risk-5 fixture: every hostile annotation must be gone.
    #[test]
    fn hostile_jsdoc_never_survives_codegen() {
        let code = emit(concat!(
            "/**\n * @license HOSTILE_LICENSE-1.0\n * @preserve\n */\n",
            "/** @const HOSTILE_CONST */\n",
            "export let mutable = 1;\n",
            "/** @nocollapse @suppress {checkTypes} HOSTILE_CAST */\n",
            "export const cast = /** @type {string} */ (String(2));\n",
            "// HOSTILE_LINE trailing prose\n",
            "export function bump(): number { mutable = mutable + 1; return mutable; }\n",
        ));
        for marker in [
            "HOSTILE_LICENSE",
            "HOSTILE_CONST",
            "HOSTILE_CAST",
            "HOSTILE_LINE",
            "@license",
            "@preserve",
            "@nocollapse",
            "@suppress",
            "@const",
            "@type",
        ] {
            assert!(!code.contains(marker), "leaked {marker}:\n{code}");
        }
    }

    /// The allowed one, which is the whole reason the policy is not "drop all".
    #[test]
    fn the_pure_annotation_survives() {
        let code = emit("export const token = /*#__PURE__*/ makeToken();\n");
        assert!(code.contains("__PURE__"), "{code}");
    }

    /// And it survives on the shape that motivated `pure_calls.rs`: a top-level
    /// declaration initialised by an annotated call, which is what lets Closure
    /// move the declaration across chunks.
    #[test]
    fn pure_survives_the_shape_pure_calls_rs_was_written_for() {
        let code = emit(concat!(
            "const styled = /*#__PURE__*/ makeStyles({});\n",
            "export const view = /* @__PURE__ */ from_html(`<p></p>`);\n",
        ));
        assert_eq!(code.matches("__PURE__").count(), 2, "{code}");
    }
}
