# Official-example byte proof

Tracked official-example distributions are reproduced only with the input contract enforced by `bun run verify:examples`:

1. Use released Bun **1.3.14**. Download `bun-v1.3.14` for the host from the `oven-sh/bun` GitHub release and verify its archive against that release's `SHASUMS256.txt` before extracting it.
2. Invoke the checker with that binary, for example `GCC_BUN_BIN=/path/to/bun bun run verify:examples`.
3. The checker rebuilds this package, creates a fresh copy of each official example, runs `bun install --frozen-lockfile` from that example's own committed `bun.lock`, builds it, and compares every output file's SHA-256 with the tracked `dist`.

The examples intentionally use `link:gcc-ts-bundler`; the checker registers only this repository package. It creates no transitive dependency links, so isolated Bun layouts must resolve every package dependency from its originating package context.

This contract replaces the prior implicit environment. The previous Lit artifact (`index-JteXPhZx.js`) had no matching released-Bun/frozen-lockfile proof; released Bun 1.3.14 with the current committed Lit lock deterministically emits `index-byH8Z65S.js` instead. The checker makes future artifact updates fail closed unless the fresh, locked build is byte-identical.
