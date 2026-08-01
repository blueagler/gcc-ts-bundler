use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::{AssignmentExpression, AssignmentTarget, Program, Statement};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;

/// The only authored Closure annotation allowed through native emission.
///
/// Capture creates this annotation only for the conservative temporary-class
/// alias shape. The native emitter keeps it only when it is attached to a
/// static member assignment, so unrelated authored JSDoc remains unavailable
/// to Closure.
#[derive(Default)]
pub(crate) struct NocollapseAssignments {
    annotated_starts: HashSet<u32>,
}

impl NocollapseAssignments {
    pub(crate) fn collect(program: &Program<'_>) -> Self {
        Self {
            annotated_starts: program
                .comments
                .iter()
                .filter(|comment| is_nocollapse_comment(program.source_text, comment))
                .map(|comment| comment.attached_to)
                .collect(),
        }
    }

    pub(crate) fn annotate_rendered_statement(
        &self,
        statement: &Statement<'_>,
        code: String,
    ) -> std::result::Result<String, String> {
        let mut collector = StaticMemberAssignmentCollector {
            annotated_indices: Vec::new(),
            annotated_starts: &self.annotated_starts,
            static_member_assignment_count: 0,
        };
        collector.visit_statement(statement);
        if collector.annotated_indices.is_empty() {
            return Ok(code);
        }
        inject_nocollapse_assignments(code, &collector.annotated_indices)
    }
}

fn is_nocollapse_comment(source: &str, comment: &oxc_ast::Comment) -> bool {
    if !comment.is_jsdoc() {
        return false;
    }
    let Some(raw) = source.get(comment.span.start as usize..comment.span.end as usize) else {
        return false;
    };
    let Some(body) = raw
        .strip_prefix("/**")
        .and_then(|body| body.strip_suffix("*/"))
    else {
        return false;
    };
    body.trim().trim_start_matches('*').trim() == "@nocollapse"
}

struct StaticMemberAssignmentCollector<'a> {
    annotated_indices: Vec<usize>,
    annotated_starts: &'a HashSet<u32>,
    static_member_assignment_count: usize,
}

impl<'a> Visit<'a> for StaticMemberAssignmentCollector<'_> {
    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        walk::walk_assignment_expression(self, assignment);
        if !matches!(
            &assignment.left,
            AssignmentTarget::StaticMemberExpression(_)
        ) {
            return;
        }
        if self.annotated_starts.contains(&assignment.span.start) {
            self.annotated_indices
                .push(self.static_member_assignment_count);
        }
        self.static_member_assignment_count += 1;
    }
}

fn inject_nocollapse_assignments(
    code: String,
    indices: &[usize],
) -> std::result::Result<String, String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &code, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"));
    }

    let static_assignment_starts = collect_static_member_assignment_starts(&parsed.program);
    let mut insertion_points = Vec::with_capacity(indices.len());
    for &index in indices {
        let Some(start) = static_assignment_starts.get(index) else {
            return Err(format!(
                "Unable to propagate @nocollapse to static member assignment {index}"
            ));
        };
        insertion_points.push(*start as usize);
    }

    let mut annotated = code;
    for start in insertion_points.into_iter().rev() {
        annotated.insert_str(start, "/** @nocollapse */ ");
    }
    Ok(annotated)
}

fn collect_static_member_assignment_starts(program: &Program<'_>) -> Vec<u32> {
    #[derive(Default)]
    struct Collector {
        starts: Vec<u32>,
    }

    impl<'a> Visit<'a> for Collector {
        fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
            walk::walk_assignment_expression(self, assignment);
            if matches!(
                &assignment.left,
                AssignmentTarget::StaticMemberExpression(_)
            ) {
                self.starts.push(assignment.span.start);
            }
        }
    }

    let mut collector = Collector::default();
    collector.visit_program(program);
    collector.starts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn propagates_only_nocollapse_on_static_member_assignments() {
        let allocator = Allocator::default();
        let source = concat!(
            "var _a;\n",
            "let C = (_a = class {}, /** @nocollapse */ _a.value = \"retained\", _a);\n",
            "/** @nocollapse */ C.other = \"not a capture annotation\";\n",
            "/** @type {string} */ C.hostile = \"dropped\";\n",
        );
        let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let annotations = NocollapseAssignments::collect(&parsed.program);
        let statement = &parsed.program.body[1];
        let rendered = "let C = (_a = class {}, _a.value = \"retained\", _a);";
        let annotated = annotations
            .annotate_rendered_statement(statement, rendered.to_string())
            .unwrap();
        assert!(
            annotated.contains("/** @nocollapse */ _a.value"),
            "{annotated}"
        );
        assert!(!annotated.contains("hostile"), "{annotated}");
    }
}
