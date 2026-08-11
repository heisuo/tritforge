import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { EditorEdge } from "./editor-model";
import { createLogicWirePath } from "./wire-routing";

export function LogicWireEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
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
    sourceLane: data?.sourceLane ?? 0,
    sourceLaneCount: data?.sourceLaneCount ?? 1,
    targetLane: data?.targetLane ?? 0,
    targetLaneCount: data?.targetLaneCount ?? 1,
  });

  return (
    <>
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
          className={`wire-label ${data?.semanticWidth && data.semanticWidth > 1 ? "is-bus" : ""}`}
          style={
            {
              transform: `translate(-50%, -50%) translate(${route.labelX}px, ${route.labelY}px)`,
              "--wire-signal-color": data?.signalColor ?? "#526168",
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
