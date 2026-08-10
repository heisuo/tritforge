import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Eraser,
  Gauge,
  Pause,
  Play,
  Plus,
  SkipForward,
  StepForward,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type UIEvent,
} from "react";
import {
  AUTO_CLOCK_RATES,
  type AutoClockRate,
  type AutoClockStatus,
} from "../app/auto-clock";
import type { TraceFrame, TraceSignalRef, TraceWatch } from "../wasm-client";
import {
  buildChronogramProjection,
  formatTraceWord,
  type BusDisplayMode,
  type ChronogramProjection,
  type MetaTrit,
} from "./chronogram-model";

export type { BusDisplayMode } from "./chronogram-model";

const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 480;
const HEIGHT_STEP = 24;
const FRAME_WIDTH = 42;
const RULER_HEIGHT = 20;
const ROW_HEIGHT = 36;
const LABEL_WIDTH = 236;
const MAX_WATCHES = 64;

export interface ChronogramSignalOption {
  id: string;
  label: string;
  width: number;
  signal: TraceSignalRef;
}

export interface ChronogramProps {
  availableSignals: ChronogramSignalOption[];
  watches: TraceWatch[];
  frames: TraceFrame[];
  rate: AutoClockRate;
  status: AutoClockStatus;
  disabled?: boolean;
  onToggleRun: () => void | Promise<void>;
  onAdvancePhase: () => void | Promise<void>;
  onTick: () => void | Promise<void>;
  onClear: () => void | Promise<void>;
  onRateChange: (rate: AutoClockRate) => void | Promise<void>;
  onWatchesChange: (watches: TraceWatch[]) => void | Promise<void>;
  onLayoutChange?: () => void;
}

interface ScrollPosition {
  left: number;
  top: number;
}

export function Chronogram({
  availableSignals,
  watches,
  frames,
  rate,
  status,
  disabled = false,
  onToggleRun,
  onAdvancePhase,
  onTick,
  onClear,
  onRateChange,
  onWatchesChange,
  onLayoutChange,
}: ChronogramProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [displayMode, setDisplayMode] = useState<BusDisplayMode>("balanced");
  const [selectedSignalId, setSelectedSignalId] = useState("");
  const [cursor, setCursor] = useState(Math.max(0, frames.length - 1));
  const [busy, setBusy] = useState(false);
  const [scrollPosition, setScrollPosition] = useState<ScrollPosition>({ left: 0, top: 0 });
  const [viewportRevision, setViewportRevision] = useState(0);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const followsTailRef = useRef(true);

  const optionById = useMemo(
    () => new Map(availableSignals.map((option) => [option.id, option])),
    [availableSignals],
  );
  const watchedIds = useMemo(() => new Set(watches.map((watch) => watch.id)), [watches]);
  const addableSignals = useMemo(
    () => availableSignals.filter((option) => !watchedIds.has(option.id)),
    [availableSignals, watchedIds],
  );
  const widths = useMemo(
    () => new Map(availableSignals.map((option) => [option.id, option.width])),
    [availableSignals],
  );
  const projection = useMemo(
    () => buildChronogramProjection({ frames, watches, widths, displayMode }),
    [displayMode, frames, watches, widths],
  );
  const selectedFrame = frames[cursor] ?? frames.at(-1);
  const selectedValues = useMemo(
    () => new Map(projection.rows.map((row) => [row.watchId, row.values[cursor] ?? "X"])),
    [cursor, projection.rows],
  );

  const scrollToTail = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    setScrollPosition({ left: viewport.scrollLeft, top: viewport.scrollTop });
  }, []);

  useEffect(() => {
    const last = Math.max(0, frames.length - 1);
    if (frames.length === 0) followsTailRef.current = true;
    if (followsTailRef.current) {
      setCursor(last);
      scrollToTail();
    } else {
      setCursor((current) => Math.min(current, last));
    }
  }, [frames.length, scrollToTail]);

  useEffect(() => {
    if (selectedSignalId && addableSignals.some((item) => item.id === selectedSignalId)) return;
    setSelectedSignalId(addableSignals[0]?.id ?? "");
  }, [addableSignals, selectedSignalId]);

  useEffect(() => {
    const finishResize = () => {
      dragRef.current = null;
    };
    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (!dragRef.current) return;
      setHeight(clampHeight(dragRef.current.startHeight + dragRef.current.startY - event.clientY));
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    window.addEventListener("blur", finishResize);
    return () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("blur", finishResize);
    };
  }, []);

  useEffect(() => {
    onLayoutChange?.();
  }, [collapsed, height, onLayoutChange]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => setViewportRevision((value) => value + 1));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [collapsed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport || collapsed) return;
    drawChronogramCanvas(canvas, viewport, projection, frames, cursor, scrollPosition);
  }, [collapsed, cursor, frames, projection, scrollPosition, viewportRevision]);

  const runAction = (action: () => void | Promise<void>): void | Promise<void> => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      const result = action();
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(() => setBusy(false));
      }
      setBusy(false);
    } catch (error) {
      setBusy(false);
      throw error;
    }
  };

  const replaceWatches = (next: TraceWatch[]) => runAction(() => onWatchesChange(next));
  const addWatch = () => {
    const option = optionById.get(selectedSignalId);
    if (!option || watches.length >= MAX_WATCHES || watchedIds.has(option.id)) return;
    void replaceWatches([...watches, { id: option.id, signal: structuredClone(option.signal) }]);
  };
  const moveWatch = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= watches.length) return;
    const next = [...watches];
    [next[index], next[target]] = [next[target], next[index]];
    void replaceWatches(next);
  };
  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setHeight((current) => clampHeight(current + (event.key === "ArrowUp" ? HEIGHT_STEP : -HEIGHT_STEP)));
  };
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!collapsed) dragRef.current = { startY: event.clientY, startHeight: height };
  };
  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollPosition({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop });
  };
  const moveCursor = (next: number) => {
    const last = Math.max(0, frames.length - 1);
    followsTailRef.current = next >= last;
    setCursor(next);
    if (followsTailRef.current) scrollToTail();
  };

  const controlsDisabled = disabled || busy || status === "disposed";
  const running = status === "running" || status === "suspended";
  const trackWidth = Math.max(1, frames.length) * FRAME_WIDTH;
  const trackHeight = RULER_HEIGHT + watches.length * ROW_HEIGHT;

  return (
    <section
      className={`chronogram ${collapsed ? "is-collapsed" : ""}`}
      style={{ height: collapsed ? "36px" : `${height}px` }}
      role="region"
      aria-label="时序图"
    >
      <div
        className="chronogram-resizer"
        role="separator"
        aria-label="调整时序图高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={MAX_HEIGHT}
        aria-valuenow={height}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={startResize}
        onKeyDown={resizeFromKeyboard}
      />
      <header className="chronogram-toolbar">
        <div className="chronogram-title">
          <Gauge aria-hidden="true" />
          <strong>时序图</strong>
          <span>{frames.length}/512</span>
        </div>
        <div className="chronogram-actions" role="toolbar" aria-label="时序控制">
          <button type="button" className="icon-button" title={running ? "暂停自动时钟" : "运行自动时钟"} aria-label={running ? "暂停自动时钟" : "运行自动时钟"} disabled={controlsDisabled} onClick={() => void runAction(onToggleRun)}>
            {running ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
          <button type="button" className="icon-button" title="推进一个相位" aria-label="推进一个相位" disabled={controlsDisabled || running} onClick={() => void runAction(onAdvancePhase)}><StepForward aria-hidden="true" /></button>
          <button type="button" className="icon-button" title="推进一个完整 Tick" aria-label="推进一个完整 Tick" disabled={controlsDisabled || running} onClick={() => void runAction(onTick)}><SkipForward aria-hidden="true" /></button>
          <button type="button" className="icon-button" title="清除波形历史" aria-label="清除波形历史" disabled={controlsDisabled || frames.length === 0} onClick={() => void runAction(onClear)}><Eraser aria-hidden="true" /></button>
          <label className="chronogram-select">
            <span className="visually-hidden">自动时钟速度</span>
            <select aria-label="自动时钟速度" value={rate} disabled={controlsDisabled} onChange={(event) => void runAction(() => onRateChange(Number(event.target.value) as AutoClockRate))}>
              {AUTO_CLOCK_RATES.map((item) => <option key={item} value={item}>{item} cyc/s</option>)}
            </select>
          </label>
          <label className="chronogram-select">
            <span className="visually-hidden">总线显示模式</span>
            <select aria-label="总线显示模式" value={displayMode} onChange={(event) => setDisplayMode(event.target.value as BusDisplayMode)}>
              <option value="balanced">平衡三进制</option>
              <option value="decimal">十进制</option>
              <option value="trits">逐 trit</option>
            </select>
          </label>
          <button type="button" className="icon-button chronogram-collapse" title={collapsed ? "展开时序图" : "折叠时序图"} aria-label={collapsed ? "展开时序图" : "折叠时序图"} onClick={() => setCollapsed((current) => !current)}>
            {collapsed ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>
        </div>
      </header>

      {!collapsed && (
        <div className="chronogram-body">
          <div className="chronogram-add-watch">
            <label>
              <span className="visually-hidden">可观察信号</span>
              <select aria-label="可观察信号" value={selectedSignalId} disabled={controlsDisabled || addableSignals.length === 0} onChange={(event) => setSelectedSignalId(event.target.value)}>
                {addableSignals.length === 0 && <option value="">无可添加信号</option>}
                {addableSignals.map((option) => <option key={option.id} value={option.id}>{option.label} [{option.width}t]</option>)}
              </select>
            </label>
            <button type="button" className="icon-button" title="添加观察信号" aria-label="添加观察信号" disabled={controlsDisabled || !selectedSignalId || watches.length >= MAX_WATCHES} onClick={addWatch}><Plus aria-hidden="true" /></button>
          </div>

          <div
            ref={viewportRef}
            className="chronogram-viewport"
            data-testid="chronogram-viewport"
            data-frame-count={frames.length}
            onScroll={handleScroll}
          >
            <div className="chronogram-scroll-content" style={{ width: `${LABEL_WIDTH + trackWidth}px`, height: `${Math.max(trackHeight, ROW_HEIGHT)}px` }}>
              <div className="chronogram-label-column" aria-label="观察信号">
                <div className="chronogram-label-heading">信号</div>
                <ol className="chronogram-watch-list">
                  {watches.map((watch, index) => {
                    const option = optionById.get(watch.id);
                    const label = option?.label ?? watch.id;
                    return (
                      <li key={watch.id} data-testid="chronogram-watch" data-watch-id={watch.id} className="chronogram-watch">
                        <span data-testid="watch-label" title={label}>{label}</span>
                        <code>{selectedValues.get(watch.id) ?? "-"}</code>
                        <button type="button" title={`上移 ${label}`} aria-label={`上移 ${label}`} disabled={controlsDisabled || index === 0} onClick={() => moveWatch(index, -1)}><ArrowUp aria-hidden="true" /></button>
                        <button type="button" title={`下移 ${label}`} aria-label={`下移 ${label}`} disabled={controlsDisabled || index === watches.length - 1} onClick={() => moveWatch(index, 1)}><ArrowDown aria-hidden="true" /></button>
                        <button type="button" title={`移除 ${label}`} aria-label={`移除 ${label}`} disabled={controlsDisabled} onClick={() => void replaceWatches(watches.filter((item) => item.id !== watch.id))}><Trash2 aria-hidden="true" /></button>
                      </li>
                    );
                  })}
                </ol>
              </div>
              <canvas
                ref={canvasRef}
                className="chronogram-canvas"
                role="img"
                aria-label="三进制时序波形"
                data-cell-count={projection.cellCount}
                data-scroll-top={scrollPosition.top}
                data-scroll-left={scrollPosition.left}
                style={{ left: `${LABEL_WIDTH + scrollPosition.left}px`, top: `${scrollPosition.top}px` }}
              />
            </div>
          </div>
          <input className="chronogram-cursor" type="range" min={0} max={Math.max(0, frames.length - 1)} value={Math.min(cursor, Math.max(0, frames.length - 1))} disabled={frames.length === 0} aria-label="时序图游标" onChange={(event) => moveCursor(Number(event.target.value))} />
          <output className="chronogram-cursor-values" data-testid="chronogram-cursor-values">
            {selectedFrame ? (
              <>
                <strong>周期 {selectedFrame.cycle}</strong>
                <span>{selectedFrame.clockPhase === "highStable" ? "HIGH" : "LOW"}</span>
                {watches.map((watch) => <span key={watch.id}>{optionById.get(watch.id)?.label ?? watch.id} {formatTraceWord(selectedValues.get(watch.id) ?? "-", displayMode)}</span>)}
              </>
            ) : <span>0 帧</span>}
          </output>
        </div>
      )}
    </section>
  );
}

function drawChronogramCanvas(
  canvas: HTMLCanvasElement,
  viewport: HTMLDivElement,
  projection: ChronogramProjection,
  frames: readonly TraceFrame[],
  cursor: number,
  scroll: ScrollPosition,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const cssWidth = Math.max(1, viewport.clientWidth - LABEL_WIDTH);
  const cssHeight = Math.max(1, viewport.clientHeight);
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.ceil(cssWidth * ratio);
  const pixelHeight = Math.ceil(cssHeight * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = "#fbfcfc";
  context.fillRect(0, 0, cssWidth, cssHeight);
  context.font = '8px "SFMono-Regular", Consolas, monospace';
  context.textBaseline = "middle";

  const firstFrame = Math.max(0, Math.floor(scroll.left / FRAME_WIDTH));
  const lastFrame = Math.min(frames.length, Math.ceil((scroll.left + cssWidth) / FRAME_WIDTH) + 1);
  for (let index = firstFrame; index < lastFrame; index += 1) {
    const x = index * FRAME_WIDTH - scroll.left;
    context.fillStyle = frames[index]?.reason === "fault" ? "#fff0f1" : "#f0f4f4";
    context.fillRect(x, -scroll.top, FRAME_WIDTH, RULER_HEIGHT);
    context.strokeStyle = "#dbe2e4";
    context.strokeRect(x, -scroll.top, FRAME_WIDTH, RULER_HEIGHT);
    context.fillStyle = frames[index]?.reason === "fault" ? "#a8202e" : "#718087";
    const phase = frames[index]?.clockPhase === "highStable" ? "H" : "L";
    context.fillText(`${frames[index]?.cycle ?? index}.${phase}`, x + 4, RULER_HEIGHT / 2 - scroll.top);
  }

  const firstRow = Math.max(0, Math.floor((scroll.top - RULER_HEIGHT) / ROW_HEIGHT));
  const lastRow = Math.min(projection.rows.length, Math.ceil((scroll.top + cssHeight - RULER_HEIGHT) / ROW_HEIGHT) + 1);
  for (let rowIndex = firstRow; rowIndex < lastRow; rowIndex += 1) {
    const row = projection.rows[rowIndex];
    const y = RULER_HEIGHT + rowIndex * ROW_HEIGHT - scroll.top;
    context.fillStyle = rowIndex % 2 ? "#fafcfc" : "#ffffff";
    context.fillRect(0, y, cssWidth, ROW_HEIGHT);
    context.strokeStyle = "#e2e7e9";
    context.beginPath();
    context.moveTo(0, y + ROW_HEIGHT - 0.5);
    context.lineTo(cssWidth, y + ROW_HEIGHT - 0.5);
    context.stroke();
    if (row.width === 1) drawScalarRow(context, row.segments, y, scroll.left, cssWidth);
    else drawBusRow(context, row.segments, y, scroll.left, cssWidth);
  }

  if (frames.length > 0) {
    const x = cursor * FRAME_WIDTH + FRAME_WIDTH / 2 - scroll.left;
    if (x >= 0 && x <= cssWidth) {
      context.strokeStyle = "#c82937";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, cssHeight);
      context.stroke();
    }
  }
}

function drawScalarRow(
  context: CanvasRenderingContext2D,
  segments: ChronogramProjection["rows"][number]["segments"],
  y: number,
  scrollLeft: number,
  width: number,
) {
  const levels = { "1": 7, "0": 17, T: 27 } as const;
  context.strokeStyle = "#edf1f2";
  for (const guide of [7, 17, 27]) {
    context.beginPath();
    context.moveTo(0, y + guide + 0.5);
    context.lineTo(width, y + guide + 0.5);
    context.stroke();
  }
  let previousLevel: number | null = null;
  for (const segment of segments) {
    const x = segment.start * FRAME_WIDTH - scrollLeft;
    const end = segment.end * FRAME_WIDTH - scrollLeft;
    if (end < 0 || x > width) continue;
    if (segment.value === "T" || segment.value === "0" || segment.value === "1") {
      const level = y + levels[segment.value];
      context.strokeStyle = "#276b63";
      context.lineWidth = 2;
      context.beginPath();
      if (previousLevel !== null) {
        context.moveTo(x, previousLevel);
        context.lineTo(x, level);
      } else context.moveTo(x, level);
      context.lineTo(end, level);
      context.stroke();
      previousLevel = level;
    } else {
      drawMetaBlock(context, segment.metaTrits[0] ?? { index: 0, symbol: "X" }, x, y + 6, end - x, 24);
      context.fillStyle = segment.value === "E" ? "#ffffff" : "#36464d";
      context.fillText(segment.value, Math.max(x + 4, 2), y + 18);
      previousLevel = null;
    }
  }
  context.lineWidth = 1;
}

function drawBusRow(
  context: CanvasRenderingContext2D,
  segments: ChronogramProjection["rows"][number]["segments"],
  y: number,
  scrollLeft: number,
  width: number,
) {
  for (const segment of segments) {
    const x = segment.start * FRAME_WIDTH - scrollLeft;
    const end = segment.end * FRAME_WIDTH - scrollLeft;
    if (end < 0 || x > width) continue;
    const bandX = Math.max(x, -1);
    const bandEnd = Math.min(end, width + 1);
    context.fillStyle = "#e9f4f1";
    context.fillRect(bandX, y + 6, bandEnd - bandX, 24);
    context.strokeStyle = "#66847f";
    context.strokeRect(bandX, y + 6, bandEnd - bandX, 24);
    drawMetaTrits(context, segment.metaTrits, segment.value.length, x, end, y + 6);
    context.fillStyle = "#264b47";
    context.fillText(segment.label, Math.max(x + 4, 2), y + 18);
  }
}

function drawMetaTrits(
  context: CanvasRenderingContext2D,
  metaTrits: readonly MetaTrit[],
  tritCount: number,
  start: number,
  end: number,
  y: number,
) {
  if (metaTrits.length === 0) return;
  const slotWidth = Math.max(7, Math.min(18, (end - start) / Math.max(1, tritCount)));
  for (const meta of metaTrits) {
    const x = start + meta.index * slotWidth;
    drawMetaBlock(context, meta, x, y, slotWidth, 24);
  }
}

function drawMetaBlock(
  context: CanvasRenderingContext2D,
  meta: MetaTrit,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const colors = { X: "#cbd4d7", Z: "#ead891", E: "#bb2938" } as const;
  context.fillStyle = colors[meta.symbol];
  context.fillRect(x, y, width, height);
  context.strokeStyle = meta.symbol === "E" ? "#7f1723" : "#7b8589";
  context.setLineDash(meta.symbol === "X" ? [3, 3] : meta.symbol === "Z" ? [1, 3] : []);
  context.beginPath();
  if (meta.symbol === "X") {
    context.moveTo(x, y + height);
    context.lineTo(x + width, y);
  } else if (meta.symbol === "Z") {
    context.moveTo(x + width / 2, y);
    context.lineTo(x + width / 2, y + height);
  } else {
    context.moveTo(x, y + height / 2);
    context.lineTo(x + width, y + height / 2);
  }
  context.stroke();
  context.setLineDash([]);
}

function clampHeight(value: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(value)));
}
