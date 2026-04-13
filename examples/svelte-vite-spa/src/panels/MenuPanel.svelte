<script lang="ts">
  import { Button, Card, Divider, Menu, MenuItem } from "m3-svelte";

  const menuChoices = [
    { label: "Open design tokens", message: "Opened design tokens" },
    { label: "Queue diagnostics review", message: "Queued diagnostics review" },
    { label: "Publish component snapshot", message: "Published component snapshot" },
  ] as const;

  type MenuChoice = (typeof menuChoices)[number]["message"] | "Menu refreshed";

  let message = $state<MenuChoice | "Pick an item from the menu.">("Pick an item from the menu.");

  function select(choice: MenuChoice): void {
    message = choice;
  }
</script>

<Card variant="elevated">
  <p>M3 Svelte</p>
  <h3>Menu</h3>
  <p>This chunk keeps the menu container and menu items out of the first load.</p>

  <Divider />

  <Button variant="outlined" onclick={() => select("Menu refreshed")}>
    Refresh menu
  </Button>

  <Menu>
    {#each menuChoices as choice}
      <MenuItem onclick={() => select(choice.message)}>
        {choice.label}
      </MenuItem>
    {/each}
  </Menu>

  <p>{message}</p>
</Card>
