/** Whitespace, stray semicolons, and the scaffolding every chunk carries. */
const SCAFFOLDING_PATTERNS = [
  /^[\s;]+/u,
  // Side-effect or named ES import of a sibling chunk.
  /^import\s*(?:[\w$*{}\s,]*\s+from\s*)?(["'])(?:\\.|(?!\1)[^\\])*\1\s*;?/u,
  // The per-chunk runtime alias line, in either output shape.
  /^var\s+[A-Za-z_$][\w$]*\s*=\s*globalThis(?:\.[\w$]+|\[(["'])(?:\\.|(?!\1)[^\\])*\1\])[^;]*;/u,
  // The chunk's own `l(<index>)` completion call, after property renaming.
  /^(?:globalThis|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*\(\s*\d+\s*\)\s*;?/u,
];

const IIFE_HEAD = /^!?\(?function\s*\([^)]*\)\s*\{/u;
const IIFE_TAIL = /\}\s*\)?\s*(?:\(\s*\)|\.call\s*\([^)]*\))\s*;?\s*$/u;

/**
 * True when the chunk body is only scaffolding. Fail-closed: anything the
 * whitelist does not recognise keeps the chunk.
 */
export function isScaffoldingOnly(sourceText: string) {
  let rest = sourceText;
  for (;;) {
    const before = rest;
    rest = rest.trim();
    const head = IIFE_HEAD.exec(rest);
    const tail = IIFE_TAIL.exec(rest);
    if (head && tail && tail.index >= head[0].length) {
      rest = rest.slice(head[0].length, tail.index);
    } else {
      for (const pattern of SCAFFOLDING_PATTERNS) {
        const match = pattern.exec(rest);
        if (match && match[0].length > 0) {
          rest = rest.slice(match[0].length);
          break;
        }
      }
    }
    if (rest === before) {
      return rest.length === 0;
    }
  }
}
