<script>
  import { onMount } from "svelte";

  let count = 0;
  const animals = [
    "Cats",
    "Dogs",
    "Hippos",
    "Elephants",
    "Frogs",
    "Cows",
  ];
  const imports = {
    a: () => import("./A.svelte.js"),
    b: () => import("./B.svelte.js"),
    c: () => import("./C.svelte.js"),
  };
  let component = "a";
  let hasMounted = false;
  let selectedModule = null;

  onMount(() => {
    hasMounted = true;
  });

  $: if (hasMounted) {
    selectedModule = imports[component]();
  }

  function increment() {
    count += 1;
  }
</script>

<svelte:head>
  <title>Svelte SPA Example</title>
</svelte:head>

<div class="page">
  <section class="hero">
    <div class="eyebrow">Svelte + Closure</div>
    <h1>Compiled Svelte components through ADVANCED mode.</h1>
    <p>
      This example precompiles <code>.svelte</code> files to native ESM, then
      runs the generated modules through gcc-ts-bundler. The component switcher
      below uses native <code>import()</code> and ships as real lazy chunks.
    </p>
    <button on:click={increment}>Clicked {count} times</button>
  </section>

  <section class="lazy-shell">
    <div class="lazy-header">
      <div>
        <div class="section-label">Dynamic Import</div>
        <h2>Swap lazily loaded Svelte components.</h2>
      </div>
      <p>
        These radio buttons trigger native ESM dynamic imports. The bundler
        rewrites them into Closure-managed lazy chunks.
      </p>
    </div>

    <div class="segmented" role="radiogroup" aria-label="Lazy component picker">
      <label class:selected={component === "a"}>
        <input type="radio" bind:group={component} value="a" />
        Aurora
      </label>

      <label class:selected={component === "b"}>
        <input type="radio" bind:group={component} value="b" />
        Botanica
      </label>

      <label class:selected={component === "c"}>
        <input type="radio" bind:group={component} value="c" />
        Circuit
      </label>
    </div>

    <div class="component-frame">
      {#if selectedModule}
        {#await selectedModule then module}
          <svelte:component this={module.default} />
        {/await}
      {:else}
        <div class="loading-state">Preparing first lazy panel...</div>
      {/if}
    </div>
  </section>

  <section class="grid">
    {#each animals as animal}
      <article class="card">
        <h2>{animal}</h2>
        <p>
          Svelte compiled this card to plain JavaScript before Closure
          optimization.
        </p>
      </article>
    {/each}
  </section>
</div>

<style>
  :global(body) {
    color: #102032;
  }

  .page {
    min-height: 100vh;
    padding: 32px;
    display: grid;
    gap: 24px;
  }

  .hero,
  .lazy-shell,
  .card {
    background: rgba(255, 255, 255, 0.86);
    border: 1px solid rgba(16, 32, 50, 0.08);
    border-radius: 24px;
    box-shadow: 0 20px 40px rgba(16, 32, 50, 0.08);
  }

  .hero {
    padding: 28px;
    display: grid;
    gap: 14px;
  }

  .lazy-shell {
    padding: 24px;
    display: grid;
    gap: 18px;
  }

  .eyebrow {
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #4d718f;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: clamp(2rem, 4vw, 3.25rem);
    line-height: 0.95;
  }

  p {
    line-height: 1.7;
    color: rgba(16, 32, 50, 0.78);
  }

  .section-label {
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #4d718f;
    margin-bottom: 6px;
  }

  button {
    width: fit-content;
    border: 0;
    border-radius: 999px;
    padding: 12px 18px;
    background: #1f4e6d;
    color: white;
    font: inherit;
    cursor: pointer;
  }

  .lazy-header {
    display: grid;
    gap: 10px;
  }

  .segmented {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .segmented label {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 999px;
    border: 1px solid rgba(31, 78, 109, 0.15);
    background: rgba(245, 250, 255, 0.92);
    color: #1f4e6d;
    font-weight: 600;
    cursor: pointer;
    transition:
      transform 140ms ease,
      border-color 140ms ease,
      background 140ms ease;
  }

  .segmented label.selected {
    background: #1f4e6d;
    color: white;
    border-color: #1f4e6d;
  }

  .segmented input {
    margin: 0;
  }

  .component-frame {
    min-height: 220px;
  }

  .loading-state {
    min-height: 100%;
    display: grid;
    place-items: center;
    border-radius: 20px;
    border: 1px dashed rgba(31, 78, 109, 0.2);
    color: #4d718f;
    background: rgba(245, 250, 255, 0.78);
    font-weight: 600;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 18px;
  }

  .card {
    padding: 22px;
    display: grid;
    gap: 10px;
  }

  @media (min-width: 760px) {
    .lazy-header {
      grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
      align-items: end;
    }
  }
</style>
