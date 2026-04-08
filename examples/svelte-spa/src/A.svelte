<section class="panel aurora">
  <div class="eyebrow">Chunk A</div>
  <h3>Aurora Board</h3>
  <p>
    This panel was loaded with native <code>import()</code> after the initial
    bundle.
  </p>
  <div class="chips">
    <span>North</span>
    <span>Glacier</span>
    <span>Static-safe</span>
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

  .aurora {
    background:
      radial-gradient(circle at top left, rgba(78, 155, 255, 0.28), transparent 36%),
      linear-gradient(145deg, rgba(255, 255, 255, 0.98), rgba(229, 241, 255, 0.9));
  }

  .eyebrow {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #4d718f;
  }

  h3,
  p {
    margin: 0;
  }

  p {
    line-height: 1.7;
    color: rgba(16, 32, 50, 0.78);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .chips span {
    padding: 8px 10px;
    border-radius: 999px;
    background: rgba(31, 78, 109, 0.08);
    color: #1f4e6d;
    font-size: 0.85rem;
    font-weight: 600;
  }
</style>
