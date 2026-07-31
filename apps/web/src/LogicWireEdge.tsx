import { BaseEdge, type EdgeProps } from "@xyflow/react";
import type { EditorEdge } from "./editor-model";
import { createLogicWirePath } from "./wire-routing";

export function LogicWireEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  style,
  markerStart,
  markerEnd,
  interactionWidth,
}: EdgeProps<EditorEdge>) {
  const route = createLogicWirePath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourceLane: data?.sourceLane ?? 0,
    sourceLaneCount: data?.sourceLaneCount ?? 1,
    targetLane: data?.targetLane ?? 0,
    targetLaneCount: data?.targetLaneCount ?? 1,
  });

  return (
    <BaseEdge
      id={id}
      path={route.path}
      labelX={route.labelX}
      labelY={route.labelY}
      label={label}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      style={style}
      markerStart={markerStart}
      markerEnd={markerEnd}
      interactionWidth={interactionWidth}
    />
  );
}
