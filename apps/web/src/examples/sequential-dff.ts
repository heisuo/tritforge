import type {
  ProjectCircuit,
  ProjectDocumentV2,
} from "../project/project-document";

type Component = ProjectCircuit["components"][number];
type Connection = ProjectCircuit["connections"][number];

function component(
  id: string,
  typeId: string,
  x: number,
  y: number,
  properties: Record<string, unknown>,
): Component {
  return { id, typeId, position: { x, y }, properties };
}

function connection(
  id: string,
  sourceComponentId: string,
  sourcePortId: string,
  targetComponentId: string,
  targetPortId: string,
): Connection {
  return {
    id,
    sourceComponentId,
    sourcePortId,
    targetComponentId,
    targetPortId,
  };
}

const SEQUENTIAL_DFF_PROJECT: ProjectDocumentV2 = {
  format: "logsim-ternary",
  version: 2,
  rootCircuitId: "main",
  circuits: [
    {
      id: "main",
      name: "单 trit DFF",
      kind: "main",
      components: [
        component("input-d", "source.trit_input", 60, 120, {
          value: "1",
          label: "D 输入",
        }),
        component("clock-1", "source.clock", 60, 300, {
          label: "Clock",
        }),
        component("input-en", "source.trit_input", 60, 480, {
          value: "1",
          label: "EN 输入",
        }),
        component("input-rst", "source.trit_input", 60, 660, {
          value: "0",
          label: "RST 输入",
        }),
        component("dff-1", "sequential.dff", 430, 300, {
          label: "DFF",
        }),
        component("probe-q", "sink.probe", 780, 300, {
          label: "Q Probe",
        }),
      ],
      connections: [
        connection("d-to-dff", "input-d", "out", "dff-1", "d"),
        connection("clock-to-dff", "clock-1", "out", "dff-1", "clk"),
        connection("en-to-dff", "input-en", "out", "dff-1", "en"),
        connection("rst-to-dff", "input-rst", "out", "dff-1", "rst"),
        connection("q-to-probe", "dff-1", "q", "probe-q", "in"),
      ],
      viewport: { x: 25, y: 20, zoom: 0.82 },
    },
  ],
};

export function cloneSequentialDffProject(): ProjectDocumentV2 {
  return structuredClone(SEQUENTIAL_DFF_PROJECT);
}
