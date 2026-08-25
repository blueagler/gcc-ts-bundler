use std::collections::HashMap;
use std::path::{Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_allocator::FromIn;
use oxc_ast::ast::{Argument, Expression};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_parser::Parser;
use oxc_span::SourceType;
use oxc_span::SPAN;
use oxc_str::Str;

use super::super::super::lowering::EnumValue;
use super::super::super::{
    resolve_relative_module, to_bundler_runtime_module_id, ChunkMode, LazyImportInput,
    TranspileContext,
};

pub(crate) fn rewrite_dynamic_imports<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    file_path: &Path,
    context: &TranspileContext,
) {
    if context.chunk_mode == ChunkMode::Off {
        return;
    }
    let Some(imports) = context
        .lazy_imports_by_file
        .get(&file_path.to_string_lossy().to_string())
    else {
        return;
    };
    DynamicImportRewriter {
        allocator,
        builder: AstBuilder::new(allocator),
        imports,
    }
    .visit_program(program);
}

struct DynamicImportRewriter<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    imports: &'i [LazyImportInput],
}

impl<'a> VisitMut<'a> for DynamicImportRewriter<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::ImportExpression(import) = expression else {
            return;
        };
        let specifier = match &import.source {
            Expression::StringLiteral(literal) => literal.value.as_str(),
            Expression::TemplateLiteral(template)
                if template.expressions.is_empty() && template.quasis.len() == 1 =>
            {
                template.quasis[0]
                    .value
                    .cooked
                    .as_ref()
                    .unwrap_or(&template.quasis[0].value.raw)
                    .as_str()
            }
            _ => return,
        };
        let Some(lazy_import) = self
            .imports
            .iter()
            .find(|entry| entry.specifier == specifier)
        else {
            return;
        };
        let module_id = Expression::new_string_literal(
            SPAN,
            Str::from_in(
                &to_bundler_runtime_module_id(&lazy_import.moduleId),
                self.allocator,
            ),
            None,
            &self.builder,
        );
        *expression = Expression::new_call_expression(
            SPAN,
            Expression::new_identifier(SPAN, "__dynamicImport", &self.builder),
            None::<oxc_allocator::Box<'a, oxc_ast::ast::TSTypeParameterInstantiation<'a>>>,
            oxc_allocator::Vec::from_value_in(Argument::from(module_id), &self.allocator),
            false,
            &self.builder,
        );
    }
}

pub(crate) fn collect_imported_enum_values(
    file_path: &Path,
    program: &oxc_ast::ast::Program<'_>,
) -> HashMap<String, HashMap<String, EnumValue>> {
    let mut imported = HashMap::new();
    for statement in &program.body {
        let oxc_ast::ast::Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        let specifier = import.source.value.as_str();
        if !specifier.starts_with('.') {
            continue;
        }
        let Some(resolved_path) = resolve_relative_module(file_path, specifier) else {
            continue;
        };
        let mut target_values = enum_values_from_file(&resolved_path);
        if target_values.is_empty() {
            for candidate in enum_metadata_candidate_paths(&resolved_path) {
                target_values = enum_values_from_file(&candidate);
                if !target_values.is_empty() {
                    break;
                }
            }
        }
        let Some(specifiers) = &import.specifiers else {
            continue;
        };
        for specifier in specifiers {
            let oxc_ast::ast::ImportDeclarationSpecifier::ImportSpecifier(named) = specifier else {
                continue;
            };
            let imported_name = match &named.imported {
                oxc_ast::ast::ModuleExportName::IdentifierName(identifier) => {
                    identifier.name.as_str()
                }
                oxc_ast::ast::ModuleExportName::IdentifierReference(identifier) => {
                    identifier.name.as_str()
                }
                oxc_ast::ast::ModuleExportName::StringLiteral(literal) => literal.value.as_str(),
            };
            if let Some(members) = target_values.get(imported_name) {
                imported.insert(named.local.name.to_string(), members.clone());
            }
        }
    }
    imported
}

fn enum_values_from_file(path: &Path) -> HashMap<String, HashMap<String, EnumValue>> {
    let Ok(source) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(source_type) = SourceType::from_path(path) else {
        return HashMap::new();
    };
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &source, source_type.with_module(true)).parse();
    if !parsed.diagnostics.is_empty() {
        return HashMap::new();
    }
    super::super::super::lowering::collect_enum_values(&parsed.program)
}

fn enum_metadata_candidate_paths(resolved_path: &Path) -> Vec<PathBuf> {
    if resolved_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("js")
    {
        return Vec::new();
    }
    let mut candidates = vec![resolved_path.with_extension("d.ts")];
    let resolved = resolved_path.to_string_lossy();
    if resolved.contains("/dist/esm/") {
        let source = resolved.replace("/dist/esm/", "/src/");
        candidates.push(PathBuf::from(&source).with_extension("ts"));
        candidates.push(PathBuf::from(source).with_extension("tsx"));
    }
    candidates
}
