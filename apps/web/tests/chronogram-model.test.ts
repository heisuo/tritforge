import { describe, expect, it } from "vitest";
import {
  buildChronogramProjection,
  formatTraceWord,
  groupConsecutiveValues,
} from "../src/components/chronogram-model";
import type { TraceFrame, TraceWatch } from "../src/wasm-client";

const scalarWatch: TraceWatch = {
  id: "scalar",
  signal: {
    kind: "componentPort",
    ref: {
      circuitId: "main",
      instancePath: [],
      componentId: "input-1",
      portId: "out",
    },
  },
};

const busWatch: TraceWatch = {
  id: "bus",
  signal: {
    kind: "componentPort",
    ref: {
      circuitId: "main",
      instancePath: [],
      componentId: "bus-1",
      portId: "out",
    },
  },
};

function traceFrame(index: number, scalar: string, bus: string): TraceFrame {
  return {
    cycle: index,
    clockPhase: index % 2 ? "highStable" : "lowStable",
    reason: "clockRise",
    diagnostics: [],
    values: [
      { watchId: scalarWatch.id, value: scalar },
      { watchId: busWatch.id, value: bus },
    ],
  };
}

describe("chronogram projection", () => {
  it("groups consecutive equal bus values and emits one label per transition", () => {
    expect(groupConsecutiveValues(["1T0", "1T0", "001", "001", "1T0"]))
      .toEqual([
        { start: 0, end: 2, value: "1T0" },
        { start: 2, end: 4, value: "001" },
        { start: 4, end: 5, value: "1T0" },
      ]);

    const projection = buildChronogramProjection({
      frames: [
        traceFrame(0, "T", "1T0"),
        traceFrame(1, "T", "1T0"),
        traceFrame(2, "0", "001"),
      ],
      watches: [scalarWatch, busWatch],
      widths: new Map([[scalarWatch.id, 1], [busWatch.id, 3]]),
      displayMode: "balanced",
    });
    const busRow = projection.rows[1];
    expect(busRow.segments).toHaveLength(2);
    expect(busRow.segments.map((segment) => segment.label)).toEqual(["1T0", "001"]);
  });

  it("keeps every mixed meta trit distinct inside one bus band", () => {
    const projection = buildChronogramProjection({
      frames: [traceFrame(0, "X", "XZE")],
      watches: [scalarWatch, busWatch],
      widths: new Map([[scalarWatch.id, 1], [busWatch.id, 3]]),
      displayMode: "trits",
    });
    const segment = projection.rows[1].segments[0];
    expect(segment.label).toBe("X Z E");
    expect(segment.metaTrits).toEqual([
      { index: 0, symbol: "X" },
      { index: 1, symbol: "Z" },
      { index: 2, symbol: "E" },
    ]);
  });

  it("preindexes a full 64 by 512 trace matrix and preserves display modes", () => {
    const watches = Array.from({ length: 64 }, (_, index): TraceWatch => ({
      ...scalarWatch,
      id: `watch-${index}`,
    }));
    const frames = Array.from({ length: 512 }, (_, frameIndex): TraceFrame => ({
      cycle: frameIndex,
      clockPhase: frameIndex % 2 ? "highStable" : "lowStable",
      reason: "clockRise",
      diagnostics: [],
      values: watches.map((watch, watchIndex) => ({
        watchId: watch.id,
        value: String((frameIndex + watchIndex) % 3 === 0 ? "T" : (frameIndex + watchIndex) % 3 === 1 ? "0" : "1"),
      })),
    }));
    const started = performance.now();
    const projection = buildChronogramProjection({
      frames,
      watches,
      widths: new Map(watches.map((watch) => [watch.id, 1])),
      displayMode: "balanced",
    });

    expect(projection.valuesByWatch).toHaveLength(64);
    expect(projection.valuesByWatch[0]).toHaveLength(512);
    expect(projection.cellCount).toBe(64 * 512);
    expect(performance.now() - started).toBeLessThan(750);
    expect(formatTraceWord("1T0", "balanced")).toBe("1T0");
    expect(formatTraceWord("1T0", "decimal")).toBe("6");
    expect(formatTraceWord("1T0", "trits")).toBe("1 T 0");
  });
});
