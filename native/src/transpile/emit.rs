use super::*;

#[derive(Clone, Debug)]
pub(super) struct EmittedProgram {
    pub(super) code: String,
    /// Lowering-helper declarations lifted out of this module so the driver
    /// can emit exactly one copy per program; see `emit_helpers`.
    pub(super) shared_helpers: Vec<emit_helpers::SharedHelperDeclaration>,
    /// Property names this module reads reflectively through `for...in`; see
    /// `emit_reflective`.
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
                        context,
                        &plan,
                        file_metadata,
                        commonjs_export_name,
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

pub(super) fn emit_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    let program = strip_runtime_directives(program);
    let reflective_property_names = emit_reflective::collect_reflective_property_names(&program);
    let mut emitted = match context.chunk_mode {
        ChunkMode::BundlerRuntime => {
            if let Some(plan) = context.hoist_plan.clone() {
                let module_id = to_goog_module_id(file_path, &context.workspace_dir);
                if plan.is_hoisted(&module_id) {
                    let mut emitted = emit_hoisted_module_program(
                        file_path,
                        program,
                        context,
                        &plan,
                        file_metadata,
                        commonjs_export_name,
                    )?;
                    emitted.reflective_property_names = reflective_property_names;
                    return Ok(emitted);
                }
            }
            emit_bundler_runtime_module_program(
                file_path,
                program,
                context,
                file_metadata,
                commonjs_export_name,
            )
        }
        ChunkMode::Off => emit_goog_module_program(
            file_path,
            program,
            context,
            file_metadata,
            commonjs_export_name,
        ),
    }?;
    emitted.reflective_property_names = reflective_property_names;
    Ok(emitted)
}

/// Drops framework bundler directives (`"use client"`, `"use server"`) from
/// the directive prologue.
///
/// They are instructions to an RSC-aware bundler, are meaningless in terminal
/// browser output, and survive Closure verbatim because a directive-position
/// string literal is an expression statement with an observable-looking value.
/// React-router alone ships 19 of them into the React example's bundle.
fn strip_runtime_directives(program: Program) -> Program {
    let Program::Module(mut module) = program else {
        return program;
    };
    // Prologue-only: a directive is defined by its position, and a string
    // literal further down could be a deliberate (if pointless) statement.
    let prologue_length = module
        .body
        .iter()
        .take_while(|item| directive_value(item).is_some())
        .count();
    let mut index = 0;
    module.body.retain(|item| {
        let keep = index >= prologue_length
            || !matches!(
                directive_value(item).as_deref(),
                Some("use client") | Some("use server")
            );
        index += 1;
        keep
    });
    Program::Module(module)
}

fn directive_value(item: &ModuleItem) -> Option<std::borrow::Cow<'_, str>> {
    let ModuleItem::Stmt(Stmt::Expr(statement)) = item else {
        return None;
    };
    let Expr::Lit(Lit::Str(literal)) = &*statement.expr else {
        return None;
    };
    Some(literal.value.to_string_lossy())
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
