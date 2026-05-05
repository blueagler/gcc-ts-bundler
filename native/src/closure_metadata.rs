use std::collections::HashMap;
use std::fs;

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureFileMetadata {
    pub decorated_output_text: Option<String>,
    pub enum_declarations: Vec<ClosureEnumDeclaration>,
    pub file_path: String,
    pub top_level_docs: Vec<ClosureTopLevelDoc>,
    pub type_declarations: Vec<ClosureTypeDeclaration>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureEnumDeclaration {
    pub exported: bool,
    pub members: Vec<ClosureEnumMember>,
    pub name: String,
    pub value_type: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ClosureEnumMember {
    pub name: String,
    pub value: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ClosureTopLevelDoc {
    pub jsdoc: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub r#static: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ClosureTypeDeclaration {
    pub snippet: String,
}

pub fn load_closure_metadata(
    metadata_path: &str,
) -> std::result::Result<HashMap<String, ClosureFileMetadata>, String> {
    let raw = fs::read_to_string(metadata_path).map_err(|error| error.to_string())?;
    let files = serde_json::from_str::<Vec<ClosureFileMetadata>>(&raw)
        .map_err(|error| error.to_string())?;
    Ok(files
        .into_iter()
        .map(|metadata| (metadata.file_path.clone(), metadata))
        .collect())
}
