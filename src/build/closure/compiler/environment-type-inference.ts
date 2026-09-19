import {
  normalizeClosureFlagName,
  type ClosureCompilerEnvironment,
  type ClosureCompilerOption,
  type ClosureCompilerOptions,
} from "./environment-resolve";

/**
 * Whether a job should run Closure's type inference *silently*.
 *
 * `--warning_level QUIET` disables the `checkTypes` pass outright, so every
 * type-based optimization pass has been running on an empty type graph and
 * `--use_types_for_optimization` has measured nothing (see the Addendum in
 * docs/research/typed-input.md). `--jscomp_warning=checkTypes` restores the
 * pass and `--hide_warnings_for=/` suppresses every diagnostic it would
 * emit, because inference over third-party bundles produces noise that is
 * never the user's to fix.
 *
 * Types pay only on class-heavy authored TS (`typeDeclarationCount` and
 * `memberAnnotationCount` both > 0). `hasTypeMetadata` alone is not enough:
 * Vite-style jobs with annotations but no type declarations stay off. On
 * real linked apps `--use_types_for_optimization` moved 0.03%. Restricted
 * to ADVANCED. `GCC_DISABLE_TYPE_INFERENCE=1` is the escape hatch.
 */
export function shouldEnableTypeInference(
  compilationLevel: string,
  counts: {
    typeDeclarationCount: number;
    memberAnnotationCount: number;
  },
  typeInferenceDisabled = process.env["GCC_DISABLE_TYPE_INFERENCE"] === "1",
) {
  return (
    compilationLevel === "ADVANCED" &&
    !typeInferenceDisabled &&
    counts.typeDeclarationCount > 0 &&
    counts.memberAnnotationCount > 0
  );
}

function hasHideWarningsFor(
  value: ClosureCompilerOption | ClosureCompilerOption[] | undefined,
): value is ClosureCompilerOption | ClosureCompilerOption[] {
  if (Array.isArray(value)) {
    return value.some((entry) => entry !== false && entry !== "");
  }
  return value !== undefined && value !== false && value !== "";
}

/**
 * Restore `checkTypes` under QUIET. `--hide_warnings_for=/` is the default
 * suppress; an explicit empty hide list (`hideWarningsFor: []`) keeps the
 * warning on and reports diagnostics.
 */
export function applyTypeInferenceOptions(
  closureOptions: ClosureCompilerOptions,
  environmentOptions: ClosureCompilerOptions,
): void {
  const hideWarningsFor = Object.hasOwn(environmentOptions, "hideWarningsFor")
    ? environmentOptions.hideWarningsFor
    : ["/"];
  closureOptions.jscompWarning = ["checkTypes"];
  if (hasHideWarningsFor(hideWarningsFor)) {
    closureOptions.hideWarningsFor = hideWarningsFor;
  }
}

/** Drop an empty hide list so Closure does not receive `--hide_warnings_for`. */
export function omitEmptyHideWarningsFor(
  closureOptions: ClosureCompilerOptions,
): void {
  if (!hasHideWarningsFor(closureOptions.hideWarningsFor)) {
    delete closureOptions.hideWarningsFor;
  }
}

export function withExplicitHideWarningsFor(
  environment: ClosureCompilerEnvironment,
  hideWarningsFor: readonly string[] | undefined,
): ClosureCompilerEnvironment {
  if (hideWarningsFor === undefined) {
    return environment;
  }
  return {
    ...environment,
    options: {
      ...environment.options,
      hideWarningsFor: [...hideWarningsFor],
    },
  };
}

export function hasStrictCheckTypes(options: ClosureCompilerOptions) {
  return Object.entries(options).some(
    ([name, value]) =>
      normalizeClosureFlagName(name) === "jscomperror" &&
      (Array.isArray(value) ? value : [value]).includes("checkTypes"),
  );
}
