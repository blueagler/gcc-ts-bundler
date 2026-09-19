use std::fmt::Write;

use super::type_metadata::TypeMetadataDelivery;
use super::{
    emit_helpers, to_goog_module_id, ChunkMode, ClosureEnumDeclaration, ClosureFileMetadata, Path,
    TranspileContext,
};

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
    pub(super) reifications: Vec<super::namespace::flow::NamespaceReification>,
    pub(super) type_metadata: TypeMetadataDelivery,
}

pub(super) fn emit_module_program_oxc<'a>(
    allocator: &'a oxc_allocator::Allocator,
    file_path: &Path,
    program: &mut oxc_ast::ast::Program<'a>,
    identity: &mut super::identity::ModuleIdentity,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    strip_runtime_directives_oxc(program);
    if context.chunk_mode == ChunkMode::BundlerRuntime {
        super::emit_goog::quote_external_boundary_accesses(
            allocator,
            file_path,
            program,
            identity,
            context,
            file_metadata,
            super::emit_goog::ExternalBoundaryEvidence::GlobalOnly,
        )?;
    } else {
        super::quote_keys::quote_literal_computed_members(allocator, program);
    }
    let mut reflective_property_names =
        super::emit_reflective::collect_reflective_property_names(program, identity)?;
    reflective_property_names.extend(super::emit_helpers::collect_lowered_define_property_names(
        program,
    ));
    let mut emitted = match context.chunk_mode {
        ChunkMode::BundlerRuntime => {
            if let Some(plan) = &context.hoist_plan {
                let module_id = to_goog_module_id(file_path, &context.workspace_dir);
                if plan.is_hoisted(&module_id) {
                    let mut emitted = super::emit_hoist::emit_hoisted_module_text(
                        allocator,
                        file_path,
                        program,
                        identity,
                        super::emit_hoist::HoistedModuleOptions {
                            context,
                            plan,
                            file_metadata,
                            commonjs_export_name,
                        },
                    )?;
                    emitted.reflective_property_names = reflective_property_names;
                    return Ok(emitted);
                }
            }
            let emitted = super::emit_runtime::emit_bundler_runtime_module_text(
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
                reifications: emitted.reifications,
                type_metadata: emitted.type_metadata,
            }
        }
        ChunkMode::Off => super::emit_goog::emit_goog_module_program(
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
    let mut output = format!(
        "/** @enum {{{}}} */\nconst {} = {{\n",
        enum_decl.value_type, emitted_name
    );
    for member in &enum_decl.members {
        // Formatting into a String cannot fail.
        let _ = writeln!(output, "  {:?}: {},", member.name, member.value);
    }
    output.push_str("};");
    if enum_decl.value_type == "number" {
        // Numeric enums retain TypeScript's last-write-wins reverse mapping.
        // The writable object view keeps forward members precisely enum-typed.
        for member in &enum_decl.members {
            let _ = write!(
                output,
                "\n/** @type {{!Object<string,(number|string)>}} */ ({emitted_name})[{}] = {:?};",
                member.value, member.name
            );
        }
    }
    output
}
