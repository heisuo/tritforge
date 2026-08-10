import { describe, expect, it, vi } from "vitest";
import type { ProjectSimulationSnapshot } from "../src/editor-model";
import { editorHandleId } from "../src/editor/port-handles";
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
      sourceHandle: editorHandleId("out", "source"),
      target: "a-probe",
      targetHandle: editorHandleId("in", "target"),
      data: {
        semanticSourcePortId: "out",
        semanticTargetPortId: "in",
      },
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

  it("projects imported input-input and output-output wires onto their exact ports", () => {
    const sameDirection: ProjectCircuitV3 = {
      ...circuit,
      components: [
        ...circuit.components,
        {
          id: "b-probe",
          typeId: "sink.probe",
          position: { x: 200, y: 100 },
          properties: {},
        },
        {
          id: "y-source",
          typeId: "source.constant",
          position: { x: 0, y: 100 },
          properties: { value: "0" },
        },
      ],
      wires: [
        {
          id: "input-input",
          endpointA: { componentId: "b-probe", portId: "in" },
          endpointB: { componentId: "a-probe", portId: "in" },
        },
        {
          id: "output-output",
          endpointA: { componentId: "z-source", portId: "out" },
          endpointB: { componentId: "y-source", portId: "out" },
        },
      ],
    };
    const editor = projectToEditor(sameDirection, (componentId) =>
      componentId.endsWith("probe")
        ? [{ id: "in", direction: "input", width: 1 }]
        : [{ id: "out", direction: "output", width: 1 }],
    );

    expect(editor.edges).toEqual([
      expect.objectContaining({
        id: "input-input",
        source: "a-probe",
        sourceHandle: editorHandleId("in", "source"),
        target: "b-probe",
        targetHandle: editorHandleId("in", "target"),
      }),
      expect.objectContaining({
        id: "output-output",
        source: "y-source",
        sourceHandle: editorHandleId("out", "source"),
        target: "z-source",
        targetHandle: editorHandleId("out", "target"),
      }),
    ]);
  });

  it("builds the component port index once for a large projection", () => {
    const componentCount = 40;
    const wireCount = 80;
    const largeCircuit: ProjectCircuitV3 = {
      id: "large",
      name: "Large",
      kind: "main",
      components: Array.from({ length: componentCount }, (_, index) => ({
        id: `node-${index}`,
        typeId: "wiring.junction",
        position: { x: index * 10, y: 0 },
        properties: {},
      })),
      wires: Array.from({ length: wireCount }, (_, index) => ({
        id: `wire-${index}`,
        endpointA: {
          componentId: `node-${index % componentCount}`,
          portId: "net",
        },
        endpointB: {
          componentId: `node-${(index + 1) % componentCount}`,
          portId: "net",
        },
      })),
    };
    const NativeMap = Map;
    let mapConstructions = 0;
    class CountingMap<K, V> extends NativeMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        super(entries);
        mapConstructions += 1;
      }
    }
    vi.stubGlobal("Map", CountingMap);
    try {
      const editor = projectToEditor(largeCircuit, () => [
        { id: "net", direction: "inout", width: 1 },
      ]);
      expect(editor.edges).toHaveLength(wireCount);
      expect(mapConstructions).toBeLessThanOrEqual(componentCount + 2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
