import { defineRule } from "@oxlint/plugins";

import type { ESTree, Options } from "@oxlint/plugins";

type OptionRecord = Record<string, Options[number]>;
type SymbolNameNode =
	| ESTree.BindingIdentifier
	| ESTree.IdentifierName
	| ESTree.IdentifierReference
	| ESTree.LabelIdentifier
	| ESTree.PrivateIdentifier
	| ESTree.TSIndexSignatureName
	| ESTree.TSThisParameter;

const defaultTerms: readonly string[] = ["shape"];

/** One word segment: an acronym run, or a word with an optional leading capital. */
const nameSegment = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+/gu;

function isOptionRecord(option: Options[number] | undefined): option is OptionRecord {
	return typeof option === "object" && option !== null && !Array.isArray(option);
}

/** Configuring `terms` replaces the default list rather than adding to it. */
function bannedTerms(options: Readonly<Options>): readonly string[] {
	const option = options[0];
	if (!isOptionRecord(option)) return defaultTerms;
	const configured = option.terms;
	if (!Array.isArray(configured)) return defaultTerms;
	const terms = configured.filter((term): term is string => typeof term === "string");
	return terms.length === 0 ? defaultTerms : terms;
}

/** The first banned term that is a whole segment of `name`, so `reshape` and `shapes` pass. */
function matchedTerm(name: string, terms: readonly string[]): string | null {
	const segments = name.match(nameSegment);
	if (segments === null) return null;
	const present = new Set(segments.map((segment) => segment.toLowerCase()));
	return terms.find((term) => present.has(term.toLowerCase())) ?? null;
}

function importedName(specifier: ESTree.ImportSpecifier): string {
	const imported = specifier.imported;
	return imported.type === "Identifier" ? imported.name : imported.value;
}

/** Whether the identifier is the name a declaration or a member definition is declared under. */
function isDeclaredName(node: SymbolNameNode): boolean {
	const parent = node.parent;
	switch (parent.type) {
		case "ClassDeclaration":
		case "ClassExpression":
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "TSDeclareFunction":
		case "TSEmptyBodyFunctionExpression":
		case "TSEnumDeclaration":
		case "TSInterfaceDeclaration":
		case "TSTypeAliasDeclaration":
			return parent.id === node;
		case "TSEnumMember":
			return !parent.computed && parent.id === node;
		case "TSTypeParameter":
			return parent.name === node;
		case "AccessorProperty":
		case "MethodDefinition":
		case "PropertyDefinition":
		case "TSAbstractAccessorProperty":
		case "TSAbstractMethodDefinition":
		case "TSAbstractPropertyDefinition":
		case "TSMethodSignature":
		case "TSPropertySignature":
			return !parent.computed && parent.key === node;
		case "TSIndexSignature":
			return parent.parameters.some((parameter) => parameter === node);
		case "ImportDefaultSpecifier":
		case "ImportNamespaceSpecifier":
			return parent.local === node;
		case "ImportSpecifier":
			// An unaliased import carries the exporting package's name, which this repository
			// cannot change; only an alias chosen here is a naming decision made here.
			return parent.local === node && importedName(parent) !== node.name;
		default:
			return false;
	}
}

/** Whether the identifier binds a local name as a declarator, a parameter, or a catch parameter. */
function isBindingName(node: SymbolNameNode): boolean {
	let current: ESTree.Node = node;
	let parent: ESTree.Node | null = node.parent;
	while (parent !== null) {
		switch (parent.type) {
			case "VariableDeclarator":
				return parent.id === current;
			case "CatchClause":
				return parent.param === current;
			case "ArrowFunctionExpression":
			case "FunctionDeclaration":
			case "FunctionExpression":
			case "TSCallSignatureDeclaration":
			case "TSConstructSignatureDeclaration":
			case "TSConstructorType":
			case "TSDeclareFunction":
			case "TSEmptyBodyFunctionExpression":
			case "TSFunctionType":
			case "TSMethodSignature":
				return parent.params.some((parameter) => parameter === current);
			case "TSParameterProperty":
				if (parent.parameter !== current) return false;
				break;
			case "AssignmentPattern":
				if (parent.left !== current) return false;
				break;
			case "RestElement":
				if (parent.argument !== current) return false;
				break;
			// Only the bound side of a destructured property is a name; its key names the source.
			case "Property":
				if (parent.value !== current) return false;
				break;
			case "ArrayPattern":
			case "ObjectPattern":
				break;
			default:
				return false;
		}
		current = parent;
		parent = current.parent;
	}
	return false;
}

/** Ban vague terms as whole word segments of the symbol names this repository declares. */
export const noShapeInSymbolNamesRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				'Disallow vague terms, "shape" by default, as whole word segments of declared JavaScript and TypeScript symbol names.',
		},
		messages: {
			forbiddenSymbolName:
				'Rename symbol "{{name}}": the word "{{term}}" names a representation rather than a role, so it says nothing the declaration does not already show. Name it for the role its value plays in the domain.',
		},
		schema: [
			{
				type: "object",
				properties: {
					terms: { type: "array", items: { type: "string" } },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ terms: [...defaultTerms] }],
	},
	createOnce(context) {
		const reportForbiddenSymbolName = (node: SymbolNameNode) => {
			const term = matchedTerm(node.name, bannedTerms(context.options));
			if (term === null) return;
			if (!isDeclaredName(node) && !isBindingName(node)) return;
			context.report({
				node,
				messageId: "forbiddenSymbolName",
				data: { name: node.name, term },
			});
		};

		return {
			Identifier: reportForbiddenSymbolName,
			PrivateIdentifier: reportForbiddenSymbolName,
		};
	},
});
