import escapeStringRegexp from "escape-string-regexp";

const raw = "file(name)+[v2].ts";
const escaped = escapeStringRegexp(raw);

const output = document.getElementById("output");
if (!output) {
  throw new Error("Missing #output element");
}

output.textContent = `Escaped pattern: ${escaped}`;
