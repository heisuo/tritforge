import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnNodeDrag,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Activity,
  Box,
  CircleDot,
  Download,
  Gauge,
  Library,
  Maximize2,
  Menu,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Plus,
  Radio,
  Redo2,
  RotateCcw,
  Trash2,
  Triangle,
  Undo2,
  Upload,
  Workflow,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useStore } from "zustand";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { CircuitNode, SIGNAL_COLORS } from "./CircuitNode";
import { COMPONENT_HELP } from "./component-help";
import { HierarchyBreadcrumbs } from "./components/HierarchyBreadcrumbs";
import { ModuleManager } from "./components/ModuleManager";
import { ExampleLibrary } from "./ExampleLibrary";
import { LogicWireEdge } from "./LogicWireEdge";
import {
  fromEditorDocument,
  toEditorDocument,
  type CircuitDocument,
} from "./editor/circuit-document";
import {
  createDefaultDocument,
  cycleKnownTrit,
  makeComponentId,
  makeConnectionId,
  renameNodeLabel,
  type CatalogComponent,
  type ConnectionCandidate,
  type EditorDocument,
  type EditorEdge,
  type EditorNode,
  type KnownTrit,
  type ProjectSimulationDiagnostic,
  type ProjectSimulationSnapshot,
  type TritSymbol,
} from "./editor-model";
import {
  EXAMPLES,
  cloneExampleDocument,
  cloneExampleProject,
  type ExampleId,
  type TernaryExample,
} from "./examples";
import {
  parseProjectDocument,
  serializeProjectDocument,
  migrateV1ToV2,
  type ProjectCircuit,
  type ProjectDocumentV2,
} from "./project/project-document";
import {
  buildProjectCatalog,
  type ProjectCatalogComponent,
} from "./project/project-catalog";
import { HierarchyRuntime, HierarchyRuntimeError } from "./project/hierarchy-runtime";
import { createProjectStore } from "./project/project-store";
import {
  createWasmRuntime,
  wasmErrorMessage,
  type WasmRuntime,
} from "./wasm-client";
import { assignWireLanes } from "./wire-routing";

const nodeTypes = { component: CircuitNode };
const edgeTypes = { logic: LogicWireEdge };
const FLOW_FIT_OPTIONS = { padding: 0.28 };
const FLOW_SNAP_GRID: [number, number] = [16, 16];
const DEFAULT_EDGE_OPTIONS = { type: "logic" as const };
const DISPLAY_NAMES: Record<string, string> = {
  "source.trit_input": "Trit Input",
  "source.constant": "Constant",
  "sink.probe": "Probe",
  "gate.buf": "BUF",
  "gate.neg": "NEG",
  "gate.min": "MIN",
  "gate.max": "MAX",
  "gate.is_neg": "IS_NEG",
  "gate.is_zero": "IS_ZERO",
  "gate.is_pos": "IS_POS",
  "gate.mod_sum": "MOD_SUM",
  "gate.consensus": "CONSENSUS",
  "gate.mux2": "MUX2",
  "gate.mux3": "MUX3",
  "module.half_adder": "Half Adder",
  "module.full_adder": "Full Adder",
  "project.module_input": "Module Input",
  "project.module_output": "Module Output",
  "project.module_instance": "Module Instance",
};

const BOUNDARY_CATALOG: ProjectCatalogComponent[] = [
  {
    type_id: "project.module_input",
    display_name: "Module Input",
    category: "project-boundary",
    kind: "source",
    ports: [{ id: "out", direction: "output", label: "out" }],
    truth_table: [],
  },
  {
    type_id: "project.module_output",
    display_name: "Module Output",
    category: "project-boundary",
    kind: "sink",
    ports: [{ id: "in", direction: "input", label: "in" }],
    truth_table: [],
  },
];

function initialProject(): ProjectDocumentV2 {
  return migrateV1ToV2(fromEditorDocument(createDefaultDocument()));
}

function circuitDocument(circuit: ProjectCircuit): CircuitDocument {
  return {
    format: "logsim-ternary",
    version: 1,
    components: circuit.components,
    connections: circuit.connections,
    ...(circuit.viewport ? { viewport: circuit.viewport } : {}),
  };
}

function descriptorIcon(descriptor: CatalogComponent) {
  if (descriptor.type_id === "source.trit_input") return Radio;
  if (descriptor.type_id === "source.constant") return Box;
  if (descriptor.type_id === "sink.probe") return Gauge;
  if (descriptor.type_id.includes("mux")) return Triangle;
  if (descriptor.category === "module" || descriptor.category === "project-module") {
    return Workflow;
  }
  return CircleDot;
}

function edgeSignal(
  edge: EditorEdge,
  snapshot: ProjectSimulationSnapshot | null,
): TritSymbol {
  if (!edge.sourceHandle) return "Z";
  return snapshot?.componentOutputs[edge.source]?.[edge.sourceHandle] ?? "Z";
}

function instanceId(moduleId: string, nodes: EditorNode[]): string {
  const stem = moduleId.replace(/-\d+$/, "") || "module";
  const used = new Set(nodes.map((node) => node.id));
  let suffix = 1;
  while (used.has(`${stem}-${suffix}`)) suffix += 1;
  return `${stem}-${suffix}`;
}

function nextId(stem: string, used: string[]): string {
  const ids = new Set(used);
  let suffix = 1;
  while (ids.has(`${stem}-${suffix}`)) suffix += 1;
  return `${stem}-${suffix}`;
}

function sourceChanges(
  before: ProjectDocumentV2,
  after: ProjectDocumentV2,
): Array<{ circuitId: string; componentId: string; value: KnownTrit }> {
  const oldValues = new Map<string, unknown>();
  for (const circuit of before.circuits) {
    for (const component of circuit.components) {
      oldValues.set(
        `${circuit.id}\0${component.id}`,
        component.typeId === "project.module_input"
          ? component.properties.previewValue
          : component.properties.value,
      );
    }
  }
  const updates: Array<{ circuitId: string; componentId: string; value: KnownTrit }> = [];
  for (const circuit of after.circuits) {
    for (const component of circuit.components) {
      const value =
        component.typeId === "project.module_input"
          ? component.properties.previewValue
          : component.properties.value;
      if (
        (value === "T" || value === "0" || value === "1") &&
        oldValues.get(`${circuit.id}\0${component.id}`) !== value
      ) {
        updates.push({ circuitId: circuit.id, componentId: component.id, value });
      }
    }
  }
  return updates;
}

function readTextFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("文件读取失败")));
    reader.readAsText(file);
  });
}

function Workbench() {
  const store = useMemo(() => createProjectStore(initialProject()), []);
  const project = useStore(store, (state) => state.project);
  const activePath = useStore(store, (state) => state.activePath);
  const canUndo = useStore(store, (state) => state.past.length > 0);
  const canRedo = useStore(store, (state) => state.future.length > 0);
  const activeCircuitId = activePath.at(-1)?.circuitId ?? project.rootCircuitId;
  const activeCircuit =
    project.circuits.find((circuit) => circuit.id === activeCircuitId) ??
    project.circuits[0];
  const initialEditor = useMemo(
    () => toEditorDocument(circuitDocument(initialProject().circuits[0])),
    [],
  );
  const [nodes, setNodes] = useState<EditorNode[]>(initialEditor.nodes);
  const [edges, setEdges] = useState<EditorEdge[]>(initialEditor.edges);
  const [baseCatalog, setBaseCatalog] = useState<CatalogComponent[]>([]);
  const [snapshot, setSnapshot] = useState<ProjectSimulationSnapshot | null>(null);
  const [diagnostics, setDiagnostics] = useState<ProjectSimulationDiagnostic[]>([]);
  const [wasmState, setWasmState] = useState<"loading" | "ready" | "error">("loading");
  const [wasmVersion, setWasmVersion] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState("正在加载 Rust/WASM...");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [exampleLibraryOpen, setExampleLibraryOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(false);
  const [activeExampleId, setActiveExampleId] = useState<ExampleId>("neg");
  const [reloadRevision, setReloadRevision] = useState(0);
  const runtimeRef = useRef<HierarchyRuntime | null>(null);
  const wasmRef = useRef<WasmRuntime | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const instanceRef = useRef<ReactFlowInstance<EditorNode, EditorEdge> | null>(null);
  const inputClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dynamicCatalog = useMemo(
    () => buildProjectCatalog(baseCatalog, project, activeCircuitId),
    [activeCircuitId, baseCatalog, project],
  );
  const moduleDescriptors = useMemo(
    () => dynamicCatalog.filter((item) => item.category === "project-module"),
    [dynamicCatalog],
  );
  const baseByType = useMemo(
    () =>
      new Map(
        [...baseCatalog, ...BOUNDARY_CATALOG].map((item) => [item.type_id, item]),
      ),
    [baseCatalog],
  );

  const descriptorForNode = useCallback(
    (node: EditorNode): ProjectCatalogComponent | CatalogComponent | undefined => {
      if (node.data.typeId === "project.module_instance") {
        const moduleId = node.data.properties?.moduleId;
        return moduleDescriptors.find((item) => item.moduleId === moduleId);
      }
      return baseByType.get(node.data.typeId);
    },
    [baseByType, moduleDescriptors],
  );

  const setSuccessfulSnapshot = useCallback((next: ProjectSimulationSnapshot) => {
    setSnapshot(next);
    setDiagnostics(next.diagnostics);
  }, []);

  const runtimeFailure = useCallback((prefix: string, error: unknown, clearSnapshot = true) => {
    if (clearSnapshot) setSnapshot(null);
    setDiagnostics(
      error instanceof HierarchyRuntimeError ? error.diagnostics : [],
    );
    setStatusMessage(`${prefix}: ${wasmErrorMessage(error)}`);
  }, []);

  const syncStructure = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      setSuccessfulSnapshot(runtime.updateProject(store.getState().project));
      setStatusMessage("工程结构已由 Rust/WASM 重新求值");
    } catch (error) {
      runtimeFailure("工程校验失败", error);
    }
  }, [runtimeFailure, setSuccessfulSnapshot, store]);

  const restoreActiveCircuit = useCallback(() => {
    const state = store.getState();
    const circuitId = state.activePath.at(-1)?.circuitId ?? state.project.rootCircuitId;
    const circuit = state.project.circuits.find((item) => item.id === circuitId);
    if (!circuit) return;
    const next = toEditorDocument(circuitDocument(circuit));
    const selection = state.selectionByCircuit[circuitId];
    setNodes(
      next.nodes.map((node) => ({
        ...node,
        selected: selection?.componentIds.includes(node.id) ?? false,
      })),
    );
    setEdges(
      next.edges.map((edge) => ({
        ...edge,
        selected: selection?.connectionIds.includes(edge.id) ?? false,
      })),
    );
    setSelectedNodeId(selection?.componentIds.at(-1) ?? null);
    setSelectedEdgeIds(selection?.connectionIds ?? []);
    setReloadRevision((value) => value + 1);
    if (circuit.viewport) {
      requestAnimationFrame(() => instanceRef.current?.setViewport(circuit.viewport!));
    }
  }, [store]);

  const persistViewport = useCallback(() => {
    const viewport = instanceRef.current?.getViewport();
    if (viewport) store.getState().setViewport(activeCircuitId, viewport);
  }, [activeCircuitId, store]);

  const commitNavigation = useCallback((
    targetCircuitId: string,
    updatePath: () => void,
    failurePrefix: string,
  ): boolean => {
    try {
      const runtime = runtimeRef.current;
      if (runtime) setSuccessfulSnapshot(runtime.switchActive(targetCircuitId));
      updatePath();
      restoreActiveCircuit();
      return true;
    } catch (error) {
      runtimeFailure(failurePrefix, error, false);
      return false;
    }
  }, [restoreActiveCircuit, runtimeFailure, setSuccessfulSnapshot]);

  useEffect(() => {
    let mounted = true;
    createWasmRuntime()
      .then((wasm) => {
        if (!mounted) return;
        wasmRef.current = wasm;
        const runtime = new HierarchyRuntime(wasm.projectSimulator);
        runtimeRef.current = runtime;
        setBaseCatalog(wasm.catalog);
        setWasmVersion(wasm.apiVersion);
        try {
          const state = store.getState();
          const currentCircuitId =
            state.activePath.at(-1)?.circuitId ?? state.project.rootCircuitId;
          setSuccessfulSnapshot(runtime.load(state.project, currentCircuitId));
          setWasmState("ready");
          setStatusMessage("Rust/WASM 层级模拟器已就绪");
        } catch (error) {
          setWasmState("error");
          runtimeFailure("WASM 加载失败", error);
        }
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setWasmState("error");
        runtimeFailure("WASM 加载失败", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 1079px)");
    const update = () => setCompactLayout(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const applyEditorDocument = useCallback(
    (next: EditorDocument) => {
      const viewport = instanceRef.current?.getViewport();
      const saved = fromEditorDocument(next, viewport);
      store.getState().setCircuit(activeCircuitId, saved);
      setNodes(next.nodes);
      setEdges(next.edges);
      syncStructure();
    },
    [activeCircuitId, store, syncStructure],
  );

  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const descriptor = descriptorForNode(node);
        return {
          ...node,
          data: {
            ...node.data,
            ports: descriptor?.ports ?? [],
            inputSignals: snapshot?.inputNets[node.id] ?? {},
            outputSignals: snapshot?.componentOutputs[node.id] ?? {},
          },
        };
      }),
    [descriptorForNode, nodes, snapshot],
  );

  const wireLanes = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return assignWireLanes(
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
        sourcePosition: nodeById.get(edge.source)?.position ?? { x: 0, y: 0 },
        targetPosition: nodeById.get(edge.target)?.position ?? { x: 0, y: 0 },
      })),
    );
  }, [edges, nodes]);

  const renderedEdges = useMemo(
    () =>
      edges.map((edge) => {
        const signal = edgeSignal(edge, snapshot);
        return {
          ...edge,
          type: "logic" as const,
          data: { ...edge.data, ...wireLanes[edge.id] },
          label: signal,
          labelStyle: { fill: SIGNAL_COLORS[signal], fontSize: 12, fontWeight: 800 },
          labelBgStyle: { fill: "#ffffff", fillOpacity: 0.92 },
          labelBgPadding: [4, 3] as [number, number],
          labelBgBorderRadius: 2,
          style: { stroke: SIGNAL_COLORS[signal], strokeWidth: 2.2 },
        };
      }),
    [edges, snapshot, wireLanes],
  );

  const validateUiConnection = useCallback(
    (connection: ConnectionCandidate) => {
      const source = nodes.find((node) => node.id === connection.source);
      const target = nodes.find((node) => node.id === connection.target);
      const sourcePort = source
        ? descriptorForNode(source)?.ports.find((port) => port.id === connection.sourceHandle)
        : undefined;
      const targetPort = target
        ? descriptorForNode(target)?.ports.find((port) => port.id === connection.targetHandle)
        : undefined;
      if (!source || !target || !sourcePort || !targetPort) {
        return { valid: false as const, reason: "missing_endpoint" as const };
      }
      if (sourcePort.direction !== "output" || targetPort.direction !== "input") {
        return { valid: false as const, reason: "invalid_direction" as const };
      }
      if (
        edges.some(
          (edge) =>
            edge.source === connection.source &&
            edge.sourceHandle === connection.sourceHandle &&
            edge.target === connection.target &&
            edge.targetHandle === connection.targetHandle,
        )
      ) {
        return { valid: false as const, reason: "duplicate" as const };
      }
      return { valid: true as const };
    },
    [descriptorForNode, edges, nodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const result = validateUiConnection(connection);
      if (!result.valid) {
        const messages = {
          duplicate: "已拒绝完全重复的连线",
          invalid_direction: "连线必须从输出端口指向输入端口",
          missing_endpoint: "连线端点不存在",
        };
        setStatusMessage(messages[result.reason]);
        return;
      }
      applyEditorDocument({
        nodes,
        edges: addEdge({ ...connection, id: makeConnectionId(edges) }, edges),
      });
    },
    [applyEditorDocument, edges, nodes, validateUiConnection],
  );

  const addBuiltin = useCallback(
    (typeId: string, position?: { x: number; y: number }) => {
      const descriptor = baseByType.get(typeId);
      if (!descriptor) return;
      let nextPosition = position;
      if (!nextPosition) {
        const bounds = flowRef.current?.getBoundingClientRect();
        nextPosition =
          bounds && instanceRef.current
            ? instanceRef.current.screenToFlowPosition({
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2,
              })
            : { x: 420, y: 280 };
      }
      const id = makeComponentId(typeId, nodes);
      const sourceValue = descriptor.category === "source" ? ("0" as KnownTrit) : undefined;
      applyEditorDocument({
        nodes: [
          ...nodes,
          {
            id,
            type: "component",
            position: nextPosition,
            data: {
              typeId,
              label: DISPLAY_NAMES[typeId] ?? descriptor.display_name,
              ...(sourceValue ? { sourceValue } : {}),
            },
          },
        ],
        edges,
      });
      setSelectedNodeId(id);
    },
    [applyEditorDocument, baseByType, edges, nodes],
  );

  const placeModule = useCallback(
    (moduleId: string) => {
      const module = project.circuits.find((circuit) => circuit.id === moduleId);
      if (!module) return;
      const id = instanceId(moduleId, nodes);
      const bounds = flowRef.current?.getBoundingClientRect();
      const position =
        bounds && instanceRef.current
          ? instanceRef.current.screenToFlowPosition({
              x: bounds.left + bounds.width / 2,
              y: bounds.top + bounds.height / 2,
            })
          : { x: 420, y: 280 };
      try {
        store.getState().addComponent(activeCircuitId, {
          id,
          typeId: "project.module_instance",
          position,
          properties: { moduleId, label: module.name },
        });
        syncStructure();
        restoreActiveCircuit();
        setSelectedNodeId(id);
        setStatusMessage(`已放置模块 ${module.name}`);
      } catch (error) {
        setStatusMessage(`模块放置失败: ${wasmErrorMessage(error)}`);
      }
    },
    [activeCircuitId, nodes, project.circuits, restoreActiveCircuit, store, syncStructure],
  );

  const openCircuit = useCallback(
    (circuitId: string) => {
      persistViewport();
      commitNavigation(
        circuitId,
        () => store.getState().openCircuit(circuitId),
        "层级切换失败",
      );
    },
    [commitNavigation, persistViewport, store],
  );

  const createModule = useCallback(() => {
    const name = window.prompt("新建模块名称", "New Module")?.trim();
    if (!name) return;
    try {
      const id = store.getState().createModule(name);
      syncStructure();
      if (
        commitNavigation(
          id,
          () => store.getState().openCircuit(id),
          "新模块打开失败",
        )
      ) {
        setStatusMessage(`已新建模块 ${name}`);
      }
    } catch (error) {
      setStatusMessage(`新建模块失败: ${wasmErrorMessage(error)}`);
    }
  }, [commitNavigation, store, syncStructure]);

  const addBoundary = useCallback(
    (direction: "input" | "output") => {
      if (activeCircuit.kind !== "module") return;
      const stem = direction === "input" ? "module-input" : "module-output";
      const id = nextId(stem, activeCircuit.components.map((item) => item.id));
      const portStem = direction === "input" ? "in" : "out";
      const portId = nextId(
        portStem,
        activeCircuit.components
          .filter((item) => item.typeId.startsWith("project.module_"))
          .map((item) => String(item.properties.portId ?? "")),
      );
      const count = activeCircuit.components.filter(
        (item) => item.typeId === `project.module_${direction}`,
      ).length;
      store.getState().addComponent(activeCircuit.id, {
        id,
        typeId: `project.module_${direction}`,
        position: { x: direction === "input" ? 80 : 650, y: 100 + count * 150 },
        properties:
          direction === "input"
            ? { portId, label: `Input ${count + 1}`, previewValue: "0" }
            : { portId, label: `Output ${count + 1}` },
      });
      syncStructure();
      restoreActiveCircuit();
    },
    [activeCircuit, restoreActiveCircuit, store, syncStructure],
  );

  const navigateBreadcrumb = useCallback(
    (index: number) => {
      persistViewport();
      const target = store.getState().activePath[index]?.circuitId;
      if (!target) return;
      commitNavigation(
        target,
        () => store.getState().navigateToDepth(index),
        "层级返回失败",
      );
    },
    [commitNavigation, persistViewport, store],
  );

  const cycleInput = useCallback(
    (node: EditorNode) => {
      const current = node.data.sourceValue ?? "0";
      const next = cycleKnownTrit(current);
      try {
        const runtime = runtimeRef.current;
        if (!runtime) throw new Error("Rust/WASM runtime is not ready");
        const nextSnapshot = runtime.setSource(activeCircuitId, node.id, next);
        store.getState().setSource(activeCircuitId, node.id, next);
        if (nextSnapshot) setSuccessfulSnapshot(nextSnapshot);
        setNodes((items) =>
          items.map((item) =>
            item.id === node.id
              ? { ...item, data: { ...item.data, sourceValue: next } }
              : item,
          ),
        );
        setStatusMessage(`输入 ${node.id}: ${current} -> ${next}`);
      } catch (error) {
        setStatusMessage(`输入更新失败: ${wasmErrorMessage(error)}`);
      }
    },
    [activeCircuitId, setSuccessfulSnapshot, store],
  );

  const enterModuleInstance = useCallback(
    (node: EditorNode) => {
      const moduleId = node.data.properties?.moduleId;
      if (typeof moduleId !== "string") {
        setStatusMessage("无法进入模块: 模块引用无效");
        return;
      }
      persistViewport();
      commitNavigation(
        moduleId,
        () => store.getState().enterInstance(activeCircuitId, node.id),
        "无法进入模块",
      );
    },
    [activeCircuitId, commitNavigation, persistViewport, store],
  );

  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: EditorNode) => {
      setSelectedNodeId(node.id);
      setSelectedEdgeIds([]);
      store.getState().setSelection(activeCircuitId, [node.id], []);
      if (
        node.data.typeId !== "source.trit_input" &&
        node.data.typeId !== "project.module_input"
      ) {
        return;
      }
      if (inputClickTimerRef.current) clearTimeout(inputClickTimerRef.current);
      if (event.detail > 1) return;
      inputClickTimerRef.current = setTimeout(() => {
        cycleInput(node);
        inputClickTimerRef.current = null;
      }, 220);
    },
    [activeCircuitId, cycleInput, store],
  );

  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: EditorNode) => {
      if (inputClickTimerRef.current) {
        clearTimeout(inputClickTimerRef.current);
        inputClickTimerRef.current = null;
      }
      if (node.data.typeId === "project.module_instance") {
        enterModuleInstance(node);
        return;
      }
      const nextLabel = window.prompt("修改模块名称", node.data.label);
      if (nextLabel === null || !nextLabel.trim()) return;
      if (node.data.typeId.startsWith("project.module_")) {
        try {
          store.getState().renameModulePort(activeCircuitId, node.id, nextLabel);
          syncStructure();
          restoreActiveCircuit();
        } catch (error) {
          setStatusMessage(`重命名失败: ${wasmErrorMessage(error)}`);
        }
        return;
      }
      const renamed = renameNodeLabel(nodes, node.id, nextLabel);
      if (renamed !== nodes) applyEditorDocument({ nodes: renamed, edges });
    },
    [
      applyEditorDocument,
      enterModuleInstance,
      edges,
      nodes,
      restoreActiveCircuit,
      store,
      syncStructure,
    ],
  );

  const deleteSelected = useCallback(() => {
    const selectedId = selectedNodeId ?? nodes.find((node) => node.selected)?.id;
    const selectedNode = nodes.find((node) => node.id === selectedId);
    if (selectedNode?.data.typeId === "project.module_input" || selectedNode?.data.typeId === "project.module_output") {
      try {
        store.getState().deleteModulePort(activeCircuitId, selectedNode.id);
        syncStructure();
        restoreActiveCircuit();
        setStatusMessage("已删除模块端口");
      } catch (error) {
        setStatusMessage(`删除受保护: ${wasmErrorMessage(error)}`);
      }
      return;
    }
    const nodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
    if (selectedNodeId) nodeIds.add(selectedNodeId);
    const edgeIds = new Set([
      ...selectedEdgeIds,
      ...edges.filter((edge) => edge.selected).map((edge) => edge.id),
    ]);
    applyEditorDocument({
      nodes: nodes.filter((node) => !nodeIds.has(node.id)),
      edges: edges.filter(
        (edge) =>
          !edgeIds.has(edge.id) &&
          !nodeIds.has(edge.source) &&
          !nodeIds.has(edge.target),
      ),
    });
    setSelectedNodeId(null);
    setSelectedEdgeIds([]);
  }, [
    activeCircuitId,
    applyEditorDocument,
    edges,
    nodes,
    restoreActiveCircuit,
    selectedEdgeIds,
    selectedNodeId,
    store,
    syncStructure,
  ]);

  const deleteModule = useCallback(
    (moduleId: string) => {
      try {
        store.getState().deleteModule(moduleId);
        const state = store.getState();
        const nextActiveId =
          state.activePath.at(-1)?.circuitId ?? state.project.rootCircuitId;
        const runtime = runtimeRef.current;
        if (runtime) {
          const nextSnapshot =
            moduleId === activeCircuitId
              ? runtime.load(state.project, nextActiveId)
              : runtime.updateProject(state.project);
          setSuccessfulSnapshot(nextSnapshot);
        }
        restoreActiveCircuit();
        setStatusMessage("模块已删除");
      } catch (error) {
        setStatusMessage(`删除受保护: ${wasmErrorMessage(error)}`);
      }
    },
    [activeCircuitId, restoreActiveCircuit, setSuccessfulSnapshot, store],
  );

  const renameModule = useCallback(
    (moduleId: string) => {
      const module = store.getState().project.circuits.find(
        (circuit) => circuit.id === moduleId,
      );
      if (!module) return;
      const name = window.prompt("修改模块名称", module.name)?.trim();
      if (!name) return;
      try {
        store.getState().renameModule(moduleId, name);
        syncStructure();
        restoreActiveCircuit();
        setStatusMessage(`模块已重命名为 ${name}`);
      } catch (error) {
        setStatusMessage(`模块重命名失败: ${wasmErrorMessage(error)}`);
      }
    },
    [restoreActiveCircuit, store, syncStructure],
  );

  const historyStep = useCallback(
    (direction: "undo" | "redo") => {
      persistViewport();
      const before = store.getState();
      const beforeProject = before.project;
      const beforeStructure = before.structureRevision;
      const beforeActive = before.activePath.at(-1)?.circuitId;
      before[direction]();
      const after = store.getState();
      const runtime = runtimeRef.current;
      try {
        if (runtime) {
          const afterActive = after.activePath.at(-1)?.circuitId;
          if (afterActive && afterActive !== beforeActive) {
            setSuccessfulSnapshot(runtime.load(after.project, afterActive));
          } else if (after.structureRevision !== beforeStructure) {
            setSuccessfulSnapshot(runtime.updateProject(after.project));
          } else {
            for (const update of sourceChanges(beforeProject, after.project)) {
              const next = runtime.setSource(
                update.circuitId,
                update.componentId,
                update.value,
              );
              if (next) setSuccessfulSnapshot(next);
            }
          }
        }
        restoreActiveCircuit();
        setStatusMessage(direction === "undo" ? "已撤销上一步编辑" : "已重做编辑");
      } catch (error) {
        runtimeFailure("历史恢复失败", error);
      }
    },
    [persistViewport, restoreActiveCircuit, runtimeFailure, setSuccessfulSnapshot, store],
  );

  const loadProject = useCallback(
    (nextProject: ProjectDocumentV2, message: string) => {
      store.getState().replaceProject(nextProject);
      try {
        const runtime = runtimeRef.current;
        if (runtime) setSuccessfulSnapshot(runtime.load(nextProject, nextProject.rootCircuitId));
        restoreActiveCircuit();
        setStatusMessage(message);
      } catch (error) {
        runtimeFailure("工程加载失败", error);
        restoreActiveCircuit();
      }
    },
    [restoreActiveCircuit, runtimeFailure, setSuccessfulSnapshot, store],
  );

  const loadExample = useCallback(
    (exampleId: ExampleId) => {
      const next =
        cloneExampleProject(exampleId) ??
        migrateV1ToV2(fromEditorDocument(cloneExampleDocument(exampleId)));
      const example = EXAMPLES.find((item) => item.id === exampleId);
      loadProject(next, `已载入示例: ${example?.name ?? exampleId}`);
      setActiveExampleId(exampleId);
      setExampleLibraryOpen(false);
      requestAnimationFrame(() => instanceRef.current?.fitView({ padding: 0.28 }));
    },
    [loadProject],
  );

  const exportProject = useCallback(() => {
    persistViewport();
    const blob = new Blob([serializeProjectDocument(store.getState().project)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = "logsim-ternary-circuit.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatusMessage("工程已导出为 JSON");
  }, [persistViewport, store]);

  const importProject = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try {
        loadProject(parseProjectDocument(await readTextFile(file)), `已导入工程: ${file.name}`);
      } catch (error) {
        setStatusMessage(`工程导入失败: ${wasmErrorMessage(error)}`);
      }
    },
    [loadProject],
  );

  const clearCircuit = useCallback(() => {
    store.getState().setCircuit(activeCircuitId, {
      components: [],
      connections: [],
    });
    setNodes([]);
    setEdges([]);
    syncStructure();
    setStatusMessage("画布已清空");
  }, [activeCircuitId, store, syncStructure]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey ? canRedo : canUndo) historyStep(event.shiftKey ? "redo" : "undo");
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (canRedo) historyStep("redo");
      } else if ((event.key === "Delete" || event.key === "Backspace") && (selectedNodeId || selectedEdgeIds.length)) {
        event.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canRedo, canUndo, deleteSelected, historyStep, selectedEdgeIds.length, selectedNodeId]);

  const modules = useMemo(
    () =>
      project.circuits
        .filter((circuit) => circuit.kind === "module")
        .map((circuit) => ({
          id: circuit.id,
          name: circuit.name,
          placeable: moduleDescriptors.some(
            (descriptor) => descriptor.moduleId === circuit.id,
          ),
          referenceCount: project.circuits.reduce(
            (count, owner) =>
              count +
              owner.components.filter(
                (component) =>
                  component.typeId === "project.module_instance" &&
                  component.properties.moduleId === circuit.id,
              ).length,
            0,
          ),
        })),
    [moduleDescriptors, project],
  );
  const breadcrumbEntries = activePath.map((entry) => ({
    circuitId: entry.circuitId,
    name:
      project.circuits.find((circuit) => circuit.id === entry.circuitId)?.name ??
      entry.circuitId,
  }));
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedDescriptor = selectedNode ? descriptorForNode(selectedNode) ?? null : null;

  const navigateDiagnostic = useCallback(
    (diagnostic: ProjectSimulationDiagnostic) => {
      const location = diagnostic.primaryLocation;
      if (!location) return;
      const ref = location.ref;
      const circuitId = ref.circuitId;
      persistViewport();
      const state = store.getState();
      const startCircuitId = activeCircuitId;
      const pathSteps: Array<{ parentCircuitId: string; instanceId: string }> = [];
      let parentCircuitId = startCircuitId;
      try {
        for (const instanceId of ref.instancePath) {
          const parent = state.project.circuits.find(
            (circuit) => circuit.id === parentCircuitId,
          );
          const instance = parent?.components.find(
            (component) =>
              component.id === instanceId &&
              component.typeId === "project.module_instance",
          );
          const moduleId = instance?.properties.moduleId;
          if (typeof moduleId !== "string") {
            throw new Error(`诊断实例路径不存在: ${instanceId}`);
          }
          pathSteps.push({ parentCircuitId, instanceId });
          parentCircuitId = moduleId;
        }
        if (ref.instancePath.length > 0 && parentCircuitId !== circuitId) {
          throw new Error("诊断实例路径与目标电路不一致");
        }
        const targetCircuitId = ref.instancePath.length > 0 ? parentCircuitId : circuitId;
        const navigated = commitNavigation(
          targetCircuitId,
          () => {
            store.getState().openCircuit(startCircuitId);
            for (const step of pathSteps) {
              store.getState().enterInstance(step.parentCircuitId, step.instanceId);
            }
            if (pathSteps.length === 0 && circuitId !== startCircuitId) {
              store.getState().openCircuit(circuitId);
            }
          },
          "诊断导航失败",
        );
        if (!navigated) return;
      } catch (error) {
        setStatusMessage(`诊断导航失败: ${wasmErrorMessage(error)}`);
        return;
      }
      requestAnimationFrame(() => {
        if ("componentId" in ref) {
          setSelectedNodeId(ref.componentId);
          store.getState().setSelection(circuitId, [ref.componentId], []);
          restoreActiveCircuit();
        } else if ("connectionId" in ref) {
          setSelectedEdgeIds([ref.connectionId]);
          store.getState().setSelection(circuitId, [], [ref.connectionId]);
          restoreActiveCircuit();
        }
      });
    },
    [activeCircuitId, commitNavigation, persistViewport, restoreActiveCircuit, store],
  );

  const handleFlowInit = useCallback(
    (instance: ReactFlowInstance<EditorNode, EditorEdge>) => {
      instanceRef.current = instance;
    },
    [],
  );
  const handleNodesChange = useCallback(
    (changes: NodeChange<EditorNode>[]) => {
      setNodes((items) => applyNodeChanges(changes, items));
    },
    [],
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<EditorEdge>[]) => {
      const nextEdges = applyEdgeChanges(changes, edges);
      if (changes.some((change) => change.type === "remove")) {
        applyEditorDocument({ nodes, edges: nextEdges });
      } else {
        setEdges(nextEdges);
      }
    },
    [applyEditorDocument, edges, nodes],
  );
  const handleNodeDragStop = useCallback<OnNodeDrag<EditorNode>>(
    (_event, node) => {
      applyEditorDocument({
        nodes: nodes.map((item) =>
          item.id === node.id
            ? { ...item, position: { ...node.position } }
            : item,
        ),
        edges,
      });
    },
    [applyEditorDocument, edges, nodes],
  );
  const handleSelectionChange = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
      const nextNodeId = selectedNodes.at(-1)?.id ?? null;
      const nextEdgeIds = selectedEdges.map((edge) => edge.id);
      setSelectedNodeId((current) => (current === nextNodeId ? current : nextNodeId));
      setSelectedEdgeIds((current) =>
        current.length === nextEdgeIds.length &&
        current.every((id, index) => id === nextEdgeIds[index])
          ? current
          : nextEdgeIds,
      );
      store.getState().setSelection(
        activeCircuitId,
        selectedNodes.map((node) => node.id),
        nextEdgeIds,
      );
    },
    [activeCircuitId, store],
  );
  const handleFlowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" || !selectedNodeId) return;
      const node = nodes.find((item) => item.id === selectedNodeId);
      if (node?.data.typeId !== "project.module_instance") return;
      event.preventDefault();
      enterModuleInstance(node);
    },
    [enterModuleInstance, nodes, selectedNodeId],
  );

  return (
    <main className="app-shell" aria-label="Logsim Ternary 编辑器">
      <header className="topbar">
        <div className="brand">
          <Workflow aria-hidden="true" />
          <strong>LOGSIM TERNARY</strong>
          <span>PHASE 2A</span>
        </div>
        <div className={`toolbar ${mobileMenuOpen ? "is-open" : ""}`} role="toolbar" aria-label="画布工具">
          <button className="mobile-only icon-button" type="button" title="打开工具菜单" aria-label="打开工具菜单" aria-expanded={mobileMenuOpen} aria-controls="mobile-toolbar-menu" onClick={() => setMobileMenuOpen((value) => !value)}><Menu aria-hidden="true" /></button>
          <button className="mobile-only icon-button" type="button" title="元件库" aria-label="切换元件库" aria-expanded={paletteOpen} aria-controls="component-palette" onClick={() => { setPaletteOpen((value) => !value); setInspectorOpen(false); }}><PanelLeft aria-hidden="true" /></button>
          <button className="mobile-only icon-button" type="button" title="检查器" aria-label="切换检查器" aria-expanded={inspectorOpen} aria-controls="component-inspector" onClick={() => { setInspectorOpen((value) => !value); setPaletteOpen(false); }}><PanelRight aria-hidden="true" /></button>
          <div className="toolbar-menu" id="mobile-toolbar-menu">
            <button className="icon-button" type="button" title="撤销" aria-label="撤销" disabled={!canUndo} onClick={() => historyStep("undo")}><Undo2 aria-hidden="true" /></button>
            <button className="icon-button" type="button" title="重做" aria-label="重做" disabled={!canRedo} onClick={() => historyStep("redo")}><Redo2 aria-hidden="true" /></button>
            <button type="button" onClick={() => setExampleLibraryOpen(true)}><Library aria-hidden="true" />示例库</button>
            <button type="button" onClick={() => loadExample("neg")}><RotateCcw aria-hidden="true" />默认示例</button>
            <button type="button" onClick={clearCircuit}><Trash2 aria-hidden="true" />清空</button>
            <button type="button" onClick={() => instanceRef.current?.fitView({ padding: 0.25, duration: 250 })}><Maximize2 aria-hidden="true" />适应画布</button>
            <button className="icon-button" type="button" title="导入工程" aria-label="导入工程" onClick={() => fileInputRef.current?.click()}><Upload aria-hidden="true" /></button>
            <button className="icon-button" type="button" title="导出工程" aria-label="导出工程" onClick={exportProject}><Download aria-hidden="true" /></button>
            <span className="toolbar-divider" />
            <button className="icon-button" type="button" title="删除所选" aria-label="删除所选" disabled={!selectedNodeId && selectedEdgeIds.length === 0} onClick={deleteSelected}><Trash2 aria-hidden="true" /></button>
          </div>
        </div>
        <div className={`wasm-badge state-${wasmState}`}><span />{wasmState === "ready" ? `WASM v${wasmVersion}` : "WASM"}</div>
      </header>

      <HierarchyBreadcrumbs entries={breadcrumbEntries} onNavigate={navigateBreadcrumb} />
      <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/json,.json" aria-label="选择三进制工程文件" onChange={importProject} />

      <div className="workbench">
        {(paletteOpen || inspectorOpen) && <button className="drawer-backdrop mobile-only" type="button" aria-label="关闭侧栏" onClick={() => { setPaletteOpen(false); setInspectorOpen(false); }} />}
        <aside id="component-palette" className={`palette ${paletteOpen ? "is-open" : ""}`} aria-label="元件库" inert={compactLayout && !paletteOpen ? true : undefined}>
          <div className="panel-title"><Plus aria-hidden="true" /><div><strong>元件库</strong><span>{dynamicCatalog.length} COMPONENTS</span></div></div>
          <ModuleManager
            modules={modules}
            activeCircuitKind={activeCircuit.kind}
            onCreate={createModule}
            onEdit={openCircuit}
            onPlace={placeModule}
            onRename={renameModule}
            onDelete={deleteModule}
            onAddInput={() => addBoundary("input")}
            onAddOutput={() => addBoundary("output")}
          />
          {["source", "gate", "module", "sink"].map((category) => (
            <section className="palette-group" key={category}>
              <h2>{category === "source" ? "输入与常量" : category === "sink" ? "观测" : category === "module" ? "算术模块" : "逻辑门"}</h2>
              {baseCatalog.filter((item) => item.category === category).map((descriptor) => {
                const Icon = descriptorIcon(descriptor);
                return (
                  <button type="button" className="palette-item" key={descriptor.type_id} draggable onDragStart={(event) => { event.dataTransfer.setData("application/logsim-component", descriptor.type_id); event.dataTransfer.effectAllowed = "copy"; }} onClick={() => addBuiltin(descriptor.type_id)}>
                    <Icon aria-hidden="true" /><span><strong>{DISPLAY_NAMES[descriptor.type_id] ?? descriptor.display_name}</strong><small>{descriptor.ports.length} PORTS</small></span><Plus aria-hidden="true" />
                  </button>
                );
              })}
            </section>
          ))}
        </aside>

        <section className="canvas" aria-label="电路画布" ref={flowRef} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); const typeId = event.dataTransfer.getData("application/logsim-component"); if (typeId && instanceRef.current) addBuiltin(typeId, instanceRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}>
          {wasmState !== "loading" ? (
            <ReactFlow<EditorNode, EditorEdge>
              key={`${activeCircuitId}-${reloadRevision}`}
              nodes={renderedNodes}
              edges={renderedEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={handleFlowInit}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              isValidConnection={(connection) => validateUiConnection(connection).valid}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onNodeDragStop={handleNodeDragStop}
              onSelectionChange={handleSelectionChange}
              onKeyDown={handleFlowKeyDown}
              deleteKeyCode={null}
              fitView
              fitViewOptions={FLOW_FIT_OPTIONS}
              minZoom={0.25}
              maxZoom={2}
              snapToGrid
              snapGrid={FLOW_SNAP_GRID}
              defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
              proOptions={{ hideAttribution: true }}
            ><Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#bcc6cc" /></ReactFlow>
          ) : <div className="canvas-loading"><Activity aria-hidden="true" /><strong>正在初始化 Rust/WASM</strong></div>}
          {nodes.length === 0 && <div className="empty-canvas"><MousePointer2 aria-hidden="true" /><strong>从左侧添加元件</strong></div>}
        </section>

        <aside id="component-inspector" className={`inspector ${inspectorOpen ? "is-open" : ""}`} aria-label="检查器" inert={compactLayout && !inspectorOpen ? true : undefined}>
          <div className="panel-title"><Activity aria-hidden="true" /><div><strong>检查器</strong><span>PROJECT SNAPSHOT</span></div></div>
          {selectedNode && selectedDescriptor ? <NodeInspector node={selectedNode} descriptor={selectedDescriptor} snapshot={snapshot} /> : <ExampleHelp example={EXAMPLES.find((item) => item.id === activeExampleId) ?? EXAMPLES[0]} />}
          <Diagnostics diagnostics={diagnostics} onNavigate={navigateDiagnostic} />
        </aside>
      </div>

      {exampleLibraryOpen && <ExampleLibrary examples={EXAMPLES} onClose={() => setExampleLibraryOpen(false)} onLoad={loadExample} />}
      <footer className="statusbar"><span className={`status-dot state-${wasmState}`} /><strong>{statusMessage}</strong><span className="status-separator" /><span>{snapshot ? snapshot.stable ? "STABLE" : "UNSTABLE" : "NO SNAPSHOT"}</span><span>{snapshot?.compileCount ?? 0} COMPILES</span><span>{diagnostics.length} DIAGNOSTICS</span><span className="status-spacer" /><span>{nodes.length} NODES</span><span>{edges.length} WIRES</span></footer>
    </main>
  );
}

function ExampleHelp({ example }: { example: TernaryExample }) {
  return (
    <section className="inspector-section example-help"><span className="type-chip">当前示例</span><h2>{example.name}</h2><div className="example-path"><span>{example.composition}</span></div><p>{example.description}</p><p className="example-expected">{example.expected}</p><dl className="ternary-key"><div><dt className="signal-T">T</dt><dd>-1，负一</dd></div><div><dt className="signal-0">0</dt><dd>0，中性值</dd></div><div><dt className="signal-1">1</dt><dd>+1，正一</dd></div></dl></section>
  );
}

function SignalRows({ title, values }: { title: string; values: Record<string, TritSymbol> }) {
  return <div className="signal-group"><h3>{title}</h3>{Object.keys(values).length === 0 ? <span className="muted">无端口</span> : Object.entries(values).map(([port, value]) => <div className="signal-row" key={port}><code>{port}</code><strong className={`signal-${value}`} style={{ color: SIGNAL_COLORS[value] }}>{value}</strong></div>)}</div>;
}

function NodeInspector({ node, descriptor, snapshot }: { node: EditorNode; descriptor: CatalogComponent; snapshot: ProjectSimulationSnapshot | null }) {
  const inputValues = snapshot?.inputNets[node.id] ?? {};
  const outputValues = snapshot?.componentOutputs[node.id] ?? {};
  const inputPorts = descriptor.ports.filter((port) => port.direction === "input");
  const outputPorts = descriptor.ports.filter((port) => port.direction === "output");
  const help = COMPONENT_HELP[descriptor.type_id];
  return <><section className="inspector-section selected-component"><span className="type-chip">{descriptor.category.toUpperCase()}</span><h2>{node.data.label}</h2><dl className="metadata"><div><dt>稳定 ID</dt><dd>{node.id}</dd></div><div><dt>类型</dt><dd>{descriptor.type_id}</dd></div></dl><div className="signal-columns"><SignalRows title="输入" values={inputValues} /><SignalRows title="输出" values={outputValues} /></div></section>{help && <section className="inspector-section component-help"><h2>中文说明</h2><p>{help.summary}</p><p>{help.details}</p></section>}{["gate", "module"].includes(descriptor.category) && descriptor.truth_table.length > 0 && <section className="inspector-section truth-table-section"><h2>真值表</h2><div className="truth-table-wrap"><table><thead><tr>{inputPorts.map((port) => <th key={port.id}>{port.id}</th>)}{outputPorts.map((port) => <th className="output-column" key={port.id}>{port.id}</th>)}</tr></thead><tbody>{descriptor.truth_table.map((row, rowIndex) => <tr key={rowIndex}>{[...row.inputs, ...row.outputs].map((value, index) => <td className={`signal-${value}`} key={`${rowIndex}-${index}`} style={{ color: SIGNAL_COLORS[value] }}>{value}</td>)}</tr>)}</tbody></table></div></section>}</>;
}

function Diagnostics({ diagnostics, onNavigate }: { diagnostics: ProjectSimulationDiagnostic[]; onNavigate: (diagnostic: ProjectSimulationDiagnostic) => void }) {
  return <section className="inspector-section diagnostics-section"><div className="section-heading"><h2>诊断</h2><span>{diagnostics.length}</span></div>{diagnostics.length === 0 ? <p className="muted">当前没有诊断信息。</p> : <ul>{diagnostics.map((diagnostic, index) => <li className={`diagnostic diagnostic-${diagnostic.severity}`} key={`${diagnostic.code}-${index}`}><button type="button" disabled={!diagnostic.primaryLocation} onClick={() => onNavigate(diagnostic)}><strong>{diagnostic.code}</strong><span>{diagnostic.message}</span></button></li>)}</ul>}</section>;
}

export function App() {
  return <ReactFlowProvider><Workbench /></ReactFlowProvider>;
}
