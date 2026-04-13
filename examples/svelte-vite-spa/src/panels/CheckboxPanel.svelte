<script lang="ts">
  import { Card, Checkbox, Divider } from "m3-svelte";

  type FlagSummary = `diag:${"on" | "off"}` | `manifest:${"on" | "off"}` | `esm:${"on" | "off"}`;
  const getSummaries = (
    diagnostics: boolean,
    manifest: boolean,
    nativeImports: boolean,
  ): readonly FlagSummary[] => [
    diagnostics ? "diag:on" : "diag:off",
    manifest ? "manifest:on" : "manifest:off",
    nativeImports ? "esm:on" : "esm:off",
  ];

  let advancedDiagnostics = $state(true);
  let publishManifest = $state(false);
  let preserveNativeImports = $state(true);
</script>

<Card variant="elevated">
  <p>M3 Svelte</p>
  <h3>Checkboxes</h3>
  <p>
    This lazy panel demonstrates the wrapped-input checkbox composition that
    <code>m3-svelte</code> expects.
  </p>

  <Divider />

  <label>
    <Checkbox>
      <input type="checkbox" bind:checked={advancedDiagnostics} />
    </Checkbox>
    Run advanced diagnostics on every build.
  </label>

  <label>
    <Checkbox>
      <input type="checkbox" bind:checked={publishManifest} />
    </Checkbox>
    Emit a chunk manifest for runtime inspection.
  </label>

  <label>
    <Checkbox>
      <input type="checkbox" bind:checked={preserveNativeImports} />
    </Checkbox>
    Preserve native dynamic imports in the demo shell.
  </label>

  <p>
    Flags: {getSummaries(advancedDiagnostics, publishManifest, preserveNativeImports).join(", ")}
  </p>
</Card>
