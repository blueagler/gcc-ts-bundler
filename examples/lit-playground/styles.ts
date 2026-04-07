export const stylesText = `
    :host {
      display: block;
      color: #102032;
      --surface: rgba(255, 255, 255, 0.9);
      --surface-strong: rgba(255, 255, 255, 0.96);
      --text-muted: rgba(16, 32, 50, 0.72);
      --accent-color: #1f4e6d;
      --accent-soft: #6f95ae;
      --border: 1px solid rgba(31, 78, 109, 0.12);
      --divider: 1px solid rgba(31, 78, 109, 0.12);
      --shadow: 0 24px 48px rgba(19, 45, 66, 0.14);
      --radius-large: 28px;
      --radius-medium: 22px;
    }

    * {
      box-sizing: border-box;
    }

    a {
      color: inherit;
      text-decoration: none;
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    .icon {
      font-family: "Material Icons";
      font-style: normal;
      font-weight: 400;
      line-height: 1;
      color: var(--accent-color);
    }

    .app-shell,
    .page-shell {
      display: flex;
      flex-direction: column;
      gap: 22px;
      min-height: 100vh;
      padding: 28px;
      background:
        radial-gradient(circle at top left, rgba(156, 203, 220, 0.45), transparent 32%),
        linear-gradient(180deg, #f3f8fb 0%, #edf4f7 100%);
    }

    .hero {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: end;
      padding: 28px;
      border-radius: var(--radius-large);
      background: var(--surface-strong);
      border: var(--border);
      box-shadow: var(--shadow);
    }

    .hero-copy {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 720px;
    }

    .eyebrow {
      color: var(--accent-soft);
      font-size: 0.82rem;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    .hero-title {
      font-size: clamp(2rem, 4vw, 3.4rem);
      line-height: 0.98;
    }

    .hero-copy p {
      color: var(--text-muted);
      line-height: 1.7;
      max-width: 56ch;
    }

    .route-nav,
    .detail-actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .nav-link,
    .action-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 16px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.74);
      border: var(--border);
      box-shadow: var(--shadow);
      color: var(--accent-color);
      font-weight: 600;
    }

    .route-panel {
      display: block;
    }

    .cards {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 18px;
    }

    .card {
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 250px;
      padding: 22px;
      border-radius: var(--radius-medium);
      background: var(--surface);
      border: var(--border);
      box-shadow: var(--shadow);
    }

    .card-icon {
      font-size: 4.5rem;
    }

    .card-title {
      font-size: 1.45rem;
      font-weight: 700;
    }

    .card-summary,
    .page-shell p {
      color: var(--text-muted);
      line-height: 1.7;
    }

    .detail-card,
    .about-card,
    .not-found-card {
      display: flex;
      flex-direction: column;
      gap: 18px;
      padding: 28px;
      border-radius: var(--radius-large);
      background: var(--surface-strong);
      border: var(--border);
      box-shadow: var(--shadow);
    }

    .detail-card .icon {
      font-size: 5rem;
    }

    .detail-badge {
      color: var(--accent-soft);
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .detail-body,
    .about-grid {
      display: grid;
      gap: 16px;
    }

    .about-grid {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }

    .about-panel {
      padding: 18px;
      border-radius: 20px;
      background: rgba(244, 249, 252, 0.92);
      border: var(--border);
    }

    @media (max-width: 720px) {
      .app-shell,
      .page-shell {
        padding: 18px;
      }

      .hero {
        flex-direction: column;
        align-items: start;
      }
    }
`;
