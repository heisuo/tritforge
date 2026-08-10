import { describe, expect, it, vi } from "vitest";
import type { CatalogComponent } from "../src/editor-model";
import { buildProjectCatalog } from "../src/project/project-catalog";
import type { ProjectDocumentV2 } from "../src/project/project-document";
import type { ProjectModulePortResolver } from "../src/wasm-client";

const resolveModulePorts = vi.fn(((project, moduleId) => {
  expect((project as { version: number }).version).toBe(3);
  if (moduleId === "a") {
    return [
      { id: "a", direction: "input", width: 3 },
      { id: "b", direction: "input", width: 1 },
      { id: "y", direction: "output", width: 1 },
    ];
  }
  if (moduleId === "c") {
    return [
      { id: "a", direction: "input", width: 1 },
      { id: "z", direction: "input", width: 1 },
    ];
  }
  return [];
}) satisfies ProjectModulePortResolver);

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

    resolveModulePorts.mockClear();
    const value = project();
    const catalog = buildProjectCatalog(
      [builtin],
      value,
      "main",
      resolveModulePorts,
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
        { id: "a", direction: "input", width: 3 },
        { id: "b", direction: "input", width: 1 },
        { id: "y", direction: "output", width: 1 },
      ],
    });
    expect(resolveModulePorts).toHaveBeenCalledWith(
      expect.objectContaining({ version: 3 }),
      "a",
    );

    catalog[0].ports[0].id = "mutated";
    expect(builtin.ports[0].id).toBe("a");
  });

  it("excludes self and candidates that would create a dependency cycle", () => {
    const catalog = buildProjectCatalog([], project(), "b", resolveModulePorts);
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
      resolveModulePorts,
    ).find(
      (item) => item.moduleId === "c",
    )!;

    expect(descriptor.ports.map((port) => port.id)).toEqual(["a", "z"]);
  });
});
