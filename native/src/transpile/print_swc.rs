use super::*;

/// TypeScript declaration merging: two `namespace A { … }` blocks are one
/// namespace, and a member declared in either block is visible from both.
///
/// SWC's `strip` does not implement that. It qualifies a reference to a
/// namespace member only when the member is declared in the *same* block, so
/// the second block keeps bare reads that resolve to nothing:
///
/// ```text
/// (function(Outer) { … Outer.version = 3; (function(Inner){…})(Outer.Inner || …) })(Outer || (Outer = {}));
/// (function(Outer) { function versionTwice() { return Inner.twice(version); } … })(Outer || (Outer = {}));
///                                                    ^^^^^      ^^^^^^^ never declared
/// ```
///
/// Closure rejects that outright (`JSC_UNDEFINED_VARIABLE: Inner`), so *every*
/// merged-namespace source failed the build; a chunked or untyped build that got
/// past Closure would throw at runtime instead. `tsc` emits `Outer.Inner` and
/// `Outer.version` here.
///
/// Fixed by merging the blocks before `strip` runs, which is the shape `strip`
/// gets right: with every member declared in one block, its own qualification
/// pass covers both directions, including a *forward* reference from the first
/// block to a member declared in the second (an alias preamble could not).
///
/// Deliberately conservative — a group is merged only when it cannot reorder
/// observable work:
///
///   * every block in the group agrees on the `export` modifier (a mixed group
///     is left alone rather than guessing which spelling wins);
///   * `declare`/`global`/qualified-name (`namespace A.B`) forms are skipped;
///   * only declarations and empty statements may sit between the blocks. Real
///     statements in between would have their execution order changed by moving
///     a body across them, so those groups keep today's behaviour instead.
fn merge_ts_namespace_blocks(mut module: Module) -> Module {
    module.body = merge_namespace_items(module.body);
    module
}

fn merge_namespace_items(mut items: Vec<ModuleItem>) -> Vec<ModuleItem> {
    // Group by namespace name, in first-occurrence order.
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some((name, _)) = namespace_block_info(item) else {
            continue;
        };
        match groups.iter_mut().find(|(known, _)| *known == name) {
            Some((_, indexes)) => indexes.push(index),
            None => groups.push((name, vec![index])),
        }
    }

    let mut absorbed = HashSet::new();
    for (_, indexes) in groups {
        if indexes.len() < 2 {
            continue;
        }
        let exported = namespace_block_info(&items[indexes[0]]).map(|(_, exported)| exported);
        let uniform = indexes.iter().all(|index| {
            namespace_block_info(&items[*index]).map(|(_, exported)| exported) == exported
        });
        if !uniform {
            continue;
        }
        let first = indexes[0];
        let last = *indexes.last().unwrap_or(&first);
        if !items[first + 1..last]
            .iter()
            .enumerate()
            .all(|(offset, item)| {
                indexes.contains(&(first + 1 + offset)) || is_order_neutral_item(item)
            })
        {
            continue;
        }
        let mut absorbed_bodies = Vec::new();
        for index in indexes.iter().skip(1) {
            let Some(block) = namespace_block_mut(&mut items[*index]) else {
                continue;
            };
            absorbed_bodies.append(&mut block.body);
            absorbed.insert(*index);
        }
        if let Some(block) = namespace_block_mut(&mut items[first]) {
            block.body.extend(absorbed_bodies);
        }
    }

    let mut merged: Vec<ModuleItem> = items
        .into_iter()
        .enumerate()
        .filter(|(index, _)| !absorbed.contains(index))
        .map(|(_, item)| item)
        .collect();
    // Recurse after merging, so blocks that only became siblings by the merge
    // above get the same treatment one level down.
    for item in &mut merged {
        if let Some(block) = namespace_block_mut(item) {
            block.body = merge_namespace_items(std::mem::take(&mut block.body));
        }
    }
    merged
}

/// `(name, is_exported)` for a mergeable namespace block.
fn namespace_block_info(item: &ModuleItem) -> Option<(String, bool)> {
    let (decl, exported) = match item {
        ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::TsModule(decl))) => {
            (decl.as_ref(), false)
        }
        ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
            match &export_decl.decl {
                swc_core::ecma::ast::Decl::TsModule(decl) => (decl.as_ref(), true),
                _ => return None,
            }
        }
        _ => return None,
    };
    if decl.declare || decl.global {
        return None;
    }
    let swc_core::ecma::ast::TsModuleName::Ident(ident) = &decl.id else {
        return None;
    };
    match &decl.body {
        Some(swc_core::ecma::ast::TsNamespaceBody::TsModuleBlock(_)) => {
            Some((ident.sym.to_string(), exported))
        }
        _ => None,
    }
}

fn namespace_block_mut(item: &mut ModuleItem) -> Option<&mut swc_core::ecma::ast::TsModuleBlock> {
    if namespace_block_info(item).is_none() {
        return None;
    }
    let decl = match item {
        ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::TsModule(decl))) => decl,
        ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
            match &mut export_decl.decl {
                swc_core::ecma::ast::Decl::TsModule(decl) => decl,
                _ => return None,
            }
        }
        _ => return None,
    };
    match decl.body.as_mut() {
        Some(swc_core::ecma::ast::TsNamespaceBody::TsModuleBlock(block)) => Some(block),
        _ => None,
    }
}

/// True when moving a namespace body across this item cannot change what runs
/// first. Declarations qualify; anything that executes on its own does not.
fn is_order_neutral_item(item: &ModuleItem) -> bool {
    match item {
        ModuleItem::Stmt(Stmt::Decl(_)) | ModuleItem::Stmt(Stmt::Empty(_)) => true,
        ModuleItem::Stmt(_) => false,
        // Import/export declarations are hoisted or inert by construction. An
        // `export default <expr>` is not, so it stays disqualifying.
        ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(_)) => false,
        ModuleItem::ModuleDecl(_) => true,
    }
}

/// `export = x` has no ES module spelling, so SWC's TypeScript strip lowers it
/// to `module.exports = x`. Every output shape this bundler emits is a
/// `goog.module`, where `module` is not bound, so the lowering produced a
/// reference to an undeclared global and Closure rejected the file
/// (`JSC_UNDEFINED_VARIABLE: module`) — for *any* source using `export =`.
///
/// `export = x` means "this module's single export is x", which is exactly
/// `export default x` in the module system we emit into; the CommonJS interop
/// that consumers go through already maps a default export onto
/// `module.exports`.
fn rewrite_ts_export_assignment(mut module: Module) -> Module {
    for item in &mut module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::TsExportAssignment(assignment)) =
            item
        else {
            continue;
        };
        let expr = assignment.expr.clone();
        let span = assignment.span;
        *item = ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
            swc_core::ecma::ast::ExportDefaultExpr { span, expr },
        ));
    }
    module
}

pub(super) fn transform_program(
    module: swc_core::ecma::ast::Module,
    file_path: &Path,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
) -> std::result::Result<Program, String> {
    let safe_enums = file_metadata
        .map(|metadata| {
            metadata
                .enums
                .iter()
                .map(|enum_decl| enum_decl.binding_name.clone())
                .chain(metadata.erased_const_enums.iter().cloned())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let erased_const_enums = file_metadata
        .map(|metadata| {
            metadata
                .erased_const_enums
                .iter()
                .cloned()
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    // An erased const enum has no replacement object, so the inliner is the
    // only thing that can resolve its members — and it has to read them before
    // the declaration is dropped. A `@enum`-backed enum is deliberately not
    // collected here: its reads resolve against the emitted object instead.
    let erased_enum_values = if erased_const_enums.is_empty() {
        HashMap::new()
    } else {
        collect_ts_enum_literal_values(&module)
            .into_iter()
            .filter(|(name, _)| erased_const_enums.contains(name))
            .collect()
    };
    let module = rewrite_ts_export_assignment(module);
    // Before `strip`: it is `strip` that mis-lowers a split namespace.
    let module = merge_ts_namespace_blocks(module);
    let module = remove_closure_safe_enums(module, &safe_enums);
    let mut enum_literal_values = collect_ts_enum_literal_values(&module);
    enum_literal_values.extend(collect_imported_ts_enum_literal_values(&module, file_path));
    enum_literal_values.extend(erased_enum_values);
    let mut program = Program::Module(module);
    let cm: Lrc<SourceMap> = Default::default();
    let module_identity =
        apply_resolver_and_global_this_compat(&mut program, should_run_resolver(file_path))?;
    // The swc-only leg: `jsx` and `strip` take the resolver's marks directly.
    // oxc's transformer takes the semantic model instead, so this destructuring
    // is the seam that goes away with the AST swap -- everything else in the
    // pipeline already asks `ModuleIdentity`.
    if let Some((unresolved_mark, top_level_mark)) = module_identity.resolver_marks() {
        if should_run_react_transform(file_path) {
            jsx(
                cm,
                None::<swc_core::common::comments::SingleThreadedComments>,
                ReactOptions {
                    runtime: Some(ReactRuntime::Classic),
                    development: Some(false),
                    ..Default::default()
                },
                top_level_mark,
                unresolved_mark,
            )
            .process(&mut program);
        }
        strip(unresolved_mark, top_level_mark).process(&mut program);
    }
    if !enum_literal_values.is_empty() {
        program.visit_mut_with(&mut EnumValueInlineVisitor::new(enum_literal_values));
    }
    apply_file_compat_transforms(&mut program, file_path, context);
    Ok(program)
}

fn remove_closure_safe_enums(module: Module, safe_enums: &HashSet<String>) -> Module {
    if safe_enums.is_empty() {
        return module;
    }

    Module {
        body: module
            .body
            .into_iter()
            .filter(|item| match item {
                ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::TsEnum(enum_decl))) => {
                    !safe_enums.contains(enum_decl.id.sym.as_ref())
                }
                ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(
                    export_decl,
                )) => match &export_decl.decl {
                    swc_core::ecma::ast::Decl::TsEnum(enum_decl) => {
                        !safe_enums.contains(enum_decl.id.sym.as_ref())
                    }
                    _ => true,
                },
                _ => true,
            })
            .collect(),
        ..module
    }
}

pub(super) fn print_program(program: &Program) -> std::result::Result<String, String> {
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
        emitter
            .emit_program(program)
            .map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

pub(super) fn print_module_item(item: ModuleItem) -> std::result::Result<String, String> {
    print_program(&Program::Module(Module {
        body: vec![item],
        shebang: None,
        span: Default::default(),
    }))
}

pub(super) fn print_statement(statement: Stmt) -> std::result::Result<String, String> {
    print_module_item(ModuleItem::Stmt(statement))
}

pub(super) fn print_expression(expression: Expr) -> std::result::Result<String, String> {
    let printed = print_statement(Stmt::Expr(ExprStmt {
        expr: Box::new(expression),
        span: Default::default(),
    }))?;
    Ok(printed.trim().trim_end_matches(';').to_string())
}

#[cfg(test)]
pub(crate) fn print_program_for_test(program: &Program) -> std::result::Result<String, String> {
    print_program(program)
}

#[cfg(test)]
pub(crate) fn print_module_item_for_test(item: ModuleItem) -> std::result::Result<String, String> {
    print_module_item(item)
}
