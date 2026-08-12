# Node Context Menu and Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent node context menu with four-direction rotation and deletion.

**Architecture:** Store rotation as editor-only top-level component metadata, project it into React Flow node data, and use pure orientation helpers to map logical input/output sides to physical Handle positions. Keep simulation properties and Rust lowering unchanged.

**Tech Stack:** TypeScript, React 19, React Flow 12, Vitest, Playwright.

---

### Task 1: Persistent Rotation Contract

**Files:**
- Create: `apps/web/src/editor/node-rotation.ts`
- Modify: `apps/web/src/editor/circuit-document.ts`
- Modify: `apps/web/src/project/project-document.ts`
- Modify: `apps/web/src/project/project-v3.ts`
- Test: `apps/web/tests/node-rotation.test.ts`
- Test: `apps/web/tests/project-v3.test.ts`

- [x] Write failing tests asserting clockwise cycle `0 -> 90 -> 180 -> 270 -> 0`, strict rejection of unsupported values, and v3 parse/serialize round trips.
- [x] Run `npx vitest run tests/node-rotation.test.ts tests/project-v3.test.ts` and confirm failures are caused by the missing rotation contract.
- [x] Add `NodeRotation`, normalization/step helpers, optional `rotation` to `EditorComponent`, and strict component parsing for the four allowed values.
- [x] Re-run the focused tests and confirm they pass.

### Task 2: Rotation-Aware Node Projection and Geometry

**Files:**
- Modify: `apps/web/src/editor-model.ts`
- Modify: `apps/web/src/editor/circuit-document.ts`
- Modify: `apps/web/src/project/editor-projection.ts`
- Modify: `apps/web/src/CircuitNode.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/tests/node-rotation.test.ts`
- Test: `apps/web/tests/editor-projection.test.ts`

- [x] Write failing tests for logical left/right side mapping at all four rotations and projection of component rotation into node data.
- [x] Run focused tests and confirm the missing mapping/projection failures.
- [x] Map logical sides to `Position.Left/Top/Right/Bottom`, render top/bottom port rows for quarter turns, and swap stable node dimensions without rotating text.
- [x] Re-run focused tests and TypeScript compilation.

### Task 3: Context Menu Commands

**Files:**
- Create: `apps/web/src/components/NodeContextMenu.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/tests/app.test.tsx`

- [x] Write failing interaction tests for opening on node right-click, clockwise/anticlockwise commands, outside/Escape close, viewport clamping, and delete.
- [x] Run the test and confirm the menu is absent.
- [x] Add controlled context-menu state, selection synchronization, command handlers using `setCircuit`, and accessible icon buttons with Chinese labels.
- [x] Re-run the interaction tests and TypeScript compilation.

### Task 4: Desktop Browser Acceptance

**Files:**
- Create: `apps/web/tests/node-context-menu.spec.ts`
- Modify: `apps/web/playwright.config.ts`

- [x] Add a 1440x900 test that places and connects two components, rotates one through all directions, checks Handle geometry and retained wire count, reloads the example/project state, and deletes through the menu.
- [x] Run `npx playwright test tests/node-context-menu.spec.ts --project=chromium` and inspect the screenshot.
- [x] Run `npx vitest run`, `npx tsc -b && npx vite build`, and focused Counter3/Bus Wiring Playwright regression tests.
- [x] Commit the implementation after `git diff --check` and a clean status review.
