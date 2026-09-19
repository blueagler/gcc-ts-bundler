use oxc_allocator::Allocator;
use oxc_allocator::FromIn;
use oxc_allocator::Vec as ArenaVec;
use oxc_ast::ast::{
    BindingIdentifier, Expression, IdentifierReference, NewExpression, PrivateIdentifier, Program,
    StaticMemberExpression,
};
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_semantic::SemanticBuilder;
use oxc_span::{SourceType, Span};
use oxc_str::Ident;
use std::collections::{BTreeSet, HashSet};
use std::path::Path;

const PRIVATE_CLASS_HELPERS: &str = r#"
class gccPrivateSlot {
  constructor() {
    this.key = Symbol();
  }
  has(receiver) {
    return this.key in receiver;
  }
  get(receiver) {
    return receiver[this.key];
  }
  set(receiver, value) {
    if (this.key in receiver) {
      receiver[this.key] = value;
    } else {
      Object.defineProperty(receiver, this.key, { writable: true, value });
    }
    return this;
  }
  add(receiver) {
    Object.defineProperty(receiver, this.key, { value: true });
    return this;
  }
}
const babelHelpers = {
  assertClassBrand(brand, receiver, value) {
    if (typeof brand === "function" ? brand === receiver : brand.has(receiver)) {
      return arguments.length < 3 ? receiver : value;
    }
    throw new TypeError("Private element is not present on this object");
  },
  checkInRHS(value) {
    if (Object(value) !== value) {
      throw new TypeError("right-hand side of 'in' should be an object, got " + (value !== null ? typeof value : "null"));
    }
    return value;
  },
  classPrivateFieldGet2(state, receiver) {
    return state.get(babelHelpers.assertClassBrand(state, receiver));
  },
  classPrivateFieldInitSpec(receiver, state, value) {
    if (state.has(receiver)) {
      throw new TypeError("Cannot initialize the same private elements twice on an object");
    }
    state.set(receiver, value);
  },
  classPrivateFieldSet2(state, receiver, value) {
    state.set(babelHelpers.assertClassBrand(state, receiver), value);
    return value;
  },
  classPrivateMethodInitSpec(receiver, brand) {
    if (brand.has(receiver)) {
      throw new TypeError("Cannot initialize the same private elements twice on an object");
    }
    brand.add(receiver);
  },
  defineProperty(object, key, value) {
    key = babelHelpers.toPropertyKey(key);
    if (key in object) {
      Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
    } else {
      object[key] = value;
    }
    return object;
  },
  readOnlyError(name) {
    throw new TypeError('"' + name + '" is read-only');
  },
  writeOnlyError(name) {
    throw new TypeError('"' + name + '" is write-only');
  },
  toPropertyKey(value) {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      const exotic = value[Symbol.toPrimitive];
      if (exotic !== undefined) {
        value = exotic.call(value, "string");
        if ((typeof value === "object" && value !== null) || typeof value === "function") {
          throw new TypeError("@@toPrimitive must return a primitive value.");
        }
      } else {
        value = String(value);
      }
    }
    return typeof value === "symbol" ? value : value + "";
  },
  toSetter(callback, args, receiver) {
    args ||= [];
    const index = args.length++;
    return { set _(value) { args[index] = value; callback.apply(receiver, args); } };
  },
  superPropGet(target, property, receiver, flags) {
    target = Object.getPrototypeOf(flags & 1 ? target.prototype : target);
    const value = Reflect.get(target, property, receiver);
    return flags & 2 && typeof value === "function" ? (args) => value.apply(receiver, args) : value;
  },
  superPropSet(target, property, value, receiver, strict, isProto) {
    target = Object.getPrototypeOf(isProto ? target.prototype : target);
    if (!Reflect.set(target, property, value, receiver) && strict) {
      throw new TypeError("failed to set property");
    }
    return value;
  },
};
"#;

struct SynthesizedSpanOffset {
    offset: u32,
}

impl VisitMut<'_> for SynthesizedSpanOffset {
    fn visit_span(&mut self, span: &mut Span) {
        span.start = span.start.saturating_add(self.offset);
        span.end = span.end.saturating_add(self.offset);
    }
}

#[derive(Default)]
struct PrivateElementDetector {
    found: bool,
    has_reserved_binding: bool,
    authored_weak_collection_news: HashSet<(u32, u32)>,
}

impl<'a> Visit<'a> for PrivateElementDetector {
    fn visit_private_identifier(&mut self, _identifier: &PrivateIdentifier<'a>) {
        self.found = true;
    }

    fn visit_binding_identifier(&mut self, identifier: &BindingIdentifier<'a>) {
        if matches!(identifier.name.as_str(), "babelHelpers" | "gccPrivateSlot") {
            self.has_reserved_binding = true;
        }
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if matches!(identifier.name.as_str(), "babelHelpers" | "gccPrivateSlot") {
            self.has_reserved_binding = true;
        }
    }

    fn visit_new_expression(&mut self, expression: &NewExpression<'a>) {
        if matches!(
            &expression.callee,
            Expression::Identifier(identifier)
                if matches!(identifier.name.as_str(), "WeakMap" | "WeakSet")
        ) {
            self.authored_weak_collection_news
                .insert((expression.span.start, expression.span.end));
        }
        walk::walk_new_expression(self, expression);
    }
}

pub(super) struct PrivateClassLowering {
    pub(super) authored_weak_collection_news: HashSet<(u32, u32)>,
}

pub(super) struct PrivateSlotConstructorRewriter<'a, 'plan> {
    pub(super) allocator: &'a Allocator,
    pub(super) authored_weak_collection_news: &'plan HashSet<(u32, u32)>,
}

impl<'a> VisitMut<'a> for PrivateSlotConstructorRewriter<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::NewExpression(new_expression) = expression else {
            return;
        };
        if self
            .authored_weak_collection_news
            .contains(&(new_expression.span.start, new_expression.span.end))
        {
            return;
        }
        let Expression::Identifier(callee) = &mut new_expression.callee else {
            return;
        };
        if matches!(callee.name.as_str(), "WeakMap" | "WeakSet") {
            callee.name = Ident::from_in("gccPrivateSlot", self.allocator);
        }
    }
}

pub(super) fn prepare_private_class_lowering<'a>(
    allocator: &'a Allocator,
    path: &Path,
    program: &mut Program<'a>,
    scoping: oxc_semantic::Scoping,
) -> Result<(Option<PrivateClassLowering>, oxc_semantic::Scoping), String> {
    let mut detector = PrivateElementDetector::default();
    detector.visit_program(program);
    if !detector.found {
        return Ok((None, scoping));
    }
    if detector.has_reserved_binding {
        return Err(format!(
            "Private class element lowering cannot safely inject its reserved bindings because {} already references babelHelpers or gccPrivateSlot",
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
    Ok((
        Some(PrivateClassLowering {
            authored_weak_collection_news: detector.authored_weak_collection_news,
        }),
        semantic.semantic.into_scoping(),
    ))
}

pub(super) fn validate_private_class_helpers(
    program: &Program<'_>,
    path: &Path,
) -> Result<(), String> {
    #[derive(Default)]
    struct HelperValidator {
        unsupported: BTreeSet<String>,
    }

    impl<'a> Visit<'a> for HelperValidator {
        fn visit_static_member_expression(&mut self, member: &StaticMemberExpression<'a>) {
            if matches!(&member.object, Expression::Identifier(object) if object.name == "babelHelpers")
            {
                let name = member.property.name.as_str();
                if !matches!(
                    name,
                    "assertClassBrand"
                        | "checkInRHS"
                        | "classPrivateFieldGet2"
                        | "classPrivateFieldInitSpec"
                        | "classPrivateFieldSet2"
                        | "classPrivateMethodInitSpec"
                        | "defineProperty"
                        | "readOnlyError"
                        | "superPropGet"
                        | "superPropSet"
                        | "toPropertyKey"
                        | "toSetter"
                        | "writeOnlyError"
                ) {
                    self.unsupported.insert(name.to_string());
                }
                return;
            }
            walk::walk_static_member_expression(self, member);
        }

        fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
            // External mode emits static helper members. Any other namespace
            // use is unknown, not evidence that the runtime can service it.
            if identifier.name == "babelHelpers" {
                self.unsupported
                    .insert("non-static babelHelpers reference".to_string());
            }
        }
    }

    // Authored references were rejected before injecting the runtime, so every
    // remaining namespace reference belongs to the runtime or Oxc's lowering.
    let mut validator = HelperValidator::default();
    validator.visit_program(program);
    if validator.unsupported.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Private class element lowering requested unsupported Oxc helpers in {}: {}",
            path.display(),
            validator
                .unsupported
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::validate_private_class_helpers;
    use crate::transpile::lowering::lower_with_oxc;
    use oxc_allocator::Allocator;
    use oxc_span::SourceType;
    use std::path::Path;

    #[test]
    fn unsupported_generated_helper_is_rejected() {
        let allocator = Allocator::default();
        let parsed = oxc_parser::Parser::new(
            &allocator,
            "babelHelpers.objectSpread2({}, source);",
            SourceType::mjs(),
        )
        .parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        assert!(validate_private_class_helpers(&parsed.program, Path::new("private.js")).is_err());
    }

    #[test]
    fn authored_helper_namespace_cannot_be_injected_over() {
        assert!(lower_with_oxc(
            Path::new("private.ts"),
            "const babelHelpers = {}; class Box { #value = 1; read() { return this.#value; } }",
        )
        .is_err());
    }
}
