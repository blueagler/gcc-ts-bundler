export function renderAboutPage(homeHref: string) {
  return `
    <div class="page-shell">
      <div class="about-card">
        <div class="detail-badge">About Route</div>
        <h2>What this route proves</h2>
        <div class="about-grid">
          <section class="about-panel">
            <h3>Chunk delivery</h3>
            <p>
              The app shell and route views stay readable and stable after
              full ADVANCED optimization.
            </p>
          </section>
          <section class="about-panel">
            <h3>Closure semantics</h3>
            <p>
              The application still compiles through Closure’s app pipeline,
              including renamed properties and chunk-capable output mode.
            </p>
          </section>
          <section class="about-panel">
            <h3>Authoring model</h3>
            <p>
              Route code stays native ESM and straightforward to inspect,
              even after the compiler rewrites the application for Closure.
            </p>
          </section>
        </div>
        <div class="detail-actions">
          <a class="action-link" href="${homeHref}">Return Home</a>
        </div>
      </div>
    </div>
  `;
}
