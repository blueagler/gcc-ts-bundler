import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>gcc-ts-bundler React SPA</h1>
      <p>Node package support now resolves browser-safe ESM dependencies.</p>
      <button onClick={() => setCount((value) => value + 1)} type="button">
        Count: {count}
      </button>
    </main>
  );
}
