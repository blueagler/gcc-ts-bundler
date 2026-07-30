//! Parity + speed probe: swc (repo-pinned versions) vs oxc 0.142.
//! Usage: gcc-oxc-probe <file-list.txt> <out-dir> [--bench N]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

// ---------- swc pipeline (mirrors native/src pipeline: parse -> resolver -> [jsx] -> strip -> print) ----------

fn swc_pipeline(path: &Path, source: &str, normalize_parens: bool) -> Result<String, String> {
    use swc_core::common::{sync::Lrc, FileName, Globals, Mark, SourceMap, GLOBALS};
    use swc_core::ecma::ast::Program;
    use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
    use swc_core::ecma::parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax, TsSyntax};
    use swc_core::ecma::visit::VisitMutWith;

    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(
        FileName::Real(path.to_path_buf()).into(),
        source.to_string(),
    );
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let syntax = match ext {
        "ts" | "mts" => Syntax::Typescript(TsSyntax {
            tsx: false,
            decorators: true,
            ..Default::default()
        }),
        "tsx" => Syntax::Typescript(TsSyntax {
            tsx: true,
            decorators: true,
            ..Default::default()
        }),
        _ => Syntax::Es(EsSyntax {
            jsx: ext == "jsx",
            ..Default::default()
        }),
    };
    let lexer = Lexer::new(syntax, Default::default(), StringInput::from(&*fm), None);
    let mut parser = Parser::new_from(lexer);
    let module = parser
        .parse_module()
        .map_err(|e| format!("{}: {:?}", path.display(), e.kind().msg()))?;
    let mut program = Program::Module(module);

    GLOBALS.set(&Globals::new(), || {
        use swc_core::ecma::ast::Pass;
        let unresolved = Mark::new();
        let top_level = Mark::new();
        swc_ecma_transforms_base::resolver(unresolved, top_level, true).process(&mut program);
        if ext == "tsx" || ext == "jsx" {
            use swc_ecma_transforms_react::{jsx, Options as ReactOptions, Runtime as ReactRuntime};
            jsx(
                cm.clone(),
                None::<swc_core::common::comments::SingleThreadedComments>,
                ReactOptions {
                    runtime: Some(ReactRuntime::Classic),
                    development: Some(false),
                    ..Default::default()
                },
                top_level,
                unresolved,
            )
            .process(&mut program);
        }
        swc_ecma_transforms_typescript::strip(unresolved, top_level).process(&mut program);
    });

    if normalize_parens {
        program.visit_mut_with(&mut ParenNormalizer);
    }

    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: CodegenConfig::default(),
            cm,
            comments: None,
            wr: writer,
        };
        emitter.emit_program(&program).map_err(|e| e.to_string())?;
    }
    String::from_utf8(output).map_err(|e| e.to_string())
}

// Copy of native/src/transpile/precedence.rs normalizer (the swc-emission-bug workaround).
struct ParenNormalizer;
impl swc_core::ecma::visit::VisitMut for ParenNormalizer {
    fn visit_mut_bin_expr(&mut self, expression: &mut swc_core::ecma::ast::BinExpr) {
        use swc_core::ecma::visit::VisitMutWith;
        expression.visit_mut_children_with(self);
        parenthesize_assignment(&mut expression.left);
        parenthesize_assignment(&mut expression.right);
    }
    fn visit_mut_expr_stmt(&mut self, statement: &mut swc_core::ecma::ast::ExprStmt) {
        use swc_core::ecma::visit::VisitMutWith;
        statement.visit_mut_children_with(self);
        parenthesize_statement_head(&mut statement.expr);
    }
}
fn parenthesize_assignment(expression: &mut Box<swc_core::ecma::ast::Expr>) {
    use swc_core::ecma::ast::Expr;
    if matches!(&**expression, Expr::Assign(_)) {
        wrap_in_parens(expression);
    }
}
fn parenthesize_statement_head(expression: &mut Box<swc_core::ecma::ast::Expr>) {
    use swc_core::ecma::ast::{Callee, Expr};
    if matches!(&**expression, Expr::Fn(_) | Expr::Class(_)) {
        wrap_in_parens(expression);
        return;
    }
    match &mut **expression {
        Expr::Call(call) => {
            if let Callee::Expr(callee) = &mut call.callee {
                parenthesize_statement_head(callee);
            }
        }
        Expr::Member(member) => parenthesize_statement_head(&mut member.obj),
        Expr::Bin(binary) => parenthesize_statement_head(&mut binary.left),
        Expr::Seq(sequence) => {
            if let Some(first) = sequence.exprs.first_mut() {
                parenthesize_statement_head(first);
            }
        }
        Expr::Cond(conditional) => parenthesize_statement_head(&mut conditional.test),
        _ => {}
    }
}
fn wrap_in_parens(expression: &mut Box<swc_core::ecma::ast::Expr>) {
    use swc_core::ecma::ast::{Expr, Invalid, ParenExpr};
    let inner = std::mem::replace(
        expression,
        Box::new(Expr::Invalid(Invalid {
            span: Default::default(),
        })),
    );
    *expression = Box::new(Expr::Paren(ParenExpr {
        expr: inner,
        span: Default::default(),
    }));
}

// ---------- oxc pipeline (parse -> semantic -> transform (ts strip + jsx classic) -> codegen) ----------

fn oxc_pipeline(path: &Path, source: &str) -> Result<String, String> {
    use oxc_allocator::Allocator;
    use oxc_codegen::Codegen;
    use oxc_parser::Parser;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;
    use oxc_transformer::{JsxOptions, JsxRuntime, TransformOptions, Transformer};

    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|e| e.to_string())?;
    let ret = Parser::new(&allocator, source, source_type).parse();
    if !ret.diagnostics.is_empty() {
        return Err(format!("{}: parse errors: {:?}", path.display(), ret.diagnostics));
    }
    let mut program = ret.program;
    let scoping = SemanticBuilder::new()
        .build(&program)
        .semantic
        .into_scoping();
    let mut options = TransformOptions::default();
    options.jsx = JsxOptions {
        runtime: JsxRuntime::Classic,
        development: false,
        ..JsxOptions::default()
    };
    let ret2 = Transformer::new(&allocator, path, &options).build_with_scoping(
        scoping,
        &mut program,
    );
    if !ret2.diagnostics.is_empty() {
        return Err(format!(
            "{}: transform errors: {:?}",
            path.display(),
            ret2.diagnostics
        ));
    }
    Ok(Codegen::new().build(&program).code)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let list = fs::read_to_string(&args[1]).expect("file list");
    let out_dir = PathBuf::from(&args[2]);
    let bench: usize = args
        .iter()
        .position(|a| a == "--bench")
        .map(|i| args[i + 1].parse().unwrap())
        .unwrap_or(0);
    fs::create_dir_all(out_dir.join("swc")).unwrap();
    fs::create_dir_all(out_dir.join("swc_norm")).unwrap();
    fs::create_dir_all(out_dir.join("oxc")).unwrap();

    let files: Vec<PathBuf> = list
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    let sources: Vec<(PathBuf, String)> = files
        .iter()
        .filter_map(|p| fs::read_to_string(p).ok().map(|s| (p.clone(), s)))
        .collect();
    eprintln!("{} files loaded", sources.len());

    let mut swc_fail = 0usize;
    let mut oxc_fail = 0usize;
    for (path, source) in &sources {
        let flat = path
            .to_string_lossy()
            .replace('/', "__")
            .trim_start_matches("__")
            .to_string();
        match swc_pipeline(path, source, false) {
            Ok(code) => fs::write(out_dir.join("swc").join(&flat), code).unwrap(),
            Err(e) => {
                swc_fail += 1;
                fs::write(out_dir.join("swc").join(format!("{flat}.err")), e).unwrap()
            }
        }
        if let Ok(code) = swc_pipeline(path, source, true) {
            fs::write(out_dir.join("swc_norm").join(&flat), code).unwrap();
        }
        match oxc_pipeline(path, source) {
            Ok(code) => fs::write(out_dir.join("oxc").join(&flat), code).unwrap(),
            Err(e) => {
                oxc_fail += 1;
                fs::write(out_dir.join("oxc").join(format!("{flat}.err")), e).unwrap()
            }
        }
    }
    eprintln!("swc failures: {swc_fail}, oxc failures: {oxc_fail}");

    if bench > 0 {
        let mut swc_times = Vec::new();
        let mut oxc_times = Vec::new();
        for _ in 0..bench {
            let t = Instant::now();
            for (path, source) in &sources {
                let _ = swc_pipeline(path, source, true);
            }
            swc_times.push(t.elapsed().as_secs_f64() * 1000.0);
            let t = Instant::now();
            for (path, source) in &sources {
                let _ = oxc_pipeline(path, source);
            }
            oxc_times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        println!(
            "swc  median {:.1} ms over {} files ({:?})",
            median(swc_times.clone()),
            sources.len(),
            swc_times.iter().map(|t| format!("{t:.0}")).collect::<Vec<_>>()
        );
        println!(
            "oxc  median {:.1} ms over {} files ({:?})",
            median(oxc_times.clone()),
            sources.len(),
            oxc_times.iter().map(|t| format!("{t:.0}")).collect::<Vec<_>>()
        );
    }
}
