import type { KnownTrit, TernaryWord } from "../editor-model";

export const MIN_SIGNAL_WIDTH = 1;
export const MAX_SIGNAL_WIDTH = 27;
export const SIGNAL_WIDTH_PRESETS = [1, 3, 6, 9, 18, 27] as const;

export type SignalWidth = number;
export type KnownTernaryWord = TernaryWord;

export function assertSignalWidth(value: unknown): SignalWidth {
  if (!Number.isInteger(value)) {
    throw new Error("Signal width must be an integer");
  }
  const width = value as number;
  if (width < MIN_SIGNAL_WIDTH || width > MAX_SIGNAL_WIDTH) {
    throw new Error(
      `Signal width must be between ${MIN_SIGNAL_WIDTH} and ${MAX_SIGNAL_WIDTH}`,
    );
  }
  return width;
}

export function assertKnownWord(
  value: unknown,
  width: SignalWidth,
): KnownTernaryWord {
  const checkedWidth = assertSignalWidth(width);
  if (typeof value !== "string" || value.length !== checkedWidth) {
    throw new Error(`Known ternary word must contain exactly ${checkedWidth} trits`);
  }
  if (!/^[T01]+$/.test(value)) {
    throw new Error("Known ternary word may contain only T, 0, or 1");
  }
  return value;
}

/** Returns bit index 0 as the least-significant trit of an MS-first word. */
export function lstTritAt(word: KnownTernaryWord, index: number): KnownTrit {
  if (!Number.isInteger(index) || index < 0 || index >= word.length) {
    throw new Error(`Trit index ${index} is outside word width ${word.length}`);
  }
  return word[word.length - 1 - index] as KnownTrit;
}

/** Builds the displayed MS-first word from trits ordered least-significant first. */
export function wordFromLstTrits(trits: readonly KnownTrit[]): KnownTernaryWord {
  return [...trits].reverse().join("");
}
