import { defineRule } from "@oxlint/plugins";

import type { ESTree, Options } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;
type OptionRecord = Record<string, Options[number]>;
type OptionName = "allowInTypeGuards" | "allowUndefinedChecks";

const equalityOperators = new Set(["==", "!=", "===", "!=="]);

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

/** `x is T`, `asserts x is T`, and bare `asserts x` all annotate the return as a TSTypePredicate. */
function declaresNarrowing(node: RuntimeFunction): boolean {
	return node.returnType?.typeAnnotation.type === "TSTypePredicate";
}

/** Walks every enclosing function so a nested helper inside a guard stays exempt. */
function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current) && declaresNarrowing(current)) return true;
		current = current.parent;
	}
	return false;
}

function unwrapParentheses(node: ESTree.Node): ESTree.Node {
	let current = node;
	while (current.type === "ParenthesizedExpression") current = current.expression;
	return current;
}

function isUndefinedString(node: ESTree.Node): boolean {
	const operand = unwrapParentheses(node);
	return operand.type === "Literal" && operand.value === "undefined";
}

function isUndefinedCheck(node: ESTree.UnaryExpression): boolean {
	let compared: ESTree.Node = node;
	while (compared.parent !== null && compared.parent.type === "ParenthesizedExpression") {
		compared = compared.parent;
	}
	const parent = compared.parent;
	if (parent === null || parent.type !== "BinaryExpression") return false;
	if (!equalityOperators.has(parent.operator)) return false;
	return isUndefinedString(parent.left === compared ? parent.right : parent.left);
}

function isOptionRecord(option: Options[number] | undefined): option is OptionRecord {
	return typeof option === "object" && option !== null && !Array.isArray(option);
}

/** Both allowances default to true, so only an explicit `false` withdraws one. */
function isAllowed(options: Readonly<Options>, key: OptionName): boolean {
	const option = options[0];
	return !isOptionRecord(option) || option[key] !== false;
}

/** Disallow runtime typeof checks outside the named guards that give them a contract. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks outside a type guard or assertion function; existence checks against `\"undefined\"` stay allowed.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Move it into a named type guard or assertion function at the boundary and call that instead; do not reach for `Object.prototype.toString`, `Function.prototype.toString`, `instanceof`, or a try/catch, which are slower, spoofable through `Symbol.toStringTag`, and wrong across realms.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
					allowUndefinedChecks: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: true, allowUndefinedChecks: true }],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				if (node.operator !== "typeof") return;
				if (isAllowed(context.options, "allowInTypeGuards") && isInsideTypeGuard(node)) return;
				if (isAllowed(context.options, "allowUndefinedChecks") && isUndefinedCheck(node)) return;
				context.report({ node, messageId: "runtimeTypeof" });
			},
		};
	},
});
