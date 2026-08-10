import type {
  CatalogComponent,
  CatalogPort,
} from "../editor-model";
import type { ProjectModulePortResolver } from "../wasm-client";
import { toRuntimeProject } from "./hierarchy-runtime";
import type { ProjectDocumentV2 } from "./project-document";
import type { ProjectDocumentV3 } from "./project-v3";

type CatalogProjectDocument = ProjectDocumentV2 | ProjectDocumentV3;

export interface ProjectCatalogComponent extends CatalogComponent {
  moduleId?: string;
  ports: ProjectCatalogPort[];
}

export interface ProjectCatalogPort extends CatalogPort {
  label?: string;
  width?: number;
}

export function buildProjectCatalog(
  builtins: CatalogComponent[],
  project: CatalogProjectDocument,
  activeCircuitId: string,
  resolveModulePorts: ProjectModulePortResolver,
): ProjectCatalogComponent[] {
  const forbidden = cycleCausingCandidates(project, activeCircuitId);
  const runtimeProject = toRuntimeProject(project);
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
      ports: resolveModulePorts(runtimeProject, circuit.id).map((port) => ({
        ...port,
      })),
      truth_table: [],
    }));
  return [...builtins.map(cloneDescriptor), ...dynamic];
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
  project: CatalogProjectDocument,
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
