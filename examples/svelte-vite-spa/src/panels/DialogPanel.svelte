<script lang="ts">
  import { Button, Card, Dialog, Divider } from "m3-svelte";

  let open = $state(false);
  let status = $state<"idle" | "confirmed">("idle");

  function closeDialog(): void {
    open = false;
    status = "confirmed";
  }
</script>

<Card variant="elevated">
  <p>M3 Svelte</p>
  <h3>Dialog</h3>
  <p>
    The dialog container and its buttons are lazy-loaded together in this
    panel.
  </p>

  <Divider />

  <Button onclick={() => (open = true)}>Open deployment dialog</Button>

  <Dialog bind:open headline="Ship the optimized bundle?">
    The dialog itself is part of the lazy chunk. It only enters the graph once
    this panel is selected.

    {#snippet buttons()}
      <Button variant="text" onclick={() => (open = false)}>Cancel</Button>
      <Button variant="tonal" onclick={closeDialog}>Ship build</Button>
    {/snippet}
  </Dialog>

  <p>
    {status === "confirmed"
      ? "Latest dialog action: deployment confirmed."
      : "No dialog action confirmed yet."}
  </p>
</Card>
