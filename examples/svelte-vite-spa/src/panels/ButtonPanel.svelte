<script lang="ts">
  import type { ComponentProps } from "svelte";
  import { Button, Card, Divider } from "m3-svelte";

  let clicks = $state(0);

  type ButtonVariant = Exclude<ComponentProps<typeof Button>["variant"], undefined>;
  type ButtonAction = {
    readonly label: string;
    readonly variant?: ButtonVariant;
  };

  const actions: readonly ButtonAction[] = [
    { label: "Filled action" },
    { label: "Tonal action", variant: "tonal" },
    { label: "Outlined action", variant: "outlined" },
    { label: "Text action", variant: "text" },
  ];

  function handleClick(): void {
    clicks += 1;
  }
</script>

<Card variant="elevated">
  <p>M3 Svelte</p>
  <h3>Buttons</h3>
  <p>
    This lazy panel renders several button variants from
    <code>m3-svelte</code>.
  </p>

  <Divider />

  <div>
    {#each actions as action}
      <Button variant={action.variant} onclick={handleClick}>
        {action.label}
      </Button>
    {/each}
  </div>

  <p>Lazy button clicks recorded: {clicks}</p>
</Card>
