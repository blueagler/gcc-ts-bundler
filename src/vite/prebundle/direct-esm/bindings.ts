import { toRelativeImportSpecifier } from "../../capture";

export interface ResolvedBinding {
  imported: string;
  local: string;
  targetFilePath: string;
}

export function renderResolvedImports(
  importerFilePath: string,
  bindings: ResolvedBinding[],
) {
  const bindingsByTarget = new Map<string, ResolvedBinding[]>();
  for (const binding of bindings) {
    const bucket = bindingsByTarget.get(binding.targetFilePath);
    if (bucket) {
      bucket.push(binding);
    } else {
      bindingsByTarget.set(binding.targetFilePath, [binding]);
    }
  }
  return [...bindingsByTarget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetFilePath, targetBindings]) => {
      const specifiers = targetBindings
        .sort((left, right) => left.local.localeCompare(right.local))
        .map(({ imported, local }) =>
          imported === local ? imported : `${imported} as ${local}`,
        );
      return `import { ${specifiers.join(", ")} } from ${JSON.stringify(
        toRelativeImportSpecifier(importerFilePath, targetFilePath),
      )};`;
    })
    .join("\n");
}
