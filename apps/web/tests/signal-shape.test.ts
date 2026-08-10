import { describe, expect, it } from "vitest";
import {
  SIGNAL_WIDTH_PRESETS,
  assertKnownWord,
  assertSignalWidth,
  lstTritAt,
  wordFromLstTrits,
} from "../src/project/signal-shape";

describe("signal shape contracts", () => {
  it("accepts widths 1 through 27 and exposes the supported presets", () => {
    expect(assertSignalWidth(1)).toBe(1);
    expect(assertSignalWidth(27)).toBe(27);
    expect(SIGNAL_WIDTH_PRESETS).toEqual([1, 3, 6, 9, 18, 27]);
    expect(() => assertSignalWidth(0)).toThrow(/1.*27/i);
    expect(() => assertSignalWidth(28)).toThrow(/1.*27/i);
    expect(() => assertSignalWidth(1.5)).toThrow(/integer/i);
  });

  it("validates exact-width known words and keeps display words MS-first", () => {
    expect(assertKnownWord("1T0", 3)).toBe("1T0");
    expect(lstTritAt("1T0", 0)).toBe("0");
    expect(lstTritAt("1T0", 2)).toBe("1");
    expect(wordFromLstTrits(["0", "T", "1"])).toBe("1T0");
    expect(() => assertKnownWord("10", 3)).toThrow(/exactly 3/i);
    expect(() => assertKnownWord("1X0", 3)).toThrow(/T, 0, or 1/i);
  });
});
