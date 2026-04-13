<script lang="ts">
  import { onMount } from "svelte";
  import type { Component } from "svelte";
  import { Button, Card, Chip, Divider } from "m3-svelte";

  type PanelId = "button" | "menu" | "checkbox" | "dialog" | "rail";
  type PanelComponent = Component<Record<string, never>>;
  type PanelModule = { default: PanelComponent };

  interface PanelDefinition {
    readonly id: PanelId;
    readonly label: string;
    readonly load: () => Promise<PanelModule>;
    readonly note: string;
  }

  let count = $state(0);
  const modules = [
    {
      id: "button",
      label: "Button",
      load: () => import("./panels/ButtonPanel.svelte"),
      note: "Multiple M3 button variants in one lazy chunk.",
    },
    {
      id: "menu",
      label: "Menu",
      load: () => import("./panels/MenuPanel.svelte"),
      note: "Static action menu rendered outside the startup path.",
    },
    {
      id: "checkbox",
      label: "Checkbox",
      load: () => import("./panels/CheckboxPanel.svelte"),
      note: "Checkbox rows using the wrapped-input composition pattern.",
    },
    {
      id: "dialog",
      label: "Dialog",
      load: () => import("./panels/DialogPanel.svelte"),
      note: "Modal container and buttons loaded on demand.",
    },
    {
      id: "rail",
      label: "Navigation Rail",
      load: () => import("./panels/NavigationRailPanel.svelte"),
      note: "Rail layout and icons isolated in their own chunk.",
    },
  ] as const satisfies readonly PanelDefinition[];
  const metrics = [
    "Lazy panels: 5",
    "UI library: m3-svelte",
    "Chunk loader: bundler-runtime",
  ] as const;
  const resolveActivePanel = (panelId: PanelId): PanelDefinition =>
    modules.find((panel) => panel.id === panelId) ?? modules[0];
  let component = $state<PanelId>(modules[0].id);
  let hasMounted = $state(false);
  let selectedModule = $state<Promise<PanelModule> | null>(null);
  let activePanel = $state<PanelDefinition>(modules[0]);

  onMount(() => {
    hasMounted = true;
  });

  $effect(() => {
    const nextPanel = resolveActivePanel(component);
    activePanel = nextPanel;

    if (hasMounted) {
      selectedModule = nextPanel.load();
    }
  });

  function increment(): void {
    count += 1;
  }

  function selectPanel(panelId: PanelId): void {
    component = panelId;
  }
</script>

<svelte:head>
  <title>Svelte SPA Example</title>
</svelte:head>

<Card variant="filled">
  <p>Svelte + Closure + M3</p>
  <h1>Lazy-load Material 3 Svelte components through ADVANCED mode.</h1>
  <p>
    This example lets Vite and the Svelte plugin transform the app first, then
    hands the captured JS graph to <code>gcc-ts-bundler</code> for ADVANCED
    chunking and runtime loading.
  </p>
  <Button onclick={increment}>Clicked {count} times</Button>

  <div>
    {#each metrics as metric}
      <Chip variant="general" elevated={true} label={true}>{metric}</Chip>
    {/each}
  </div>
</Card>

<Card variant="outlined">
  <p>Dynamic Import</p>
  <h2>Swap lazily loaded M3 component panels.</h2>
  <p>
    Each button below triggers a native ESM <code>import()</code>. The bundler
    rewrites those imports into Closure-managed lazy chunks.
  </p>

  <div>
    {#each modules as panel}
      <Button
        variant={component === panel.id ? "filled" : "outlined"}
        onclick={() => selectPanel(panel.id)}
      >
        {panel.label}
      </Button>
    {/each}
  </div>

  <Divider />
  <p>{activePanel.note}</p>
</Card>

<Card variant="elevated">
  {#if selectedModule}
    {#await selectedModule then module}
      {@const Panel = module.default}
      <Panel />
    {/await}
  {:else}
    <p>Preparing first lazy panel...</p>
  {/if}
</Card>

<div>
  {#each metrics as metric}
    <Card variant="outlined">
      <p>{metric}</p>
    </Card>
  {/each}
</div>
