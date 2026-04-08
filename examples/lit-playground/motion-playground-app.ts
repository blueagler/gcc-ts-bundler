import { Router } from "@lit-labs/router";
import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";

import "./motion-lit.js";

import {
  ABOUT_PATH,
  HOME_PATH,
  INDEX_PATH,
  animalPath,
  data,
  findItemById,
  type DataItem,
} from "./support.js";
import { appStyles } from "./styles.js";

@customElement("motion-playground-app")
export class MotionPlaygroundApp extends LitElement {
  static styles = [appStyles];

  private readonly router = new Router(this, [
    {
      path: HOME_PATH,
      render: () => this.renderHomeRoute(),
    },
    {
      path: INDEX_PATH,
      render: () => this.renderHomeRoute(),
    },
    {
      path: ABOUT_PATH,
      enter: async () => {
        await import("./pages/about-page.js");
        return true;
      },
      render: () =>
        html`<about-page-view .homeHref=${HOME_PATH}></about-page-view>`,
    },
    {
      path: "/animals/:id",
      enter: async () => {
        await import("./pages/animal-page.js");
        return true;
      },
      render: ({ id }: { id?: string }) => this.renderAnimalRoute(id),
    },
  ], {
    fallback: {
      render: () => this.renderNotFound(),
    },
  });

  override render() {
    return html`
      <div class="app-shell">
        <header class="hero">
          <div class="hero-copy">
            <div class="eyebrow">Closure Chunks + Lit</div>
            <h1 class="hero-title">Native ESM route chunks with Lit router.</h1>
            <p>
              The shell stays eager, while route modules are loaded only when
              navigation needs them. The authoring model stays native ESM, and
              the bundler still emits Closure lazy chunks.
            </p>
          </div>
          <motion-lit></motion-lit>
          <nav class="route-nav" aria-label="Primary">
            <a class="nav-link" href=${HOME_PATH}>Home</a>
            <a class="nav-link" href=${ABOUT_PATH}>About</a>
          </nav>
        </header>
        <section class="route-panel">${this.router.outlet() ?? nothing}</section>
      </div>
    `;
  }

  private renderHomeRoute() {
    return html`
      <div class="page-shell">
        <div class="route-intro">
          <span class="detail-badge">Eager Shell</span>
          <p>
            This route is in the initial chunk. The detail and about routes are
            plain dynamic imports, so they split naturally and still work
            through Closure chunk loading.
          </p>
        </div>
        <ul class="cards">
          ${data.map((item) => this.renderAnimalCard(item))}
        </ul>
      </div>
    `;
  }

  private renderAnimalRoute(id: string | undefined) {
    const item = findItemById(id ?? "");
    if (!item) {
      return this.renderNotFound();
    }

    return html`
      <animal-page-view
        .aboutHref=${ABOUT_PATH}
        .homeHref=${HOME_PATH}
        .item=${item}
      ></animal-page-view>
    `;
  }

  private renderAnimalCard(item: DataItem) {
    return html`
      <li>
        <a class="card" href=${animalPath(item.id)}>
          <span class="icon card-icon">pets</span>
          <div class="card-title">${item.value}</div>
          <p class="card-summary">${item.summary}</p>
        </a>
      </li>
    `;
  }

  private renderNotFound() {
    return html`
      <div class="page-shell">
        <div class="not-found-card">
          <div class="eyebrow">Not Found</div>
          <h2>That route does not map to a page.</h2>
          <p>Use the home route to select an animal card.</p>
          <div class="detail-actions">
            <a class="action-link" href=${HOME_PATH}>Return Home</a>
          </div>
        </div>
      </div>
    `;
  }
}
