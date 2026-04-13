<script lang="ts">
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

  type RailDestination = "apps" | "palette" | "widgets";
  type RailIcon = typeof iconApps;

  const destinations = [
    { id: "apps", label: "Apps", icon: iconApps },
    { id: "palette", label: "Palette", icon: iconPalette },
    { id: "widgets", label: "Widgets", icon: iconWidgets },
  ] as const satisfies readonly {
    readonly id: RailDestination;
    readonly label: string;
    readonly icon: RailIcon;
  }[];

  let open = $state(true);
  let active = $state<RailDestination>("apps");

  function setActive(destination: RailDestination): void {
    active = destination;
  }
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

    {#each destinations as destination}
      <NavigationRailItem
        label={destination.label}
        icon={destination.icon}
        active={active === destination.id}
        onclick={() => setActive(destination.id)}
      />
    {/each}
  </NavigationRail>

  <p>Active destination: {active}</p>
</Card>
