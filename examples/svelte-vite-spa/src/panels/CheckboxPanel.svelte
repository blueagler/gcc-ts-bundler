<script>
  import { Card, Checkbox, Divider } from "m3-svelte";

  let advancedDiagnostics = true;
  let publishManifest = false;
  let preserveNativeImports = true;
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
    Flags:
    {advancedDiagnostics ? "diag:on" : "diag:off"},
    {publishManifest ? "manifest:on" : "manifest:off"},
    {preserveNativeImports ? "esm:on" : "esm:off"}
  </p>
</Card>
