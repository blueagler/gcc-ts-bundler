<script>
  import {
    Button,
    Card,
    Divider,
    NavigationRail,
    NavigationRailItem,
  } from "m3-svelte";
  import iconApps from "@ktibow/iconset-material-symbols/apps";
  import iconPalette from "@ktibow/iconset-material-symbols/palette";
  import iconWidgets from "@ktibow/iconset-material-symbols/widgets";

  let open = true;
  let active = "apps";
</script>

<Card variant="elevated">
  <p>M3 Svelte</p>
  <h3>Navigation Rail</h3>
  <p>
    The navigation rail and icon set stay in this lazy chunk instead of landing
    in the shell.
  </p>

  <Divider />

  <NavigationRail bind:open alignment="top">
    {#snippet fab(isOpen)}
      <Button variant="tonal" onclick={() => (active = isOpen ? "apps" : active)}>
        {isOpen ? "Compose" : "+"}
      </Button>
    {/snippet}

    <NavigationRailItem
      label="Apps"
      icon={iconApps}
      active={active === "apps"}
      onclick={() => (active = "apps")}
    />
    <NavigationRailItem
      label="Palette"
      icon={iconPalette}
      active={active === "palette"}
      onclick={() => (active = "palette")}
    />
    <NavigationRailItem
      label="Widgets"
      icon={iconWidgets}
      active={active === "widgets"}
      onclick={() => (active = "widgets")}
    />
  </NavigationRail>

  <p>Active destination: {active}</p>
</Card>
