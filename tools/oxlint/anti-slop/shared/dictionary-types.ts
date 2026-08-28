import type { ESTree } from "@oxlint/plugins";

const BUILT_INS = new Set([
	"Record",
	"Readonly",
	"Partial",
	"Required",
	"Pick",
	"Omit",
	"PropertyKey",
	"NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);
const EVIDENCE_FREE_UNARY_OPERATORS = new Set(["delete", "typeof", "void"]);

type TypeAliasEnvironment = ReadonlyMap<string, ESTree.TSType>;

const NO_SUBSTITUTIONS: TypeAliasEnvironment = new Map();
const NO_RESOLVING: ReadonlySet<string> = new Set();

type ResolvedType = {
	readonly type: ESTree.TSType;
	readonly substitutions: TypeAliasEnvironment;
};

export type UnsafeDictionary = {
	readonly kind: "unsafe-dictionary";
	readonly unsafeValue: "any" | "empty-object" | "object" | "union" | "unknown";
};

export type WideningTargetKind =
	| "any"
	| "anonymous object"
	| "generic container"
	| "object"
	| "open dictionary"
	| "unknown";

export type WideningTarget = {
	readonly kind: WideningTargetKind;
};

export type TypeEnvironment = {
	readonly aliases: ReadonlyMap<string, ESTree.TSTypeAliasDeclaration>;
	readonly interfaces: ReadonlyMap<string, readonly ESTree.TSInterfaceDeclaration[]>;
	readonly shadowedBuiltIns: ReadonlySet<string>;
};

function declaredStatement(statement: ESTree.Statement): ESTree.Node | null {
	return statement.type === "ExportNamedDeclaration" ||
		statement.type === "ExportDefaultDeclaration"
		? (statement.declaration ?? null)
		: statement;
}

type MutableTypeEnvironment = {
	readonly aliases: Map<string, ESTree.TSTypeAliasDeclaration>;
	readonly interfaces: Map<string, ESTree.TSInterfaceDeclaration[]>;
	readonly shadowedBuiltIns: Set<string>;
};

function shadowIfBuiltIn(name: string, environment: MutableTypeEnvironment): void {
	if (BUILT_INS.has(name)) environment.shadowedBuiltIns.add(name);
}

function recordImportShadowing(
	declaration: ESTree.ImportDeclaration,
	environment: MutableTypeEnvironment,
): void {
	for (const specifier of declaration.specifiers) {
		shadowIfBuiltIn(specifier.local.name, environment);
	}
}

function recordTypeAlias(
	declaration: ESTree.TSTypeAliasDeclaration,
	environment: MutableTypeEnvironment,
): void {
	const existing = environment.aliases.get(declaration.id.name);
	if (existing === undefined) environment.aliases.set(declaration.id.name, declaration);
	else environment.shadowedBuiltIns.add(declaration.id.name);
	shadowIfBuiltIn(declaration.id.name, environment);
}

function recordInterface(
	declaration: ESTree.TSInterfaceDeclaration,
	environment: MutableTypeEnvironment,
): void {
	const declarations = environment.interfaces.get(declaration.id.name) ?? [];
	declarations.push(declaration);
	environment.interfaces.set(declaration.id.name, declarations);
	shadowIfBuiltIn(declaration.id.name, environment);
}

function recordDeclaration(declaration: ESTree.Node, environment: MutableTypeEnvironment): void {
	switch (declaration.type) {
		case "ImportDeclaration":
			recordImportShadowing(declaration, environment);
			return;
		case "TSTypeAliasDeclaration":
			recordTypeAlias(declaration, environment);
			return;
		case "TSInterfaceDeclaration":
			recordInterface(declaration, environment);
			return;
		case "TSEnumDeclaration":
			shadowIfBuiltIn(declaration.id.name, environment);
			return;
		case "ClassDeclaration":
		case "FunctionDeclaration":
			if (declaration.id !== null) shadowIfBuiltIn(declaration.id.name, environment);
			return;
		default:
			return;
	}
}

export function createTypeEnvironment(program: ESTree.Program): TypeEnvironment {
	const environment: MutableTypeEnvironment = {
		aliases: new Map(),
		interfaces: new Map(),
		shadowedBuiltIns: new Set(),
	};
	for (const statement of program.body) {
		const declaration = declaredStatement(statement);
		if (declaration === null) continue;
		recordDeclaration(declaration, environment);
	}
	return environment;
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
	return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isBuiltIn(name: string, environment: TypeEnvironment): boolean {
	return BUILT_INS.has(name) && !environment.shadowedBuiltIns.has(name);
}

function isUnappliedReferenceTo(type: ESTree.TSType, name: string): boolean {
	const unwrapped = unwrapTransparentType(type);
	return (
		unwrapped.type === "TSTypeReference" &&
		typeReferenceName(unwrapped) === name &&
		(unwrapped.typeArguments === null ||
			unwrapped.typeArguments === undefined ||
			unwrapped.typeArguments.params.length === 0)
	);
}

function unwrapTransparentType(type: ESTree.TSType): ESTree.TSType {
	let current = type;
	while (
		current.type === "TSParenthesizedType" ||
		(current.type === "TSTypeOperator" && current.operator === "readonly")
	) {
		current = current.typeAnnotation;
	}
	return current;
}

function isNeverType(type: ESTree.TSType): boolean {
	return unwrapTransparentType(type).type === "TSNeverKeyword";
}

function isEffectivelyEmptyMember(member: ESTree.TSSignature): boolean {
	return (
		member.type === "TSPropertySignature" &&
		member.optional === true &&
		member.typeAnnotation !== null &&
		member.typeAnnotation !== undefined &&
		isNeverType(member.typeAnnotation.typeAnnotation)
	);
}

function isEffectivelyEmptyTypeLiteral(type: ESTree.TSTypeLiteral): boolean {
	return type.members.length === 0 || type.members.every(isEffectivelyEmptyMember);
}

function isEffectivelyEmptyInterface(
	declarations: readonly ESTree.TSInterfaceDeclaration[],
): boolean {
	if (declarations.length !== 1) return false;
	const [type] = declarations;
	return (
		type !== undefined &&
		type.extends.length === 0 &&
		(type.body.body.length === 0 || type.body.body.every(isEffectivelyEmptyMember))
	);
}

function resolvedSubstitutionArgument(
	type: ESTree.TSType,
	base: TypeAliasEnvironment,
	resolving: ReadonlySet<string> = new Set(),
): ESTree.TSType {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type !== "TSTypeReference") return type;
	const name = typeReferenceName(unwrapped);
	if (name === null || resolving.has(name)) return type;
	const substitution = base.get(name);
	if (substitution === undefined) return type;
	const nextResolving = new Set(resolving);
	nextResolving.add(name);
	return resolvedSubstitutionArgument(substitution, base, nextResolving);
}

function aliasSubstitution(
	alias: ESTree.TSTypeAliasDeclaration,
	type: ESTree.TSTypeReference,
	base: TypeAliasEnvironment,
): TypeAliasEnvironment | null {
	const parameters = alias.typeParameters?.params ?? [];
	const arguments_ = type.typeArguments?.params ?? [];
	const next = new Map(base);
	for (const [index, parameter] of parameters.entries()) {
		const argument = arguments_[index] ?? parameter.default;
		if (argument === null || argument === undefined) return null;
		next.set(parameter.name.name, resolvedSubstitutionArgument(argument, next));
	}
	return next;
}

type ExpandedAlias = {
	readonly type: ESTree.TSType;
	readonly substitutions: TypeAliasEnvironment;
	readonly resolvingAliases: ReadonlySet<string>;
};

function expandAlias(
	name: string,
	type: ESTree.TSTypeReference,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): ExpandedAlias | null {
	const alias = environment.aliases.get(name);
	if (alias === undefined || resolvingAliases.has(name)) return null;
	const nextSubstitutions = aliasSubstitution(alias, type, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(name);
	return {
		type: alias.typeAnnotation,
		substitutions: nextSubstitutions,
		resolvingAliases: nextResolving,
	};
}

function unsafeUnionValue(
	type: ESTree.TSUnionType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): UnsafeDictionary["unsafeValue"] | null {
	const hasUnsafeMember = type.types.some(
		(member) => unsafeDirectValue(member, environment, substitutions, resolvingAliases) !== null,
	);
	return hasUnsafeMember ? "union" : null;
}

function unsafeIntersectionValue(
	type: ESTree.TSIntersectionType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): UnsafeDictionary["unsafeValue"] | null {
	const unsafeMembers = type.types.map((member) =>
		unsafeDirectValue(member, environment, substitutions, resolvingAliases),
	);
	if (unsafeMembers.includes("any")) return "any";
	if (unsafeMembers.length === 0) return null;
	if (!unsafeMembers.every((member) => member !== null)) return null;
	return unsafeMembers[0] ?? null;
}

function unsafeReferenceValue(
	type: ESTree.TSTypeReference,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): UnsafeDictionary["unsafeValue"] | null {
	const name = typeReferenceName(type);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
		const wrapped = type.typeArguments?.params[0];
		if (wrapped === undefined) return null;
		return unsafeDirectValue(wrapped, environment, substitutions, resolvingAliases);
	}
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		if (isUnappliedReferenceTo(substitution, name)) return null;
		return unsafeDirectValue(substitution, environment, substitutions, resolvingAliases);
	}
	const interfaceDeclarations = environment.interfaces.get(name);
	if (interfaceDeclarations !== undefined) {
		return isEffectivelyEmptyInterface(interfaceDeclarations) ? "empty-object" : null;
	}
	const expanded = expandAlias(name, type, environment, substitutions, resolvingAliases);
	if (expanded === null) return null;
	return unsafeDirectValue(
		expanded.type,
		environment,
		expanded.substitutions,
		expanded.resolvingAliases,
	);
}

function unsafeDirectValue(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): UnsafeDictionary["unsafeValue"] | null {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return "unknown";
	if (unwrapped.type === "TSAnyKeyword") return "any";
	if (unwrapped.type === "TSObjectKeyword") return "object";
	if (unwrapped.type === "TSTypeLiteral") {
		return isEffectivelyEmptyTypeLiteral(unwrapped) ? "empty-object" : null;
	}
	if (unwrapped.type === "TSUnionType") {
		return unsafeUnionValue(unwrapped, environment, substitutions, resolvingAliases);
	}
	if (unwrapped.type === "TSIntersectionType") {
		return unsafeIntersectionValue(unwrapped, environment, substitutions, resolvingAliases);
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	return unsafeReferenceValue(unwrapped, environment, substitutions, resolvingAliases);
}

function openIndexMemberValue(
	member: ESTree.TSSignature,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): readonly ResolvedType[] {
	if (member.type !== "TSIndexSignature") return [];
	if (member.typeAnnotation === null) return [];
	if (
		isClosedKeySet(
			indexSignatureKeyType(member),
			environment,
			substitutions,
			resolvingAliases,
		)
	) {
		return [];
	}
	return [{ type: member.typeAnnotation.typeAnnotation, substitutions }];
}

function mappedValueTypes(
	type: ESTree.TSMappedType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): readonly ResolvedType[] {
	if (type.typeAnnotation === null) return [];
	if (isClosedKeySet(type.constraint, environment, substitutions, resolvingAliases)) return [];
	return [{ type: type.typeAnnotation, substitutions }];
}

function recordValueTypes(
	type: ESTree.TSTypeReference,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): readonly ResolvedType[] {
	const key = type.typeArguments?.params[0] ?? null;
	const value = type.typeArguments?.params[1] ?? null;
	if (value === null) return [];
	if (isClosedKeySet(key, environment, substitutions, resolvingAliases)) return [];
	return [{ type: value, substitutions }];
}

function pickOmitValueTypes(
	name: "Pick" | "Omit",
	type: ESTree.TSTypeReference,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): readonly ResolvedType[] {
	const source = type.typeArguments?.params[0];
	if (source === undefined) return [];
	const keys = type.typeArguments?.params[1] ?? null;
	// Picking a finite key set closes the record whatever the source was, while Omit leaves the
	// source's key set exactly as open as it found it.
	if (name === "Pick" && isClosedKeySet(keys, environment, substitutions, resolvingAliases)) {
		return [];
	}
	return dictionaryValueTypes(source, environment, substitutions, resolvingAliases);
}

function referenceValueTypes(
	type: ESTree.TSTypeReference,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): readonly ResolvedType[] {
	const name = typeReferenceName(type);
	if (name === null) return [];
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		if (isUnappliedReferenceTo(substitution, name)) return [];
		return dictionaryValueTypes(substitution, environment, substitutions, resolvingAliases);
	}
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
		const wrapped = type.typeArguments?.params[0];
		if (wrapped === undefined) return [];
		return dictionaryValueTypes(wrapped, environment, substitutions, resolvingAliases);
	}
	if (name === "Record" && isBuiltIn(name, environment)) {
		return recordValueTypes(type, environment, substitutions, resolvingAliases);
	}
	if ((name === "Pick" || name === "Omit") && isBuiltIn(name, environment)) {
		return pickOmitValueTypes(name, type, environment, substitutions, resolvingAliases);
	}
	const expanded = expandAlias(name, type, environment, substitutions, resolvingAliases);
	if (expanded === null) return [];
	return dictionaryValueTypes(
		expanded.type,
		environment,
		expanded.substitutions,
		expanded.resolvingAliases,
	);
}

function dictionaryValueTypes(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): readonly ResolvedType[] {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.flatMap((member) =>
			openIndexMemberValue(member, environment, substitutions, resolvingAliases),
		);
	}
	if (unwrapped.type === "TSMappedType") {
		return mappedValueTypes(unwrapped, environment, substitutions, resolvingAliases);
	}
	if (unwrapped.type !== "TSTypeReference") return [];
	return referenceValueTypes(unwrapped, environment, substitutions, resolvingAliases);
}

export function classifyUnsafeDictionaryValue(
	valueType: ESTree.TSType,
	environment: TypeEnvironment,
): UnsafeDictionary | null {
	const unsafeValue = unsafeDirectValue(valueType, environment, NO_SUBSTITUTIONS, NO_RESOLVING);
	return unsafeValue === null ? null : { kind: "unsafe-dictionary", unsafeValue };
}

export function classifyUnsafeDictionary(
	type: ESTree.TSType,
	environment: TypeEnvironment,
): UnsafeDictionary | null {
	for (const valueType of dictionaryValueTypes(type, environment, NO_SUBSTITUTIONS, NO_RESOLVING)) {
		const unsafeValue = unsafeDirectValue(
			valueType.type,
			environment,
			valueType.substitutions,
			NO_RESOLVING,
		);
		if (unsafeValue !== null) return { kind: "unsafe-dictionary", unsafeValue };
	}
	return null;
}

function resolvesToDictionary(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): boolean {
	return dictionaryValueTypes(type, environment, substitutions, resolvingAliases).length > 0;
}

export function classifyWideningTarget(
	type: ESTree.TSType,
	environment: TypeEnvironment,
): WideningTarget | null {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSAnyKeyword") return { kind: "any" };
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		// A type literal made of concrete members restates the evidence instead of widening it, so
		// only an open index signature or an escape-hatch member counts as a broader target.
		if (hasOpenIndexSignature(unwrapped, environment, NO_SUBSTITUTIONS, NO_RESOLVING)) {
			return { kind: "open dictionary" };
		}
		return hasEscapeHatchMember(unwrapped, environment, NO_SUBSTITUTIONS, NO_RESOLVING)
			? { kind: "anonymous object" }
			: null;
	}
	if (unwrapped.type === "TSMappedType") {
		return isClosedKeySet(unwrapped.constraint, environment, NO_SUBSTITUTIONS, NO_RESOLVING)
			? null
			: { kind: "open dictionary" };
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined ? null : classifyWideningTarget(wrapped, environment);
	}
	if (name === "Record" && isBuiltIn(name, environment)) {
		const key = unwrapped.typeArguments?.params[0] ?? null;
		return isClosedKeySet(key, environment, NO_SUBSTITUTIONS, NO_RESOLVING)
			? null
			: { kind: "open dictionary" };
	}
	const alias = environment.aliases.get(name);
	if (alias === undefined) return null;
	if ((alias.typeParameters?.params.length ?? 0) > 0) {
		const substitutions = aliasSubstitution(alias, unwrapped, NO_SUBSTITUTIONS);
		return substitutions !== null &&
			resolvesToDictionary(alias.typeAnnotation, environment, substitutions, new Set([name]))
			? { kind: "generic container" }
			: null;
	}
	const substitutions = aliasSubstitution(alias, unwrapped, NO_SUBSTITUTIONS);
	if (substitutions === null) return null;
	return classifyAliasBroadTarget(
		alias.typeAnnotation,
		environment,
		substitutions,
		new Set([name]),
	);
}

function indexSignatureKeyType(member: ESTree.TSIndexSignature): ESTree.TSType | null {
	return member.parameters[0]?.typeAnnotation?.typeAnnotation ?? null;
}

/**
 * A key set counts as closed when it provably resolves to a finite union of literal keys, or when it
 * is the `keyof` of a type that is not itself an open dictionary. Anything else unresolvable stays
 * open, so `string`, `PropertyKey`, template literals, unsubstituted type parameters, and missing
 * annotations keep the dictionary verdict they had before.
 */
function isClosedKeySet(
	type: ESTree.TSType | null,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): boolean {
	if (type === null) return false;
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSLiteralType") return true;
	// `keyof X` states that the keys are exactly X's own, which is the opposite of a dictionary that
	// promises nothing about them. That holds whether or not X is declared in this file, so a
	// projection over an imported type stays closed; only a provably open X reopens the key set.
	if (unwrapped.type === "TSTypeOperator" && unwrapped.operator === "keyof") {
		return !resolvesToDictionary(
			unwrapped.typeAnnotation,
			environment,
			substitutions,
			resolvingAliases,
		);
	}
	if (unwrapped.type === "TSUnionType") {
		return (
			unwrapped.types.length > 0 &&
			unwrapped.types.every((member) =>
				isClosedKeySet(member, environment, substitutions, resolvingAliases),
			)
		);
	}
	if (unwrapped.type !== "TSTypeReference") return false;
	const name = typeReferenceName(unwrapped);
	if (name === null) return false;
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return (
			!isUnappliedReferenceTo(substitution, name) &&
			isClosedKeySet(substitution, environment, substitutions, resolvingAliases)
		);
	}
	const alias = environment.aliases.get(name);
	if (alias === undefined || resolvingAliases.has(name)) return false;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return false;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(name);
	return isClosedKeySet(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
}

function hasOpenIndexSignature(
	type: ESTree.TSTypeLiteral,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): boolean {
	return type.members.some(
		(member) =>
			member.type === "TSIndexSignature" &&
			!isClosedKeySet(
				indexSignatureKeyType(member),
				environment,
				substitutions,
				resolvingAliases,
			),
	);
}

function hasEscapeHatchMember(
	type: ESTree.TSTypeLiteral,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): boolean {
	return type.members.some((member) => {
		if (member.type !== "TSPropertySignature") return false;
		const memberType = member.typeAnnotation?.typeAnnotation;
		return (
			memberType !== undefined &&
			unsafeDirectValue(memberType, environment, substitutions, resolvingAliases) !== null
		);
	});
}

function classifyAliasBroadTarget(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<string>,
): WideningTarget | null {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSAnyKeyword") return { kind: "any" };
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		return hasOpenIndexSignature(unwrapped, environment, substitutions, resolvingAliases)
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type === "TSMappedType") {
		return isClosedKeySet(unwrapped.constraint, environment, substitutions, resolvingAliases)
			? null
			: { kind: "open dictionary" };
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? null
			: classifyAliasBroadTarget(
					substitution,
					environment,
					substitutions,
					resolvingAliases,
				);
	}
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: classifyAliasBroadTarget(wrapped, environment, substitutions, resolvingAliases);
	}
	if (name === "Record" && isBuiltIn(name, environment)) {
		const key = unwrapped.typeArguments?.params[0] ?? null;
		return isClosedKeySet(key, environment, substitutions, resolvingAliases)
			? null
			: { kind: "open dictionary" };
	}
	const alias = environment.aliases.get(name);
	if (alias === undefined || resolvingAliases.has(name)) return null;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(name);
	return classifyAliasBroadTarget(
		alias.typeAnnotation,
		environment,
		nextSubstitutions,
		nextResolving,
	);
}

export function isKnownEvidenceExpression(expression: ESTree.Expression): boolean {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression" ||
		current.type === "TSSatisfiesExpression"
	) {
		current = current.expression;
	}
	// `typeof`, `delete`, and `void` report on a runtime probe, not on the value's own type.
	if (current.type === "UnaryExpression") {
		return !EVIDENCE_FREE_UNARY_OPERATORS.has(current.operator);
	}
	return (
		current.type === "ArrayExpression" ||
		current.type === "ArrowFunctionExpression" ||
		current.type === "ClassExpression" ||
		current.type === "FunctionExpression" ||
		current.type === "NewExpression" ||
		current.type === "Literal" ||
		current.type === "ObjectExpression" ||
		current.type === "TemplateLiteral"
	);
}
