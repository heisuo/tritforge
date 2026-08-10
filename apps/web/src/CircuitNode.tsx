import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Box,
  Boxes,
  Cable,
  CircleDot,
  Clock3,
  Gauge,
  GitFork,
  PanelTop,
  Radio,
  Triangle,
  Workflow,
} from "lucide-react";
import type {
  CatalogPort,
  EditorNode,
  TernaryWord,
  TritSymbol,
} from "./editor-model";
import { editorHandleId } from "./editor/port-handles";

const SIGNAL_COLORS: Record<TritSymbol, string> = {
  T: "#246b9a",
  "0": "#64717d",
  "1": "#b53b3f",
  X: "#7b5794",
  Z: "#8b969e",
  E: "#c32231",
};

function signalForPort(
  port: CatalogPort,
  inputs: Record<string, TernaryWord>,
  outputs: Record<string, TernaryWord>,
): TernaryWord {
  return port.direction !== "output"
    ? inputs[port.id] ?? "Z"
    : outputs[port.id] ?? "Z";
}

function signalColor(value: TernaryWord): string {
  if (isTritSymbol(value)) return SIGNAL_COLORS[value];
  if (value.includes("E")) return SIGNAL_COLORS.E;
  if (value.includes("X")) return SIGNAL_COLORS.X;
  if (value.includes("Z")) return SIGNAL_COLORS.Z;
  return "#315f66";
}

function signalFontSize(value: TernaryWord, large = false): number {
  if (large) {
    if (value.length > 24) return 7;
    if (value.length > 18) return 8;
    if (value.length > 9) return 13;
    if (value.length > 6) return 17;
    if (value.length > 3) return 22;
    return 31;
  }
  if (value.length > 18) return 6;
  if (value.length > 9) return 7;
  return 9;
}

function signalLengthClass(value: TernaryWord): string {
  if (value.length > 24) return "signal-length-27";
  if (value.length > 18) return "signal-length-long";
  if (value.length > 9) return "signal-length-medium";
  return "signal-length-short";
}

function ComponentIcon({ typeId }: { typeId: string }) {
  if (typeId === "project.module_instance") {
    return <Boxes aria-hidden="true" />;
  }
  if (typeId === "project.module_input") {
    return <Radio aria-hidden="true" />;
  }
  if (typeId === "project.module_output") {
    return <Gauge aria-hidden="true" />;
  }
  if (typeId === "source.trit_input") {
    return <Radio aria-hidden="true" />;
  }
  if (typeId === "source.constant") {
    return <Box aria-hidden="true" />;
  }
  if (typeId === "source.clock") {
    return <Clock3 aria-hidden="true" />;
  }
  if (typeId === "sequential.dff") {
    return <PanelTop aria-hidden="true" />;
  }
  if (typeId === "sink.probe") {
    return <Gauge aria-hidden="true" />;
  }
  if (typeId.includes("mux")) {
    return <Triangle aria-hidden="true" />;
  }
  if (typeId.startsWith("module.")) {
    return <Workflow aria-hidden="true" />;
  }
  return <CircleDot aria-hidden="true" />;
}

export function CircuitNode({
  id,
  data,
  selected,
}: NodeProps<EditorNode>) {
  const inputs: Record<string, TernaryWord> = {
    ...(data.inputSignals ?? {}),
    ...(data.inputWords ?? {}),
  };
  const outputs: Record<string, TernaryWord> = {
    ...(data.outputSignals ?? {}),
    ...(data.outputWords ?? {}),
  };
  const ports = data.ports ?? [];
  if (data.typeId.startsWith("wiring.")) {
    return (
      <WiringNode
        id={id}
        typeId={data.typeId}
        label={data.label}
        properties={data.properties ?? {}}
        ports={ports}
        inputs={inputs}
        outputs={outputs}
        selected={selected}
      />
    );
  }
  const inputPorts = ports.filter((port) => port.direction !== "output");
  const outputPorts = ports.filter((port) => port.direction !== "input");
  const registerWord =
    data.typeId === "project.module_instance" &&
    data.properties?.moduleId === "register3"
      ? `${outputs.q2 ?? "Z"}${outputs.q1 ?? "Z"}${outputs.q0 ?? "Z"}`
      : null;
  const displaySignal =
    data.typeId === "sink.probe" || data.typeId === "project.module_output"
      ? inputs.in ?? "Z"
      : data.typeId === "sequential.dff"
        ? outputs.q ?? "Z"
        : registerWord
          ? registerWord
          : outputs.out ?? outputs.y ?? outputs.sum ?? data.sourceValue ?? "Z";
  const primarySignal: TritSymbol = isTritSymbol(displaySignal) ? displaySignal : "X";

  return (
    <div
      className={`circuit-node signal-${primarySignal} ${
        data.typeId.startsWith("project.module_") ? "is-project-node" : ""
      } ${
        data.typeId === "source.clock" || data.typeId === "sequential.dff"
          ? "is-sequential-node"
          : ""
      } ${
        selected ? "is-selected" : ""
      }`}
      style={{ "--signal-color": signalColor(displaySignal) } as React.CSSProperties}
    >
      <div className="node-heading">
        <ComponentIcon typeId={data.typeId} />
        <span>{data.label}</span>
      </div>
      <strong
        className={`node-signal ${signalLengthClass(displaySignal)}`}
        aria-label={`信号 ${displaySignal}`}
        style={{ fontSize: signalFontSize(displaySignal, true) }}
      >
        {displaySignal}
      </strong>
      <div className="node-id">{data.typeId}</div>

      {inputPorts.map((port, index) => {
        const signal = signalForPort(port, inputs, outputs);
        return (
          <div
            className="port-row port-row-input"
            key={port.id}
            style={{
              top: `${((index + 1) / (inputPorts.length + 1)) * 100}%`,
            }}
          >
            <Handle
              id={editorHandleId(port.id, "target")}
              data-testid={`handle-${id}-input-${port.id}`}
              type="target"
              position={Position.Left}
              style={{ backgroundColor: signalColor(signal) }}
            />
            {port.direction === "input" && (
              <Handle
                id={editorHandleId(port.id, "source")}
                data-testid={`handle-${id}-output-${port.id}`}
                type="source"
                position={Position.Left}
                style={{
                  backgroundColor: signalColor(signal),
                  opacity: 0,
                  pointerEvents: "none",
                }}
              />
            )}
            <span>{"label" in port ? String(port.label) : port.id}</span>
            <small>{port.width}t</small>
            <b style={{ color: signalColor(signal), fontSize: signalFontSize(signal) }}>{signal}</b>
          </div>
        );
      })}

      {outputPorts.map((port, index) => {
        const signal = signalForPort(port, inputs, outputs);
        return (
          <div
            className="port-row port-row-output"
            key={port.id}
            style={{
              top: `${((index + 1) / (outputPorts.length + 1)) * 100}%`,
            }}
          >
            <b style={{ color: signalColor(signal), fontSize: signalFontSize(signal) }}>{signal}</b>
            <small>{port.width}t</small>
            <span>{"label" in port ? String(port.label) : port.id}</span>
            <Handle
              id={editorHandleId(port.id, "source")}
              data-testid={`handle-${id}-output-${port.id}`}
              type="source"
              position={Position.Right}
              style={{ backgroundColor: signalColor(signal) }}
            />
            {port.direction === "output" && (
              <Handle
                id={editorHandleId(port.id, "target")}
                data-testid={`handle-${id}-input-${port.id}`}
                type="target"
                position={Position.Right}
                style={{
                  backgroundColor: signalColor(signal),
                  opacity: 0,
                  pointerEvents: "none",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface WiringNodeProps {
  id: string;
  typeId: string;
  label: string;
  properties: Record<string, unknown>;
  ports: CatalogPort[];
  inputs: Record<string, TernaryWord>;
  outputs: Record<string, TernaryWord>;
  selected: boolean;
}

function InOutPort({
  nodeId,
  port,
  position,
  signal,
}: {
  nodeId: string;
  port: CatalogPort;
  position: Position;
  signal: TernaryWord;
}) {
  const name = "label" in port ? String(port.label) : port.id;
  const accessibleName = `${name}，双向，${port.width} trit`;
  return (
    <>
      <Handle
        id={editorHandleId(port.id, "target")}
        data-testid={`handle-${nodeId}-input-${port.id}`}
        type="target"
        position={position}
        aria-label={accessibleName}
        title={accessibleName}
        style={{ backgroundColor: signalColor(signal) }}
      />
      <Handle
        id={editorHandleId(port.id, "source")}
        data-testid={`handle-${nodeId}-output-${port.id}`}
        type="source"
        position={position}
        aria-label={accessibleName}
        title={accessibleName}
        style={{ backgroundColor: signalColor(signal) }}
      />
    </>
  );
}

function WiringNode({
  id,
  typeId,
  label,
  properties,
  ports,
  inputs,
  outputs,
  selected,
}: WiringNodeProps) {
  const signal = (port: CatalogPort) => signalForPort(port, inputs, outputs);
  const trunk = ports.find((port) => port.id === "trunk");
  const branches = ports.filter((port) => port.id.startsWith("branch"));
  const net = ports.find((port) => port.id === "net");
  const width = trunk?.width ?? net?.width ?? 1;

  if (typeId === "wiring.junction" && net) {
    const value = signal(net);
    return (
      <div
        className={`wiring-junction ${selected ? "is-selected" : ""}`}
        style={{ "--signal-color": signalColor(value) } as React.CSSProperties}
        aria-label={`${label} ${width}t ${value}`}
      >
        <InOutPort nodeId={id} port={net} position={Position.Left} signal={value} />
        <span className="junction-dot" />
        <span className="wiring-width">{width}t</span>
      </div>
    );
  }

  if (typeId === "wiring.tunnel" && net) {
    const value = signal(net);
    const tunnelLabel = String(properties.label ?? label);
    return (
      <div
        className={`wiring-tunnel ${selected ? "is-selected" : ""}`}
        style={{
          "--signal-color": signalColor(value),
          width: `${Math.max(116, 96 + width * 4)}px`,
        } as React.CSSProperties}
      >
        <InOutPort nodeId={id} port={net} position={Position.Left} signal={value} />
        <Cable aria-hidden="true" />
        <strong>{tunnelLabel}</strong>
        <span>{width}t</span>
        <b style={{ fontSize: signalFontSize(value) }}>{value}</b>
      </div>
    );
  }

  const branchTop = 38;
  const branchGap = 20;
  const splitterHeight = Math.max(
    126,
    70 + Math.max(0, branches.length - 1) * branchGap,
  );
  const splitterWidth = width > 9 ? 190 + width * 4 : 178;
  const trunkTop =
    branchTop + (Math.max(0, branches.length - 1) * branchGap) / 2;

  return (
    <div
      className={`wiring-splitter ${selected ? "is-selected" : ""}`}
      style={{ height: splitterHeight, width: splitterWidth }}
    >
      <div className="splitter-title">
        <GitFork aria-hidden="true" />
        <strong>{label}</strong>
      </div>
      {trunk && (
        <div className="splitter-trunk" style={{ top: trunkTop }}>
          <InOutPort
            nodeId={id}
            port={trunk}
            position={Position.Left}
            signal={signal(trunk)}
          />
          <span>trunk</span>
          <small>{trunk.width}t</small>
          <b style={{ fontSize: signalFontSize(signal(trunk)) }}>{signal(trunk)}</b>
        </div>
      )}
      <div className="splitter-bar" />
      {branches.map((port, index) => (
        <div
          className="splitter-branch"
          key={port.id}
          style={{ top: branchTop + index * branchGap }}
        >
          <b style={{ fontSize: signalFontSize(signal(port)) }}>{signal(port)}</b>
          <small>{port.width}t</small>
          <span>{port.id}</span>
          <InOutPort
            nodeId={id}
            port={port}
            position={Position.Right}
            signal={signal(port)}
          />
        </div>
      ))}
      <code>{Array.isArray(properties.mapping) ? properties.mapping.join("·") : ""}</code>
    </div>
  );
}

function isTritSymbol(value: string): value is TritSymbol {
  return value === "T" || value === "0" || value === "1" || value === "X" || value === "Z" || value === "E";
}

export { SIGNAL_COLORS };
