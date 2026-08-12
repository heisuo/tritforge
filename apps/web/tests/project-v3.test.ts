import { describe, expect, it } from "vitest";
import type { CircuitDocument } from "../src/editor/circuit-document";
import {
  migrateV2ToV3,
  parseProjectDocumentV3,
  serializeProjectDocumentV3,
  type ProjectDocumentV2,
  type ProjectDocumentV3,
} from "../src/project/project-document";

function component(
  id: string,
  typeId = "gate.buf",
  properties: Record<string, unknown> = {},
) {
  return { id, typeId, position: { x: 0, y: 0 }, properties };
}

function v2Project(): ProjectDocumentV2 {
  return {
    format: "logsim-ternary",
    version: 2,
    rootCircuitId: "main",
    circuits: [
      {
        id: "main",
        name: "Main",
        kind: "main",
        components: [
          component("source", "source.trit_input", {
            value: "T",
            nested: { keep: true },
          }),
          component("probe", "sink.probe"),
        ],
        connections: [
          {
            id: "wire-z",
            sourceComponentId: "source",
            sourcePortId: "out",
            targetComponentId: "probe",
            targetPortId: "in",
          },
        ],
        viewport: { x: 12, y: -8, zoom: 1.25 },
      },
      {
        id: "identity",
        name: "Identity",
        kind: "module",
        components: [
          component("in", "project.module_input", {
            portId: "a",
            label: "A",
            previewValue: "0",
          }),
          component("out", "project.module_output", {
            portId: "y",
            label: "Y",
          }),
        ],
        connections: [
          {
            id: "wire-a",
            sourceComponentId: "in",
            sourcePortId: "out",
            targetComponentId: "out",
            targetPortId: "in",
          },
        ],
      },
    ],
  };
}

function v3Project(): ProjectDocumentV3 {
  return migrateV2ToV3(v2Project());
}

describe("project document v3", () => {
  it("migrates v2 connections to ordered undirected wires without rewriting content", () => {
    const legacy = v2Project();

    const migrated = parseProjectDocumentV3(JSON.stringify(legacy));

    expect(migrated).toEqual({
      format: "logsim-ternary",
      version: 3,
      rootCircuitId: "main",
      circuits: [
        {
          id: "main",
          name: "Main",
          kind: "main",
          components: legacy.circuits[0].components,
          wires: [
            {
              id: "wire-z",
              endpointA: { componentId: "source", portId: "out" },
              endpointB: { componentId: "probe", portId: "in" },
            },
          ],
          viewport: { x: 12, y: -8, zoom: 1.25 },
        },
        {
          id: "identity",
          name: "Identity",
          kind: "module",
          components: legacy.circuits[1].components,
          wires: [
            {
              id: "wire-a",
              endpointA: { componentId: "in", portId: "out" },
              endpointB: { componentId: "out", portId: "in" },
            },
          ],
        },
      ],
    });
    expect(migrated.circuits[0].components[0].properties).not.toHaveProperty(
      "width",
    );
    expect(migrated.circuits[1].components[0].properties).not.toHaveProperty(
      "width",
    );
  });

  it("migrates v1 through the legacy project shape and preserves positions and viewport", () => {
    const v1: CircuitDocument = {
      format: "logsim-ternary",
      version: 1,
      components: [
        {
          ...component("source", "source.constant", {
            value: "1",
            extension: { note: "keep" },
          }),
          position: { x: 25, y: 40 },
        },
        { ...component("probe", "sink.probe"), position: { x: 80, y: 40 } },
      ],
      connections: [
        {
          id: "legacy-edge",
          sourceComponentId: "source",
          sourcePortId: "out",
          targetComponentId: "probe",
          targetPortId: "in",
        },
      ],
      viewport: { x: -5, y: 6, zoom: 0.75 },
    };

    const migrated = parseProjectDocumentV3(JSON.stringify(v1));

    expect(migrated.circuits[0]).toEqual({
      id: "main",
      name: "Main",
      kind: "main",
      components: v1.components,
      wires: [
        {
          id: "legacy-edge",
          endpointA: { componentId: "source", portId: "out" },
          endpointB: { componentId: "probe", portId: "in" },
        },
      ],
      viewport: v1.viewport,
    });
  });

  it("deep-clones migration inputs and preserves user array order", () => {
    const legacy = v2Project();
    legacy.circuits[0].connections.unshift({
      id: "wire-first",
      sourceComponentId: "source",
      sourcePortId: "out",
      targetComponentId: "probe",
      targetPortId: "in",
    });

    const migrated = migrateV2ToV3(legacy);
    (
      migrated.circuits[0].components[0].properties.nested as {
        keep: boolean;
      }
    ).keep = false;
    migrated.circuits[0].components[0].position.x = 99;
    if (migrated.circuits[0].viewport) migrated.circuits[0].viewport.x = 99;

    expect(migrated.circuits[0].wires.map((wire) => wire.id)).toEqual([
      "wire-first",
      "wire-z",
    ]);
    expect(legacy.circuits[0].components[0].properties.nested).toEqual({
      keep: true,
    });
    expect(legacy.circuits[0].components[0].position.x).toBe(0);
    expect(legacy.circuits[0].viewport?.x).toBe(12);
  });

  it("serializes only v3 wires and is idempotent after parsing", () => {
    const parsed = parseProjectDocumentV3(JSON.stringify(v2Project()));

    const serialized = serializeProjectDocumentV3(parsed);
    const encoded = JSON.parse(serialized) as Record<string, unknown>;

    expect(encoded.version).toBe(3);
    expect(serialized).toContain('"wires"');
    expect(serialized).not.toContain('"connections"');
    expect(parseProjectDocumentV3(serialized)).toEqual(parsed);
    expect(
      serializeProjectDocumentV3(parseProjectDocumentV3(serialized)),
    ).toBe(serialized);
  });

  it("round-trips editor-only component rotation", () => {
    const project = v3Project();
    project.circuits[0].components[0].rotation = 90;

    const parsed = parseProjectDocumentV3(
      serializeProjectDocumentV3(project),
    );

    expect(parsed.circuits[0].components[0].rotation).toBe(90);
  });

  it("rejects unsupported component rotation", () => {
    const project = v3Project() as unknown as {
      circuits: Array<{ components: Array<Record<string, unknown>> }>;
    };
    project.circuits[0].components[0].rotation = 45;

    expect(() => parseProjectDocumentV3(JSON.stringify(project))).toThrow(
      /rotation/i,
    );
  });

  it("preserves native v3 width-aware properties without interpreting them", () => {
    const project = v3Project();
    project.circuits[0].components[0].properties = {
      width: 3,
      value: "1T0",
      extension: { keep: true },
    };
    project.circuits[1].components[0].properties = {
      portId: "a",
      label: "A",
      width: 3,
      previewValue: "T01",
    };

    expect(parseProjectDocumentV3(JSON.stringify(project))).toEqual(project);
  });

  it.each([
    ["top-level", (project: Record<string, unknown>) => (project.extra = true)],
    [
      "circuit",
      (project: Record<string, unknown>) =>
        ((project.circuits as Record<string, unknown>[])[0].extra = true),
    ],
    [
      "component",
      (project: Record<string, unknown>) =>
        ((((project.circuits as Record<string, unknown>[])[0]
          .components as Record<string, unknown>[])[0].extra = true)),
    ],
    [
      "wire",
      (project: Record<string, unknown>) =>
        ((((project.circuits as Record<string, unknown>[])[0]
          .wires as Record<string, unknown>[])[0].extra = true)),
    ],
    [
      "endpoint",
      (project: Record<string, unknown>) =>
        (((((project.circuits as Record<string, unknown>[])[0]
          .wires as Record<string, unknown>[])[0]
          .endpointA as Record<string, unknown>).extra = true)),
    ],
  ])("rejects unknown %s fields", (_label, mutate) => {
    const project = structuredClone(v3Project()) as unknown as Record<
      string,
      unknown
    >;
    mutate(project);

    expect(() => parseProjectDocumentV3(JSON.stringify(project))).toThrow(
      /unknown property 'extra'/i,
    );
  });

  it("rejects mixed v3 schemas and requires wires", () => {
    const mixed = structuredClone(v3Project()) as unknown as {
      circuits: Array<Record<string, unknown>>;
    };
    mixed.circuits[0].connections = [];
    expect(() => parseProjectDocumentV3(JSON.stringify(mixed))).toThrow(
      /connections/i,
    );

    const missingWires = structuredClone(v3Project()) as unknown as {
      circuits: Array<Record<string, unknown>>;
    };
    delete missingWires.circuits[0].wires;
    expect(() => parseProjectDocumentV3(JSON.stringify(missingWires))).toThrow(
      /wires/i,
    );
  });

  it("rejects duplicate IDs and endpoints referencing missing components", () => {
    const duplicateCircuit = v3Project();
    duplicateCircuit.circuits.push(structuredClone(duplicateCircuit.circuits[0]));
    expect(() =>
      parseProjectDocumentV3(JSON.stringify(duplicateCircuit)),
    ).toThrow(/duplicate circuit/i);

    const duplicateComponents = v3Project();
    duplicateComponents.circuits[0].components.push(
      structuredClone(duplicateComponents.circuits[0].components[0]),
    );
    expect(() =>
      parseProjectDocumentV3(JSON.stringify(duplicateComponents)),
    ).toThrow(/duplicate component/i);

    const duplicateWires = v3Project();
    duplicateWires.circuits[0].wires.push(
      structuredClone(duplicateWires.circuits[0].wires[0]),
    );
    expect(() =>
      parseProjectDocumentV3(JSON.stringify(duplicateWires)),
    ).toThrow(/duplicate wire/i);

    const missingEndpoint = v3Project();
    missingEndpoint.circuits[0].wires[0].endpointB.componentId = "missing";
    expect(() =>
      parseProjectDocumentV3(JSON.stringify(missingEndpoint)),
    ).toThrow(/missing component/i);
  });

  it("requires exactly one main circuit and a root that names it", () => {
    const twoMains = v3Project();
    twoMains.circuits[1].kind = "main";
    expect(() => parseProjectDocumentV3(JSON.stringify(twoMains))).toThrow(
      /exactly one main/i,
    );

    const missingRoot = v3Project();
    missingRoot.rootCircuitId = "missing";
    expect(() => parseProjectDocumentV3(JSON.stringify(missingRoot))).toThrow(
      /rootCircuitId/i,
    );

    const moduleRoot = v3Project();
    moduleRoot.rootCircuitId = "identity";
    expect(() => parseProjectDocumentV3(JSON.stringify(moduleRoot))).toThrow(
      /main circuit/i,
    );
  });
});
