use oxc_allocator::Vec as ArenaVec;
use oxc_ast::ast::{
    Declaration, Program, Statement, TSModuleDeclarationBody, TSModuleDeclarationName,
    VariableDeclaration, VariableDeclarationKind,
};
use std::collections::HashSet;

/// TypeScript declaration merging: two `namespace A { … }` blocks are one
/// namespace, and a member declared in either is visible from both.
///
/// Neither front end implements that. swc's `strip` qualifies a member reference
/// only inside the block that declares it, and **oxc's transformer has the same
/// gap** (measured: the merged block emits a bare `Inner` that throws
/// `ReferenceError: Inner is not defined`). So the owned pre-lowering merge that
/// fixed it on swc is needed here too, and this is that pass on the oxc AST.
///
/// Conservative in exactly the same way: a group merges only when it cannot
/// reorder observable work — every block agrees on the `export` modifier,
/// `declare`/qualified-name forms are skipped, and only declarations may sit
/// between the blocks.
pub(super) fn merge_namespace_blocks<'a>(statements: &mut ArenaVec<'a, Statement<'a>>) {
    fn block_info(statement: &Statement<'_>) -> Option<(String, bool)> {
        let (declaration, exported) = match statement {
            Statement::TSModuleDeclaration(declaration) => (&**declaration, false),
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_ref() {
                Some(Declaration::TSModuleDeclaration(declaration)) => (&**declaration, true),
                _ => return None,
            },
            _ => return None,
        };
        if declaration.declare {
            return None;
        }
        let TSModuleDeclarationName::Identifier(id) = &declaration.id else {
            return None;
        };
        match &declaration.body {
            Some(TSModuleDeclarationBody::TSModuleBlock(_)) => {
                Some((id.name.to_string(), exported))
            }
            _ => None,
        }
    }

    fn block_mut<'a, 'b>(
        statement: &'b mut Statement<'a>,
    ) -> Option<&'b mut ArenaVec<'a, Statement<'a>>> {
        let declaration = match statement {
            Statement::TSModuleDeclaration(declaration) => &mut **declaration,
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_mut() {
                Some(Declaration::TSModuleDeclaration(declaration)) => &mut **declaration,
                _ => return None,
            },
            _ => return None,
        };
        match declaration.body.as_mut() {
            Some(TSModuleDeclarationBody::TSModuleBlock(block)) => Some(&mut block.body),
            _ => None,
        }
    }

    /// True when moving a namespace body across this item cannot change what
    /// runs first.
    ///
    /// Note `is_declaration()` alone is wrong here: `export function f() {}` is a
    /// *module* declaration, so the first version of this gate silently refused
    /// to merge across any exported declaration (finding 6's tri-split). An
    /// `export default <expr>` stays disqualifying because it evaluates.
    fn order_neutral(statement: &Statement<'_>) -> bool {
        if matches!(statement, Statement::ExportDefaultDeclaration(_)) {
            return false;
        }
        statement.is_declaration()
            || statement.is_module_declaration()
            || matches!(statement, Statement::EmptyStatement(_))
    }

    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, statement) in statements.iter().enumerate() {
        let Some((name, _)) = block_info(statement) else {
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
        let exported = block_info(&statements[indexes[0]]).map(|(_, exported)| exported);
        if !indexes
            .iter()
            .all(|index| block_info(&statements[*index]).map(|(_, e)| e) == exported)
        {
            continue;
        }
        let first = indexes[0];
        let last = *indexes.last().unwrap_or(&first);
        if !(first + 1..last)
            .all(|index| indexes.contains(&index) || order_neutral(&statements[index]))
        {
            continue;
        }
        let mut moved: Vec<Statement<'a>> = Vec::new();
        for index in indexes.iter().skip(1) {
            let Some(body) = block_mut(&mut statements[*index]) else {
                continue;
            };
            moved.extend(body.drain(..));
            absorbed.insert(*index);
        }
        if let Some(body) = block_mut(&mut statements[first]) {
            for statement in moved {
                body.push(statement);
            }
        }
    }

    if !absorbed.is_empty() {
        let mut index = 0;
        statements.retain(|_| {
            let keep = !absorbed.contains(&index);
            index += 1;
            keep
        });
    }

    // Recurse after merging: a nested namespace split across two *parent* blocks
    // only becomes a sibling pair once the outer merge has happened.
    for statement in statements.iter_mut() {
        if let Some(body) = block_mut(statement) {
            merge_namespace_blocks(body);
        }
    }
}

/// Names oxc will lower onto a binding of its own: TS enums and namespaces.
///
/// Collected from the *pre*-transform AST, because after lowering there is
/// nothing left to distinguish the generated binding from an authored one.
pub(super) fn hoisted_lowering_names(program: &Program<'_>) -> HashSet<String> {
    fn record(statement: &Statement<'_>, names: &mut HashSet<String>) {
        match statement {
            Statement::TSEnumDeclaration(declaration) => {
                names.insert(declaration.id.name.to_string());
            }
            Statement::TSModuleDeclaration(declaration) => {
                if let TSModuleDeclarationName::Identifier(id) = &declaration.id {
                    names.insert(id.name.to_string());
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    match declaration {
                        Declaration::TSEnumDeclaration(enum_declaration) => {
                            names.insert(enum_declaration.id.name.to_string());
                        }
                        Declaration::TSModuleDeclaration(module_declaration) => {
                            if let TSModuleDeclarationName::Identifier(id) = &module_declaration.id
                            {
                                names.insert(id.name.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    let mut names = HashSet::new();
    for statement in &program.body {
        record(statement, &mut names);
    }
    names
}

/// Restores `var` semantics for the bindings oxc lowers TS constructs onto.
///
/// `tsc` emits `export var Kind;` for an exported enum and `export var Outer;`
/// for an exported namespace. oxc emits `export let` for both, and `let` has a
/// temporal dead zone: a value-position read that runs before the declaration
/// throws `ReferenceError: Cannot access 'Kind' before initialization` instead
/// of reading `undefined` — and `typeof` does not protect against it either
/// (OX-D3 audit §7, with an executing repro; pinned by the risk-6 test in
/// `test/oxc-migration-safety.test.mjs` and by a cargo regression).
///
/// This is a divergence from tsc's *emit contract*, not a style difference, so
/// the lowering is ours: keep oxc's object-construction shape, take back the
/// binding kind.
pub(super) fn force_var_for_lowered_declarations(
    program: &mut Program<'_>,
    names: &HashSet<String>,
) {
    fn fix(declaration: &mut VariableDeclaration<'_>, names: &HashSet<String>) {
        if declaration.kind == VariableDeclarationKind::Var {
            return;
        }
        let lowered = declaration.declarations.iter().any(|declarator| {
            declarator
                .id
                .get_binding_identifier()
                .is_some_and(|binding| names.contains(binding.name.as_str()))
        });
        if lowered {
            declaration.kind = VariableDeclarationKind::Var;
        }
    }

    for statement in program.body.iter_mut() {
        match statement {
            Statement::VariableDeclaration(declaration) => fix(declaration, names),
            Statement::ExportNamedDeclaration(export) => {
                if let Some(Declaration::VariableDeclaration(declaration)) =
                    export.declaration.as_mut()
                {
                    fix(declaration, names);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod namespaces {
    //! Namespace shapes against what the OX-A end-to-end test requires.
    //!
    //! The swc side needed an owned pre-strip pass here: `strip` qualifies a
    //! member reference only inside the block that declares it, so a *merged*
    //! second `namespace A { … }` block emitted bare reads that Closure rejected
    //! (JSC_UNDEFINED_VARIABLE). Whether oxc has the same gap is measured, not
    //! assumed.
    use super::super::lower_with_oxc;
    use std::path::Path;
    use std::process::Command;

    fn run(source: &str) -> String {
        let code = lower_with_oxc(Path::new("m.ts"), source).expect("lowering");
        let dir = std::env::temp_dir().join(format!(
            "gcc-oxc-ns-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("m.mjs");
        std::fs::write(
            &file,
            format!("{code}\nconsole.log(JSON.stringify(probe));\n"),
        )
        .unwrap();
        let output = Command::new("node").arg(&file).output().expect("node");
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            output.status.success(),
            "node failed: {stderr}\n--- emitted:\n{code}"
        );
        stdout
    }

    /// The nesting the OX-A test exercises: three levels, a sibling reference
    /// inside a namespace, and an alias out of the middle of the chain.
    #[test]
    fn a_nested_namespace_chain_executes() {
        let probe = run(concat!(
            "export namespace Outer {\n",
            "  export const version = 3;\n",
            "  export namespace Inner {\n",
            "    export const tag = 'INNER';\n",
            "    export function twice(value: number): number { return value * 2; }\n",
            "    export namespace Deep {\n",
            "      export function thrice(value: number): number { return twice(value) + value; }\n",
            "    }\n",
            "  }\n",
            "  export function describe(): string { return `${version}:${Inner.tag}`; }\n",
            "}\n",
            "export const probe = [Outer.version, Outer.Inner.tag, Outer.Inner.twice(4), Outer.Inner.Deep.thrice(4), Outer.describe()].join('|');\n",
        ));
        assert_eq!(probe, "\"3|INNER|8|12|3:INNER\"");
    }

    /// Declaration merging: the case that needed the owned pre-strip merge on
    /// swc. The second block's body must see the first block's members.
    #[test]
    fn merged_declaration_blocks_execute() {
        let probe = run(concat!(
            "export namespace Outer {\n",
            "  export const version = 3;\n",
            "  export namespace Inner {\n",
            "    export function twice(value: number): number { return value * 2; }\n",
            "  }\n",
            "}\n",
            "export namespace Outer {\n",
            "  export function versionTwice(): number { return Inner.twice(version); }\n",
            "}\n",
            "export const probe = [Outer.version, Outer.versionTwice()].join('|');\n",
        ));
        assert_eq!(probe, "\"3|6\"");
    }
}

#[cfg(test)]
mod namespace_merge_guards {
    //! The conservative gate, same as the swc pass: merging must not reorder
    //! observable work, and must not guess on a mixed group.
    use super::super::lower_with_oxc;
    use std::path::Path;

    #[test]
    fn a_statement_between_blocks_blocks_the_merge() {
        let code = lower_with_oxc(
            Path::new("m.ts"),
            "export namespace A { export const v = 1; }\nconsole.log('between');\nexport namespace A { export function r(): number { return 7; } }\n",
        )
        .unwrap();
        // Two IIFEs still, in source order: the console.log did not move.
        let between = code.find("between").expect("kept");
        let second = code
            .rfind("A ||")
            .or_else(|| code.rfind("A)"))
            .expect("second block");
        assert!(between < second, "{code}");
    }

    #[test]
    fn a_mixed_export_group_is_left_alone() {
        let code = lower_with_oxc(
            Path::new("m.ts"),
            "namespace A { export const v = 1; }\nexport namespace A { export const w = 2; }\n",
        )
        .unwrap();
        assert!(code.contains("A"), "{code}");
    }

    #[test]
    fn a_nested_split_merges_one_level_down() {
        let code = lower_with_oxc(
            Path::new("m.ts"),
            "export namespace O { export namespace I { export const a = 1; } }\nexport function between(): number { return 1; }\nexport namespace O { export namespace I { export const b = 2; } }\n",
        )
        .unwrap();
        // One IIFE per namespace, not two: the inner pair became siblings only
        // after the outer merge, which is why the pass recurses afterwards.
        assert_eq!(code.matches("(O ||").count(), 1, "{code}");
    }
}
