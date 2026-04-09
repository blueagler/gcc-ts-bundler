use std::collections::HashMap;
use std::path::PathBuf;

use swc_core::common::{sync::Lrc, SourceMap};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::visit::{VisitMut, VisitMutWith};

use crate::commonjs::evaluate_boolean_expr;
use crate::module_cache::parse_module;

pub fn rewrite_decorator_metadata(
    code: String,
    property_renaming_report: String,
) -> std::result::Result<String, String> {
    if property_renaming_report.trim().is_empty()
        || !code.contains("kind:")
        || !code.contains("name:")
    {
        return Ok(code);
    }

    let renames = parse_property_renaming_report(&property_renaming_report);
    if renames.is_empty() {
        return Ok(code);
    }

    let mut module = parse_module(&PathBuf::from("decorator-bundle.js"), &code)?;
    let mut rewriter = DecoratorMetadataRewriter {
        changed: false,
        renames: &renames,
    };
    module.visit_mut_with(&mut rewriter);
    if !rewriter.changed {
        return Ok(code);
    }

    print_module_minified(&module)
}

fn parse_property_renaming_report(report: &str) -> HashMap<String, String> {
    let mut renames = HashMap::new();
    for line in report.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((original, renamed)) = trimmed.split_once(':') else {
            continue;
        };
        if !original.is_empty() && !renamed.is_empty() {
            renames.insert(original.to_string(), renamed.to_string());
        }
    }
    renames
}

struct DecoratorMetadataRewriter<'a> {
    changed: bool,
    renames: &'a HashMap<String, String>,
}

impl DecoratorMetadataRewriter<'_> {
    fn maybe_rewrite_metadata_object(&mut self, object: &mut ObjectLit) {
        let Some(kind) = get_string_property_value(object, "kind") else {
            return;
        };
        if !matches!(
            kind.as_str(),
            "accessor" | "field" | "getter" | "method" | "setter"
        ) {
            return;
        }
        if matches!(get_boolean_property_value(object, "private"), Some(true)) {
            return;
        }
        let Some(original_name) = get_string_property_value(object, "name") else {
            return;
        };
        let Some(renamed) = self.renames.get(&original_name).cloned() else {
            return;
        };
        if renamed == original_name {
            return;
        }

        if set_string_property_value(object, "name", &renamed) {
            self.changed = true;
        }
        if let Some(access) = get_object_property_value_mut(object, "access") {
            let mut rewriter = DecoratorAccessHasRewriter {
                changed: false,
                original_name: &original_name,
                renamed_name: &renamed,
            };
            access.visit_mut_with(&mut rewriter);
            self.changed |= rewriter.changed;
        }
    }
}

impl VisitMut for DecoratorMetadataRewriter<'_> {
    fn visit_mut_call_expr(&mut self, call_expr: &mut CallExpr) {
        call_expr.visit_mut_children_with(self);

        for argument in &mut call_expr.args {
            if let Expr::Object(object) = &mut *argument.expr {
                self.maybe_rewrite_metadata_object(object);
            }
        }
    }
}

struct DecoratorAccessHasRewriter<'a> {
    changed: bool,
    original_name: &'a str,
    renamed_name: &'a str,
}

impl VisitMut for DecoratorAccessHasRewriter<'_> {
    fn visit_mut_bin_expr(&mut self, bin_expr: &mut BinExpr) {
        bin_expr.visit_mut_children_with(self);

        if bin_expr.op != BinaryOp::In {
            return;
        }
        let Expr::Lit(Lit::Str(value)) = &mut *bin_expr.left else {
            return;
        };
        if value.value.to_string_lossy() != self.original_name {
            return;
        }

        value.value = self.renamed_name.into();
        self.changed = true;
    }
}

fn get_object_property_value_mut<'a>(
    object: &'a mut ObjectLit,
    property_name: &str,
) -> Option<&'a mut ObjectLit> {
    for property in &mut object.props {
        let PropOrSpread::Prop(prop) = property else {
            continue;
        };
        let Prop::KeyValue(key_value) = prop.as_mut() else {
            continue;
        };
        if prop_name_to_string(&key_value.key).as_deref() != Some(property_name) {
            continue;
        }
        let Expr::Object(value) = &mut *key_value.value else {
            return None;
        };
        return Some(value);
    }
    None
}

fn get_boolean_property_value(object: &ObjectLit, property_name: &str) -> Option<bool> {
    for property in &object.props {
        let PropOrSpread::Prop(prop) = property else {
            continue;
        };
        let Prop::KeyValue(key_value) = prop.as_ref() else {
            continue;
        };
        if prop_name_to_string(&key_value.key).as_deref() != Some(property_name) {
            continue;
        }
        return evaluate_boolean_expr(&key_value.value);
    }
    None
}

fn get_string_property_value(object: &ObjectLit, property_name: &str) -> Option<String> {
    for property in &object.props {
        let PropOrSpread::Prop(prop) = property else {
            continue;
        };
        let Prop::KeyValue(key_value) = prop.as_ref() else {
            continue;
        };
        if prop_name_to_string(&key_value.key).as_deref() != Some(property_name) {
            continue;
        }
        let Expr::Lit(Lit::Str(value)) = &*key_value.value else {
            return None;
        };
        return Some(value.value.to_string_lossy().to_string());
    }
    None
}

fn prop_name_to_string(prop_name: &PropName) -> Option<String> {
    match prop_name {
        PropName::Ident(ident) => Some(ident.sym.to_string()),
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Num(value) => Some(value.value.to_string()),
        _ => None,
    }
}

fn set_string_property_value(
    object: &mut ObjectLit,
    property_name: &str,
    next_value: &str,
) -> bool {
    for property in &mut object.props {
        let PropOrSpread::Prop(prop) = property else {
            continue;
        };
        let Prop::KeyValue(key_value) = prop.as_mut() else {
            continue;
        };
        if prop_name_to_string(&key_value.key).as_deref() != Some(property_name) {
            continue;
        }
        let Expr::Lit(Lit::Str(value)) = &mut *key_value.value else {
            return false;
        };
        value.value = next_value.into();
        return true;
    }
    false
}

fn print_module_minified(module: &Module) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: CodegenConfig::default().with_minify(true),
            cm,
            comments: None,
            wr: writer,
        };
        emitter
            .emit_module(module)
            .map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::rewrite_decorator_metadata;

    #[test]
    fn rewrites_decorator_metadata_names_and_access_has_checks() {
        let output = rewrite_decorator_metadata(
            "function g(A,y,d,b,e,n){return b}g(b,null,e,{kind:\"accessor\",name:\"letters\",static:!1,private:!1,access:{has:H=>\"letters\"in H,get:H=>H.J,set:(H,J)=>{H.J=J}},metadata:D},n,z);".to_string(),
            "letters:J\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("name:\"J\""), "{output}");
        assert!(output.contains("\"J\"in H"), "{output}");
    }

    #[test]
    fn leaves_unrelated_string_literals_untouched() {
        let output = rewrite_decorator_metadata(
            "console.log(\"letters\");g(b,null,e,{kind:\"accessor\",name:\"letters\",static:!1,private:!1,access:{has:H=>\"letters\"in H,get:H=>H.J,set:(H,J)=>{H.J=J}},metadata:D},n,z);".to_string(),
            "letters:J\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("console.log(\"letters\")"), "{output}");
        assert!(output.contains("name:\"J\""), "{output}");
    }

    #[test]
    fn skips_metadata_without_string_literal_names() {
        let input =
            "g(null,y={value:b},A,{kind:\"class\",name:b.name,metadata:D},null,d);".to_string();
        let output =
            rewrite_decorator_metadata(input.clone(), "letters:J\n".to_string()).expect("rewrite");

        assert_eq!(output, input);
    }
}
