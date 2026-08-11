import { describe, expect, it } from "vitest";
import { formatCanvasWord } from "../src/canvas-display";

describe("canvas signal display", () => {
  it("converts known multi-trit balanced words to decimal", () => {
    expect(formatCanvasWord("1T0", "decimal")).toBe("6");
    expect(formatCanvasWord("T01", "decimal")).toBe("-8");
    expect(formatCanvasWord("111111111111111111111111111", "decimal")).toBe(
      "3812798742493",
    );
  });

  it("keeps scalar and meta-state signals in ternary notation", () => {
    expect(formatCanvasWord("T", "decimal")).toBe("T");
    expect(formatCanvasWord("1XE", "decimal")).toBe("1XE");
    expect(formatCanvasWord("1T0", "balanced")).toBe("1T0");
  });
});
