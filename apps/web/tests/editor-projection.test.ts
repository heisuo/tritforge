import { describe, expect, it } from "vitest";
import type { ProjectSimulationSnapshot } from "../src/editor-model";
import { edgeNetValue, projectToEditor } from "../src/project/editor-projection";
import type { ProjectCircuitV3 } from "../src/project/project-v3";

const circuit: ProjectCircuitV3 = {
  id: "main",
  name: "Main",
  kind: "main",
  components: [
    {
      id: "z-source",
      typeId: "source.constant",
      position: { x: 0, y: 0 },
      properties: { value: "1" },
    },
    {
      id: "a-probe",
      typeId: "sink.probe",
      position: { x: 200, y: 0 },
      properties: {},
    },
  ],
  wires: [
    {
      id: "wire-1",
      endpointA: { componentId: "a-probe", portId: "in" },
      endpointB: { componentId: "z-source", portId: "out" },
    },
  ],
};

describe("v3 editor projection", () => {
  it("orients lexically normalized endpoints by resolved Rust port direction", () => {
    const editor = projectToEditor(circuit, (componentId) =>
      componentId === "z-source"
        ? [{ id: "out", direction: "output", width: 1 }]
        : [{ id: "in", direction: "input", width: 1 }],
    );

    expect(editor.edges[0]).toMatchObject({
      source: "z-source",
      sourceHandle: "out",
      target: "a-probe",
      targetHandle: "in",
    });
  });

  it("labels a wire from the resolved net instead of the raw driver", () => {
    const editor = projectToEditor(circuit, (componentId) =>
      componentId === "z-source"
        ? [{ id: "out", direction: "output", width: 1 }]
        : [{ id: "in", direction: "input", width: 1 }],
    );
    const snapshot: ProjectSimulationSnapshot = {
      componentOutputs: { "z-source": { out: "1" } },
      inputNets: { "a-probe": { in: "E" } },
      componentOutputWords: { "z-source": { out: "1" } },
      inputNetWords: { "a-probe": { in: "E" } },
      diagnostics: [],
      stable: true,
      tickCount: 0,
      compileCount: 1,
    };

    expect(edgeNetValue(editor.edges[0], snapshot)).toBe("E");
  });
});
