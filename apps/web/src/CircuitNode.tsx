import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Box,
  Boxes,
  CircleDot,
  Clock3,
  Gauge,
  PanelTop,
  Radio,
  Triangle,
  Workflow,
} from "lucide-react";
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
  const inputs = data.inputSignals ?? {};
  const outputs = data.outputSignals ?? {};
  const ports = data.ports ?? [];
  const inputPorts = ports.filter((port) => port.direction === "input");
  const outputPorts = ports.filter((port) => port.direction === "output");
  const registerWord =
    data.typeId === "project.module_instance" &&
    data.properties?.moduleId === "register3"
      ? `${outputs.q2 ?? "Z"}${outputs.q1 ?? "Z"}${outputs.q0 ?? "Z"}`
      : null;
  const primarySignal =
    data.typeId === "sink.probe" || data.typeId === "project.module_output"
      ? inputs.in ?? "Z"
      : data.typeId === "sequential.dff"
        ? outputs.q ?? "Z"
        : registerWord
          ? outputs.q2 ?? "Z"
          : outputs.out ?? outputs.y ?? outputs.sum ?? data.sourceValue ?? "Z";
  const displaySignal = registerWord ?? primarySignal;

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
      style={{ "--signal-color": SIGNAL_COLORS[primarySignal] } as React.CSSProperties}
    >
      <div className="node-heading">
        <ComponentIcon typeId={data.typeId} />
        <span>{data.label}</span>
      </div>
      <strong className="node-signal" aria-label={`信号 ${displaySignal}`}>
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
              id={port.id}
              data-testid={`handle-${id}-input-${port.id}`}
              type="target"
              position={Position.Left}
              style={{ backgroundColor: SIGNAL_COLORS[signal] }}
            />
            <span>{"label" in port ? String(port.label) : port.id}</span>
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
            <span>{"label" in port ? String(port.label) : port.id}</span>
            <Handle
              id={port.id}
              data-testid={`handle-${id}-output-${port.id}`}
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
