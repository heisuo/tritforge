import { describe, expect, it } from "vitest";
import {
  createEmptyCircuitDocument,
  fromEditorDocument,
  parseCircuitDocument,
  serializeCircuitDocument,
  toEditorDocument,
} from "../src/editor/circuit-document";
import { editorHandleId } from "../src/editor/port-handles";
import { createDefaultDocument } from "../src/editor-model";

describe("versioned circuit documents", () => {
  it("round-trips editor components, connections, and source values", () => {
    const editor = createDefaultDocument();
    const document = fromEditorDocument(editor, { x: 12, y: -8, zoom: 1.25 });

    expect(document).toMatchObject({
      format: "logsim-ternary",
      version: 1,
      viewport: { x: 12, y: -8, zoom: 1.25 },
    });
    expect(toEditorDocument(parseCircuitDocument(serializeCircuitDocument(document))))
      .toEqual(editor);
  });

  it("stores semantic port IDs instead of role-specific editor handle IDs", () => {
    const editor = createDefaultDocument();
    editor.nodes[0].data.ports = [
      { id: "out", direction: "output", width: 1 },
    ];
    editor.nodes[1].data.ports = [
      { id: "a", direction: "input", width: 1 },
      { id: "y", direction: "output", width: 1 },
    ];
    editor.edges[0].sourceHandle = editorHandleId("out", "source");
    editor.edges[0].targetHandle = editorHandleId("a", "target");

    expect(fromEditorDocument(editor).connections[0]).toMatchObject({
      sourcePortId: "out",
      targetPortId: "a",
    });
  });

  it("rejects unsupported versions and unknown top-level properties", () => {
    expect(() =>
      parseCircuitDocument(
        JSON.stringify({ ...createEmptyCircuitDocument(), version: 2 }),
      ),
    ).toThrow(/version/i);
    expect(() =>
      parseCircuitDocument(
        JSON.stringify({ ...createEmptyCircuitDocument(), surprise: true }),
      ),
    ).toThrow(/surprise/i);
  });

  it("accepts the frozen v1 shape and preserves extensible properties", () => {
    const document = parseCircuitDocument(JSON.stringify({
      format: "logsim-ternary",
      version: 1,
      components: [
        {
          id: "input-1",
          typeId: "source.trit_input",
          position: { x: 10, y: 20 },
          properties: { value: "T", note: "teaching input" },
        },
        {
          id: "probe-1",
          typeId: "sink.probe",
          position: { x: 300, y: 20 },
          properties: {},
        },
      ],
      connections: [
        {
          id: "wire-1",
          sourceComponentId: "input-1",
          sourcePortId: "out",
          targetComponentId: "probe-1",
          targetPortId: "in",
        },
      ],
    }));

    expect(document.components[0].properties.note).toBe("teaching input");
    expect(document.connections[0].targetComponentId).toBe("probe-1");
  });

  it("preserves known multi-trit words in the legacy editor document adapter", () => {
    const document = parseCircuitDocument(JSON.stringify({
      ...createEmptyCircuitDocument(),
      components: [
        {
          id: "word",
          typeId: "source.trit_input",
          position: { x: 0, y: 0 },
          properties: { value: "1T0", width: 3 },
        },
      ],
    }));

    expect(toEditorDocument(document).nodes[0].data.sourceValue).toBe("1T0");
  });

  it("rejects a non-positive viewport zoom", () => {
    expect(() =>
      parseCircuitDocument(JSON.stringify({
        ...createEmptyCircuitDocument(),
        viewport: { x: 0, y: 0, zoom: -1 },
      })),
    ).toThrow(/zoom/i);
  });

  it("rejects invalid reserved properties while allowing extension keys", () => {
    const base = {
      id: "gate-1",
      typeId: "gate.buf",
      position: { x: 0, y: 0 },
    };
    expect(() =>
      parseCircuitDocument(JSON.stringify({
        ...createEmptyCircuitDocument(),
        components: [{ ...base, properties: { value: 2 } }],
      })),
    ).toThrow(/properties\.value/i);
    expect(() =>
      parseCircuitDocument(JSON.stringify({
        ...createEmptyCircuitDocument(),
        components: [{ ...base, properties: { label: 42 } }],
      })),
    ).toThrow(/properties\.label/i);
  });
});
