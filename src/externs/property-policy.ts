import { isRecord, isString, isUnknownArray } from "../shared/validation";
import { renderStructuralExternLine } from "./barriers";

/**
 * Caller-asserted renameability for structural `Object.prototype.*` pins.
 *
 * Typed owner-qualified declarations are out of scope: those still pin the
 * name globally for renaming, and `emitMember` is untouched.
 */
export interface PropertyPolicy {
  renameable: readonly string[];
}

const RUNTIME_PROTOCOL_PREFIX = "__gcc";

/**
 * Validate and copy a caller-supplied policy. `undefined` is a no-op.
 * Names must be non-empty strings; `__gcc*` is the runtime protocol
 * namespace and is rejected up front.
 */
export function resolvePropertyPolicy(
  policy: PropertyPolicy | undefined,
): PropertyPolicy | undefined {
  if (policy === undefined) {
    return undefined;
  }
  if (!isRecord(policy) || !isUnknownArray(policy.renameable)) {
    throw new Error(
      "generateExterns propertyPolicy.renameable must be an array of non-empty strings.",
    );
  }
  const renameable: string[] = [];
  const seen = new Set<string>();
  const protocolNames: string[] = [];
  for (const name of policy.renameable) {
    if (!isString(name) || name.length === 0) {
      throw new Error(
        "generateExterns propertyPolicy.renameable names must be non-empty strings.",
      );
    }
    if (name.startsWith(RUNTIME_PROTOCOL_PREFIX)) {
      protocolNames.push(name);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    renameable.push(name);
  }
  if (protocolNames.length > 0) {
    throw new Error(
      `generateExterns propertyPolicy.renameable rejects names that begin with "${RUNTIME_PROTOCOL_PREFIX}" (runtime protocol namespace): ${[...new Set(protocolNames)].join(", ")}.`,
    );
  }
  return { renameable };
}

/**
 * Drop structural pin lines whose property name is in `renameable`.
 * Remaining line insertion order is unchanged. Every listed name must
 * match a line that is actually removed; unmatched names fail closed.
 */
export function applyPropertyPolicy(
  emittedLines: Set<string>,
  policy: PropertyPolicy | undefined,
): void {
  if (policy === undefined || policy.renameable.length === 0) {
    return;
  }
  const unmatched: string[] = [];
  for (const name of policy.renameable) {
    if (emittedLines.delete(renderStructuralExternLine(name))) {
      continue;
    }
    unmatched.push(name);
  }
  if (unmatched.length > 0) {
    throw new Error(
      `generateExterns propertyPolicy.renameable names were not pinned by any structural extern line: ${unmatched.join(", ")}.`,
    );
  }
}
