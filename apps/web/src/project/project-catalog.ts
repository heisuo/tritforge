import type {
  CatalogComponent,
  CatalogPort,
} from "../editor-model";
import type { ProjectDocumentV2 } from "./project-document";

export interface ProjectCatalogComponent extends CatalogComponent {
  moduleId?: string;
  ports: ProjectCatalogPort[];
}

export interface ProjectCatalogPort extends CatalogPort {
  label?: string;
}

export function buildProjectCatalog(
  builtins: CatalogComponent[],
  project: ProjectDocumentV2,
  activeCircuitId: string,
): ProjectCatalogComponent[] {
  const forbidden = cycleCausingCandidates(project, activeCircuitId);
  const dynamic = project.circuits
    .filter(
      (circuit) =>
        circuit.kind === "module" &&
        !forbidden.has(circuit.id),
    )
    .map((circuit): ProjectCatalogComponent => ({
      type_id: "project.module_instance",
      display_name: circuit.name,
      category: "project-module",
      kind: "module_instance",
      moduleId: circuit.id,
      ports: orderedBoundaryPorts(circuit.components),
      truth_table: [],
    }));
  return [...builtins.map(cloneDescriptor), ...dynamic];
}

function orderedBoundaryPorts(
  components: ProjectDocumentV2["circuits"][number]["components"],
): CatalogPort[] {
  return components
    .filter(
      (component) =>
        component.typeId === "project.module_input" ||
        component.typeId === "project.module_output",
    )
    .slice()
    .sort(
      (left, right) =>
        left.position.y - right.position.y || left.id.localeCompare(right.id),
    )
    .map((component) => ({
      id: String(component.properties.portId),
      label: String(component.properties.label),
      direction:
        component.typeId === "project.module_input"
          ? ("input" as const)
          : ("output" as const),
    }));
}

function cloneDescriptor(descriptor: CatalogComponent): ProjectCatalogComponent {
  return {
    ...descriptor,
    ports: descriptor.ports.map((port) => ({ ...port })),
    truth_table: descriptor.truth_table.map((row) => ({
      inputs: [...row.inputs],
      outputs: [...row.outputs],
    })),
  };
}

function cycleCausingCandidates(
  project: ProjectDocumentV2,
  activeCircuitId: string,
): Set<string> {
  const reverse = new Map<string, Set<string>>();
  for (const circuit of project.circuits) {
    for (const component of circuit.components) {
      const moduleId = component.properties.moduleId;
      if (
        component.typeId !== "project.module_instance" ||
        typeof moduleId !== "string"
      ) {
        continue;
      }
      const owners = reverse.get(moduleId) ?? new Set<string>();
      owners.add(circuit.id);
      reverse.set(moduleId, owners);
    }
  }
  const pending = [activeCircuitId];
  const forbidden = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (forbidden.has(current)) {
      continue;
    }
    forbidden.add(current);
    for (const owner of reverse.get(current) ?? []) {
      pending.push(owner);
    }
  }
  return forbidden;
}
