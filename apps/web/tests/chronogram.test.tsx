import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    fireEvent.click(screen.getByRole("button", { name: "清空时序记录" }));
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

  it("formats buses as balanced ternary, decimal, or separated trits", () => {
    render(<Chronogram {...baseProps} />);
    const row = screen.getByTestId(`wave-${busWatch.id}`);
    expect(row).toHaveTextContent("1T0");

    fireEvent.change(screen.getByLabelText("总线显示模式"), {
      target: { value: "decimal" },
    });
    expect(row).toHaveTextContent("6");

    fireEvent.change(screen.getByLabelText("总线显示模式"), {
      target: { value: "trits" },
    });
    expect(row).toHaveTextContent("1 T 0");
  });

  it("uses three scalar levels and distinct unknown, high-impedance, and error marks", () => {
    const metaFrames = [
      frame(0, "T", "1T0"),
      frame(1, "0", "1T0"),
      frame(2, "1", "1T0"),
      frame(3, "X", "1T0"),
      frame(4, "Z", "1T0"),
      frame(5, "E", "1T0"),
    ];
    render(<Chronogram {...baseProps} frames={metaFrames} />);
    const row = screen.getByTestId(`wave-${scalarWatch.id}`);
    expect(within(row).getByTestId("scalar-waveform")).toBeInTheDocument();
    expect(within(row).getByTestId("scalar-T")).toHaveAttribute("data-level", "low");
    expect(within(row).getByTestId("scalar-0")).toHaveAttribute("data-level", "middle");
    expect(within(row).getByTestId("scalar-1")).toHaveAttribute("data-level", "high");
    expect(within(row).getByTestId("scalar-X")).toHaveClass("state-X");
    expect(within(row).getByTestId("scalar-Z")).toHaveClass("state-Z");
    expect(within(row).getByTestId("scalar-E")).toHaveClass("state-E");
  });
});
