import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  type EdgeProps,
} from "@xyflow/react";
import type { CSSProperties } from "react";
import type { EditorEdge } from "./editor-model";
import { createLogicWirePath } from "./wire-routing";

export function LogicWireEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
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
    sourceSide: sourcePosition === Position.Left ? "left" : "right",
    targetSide: targetPosition === Position.Right ? "right" : "left",
    sourceNodeId: source,
    targetNodeId: target,
    obstacles: data?.routeObstacles,
    sourceLane: data?.sourceLane ?? 0,
    sourceLaneCount: data?.sourceLaneCount ?? 1,
    targetLane: data?.targetLane ?? 0,
    targetLaneCount: data?.targetLaneCount ?? 1,
  });

  return (
    <>
      <path
        d={route.path}
        className="wire-bridge-gap"
        style={{
          strokeWidth:
            (typeof style?.strokeWidth === "number" ? style.strokeWidth : 2) + 5,
        }}
      />
      <BaseEdge
        id={id}
        path={route.path}
        style={style}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
      />
      <EdgeLabelRenderer>
        <div
          className={`wire-label ${data?.semanticWidth && data.semanticWidth > 1 ? "is-bus" : ""} ${selected ? "is-selected" : ""}`}
          style={
            {
              transform: `translate(-50%, -50%) translate(${route.labelX}px, ${route.labelY}px)`,
              "--wire-signal-color": selected
                ? "#1867d2"
                : (data?.signalColor ?? "#526168"),
            } as CSSProperties
          }
          data-testid={`wire-label-${id}`}
        >
          {data?.localName && (
            <span className="wire-name">{data.localName}</span>
          )}
          <span className="wire-width">{data?.semanticWidth ?? 1}t</span>
          <strong>{data?.displayWord ?? data?.currentWord ?? "Z"}</strong>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
