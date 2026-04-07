import { Routes } from "@lit-labs/router";

import { renderAboutPage } from "./pages/about-page.js";
import { renderAnimalPage } from "./pages/animal-page.js";
import { data, findItemById } from "./support.js";
import { stylesText } from "./styles.js";

interface ReactiveController {
  hostConnected?(): void;
  hostDisconnected?(): void;
}

interface RouterHost extends HTMLElement {
  addController(controller: ReactiveController): void;
  removeController(controller: ReactiveController): void;
  requestUpdate(): void;
  updateComplete: Promise<boolean>;
}

export function mountMotionPlaygroundApp(container: HTMLElement) {
  const controllers = new Set<ReactiveController>();

  const host = container as RouterHost;
  let routes!: Routes;

  host.addController = (controller: ReactiveController) => {
    controllers.add(controller);
  };
  host.removeController = (controller: ReactiveController) => {
    controllers.delete(controller);
  };
  host.requestUpdate = () => {
    renderApp(host, routes);
  };
  host.updateComplete = Promise.resolve(true);

  routes = new Routes(host, [
    {
      path: "/",
      render: (): string => renderHome(),
    },
    {
      path: "/about",
      render: (): string => renderAboutPage(routeHref("/")),
    },
    {
      path: "/animals/:id",
      render: ({ id }: { id?: string }): string => {
        const item = findItemById(id ?? "");
        return item
          ? renderAnimalPage(item, routeHref("/"), routeHref("/about"))
          : renderNotFound(routeHref("/"));
      },
    },
  ], {
    fallback: {
      render: (): string => renderNotFound(routeHref("/")),
    },
  });

  renderApp(host, routes);
  controllers.forEach((controller) => controller.hostConnected?.());
  void routes.goto(normalizeHashPath(location.hash));

  const syncRoute = () => {
    void routes.goto(normalizeHashPath(location.hash));
  };
  window.addEventListener("hashchange", syncRoute);

  return () => {
    window.removeEventListener("hashchange", syncRoute);
    controllers.forEach((controller) => controller.hostDisconnected?.());
    host.innerHTML = "";
  };
}

function renderApp(host: HTMLElement, routes: Routes) {
  host.innerHTML = `
    <style>${stylesText}</style>
    <div class="app-shell">
      <header class="hero">
        <div class="hero-copy">
          <div class="eyebrow">Closure Chunks + Lit</div>
          <h1 class="hero-title">Router views with full ADVANCED mode.</h1>
          <p>
            This playground uses @lit-labs/router for in-app navigation while
            keeping the browser demo stable under full Closure optimization.
          </p>
        </div>
        <nav class="route-nav" aria-label="Primary">
          <a class="nav-link" href="${routeHref("/")}">Home</a>
          <a class="nav-link" href="${routeHref("/about")}">About</a>
        </nav>
      </header>
      <section class="route-panel">${routes.outlet() ?? ""}</section>
    </div>
  `;
}

function renderHome() {
  return `
    <div class="page-shell">
      <ul class="cards">
        ${data
          .map(
            (item) => `
              <li>
                <a class="card" href="${routeHref(`/animals/${item.id}`)}">
                  <span class="icon card-icon">pets</span>
                  <div class="card-title">${item.value}</div>
                  <p class="card-summary">${item.summary}</p>
                </a>
              </li>
            `,
          )
          .join("")}
      </ul>
    </div>
  `;
}

function renderNotFound(homeHref: string) {
  return `
    <div class="page-shell">
      <div class="not-found-card">
        <div class="eyebrow">Not Found</div>
        <h2>That route does not map to a page.</h2>
        <p>Use the home route to select an animal card.</p>
        <div class="detail-actions">
          <a class="action-link" href="${homeHref}">Return Home</a>
        </div>
      </div>
    </div>
  `;
}

function normalizeHashPath(hash: string) {
  const pathname = hash.replace(/^#/, "") || "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function routeHref(pathname: string) {
  return `#${pathname}`;
}
