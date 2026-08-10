import type { CatalogPort } from "../editor-model";

export type EditorHandleRole = "source" | "target";

const HANDLE_PREFIX = "logsim-port";

export function editorHandleId(
  portId: string,
  role: EditorHandleRole,
): string {
  return `${HANDLE_PREFIX}:${role}:${encodeURIComponent(portId)}`;
}

export function portForEditorHandle(
  ports: ReadonlyArray<CatalogPort>,
  handleId: string | null | undefined,
): CatalogPort | undefined {
  if (!handleId) return undefined;
  return ports.find(
    (port) =>
      editorHandleId(port.id, "source") === handleId ||
      editorHandleId(port.id, "target") === handleId,
  ) ?? ports.find((port) => port.id === handleId);
}

export function semanticPortIdForHandle(
  ports: ReadonlyArray<CatalogPort>,
  handleId: string | null | undefined,
): string | undefined {
  return portForEditorHandle(ports, handleId)?.id;
}
