<section class="panel circuit">
  <div class="eyebrow">Chunk C</div>
  <h3>Circuit Console</h3>
  <p>
    This chunk keeps the same authoring model: native ESM in, Closure-style
    optimized output out.
  </p>
  <div class="stats">
    <article>
      <strong>3</strong>
      <span>lazy panels</span>
    </article>
    <article>
      <strong>1</strong>
      <span>entry chunk</span>
    </article>
    <article>
      <strong>0</strong>
      <span>manual loader APIs</span>
    </article>
  </div>
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

  .circuit {
    background:
      radial-gradient(circle at center, rgba(255, 178, 73, 0.2), transparent 38%),
      linear-gradient(145deg, rgba(255, 252, 246, 0.98), rgba(255, 238, 213, 0.92));
  }

  .eyebrow {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #8a5a19;
  }

  h3,
  p {
    margin: 0;
  }

  p {
    line-height: 1.7;
    color: rgba(16, 32, 50, 0.78);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px;
  }

  .stats article {
    padding: 12px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.72);
    display: grid;
    gap: 4px;
  }

  strong {
    font-size: 1.5rem;
    color: #8a5a19;
  }

  span {
    color: rgba(16, 32, 50, 0.76);
    font-size: 0.9rem;
  }
</style>
