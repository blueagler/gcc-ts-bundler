# anti-slop

An Oxlint plugin of fifteen generic rules that reject low-evidence code: patterns that compile and run while telling the reader, the compiler, and the next caller nothing about what a value actually is or who owns it.

The thesis is that most of these patterns are the same mistake wearing different syntax. A value arrives without a contract, and instead of establishing one at the boundary where it enters the program, the code carries the uncertainty inward and papers over it locally with an assertion, a `typeof` branch, an `unknown` annotation, or an open dictionary. Each of those is cheap to write and expensive to own, because the knowledge of what the value is now lives in the author's head rather than in a type. Every rule here points at one such pattern, and in every case the intended fix has the same shape: parse or validate once at the I/O boundary, name the resulting type after the domain role it plays, and let inference carry that type through the rest of the program.

The rules are deliberately generic, so they belong in any TypeScript or JavaScript repository. Project-specific rules belong in a separate plugin.

## Rules

### no-chained-type-assertions

Rationale: a chain such as `as unknown as T` exists precisely because the direct assertion was rejected. Widening to the top type first is not evidence that the value is a `T`; it only removes the compiler's ability to object. The chain states that the author overrode the type system twice in a row, which is exactly where a mismatch between an external payload and its assumed type survives review.

Wrong:

```ts
const config = readFileSync("config.json", "utf8") as unknown as ServerConfig;
```

Right:

```ts
const config = parseServerConfig(JSON.parse(readFileSync("config.json", "utf8")));
```

Options: none. A chain composed only of `as const` assertions is allowed, because const assertions narrow rather than widen, though TypeScript rejects a repeated const assertion on its own, so the allowance mostly documents intent.

### no-conditional-empty-object-spread

Rationale: `...(condition ? { key: value } : {})` hides a property omission inside an expression. The reader has to evaluate a conditional and recognize that spreading an empty object is the idiom for "leave this key out", and the resulting type is a union that inference handles worse than the equivalent statements. Assembling the object explicitly makes both the presence rule and the resulting shape legible.

Wrong:

```ts
const request = {
  url,
  ...(timeout === undefined ? {} : { timeout }),
};
```

Right:

```ts
const request: Request = { url };
if (timeout !== undefined) request.timeout = timeout;
```

Options: none. The rule reads object spreads and JSX attribute spreads, and it strips the wrappers that leave the spread value unchanged, so parentheses, `as T`, `satisfies T`, and a non-null assertion do not hide the pattern. A logical expression is read the same way as a ternary: `...(hasTimeout && { timeout })` omits the key through the operator's falsy result rather than through a written `{}`, and it reports for the same reason. Two object operands are a choice between shapes rather than an omission, so `...(a ? { x } : { x: y })` stays silent.

`??` is deliberately outside the rule. `...(options.compiler ?? {})` defaults a whole optional value instead of deciding whether one named key appears, so there is no omission for a reader to reconstruct and the rewrite above does not describe the code at all. Cloning an optional object this way is the idiomatic form, and reporting it would be a false positive on correct code.

### no-known-value-widening

Rationale: when a value's type is already established syntactically, annotating it with a broad or anonymous target throws that knowledge away at the one moment it was free to keep. A literal object annotated as `Record<string, unknown>` loses its keys; a known value annotated as `object` or `unknown` loses everything. The annotation looks like documentation but is a downgrade, and every downstream caller pays for it with an assertion.

Wrong:

```ts
const routes: Record<string, unknown> = { home: "/", search: "/search" };
```

Right:

```ts
const routes = { home: "/", search: "/search" } as const satisfies Record<string, string>;
```

Options: none. Seeding an empty object literal into a dictionary or generic container that is filled later is allowed, since there is no evidence to discard. A homomorphic mapped type such as `{ [Key in keyof Settings]: string[] }` is not a widening target either, because its keys are pinned to a named type rather than left open.

### no-module-mocking

Rationale: `vi.mock`, `vi.doMock`, `jest.mock`, and `jest.unstable_mockModule` replace a module behind its importers' backs. The test then passes against a fabrication whose shape is never checked against the real module, so it keeps passing after the real module's contract changes. Injecting the dependency through an interface makes the substitution type-checked and puts the seam in the production code where it belongs.

Wrong:

```ts
vi.mock("./clock.ts", () => ({ now: () => 0 }));
```

Right:

```ts
const frozenClock: Clock = { now: () => 0 };
const service = createService({ clock: frozenClock });
```

Options: `modules` lists the module specifiers whose mocking surface the rule rejects, and configuring it replaces the default list of `vitest`, `@jest/globals`, `jest`, and `bun:test` rather than extending it. The rule recognizes `vi` and `jest` as globals, as named, default, and namespace imports, and as `require` or dynamic `import` bindings. It also follows the mocking API reached through the module binding itself, so `vitest.vi.mock(…)` and `vitest["vi"].mock(…)` are reported alongside `vi.mock(…)`, while a local binding that merely shares the name is not.

### no-object-parameters

Rationale: `object` says only that the argument is not a primitive. A function that accepts it cannot read any property without an assertion, and a caller cannot tell what to pass. It is almost always a placeholder left where a named input type should be, and it pushes the parsing work into the function body, where it is repeated for every call path.

Wrong:

```ts
function saveSettings(settings: object): void {}
```

Right:

```ts
function saveSettings(settings: EditorSettings): void {}
```

Options: none. Local type aliases that resolve to `object`, and unions containing `object`, are treated the same as writing `object` directly. A rest parameter is read through the array that collects the arguments, so `...values: object[]` reports: it accepts an `object` at every position and states no more about any one of them than `value: object` does. A type parameter constrained with `extends object` is not reported, because the parameter's annotation is the type parameter rather than the constraint.

### no-reflect-apply

Rationale: `Reflect.apply` invokes a function through a dynamic path that discards the call signature, so the arguments are checked as an array rather than against parameters. It is nearly always a workaround for a typing problem in the callee or an ad hoc dispatch mechanism. Calling the function directly restores the check, and genuine dynamic dispatch deserves a named interface that says which operations exist.

Wrong:

```ts
const result = Reflect.apply(handler, undefined, [request, context]);
```

Right:

```ts
const result = handler(request, context);
```

Options: none. Only calls on the global `Reflect` are reported.

### no-reflect-get

Rationale: `Reflect.get` reads a property while erasing the fact that the property was ever declared. The result is typed by the escape hatch rather than by the object, so nothing verifies that the key exists or that the value has the assumed type. Where the object is known, ordinary access is both safer and clearer; where it is not known, the payload should be parsed into a domain type before anything reads from it.

Wrong:

```ts
const version = Reflect.get(manifest, "version");
```

Right:

```ts
const version = manifest.version;
```

Options: none. Only calls on the global `Reflect` are reported.

### no-runtime-typeof

Rationale: `typeof` answers a question about JavaScript representation, not about the domain. Knowing that a value is a string does not establish that it is a user id, a URL, or a currency code, so a `typeof` branch in business logic is usually a decoding step that was skipped at the boundary and is now being improvised in the middle of the program, once per call site and slightly differently each time. Decode the input where it enters, then branch on the domain value.

Wrong:

```ts
function renderLabel(value: unknown): string {
  if (typeof value === "number") return value.toFixed(2);
  return String(value);
}
```

Right:

```ts
function renderLabel(amount: Money): string {
  return amount.value.toFixed(amount.precision);
}
```

Options: `allowInTypeGuards` is enabled by default and permits `typeof` inside a function whose return type is a type predicate, which is where a representation check legitimately lives. `allowUndefinedChecks` is also enabled by default and permits an equality comparison against the string `"undefined"`, because testing whether a binding is defined has no domain-level substitute. Set either option to `false` to withdraw that allowance.

### no-shape-in-symbol-names

Rationale: naming something for its structure rather than its role tells the reader nothing they could not already see. A `UserShape` or a `configShape` is a declaration whose meaning nobody has decided yet, and the name will still be there long after the ambiguity has hardened into a contract. Name the declaration for what owns it or what it is used for.

Wrong:

```ts
type PayloadShape = { id: string; total: number };
```

Right:

```ts
type CheckoutTotal = { id: string; total: number };
```

Options: `terms` takes the list of banned words and defaults to `["shape"]`. Matching is on word segments at declarations, so `shape` and `userShape` are reported while `reshape` and `shapefile` are not, and a banned name imported from a third-party package does not produce a finding at every use site.

### no-unknown-parameters

Rationale: an `unknown` parameter moves the parsing obligation from the one boundary that knows the payload's provenance into every function that touches it. The function cannot proceed without narrowing, so the narrowing is duplicated inward, and the call sites lose any statement of what they are allowed to pass. Accept the parsed domain type and run the schema or parser once, at the boundary.

Wrong:

```ts
function handleMessage(payload: unknown): void {}
```

Right:

```ts
function handleMessage(payload: InboundMessage): void {}
```

A rest parameter is read through the array that collects the arguments, so `...values: unknown[]` is reported too: it accepts an `unknown` at every position, which is the same missing contract spelled once for all of them. `readonly unknown[]`, `Array<unknown>`, and a tuple with an `unknown` member are read the same way.

Options: `allowedNames` lists parameter names that may be `unknown`. It replaces the previously hardcoded exemption for `cause`, so a project that enriches errors with an arbitrary cause lists that name explicitly with `allowedNames: ["cause"]`. There is no boundary opt-out, because a parser's own input is a `string`, a `Uint8Array`, or a `Response`, not `unknown`. An unconstrained single-use type parameter is rejected as a fake generic for the same reason: `parse<T>(input: string): T` is `unknown` with the burden shifted onto the caller.

### no-unknown-returns

Rationale: a function that returns `unknown` has done the work and then refused to say what came of it. Every caller must narrow the result before using it, so the knowledge the function already had is reconstructed repeatedly and inconsistently downstream. If the function cannot name what it returns, its contract is not finished.

Wrong:

```ts
function loadSettings(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
```

Right:

```ts
function loadSettings(path: string): EditorSettings {
  return parseEditorSettings(JSON.parse(readFileSync(path, "utf8")));
}
```

Options: none. Local aliases that resolve to `unknown` count as `unknown`, and an unconstrained type parameter that appears only in the return position is rejected as a fake generic, since the caller picks `T` with no evidence that the value matches it. There is no boundary opt-out; a parsing function is exactly the place that is supposed to name its output.

### no-unknown-type-aliases

Rationale: `type Json = unknown` gives an escape hatch a respectable name. Readers see a domain-looking type and assume a contract exists while the compiler still knows nothing, and the alias then spreads through signatures that would have been questioned had they spelled `unknown` in the open. If a value really is unparsed, keep that visible at the one place where it is true.

Wrong:

```ts
type JsonValue = unknown;
type ApiPayload = JsonValue;
```

Right:

```ts
type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

Options: none. Aliases are followed transitively, so an alias to an alias that resolves to `unknown` is reported. There is no boundary opt-out for naming `unknown`.

### no-unsafe-dictionary-type

Rationale: an open dictionary whose value type is `unknown`, `any`, `object`, `{}`, or a union containing one of those promises callers a lookup table and then delivers nothing about what a lookup produces. Two obligations are lost at once: which keys exist, and what a value is. The shape is common as a temporary stand-in, and once it reaches a signature it forces an assertion at every read.

Wrong:

```ts
type FeatureFlags = Record<string, unknown>;
```

Right:

```ts
type FeatureFlags = Record<FeatureName, boolean>;
```

Options: none. Intersections follow TypeScript's own absorption rules rather than the union rule: `any & T` is `any` and reports, while `unknown & T` is just `T` and stays silent. A closed-key record is not an open dictionary: `Record<"draft" | "published", unknown>` has a finite key set and is treated as an ordinary object type, so the rule does not fire on it. A `keyof` key set is closed for the same reason: `{ [Key in keyof Settings]: unknown }` states that the keys are exactly `Settings`'s own, and that holds whether or not `Settings` is declared in the same file, so a projection over an imported type is not an open dictionary. Only a provably open source reopens it, as in `keyof Record<string, string>`. The rule targets dictionaries keyed by `string`, `number`, `symbol`, `PropertyKey`, or a template literal type, whether they are written as `Record<...>`, an index signature, or a mapped type.

### no-widen-then-assert

Rationale: widening a known value into a broad local binding and later asserting it back to a narrower type is a round trip that produces no information and can only be wrong. The evidence existed at initialization, was deleted, and is being recreated by decree. If the two types ever diverge, nothing detects it, because the assertion is unconditional.

Wrong:

```ts
const raw: unknown = { id, total };
const order = raw as Order;
```

Right:

```ts
const order = { id, total } satisfies Order;
```

Options: none. The rule reports immutable `const` bindings whose widening and later assertion occur within the same function boundary. Two consequences are worth knowing before reading a finding: the evidence that the value was already known has to come from inside that same function, so a binding initialized from module scope is silent, and after an object widening the asserted type has to be syntactically narrower than what was written, so asserting back to the type the literal already satisfied is not a round trip the rule claims to detect.

### require-safety-comment-for-type-assertion

Rationale: an assertion is a claim that the author knows something the compiler cannot verify. That claim is worth writing down, because the reviewer needs to check it and the next reader needs to know what would invalidate it. Requiring the justification in writing also makes a reflexive assertion expensive enough to reconsider, which is usually the better outcome.

Wrong:

```ts
const element = document.getElementById("root") as HTMLDivElement;
```

Right:

```ts
// SAFETY: index.html declares #root as a div and the bundle only runs after DOMContentLoaded.
const element = document.getElementById("root") as HTMLDivElement;
```

Options: none. The comment must contain `SAFETY:` and sit immediately before the assertion or before the statement that contains it, including before the `export` that wraps a declaration, since the keyword sits between the justification and the declaration it documents. A comment after the assertion on the same line does not count, and the marker is matched case-sensitively. Const assertions are exempt, since they narrow rather than claim.

## Hazards when fixing findings

### Property names that cross a serialization or minification boundary

Remediation often restructures an object, and an object whose keys travel outside the program carries a constraint the type system does not express: the key text itself is part of the contract. A property-mangling minifier or an advanced optimizer is free to rename an unquoted property, and it will, while the code on the other side of the boundary still looks for the original name. Nothing fails at build time. The mismatch shows up at runtime as a message that is never matched, a lock that is never released, or a field that silently reads as undefined.

The rule is to quote consistently on both sides. Quote the key in the object literal and read it through quoted bracket access wherever the name also appears in JSON, a wire protocol, a config file, or another process's expectations.

Wrong, when this object is serialized and read elsewhere:

```ts
const record = { lockId, releasedAt };
if (parsed.lockId === lockId) release();
```

Right:

```ts
const record = { "lockId": lockId, "releasedAt": releasedAt };
if (parsed["lockId"] === lockId) release();
```

### Replacing a banned typeof

When `no-runtime-typeof` reports a check, the fix is a named guard that states the domain question, or a parse at the boundary that makes the check unnecessary. It is not a different way to spell the same structural test. Substituting `Object.prototype.toString`, `Function.prototype.toString`, `instanceof`, or a try/catch that treats a thrown error as a type answer satisfies the rule while leaving the original problem in place, hiding the intent from the next reader, and, in the case of exception-based checks, turning a cheap predicate into a dramatically more expensive one on a hot path.

Wrong:

```ts
function isCallable(value: Handler | HandlerDescriptor): boolean {
  try {
    (value as Handler)();
    return true;
  } catch {
    return false;
  }
}
```

Right:

```ts
function isHandler(value: Handler | HandlerDescriptor): value is Handler {
  return value.kind === "handler";
}
```
