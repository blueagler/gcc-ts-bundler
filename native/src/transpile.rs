#![allow(non_snake_case)]

use std::fs;
use std::path::PathBuf;

use napi_derive::napi;
use rayon::prelude::*;
use swc_core::common::{sync::Lrc, Globals, Mark, SourceMap, GLOBALS};
use swc_core::ecma::ast::{Pass, Program};
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_ecma_transforms_base::resolver;
use swc_ecma_transforms_typescript::strip;

use crate::module_cache::get_or_parse_cached_module;

#[allow(non_snake_case)]
#[napi(object)]
pub struct TranspileOutput {
    pub emittedFiles: Vec<String>,
    pub externsPath: String,
}

pub fn transpile_sources(
    file_names: Vec<String>,
    out_dir: String,
    externs_path: String,
    workspace_dir: String,
) -> std::result::Result<TranspileOutput, String> {
    fs::create_dir_all(&out_dir).map_err(|error| error.to_string())?;
    if let Some(parent) = PathBuf::from(&externs_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&externs_path, "").map_err(|error| error.to_string())?;

    let workspace_dir = PathBuf::from(workspace_dir);
    let out_dir = PathBuf::from(out_dir);
    let emitted_outputs = file_names
        .par_iter()
        .filter(|file_name| !file_name.ends_with(".d.ts"))
        .map(|file_name| {
            let file_path = PathBuf::from(file_name);
            let relative_path = file_path.strip_prefix(&workspace_dir).unwrap_or(&file_path);
            let output_path = out_dir.join(relative_path).with_extension("js");

            let code = GLOBALS.set(&Globals::new(), || {
                let module = get_or_parse_cached_module(&file_path)?;
                let program = transform_program(module)?;
                print_program(&program)
            })?;

            Ok::<_, String>((output_path, code))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut emitted_files = Vec::with_capacity(emitted_outputs.len());
    for (output_path, code) in emitted_outputs {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&output_path, code).map_err(|error| error.to_string())?;
        emitted_files.push(output_path.to_string_lossy().to_string());
    }

    emitted_files.sort();
    Ok(TranspileOutput {
        emittedFiles: emitted_files,
        externsPath: externs_path,
    })
}

fn transform_program(module: swc_core::ecma::ast::Module) -> std::result::Result<Program, String> {
    let unresolved_mark = Mark::new();
    let top_level_mark = Mark::new();
    let mut program = Program::Module(module);
    resolver(unresolved_mark, top_level_mark, true).process(&mut program);
    strip(unresolved_mark, top_level_mark).process(&mut program);
    Ok(program)
}

fn print_program(program: &Program) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: CodegenConfig::default(),
            cm,
            comments: None,
            wr: writer,
        };
        emitter.emit_program(program).map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}
