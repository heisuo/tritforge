import { describe, expect, it } from "vitest";
import type { CatalogComponent } from "../src/editor-model";
import { buildProjectCatalog } from "../src/project/project-catalog";
import type { ProjectDocumentV2 } from "../src/project/project-document";

const moduleInterfaces = {
  a: [
    { id: "a", label: "Input A", direction: "input" as const, width: 3 },
    { id: "b", label: "Input B", direction: "input" as const, width: 1 },
    { id: "y", label: "Result Y", direction: "output" as const, width: 1 },
  ],
  b: [],
  c: [
    { id: "a", label: "Port A", direction: "input" as const, width: 1 },
    { id: "z", label: "Port Z", direction: "input" as const, width: 1 },
  ],
};

function moduleCircuit(id: string, components: ProjectDocumentV2["circuits"][number]["components"] = []) {
  return { id, name: id.toUpperCase(), kind: "module" as const, components, connections: [] };
}

function project(): ProjectDocumentV2 {
  return {
    format: "logsim-ternary",
    version: 2,
    rootCircuitId: "main",
    circuits: [
      { id: "main", name: "Main", kind: "main", components: [], connections: [] },
      moduleCircuit("a", [
        {
          id: "out-low",
          typeId: "project.module_output",
          position: { x: 300, y: 200 },
          properties: { portId: "y", label: "Y" },
        },
        {
          id: "in-high",
          typeId: "project.module_input",
          position: { x: 0, y: 20 },
          properties: { portId: "a", label: "A", previewValue: "1T0", width: 3 },
        },
        {
          id: "in-low",
          typeId: "project.module_input",
          position: { x: 0, y: 120 },
          properties: { portId: "b", label: "B", previewValue: "0" },
        },
        {
          id: "b-in-a",
          typeId: "project.module_instance",
          position: { x: 150, y: 80 },
          properties: { moduleId: "b", label: "B1" },
        },
      ]),
      moduleCircuit("b"),
      moduleCircuit("c"),
    ],
  };
}

describe("project catalog", () => {
  it("merges built-ins with Rust-resolved module ports", () => {
    const builtin: CatalogComponent = {
      type_id: "gate.buf",
      display_name: "BUF",
      category: "gate",
      kind: "gate",
      ports: [{ id: "a", direction: "input" }, { id: "y", direction: "output" }],
      truth_table: [],
    };

    const value = project();
    const catalog = buildProjectCatalog(
      [builtin],
      value,
      "main",
      moduleInterfaces,
    );
    const descriptor = catalog.find(
      (item) => item.category === "project-module" && item.moduleId === "a",
    );

    expect(catalog[0]).toEqual(builtin);
    expect(descriptor).toMatchObject({
      type_id: "project.module_instance",
      display_name: "A",
      category: "project-module",
      kind: "module_instance",
      moduleId: "a",
      ports: [
        { id: "a", label: "Input A", direction: "input", width: 3 },
        { id: "b", label: "Input B", direction: "input", width: 1 },
        { id: "y", label: "Result Y", direction: "output", width: 1 },
      ],
    });

    catalog[0].ports[0].id = "mutated";
    expect(builtin.ports[0].id).toBe("a");
  });

  it("excludes self and candidates that would create a dependency cycle", () => {
    const catalog = buildProjectCatalog([], project(), "b", moduleInterfaces);
    const moduleIds = catalog
      .filter((item) => item.category === "project-module")
      .map((item) => item.moduleId);

    expect(moduleIds).toEqual(["c"]);
  });

  it("uses Rust module-port ordering instead of boundary coordinates", () => {
    const value = project();
    const module = value.circuits.find((circuit) => circuit.id === "c")!;
    module.components = [
      {
        id: "z-boundary",
        typeId: "project.module_input",
        position: { x: 0, y: 10 },
        properties: { portId: "a", label: "A", previewValue: "0" },
      },
      {
        id: "a-boundary",
        typeId: "project.module_input",
        position: { x: 0, y: 10 },
        properties: { portId: "z", label: "Z", previewValue: "0" },
      },
    ];

    const descriptor = buildProjectCatalog(
      [],
      value,
      "main",
      moduleInterfaces,
    ).find(
      (item) => item.moduleId === "c",
    )!;

    expect(descriptor.ports.map((port) => port.id)).toEqual(["a", "z"]);
  });
});
