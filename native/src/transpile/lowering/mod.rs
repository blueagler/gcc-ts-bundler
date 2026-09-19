//! M2: TS lowering on oxc, with the parts we must own.
//!
//! `oxc_transformer` does the type erasure, but it does **not** do what this
//! pipeline needs for enums and namespaces. What it gets wrong is measured
//! below rather than assumed, and each divergence becomes a pass we own.

mod casts;
mod comments;
mod enums;
mod namespaces;
mod preserved;
mod private_class;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
#[cfg(test)]
use oxc_ast::ast::{ObjectProperty, PropertyKey};
#[cfg(test)]
use oxc_ast_visit::walk;
#[cfg(test)]
use oxc_ast_visit::Visit;
use oxc_ast_visit::VisitMut;
#[cfg(test)]
use oxc_codegen::Codegen;
use oxc_semantic::SemanticBuilder;
#[cfg(test)]
use oxc_span::SourceType;
use oxc_transformer::{
    ClassPropertiesOptions, HelperLoaderMode, JsxOptions, JsxRuntime, TransformOptions, Transformer,
};
use std::path::Path;

use super::identity::ModuleIdentity;
use crate::closure_capabilities::CLOSURE_COMPILER_CAPABILITIES;

use self::casts::synthesize_closure_casts;
use self::enums::{erase_const_enum_objects, ConstEnumInliner};
use self::namespaces::{
    flatten_literal_namespaces, force_var_for_lowered_declarations, hoisted_lowering_names,
    merge_namespace_blocks, stable_literal_namespaces,
};
use self::private_class::{
    prepare_private_class_lowering, validate_private_class_helpers, PrivateSlotConstructorRewriter,
};

pub(crate) use self::casts::materialize_closure_casts;
pub(crate) use self::comments::closure_input_codegen_options;
pub(crate) use self::enums::{
    collect_const_enum_values, collect_enum_values, remove_enum_declarations, EnumValues,
};
pub(crate) use self::preserved::emit_preserved_module;

#[cfg(test)]
pub(crate) fn transform_program<'a>(
    allocator: &'a Allocator,
    path: &Path,
    program: &mut Program<'a>,
    scoping: oxc_semantic::Scoping,
    run_jsx: bool,
) -> Result<ModuleIdentity, String> {
    transform_program_with_enum_values(
        allocator,
        path,
        program,
        scoping,
        run_jsx,
        EnumValues::new(),
    )
}

pub(crate) fn transform_program_with_enum_values<'a>(
    allocator: &'a Allocator,
    path: &Path,
    program: &mut Program<'a>,
    scoping: oxc_semantic::Scoping,
    run_jsx: bool,
    mut enum_values: EnumValues,
) -> Result<ModuleIdentity, String> {
    merge_namespace_blocks(&mut program.body);
    synthesize_closure_casts(allocator, program);
    let lowered_names = hoisted_lowering_names(program);
    let const_enum_values = collect_const_enum_values(program);
    for (name, members) in &const_enum_values {
        enum_values.insert(name.clone(), members.clone());
    }
    let (private_lowering, scoping) = if CLOSURE_COMPILER_CAPABILITIES.private_class_elements {
        (None, scoping)
    } else {
        prepare_private_class_lowering(allocator, path, program, scoping)?
    };
    let lower_private_classes = private_lowering.is_some();
    // Private-class helper injection rebuilds SymbolIds. Flattening is only sound
    // against the scoping the transformer will actually consume.
    let flatten_candidates = if lower_private_classes {
        Vec::new()
    } else {
        stable_literal_namespaces(program, &scoping)
    };
    let mut options = TransformOptions::default();
    if lower_private_classes {
        options.env.es2022.class_properties = Some(ClassPropertiesOptions::default());
        options.env.es2022.class_static_block = true;
        options.helper_loader.mode = HelperLoaderMode::External;
    }
    if run_jsx {
        options.jsx = JsxOptions {
            runtime: JsxRuntime::Classic,
            development: false,
            ..JsxOptions::default()
        };
    }
    let mut result =
        Transformer::new(allocator, path, &options).build_with_scoping(scoping, program);
    if !result.diagnostics.is_empty() {
        return Err(result
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    if let Some(private_lowering) = &private_lowering {
        validate_private_class_helpers(program, path)?;
        PrivateSlotConstructorRewriter {
            allocator,
            authored_weak_collection_news: &private_lowering.authored_weak_collection_news,
        }
        .visit_program(program);
    }
    force_var_for_lowered_declarations(program, &lowered_names);
    if !enum_values.is_empty() {
        let mut inliner = ConstEnumInliner {
            allocator,
            builder: oxc_ast::builder::AstBuilder::new(allocator),
            values: &enum_values,
            scoping: &mut result.scoping,
        };
        oxc_ast_visit::VisitMut::visit_program(&mut inliner, program);
        erase_const_enum_objects(program, &const_enum_values);
    }
    let flattened =
        flatten_literal_namespaces(allocator, program, &result.scoping, &flatten_candidates);
    if lower_private_classes || flattened {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(false)
            .with_enum_eval(true)
            .build(program);
        if !semantic.diagnostics.is_empty() {
            return Err(semantic
                .diagnostics
                .iter()
                .map(|diagnostic| format!("{}: {diagnostic}", path.display()))
                .collect::<Vec<_>>()
                .join("\n"));
        }
        Ok(ModuleIdentity::new(semantic.semantic.into_scoping()))
    } else {
        Ok(ModuleIdentity::new(result.scoping))
    }
}

#[cfg(test)]
/// parse -> semantic -> oxc TS/JSX lowering -> print. The baseline the owned
/// passes are measured against.
pub(crate) fn lower_with_oxc(path: &Path, source: &str) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|error| error.to_string())?;
    let parsed = oxc_parser::Parser::new(&allocator, source, source_type).parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(format!("{}: {}", path.display(), error.message));
    }
    let mut program = parsed.program;
    let scoping = SemanticBuilder::new()
        .with_build_nodes(false)
        // Finding 7: the transformer *panics* on any enum unless the model was
        // built with this on ("Transformer requires `Scoping` produced with
        // `SemanticBuilder::with_enum_eval(true)`"). It is not a diagnostic and
        // not a fallback -- a pipeline that forgets it dies on the first enum.
        .with_enum_eval(true)
        .build(&program)
        .semantic
        .into_scoping();
    transform_program(
        &allocator,
        path,
        &mut program,
        scoping,
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| matches!(extension, "jsx" | "tsx")),
    )?;
    Ok(materialize_closure_casts(
        &Codegen::new().build(&program).code,
    ))
}

#[cfg(test)]
mod what_oxc_gets_wrong {
    use super::{
        lower_with_oxc, prepare_private_class_lowering, walk, Allocator, ObjectProperty, Path,
        PropertyKey, SemanticBuilder, SourceType, Visit,
    };

    fn lower(name: &str, source: &str) -> Result<String, String> {
        lower_with_oxc(Path::new(name), source)
    }

    /// The pinned TDZ contract: `tsc` and swc emit `export var Kind`; oxc emits
    /// `export let Kind`, whose dead zone turns a forward read into a
    /// ReferenceError (OX-D3 §7). This test records the defect on the real
    /// transformer so the owned fix has something to prove itself against.
    #[test]
    fn an_exported_enum_keeps_var_semantics() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower("m.ts", "export enum Kind { A = 1 }\n")?;
        assert!(code.contains("export var Kind"), "{code}");
        assert!(!code.contains("let Kind"), "{code}");
        Ok(())
    }

    /// Same defect, same fix, other construct: an exported namespace is lowered
    /// onto `export let Outer` too.
    #[test]
    fn an_exported_namespace_keeps_var_semantics() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower("m.ts", "export namespace Outer { export const v = 3; }\n")?;
        assert!(code.contains("export var Outer"), "{code}");
        assert!(!code.contains("let Outer"), "{code}");
        Ok(())
    }

    /// A plain (non-exported) enum was already `var`; the pass must not disturb
    /// it, and must not touch authored `let`s that merely share a name shape.
    #[test]
    fn authored_let_bindings_are_untouched() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower(
            "m.ts",
            "enum Kind { A = 1 }\nlet other = 2;\nexport { other };\n",
        )?;
        assert!(code.contains("var Kind"), "{code}");
        assert!(code.contains("let other"), "{code}");
        Ok(())
    }

    /// The owned erasure contract differs from Oxc's isolated-module enum
    /// optimization: nothing named `Dir` survives, and the read is a literal.
    #[test]
    fn a_const_enum_is_inlined_and_erased() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower(
            "m.ts",
            "const enum Dir { Up = 1, Down = 1 + Up }\nexport const d = Dir.Down;\n",
        )?;
        assert!(!code.contains("Dir"), "{code}");
        assert!(code.contains("export const d = 2"), "{code}");
        Ok(())
    }

    /// `export = x` has no ES spelling; swc lowered it to `module.exports`,
    /// which is undeclared in a goog.module. Recorded here for the owned
    /// pre-rewrite (to `export default`).
    #[test]
    fn export_assignment_needs_our_prerewrite() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower(
            "m.ts",
            "function greet(): string { return 'hi'; }\nexport = greet;\n",
        )?;
        assert!(
            code.contains("module.exports") || code.contains("export default"),
            "{code}"
        );
        Ok(())
    }

    /// JSX classic production, which we do want from the transformer.
    #[test]
    fn jsx_classic_production_is_what_we_asked_for() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower("m.tsx", "export const view = <div id=\"a\">hi</div>;\n")?;
        assert!(code.contains("React.createElement"), "{code}");
        Ok(())
    }

    #[test]
    fn synthesized_private_helper_spans_do_not_overlap_authored_source(
    ) -> Result<(), Box<dyn std::error::Error>> {
        struct HelperObjectKeySpans(Vec<u32>);

        impl<'a> Visit<'a> for HelperObjectKeySpans {
            fn visit_object_property(&mut self, property: &ObjectProperty<'a>) {
                if let PropertyKey::StaticIdentifier(identifier) = &property.key {
                    if identifier.name == "classPrivateFieldInitSpec" {
                        self.0.push(identifier.span.start);
                    }
                }
                walk::walk_object_property(self, property);
            }
        }

        let source = "class Box { #value = 1; }";
        let allocator = Allocator::default();
        let source_type = SourceType::from_path(Path::new("box.ts"))?.with_module(true);
        let parsed = oxc_parser::Parser::new(&allocator, source, source_type).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        let scoping = SemanticBuilder::new()
            .with_build_nodes(false)
            .with_enum_eval(true)
            .build(&program)
            .semantic
            .into_scoping();
        let (enabled, _) =
            prepare_private_class_lowering(&allocator, Path::new("box.ts"), &mut program, scoping)?;
        assert!(enabled.is_some());
        let mut spans = HelperObjectKeySpans(Vec::new());
        spans.visit_program(&program);
        assert!(!spans.0.is_empty());
        assert!(
            spans.0.iter().all(|start| *start > source.len() as u32),
            "helper spans overlapped authored source: {:?}",
            spans.0
        );
        Ok(())
    }

    #[test]
    fn private_class_elements_use_symbol_slots_only_when_present(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let code = lower("m.ts",
    "class Box { #value = 1; static #scale = 2; #read() { return this.#value; } static has(value: object) { return #value in value; } value() { return this.#read() + Box.#scale; } } export const box = new Box();\n",)?;
        assert!(!code.contains("#value"), "{code}");
        assert!(!code.contains("#read"), "{code}");
        assert!(code.contains("new gccPrivateSlot"), "{code}");
        assert!(!code.contains("new WeakMap"), "{code}");
        assert!(!code.contains("new WeakSet"), "{code}");
        assert!(code.contains("Symbol()"), "{code}");
        assert!(code.contains("babelHelpers"), "{code}");

        let ordinary = lower("plain.ts", "export class Box { value = 1; }\n")?;
        assert!(!ordinary.contains("babelHelpers"), "{ordinary}");
        assert!(ordinary.contains("value = 1"), "{ordinary}");

        let lit_styles = lower("styles.ts",
    "const css = String.raw; export const styles = css`:host { --text: #fff; } #center { color: #08060d; }`;\n",)?;
        assert!(!lit_styles.contains("babelHelpers"), "{lit_styles}");
        assert!(!lit_styles.contains("gccPrivateSlot"), "{lit_styles}");
        assert!(lit_styles.contains("#center"), "{lit_styles}");
        Ok(())
    }

    #[test]
    fn authored_weak_collections_are_not_rewritten() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower("m.ts",
    "const authored = new WeakMap<object, number>(); class Box { #value = 1; read() { return this.#value; } } export { authored, Box };\n",)?;
        assert!(code.contains("new WeakMap"), "{code}");
        assert!(code.contains("new gccPrivateSlot"), "{code}");
        Ok(())
    }
}

#[cfg(test)]
mod executing {
    //! Text assertions say the binding kind changed; only running the output
    //! says the dead zone is gone. This is the OX-D3 repro, emitted through the
    //! oxc pipeline and executed.
    use super::{lower_with_oxc, Path};
    use std::process::Command;

    pub(super) fn run_emitted(
        name: &str,
        source: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let code = lower_with_oxc(Path::new("m.ts"), source)?;
        let dir = std::env::temp_dir().join(format!(
            "gcc-oxc-exec-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir)?;
        let file = dir.join("m.mjs");
        std::fs::write(
            &file,
            format!("{code}\nconsole.log(JSON.stringify(probe));\n"),
        )?;
        let output = Command::new("node").arg(&file).output()?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            output.status.success(),
            "node failed: {stderr}\n--- emitted:\n{code}"
        );
        Ok(stdout)
    }

    /// The pinned contract: a forward reference to an exported enum reads
    /// `undefined`, exactly as `tsc` emits it. Before the owned pass this threw
    /// `ReferenceError: Cannot access 'Kind' before initialization`.
    #[test]
    fn a_forward_reference_to_an_exported_enum_does_not_throw(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let probe = run_emitted("enum-tdz",
    "export function early(): string { return typeof Kind; }\nexport const probe = early();\nexport enum Kind { A = 1 }\n",)?;
        assert_eq!(probe, "\"undefined\"");
        Ok(())
    }

    /// Same for an exported namespace, which oxc also lowers onto `export let`.
    #[test]
    fn a_forward_reference_to_an_exported_namespace_does_not_throw(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let probe = run_emitted("namespace-tdz",
    "export function early(): string { return typeof Outer; }\nexport const probe = early();\nexport namespace Outer { export const v = 3; }\n",)?;
        assert_eq!(probe, "\"undefined\"");
        Ok(())
    }

    #[test]
    fn private_accessor_getters_and_setters_execute_for_instances_statics_and_inheritance(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let probe = run_emitted(
            "private-accessors",
            r"
        class InstanceBase {
          #value = 1;
          get #pair() { return this.#value * 2; }
          set #pair(value: number) { this.#value = value; }
          read() { return this.#pair; }
          change(value: number) { this.#pair = value; return this.#pair; }
        }
        class InstanceChild extends InstanceBase {}
        class StaticBase {
          static #value = 7;
          static get #pair() { return this.#value * 2; }
          static set #pair(value: number) { this.#value = value; }
          static read() { return this.#pair; }
          static change(value: number) { this.#pair = value; return this.#pair; }
        }
        class StaticChild extends StaticBase {}
        function fails(callback: () => unknown) {
          try { callback(); return false; } catch (error) { return error instanceof TypeError; }
        }
        const instance = new InstanceChild();
        export const probe = [
          instance.read(),
          instance.change(4),
          StaticBase.read(),
          StaticBase.change(9),
          fails(() => StaticChild.read()),
          fails(() => StaticChild.change(10)),
        ];
        ",
        )?;
        assert_eq!(probe, "[2,8,14,18,true,true]");
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Upstream oxc defects and our mitigations
// ---------------------------------------------------------------------------
//
// Three of the four findings from this milestone are defects in oxc 0.142 rather
// than in our code. Each is mitigated here and pinned by an executing test; this
// block is the record of what is ours to carry and what should go upstream.
//
// 1. `SemanticBuilder::with_enum_eval(true)` is *required* for enum lowering, and
//    the transformer **panics** without it rather than emitting a diagnostic:
//        "Transformer requires `Scoping` produced with
//         `SemanticBuilder::with_enum_eval(true)` to correctly transform `enum X`"
//    Mitigation: `lower_with_oxc` always sets it, and
//    `with_enum_eval_is_required` below fails loudly if anyone removes it.
//    Upstream: a hard panic on valid input is a bad failure mode; a diagnostic
//    (or defaulting the flag when a `TSEnumDeclaration` is present) would be
//    better. Severity for us: nil once set, fatal if forgotten.
//
// 2. An exported enum lowers to `export let`, and an exported *namespace* to
//    `export let` as well. `tsc` emits `export var` for both. `let` has a
//    temporal dead zone, so a forward reference throws instead of reading
//    `undefined`, and `typeof` does not protect against it.
//    Mitigation: `force_var_for_lowered_declarations`. Upstream: this is a
//    divergence from tsc's emit contract, not a style choice.
//
// 3. Declaration merging is not implemented for namespaces: a second
//    `namespace A { … }` block emits a bare reference to the first block's member
//    and throws `ReferenceError` at runtime. swc has the identical gap.
//    Mitigation: `merge_namespace_blocks`, run before lowering.
//
// The fourth finding was ours, not oxc's: `IdentifierReference::reference_id()`
// panics on a synthesised node, so `identity::key_of_reference` reads the
// `Cell` directly and is total. Pinned in `identity.rs`.

#[cfg(test)]
mod upstream_defect_guards {
    use super::{lower_with_oxc, Path};

    /// Finding 1, pinned: lowering an enum must not panic.
    ///
    /// This is a guard against *our* configuration regressing, not against oxc:
    /// drop `with_enum_eval(true)` from `lower_with_oxc` and this test dies with
    /// the upstream panic instead of failing an assertion, which is exactly the
    /// signal wanted — the failure mode in production would be identical.
    #[test]
    fn with_enum_eval_is_required_and_we_set_it() -> Result<(), Box<dyn std::error::Error>> {
        let code = lower_with_oxc(Path::new("m.ts"),
    "export enum Kind { A = 1 }\nenum Plain { B = 2 }\nconst enum C { D = 3 }\nexport const use = C.D;\n",)?;
        assert!(code.contains("export var Kind"), "{code}");
        assert!(code.contains("var Plain"), "{code}");
        // The const enum is inlined and erased, so neither the object nor a
        // member read survives.
        assert!(!code.contains("var C "), "{code}");
        assert!(code.contains("export const use = 3"), "{code}");
        Ok(())
    }
}
