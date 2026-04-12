function findMatchingParen(sourceText: string, openParenIndex: number) {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  for (let index = openParenIndex; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (inString) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === inString) {
        inString = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      inString = character as '"' | "'" | "`";
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error("gccTsBundler() could not parse the runtime manifest call.");
}

function findMatchingDelimiter(
  sourceText: string,
  openIndex: number,
  openCharacter: string,
  closeCharacter: string,
) {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  for (let index = openIndex; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (inString) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === inString) {
        inString = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      inString = character as '"' | "'" | "`";
      continue;
    }
    if (character === openCharacter) {
      depth += 1;
      continue;
    }
    if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error(
    "gccTsBundler() could not parse the runtime manifest payload.",
  );
}

export function extractRuntimeInitManifest(sourceText: string) {
  const runtimeMarkerIndex = sourceText.indexOf("__g");
  if (runtimeMarkerIndex < 0) {
    throw new Error("gccTsBundler() could not find the runtime global marker.");
  }

  const applyIndex = sourceText.indexOf(".a(", runtimeMarkerIndex);
  if (applyIndex < 0) {
    throw new Error(
      "gccTsBundler() could not find the runtime manifest init call.",
    );
  }

  const openParenIndex = sourceText.indexOf("(", applyIndex);
  const arrayStartIndex = sourceText.indexOf("[", openParenIndex);
  if (openParenIndex < 0 || arrayStartIndex < 0) {
    throw new Error(
      "gccTsBundler() could not find the runtime manifest payload in the base chunk.",
    );
  }

  const arrayEndIndex = findMatchingDelimiter(
    sourceText,
    arrayStartIndex,
    "[",
    "]",
  );
  const manifestText = sourceText.slice(arrayStartIndex, arrayEndIndex + 1);
  const manifest = Function(`return (${manifestText});`)();
  const closeParenIndex = findMatchingParen(sourceText, openParenIndex);
  let insertIndex = closeParenIndex + 1;
  if (sourceText[insertIndex] === ";") {
    insertIndex += 1;
  }

  return {
    arrayEndIndex,
    arrayStartIndex,
    insertIndex,
    manifest,
  };
}

export function replaceRuntimeInitManifest(
  sourceText: string,
  manifest: unknown,
) {
  const payload = extractRuntimeInitManifest(sourceText);
  return (
    sourceText.slice(0, payload.arrayStartIndex) +
    JSON.stringify(manifest) +
    sourceText.slice(payload.arrayEndIndex + 1)
  );
}
