import type { TraceFrame, TraceWatch } from "../wasm-client";

export type BusDisplayMode = "balanced" | "decimal" | "trits";

export interface ValueRun {
  start: number;
  end: number;
  value: string;
}

export interface MetaTrit {
  index: number;
  symbol: "X" | "Z" | "E";
}

export interface ChronogramSegment extends ValueRun {
  label: string;
  metaTrits: MetaTrit[];
}

export interface ChronogramRowProjection {
  watchId: string;
  width: number;
  values: string[];
  segments: ChronogramSegment[];
}

export interface ChronogramProjection {
  rows: ChronogramRowProjection[];
  valuesByWatch: string[][];
  cellCount: number;
}

export function groupConsecutiveValues(values: readonly string[]): ValueRun[] {
  if (values.length === 0) return [];
  const runs: ValueRun[] = [];
  let start = 0;
  for (let index = 1; index <= values.length; index += 1) {
    if (index < values.length && values[index] === values[start]) continue;
    runs.push({ start, end: index, value: values[start] });
    start = index;
  }
  return runs;
}

export function formatTraceWord(word: string, mode: BusDisplayMode): string {
  if (mode === "trits") return [...word].join(" ");
  if (mode === "decimal" && /^[T01]+$/.test(word)) {
    let value = 0n;
    for (const trit of word) {
      value = value * 3n + (trit === "T" ? -1n : trit === "1" ? 1n : 0n);
    }
    return value.toString();
  }
  return word;
}

export function buildChronogramProjection({
  frames,
  watches,
  widths,
  displayMode,
}: {
  frames: readonly TraceFrame[];
  watches: readonly TraceWatch[];
  widths: ReadonlyMap<string, number>;
  displayMode: BusDisplayMode;
}): ChronogramProjection {
  const watchIndex = new Map(watches.map((watch, index) => [watch.id, index]));
  const valuesByWatch = watches.map(() => Array<string>(frames.length).fill("X"));

  frames.forEach((frame, frameIndex) => {
    for (const value of frame.values) {
      const rowIndex = watchIndex.get(value.watchId);
      if (rowIndex !== undefined) valuesByWatch[rowIndex][frameIndex] = value.value;
    }
  });

  const rows = watches.map((watch, index): ChronogramRowProjection => {
    const values = valuesByWatch[index];
    const inferredWidth = values.find((value) => value !== "X")?.length ?? 1;
    const width = widths.get(watch.id) ?? inferredWidth;
    return {
      watchId: watch.id,
      width,
      values,
      segments: groupConsecutiveValues(values).map((run) => ({
        ...run,
        label: formatTraceWord(run.value, displayMode),
        metaTrits: [...run.value].flatMap((symbol, tritIndex) =>
          symbol === "X" || symbol === "Z" || symbol === "E"
            ? [{ index: tritIndex, symbol }]
            : [],
        ),
      })),
    };
  });

  return { rows, valuesByWatch, cellCount: watches.length * frames.length };
}
