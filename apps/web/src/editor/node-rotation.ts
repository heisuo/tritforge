export type NodeRotation = 0 | 90 | 180 | 270;
export type NodeSide = "left" | "top" | "right" | "bottom";

const ROTATIONS: NodeRotation[] = [0, 90, 180, 270];
const SIDES: NodeSide[] = ["left", "top", "right", "bottom"];

export function isNodeRotation(value: unknown): value is NodeRotation {
  return ROTATIONS.includes(value as NodeRotation);
}

export function rotateClockwise(rotation: NodeRotation): NodeRotation {
  return ROTATIONS[(ROTATIONS.indexOf(rotation) + 1) % ROTATIONS.length];
}

export function rotateCounterClockwise(rotation: NodeRotation): NodeRotation {
  return ROTATIONS[(ROTATIONS.indexOf(rotation) + ROTATIONS.length - 1) % ROTATIONS.length];
}

export function rotatedSide(side: NodeSide, rotation: NodeRotation): NodeSide {
  return SIDES[(SIDES.indexOf(side) + rotation / 90) % SIDES.length];
}
