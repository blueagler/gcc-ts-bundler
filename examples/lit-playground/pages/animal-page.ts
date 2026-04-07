import type { DataItem } from "../support.js";

export function renderAnimalPage(
  item: DataItem,
  homeHref: string,
  aboutHref: string,
) {
  return `
    <div class="page-shell">
      <div class="detail-card">
        <div class="detail-badge">Detail Route</div>
        <span class="icon">pets</span>
        <h2>${item.value}</h2>
        <p>${item.summary}</p>
        <div class="detail-body">
          <p>${item.detail}</p>
          <p>
            This detail view stays readable after ADVANCED optimization and
            gives the playground a second route without relying on framework
            lifecycle magic.
          </p>
        </div>
        <div class="detail-actions">
          <a class="action-link" href="${homeHref}">Back to cards</a>
          <a class="action-link" href="${aboutHref}">About this demo</a>
        </div>
      </div>
    </div>
  `;
}
