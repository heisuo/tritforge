import { describe, expect, it } from "vitest";
import {
  assignWireLanes,
  createLogicWirePath,
  type WireGeometry,
} from "../src/wire-routing";

const fanOutWires: WireGeometry[] = [
  {
    id: "to-bottom",
    source: "input",
    sourceHandle: "out",
    target: "bottom",
    targetHandle: "a",
    sourcePosition: { x: 100, y: 200 },
    targetPosition: { x: 500, y: 360 },
  },
  {
    id: "to-top",
    source: "input",
    sourceHandle: "out",
    target: "top",
    targetHandle: "a",
    sourcePosition: { x: 100, y: 200 },
    targetPosition: { x: 500, y: 80 },
  },
  {
    id: "to-middle",
    source: "input",
    sourceHandle: "out",
    target: "middle",
    targetHandle: "a",
    sourcePosition: { x: 100, y: 200 },
    targetPosition: { x: 500, y: 220 },
  },
];

describe("stable wire lane assignment", () => {
  it("orders fan-out lanes by target geometry", () => {
    const lanes = assignWireLanes(fanOutWires);

    expect(lanes["to-top"]).toMatchObject({
      sourceLane: 0,
      sourceLaneCount: 3,
    });
    expect(lanes["to-middle"]).toMatchObject({
      sourceLane: 1,
      sourceLaneCount: 3,
    });
    expect(lanes["to-bottom"]).toMatchObject({
      sourceLane: 2,
      sourceLaneCount: 3,
    });
  });

  it("does not change lanes when input order changes", () => {
    expect(assignWireLanes([...fanOutWires].reverse())).toEqual(
      assignWireLanes(fanOutWires),
    );
  });

  it("orders fan-in lanes by source geometry", () => {
    const lanes = assignWireLanes([
      {
        id: "bottom-in",
        source: "bottom",
        sourceHandle: "out",
        target: "probe",
        targetHandle: "in",
        sourcePosition: { x: 100, y: 340 },
        targetPosition: { x: 500, y: 200 },
      },
      {
        id: "top-in",
        source: "top",
        sourceHandle: "out",
        target: "probe",
        targetHandle: "in",
        sourcePosition: { x: 100, y: 60 },
        targetPosition: { x: 500, y: 200 },
      },
    ]);

    expect(lanes["top-in"]).toMatchObject({
      targetLane: 0,
      targetLaneCount: 2,
    });
    expect(lanes["bottom-in"]).toMatchObject({
      targetLane: 1,
      targetLaneCount: 2,
    });
  });
});

describe("orthogonal logic wire paths", () => {
  it("keeps only a short shared stub before fan-out lanes separate", () => {
    const upper = createLogicWirePath({
      sourceX: 100,
      sourceY: 200,
      targetX: 500,
      targetY: 340,
      sourceLane: 0,
      sourceLaneCount: 2,
      targetLane: 0,
      targetLaneCount: 1,
    });
    const lower = createLogicWirePath({
      sourceX: 100,
      sourceY: 200,
      targetX: 500,
      targetY: 340,
      sourceLane: 1,
      sourceLaneCount: 2,
      targetLane: 0,
      targetLaneCount: 1,
    });

    expect(upper.points[0]).toEqual({ x: 100, y: 200 });
    expect(upper.points[1]).toEqual({ x: 128, y: 200 });
    expect(lower.points[1]).toEqual({ x: 142, y: 200 });
    expect(upper.path).not.toBe(lower.path);
    expect(upper.labelY).not.toBe(lower.labelY);
  });
});
