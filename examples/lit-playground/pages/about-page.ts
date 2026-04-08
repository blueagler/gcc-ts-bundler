import { html } from "lit";
import { customElement, property } from "lit/decorators.js";

import { animalPath } from "../support.js";
import { PageViewBase } from "./page-view-base.js";

@customElement("about-page-view")
export class AboutPageView extends PageViewBase {
  @property({ attribute: false }) accessor homeHref = "/";

  override render() {
    return html`
      <div class="page-shell">
        <div class="about-card">
          <div class="detail-badge">Lazy Route Component</div>
          <h2>What this route proves</h2>
          <div class="about-grid">
            <section class="about-panel">
              <h3>Native ESM split</h3>
              <p>
                This route lives in its own module and is loaded with a literal
                <code>import()</code> instead of a compile-time helper API.
              </p>
            </section>
            <section class="about-panel">
              <h3>Closure lazy load</h3>
              <p>
                gcc-ts-bundler still turns that async import into Closure chunk
                loading, so the authoring model stays plain ESM.
              </p>
            </section>
            <section class="about-panel">
              <h3>Lit component route</h3>
              <p>
                The module exports a real Lit component, not a template helper,
                so route UI can own state and lifecycle directly.
              </p>
            </section>
          </div>
          <div class="detail-actions">
            <a class="action-link" href=${this.homeHref}>Return Home</a>
            <a class="action-link" href=${animalPath("elephants")}>
              Open Detail Route
            </a>
          </div>
        </div>
      </div>
    `;
  }
}
