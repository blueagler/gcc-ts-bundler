import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

type StatementList = readonly (ESTree.Directive | ESTree.Statement)[];

/** Type aliases a name can resolve to, keyed by the name they introduce. */
export type TypeAliasTable = ReadonlyMap<string, ESTree.TSTypeAliasDeclaration>;

/** Everything the `unknown` rules need to agree on what a written type resolves to. */
export type UnknownResolutionScope = {
	readonly aliases: TypeAliasTable;
	/** Type parameter names in scope, which bind ahead of a same-named alias. */
	readonly shadowedNames: ReadonlySet<string>;
	/** Optional wrapper unwrapping, such as reading the value type out of `Promise<T>`. */
	readonly unwrapReference?: (reference: ESTree.TSTypeReference) => ESTree.TSType | null;
};

function collectAliasDeclarations(
	body: StatementList,
	declarations: ESTree.TSTypeAliasDeclaration[],
): void {
	const nestedBodies: StatementList[] = [];
	for (const statement of body) {
		const declaration =
			statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
		if (declaration === null || declaration === undefined) continue;
		if (declaration.type === "TSTypeAliasDeclaration") {
			declarations.push(declaration);
			continue;
		}
		if (declaration.type !== "TSModuleDeclaration") continue;
		const moduleBody = declaration.body;
		if (moduleBody !== null && moduleBody !== undefined) nestedBodies.push(moduleBody.body);
	}
	for (const nested of nestedBodies) collectAliasDeclarations(nested, declarations);
}

/** List every alias a file declares, including those inside `namespace` and `module` bodies. */
function declaredTypeAliases(program: ESTree.Program): readonly ESTree.TSTypeAliasDeclaration[] {
	const declarations: ESTree.TSTypeAliasDeclaration[] = [];
	collectAliasDeclarations(program.body, declarations);
	return declarations;
}

function aliasTable(declarations: readonly ESTree.TSTypeAliasDeclaration[]): TypeAliasTable {
	const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();
	// Enclosing scopes come first, so an outer alias keeps a name that a namespace reuses.
	for (const declaration of declarations) {
		if (!aliases.has(declaration.id.name)) aliases.set(declaration.id.name, declaration);
	}
	return aliases;
}

/** Index the aliases of a file so a written name can be followed without type information. */
export function collectTypeAliases(program: ESTree.Program): TypeAliasTable {
	return aliasTable(declaredTypeAliases(program));
}

function isUnknown(
	type: ESTree.TSType,
	scope: UnknownResolutionScope,
	visited: ReadonlySet<string>,
): boolean {
	if (type.type === "TSUnknownKeyword") return true;
	if (type.type === "TSParenthesizedType") return isUnknown(type.typeAnnotation, scope, visited);
	// A union with an `unknown` member collapses to `unknown`.
	if (type.type === "TSUnionType") {
		return type.types.some((member) => isUnknown(member, scope, visited));
	}
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return false;
	const name = type.typeName.name;
	if (scope.shadowedNames.has(name) || visited.has(name)) return false;
	const unwrapped = scope.unwrapReference?.(type) ?? null;
	if (unwrapped !== null) return isUnknown(unwrapped, scope, visited);
	if ((type.typeArguments?.params.length ?? 0) > 0) return false;
	const alias = scope.aliases.get(name);
	if (
		alias === undefined ||
		(alias.typeParameters !== null && alias.typeParameters !== undefined)
	) {
		return false;
	}
	const nextVisited = new Set(visited);
	nextVisited.add(name);
	return isUnknown(alias.typeAnnotation, scope, nextVisited);
}

/** Report whether a written type collapses to `unknown` through parentheses, aliases, and unions. */
export function resolvesToUnknown(type: ESTree.TSType, scope: UnknownResolutionScope): boolean {
	return isUnknown(type, scope, new Set());
}

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow type aliases whose resolved type is unknown; unknown must stay visible at the boundary that parses it.",
		},
		messages: {
			unknownAlias:
				"Type alias `{{alias}}` resolves to `unknown`, and an unconstrained type parameter in its place is the same escape hatch under a new name. Name the domain type this value has once it is parsed at its I/O boundary, and spell `unknown` out at that boundary instead.",
		},
	},
	createOnce(context) {
		return {
			Program(node) {
				const declarations = declaredTypeAliases(node);
				const aliases = aliasTable(declarations);
				for (const alias of declarations) {
					const scope: UnknownResolutionScope = {
						aliases,
						shadowedNames: lexicalTypeParameterNames(alias, context.sourceCode.visitorKeys),
					};
					if (!resolvesToUnknown(alias.typeAnnotation, scope)) continue;
					context.report({
						node: alias.id,
						messageId: "unknownAlias",
						data: { alias: alias.id.name },
					});
				}
			},
		};
	},
});
