import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Chronogram, type ChronogramSignalOption } from "../src/components/Chronogram";
import type { TraceFrame, TraceWatch } from "../src/wasm-client";

const availableSignals: ChronogramSignalOption[] = [
  {
    id: "main::input-1.out",
    label: "Input.out",
    width: 1,
    signal: {
      kind: "componentPort",
      ref: {
        circuitId: "main",
        instancePath: [],
        componentId: "input-1",
        portId: "out",
      },
    },
  },
  {
    id: "main::bus-1.out",
    label: "Data.out",
    width: 3,
    signal: {
      kind: "componentPort",
      ref: {
        circuitId: "main",
        instancePath: [],
        componentId: "bus-1",
        portId: "out",
      },
    },
  },
];

const scalarWatch: TraceWatch = {
  id: availableSignals[0].id,
  signal: availableSignals[0].signal,
};

const busWatch: TraceWatch = {
  id: availableSignals[1].id,
  signal: availableSignals[1].signal,
};

function frame(
  cycle: number,
  scalar: string,
  bus: string,
  reason: TraceFrame["reason"] = "clockRise",
): TraceFrame {
  return {
    cycle,
    clockPhase: cycle % 2 === 0 ? "lowStable" : "highStable",
    reason,
    values: [
      { watchId: scalarWatch.id, value: scalar },
      { watchId: busWatch.id, value: bus },
    ],
    diagnostics: [],
  };
}

const baseProps = {
  availableSignals,
  watches: [scalarWatch, busWatch],
  frames: [frame(0, "T", "1T0", "load"), frame(1, "0", "001")],
  rate: 2 as const,
  status: "paused" as const,
  disabled: false,
  onToggleRun: vi.fn(),
  onAdvancePhase: vi.fn(),
  onTick: vi.fn(),
  onClear: vi.fn(),
  onRateChange: vi.fn(),
  onWatchesChange: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    setLineDash: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});

describe("Chronogram", () => {
  it("adds, removes, and reorders watches through controlled updates", () => {
    function Harness() {
      const [watches, setWatches] = useState<TraceWatch[]>([scalarWatch]);
      return (
        <Chronogram
          {...baseProps}
          watches={watches}
          onWatchesChange={(next) => setWatches(next)}
        />
      );
    }

    render(<Harness />);
    fireEvent.change(screen.getByLabelText("可观察信号"), {
      target: { value: busWatch.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加观察信号" }));
    expect(screen.getAllByTestId("chronogram-watch")).toHaveLength(2);

    const dataRow = screen
      .getAllByTestId("chronogram-watch")
      .find((item) => item.getAttribute("data-watch-id") === busWatch.id)!;
    fireEvent.click(within(dataRow).getByRole("button", { name: "上移 Data.out" }));
    expect(screen.getAllByTestId("watch-label").map((item) => item.textContent)).toEqual([
      "Data.out",
      "Input.out",
    ]);

    fireEvent.click(within(dataRow).getByRole("button", { name: "移除 Data.out" }));
    expect(screen.getAllByTestId("chronogram-watch")).toHaveLength(1);
    expect(screen.getByTestId("watch-label")).toHaveTextContent("Input.out");
  });

  it("collapses and resizes the bottom dock from the keyboard separator", () => {
    render(<Chronogram {...baseProps} />);
    const dock = screen.getByRole("region", { name: "时序图" });
    expect(dock).toHaveStyle({ height: "240px" });

    fireEvent.keyDown(screen.getByRole("separator", { name: "调整时序图高度" }), {
      key: "ArrowUp",
    });
    expect(dock).toHaveStyle({ height: "264px" });

    fireEvent.click(screen.getByRole("button", { name: "折叠时序图" }));
    expect(dock).toHaveClass("is-collapsed");
    expect(screen.queryByLabelText("时序图游标")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开时序图" }));
    expect(dock).not.toHaveClass("is-collapsed");
  });

  it("exposes run, pause, phase, Tick, clear, and speed controls", () => {
    const onToggleRun = vi.fn();
    const onAdvancePhase = vi.fn();
    const onTick = vi.fn();
    const onClear = vi.fn();
    const onRateChange = vi.fn();
    const { rerender } = render(
      <Chronogram
        {...baseProps}
        onToggleRun={onToggleRun}
        onAdvancePhase={onAdvancePhase}
        onTick={onTick}
        onClear={onClear}
        onRateChange={onRateChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "运行自动时钟" }));
    fireEvent.click(screen.getByRole("button", { name: "推进一个相位" }));
    fireEvent.click(screen.getByRole("button", { name: "推进一个完整 Tick" }));
    fireEvent.click(screen.getByRole("button", { name: "清除波形历史" }));
    fireEvent.change(screen.getByLabelText("自动时钟速度"), {
      target: { value: "10" },
    });
    expect(onToggleRun).toHaveBeenCalledTimes(1);
    expect(onAdvancePhase).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onRateChange).toHaveBeenCalledWith(10);

    rerender(
      <Chronogram
        {...baseProps}
        status="running"
        onToggleRun={onToggleRun}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "暂停自动时钟" }));
    expect(onToggleRun).toHaveBeenCalledTimes(2);
  });

  it("moves the cursor and shows each watched value at that frame", () => {
    render(<Chronogram {...baseProps} />);
    fireEvent.change(screen.getByLabelText("时序图游标"), {
      target: { value: "1" },
    });
    const cursor = screen.getByTestId("chronogram-cursor-values");
    expect(cursor).toHaveTextContent("周期 1");
    expect(cursor).toHaveTextContent("Input.out 0");
    expect(cursor).toHaveTextContent("Data.out 001");
  });

  it("renders a bounded 512-frame history without dropping the cursor endpoint", () => {
    const frames = Array.from({ length: 512 }, (_, index) =>
      frame(index, index % 3 === 0 ? "T" : index % 3 === 1 ? "0" : "1", "1T0"),
    );
    render(<Chronogram {...baseProps} frames={frames} />);
    expect(screen.getByTestId("chronogram-viewport")).toHaveAttribute(
      "data-frame-count",
      "512",
    );
    const cursor = screen.getByLabelText("时序图游标");
    expect(cursor).toHaveAttribute("max", "511");
    fireEvent.change(cursor, { target: { value: "511" } });
    expect(screen.getByTestId("chronogram-cursor-values")).toHaveTextContent(
      "周期 511",
    );
  });

  it("formats cursor buses as balanced ternary, decimal, or separated trits", () => {
    render(<Chronogram {...baseProps} />);
    const values = screen.getByTestId("chronogram-cursor-values");
    fireEvent.change(screen.getByLabelText("时序图游标"), { target: { value: "0" } });
    expect(values).toHaveTextContent("1T0");

    fireEvent.change(screen.getByLabelText("总线显示模式"), {
      target: { value: "decimal" },
    });
    expect(values).toHaveTextContent("6");

    fireEvent.change(screen.getByLabelText("总线显示模式"), {
      target: { value: "trits" },
    });
    expect(values).toHaveTextContent("1 T 0");
  });

  it("uses one canvas and bounded DOM for 64 watches by 512 frames", () => {
    const signals = Array.from({ length: 64 }, (_, index): ChronogramSignalOption => ({
      ...availableSignals[0],
      id: `watch-${index}`,
      label: `Signal ${index}`,
      signal: {
        kind: "componentPort",
        ref: {
          circuitId: "main",
          instancePath: [],
          componentId: `input-${index}`,
          portId: "out",
        },
      },
    }));
    const watches = signals.map((signal): TraceWatch => ({ id: signal.id, signal: signal.signal }));
    const frames = Array.from({ length: 512 }, (_, index): TraceFrame => ({
      cycle: index,
      clockPhase: index % 2 ? "highStable" : "lowStable",
      reason: "clockRise",
      diagnostics: [],
      values: watches.map((watch, watchIndex) => ({
        watchId: watch.id,
        value: (index + watchIndex) % 2 ? "1" : "T",
      })),
    }));
    const { container } = render(
      <Chronogram {...baseProps} availableSignals={signals} watches={watches} frames={frames} />,
    );

    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.querySelectorAll("*").length).toBeLessThan(1400);
    expect(container.querySelector("canvas")).toHaveAttribute("data-cell-count", "32768");
    expect(container.querySelectorAll(".scalar-segment, .bus-segment")).toHaveLength(0);
  });

  it("keeps labels and waves in one shared vertical scroller", () => {
    render(<Chronogram {...baseProps} />);
    const viewport = screen.getByTestId("chronogram-viewport");
    expect(viewport).toContainElement(screen.getAllByTestId("chronogram-watch")[0]);
    expect(viewport).toContainElement(screen.getByRole("img", { name: "三进制时序波形" }));
    viewport.scrollTop = 36;
    fireEvent.scroll(viewport);
    expect(screen.getByRole("img", { name: "三进制时序波形" })).toHaveAttribute(
      "data-scroll-top",
      "36",
    );
  });

  it("follows the live tail until the cursor is moved back", async () => {
    const { rerender } = render(<Chronogram {...baseProps} />);
    const viewport = screen.getByTestId("chronogram-viewport");
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 900 });

    const threeFrames = [...baseProps.frames, frame(2, "1", "1T1")];
    rerender(<Chronogram {...baseProps} frames={threeFrames} />);
    await waitFor(() => expect(screen.getByLabelText("时序图游标")).toHaveValue("2"));
    expect(viewport.scrollLeft).toBe(600);

    fireEvent.change(screen.getByLabelText("时序图游标"), { target: { value: "0" } });
    viewport.scrollLeft = 120;
    rerender(<Chronogram {...baseProps} frames={[...threeFrames, frame(3, "T", "XZE")]} />);
    expect(screen.getByLabelText("时序图游标")).toHaveValue("0");
    expect(viewport.scrollLeft).toBe(120);

    fireEvent.change(screen.getByLabelText("时序图游标"), { target: { value: "3" } });
    rerender(<Chronogram {...baseProps} frames={[...threeFrames, frame(3, "T", "XZE"), frame(4, "0", "111")]} />);
    await waitFor(() => expect(screen.getByLabelText("时序图游标")).toHaveValue("4"));
    expect(viewport.scrollLeft).toBe(600);
  });

  it("notifies layout changes and ends resize on pointer cancellation or window blur", () => {
    const onLayoutChange = vi.fn();
    render(<Chronogram {...baseProps} onLayoutChange={onLayoutChange} />);
    const dock = screen.getByRole("region", { name: "时序图" });
    const separator = screen.getByRole("separator", { name: "调整时序图高度" });

    fireEvent.pointerDown(separator, { clientY: 300 });
    fireEvent.pointerMove(window, { clientY: 260 });
    const draggedHeight = dock.style.height;
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, { clientY: 180 });
    expect(dock.style.height).toBe(draggedHeight);

    fireEvent.pointerDown(separator, { clientY: 300 });
    fireEvent(window, new Event("blur"));
    fireEvent.pointerMove(window, { clientY: 200 });
    expect(dock.style.height).toBe(draggedHeight);

    fireEvent.click(screen.getByRole("button", { name: "折叠时序图" }));
    expect(onLayoutChange).toHaveBeenCalled();
  });
});
