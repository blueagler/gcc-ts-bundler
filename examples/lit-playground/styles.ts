import { css } from "lit";

export const appStyles = css`
  :host {
    display: block;
    color: #102032;
    --surface: rgba(255, 255, 255, 0.9);
    --surface-strong: rgba(255, 255, 255, 0.96);
    --surface-soft: rgba(244, 249, 252, 0.92);
    --text-muted: rgba(16, 32, 50, 0.72);
    --accent-color: #1f4e6d;
    --accent-soft: #6f95ae;
    --border: 1px solid rgba(31, 78, 109, 0.12);
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
  h3,
  p,
  ul {
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

  .eyebrow,
  .detail-badge {
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

  .hero-copy p,
  .card-summary,
  .page-shell p {
    color: var(--text-muted);
    line-height: 1.7;
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

  .route-intro {
    display: grid;
    gap: 10px;
    padding: 20px 22px;
    border-radius: var(--radius-medium);
    background: rgba(255, 255, 255, 0.74);
    border: var(--border);
    box-shadow: var(--shadow);
  }

  .cards {
    list-style: none;
    padding: 0;
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

  .detail-card,
  .about-card,
  .loading-card,
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

  .loading-card {
    background:
      linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(233, 243, 248, 0.96));
  }

  .detail-card .icon {
    font-size: 5rem;
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
    background: var(--surface-soft);
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

export const motionLetterStyles = [
  css`
    :host {
      display: flex;
      min-height: 180px;
      width: min(100%, 520px);
      align-items: center;
      position: relative;
      overflow: hidden;
      color: #040424;
      cursor: pointer;
      user-select: none;
    }

    .letter {
      flex: 1;
      font-size: clamp(4rem, 12vw, 10rem);
      line-height: 0.9;
      text-align: center;
      will-change: transform;
      background: linear-gradient(
        0deg,
        rgba(2, 0, 36, 1) 0%,
        rgba(9, 33, 121, 1) 35%,
        rgba(0, 212, 255, 1) 100%
      );
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .info {
      position: absolute;
      right: 8px;
      bottom: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.72);
      color: rgba(16, 32, 50, 0.72);
      font-size: 0.75rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
  `,
];
