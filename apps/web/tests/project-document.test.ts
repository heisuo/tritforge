import { describe, expect, it } from "vitest";
import {
  createEmptyCircuitDocument,
  serializeCircuitDocument,
  type CircuitDocument,
} from "../src/editor/circuit-document";
import {
  migrateV1ToV2,
  parseProjectDocument,
  parseProjectDocumentV2,
  serializeProjectDocument,
  serializeProjectDocumentV2,
  type ProjectDocumentV2,
} from "../src/project/project-document";

function component(
  id: string,
  typeId = "gate.buf",
  properties: Record<string, unknown> = {},
) {
  return { id, typeId, position: { x: 0, y: 0 }, properties };
}

function emptyProject(): ProjectDocumentV2 {
  return {
    format: "logsim-ternary",
    version: 2,
    rootCircuitId: "main",
    circuits: [
      {
        id: "main",
        name: "Main",
        kind: "main",
        components: [],
        connections: [],
      },
    ],
  };
}

describe("project document v2", () => {
  it("migrates a v1 circuit into the main project without rewriting content", () => {
    const v1: CircuitDocument = {
      ...createEmptyCircuitDocument(),
      components: [
        component("ordinary", "gate.buf", {
          moduleId: 123,
          portId: false,
          nested: { note: "keep me" },
        }),
      ],
      viewport: { x: 12, y: -8, zoom: 1.25 },
    };

    const migrated = parseProjectDocumentV2(serializeCircuitDocument(v1));

    expect(migrated).toMatchObject({
      format: "logsim-ternary",
      version: 2,
      rootCircuitId: "main",
      circuits: [{ id: "main", name: "Main", kind: "main" }],
    });
    expect(migrated.circuits[0].components).toEqual(v1.components);
    expect(migrated.circuits[0].connections).toEqual(v1.connections);
    expect(migrated.circuits[0].viewport).toEqual(v1.viewport);
  });

  it("deep-clones v1 extension properties during pure migration", () => {
    const v1: CircuitDocument = {
      ...createEmptyCircuitDocument(),
      components: [component("ordinary", "gate.buf", { nested: { count: 1 } })],
    };

    const migrated = migrateV1ToV2(v1);
    const nested = migrated.circuits[0].components[0].properties.nested as {
      count: number;
    };
    nested.count = 2;

    expect(v1.components[0].properties.nested).toEqual({ count: 1 });
  });

  it("can re-read a migrated v1 document containing legacy whitespace strings", () => {
    const v1: CircuitDocument = {
      ...createEmptyCircuitDocument(),
      components: [component(" ", "gate.buf", { label: " " })],
    };

    const migrated = parseProjectDocumentV2(serializeCircuitDocument(v1));

    expect(parseProjectDocumentV2(serializeProjectDocumentV2(migrated))).toEqual(
      migrated,
    );
  });

  it("round-trips module components and ordinary extension properties", () => {
    const project: ProjectDocumentV2 = {
      ...emptyProject(),
      circuits: [
        emptyProject().circuits[0],
        {
          id: "identity",
          name: "Identity",
          kind: "module",
          components: [
            component("in", "project.module_input", {
              portId: "a",
              label: "A",
              previewValue: "T",
            }),
            component("out", "project.module_output", {
              portId: "y",
              label: "Y",
            }),
            component("ordinary", "gate.buf", {
              moduleId: 123,
              portId: false,
            }),
          ],
          connections: [],
          viewport: { x: 1, y: 2, zoom: 0.75 },
        },
      ],
    };

    expect(parseProjectDocumentV2(serializeProjectDocumentV2(project))).toEqual(project);
  });

  it.each([
    [
      "project.module_input",
      { portId: 3, label: "A", previewValue: "0" },
      /portId/i,
    ],
    ["project.module_input", { portId: "a", label: "A", previewValue: "X" }, /previewValue/i],
    ["project.module_output", { portId: "y", label: false }, /label/i],
    ["project.module_instance", { moduleId: false, label: "U1" }, /moduleId/i],
  ])("rejects malformed %s properties", (typeId, properties, message) => {
    const project = emptyProject();
    project.circuits[0].components = [component("bad", typeId, properties)];

    expect(() => parseProjectDocumentV2(JSON.stringify(project))).toThrow(message);
  });

  it("rejects multiple main circuits and duplicate circuit IDs", () => {
    const twoMains = emptyProject();
    twoMains.circuits.push({
      ...twoMains.circuits[0],
      id: "other-main",
      name: "Other Main",
    });
    expect(() => parseProjectDocumentV2(JSON.stringify(twoMains))).toThrow(/main/i);

    const duplicate = emptyProject();
    duplicate.circuits.push({
      ...duplicate.circuits[0],
      kind: "module",
    });
    expect(() => parseProjectDocumentV2(JSON.stringify(duplicate))).toThrow(/duplicate/i);
  });

  it("rejects invalid circuit viewport zoom and unknown top-level keys", () => {
    const invalidZoom = emptyProject();
    invalidZoom.circuits[0].viewport = { x: 0, y: 0, zoom: 0 };
    expect(() => parseProjectDocumentV2(JSON.stringify(invalidZoom))).toThrow(/zoom/i);

    expect(() =>
      parseProjectDocumentV2(
        JSON.stringify({ ...emptyProject(), unexpected: true }),
      ),
    ).toThrow(/unexpected/i);
  });

  it("rejects duplicate component and connection IDs inside a circuit", () => {
    const duplicateComponents = emptyProject();
    duplicateComponents.circuits[0].components = [
      component("same"),
      component("same"),
    ];
    expect(() => parseProjectDocumentV2(JSON.stringify(duplicateComponents))).toThrow(
      /duplicate component/i,
    );

    const duplicateConnections = emptyProject();
    duplicateConnections.circuits[0].components = [component("a"), component("b")];
    duplicateConnections.circuits[0].connections = [
      {
        id: "same",
        sourceComponentId: "a",
        sourcePortId: "out",
        targetComponentId: "b",
        targetPortId: "in",
      },
      {
        id: "same",
        sourceComponentId: "a",
        sourcePortId: "out",
        targetComponentId: "b",
        targetPortId: "in",
      },
    ];
    expect(() => parseProjectDocumentV2(JSON.stringify(duplicateConnections))).toThrow(
      /duplicate connection/i,
    );
  });
});

describe("default project document compatibility", () => {
  it("imports v1 and v2 through stable v3-only export", () => {
    const v1 = createEmptyCircuitDocument();
    const v2 = emptyProject();

    for (const legacy of [v1, v2]) {
      const parsed = parseProjectDocument(JSON.stringify(legacy));
      const serialized = serializeProjectDocument(parsed);
      const encoded = JSON.parse(serialized) as Record<string, unknown>;

      expect(parsed.version).toBe(3);
      expect(encoded.version).toBe(3);
      expect(serialized).toContain('"wires"');
      expect(serialized).not.toContain('"connections"');
      expect(parseProjectDocument(serialized)).toEqual(parsed);
    }
  });
});
