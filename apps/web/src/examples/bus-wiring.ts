import type {
  ProjectCircuitV3,
  ProjectDocumentV3,
  ProjectWire,
} from "../project/project-v3";

type Component = ProjectCircuitV3["components"][number];

function component(
  id: string,
  typeId: string,
  x: number,
  y: number,
  properties: Record<string, unknown>,
): Component {
  return { id, typeId, position: { x, y }, properties };
}

function wire(
  id: string,
  componentA: string,
  portA: string,
  componentB: string,
  portB: string,
): ProjectWire {
  return {
    id,
    endpointA: { componentId: componentA, portId: portA },
    endpointB: { componentId: componentB, portId: portB },
  };
}

const main: ProjectCircuitV3 = {
  id: "main",
  name: "3-trit Bus and Local Tunnel",
  kind: "main",
  components: [
    component("word-input", "source.trit_input", 0, 280, {
      label: "三位输入",
      value: "1T0",
      width: 3,
    }),
    component("split-word", "wiring.splitter", 250, 250, {
      label: "拆分总线",
      width: 3,
      branchCount: 3,
      mapping: [0, 1, 2],
    }),
    component("lst-junction", "wiring.junction", 460, 75, {
      label: "LST 扇出",
      width: 1,
    }),
    component("probe-lst", "sink.probe", 670, 35, {
      label: "branch0 / LST",
      width: 1,
    }),
    component("tunnel-send", "wiring.tunnel", 550, 500, {
      label: "DATA_MID",
      width: 1,
    }),
    component("tunnel-receive", "wiring.tunnel", 520, 170, {
      label: "DATA_MID",
      width: 1,
    }),
    component("probe-mid", "sink.probe", 730, 505, {
      label: "branch1",
      width: 1,
    }),
    component("probe-mst", "sink.probe", 590, 650, {
      label: "branch2 / MST",
      width: 1,
    }),
    component("join-word", "wiring.splitter", 830, 255, {
      label: "重组三位总线",
      width: 3,
      branchCount: 3,
      mapping: [0, 1, 2],
    }),
    component("probe-word", "sink.probe", 1060, 95, {
      label: "重组输出",
      width: 3,
    }),
  ],
  wires: [
    wire("word-to-split", "word-input", "out", "split-word", "trunk"),
    wire(
      "branch0-to-junction",
      "split-word",
      "branch0",
      "lst-junction",
      "net",
    ),
    wire(
      "junction-to-lst-probe",
      "lst-junction",
      "net",
      "probe-lst",
      "in",
    ),
    wire(
      "junction-to-join",
      "lst-junction",
      "net",
      "join-word",
      "branch0",
    ),
    wire(
      "branch1-to-tunnel",
      "split-word",
      "branch1",
      "tunnel-send",
      "net",
    ),
    wire(
      "tunnel-to-join",
      "tunnel-receive",
      "net",
      "join-word",
      "branch1",
    ),
    wire(
      "tunnel-to-mid-probe",
      "tunnel-receive",
      "net",
      "probe-mid",
      "in",
    ),
    wire(
      "branch2-to-join",
      "split-word",
      "branch2",
      "join-word",
      "branch2",
    ),
    wire(
      "branch2-to-mst-probe",
      "split-word",
      "branch2",
      "probe-mst",
      "in",
    ),
    wire(
      "join-to-word-probe",
      "join-word",
      "trunk",
      "probe-word",
      "in",
    ),
  ],
  viewport: { x: 85, y: 95, zoom: 0.62 },
};

export const BUS_WIRING_PROJECT: ProjectDocumentV3 = {
  format: "logsim-ternary",
  version: 3,
  rootCircuitId: "main",
  circuits: [main],
};

export function cloneBusWiringProject(): ProjectDocumentV3 {
  return structuredClone(BUS_WIRING_PROJECT);
}
