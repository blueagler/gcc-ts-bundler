<script>
  let count = 0;
  const animals = [
    "Cats",
    "Dogs",
    "Hippos",
    "Elephants",
    "Frogs",
    "Cows",
  ];

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
      runs the generated modules through gcc-ts-bundler.
    </p>
    <button on:click={increment}>Clicked {count} times</button>
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
</style>
