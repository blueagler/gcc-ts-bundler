use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::super::PackageImport;

pub(super) fn parse_package_import(specifier: &str) -> std::result::Result<PackageImport, String> {
    if specifier.starts_with('@') {
        let mut segments = specifier.split('/');
        let scope = segments
            .next()
            .ok_or_else(|| format!("Invalid package specifier \"{specifier}\""))?;
        let name = segments
            .next()
            .ok_or_else(|| format!("Invalid package specifier \"{specifier}\""))?;
        let package_name = format!("{scope}/{name}");
        let remainder = segments.collect::<Vec<_>>().join("/");
        Ok(PackageImport {
            package_name,
            subpath: if remainder.is_empty() {
                ".".to_string()
            } else {
                format!("./{remainder}")
            },
        })
    } else {
        let mut segments = specifier.split('/');
        let package_name = segments
            .next()
            .ok_or_else(|| format!("Invalid package specifier \"{specifier}\""))?
            .to_string();
        let remainder = segments.collect::<Vec<_>>().join("/");
        Ok(PackageImport {
            package_name,
            subpath: if remainder.is_empty() {
                ".".to_string()
            } else {
                format!("./{remainder}")
            },
        })
    }
}

pub(super) fn find_package_dir(importer: &Path, package_name: &str) -> Option<PathBuf> {
    let mut current = importer.parent();

    while let Some(directory) = current {
        let candidate = directory.join("node_modules").join(package_name);
        if candidate.exists() {
            return Some(candidate);
        }
        current = directory.parent();
    }

    None
}

pub(super) fn read_package_json(path: &Path) -> std::result::Result<Value, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| format!("{}: {error}", path.to_string_lossy()))
}

pub(super) fn format_package_specifier(package_import: &PackageImport) -> String {
    if package_import.subpath == "." {
        package_import.package_name.clone()
    } else {
        format!(
            "{}/{}",
            package_import.package_name,
            package_import.subpath.trim_start_matches("./")
        )
    }
}

pub(super) fn is_bare_package_specifier(specifier: &str) -> bool {
    !specifier.starts_with('/') && !specifier.contains(':')
}

pub(super) fn is_node_builtin(specifier: &str) -> bool {
    if specifier.starts_with("node:") {
        return true;
    }
    if specifier.starts_with('@') {
        return false;
    }

    let root = specifier.split('/').next().unwrap_or(specifier);
    matches!(
        root,
        "_http_agent"
            | "_http_client"
            | "_http_common"
            | "_http_incoming"
            | "_http_outgoing"
            | "_http_server"
            | "_stream_duplex"
            | "_stream_passthrough"
            | "_stream_readable"
            | "_stream_transform"
            | "_stream_wrap"
            | "_stream_writable"
            | "_tls_common"
            | "_tls_wrap"
            | "assert"
            | "async_hooks"
            | "buffer"
            | "child_process"
            | "cluster"
            | "console"
            | "constants"
            | "crypto"
            | "dgram"
            | "diagnostics_channel"
            | "dns"
            | "domain"
            | "events"
            | "fs"
            | "http"
            | "http2"
            | "https"
            | "inspector"
            | "module"
            | "net"
            | "os"
            | "path"
            | "perf_hooks"
            | "process"
            | "punycode"
            | "querystring"
            | "readline"
            | "repl"
            | "stream"
            | "string_decoder"
            | "sys"
            | "timers"
            | "tls"
            | "trace_events"
            | "tty"
            | "url"
            | "util"
            | "v8"
            | "vm"
            | "worker_threads"
            | "zlib"
    )
}
