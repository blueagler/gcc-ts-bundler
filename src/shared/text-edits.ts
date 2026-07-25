export interface TextEdit {
  end: number;
  start: number;
  text: string;
}

/** Apply non-overlapping edits by splicing from the end backwards. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  let rewritten = text;
  for (const edit of [...edits].sort(
    (left, right) => right.start - left.start,
  )) {
    rewritten =
      rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  return rewritten;
}
