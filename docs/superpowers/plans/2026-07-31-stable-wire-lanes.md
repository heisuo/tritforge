# Stable Wire Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic orthogonal wire lanes that separate fan-out and
fan-in paths without changing circuit semantics or node positions.

**Architecture:** A pure routing module assigns endpoint lanes and generates
SVG paths. A custom React Flow edge renders those paths, while `App.tsx`
attaches derived routing metadata to displayed edges.

**Tech Stack:** TypeScript, React 19, React Flow 12, Vitest, Vite

---

### Task 1: Test the routing contract

**Files:**
- Create: `apps/web/tests/wire-routing.test.ts`

- [ ] Add tests that call `assignWireLanes()` with shuffled fan-out and fan-in
      inputs and assert stable, distinct indices ordered by endpoint geometry.
- [ ] Add a test that calls `createLogicWirePath()` for two lanes and asserts
      distinct SVG paths, label coordinates, and a short common source stub.
- [ ] Run `npm test -- wire-routing.test.ts` and confirm failure because
      `../src/wire-routing` does not exist.

### Task 2: Implement pure routing

**Files:**
- Create: `apps/web/src/wire-routing.ts`

- [ ] Define `WireGeometry`, `WireLaneAssignment`, and `LogicWireRoute` types.
- [ ] Implement stable grouping and sorting in `assignWireLanes(wires)`.
- [ ] Implement `createLogicWirePath(args)` with 28px endpoint stubs, 14px
      lane spacing, rounded orthogonal corners, and a close-node fallback.
- [ ] Run `npm test -- wire-routing.test.ts` and confirm all routing tests pass.

### Task 3: Render custom logic wires

**Files:**
- Create: `apps/web/src/LogicWireEdge.tsx`
- Modify: `apps/web/src/editor-model.ts`
- Modify: `apps/web/src/App.tsx`

- [ ] Define typed edge data containing source/target lane indices and counts.
- [ ] Render the pure route with React Flow `BaseEdge` and `EdgeLabelRenderer`.
- [ ] Derive lane assignments from node positions in `App.tsx`, set displayed
      edge type to `logic`, and register `edgeTypes`.
- [ ] Preserve edge selection, deletion, labels, signal colors, and the stored
      circuit connection format.

### Task 4: Verify behavior

**Files:**
- Modify only if a verified defect is found.

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Start or reuse Vite and verify `http://127.0.0.1:5173/` returns HTTP 200.
- [ ] Capture desktop and mobile screenshots of fan-out examples and inspect
      them for hidden branches, blank rendering, and UI overlap.
- [ ] Run `git diff --check` and inspect `git status --short`.
