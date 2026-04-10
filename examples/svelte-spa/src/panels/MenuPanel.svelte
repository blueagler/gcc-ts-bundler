<script>
  import { Button, Card, Divider, Menu, MenuItem } from "../../.m3-compiled/package/index.js";

  let message = "Pick an item from the menu.";

  function select(choice) {
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
    <MenuItem onclick={() => select("Opened design tokens")}>
      Open design tokens
    </MenuItem>
    <MenuItem onclick={() => select("Queued diagnostics review")}>
      Queue diagnostics review
    </MenuItem>
    <MenuItem onclick={() => select("Published component snapshot")}>
      Publish component snapshot
    </MenuItem>
  </Menu>

  <p>{message}</p>
</Card>
