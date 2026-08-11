export type CanvasDisplayMode = "balanced" | "decimal";

export function formatCanvasWord(
  word: string,
  mode: CanvasDisplayMode,
): string {
  if (mode !== "decimal" || word.length <= 1 || !/^[T01]+$/.test(word)) {
    return word;
  }
  let value = 0n;
  for (const trit of word) {
    value = value * 3n + (trit === "T" ? -1n : trit === "1" ? 1n : 0n);
  }
  return value.toString();
}
