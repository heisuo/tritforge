import { describe, expect, it } from "vitest";
import {
  rotateClockwise,
  rotateCounterClockwise,
  rotatedSide,
} from "../src/editor/node-rotation";
import {
  fromEditorDocument,
  toEditorDocument,
  type CircuitDocument,
} from "../src/editor/circuit-document";

describe("node rotation", () => {
  it("cycles clockwise and counter-clockwise through four directions", () => {
    expect(rotateClockwise(0)).toBe(90);
    expect(rotateClockwise(90)).toBe(180);
    expect(rotateClockwise(180)).toBe(270);
    expect(rotateClockwise(270)).toBe(0);
    expect(rotateCounterClockwise(0)).toBe(270);
  });

  it("maps logical port sides to physical sides", () => {
    expect(rotatedSide("left", 0)).toBe("left");
    expect(rotatedSide("left", 90)).toBe("top");
    expect(rotatedSide("left", 180)).toBe("right");
    expect(rotatedSide("left", 270)).toBe("bottom");
    expect(rotatedSide("right", 90)).toBe("bottom");
  });

  it("preserves rotation through editor projection", () => {
    const circuit: CircuitDocument = {
      format: "logsim-ternary",
      version: 1,
      components: [
        {
          id: "gate",
          typeId: "gate.buf",
          position: { x: 10, y: 20 },
          rotation: 270,
          properties: { label: "BUF" },
        },
      ],
      connections: [],
    };

    expect(fromEditorDocument(toEditorDocument(circuit)).components[0].rotation).toBe(
      270,
    );
  });
});
