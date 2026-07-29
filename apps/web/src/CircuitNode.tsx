import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Box, CircleDot, Gauge, Radio, Triangle, Workflow } from "lucide-react";
import type {
  CatalogPort,
  EditorNode,
  TritSymbol,
} from "./editor-model";

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
  inputs: Record<string, TritSymbol>,
  outputs: Record<string, TritSymbol>,
): TritSymbol {
  return port.direction === "input"
    ? inputs[port.id] ?? "Z"
    : outputs[port.id] ?? "Z";
}

function ComponentIcon({ typeId }: { typeId: string }) {
  if (typeId === "source.trit_input") {
    return <Radio aria-hidden="true" />;
  }
  if (typeId === "source.constant") {
    return <Box aria-hidden="true" />;
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
  data,
  selected,
}: NodeProps<EditorNode>) {
  const inputs = data.inputSignals ?? {};
  const outputs = data.outputSignals ?? {};
  const ports = data.ports ?? [];
  const inputPorts = ports.filter((port) => port.direction === "input");
  const outputPorts = ports.filter((port) => port.direction === "output");
  const primarySignal =
    data.typeId === "sink.probe"
      ? inputs.in ?? "Z"
      : outputs.out ?? outputs.y ?? outputs.sum ?? data.sourceValue ?? "Z";

  return (
    <div
      className={`circuit-node signal-${primarySignal} ${
        selected ? "is-selected" : ""
      }`}
      style={{ "--signal-color": SIGNAL_COLORS[primarySignal] } as React.CSSProperties}
    >
      <div className="node-heading">
        <ComponentIcon typeId={data.typeId} />
        <span>{data.label}</span>
      </div>
      <strong className="node-signal" aria-label={`信号 ${primarySignal}`}>
        {primarySignal}
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
              id={port.id}
              type="target"
              position={Position.Left}
              style={{ backgroundColor: SIGNAL_COLORS[signal] }}
            />
            <span>{port.id}</span>
            <b style={{ color: SIGNAL_COLORS[signal] }}>{signal}</b>
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
            <b style={{ color: SIGNAL_COLORS[signal] }}>{signal}</b>
            <span>{port.id}</span>
            <Handle
              id={port.id}
              type="source"
              position={Position.Right}
              style={{ backgroundColor: SIGNAL_COLORS[signal] }}
            />
          </div>
        );
      })}
    </div>
  );
}

export { SIGNAL_COLORS };
