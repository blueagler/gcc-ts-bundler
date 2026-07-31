#![allow(non_snake_case)]

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use napi_derive::napi;
use serde::{Deserialize, Serialize};

use crate::pathing::normalize_path;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureFileMetadata {
    /// Environment globals declared by ambient `.d.ts` files. They never enter
    /// the module graph, so the metadata channel is the only path that carries
    /// them to the externs writer.
    #[serde(default)]
    pub ambient_globals: Vec<String>,
    #[serde(default)]
    pub annotations: Vec<ClosureAnnotation>,
    #[serde(default)]
    pub declarations: Vec<ClosureTypeDeclaration>,
    pub decorated_output_text: Option<String>,
    #[serde(default)]
    pub diagnostics: Vec<TypeMetadataDiagnostic>,
    #[serde(default)]
    pub enums: Vec<ClosureEnumDeclaration>,
    /// Const enums TypeScript erases. Only the names travel: the declaration is
    /// dropped and nothing is emitted in its place.
    #[allow(dead_code)]
    #[serde(default)]
    pub erased_const_enums: Vec<String>,
    pub file_path: String,
    #[allow(dead_code)]
    pub runtime_module_id: Option<String>,
    pub source_file_path: String,
    #[serde(default)]
    pub symbols: Vec<ClosureTypeSymbol>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureAnnotation {
    #[serde(default)]
    pub references: Vec<ClosureTypeReference>,
    pub target: ClosureAnnotationTarget,
    pub template: String,
    pub type_bearing: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClosureAnnotationTarget {
    #[serde(rename_all = "camelCase")]
    Binding { binding_name: String },
    #[serde(rename_all = "camelCase")]
    Member {
        member_kind: String,
        member_name: String,
        owner_binding_name: String,
        #[serde(rename = "static")]
        is_static: bool,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureTypeReference {
    pub symbol_id: String,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureTypeSymbol {
    pub builtin_name: Option<String>,
    pub declaration_file_path: Option<String>,
    #[allow(dead_code)]
    pub declaration_id: Option<String>,
    #[allow(dead_code)]
    pub declaration_start: Option<u32>,
    pub diagnostic_name: String,
    pub id: String,
    pub kind: String,
    pub local_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureTypeDeclaration {
    pub declared_symbol_id: String,
    #[allow(dead_code)]
    pub exported: bool,
    pub id: String,
    #[serde(default)]
    pub references: Vec<ClosureTypeReference>,
    pub template: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureEnumDeclaration {
    pub binding_name: String,
    pub exported: bool,
    #[serde(default)]
    pub members: Vec<ClosureEnumMember>,
    pub symbol_id: String,
    pub value_type: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ClosureEnumMember {
    pub name: String,
    pub value: serde_json::Value,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeMetadataCounts {
    pub annotationCount: u32,
    pub enumDeclarationCount: u32,
    pub memberAnnotationCount: u32,
    pub typeDeclarationCount: u32,
    pub unresolvedTypeReferenceCount: u32,
}

impl TypeMetadataCounts {
    pub(crate) fn add_assign(&mut self, other: &Self) {
        self.annotationCount += other.annotationCount;
        self.enumDeclarationCount += other.enumDeclarationCount;
        self.memberAnnotationCount += other.memberAnnotationCount;
        self.typeDeclarationCount += other.typeDeclarationCount;
        self.unresolvedTypeReferenceCount += other.unresolvedTypeReferenceCount;
    }

    pub(crate) fn has_type_metadata(&self) -> bool {
        self.annotationCount
            + self.enumDeclarationCount
            + self.memberAnnotationCount
            + self.typeDeclarationCount
            > 0
    }
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeMetadataDiagnostic {
    pub declarationFilePath: Option<String>,
    pub phase: String,
    pub reason: String,
    pub sourceFilePath: String,
    pub symbolId: Option<String>,
    pub symbolName: Option<String>,
    pub target: Option<String>,
}

impl TypeMetadataDiagnostic {
    pub(crate) fn delivery(
        metadata: &ClosureFileMetadata,
        reason: impl Into<String>,
        symbol: Option<&ClosureTypeSymbol>,
        target: Option<String>,
    ) -> Self {
        Self {
            declarationFilePath: symbol.and_then(|value| value.declaration_file_path.clone()),
            phase: "delivery".to_string(),
            reason: reason.into(),
            sourceFilePath: metadata.source_file_path.clone(),
            symbolId: symbol.map(|value| value.id.clone()),
            symbolName: symbol.map(|value| value.diagnostic_name.clone()),
            target,
        }
    }

    pub(crate) fn stable_key(&self) -> (&str, &str, &str, &str, &str) {
        (
            self.phase.as_str(),
            self.reason.as_str(),
            self.symbolId.as_deref().unwrap_or_default(),
            self.target.as_deref().unwrap_or_default(),
            self.sourceFilePath.as_str(),
        )
    }
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmittedTypeMetadata {
    pub counts: TypeMetadataCounts,
    pub diagnostics: Vec<TypeMetadataDiagnostic>,
    pub emittedFile: String,
    pub hasTypeMetadata: bool,
}

impl EmittedTypeMetadata {
    pub(crate) fn new(
        emitted_file: String,
        counts: TypeMetadataCounts,
        mut diagnostics: Vec<TypeMetadataDiagnostic>,
    ) -> Self {
        diagnostics.sort_by(|left, right| left.stable_key().cmp(&right.stable_key()));
        diagnostics.dedup_by(|left, right| left.stable_key() == right.stable_key());
        let has_type_metadata = counts.has_type_metadata();
        Self {
            counts,
            diagnostics,
            emittedFile: emitted_file,
            hasTypeMetadata: has_type_metadata,
        }
    }
}

pub(crate) fn closure_metadata_key(file_path: &Path) -> String {
    normalize_path(file_path).to_string_lossy().to_string()
}

pub fn load_closure_metadata(
    metadata_path: &str,
) -> std::result::Result<HashMap<String, ClosureFileMetadata>, String> {
    let raw = fs::read_to_string(metadata_path).map_err(|error| error.to_string())?;
    let files = serde_json::from_str::<Vec<ClosureFileMetadata>>(&raw)
        .map_err(|error| error.to_string())?;
    Ok(files
        .into_iter()
        .map(|metadata| {
            let key = closure_metadata_key(Path::new(&metadata.file_path));
            (key, metadata)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_symbol_aware_metadata_v1() {
        let files = serde_json::from_str::<Vec<ClosureFileMetadata>>(
            r#"[
              {
                "annotations": [{
                  "references": [{"symbolId":"runtime:widget","token":"__GCC_TYPE_0__"}],
                  "target": {"kind":"member","memberKind":"field","memberName":"value","ownerBindingName":"Widget","static":false},
                  "template": "/** @type {!__GCC_TYPE_0__} */\n",
                  "typeBearing": true
                }],
                "declarations": [{
                  "declaredSymbolId":"record:config",
                  "exported":false,
                  "id":"record:config:declaration",
                  "references":[],
                  "template":"/** @record */\nfunction Config() {}\n"
                }],
                "decoratedOutputText": null,
                "diagnostics": [],
                "enums": [{
                  "bindingName":"Kind",
                  "exported":true,
                  "members":[{"name":"A","value":1}],
                  "symbolId":"enum:kind",
                  "valueType":"number"
                }],
                "filePath":"/tmp/input.ts",
                "runtimeModuleId":"app:input",
                "sourceFilePath":"/tmp/source.ts",
                "symbols":[
                  {"diagnosticName":"Widget","id":"runtime:widget","kind":"runtime","localName":"Widget"},
                  {"declarationId":"record:config:declaration","diagnosticName":"Config","id":"record:config","kind":"generated-record"}
                ]
              }
            ]"#,
        )
        .unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].annotations.len(), 1);
        assert_eq!(files[0].declarations.len(), 1);
        assert_eq!(files[0].enums[0].binding_name, "Kind");
        assert_eq!(files[0].runtime_module_id.as_deref(), Some("app:input"));
    }

    #[test]
    fn derives_has_type_metadata_from_delivered_counts() {
        let metadata = EmittedTypeMetadata::new(
            "/tmp/out.js".to_string(),
            TypeMetadataCounts {
                enumDeclarationCount: 1,
                ..Default::default()
            },
            Vec::new(),
        );
        assert!(metadata.hasTypeMetadata);
    }
}
