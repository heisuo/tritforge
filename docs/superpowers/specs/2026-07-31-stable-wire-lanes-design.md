# Stable Wire Lanes Design

## Goal

Replace React Flow's independent `smoothstep` routing with stable orthogonal
wire lanes so fan-out and fan-in wires do not hide each other along long
shared segments.

## Scope

- Preserve manually positioned nodes and the existing circuit document format.
- Split wires shortly after a shared source and shortly before a shared target.
- Assign lanes from topology and node positions, never from live signal values.
- Keep a short common stub for a true fan-out because it represents one net.
- Use rounded orthogonal paths and retain the current signal colors and labels.

This first routing layer does not promise globally crossing-free or
obstacle-avoiding paths. Those require editable waypoints or a global router
such as ELK and remain later work.

## Architecture

`wire-routing.ts` owns deterministic lane assignment and SVG path generation.
It accepts small geometry records and returns lane metadata, making the
algorithm testable without React Flow or a browser.

`LogicWireEdge.tsx` is a presentation component. It receives React Flow edge
coordinates plus lane metadata, renders the generated path through `BaseEdge`,
and places the signal label on the path's central track.

`App.tsx` enriches each displayed edge with routing geometry derived from the
current node positions. Stored `EditorEdge` objects and WASM circuit
connections remain unchanged.

## Routing Rules

1. Group wires by `source + sourceHandle` and independently by
   `target + targetHandle`.
2. Sort source groups by target Y, target X, then edge ID. Sort target groups
   by source Y, source X, then edge ID.
3. Assign zero-based source and target lane indices.
4. Start each first turn at `28px + lane * 14px` from its endpoint.
5. Offset the middle track by the centered source lane for fan-out, otherwise
   by the centered target lane for fan-in.
6. Use the edge ID only as a final tie-breaker, so signal updates cannot move a
   wire.
7. Fall back to a simple midpoint route when nodes are too close to fit all
   endpoint lanes.

## Verification

- Unit tests cover fan-out separation, fan-in separation, input-order
  independence, and distinct generated SVG paths.
- Existing editor and example tests must remain green.
- TypeScript build and Vite production build must pass.
- Desktop and mobile screenshots must show visible, non-overlapping fan-out
  branches without UI overlap.
