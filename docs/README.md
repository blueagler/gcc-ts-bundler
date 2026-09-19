# Documentation map

Choose the document for the task. This is a router, not a required reading list.
Start with the root [README](../README.md) to install or try the package.

## Use the package

These references describe the public contract and ship in the package.

| Task                                                               | Reference                 |
| ------------------------------------------------------------------ | ------------------------- |
| Call `build`, generate externs, or understand output/cache effects | [API](reference/api.md)   |
| Run a command or look up a flag                                    | [CLI](reference/cli.md)   |
| Configure the plugin, framework presets, or build reports          | [Vite](reference/vite.md) |

## Change the implementation

These guides assume a repository checkout and do not ship in the package.

| Question                                                       | Guide                                       |
| -------------------------------------------------------------- | ------------------------------------------- |
| Where does this change flow, and what must I check?            | [Change routes](development/changes.md)     |
| Who owns a stage, resource, or cross-language handoff?         | [Architecture](development/architecture.md) |
| What tools, build artifacts, or commands does this check need? | [Workflows](development/workflows.md)       |
| How do cache cleanup, fresh graphs, or Vite rebuilds stay owned? | [Resource boundaries](development/architecture.md#failure-and-resource-boundaries) and [Vite change route](development/changes.md#vite-rebuilds-provenance-and-output-ownership) |
| Which exact tarballs are verified before release uploads? | [Release workflow](development/workflows.md#native-packaging-and-releases) |

Use a change route to locate the owner, then follow the relevant calls. The
route is not a replacement for reading changed code. The workflow guide owns
command prerequisites; the architecture guide owns handoff invariants. Neither
should duplicate public option tables.

## Evidence and proposals

[Research](research/) preserves measurements, rejected alternatives, and design
proposals. It is repository-only and is not another API or task list.

- [Closed directions](research/closed-directions.md): negative results scoped to
  their workload and compiler—not a ban on contradicting evidence.
- [Optimization rationale](research/optimization-architecture.md) and
  [earlier implementation plan](research/plan-repoint-and-simplify.md): historical
  measurements and partial landing notes.
- [Core/Vite inversion](research/plan-mirror-inversion.md): a proposed boundary
  change, not an available core API.
- [Boundary linter](research/boundary-linter-option.md): a no-go proposal; its
  sample `lint` command does not exist.

## Keep the map honest

When a behavior changes, update its reference plus affected source docstrings
and CLI help. When ownership changes, update the route rather than adding a
second inventory. Keep the reason for a non-obvious invariant near its owner
and test the behavior it protects.

If prose and execution disagree, investigate the discrepancy; do not declare
all current behavior intentional. Mark an unresolved limitation explicitly.
A passing build does not prove cache restoration, cleanup, runtime behavior,
or release packaging. The curated `test:fast` lane, full runtime suite,
self-build identity, exact-package verification and example-byte comparison
answer different questions. Source contracts and named regression routes are
not a claim those gates passed; report only the evidence actually run.

Do not add another global checklist, copied defaults, or undated benchmark
claim. Historical evidence should identify its input/compiler scope; missing
provenance is a limitation, not permission to treat a number as current.
