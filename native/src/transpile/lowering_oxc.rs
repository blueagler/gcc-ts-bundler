//! M2: TS lowering on oxc, with the parts we must own.
//!
//! `oxc_transformer` does the type erasure, but it does **not** do what this
//! pipeline needs for enums and namespaces. What it gets wrong is measured
//! below rather than assumed, and each divergence becomes a pass we own.

use oxc_allocator::Allocator;
use oxc_allocator::Vec as ArenaVec;
use oxc_ast::ast::{
    BinaryOperator, BindingIdentifier, Declaration, Expression, PrivateIdentifier, Program,
    Statement, TSEnumMemberName, TSModuleDeclarationBody, TSModuleDeclarationName, UnaryOperator,
    VariableDeclaration, VariableDeclarationKind,
};
#[cfg(test)]
use oxc_ast::ast::{ObjectProperty, PropertyKey};
#[cfg(test)]
use oxc_ast_visit::walk;
use oxc_ast_visit::{Visit, VisitMut};
use oxc_codegen::Codegen;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_transformer::{
    ClassPropertiesOptions, Helper, HelperLoaderMode, JsxOptions, JsxRuntime, TransformOptions,
    Transformer,
};
use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::identity_oxc::ModuleIdentity;

const PRIVATE_CLASS_HELPERS: &str = r#"
const babelHelpers = (function () {
  function babelTypeof(value) {
    return babelTypeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol"
      ? function (value) { return typeof value; }
      : function (value) {
          return value && typeof Symbol === "function" && value.constructor === Symbol && value !== Symbol.prototype
            ? "symbol"
            : typeof value;
        }, babelTypeof(value);
  }
  function toPrimitive(value, hint) {
    if (babelTypeof(value) !== "object" || !value) return value;
    const exotic = value[Symbol.toPrimitive];
    if (exotic !== undefined) {
      const result = exotic.call(value, hint || "default");
      if (babelTypeof(result) !== "object") return result;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return (hint === "string" ? String : Number)(value);
  }
  function toPropertyKey(value) {
    const key = toPrimitive(value, "string");
    return babelTypeof(key) === "symbol" ? key : key + "";
  }
  function defineProperty(object, key, value) {
    key = toPropertyKey(key);
    if (key in object) {
      Object.defineProperty(object, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      object[key] = value;
    }
    return object;
  }
  function checkPrivateRedeclaration(receiver, collection) {
    if (collection.has(receiver)) {
      throw new TypeError("Cannot initialize the same private elements twice on an object");
    }
  }
  function classPrivateFieldInitSpec(receiver, state, value) {
    checkPrivateRedeclaration(receiver, state);
    state.set(receiver, value);
  }
  function classPrivateMethodInitSpec(receiver, brand) {
    checkPrivateRedeclaration(receiver, brand);
    brand.add(receiver);
  }
  function assertClassBrand(brand, receiver, value) {
    if (typeof brand === "function" ? brand === receiver : brand.has(receiver)) {
      return arguments.length < 3 ? receiver : value;
    }
    throw new TypeError("Private element is not present on this object");
  }
  function classPrivateFieldGet2(state, receiver) {
    return state.get(assertClassBrand(state, receiver));
  }
  function classPrivateFieldSet2(state, receiver, value) {
    state.set(assertClassBrand(state, receiver), value);
    return value;
  }
  function toSetter(callback, args, receiver) {
    args || (args = []);
    const index = args.length++;
    return Object.defineProperty({}, "_", {
      set(value) {
        args[index] = value;
        callback.apply(receiver, args);
      },
    });
  }
  function readOnlyError(name) {
    throw new TypeError('"' + name + '" is read-only');
  }
  function writeOnlyError(name) {
    throw new TypeError('"' + name + '" is write-only');
  }
  function checkInRHS(value) {
    if (Object(value) !== value) {
      throw new TypeError("right-hand side of 'in' should be an object, got " + (value !== null ? babelTypeof(value) : "null"));
    }
    return value;
  }
  function getPrototypeOf(value) {
    return getPrototypeOf = Object.setPrototypeOf
      ? Object.getPrototypeOf.bind()
      : function (value) { return value.__proto__ || Object.getPrototypeOf(value); }, getPrototypeOf(value);
  }
  function superPropBase(target, property) {
    while (!Object.prototype.hasOwnProperty.call(target, property) && (target = getPrototypeOf(target)) !== null) {}
    return target;
  }
  function get(target, property, receiver) {
    return get = typeof Reflect !== "undefined" && Reflect.get
      ? Reflect.get.bind()
      : function (target, property, receiver) {
          const base = superPropBase(target, property);
          if (base) {
            const descriptor = Object.getOwnPropertyDescriptor(base, property);
            return descriptor.get ? descriptor.get.call(arguments.length < 3 ? target : receiver) : descriptor.value;
          }
        }, get(target, property, receiver);
  }
  function setProperty(target, property, value, receiver) {
    return setProperty = typeof Reflect !== "undefined" && Reflect.set
      ? Reflect.set
      : function (target, property, value, receiver) {
          let descriptor;
          const base = superPropBase(target, property);
          if (base) {
            descriptor = Object.getOwnPropertyDescriptor(base, property);
            if (descriptor.set) return descriptor.set.call(receiver, value), true;
            if (!descriptor.writable) return false;
          }
          descriptor = Object.getOwnPropertyDescriptor(receiver, property);
          if (descriptor) {
            if (!descriptor.writable) return false;
            descriptor.value = value;
            Object.defineProperty(receiver, property, descriptor);
          } else {
            defineProperty(receiver, property, value);
          }
          return true;
        }, setProperty(target, property, value, receiver);
  }
  function set(target, property, value, receiver, strict) {
    if (!setProperty(target, property, value, receiver || target) && strict) {
      throw new TypeError("failed to set property");
    }
    return value;
  }
  function superPropGet(target, property, receiver, flags) {
    const value = get(getPrototypeOf(flags & 1 ? target.prototype : target), property, receiver);
    return flags & 2 && typeof value === "function"
      ? function (args) { return value.apply(receiver, args); }
      : value;
  }
  function superPropSet(target, property, value, receiver, strict, isProto) {
    return set(getPrototypeOf(isProto ? target.prototype : target), property, value, receiver, strict);
  }
  return {
    assertClassBrand,
    checkInRHS,
    classPrivateFieldGet2,
    classPrivateFieldInitSpec,
    classPrivateFieldSet2,
    classPrivateMethodInitSpec,
    defineProperty,
    readOnlyError,
    superPropGet,
    superPropSet,
    toPropertyKey,
    toSetter,
    writeOnlyError,
  };
})();
"#;

#[cfg(test)]
pub(crate) fn transform_program<'a>(
    allocator: &'a Allocator,
    path: &Path,
    program: &mut Program<'a>,
    scoping: oxc_semantic::Scoping,
    run_jsx: bool,
) -> Result<ModuleIdentity, String> {
    transform_program_with_enum_values(allocator, path, program, scoping, run_jsx, HashMap::new())
}

pub(crate) fn strip_typescript_module(path: &Path, source: &str) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path)
        .map_err(|error| error.to_string())?
        .with_module(true);
    if !source_type.is_typescript() || source_type.is_jsx() {
        return Err(format!(
            "Preserved type stripping requires a non-JSX TypeScript module: {}",
            path.display()
        ));
    }
    let source = rewrite_preserved_module_specifiers(path, source, source_type)?;
    let parsed = oxc_parser::Parser::new(&allocator, &source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut program = parsed.program;
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_enum_eval(true)
        .build(&program);
    if !semantic.diagnostics.is_empty() {
        return Err(semantic
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let options = TransformOptions::default();
    let result = Transformer::new(&allocator, path, &options)
        .build_with_scoping(semantic.semantic.into_scoping(), &mut program);
    if !result.diagnostics.is_empty() {
        return Err(result
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    Ok(Codegen::new().build(&program).code)
}

fn rewrite_preserved_module_specifiers(
    path: &Path,
    source: &str,
    source_type: SourceType,
) -> Result<String, String> {
    let allocator = Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut edits = Vec::<(usize, usize, String)>::new();
    for statement in &parsed.program.body {
        let literal = match statement {
            Statement::ImportDeclaration(import) => Some(&import.source),
            Statement::ExportAllDeclaration(export) => Some(&export.source),
            Statement::ExportNamedDeclaration(export) => export.source.as_ref(),
            _ => None,
        };
        let Some(literal) = literal else {
            continue;
        };
        let Some(specifier) = preserved_output_specifier(path, literal.value.as_str()) else {
            continue;
        };
        let span = literal.span();
        edits.push((
            span.start as usize,
            span.end as usize,
            format!("{specifier:?}"),
        ));
    }
    let mut output = source.to_string();
    edits.sort_by_key(|(start, _, _)| *start);
    for (start, end, replacement) in edits.into_iter().rev() {
        output.replace_range(start..end, &replacement);
    }
    Ok(output)
}

fn preserved_output_specifier(path: &Path, specifier: &str) -> Option<String> {
    if !specifier.starts_with('.') {
        return None;
    }
    let extension = Path::new(specifier)
        .extension()
        .and_then(|value| value.to_str());
    if matches!(extension, Some("ts" | "tsx" | "mts" | "cts")) {
        let stem = specifier.rsplit_once('.')?.0;
        return Some(format!("{stem}.js"));
    }
    if extension.is_some() {
        return None;
    }
    let target = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(specifier);
    for extension in ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"] {
        if target.with_extension(extension).is_file() {
            return Some(format!("{specifier}.js"));
        }
    }
    for extension in ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"] {
        if target.join(format!("index.{extension}")).is_file() {
            return Some(format!("{}/index.js", specifier.trim_end_matches('/')));
        }
    }
    None
}

struct SynthesizedSpanOffset {
    offset: u32,
}

impl<'a> VisitMut<'a> for SynthesizedSpanOffset {
    fn visit_span(&mut self, span: &mut Span) {
        span.start = span.start.saturating_add(self.offset);
        span.end = span.end.saturating_add(self.offset);
    }
}

#[derive(Default)]
struct PrivateElementDetector {
    found: bool,
    has_babel_helpers_binding: bool,
}

impl<'a> Visit<'a> for PrivateElementDetector {
    fn visit_private_identifier(&mut self, _identifier: &PrivateIdentifier<'a>) {
        self.found = true;
    }

    fn visit_binding_identifier(&mut self, identifier: &BindingIdentifier<'a>) {
        if identifier.name == "babelHelpers" {
            self.has_babel_helpers_binding = true;
        }
    }
}

fn prepare_private_class_lowering<'a>(
    allocator: &'a Allocator,
    path: &Path,
    program: &mut Program<'a>,
    scoping: oxc_semantic::Scoping,
) -> Result<(bool, oxc_semantic::Scoping), String> {
    let mut detector = PrivateElementDetector::default();
    detector.visit_program(program);
    if !detector.found {
        return Ok((false, scoping));
    }
    if detector.has_babel_helpers_binding {
        return Err(format!(
            "Private class element lowering cannot safely inject its Oxc helper binding because {} already declares babelHelpers",
            path.display()
        ));
    }

    let source_type = SourceType::from_path(Path::new("gcc-private-class-helpers.js"))
        .map_err(|error| error.to_string())?
        .with_module(true);
    let mut parsed = oxc_parser::Parser::new(allocator, PRIVATE_CLASS_HELPERS, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("private class helper runtime: {diagnostic}"))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    // Exact-span metadata addresses the authored source. Keep synthesized helper
    // spans outside that range so an unrelated authored property at the same
    // byte offset cannot accidentally quote a helper-runtime object key.
    SynthesizedSpanOffset {
        offset: program.span.end.saturating_add(1),
    }
    .visit_program(&mut parsed.program);

    let original_body = std::mem::replace(&mut program.body, ArenaVec::new_in(&allocator));
    let mut body = parsed.program.body;
    body.extend(original_body);
    program.body = body;

    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
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
    Ok((true, semantic.semantic.into_scoping()))
}

fn supports_private_class_helper(helper: Helper) -> bool {
    matches!(
        helper,
        Helper::AssertClassBrand
            | Helper::CheckInRHS
            | Helper::ClassPrivateFieldGet2
            | Helper::ClassPrivateFieldInitSpec
            | Helper::ClassPrivateFieldSet2
            | Helper::ClassPrivateMethodInitSpec
            | Helper::DefineProperty
            | Helper::ReadOnlyError
            | Helper::SuperPropGet
            | Helper::SuperPropSet
            | Helper::ToPropertyKey
            | Helper::ToSetter
            | Helper::WriteOnlyError
    )
}

pub(crate) fn transform_program_with_enum_values<'a>(
    allocator: &'a Allocator,
    path: &Path,
    program: &mut Program<'a>,
    scoping: oxc_semantic::Scoping,
    run_jsx: bool,
    mut enum_values: HashMap<String, HashMap<String, EnumValue>>,
) -> Result<ModuleIdentity, String> {
    merge_namespace_blocks(&mut program.body);
    let lowered_names = hoisted_lowering_names(program);
    let const_enum_values = collect_const_enum_values(program);
    for (name, members) in &const_enum_values {
        enum_values.insert(name.clone(), members.clone());
    }
    let (lower_private_classes, scoping) =
        prepare_private_class_lowering(allocator, path, program, scoping)?;
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
    let result = Transformer::new(allocator, path, &options).build_with_scoping(scoping, program);
    if !result.diagnostics.is_empty() {
        return Err(result
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    if lower_private_classes {
        #[allow(deprecated)]
        let unsupported_helpers = result
            .helpers_used
            .keys()
            .copied()
            .filter(|helper| !supports_private_class_helper(*helper))
            .map(|helper| helper.name())
            .collect::<Vec<_>>();
        if !unsupported_helpers.is_empty() {
            return Err(format!(
                "Private class element lowering requested unsupported Oxc helpers in {}: {}",
                path.display(),
                unsupported_helpers.join(", ")
            ));
        }
    }
    force_var_for_lowered_declarations(program, &lowered_names);
    if !enum_values.is_empty() {
        let mut inliner = ConstEnumInliner {
            allocator,
            builder: oxc_ast::builder::AstBuilder::new(allocator),
            values: &enum_values,
        };
        oxc_ast_visit::VisitMut::visit_program(&mut inliner, program);
        erase_const_enum_objects(program, &const_enum_values);
    }
    Ok(ModuleIdentity::new(result.scoping))
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
        .with_build_nodes(true)
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
    Ok(Codegen::new().build(&program).code)
}

/// TypeScript declaration merging: two `namespace A { … }` blocks are one
/// namespace, and a member declared in either is visible from both.
///
/// Neither front end implements that. swc's `strip` qualifies a member reference
/// only inside the block that declares it, and **oxc's transformer has the same
/// gap** (measured: the merged block emits a bare `Inner` that throws
/// `ReferenceError: Inner is not defined`). So the owned pre-lowering merge that
/// fixed it on swc is needed here too, and this is that pass on the oxc AST.
///
/// Conservative in exactly the same way: a group merges only when it cannot
/// reorder observable work — every block agrees on the `export` modifier,
/// `declare`/qualified-name forms are skipped, and only declarations may sit
/// between the blocks.
fn merge_namespace_blocks<'a>(statements: &mut ArenaVec<'a, Statement<'a>>) {
    fn block_info(statement: &Statement<'_>) -> Option<(String, bool)> {
        let (declaration, exported) = match statement {
            Statement::TSModuleDeclaration(declaration) => (&**declaration, false),
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_ref() {
                Some(Declaration::TSModuleDeclaration(declaration)) => (&**declaration, true),
                _ => return None,
            },
            _ => return None,
        };
        if declaration.declare {
            return None;
        }
        let TSModuleDeclarationName::Identifier(id) = &declaration.id else {
            return None;
        };
        match &declaration.body {
            Some(TSModuleDeclarationBody::TSModuleBlock(_)) => {
                Some((id.name.to_string(), exported))
            }
            _ => None,
        }
    }

    fn block_mut<'a, 'b>(
        statement: &'b mut Statement<'a>,
    ) -> Option<&'b mut ArenaVec<'a, Statement<'a>>> {
        let declaration = match statement {
            Statement::TSModuleDeclaration(declaration) => &mut **declaration,
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_mut() {
                Some(Declaration::TSModuleDeclaration(declaration)) => &mut **declaration,
                _ => return None,
            },
            _ => return None,
        };
        match declaration.body.as_mut() {
            Some(TSModuleDeclarationBody::TSModuleBlock(block)) => Some(&mut block.body),
            _ => None,
        }
    }

    /// True when moving a namespace body across this item cannot change what
    /// runs first.
    ///
    /// Note `is_declaration()` alone is wrong here: `export function f() {}` is a
    /// *module* declaration, so the first version of this gate silently refused
    /// to merge across any exported declaration (finding 6's tri-split). An
    /// `export default <expr>` stays disqualifying because it evaluates.
    fn order_neutral(statement: &Statement<'_>) -> bool {
        if matches!(statement, Statement::ExportDefaultDeclaration(_)) {
            return false;
        }
        statement.is_declaration()
            || statement.is_module_declaration()
            || matches!(statement, Statement::EmptyStatement(_))
    }

    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, statement) in statements.iter().enumerate() {
        let Some((name, _)) = block_info(statement) else {
            continue;
        };
        match groups.iter_mut().find(|(known, _)| *known == name) {
            Some((_, indexes)) => indexes.push(index),
            None => groups.push((name, vec![index])),
        }
    }

    let mut absorbed = HashSet::new();
    for (_, indexes) in groups {
        if indexes.len() < 2 {
            continue;
        }
        let exported = block_info(&statements[indexes[0]]).map(|(_, exported)| exported);
        if !indexes
            .iter()
            .all(|index| block_info(&statements[*index]).map(|(_, e)| e) == exported)
        {
            continue;
        }
        let first = indexes[0];
        let last = *indexes.last().unwrap_or(&first);
        if !(first + 1..last)
            .all(|index| indexes.contains(&index) || order_neutral(&statements[index]))
        {
            continue;
        }
        let mut moved: Vec<Statement<'a>> = Vec::new();
        for index in indexes.iter().skip(1) {
            let Some(body) = block_mut(&mut statements[*index]) else {
                continue;
            };
            moved.extend(body.drain(..));
            absorbed.insert(*index);
        }
        if let Some(body) = block_mut(&mut statements[first]) {
            for statement in moved {
                body.push(statement);
            }
        }
    }

    if !absorbed.is_empty() {
        let mut index = 0;
        statements.retain(|_| {
            let keep = !absorbed.contains(&index);
            index += 1;
            keep
        });
    }

    // Recurse after merging: a nested namespace split across two *parent* blocks
    // only becomes a sibling pair once the outer merge has happened.
    for statement in statements.iter_mut() {
        if let Some(body) = block_mut(statement) {
            merge_namespace_blocks(body);
        }
    }
}

/// Names oxc will lower onto a binding of its own: TS enums and namespaces.
///
/// Collected from the *pre*-transform AST, because after lowering there is
/// nothing left to distinguish the generated binding from an authored one.
fn hoisted_lowering_names(program: &Program<'_>) -> HashSet<String> {
    fn record(statement: &Statement<'_>, names: &mut HashSet<String>) {
        match statement {
            Statement::TSEnumDeclaration(declaration) => {
                names.insert(declaration.id.name.to_string());
            }
            Statement::TSModuleDeclaration(declaration) => {
                if let TSModuleDeclarationName::Identifier(id) = &declaration.id {
                    names.insert(id.name.to_string());
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    match declaration {
                        Declaration::TSEnumDeclaration(enum_declaration) => {
                            names.insert(enum_declaration.id.name.to_string());
                        }
                        Declaration::TSModuleDeclaration(module_declaration) => {
                            if let TSModuleDeclarationName::Identifier(id) = &module_declaration.id
                            {
                                names.insert(id.name.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    let mut names = HashSet::new();
    for statement in &program.body {
        record(statement, &mut names);
    }
    names
}

/// Restores `var` semantics for the bindings oxc lowers TS constructs onto.
///
/// `tsc` emits `export var Kind;` for an exported enum and `export var Outer;`
/// for an exported namespace. oxc emits `export let` for both, and `let` has a
/// temporal dead zone: a value-position read that runs before the declaration
/// throws `ReferenceError: Cannot access 'Kind' before initialization` instead
/// of reading `undefined` — and `typeof` does not protect against it either
/// (OX-D3 audit §7, with an executing repro; pinned by the risk-6 test in
/// `test/oxc-migration-safety.test.mjs` and by a cargo regression).
///
/// This is a divergence from tsc's *emit contract*, not a style difference, so
/// the lowering is ours: keep oxc's object-construction shape, take back the
/// binding kind.
fn force_var_for_lowered_declarations(program: &mut Program<'_>, names: &HashSet<String>) {
    fn fix(declaration: &mut VariableDeclaration<'_>, names: &HashSet<String>) {
        if declaration.kind == VariableDeclarationKind::Var {
            return;
        }
        let lowered = declaration.declarations.iter().any(|declarator| {
            declarator
                .id
                .get_binding_identifier()
                .is_some_and(|binding| names.contains(binding.name.as_str()))
        });
        if lowered {
            declaration.kind = VariableDeclarationKind::Var;
        }
    }

    for statement in program.body.iter_mut() {
        match statement {
            Statement::VariableDeclaration(declaration) => fix(declaration, names),
            Statement::ExportNamedDeclaration(export) => {
                if let Some(Declaration::VariableDeclaration(declaration)) =
                    export.declaration.as_mut()
                {
                    fix(declaration, names);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod what_oxc_gets_wrong {
    use super::*;

    fn lower(name: &str, source: &str) -> String {
        lower_with_oxc(Path::new(name), source).expect("lowering")
    }

    /// The pinned TDZ contract: `tsc` and swc emit `export var Kind`; oxc emits
    /// `export let Kind`, whose dead zone turns a forward read into a
    /// ReferenceError (OX-D3 §7). This test records the defect on the real
    /// transformer so the owned fix has something to prove itself against.
    #[test]
    fn an_exported_enum_keeps_var_semantics() {
        let code = lower("m.ts", "export enum Kind { A = 1 }\n");
        assert!(code.contains("export var Kind"), "{code}");
        assert!(!code.contains("let Kind"), "{code}");
    }

    /// Same defect, same fix, other construct: an exported namespace is lowered
    /// onto `export let Outer` too.
    #[test]
    fn an_exported_namespace_keeps_var_semantics() {
        let code = lower("m.ts", "export namespace Outer { export const v = 3; }\n");
        assert!(code.contains("export var Outer"), "{code}");
        assert!(!code.contains("let Outer"), "{code}");
    }

    /// A plain (non-exported) enum was already `var`; the pass must not disturb
    /// it, and must not touch authored `let`s that merely share a name shape.
    #[test]
    fn authored_let_bindings_are_untouched() {
        let code = lower(
            "m.ts",
            "enum Kind { A = 1 }\nlet other = 2;\nexport { other };\n",
        );
        assert!(code.contains("var Kind"), "{code}");
        assert!(code.contains("let other"), "{code}");
    }

    /// oxc does not inline const enums -- it emits the runtime object and leaves
    /// member reads as property accesses -- so the whole job is ours. This
    /// asserted the un-owned baseline until `ConstEnumInliner` landed; now it
    /// asserts the contract: nothing named `Dir` survives, and the read is a
    /// literal.
    #[test]
    fn a_const_enum_is_inlined_and_erased() {
        let code = lower(
            "m.ts",
            "const enum Dir { Up = 1, Down = 1 + Up }\nexport const d = Dir.Down;\n",
        );
        assert!(!code.contains("Dir"), "{code}");
        assert!(code.contains("export const d = 2"), "{code}");
    }

    /// `export = x` has no ES spelling; swc lowered it to `module.exports`,
    /// which is undeclared in a goog.module. Recorded here for the owned
    /// pre-rewrite (to `export default`).
    #[test]
    fn export_assignment_needs_our_prerewrite() {
        let code = lower(
            "m.ts",
            "function greet(): string { return 'hi'; }\nexport = greet;\n",
        );
        assert!(
            code.contains("module.exports") || code.contains("export default"),
            "{code}"
        );
    }

    /// JSX classic production, which we do want from the transformer.
    #[test]
    fn jsx_classic_production_is_what_we_asked_for() {
        let code = lower("m.tsx", "export const view = <div id=\"a\">hi</div>;\n");
        assert!(code.contains("React.createElement"), "{code}");
    }

    #[test]
    fn synthesized_private_helper_spans_do_not_overlap_authored_source() {
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
        let source_type = SourceType::from_path(Path::new("box.ts"))
            .unwrap()
            .with_module(true);
        let parsed = oxc_parser::Parser::new(&allocator, source, source_type).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        let scoping = SemanticBuilder::new()
            .with_build_nodes(true)
            .with_enum_eval(true)
            .build(&program)
            .semantic
            .into_scoping();
        let (enabled, _) =
            prepare_private_class_lowering(&allocator, Path::new("box.ts"), &mut program, scoping)
                .unwrap();
        assert!(enabled);
        let mut spans = HelperObjectKeySpans(Vec::new());
        spans.visit_program(&program);
        assert!(!spans.0.is_empty());
        assert!(
            spans.0.iter().all(|start| *start > source.len() as u32),
            "helper spans overlapped authored source: {:?}",
            spans.0
        );
    }

    #[test]
    fn private_class_elements_use_spec_helpers_only_when_present() {
        let code = lower(
            "m.ts",
            "class Box { #value = 1; static #scale = 2; #read() { return this.#value; } static has(value: object) { return #value in value; } value() { return this.#read() + Box.#scale; } } export const box = new Box();\n",
        );
        assert!(!code.contains("#value"), "{code}");
        assert!(!code.contains("#read"), "{code}");
        assert!(code.contains("new WeakMap"), "{code}");
        assert!(code.contains("new WeakSet"), "{code}");
        assert!(code.contains("babelHelpers"), "{code}");

        let ordinary = lower("plain.ts", "export class Box { value = 1; }\n");
        assert!(!ordinary.contains("babelHelpers"), "{ordinary}");
        assert!(ordinary.contains("value = 1"), "{ordinary}");
    }

    /// Namespace lowering shape, for the OX-A end-to-end namespace test.
    #[test]
    fn namespace_lowering_shape_is_recorded() {
        let code = lower(
            "m.ts",
            "export namespace Outer { export const version = 3; export namespace Inner { export const tag = 'INNER'; } }\n",
        );
        assert!(code.contains("Outer"), "{code}");
        assert!(code.contains("Inner"), "{code}");
    }
}

#[cfg(test)]
mod shapes {
    use super::*;
    #[test]
    fn print_shapes() {
        for (name, src) in [
            ("exported enum", "export enum Kind { A = 1, B = 2 }\n"),
            ("plain enum", "enum Kind { A = 1 }\n"),
            ("const enum", "const enum Dir { Up = 1, Down = 1 + Up }\nexport const d = Dir.Down;\n"),
            ("export assign", "function greet(): string { return 'hi'; }\nexport = greet;\n"),
            ("namespace", "export namespace Outer { export const v = 3; export namespace Inner { export const t = 'I'; } }\n"),
        ] {
            println!("--- {name}\n{}", lower_with_oxc(Path::new("m.ts"), src).unwrap());
        }
    }
}

#[cfg(test)]
mod executing {
    //! Text assertions say the binding kind changed; only running the output
    //! says the dead zone is gone. This is the OX-D3 repro, emitted through the
    //! oxc pipeline and executed.
    use super::*;
    use std::process::Command;

    fn run_emitted(name: &str, source: &str) -> String {
        let code = lower_with_oxc(Path::new("m.ts"), source).expect("lowering");
        let dir = std::env::temp_dir().join(format!(
            "gcc-oxc-exec-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("m.mjs");
        std::fs::write(
            &file,
            format!("{code}\nconsole.log(JSON.stringify(probe));\n"),
        )
        .unwrap();
        let output = Command::new("node").arg(&file).output().expect("node");
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            output.status.success(),
            "node failed: {stderr}\n--- emitted:\n{code}"
        );
        stdout
    }

    /// The pinned contract: a forward reference to an exported enum reads
    /// `undefined`, exactly as `tsc` emits it. Before the owned pass this threw
    /// `ReferenceError: Cannot access 'Kind' before initialization`.
    #[test]
    fn a_forward_reference_to_an_exported_enum_does_not_throw() {
        let probe = run_emitted(
            "enum-tdz",
            "export function early(): string { return typeof Kind; }\nexport const probe = early();\nexport enum Kind { A = 1 }\n",
        );
        assert_eq!(probe, "\"undefined\"");
    }

    /// Same for an exported namespace, which oxc also lowers onto `export let`.
    #[test]
    fn a_forward_reference_to_an_exported_namespace_does_not_throw() {
        let probe = run_emitted(
            "namespace-tdz",
            "export function early(): string { return typeof Outer; }\nexport const probe = early();\nexport namespace Outer { export const v = 3; }\n",
        );
        assert_eq!(probe, "\"undefined\"");
    }
}

// ---------------------------------------------------------------------------
// Owned lowering: const-enum inlining
// ---------------------------------------------------------------------------
//
// oxc does not inline const enums -- measured above, it emits the runtime object
// and leaves `Dir.Down` as a property read. TypeScript erases a `const enum`
// entirely and inlines every member read, so the whole job is ours, exactly as
// it is on the swc side (`enums.rs`).
//
// Same shape as the swc implementation, deliberately: collect member values from
// the *pre*-transform AST (the declaration is gone afterwards), inline reads on
// the *post*-transform AST (that is where the reads survive), then drop the
// runtime object oxc emitted for a `const` enum. The folding grammar is the same
// one OXD0 added after finding that unfolded constant expressions crashed at
// runtime -- the two folders must agree, so this is a port of that logic and not
// a fresh one.

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum EnumValue {
    Number(f64),
    String(String),
}

/// `enum name -> member name -> value`, for enums whose members all fold.
fn collect_enum_values_where(
    program: &Program<'_>,
    only_const: bool,
) -> HashMap<String, HashMap<String, EnumValue>> {
    let mut enums = HashMap::new();
    for statement in &program.body {
        let declaration = match statement {
            Statement::TSEnumDeclaration(declaration) => Some(&**declaration),
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_ref() {
                Some(Declaration::TSEnumDeclaration(declaration)) => Some(&**declaration),
                _ => None,
            },
            _ => None,
        };
        let Some(declaration) = declaration else {
            continue;
        };
        if only_const && !declaration.r#const {
            continue;
        }
        let mut members = HashMap::new();
        let mut next_number = 0f64;
        let mut auto_numbering = true;
        for member in &declaration.body.members {
            let name = match &member.id {
                TSEnumMemberName::Identifier(id) => id.name.to_string(),
                TSEnumMemberName::String(literal) => literal.value.to_string(),
                _ => continue,
            };
            let value = match &member.initializer {
                Some(initializer) => {
                    let Some(value) =
                        fold_enum_initializer(initializer, &declaration.id.name, &members)
                    else {
                        auto_numbering = false;
                        continue;
                    };
                    if let EnumValue::Number(number) = value {
                        next_number = number + 1.0;
                        auto_numbering = true;
                    } else {
                        auto_numbering = false;
                    }
                    value
                }
                None if auto_numbering => {
                    let value = EnumValue::Number(next_number);
                    next_number += 1.0;
                    value
                }
                None => continue,
            };
            members.insert(name, value);
        }
        if !members.is_empty() {
            enums.insert(declaration.id.name.to_string(), members);
        }
    }
    enums
}

pub(crate) fn collect_enum_values(
    program: &Program<'_>,
) -> HashMap<String, HashMap<String, EnumValue>> {
    collect_enum_values_where(program, false)
}

pub(crate) fn collect_const_enum_values(
    program: &Program<'_>,
) -> HashMap<String, HashMap<String, EnumValue>> {
    collect_enum_values_where(program, true)
}

pub(crate) fn remove_enum_declarations(program: &mut Program<'_>, names: &HashSet<String>) {
    if names.is_empty() {
        return;
    }
    program.body.retain(|statement| {
        let name = match statement {
            Statement::TSEnumDeclaration(declaration) => Some(declaration.id.name.as_str()),
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_ref() {
                Some(Declaration::TSEnumDeclaration(declaration)) => {
                    Some(declaration.id.name.as_str())
                }
                _ => None,
            },
            _ => None,
        };
        name.is_none_or(|name| !names.contains(name))
    });
}

/// The TypeScript constant-expression grammar, matching `enums.rs`'s folder.
fn fold_enum_initializer(
    expression: &Expression<'_>,
    enum_name: &str,
    already: &HashMap<String, EnumValue>,
) -> Option<EnumValue> {
    let fold = |inner| fold_enum_initializer(inner, enum_name, already);
    match expression {
        Expression::NumericLiteral(literal) => Some(EnumValue::Number(literal.value)),
        Expression::StringLiteral(literal) => Some(EnumValue::String(literal.value.to_string())),
        // `Down = 1 + Up`: a bare reference to an earlier member.
        Expression::Identifier(identifier) => already.get(identifier.name.as_str()).cloned(),
        // `Down = 1 + Dir.Up`: the same thing, qualified.
        Expression::StaticMemberExpression(member) => {
            let Expression::Identifier(object) = &member.object else {
                return None;
            };
            if object.name != enum_name {
                return None;
            }
            already.get(member.property.name.as_str()).cloned()
        }
        Expression::ParenthesizedExpression(parenthesized) => fold(&parenthesized.expression),
        Expression::UnaryExpression(unary) => {
            let EnumValue::Number(value) = fold(&unary.argument)? else {
                return None;
            };
            match unary.operator {
                UnaryOperator::UnaryNegation => Some(EnumValue::Number(-value)),
                UnaryOperator::UnaryPlus => Some(EnumValue::Number(value)),
                UnaryOperator::BitwiseNot => Some(EnumValue::Number(!to_int32(value) as f64)),
                _ => None,
            }
        }
        Expression::BinaryExpression(binary) => {
            let EnumValue::Number(left) = fold(&binary.left)? else {
                return None;
            };
            let EnumValue::Number(right) = fold(&binary.right)? else {
                return None;
            };
            let folded = match binary.operator {
                BinaryOperator::Addition => left + right,
                BinaryOperator::Subtraction => left - right,
                BinaryOperator::Multiplication => left * right,
                BinaryOperator::Division => left / right,
                BinaryOperator::Remainder => left % right,
                BinaryOperator::Exponential => left.powf(right),
                BinaryOperator::BitwiseOR => (to_int32(left) | to_int32(right)) as f64,
                BinaryOperator::BitwiseAnd => (to_int32(left) & to_int32(right)) as f64,
                BinaryOperator::BitwiseXOR => (to_int32(left) ^ to_int32(right)) as f64,
                BinaryOperator::ShiftLeft => (to_int32(left) << (to_uint32(right) & 31)) as f64,
                BinaryOperator::ShiftRight => (to_int32(left) >> (to_uint32(right) & 31)) as f64,
                BinaryOperator::ShiftRightZeroFill => {
                    (to_uint32(left) >> (to_uint32(right) & 31)) as f64
                }
                _ => return None,
            };
            Some(EnumValue::Number(folded))
        }
        _ => None,
    }
}

fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() {
        return 0;
    }
    (value.trunc().rem_euclid(4_294_967_296.0)) as u32
}

fn to_int32(value: f64) -> i32 {
    to_uint32(value) as i32
}

/// Rewrites `Dir.Up` reads to their folded literal, and drops the runtime object
/// oxc emitted for the const enum.
struct ConstEnumInliner<'a, 'v> {
    allocator: &'a Allocator,
    builder: oxc_ast::builder::AstBuilder<'a>,
    values: &'v HashMap<String, HashMap<String, EnumValue>>,
}

impl<'a> oxc_ast_visit::VisitMut<'a> for ConstEnumInliner<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        oxc_ast_visit::walk_mut::walk_expression(self, expression);
        let Expression::StaticMemberExpression(member) = expression else {
            return;
        };
        let Expression::Identifier(object) = &member.object else {
            return;
        };
        let Some(members) = self.values.get(object.name.as_str()) else {
            return;
        };
        let Some(value) = members.get(member.property.name.as_str()) else {
            return;
        };
        *expression = match value {
            EnumValue::Number(number) => {
                // Negative values are a unary expression, not a literal.
                if *number < 0.0 {
                    let literal = Expression::new_numeric_literal(
                        oxc_span::SPAN,
                        -number,
                        None,
                        oxc_syntax::number::NumberBase::Decimal,
                        &self.builder,
                    );
                    Expression::new_unary_expression(
                        oxc_span::SPAN,
                        UnaryOperator::UnaryNegation,
                        literal,
                        &self.builder,
                    )
                } else {
                    Expression::new_numeric_literal(
                        oxc_span::SPAN,
                        *number,
                        None,
                        oxc_syntax::number::NumberBase::Decimal,
                        &self.builder,
                    )
                }
            }
            EnumValue::String(text) => {
                let value: oxc_str::Str<'a> =
                    oxc_allocator::FromIn::from_in(text.as_str(), self.allocator);
                Expression::new_string_literal(oxc_span::SPAN, value, None, &self.builder)
            }
        };
    }
}

/// Drops the lowered runtime object for every const enum we inlined.
///
/// TypeScript erases a `const enum`; oxc emits the object anyway, and leaving it
/// would ship bytes no legal program can reach *and* make the erased value
/// observable (`import * as m; m.ConstEnum` would return an object where `tsc`
/// gives `undefined`) -- the divergence the tsickle export corpus caught.
fn erase_const_enum_objects(
    program: &mut Program<'_>,
    inlined: &HashMap<String, HashMap<String, EnumValue>>,
) {
    program.body.retain(|statement| {
        let declared = match statement {
            Statement::VariableDeclaration(declaration) => declaration
                .declarations
                .first()
                .and_then(|declarator| declarator.id.get_binding_identifier())
                .map(|binding| binding.name.to_string()),
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_ref() {
                Some(Declaration::VariableDeclaration(declaration)) => declaration
                    .declarations
                    .first()
                    .and_then(|declarator| declarator.id.get_binding_identifier())
                    .map(|binding| binding.name.to_string()),
                _ => None,
            },
            _ => None,
        };
        declared.is_none_or(|name| !inlined.contains_key(&name))
    });
}

#[cfg(test)]
mod const_enums {
    use super::*;

    /// The values OXD0 pinned on the swc folder, re-asserted on this one. The
    /// two folders must agree: a disagreement is the silent-divergence class the
    /// safety net exists for.
    #[test]
    fn constant_expression_members_fold_to_the_same_values_as_the_swc_folder() {
        let allocator = Allocator::default();
        let source = "const enum Dir { Up = 1, Down = 1 + Up, Both = Down << 2, Neg = -Down, Mask = Both | Dir.Up, Half = (Both + 2) / 5, Next }\n";
        let parsed = oxc_parser::Parser::new(&allocator, source, SourceType::ts()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let values = collect_const_enum_values(&parsed.program);
        let dir = values.get("Dir").expect("Dir folded");

        // Up=1, Down=2, Both=8, Neg=-2, Mask=9, Half=2, Next=3 -- auto-numbering
        // resumes from the folded value, exactly as TypeScript does.
        assert_eq!(dir.get("Up"), Some(&EnumValue::Number(1.0)));
        assert_eq!(dir.get("Down"), Some(&EnumValue::Number(2.0)));
        assert_eq!(dir.get("Both"), Some(&EnumValue::Number(8.0)));
        assert_eq!(dir.get("Neg"), Some(&EnumValue::Number(-2.0)));
        assert_eq!(dir.get("Mask"), Some(&EnumValue::Number(9.0)));
        assert_eq!(dir.get("Half"), Some(&EnumValue::Number(2.0)));
        assert_eq!(dir.get("Next"), Some(&EnumValue::Number(3.0)));
    }

    #[test]
    fn string_members_fold() {
        let allocator = Allocator::default();
        let parsed =
            oxc_parser::Parser::new(&allocator, "const enum L { S = \"s\" }\n", SourceType::ts())
                .parse();
        let values = collect_const_enum_values(&parsed.program);
        assert_eq!(
            values.get("L").and_then(|members| members.get("S")),
            Some(&EnumValue::String("s".to_string()))
        );
    }

    #[test]
    fn a_plain_enum_is_not_a_const_enum() {
        let allocator = Allocator::default();
        let parsed =
            oxc_parser::Parser::new(&allocator, "enum Plain { A = 1 }\n", SourceType::ts()).parse();
        assert!(collect_const_enum_values(&parsed.program).is_empty());
    }
}

#[cfg(test)]
mod const_enum_end_to_end {
    //! The gate for "enum inlining ours end-to-end": emit through the real oxc
    //! pipeline and run it. A const enum has no runtime object, so if the reads
    //! were not inlined this throws instead of returning values.
    use super::*;
    use std::process::Command;

    fn run(source: &str) -> String {
        let code = lower_with_oxc(Path::new("m.ts"), source).expect("lowering");
        let dir = std::env::temp_dir().join(format!(
            "gcc-oxc-enum-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("m.mjs");
        std::fs::write(
            &file,
            format!("{code}\nconsole.log(JSON.stringify(probe));\n"),
        )
        .unwrap();
        let output = Command::new("node").arg(&file).output().expect("node");
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            output.status.success(),
            "node failed: {stderr}\n--- emitted:\n{code}"
        );
        stdout
    }

    #[test]
    fn const_enum_reads_inline_and_the_object_is_erased() {
        let probe = run(concat!(
            "const enum Dir { Up = 1, Down = 1 + Up, Both = Down << 2, Neg = -Down, Mask = Both | Dir.Up, Half = (Both + 2) / 5, Next }\n",
            "const enum L { S = \"s\" }\n",
            "export const probe = [Dir.Up, Dir.Down, Dir.Both, Dir.Neg, Dir.Mask, Dir.Half, Dir.Next, L.S, typeof Dir].join(\"|\");\n",
        ));
        // Values identical to the swc pipeline's, and `typeof Dir` proves the
        // runtime object is gone rather than merely unused.
        assert_eq!(probe, "\"1|2|8|-2|9|2|3|s|undefined\"");
    }
}

#[cfg(test)]
mod namespaces {
    //! Namespace shapes against what the OX-A end-to-end test requires.
    //!
    //! The swc side needed an owned pre-strip pass here: `strip` qualifies a
    //! member reference only inside the block that declares it, so a *merged*
    //! second `namespace A { … }` block emitted bare reads that Closure rejected
    //! (JSC_UNDEFINED_VARIABLE). Whether oxc has the same gap is measured, not
    //! assumed.
    use super::*;
    use std::process::Command;

    fn run(source: &str) -> String {
        let code = lower_with_oxc(Path::new("m.ts"), source).expect("lowering");
        let dir = std::env::temp_dir().join(format!(
            "gcc-oxc-ns-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("m.mjs");
        std::fs::write(
            &file,
            format!("{code}\nconsole.log(JSON.stringify(probe));\n"),
        )
        .unwrap();
        let output = Command::new("node").arg(&file).output().expect("node");
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            output.status.success(),
            "node failed: {stderr}\n--- emitted:\n{code}"
        );
        stdout
    }

    /// The nesting the OX-A test exercises: three levels, a sibling reference
    /// inside a namespace, and an alias out of the middle of the chain.
    #[test]
    fn a_nested_namespace_chain_executes() {
        let probe = run(concat!(
            "export namespace Outer {\n",
            "  export const version = 3;\n",
            "  export namespace Inner {\n",
            "    export const tag = 'INNER';\n",
            "    export function twice(value: number): number { return value * 2; }\n",
            "    export namespace Deep {\n",
            "      export function thrice(value: number): number { return twice(value) + value; }\n",
            "    }\n",
            "  }\n",
            "  export function describe(): string { return `${version}:${Inner.tag}`; }\n",
            "}\n",
            "export const probe = [Outer.version, Outer.Inner.tag, Outer.Inner.twice(4), Outer.Inner.Deep.thrice(4), Outer.describe()].join('|');\n",
        ));
        assert_eq!(probe, "\"3|INNER|8|12|3:INNER\"");
    }

    /// Declaration merging: the case that needed the owned pre-strip merge on
    /// swc. The second block's body must see the first block's members.
    #[test]
    fn merged_declaration_blocks_execute() {
        let probe = run(concat!(
            "export namespace Outer {\n",
            "  export const version = 3;\n",
            "  export namespace Inner {\n",
            "    export function twice(value: number): number { return value * 2; }\n",
            "  }\n",
            "}\n",
            "export namespace Outer {\n",
            "  export function versionTwice(): number { return Inner.twice(version); }\n",
            "}\n",
            "export const probe = [Outer.version, Outer.versionTwice()].join('|');\n",
        ));
        assert_eq!(probe, "\"3|6\"");
    }
}

#[cfg(test)]
mod namespace_merge_guards {
    //! The conservative gate, same as the swc pass: merging must not reorder
    //! observable work, and must not guess on a mixed group.
    use super::*;

    #[test]
    fn a_statement_between_blocks_blocks_the_merge() {
        let code = lower_with_oxc(
            Path::new("m.ts"),
            "export namespace A { export const v = 1; }\nconsole.log('between');\nexport namespace A { export function r(): number { return 7; } }\n",
        )
        .unwrap();
        // Two IIFEs still, in source order: the console.log did not move.
        let between = code.find("between").expect("kept");
        let second = code
            .rfind("A ||")
            .or_else(|| code.rfind("A)"))
            .expect("second block");
        assert!(between < second, "{code}");
    }

    #[test]
    fn a_mixed_export_group_is_left_alone() {
        let code = lower_with_oxc(
            Path::new("m.ts"),
            "namespace A { export const v = 1; }\nexport namespace A { export const w = 2; }\n",
        )
        .unwrap();
        assert!(code.contains("A"), "{code}");
    }

    #[test]
    fn a_nested_split_merges_one_level_down() {
        let code = lower_with_oxc(
            Path::new("m.ts"),
            "export namespace O { export namespace I { export const a = 1; } }\nexport function between(): number { return 1; }\nexport namespace O { export namespace I { export const b = 2; } }\n",
        )
        .unwrap();
        // One IIFE per namespace, not two: the inner pair became siblings only
        // after the outer merge, which is why the pass recurses afterwards.
        assert_eq!(code.matches("(O ||").count(), 1, "{code}");
    }
}

// ---------------------------------------------------------------------------
// M3 groundwork: the comments policy that replaces `pure_calls.rs`
// ---------------------------------------------------------------------------
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
        let allocator = Allocator::default();
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
// panics on a synthesised node, so `identity_oxc::key_of_reference` reads the
// `Cell` directly and is total. Pinned in `identity_oxc.rs`.

#[cfg(test)]
mod upstream_defect_guards {
    use super::*;

    /// Finding 1, pinned: lowering an enum must not panic.
    ///
    /// This is a guard against *our* configuration regressing, not against oxc:
    /// drop `with_enum_eval(true)` from `lower_with_oxc` and this test dies with
    /// the upstream panic instead of failing an assertion, which is exactly the
    /// signal wanted — the failure mode in production would be identical.
    #[test]
    fn with_enum_eval_is_required_and_we_set_it() {
        let code = lower_with_oxc(
            Path::new("m.ts"),
            "export enum Kind { A = 1 }\nenum Plain { B = 2 }\nconst enum C { D = 3 }\nexport const use = C.D;\n",
        )
        .expect("enum lowering must not panic");
        assert!(code.contains("export var Kind"), "{code}");
        assert!(code.contains("var Plain"), "{code}");
        // The const enum is inlined and erased, so neither the object nor a
        // member read survives.
        assert!(!code.contains("var C "), "{code}");
        assert!(code.contains("export const use = 3"), "{code}");
    }
}
