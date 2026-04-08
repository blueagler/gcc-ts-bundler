<section class="panel botanica">
  <div class="eyebrow">Chunk B</div>
  <h3>Botanica Notes</h3>
  <p>
    A separate lazy chunk can still carry normal Svelte styling and DOM
    updates through the Closure pipeline.
  </p>
  <ul>
    <li>Leaf motion studies</li>
    <li>Glasshouse humidity</li>
    <li>Edge-safe hydration</li>
  </ul>
</section>

<style>
  .panel {
    min-height: 100%;
    padding: 22px;
    display: grid;
    gap: 12px;
    border-radius: 20px;
    border: 1px solid rgba(16, 32, 50, 0.08);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
  }

  .botanica {
    background:
      radial-gradient(circle at top right, rgba(132, 201, 138, 0.25), transparent 36%),
      linear-gradient(145deg, rgba(252, 255, 251, 0.98), rgba(231, 246, 229, 0.92));
  }

  .eyebrow {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #4a7a53;
  }

  h3,
  p,
  ul {
    margin: 0;
  }

  p,
  li {
    line-height: 1.7;
    color: rgba(16, 32, 50, 0.78);
  }

  ul {
    padding-left: 18px;
    display: grid;
    gap: 6px;
  }
</style>
