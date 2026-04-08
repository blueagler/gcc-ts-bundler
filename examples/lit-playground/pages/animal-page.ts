import { html } from "lit";
import { customElement, property } from "lit/decorators.js";

import type { DataItem } from "../support.js";
import { PageViewBase } from "./page-view-base.js";

@customElement("animal-page-view")
export class AnimalPageView extends PageViewBase {
  @property({ attribute: false }) accessor aboutHref = "/about";
  @property({ attribute: false }) accessor homeHref = "/";
  @property({ attribute: false }) accessor item!: DataItem;

  override render() {
    return html`
      <div class="page-shell">
        <div class="detail-card">
          <div class="detail-badge">Lazy Detail Component</div>
          <span class="icon">pets</span>
          <h2>${this.item.value}</h2>
          <p>${this.item.summary}</p>
          <div class="detail-body">
            <p>${this.item.detail}</p>
            <p>
              This page module is a Lit component loaded by native ESM dynamic
              import, then rewritten into a Closure lazy chunk at build time.
            </p>
          </div>
          <div class="detail-actions">
            <a class="action-link" href=${this.homeHref}>Back to cards</a>
            <a class="action-link" href=${this.aboutHref}>
              About this demo
            </a>
          </div>
        </div>
      </div>
    `;
  }
}
