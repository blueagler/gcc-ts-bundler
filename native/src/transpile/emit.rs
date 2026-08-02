use super::type_metadata::TypeMetadataDelivery;
use super::*;

#[derive(Clone, Debug)]
pub(super) struct PreservedImportPlan {
    pub(super) boundary_exports: Vec<String>,
    pub(super) boundary_names: Vec<String>,
    pub(super) external_specifier: Option<String>,
    pub(super) import_clause: String,
    pub(super) target_module_id: String,
}

#[derive(Clone, Debug)]
pub(super) struct EmittedProgram {
    pub(super) code: String,
    pub(super) preserved_extern_lines: Vec<String>,
    pub(super) preserved_imports: Vec<PreservedImportPlan>,
    pub(super) shared_helpers: Vec<emit_helpers::SharedHelperDeclaration>,
    pub(super) reflective_property_names: std::collections::BTreeSet<String>,
    pub(super) type_metadata: TypeMetadataDelivery,
}

impl std::ops::Deref for EmittedProgram {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.code
    }
}

impl std::fmt::Display for EmittedProgram {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.code.fmt(formatter)
    }
}

pub(super) fn emit_module_program_oxc<'a>(
    allocator: &'a oxc_allocator::Allocator,
    file_path: &Path,
    program: &mut oxc_ast::ast::Program<'a>,
    identity: &mut super::identity_oxc::ModuleIdentity,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    strip_runtime_directives_oxc(program);
    let reflective_property_names =
        super::emit_reflective_oxc::collect_reflective_property_names(program, identity);
    let mut emitted = match context.chunk_mode {
        ChunkMode::BundlerRuntime => {
            if let Some(plan) = context.hoist_plan.clone() {
                let module_id = to_goog_module_id(file_path, &context.workspace_dir);
                if plan.is_hoisted(&module_id) {
                    let mut emitted = super::emit_hoist_oxc::emit_hoisted_module_text(
                        allocator,
                        file_path,
                        program,
                        identity,
                        super::emit_hoist_oxc::HoistedModuleOptions {
                            context,
                            plan: &plan,
                            file_metadata,
                            commonjs_export_name,
                        },
                    )?;
                    emitted.reflective_property_names = reflective_property_names;
                    return Ok(emitted);
                }
            }
            let emitted = super::emit_runtime_oxc::emit_bundler_runtime_module_text(
                allocator,
                file_path,
                program,
                identity,
                context,
                file_metadata,
                commonjs_export_name,
            )?;
            EmittedProgram {
                code: emitted.code,
                preserved_extern_lines: Vec::new(),
                preserved_imports: Vec::new(),
                shared_helpers: Vec::new(),
                reflective_property_names: Default::default(),
                type_metadata: emitted.type_metadata,
            }
        }
        ChunkMode::Off => super::emit_goog_oxc::emit_goog_module_program(
            allocator,
            file_path,
            program,
            identity,
            context,
            file_metadata,
            commonjs_export_name,
        )?,
    };
    emitted.reflective_property_names = reflective_property_names;
    Ok(emitted)
}

fn strip_runtime_directives_oxc(program: &mut oxc_ast::ast::Program<'_>) {
    program
        .directives
        .retain(|directive| !matches!(directive.directive.as_str(), "use client" | "use server"));
}

pub(super) fn render_closure_enum(
    enum_decl: &ClosureEnumDeclaration,
    emitted_name: &str,
) -> String {
    let member_lines = enum_decl
        .members
        .iter()
        .map(|member| {
            let value = match &member.value {
                serde_json::Value::Bool(value) => value.to_string(),
                serde_json::Value::Number(value) => value.to_string(),
                serde_json::Value::String(value) => format!("{value:?}"),
                _ => "undefined".to_string(),
            };
            if is_valid_js_identifier(&member.name) {
                format!("  {}: {},", member.name, value)
            } else {
                format!("  {:?}: {},", member.name, value)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "/** @enum {{{}}} */\nconst {} = {{\n{}\n}};",
        enum_decl.value_type, emitted_name, member_lines
    )
}
