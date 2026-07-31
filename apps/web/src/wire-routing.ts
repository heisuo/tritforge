export interface WirePoint {
  x: number;
  y: number;
}

export interface WireGeometry {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  sourcePosition: WirePoint;
  targetPosition: WirePoint;
}

export interface WireLaneAssignment {
  sourceLane: number;
  sourceLaneCount: number;
  targetLane: number;
  targetLaneCount: number;
}

export interface LogicWirePathArgs extends WireLaneAssignment {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}

export interface LogicWireRoute {
  path: string;
  labelX: number;
  labelY: number;
  points: WirePoint[];
}

const ENDPOINT_STUB = 28;
const LANE_SPACING = 14;
const CORNER_RADIUS = 6;
const MIN_MIDDLE_TRACK = 24;

function endpointKey(nodeId: string, handleId?: string | null): string {
  return `${nodeId}\u0000${handleId ?? ""}`;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function groupWires(
  wires: WireGeometry[],
  keyFor: (wire: WireGeometry) => string,
): Map<string, WireGeometry[]> {
  const groups = new Map<string, WireGeometry[]>();
  for (const wire of wires) {
    const key = keyFor(wire);
    const group = groups.get(key);
    if (group) {
      group.push(wire);
    } else {
      groups.set(key, [wire]);
    }
  }
  return groups;
}

export function assignWireLanes(
  wires: WireGeometry[],
): Record<string, WireLaneAssignment> {
  const assignments = Object.fromEntries(
    wires.map((wire) => [
      wire.id,
      {
        sourceLane: 0,
        sourceLaneCount: 1,
        targetLane: 0,
        targetLaneCount: 1,
      },
    ]),
  ) as Record<string, WireLaneAssignment>;

  const sourceGroups = groupWires(wires, (wire) =>
    endpointKey(wire.source, wire.sourceHandle),
  );
  for (const group of sourceGroups.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.targetPosition.y - right.targetPosition.y ||
        left.targetPosition.x - right.targetPosition.x ||
        compareText(left.target, right.target) ||
        compareText(left.targetHandle ?? "", right.targetHandle ?? "") ||
        compareText(left.id, right.id),
    );
    ordered.forEach((wire, index) => {
      assignments[wire.id].sourceLane = index;
      assignments[wire.id].sourceLaneCount = ordered.length;
    });
  }

  const targetGroups = groupWires(wires, (wire) =>
    endpointKey(wire.target, wire.targetHandle),
  );
  for (const group of targetGroups.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.sourcePosition.y - right.sourcePosition.y ||
        left.sourcePosition.x - right.sourcePosition.x ||
        compareText(left.source, right.source) ||
        compareText(left.sourceHandle ?? "", right.sourceHandle ?? "") ||
        compareText(left.id, right.id),
    );
    ordered.forEach((wire, index) => {
      assignments[wire.id].targetLane = index;
      assignments[wire.id].targetLaneCount = ordered.length;
    });
  }

  return assignments;
}

function distance(left: WirePoint, right: WirePoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function roundedOrthogonalPath(points: WirePoint[]): string {
  if (points.length === 0) {
    return "";
  }

  let path = `M ${formatNumber(points[0].x)} ${formatNumber(points[0].y)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const incoming = distance(previous, current);
    const outgoing = distance(current, next);
    const radius = Math.min(CORNER_RADIUS, incoming / 2, outgoing / 2);

    if (radius === 0) {
      continue;
    }

    const before = {
      x: current.x + ((previous.x - current.x) / incoming) * radius,
      y: current.y + ((previous.y - current.y) / incoming) * radius,
    };
    const after = {
      x: current.x + ((next.x - current.x) / outgoing) * radius,
      y: current.y + ((next.y - current.y) / outgoing) * radius,
    };
    path += ` L ${formatNumber(before.x)} ${formatNumber(before.y)}`;
    path += ` Q ${formatNumber(current.x)} ${formatNumber(current.y)}`;
    path += ` ${formatNumber(after.x)} ${formatNumber(after.y)}`;
  }

  const last = points.at(-1)!;
  return `${path} L ${formatNumber(last.x)} ${formatNumber(last.y)}`;
}

function removeConsecutiveDuplicates(points: WirePoint[]): WirePoint[] {
  return points.filter(
    (point, index) =>
      index === 0 ||
      point.x !== points[index - 1].x ||
      point.y !== points[index - 1].y,
  );
}

export function createLogicWirePath(
  args: LogicWirePathArgs,
): LogicWireRoute {
  const {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourceLane,
    sourceLaneCount,
    targetLane,
    targetLaneCount,
  } = args;
  const direction = targetX >= sourceX ? 1 : -1;
  const horizontalDistance = Math.abs(targetX - sourceX);
  const sourceDepth = ENDPOINT_STUB + sourceLane * LANE_SPACING;
  const targetDepth = ENDPOINT_STUB + targetLane * LANE_SPACING;
  const lanesFit =
    horizontalDistance >= sourceDepth + targetDepth + MIN_MIDDLE_TRACK;

  const sourceTurnX = lanesFit
    ? sourceX + direction * sourceDepth
    : (sourceX + targetX) / 2;
  const targetTurnX = lanesFit
    ? targetX - direction * targetDepth
    : (sourceX + targetX) / 2;

  const activeLane =
    sourceLaneCount > 1
      ? sourceLane - (sourceLaneCount - 1) / 2
      : targetLaneCount > 1
        ? targetLane - (targetLaneCount - 1) / 2
        : 0;
  const middleY =
    (sourceY + targetY) / 2 + activeLane * LANE_SPACING;

  const points = removeConsecutiveDuplicates([
    { x: sourceX, y: sourceY },
    { x: sourceTurnX, y: sourceY },
    { x: sourceTurnX, y: middleY },
    { x: targetTurnX, y: middleY },
    { x: targetTurnX, y: targetY },
    { x: targetX, y: targetY },
  ]);

  return {
    path: roundedOrthogonalPath(points),
    labelX: (sourceTurnX + targetTurnX) / 2,
    labelY: middleY,
    points,
  };
}
