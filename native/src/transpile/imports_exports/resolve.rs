use super::*;

pub(crate) fn resolve_module_id_for_specifier(
    file_path: &Path,
    specifier: &str,
    context: &TranspileContext,
) -> std::result::Result<String, String> {
    if specifier.starts_with('.') {
        let resolved = resolve_relative_module(file_path, specifier).ok_or_else(|| {
            format!(
                "Failed to resolve module specifier {specifier:?} from {}",
                file_path.display()
            )
        })?;
        return Ok(to_goog_module_id(&resolved, &context.workspace_dir));
    }

    let (package_name, subpath) = split_package_specifier(specifier);
    let alias = context
        .package_aliases
        .iter()
        .find(|alias| alias.packageName == package_name && alias.subpath == subpath)
        .or_else(|| {
            context
                .package_aliases
                .iter()
                .find(|alias| alias.packageName == package_name && alias.subpath == ".")
        })
        .ok_or_else(|| format!("Failed to resolve package specifier {specifier:?}"))?;
    Ok(to_goog_module_id(
        Path::new(&alias.targetPath),
        &context.workspace_dir,
    ))
}

fn split_package_specifier(specifier: &str) -> (String, String) {
    if specifier.starts_with('@') {
        let parts = specifier.split('/').collect::<Vec<_>>();
        let package_name = format!("{}/{}", parts[0], parts[1]);
        let subpath = if parts.len() > 2 {
            format!("./{}", parts[2..].join("/"))
        } else {
            ".".to_string()
        };
        (package_name, subpath)
    } else {
        let parts = specifier.split('/').collect::<Vec<_>>();
        let package_name = parts[0].to_string();
        let subpath = if parts.len() > 1 {
            format!("./{}", parts[1..].join("/"))
        } else {
            ".".to_string()
        };
        (package_name, subpath)
    }
}
