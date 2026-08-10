import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
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
  Cable,
  CircleDot,
  Clock3,
  Download,
  Gauge,
  GitFork,
  Library,
  Maximize2,
  Menu,
  MousePointer2,
  PanelLeft,
  PanelRight,
  PanelTop,
  Plus,
  Radio,
  Redo2,
  StepForward,
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
import { PropertyEditor } from "./components/PropertyEditor";
import { ExampleLibrary } from "./ExampleLibrary";
import { LogicWireEdge } from "./LogicWireEdge";
import {
  fromEditorDocument,
  toEditorDocument,
  type CircuitDocument,
} from "./editor/circuit-document";
import { semanticPortIdForHandle } from "./editor/port-handles";
import {
  createDefaultDocument,
  cycleKnownWord,
  makeComponentId,
  makeConnectionId,
  renameNodeLabel,
  validateConnection,
  type CatalogComponent,
  type ConnectionCandidate,
  type EditorDocument,
  type EditorEdge,
  type EditorNode,
  type ProjectSimulationDiagnostic,
  type ProjectSimulationSnapshot,
  type TernaryWord,
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
  migrateV2ToV3,
  type ProjectCircuitV3,
  type ProjectDocumentV3,
} from "./project/project-document";
import {
  buildProjectCatalog,
  type ProjectCatalogComponent,
} from "./project/project-catalog";
import {
  HierarchyRuntime,
  HierarchyRuntimeError,
} from "./project/hierarchy-runtime";
import {
  ProjectEditError,
  createProjectStore,
} from "./project/project-store";
import { edgeNetValue, projectToEditor } from "./project/editor-projection";
import {
  createWasmRuntime,
  wasmErrorMessage,
  wasmProjectError,
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
  "source.clock": "Clock",
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
  "sequential.dff": "DFF",
  "project.module_input": "Module Input",
  "project.module_output": "Module Output",
  "project.module_instance": "Module Instance",
  "wiring.junction": "连接点",
  "wiring.tunnel": "隧道",
  "wiring.splitter": "分线器",
};

const WIRING_HELPERS = [
  {
    typeId: "wiring.junction",
    displayName: "连接点",
    properties: { width: 1 },
  },
  {
    typeId: "wiring.tunnel",
    displayName: "隧道",
    properties: { width: 1, label: "net" },
  },
  {
    typeId: "wiring.splitter",
    displayName: "分线器",
    properties: { width: 3, branchCount: 3, mapping: [0, 1, 2] },
  },
] as const;

const BOUNDARY_CATALOG: ProjectCatalogComponent[] = [
  {
    type_id: "project.module_input",
    display_name: "Module Input",
    category: "project-boundary",
    kind: "source",
    ports: [{ id: "out", direction: "output", label: "out", width: 1 }],
    truth_table: [],
  },
  {
    type_id: "project.module_output",
    display_name: "Module Output",
    category: "project-boundary",
    kind: "sink",
    ports: [{ id: "in", direction: "input", label: "in", width: 1 }],
    truth_table: [],
  },
];

function initialProject(): ProjectDocumentV3 {
  return migrateV2ToV3(
    migrateV1ToV2(fromEditorDocument(createDefaultDocument())),
  );
}

function circuitDocument(circuit: ProjectCircuitV3): CircuitDocument {
  return {
    format: "logsim-ternary",
    version: 1,
    components: circuit.components,
    connections: circuit.wires.map((wire) => ({
      id: wire.id,
      sourceComponentId: wire.endpointA.componentId,
      sourcePortId: wire.endpointA.portId,
      targetComponentId: wire.endpointB.componentId,
      targetPortId: wire.endpointB.portId,
    })),
    ...(circuit.viewport ? { viewport: circuit.viewport } : {}),
  };
}

function descriptorIcon(descriptor: CatalogComponent) {
  if (descriptor.type_id === "wiring.splitter") return GitFork;
  if (descriptor.type_id === "wiring.tunnel") return Cable;
  if (descriptor.type_id === "source.trit_input") return Radio;
  if (descriptor.type_id === "source.constant") return Box;
  if (descriptor.type_id === "source.clock") return Clock3;
  if (descriptor.type_id === "sequential.dff") return PanelTop;
  if (descriptor.type_id === "sink.probe") return Gauge;
  if (descriptor.type_id.includes("mux")) return Triangle;
  if (descriptor.category === "module" || descriptor.category === "project-module") {
    return Workflow;
  }
  return CircleDot;
}

function defaultComponentProperties(
  typeId: string,
  label: string,
): Record<string, unknown> {
  const helper = WIRING_HELPERS.find((item) => item.typeId === typeId);
  if (helper) return { ...structuredClone(helper.properties), label };
  if (typeId === "source.trit_input" || typeId === "source.constant") {
    return { width: 1, value: "0", label };
  }
  if (typeId === "sink.probe") return { width: 1, label };
  return { label };
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

function wordColor(value: TernaryWord): string {
  if (value.length === 1 && value in SIGNAL_COLORS) {
    return SIGNAL_COLORS[value as TritSymbol];
  }
  if (value.includes("E")) return SIGNAL_COLORS.E;
  if (value.includes("X")) return SIGNAL_COLORS.X;
  if (value.includes("Z")) return SIGNAL_COLORS.Z;
  return "#315f66";
}

function propertyEditMessage(error: unknown): string {
  const code =
    error instanceof ProjectEditError || error instanceof HierarchyRuntimeError
      ? error.code
      : "PROPERTY_UPDATE_FAILED";
  const chinese: Record<string, string> = {
    INVALID_SIGNAL_WIDTH: "宽度必须是 1 到 27 trit",
    INVALID_SPLITTER_MAP: "分线器位映射无效",
    INVALID_WORD: "源字值必须与宽度一致且只包含 T、0、1",
    WIDTH_MISMATCH: "属性更新会造成连接线宽度不匹配",
    INVALID_PROPERTY: "属性值无效",
  };
  return `${chinese[code] ?? wasmErrorMessage(error)} [${code}]`;
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
  const structureRevision = useStore(store, (state) => state.structureRevision);
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
  const [dynamicCatalog, setDynamicCatalog] = useState<ProjectCatalogComponent[]>([]);
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
  const baseCatalogRef = useRef<CatalogComponent[]>([]);
  const runtimeActiveCircuitRef = useRef<string | null>(null);
  const pendingActiveCircuitRef = useRef<string | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const instanceRef = useRef<ReactFlowInstance<EditorNode, EditorEdge> | null>(null);
  const inputClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const decoded =
      error instanceof HierarchyRuntimeError
        ? error
        : new HierarchyRuntimeError(wasmProjectError(error));
    if (clearSnapshot) setSnapshot(null);
    setDiagnostics(decoded.diagnostics);
    setStatusMessage(`${prefix}: ${decoded.message}`);
  }, []);

  const editFailure = useCallback((prefix: string, error: unknown) => {
    if (error instanceof HierarchyRuntimeError) {
      runtimeFailure(prefix, error, false);
      return;
    }
    const code = error instanceof ProjectEditError ? ` [${error.code}]` : "";
    setStatusMessage(`${prefix}${code}: ${wasmErrorMessage(error)}`);
  }, [runtimeFailure]);

  const prepareProjectCatalog = useCallback(
    (
      nextProject: ProjectDocumentV3,
      nextActiveCircuitId: string,
    ) => {
      const interfaces = store.getState().resolveProjectModuleInterfaces();
      return {
        catalog: buildProjectCatalog(
          baseCatalogRef.current,
          nextProject,
          nextActiveCircuitId,
          interfaces,
        ),
        interfaces,
      };
    },
    [store],
  );

  const acceptProjectCatalog = useCallback(
    (prepared: ReturnType<typeof prepareProjectCatalog>) => {
      if (!prepared) return;
      setDynamicCatalog(prepared.catalog);
    },
    [],
  );

  const tickSimulation = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      setSuccessfulSnapshot(runtime.tick());
      setStatusMessage("已完成单步 Tick");
    } catch (error) {
      runtimeFailure("单步 Tick 失败", error);
    }
  }, [runtimeFailure, setSuccessfulSnapshot]);

  const restoreActiveCircuit = useCallback(() => {
    const state = store.getState();
    const circuitId = state.activePath.at(-1)?.circuitId ?? state.project.rootCircuitId;
    const circuit = state.project.circuits.find((item) => item.id === circuitId);
    if (!circuit) return;
    const next = projectToEditor(circuit, (componentId) =>
      state.resolveComponentPorts(circuitId, componentId),
    );
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
        selected: selection?.wireIds.includes(edge.id) ?? false,
      })),
    );
    setSelectedNodeId(selection?.componentIds.at(-1) ?? null);
    setSelectedEdgeIds(selection?.wireIds ?? []);
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
      const nextCatalog = prepareProjectCatalog(
        store.getState().project,
        targetCircuitId,
      );
      const nextSnapshot = runtime?.switchActive(targetCircuitId);
      if (nextSnapshot) runtimeActiveCircuitRef.current = targetCircuitId;
      acceptProjectCatalog(nextCatalog);
      if (nextSnapshot) setSuccessfulSnapshot(nextSnapshot);
      updatePath();
      restoreActiveCircuit();
      return true;
    } catch (error) {
      runtimeFailure(failurePrefix, error, false);
      return false;
    }
  }, [acceptProjectCatalog, prepareProjectCatalog, restoreActiveCircuit, runtimeFailure, setSuccessfulSnapshot, store]);

  useEffect(() => {
    let mounted = true;
    createWasmRuntime()
      .then((wasm) => {
        if (!mounted) return;
        wasmRef.current = wasm;
        const runtime = new HierarchyRuntime(wasm.projectSimulator);
        runtimeRef.current = runtime;
        const wiringCatalog: CatalogComponent[] = WIRING_HELPERS.map((helper) => ({
          type_id: helper.typeId,
          display_name: helper.displayName,
          category: "wiring",
          kind: "wiring",
          ports: wasm.resolveProjectPorts(
            helper.typeId,
            structuredClone(helper.properties),
          ),
          truth_table: [],
        }));
        const completeCatalog = [...wasm.catalog, ...wiringCatalog];
        baseCatalogRef.current = completeCatalog;
        store.getState().setPortResolver({
          resolvePorts: wasm.resolveProjectPorts,
          resolveModuleInterfaces: wasm.resolveProjectModuleInterfaces,
        });
        setBaseCatalog(completeCatalog);
        setWasmVersion(wasm.apiVersion);
        try {
          const state = store.getState();
          const currentCircuitId =
            state.activePath.at(-1)?.circuitId ?? state.project.rootCircuitId;
          const nextCatalog = prepareProjectCatalog(
            state.project,
            currentCircuitId,
          );
          const nextSnapshot = runtime.load(state.project, currentCircuitId);
          runtimeActiveCircuitRef.current = currentCircuitId;
          store.getState().setApplyProject((nextProject) => {
            const requested = pendingActiveCircuitRef.current;
            const currentState = store.getState();
            const currentActive =
              requested ??
              currentState.activePath.at(-1)?.circuitId ??
              nextProject.rootCircuitId;
            const nextActive = nextProject.circuits.some(
              (circuit) => circuit.id === currentActive,
            )
              ? currentActive
              : nextProject.rootCircuitId;
            const accepted =
              requested !== null || runtimeActiveCircuitRef.current !== nextActive
                ? runtime.load(nextProject, nextActive)
                : runtime.updateProject(nextProject);
            runtimeActiveCircuitRef.current = nextActive;
            setSuccessfulSnapshot(accepted);
          });
          acceptProjectCatalog(nextCatalog);
          setSuccessfulSnapshot(nextSnapshot);
          restoreActiveCircuit();
          setWasmState("ready");
          setStatusMessage("Rust/WASM 层级模拟器已就绪");
        } catch (error) {
          setWasmState("error");
          runtimeFailure("WASM 加载失败", error, false);
        }
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setWasmState("error");
        runtimeFailure("WASM 加载失败", error, false);
      });
    return () => {
      mounted = false;
      store.getState().setApplyProject(undefined);
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

  useEffect(() => {
    if (wasmState !== "ready") return;
    try {
      acceptProjectCatalog(
        prepareProjectCatalog(store.getState().project, activeCircuitId),
      );
    } catch (error) {
      editFailure("元件目录更新失败", error);
    }
  }, [
    acceptProjectCatalog,
    activeCircuitId,
    editFailure,
    prepareProjectCatalog,
    store,
    structureRevision,
    wasmState,
  ]);

  const applyEditorDocument = useCallback(
    (next: EditorDocument) => {
      try {
        const viewport = instanceRef.current?.getViewport();
        const saved = fromEditorDocument(next, viewport);
        store.getState().setCircuit(activeCircuitId, {
          components: saved.components,
          wires: saved.connections.map((connection) => ({
            id: connection.id,
            endpointA: {
              componentId: connection.sourceComponentId,
              portId: connection.sourcePortId,
            },
            endpointB: {
              componentId: connection.targetComponentId,
              portId: connection.targetPortId,
            },
          })),
          ...(saved.viewport ? { viewport: saved.viewport } : {}),
        });
        setNodes(next.nodes);
        setEdges(next.edges);
        return true;
      } catch (error) {
        editFailure("工程编辑失败", error);
        return false;
      }
    },
    [activeCircuitId, editFailure, store],
  );

  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const descriptor = descriptorForNode(node);
        return {
          ...node,
          data: {
            ...node.data,
            ports: node.data.ports ?? descriptor?.ports ?? [],
            inputSignals: snapshot?.inputNets[node.id] ?? {},
            outputSignals: snapshot?.componentOutputs[node.id] ?? {},
            inputWords: snapshot?.inputNetWords[node.id] ?? {},
            outputWords: snapshot?.componentOutputWords[node.id] ?? {},
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
        const signal = edgeNetValue(edge, snapshot);
        const color = wordColor(signal);
        const sourceNode = nodes.find((node) => node.id === edge.source);
        const targetNode = nodes.find((node) => node.id === edge.target);
        const sourcePortId = edge.data?.semanticSourcePortId ?? edge.sourceHandle;
        const targetPortId = edge.data?.semanticTargetPortId ?? edge.targetHandle;
        const width =
          sourceNode?.data.ports?.find((port) => port.id === sourcePortId)?.width ??
          targetNode?.data.ports?.find((port) => port.id === targetPortId)?.width ??
          signal.length;
        const tunnelNode = [sourceNode, targetNode].find(
          (node) => node?.data.typeId === "wiring.tunnel",
        );
        const localName =
          typeof tunnelNode?.data.properties?.label === "string"
            ? tunnelNode.data.properties.label
            : tunnelNode?.data.typeId === "wiring.tunnel"
              ? tunnelNode.data.label
              : undefined;
        return {
          ...edge,
          type: "logic" as const,
          data: {
            ...edge.data,
            ...wireLanes[edge.id],
            semanticWidth: width,
            currentWord: signal,
            ...(localName ? { localName } : {}),
          },
          style: {
            stroke: width > 1 ? "#426a70" : color,
            strokeWidth: width > 1 ? 6 : 2,
          },
        };
      }),
    [edges, nodes, snapshot, wireLanes],
  );

  const validateUiConnection = useCallback(
    (connection: ConnectionCandidate) => {
      return validateConnection(connection, { nodes, edges });
    },
    [edges, nodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const result = validateUiConnection(connection);
      if (!result.valid) {
        const messages = {
          duplicate: "已拒绝完全重复的连线",
          missing_endpoint: "连线端点不存在",
          same_endpoint: "连线失败: 不能连接同一端口",
          width_mismatch: "连线失败: 两端信号宽度不一致",
        };
        setStatusMessage(messages[result.reason]);
        return;
      }
      try {
        if (!connection.source || !connection.sourceHandle || !connection.target || !connection.targetHandle) {
          setStatusMessage("连线失败: 连线端点不存在");
          return;
        }
        const sourceNode = nodes.find((node) => node.id === connection.source);
        const targetNode = nodes.find((node) => node.id === connection.target);
        const sourcePortId = semanticPortIdForHandle(
          sourceNode?.data.ports ?? [],
          connection.sourceHandle,
        );
        const targetPortId = semanticPortIdForHandle(
          targetNode?.data.ports ?? [],
          connection.targetHandle,
        );
        if (!sourcePortId || !targetPortId) {
          setStatusMessage("连线失败: 连线端点不存在");
          return;
        }
        store.getState().addWire(activeCircuitId, {
          id: makeConnectionId(edges),
          endpointA: {
            componentId: connection.source,
            portId: sourcePortId,
          },
          endpointB: {
            componentId: connection.target,
            portId: targetPortId,
          },
        });
        restoreActiveCircuit();
        setStatusMessage("连线已添加");
      } catch (error) {
        const code = error instanceof ProjectEditError ? ` [${error.code}]` : "";
        if (error instanceof HierarchyRuntimeError) {
          setDiagnostics(error.diagnostics);
        }
        setStatusMessage(`连线失败${code}: ${wasmErrorMessage(error)}`);
      }
    },
    [activeCircuitId, edges, nodes, restoreActiveCircuit, store, validateUiConnection],
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
      const label = DISPLAY_NAMES[typeId] ?? descriptor.display_name;
      try {
        store.getState().addComponent(activeCircuitId, {
          id,
          typeId,
          position: nextPosition,
          properties: defaultComponentProperties(typeId, label),
        });
        store.getState().setSelection(activeCircuitId, [id], []);
        const state = store.getState();
        const circuit = state.project.circuits.find(
          (item) => item.id === activeCircuitId,
        );
        const projected = circuit
          ? projectToEditor(circuit, (componentId) =>
              state.resolveComponentPorts(activeCircuitId, componentId),
            ).nodes.find((node) => node.id === id)
          : undefined;
        if (!projected) throw new Error(`无法投影新元件 '${id}'`);
        setNodes((current) => [
          ...current.map((node) => ({ ...node, selected: false })),
          { ...projected, selected: true },
        ]);
        setSelectedNodeId(id);
        setSelectedEdgeIds([]);
        setStatusMessage(`已添加${label}`);
      } catch (error) {
        editFailure("元件添加失败", error);
      }
    },
    [activeCircuitId, baseByType, editFailure, nodes, store],
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
        restoreActiveCircuit();
        setSelectedNodeId(id);
        setStatusMessage(`已放置模块 ${module.name}`);
      } catch (error) {
        editFailure("模块放置失败", error);
      }
    },
    [activeCircuitId, editFailure, nodes, project.circuits, restoreActiveCircuit, store],
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
      editFailure("新建模块失败", error);
    }
  }, [commitNavigation, editFailure, store]);

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
      try {
        store.getState().addComponent(activeCircuit.id, {
          id,
          typeId: `project.module_${direction}`,
          position: { x: direction === "input" ? 80 : 650, y: 100 + count * 150 },
          properties:
            direction === "input"
              ? { portId, label: `Input ${count + 1}`, width: 1, previewValue: "0" }
              : { portId, label: `Output ${count + 1}`, width: 1 },
        });
        restoreActiveCircuit();
      } catch (error) {
        editFailure("模块端口添加失败", error);
      }
    },
    [activeCircuit, editFailure, restoreActiveCircuit, store],
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
      const next = cycleKnownWord(current);
      try {
        store.getState().setSource(activeCircuitId, node.id, next);
        setNodes((items) =>
          items.map((item) =>
            item.id === node.id
              ? { ...item, data: { ...item.data, sourceValue: next } }
              : item,
          ),
        );
        setStatusMessage(`输入 ${node.id}: ${current} -> ${next}`);
      } catch (error) {
        editFailure("输入更新失败", error);
      }
    },
    [activeCircuitId, editFailure, store],
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
    ],
  );

  const deleteSelected = useCallback(() => {
    const selectedId = selectedNodeId ?? nodes.find((node) => node.selected)?.id;
    const selectedNode = nodes.find((node) => node.id === selectedId);
    if (selectedNode?.data.typeId === "project.module_input" || selectedNode?.data.typeId === "project.module_output") {
      try {
        store.getState().deleteModulePort(activeCircuitId, selectedNode.id);
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
    const committed = applyEditorDocument({
      nodes: nodes.filter((node) => !nodeIds.has(node.id)),
      edges: edges.filter(
        (edge) =>
          !edgeIds.has(edge.id) &&
          !nodeIds.has(edge.source) &&
          !nodeIds.has(edge.target),
      ),
    });
    if (!committed) return;
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
  ]);

  const deleteModule = useCallback(
    (moduleId: string) => {
      try {
        store.getState().deleteModule(moduleId);
        restoreActiveCircuit();
        setStatusMessage("模块已删除");
      } catch (error) {
        editFailure("删除受保护", error);
      }
    },
    [editFailure, restoreActiveCircuit, store],
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
        restoreActiveCircuit();
        setStatusMessage(`模块已重命名为 ${name}`);
      } catch (error) {
        editFailure("模块重命名失败", error);
      }
    },
    [editFailure, restoreActiveCircuit, store],
  );

  const historyStep = useCallback(
    (direction: "undo" | "redo") => {
      persistViewport();
      try {
        store.getState()[direction]();
        restoreActiveCircuit();
        setStatusMessage(direction === "undo" ? "已撤销上一步编辑" : "已重做编辑");
      } catch (error) {
        editFailure("历史恢复失败", error);
      }
    },
    [editFailure, persistViewport, restoreActiveCircuit, store],
  );

  const loadProject = useCallback(
    (nextProject: ProjectDocumentV3, message: string) => {
      try {
        pendingActiveCircuitRef.current = nextProject.rootCircuitId;
        store.getState().replaceProject(nextProject);
        restoreActiveCircuit();
        setStatusMessage(message);
      } catch (error) {
        runtimeFailure("工程加载失败", error, false);
        restoreActiveCircuit();
      } finally {
        pendingActiveCircuitRef.current = null;
      }
    },
    [restoreActiveCircuit, runtimeFailure, store],
  );

  const loadExample = useCallback(
    (exampleId: ExampleId) => {
      const legacy =
        cloneExampleProject(exampleId) ??
        migrateV1ToV2(fromEditorDocument(cloneExampleDocument(exampleId)));
      const next = migrateV2ToV3(legacy);
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
    try {
      store.getState().setCircuit(activeCircuitId, {
        components: [],
        wires: [],
      });
      setNodes([]);
      setEdges([]);
      setSelectedNodeId(null);
      setSelectedEdgeIds([]);
      setStatusMessage("画布已清空");
    } catch (error) {
      editFailure("清空失败", error);
    }
  }, [activeCircuitId, editFailure, store]);

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
  const selectedComponent = selectedNode
    ? activeCircuit.components.find(
        (component) => component.id === selectedNode.id,
      ) ?? null
    : null;

  const commitSelectedProperties = useCallback(
    (properties: Record<string, unknown>): string | undefined => {
      if (!selectedNodeId) return "没有选中的元件 [UNKNOWN_COMPONENT]";
      try {
        store
          .getState()
          .setComponentProperties(activeCircuitId, selectedNodeId, properties);
        restoreActiveCircuit();
        setStatusMessage("属性已更新");
        return undefined;
      } catch (error) {
        if (error instanceof HierarchyRuntimeError) {
          setDiagnostics(error.diagnostics);
        }
        const message = propertyEditMessage(error);
        setStatusMessage(`属性更新失败: ${message}`);
        return message;
      }
    },
    [activeCircuitId, restoreActiveCircuit, selectedNodeId, store],
  );

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
          <span>PHASE 3B</span>
        </div>
        <div className={`toolbar ${mobileMenuOpen ? "is-open" : ""}`} role="toolbar" aria-label="画布工具">
          <button className="mobile-only icon-button" type="button" title="打开工具菜单" aria-label="打开工具菜单" aria-expanded={mobileMenuOpen} aria-controls="mobile-toolbar-menu" onClick={() => setMobileMenuOpen((value) => !value)}><Menu aria-hidden="true" /></button>
          <button className="mobile-only icon-button" type="button" title="元件库" aria-label="切换元件库" aria-expanded={paletteOpen} aria-controls="component-palette" onClick={() => { setPaletteOpen((value) => !value); setInspectorOpen(false); }}><PanelLeft aria-hidden="true" /></button>
          <button className="mobile-only icon-button" type="button" title="检查器" aria-label="切换检查器" aria-expanded={inspectorOpen} aria-controls="component-inspector" onClick={() => { setInspectorOpen((value) => !value); setPaletteOpen(false); }}><PanelRight aria-hidden="true" /></button>
          <div className="toolbar-menu" id="mobile-toolbar-menu">
            <button className="icon-button" type="button" title="撤销" aria-label="撤销" disabled={!canUndo} onClick={() => historyStep("undo")}><Undo2 aria-hidden="true" /></button>
            <button className="icon-button" type="button" title="重做" aria-label="重做" disabled={!canRedo} onClick={() => historyStep("redo")}><Redo2 aria-hidden="true" /></button>
            <button className="icon-button" type="button" title="单步 Tick" aria-label="单步 Tick" disabled={wasmState !== "ready" || !snapshot} onClick={tickSimulation}><StepForward aria-hidden="true" /></button>
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
          {["source", "wiring", "gate", "module", "sequential", "sink"].map((category) => (
            <section className="palette-group" key={category}>
              <h2>{category === "source" ? "输入与常量" : category === "sink" ? "观测" : category === "wiring" ? "布线" : category === "module" ? "算术模块" : category === "sequential" ? "时序" : "逻辑门"}</h2>
              {baseCatalog.filter((item) => item.category === category).map((descriptor) => {
                const Icon = descriptorIcon(descriptor);
                const name = DISPLAY_NAMES[descriptor.type_id] ?? descriptor.display_name;
                return (
                  <button type="button" className="palette-item" key={descriptor.type_id} aria-label={`添加${name}`} title={`添加${name}`} draggable onDragStart={(event) => { event.dataTransfer.setData("application/logsim-component", descriptor.type_id); event.dataTransfer.effectAllowed = "copy"; }} onClick={() => addBuiltin(descriptor.type_id)}>
                    <Icon aria-hidden="true" /><span><strong>{name}</strong><small>{descriptor.ports.length} PORTS</small></span><Plus aria-hidden="true" />
                  </button>
                );
              })}
            </section>
          ))}
        </aside>

        <section className="canvas" aria-label="电路画布" data-wire-state={JSON.stringify(renderedEdges.map((edge) => ({ id: edge.id, source: edge.source, sourcePort: edge.data?.semanticSourcePortId ?? edge.sourceHandle, target: edge.target, targetPort: edge.data?.semanticTargetPortId ?? edge.targetHandle, signal: edge.data?.currentWord, width: edge.data?.semanticWidth, name: edge.data?.localName })))} ref={flowRef} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); const typeId = event.dataTransfer.getData("application/logsim-component"); if (typeId && instanceRef.current) addBuiltin(typeId, instanceRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}>
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
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onNodeDragStop={handleNodeDragStop}
              onSelectionChange={handleSelectionChange}
              connectionMode={ConnectionMode.Loose}
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
          {selectedNode && selectedDescriptor ? <><NodeInspector node={selectedNode} descriptor={selectedDescriptor} snapshot={snapshot} />{selectedComponent && <PropertyEditor key={`${activeCircuitId}/${selectedComponent.id}`} typeId={selectedComponent.typeId} properties={selectedComponent.properties} onCommit={commitSelectedProperties} />}</> : <ExampleHelp example={EXAMPLES.find((item) => item.id === activeExampleId) ?? EXAMPLES[0]} />}
          <Diagnostics diagnostics={diagnostics} onNavigate={navigateDiagnostic} />
        </aside>
      </div>

      {exampleLibraryOpen && <ExampleLibrary examples={EXAMPLES} onClose={() => setExampleLibraryOpen(false)} onLoad={loadExample} />}
      <footer className="statusbar"><span className={`status-dot state-${wasmState}`} /><strong>{statusMessage}</strong><span className="status-separator" /><span>{snapshot ? snapshot.stable ? "STABLE" : "UNSTABLE" : "NO SNAPSHOT"}</span><span>{snapshot?.tickCount ?? 0} TICKS</span><span>{snapshot?.compileCount ?? 0} COMPILES</span><span>{diagnostics.length} DIAGNOSTICS</span><span className="status-spacer" /><span>{nodes.length} NODES</span><span>{edges.length} WIRES</span></footer>
    </main>
  );
}

function ExampleHelp({ example }: { example: TernaryExample }) {
  return (
    <section className="inspector-section example-help"><span className="type-chip">当前示例</span><h2>{example.name}</h2><div className="example-path"><span>{example.composition}</span></div><p>{example.description}</p><p className="example-expected">{example.expected}</p><dl className="ternary-key"><div><dt className="signal-T">T</dt><dd>-1，负一</dd></div><div><dt className="signal-0">0</dt><dd>0，中性值</dd></div><div><dt className="signal-1">1</dt><dd>+1，正一</dd></div></dl></section>
  );
}

function SignalRows({ title, values }: { title: string; values: Record<string, TernaryWord> }) {
  return <div className="signal-group"><h3>{title}</h3>{Object.keys(values).length === 0 ? <span className="muted">无端口</span> : Object.entries(values).map(([port, value]) => <div className="signal-row" key={port}><code>{port}</code><strong style={{ color: wordColor(value) }}>{value}</strong></div>)}</div>;
}

function NodeInspector({ node, descriptor, snapshot }: { node: EditorNode; descriptor: CatalogComponent; snapshot: ProjectSimulationSnapshot | null }) {
  const inputValues = { ...(snapshot?.inputNets[node.id] ?? {}), ...(snapshot?.inputNetWords[node.id] ?? {}) };
  const outputValues = { ...(snapshot?.componentOutputs[node.id] ?? {}), ...(snapshot?.componentOutputWords[node.id] ?? {}) };
  const resolvedPorts = node.data.ports ?? descriptor.ports;
  const inputPorts = resolvedPorts.filter((port) => port.direction !== "output");
  const outputPorts = resolvedPorts.filter((port) => port.direction !== "input");
  const help = COMPONENT_HELP[descriptor.type_id];
  return <><section className="inspector-section selected-component"><span className="type-chip">{descriptor.category.toUpperCase()}</span><h2>{node.data.label}</h2><dl className="metadata"><div><dt>稳定 ID</dt><dd>{node.id}</dd></div><div><dt>类型</dt><dd>{descriptor.type_id}</dd></div></dl><div className="signal-columns"><SignalRows title="输入" values={inputValues} /><SignalRows title="输出" values={outputValues} /></div></section>{help && <section className="inspector-section component-help"><h2>中文说明</h2><p>{help.summary}</p><p>{help.details}</p></section>}{["gate", "module"].includes(descriptor.category) && descriptor.truth_table.length > 0 && <section className="inspector-section truth-table-section"><h2>真值表</h2><div className="truth-table-wrap"><table><thead><tr>{inputPorts.map((port) => <th key={port.id}>{port.id}</th>)}{outputPorts.map((port) => <th className="output-column" key={port.id}>{port.id}</th>)}</tr></thead><tbody>{descriptor.truth_table.map((row, rowIndex) => <tr key={rowIndex}>{[...row.inputs, ...row.outputs].map((value, index) => <td className={`signal-${value}`} key={`${rowIndex}-${index}`} style={{ color: SIGNAL_COLORS[value] }}>{value}</td>)}</tr>)}</tbody></table></div></section>}</>;
}

function Diagnostics({ diagnostics, onNavigate }: { diagnostics: ProjectSimulationDiagnostic[]; onNavigate: (diagnostic: ProjectSimulationDiagnostic) => void }) {
  return <section className="inspector-section diagnostics-section"><div className="section-heading"><h2>诊断</h2><span>{diagnostics.length}</span></div>{diagnostics.length === 0 ? <p className="muted">当前没有诊断信息。</p> : <ul>{diagnostics.map((diagnostic, index) => <li className={`diagnostic diagnostic-${diagnostic.severity}`} key={`${diagnostic.code}-${index}`}><button type="button" disabled={!diagnostic.primaryLocation} onClick={() => onNavigate(diagnostic)}><strong>{diagnostic.code}</strong><span>{diagnostic.message}</span></button></li>)}</ul>}</section>;
}

export function App() {
  return <ReactFlowProvider><Workbench /></ReactFlowProvider>;
}
