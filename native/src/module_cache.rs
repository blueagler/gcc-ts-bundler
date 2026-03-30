use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use swc_core::common::{sync::Lrc, FileName, SourceMap};
use swc_core::ecma::ast::Module;
use swc_core::ecma::parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax, TsSyntax};

#[derive(Clone)]
pub struct CachedModule {
    pub file_len: u64,
    pub modified_at_millis: u128,
    pub module: Module,
}

static MODULE_CACHE: OnceLock<Mutex<HashMap<String, CachedModule>>> = OnceLock::new();

pub fn parse_module(file_path: &Path, source: &str) -> std::result::Result<Module, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(FileName::Real(file_path.to_path_buf()).into(), source.to_string());
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
            jsx: matches!(file_path.extension().and_then(|ext| ext.to_str()), Some("jsx")),
            ..Default::default()
        }),
    };

    let lexer = Lexer::new(syntax, Default::default(), StringInput::from(&*fm), None);
    let mut parser = Parser::new_from(lexer);
    parser
        .parse_module()
        .map_err(|error| format!("{}: {}", file_path.to_string_lossy(), error.kind().msg()))
}

pub fn parse_and_cache_module(
    file_path: &PathBuf,
    source: &str,
) -> std::result::Result<Module, String> {
    let module = parse_module(file_path, source)?;
    let metadata = fs::metadata(file_path).map_err(|error| error.to_string())?;
    let modified_at = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let cache = MODULE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    cache
        .lock()
        .map_err(|_| "module cache mutex poisoned".to_string())?
        .insert(
            file_path.to_string_lossy().to_string(),
            CachedModule {
                file_len: metadata.len(),
                modified_at_millis: modified_at,
                module: module.clone(),
            },
        );
    Ok(module)
}

pub fn get_or_parse_cached_module(file_path: &PathBuf) -> std::result::Result<Module, String> {
    let metadata = fs::metadata(file_path).map_err(|error| error.to_string())?;
    let modified_at = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let key = file_path.to_string_lossy().to_string();
    if let Some(cache) = MODULE_CACHE.get() {
        if let Ok(cache_guard) = cache.lock() {
            if let Some(cached) = cache_guard.get(&key) {
                if cached.file_len == metadata.len() && cached.modified_at_millis == modified_at {
                    return Ok(cached.module.clone());
                }
            }
        }
    }

    let source = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    parse_and_cache_module(file_path, &source)
}
