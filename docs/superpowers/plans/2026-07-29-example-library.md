# Ternary Example Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a five-circuit example library and Chinese explanations for all phase-one components.

**Architecture:** Immutable example documents and component help text live in focused data
modules. A modal library selects a document; `App` replaces editor state and reloads the
existing Rust/WASM simulator.

**Tech Stack:** React 19, TypeScript, React Flow, Lucide React, Vitest, Rust/WASM.

---

### Task 1: Define Examples and Help Text

**Files:**
- Create: `apps/web/src/examples.ts`
- Create: `apps/web/src/component-help.ts`
- Create: `apps/web/tests/examples.test.ts`

- [ ] Write failing tests asserting five stable example IDs, unique graph IDs, valid
  connection endpoints, deep-cloned documents, and help text for all 12 type IDs.
- [ ] Run `npm --prefix apps/web test -- examples.test.ts` and confirm the modules are missing.
- [ ] Implement `EXAMPLES`, `cloneExampleDocument`, and `COMPONENT_HELP`.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Add the Example Library UI

**Files:**
- Create: `apps/web/src/ExampleLibrary.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] Add a toolbar button using Lucide `Library`.
- [ ] Add an accessible dialog with example descriptions and load buttons.
- [ ] On load, replace nodes and edges, reload Rust/WASM, close the dialog, and fit view.
- [ ] Add the selected component's Chinese explanation above its truth table.
- [ ] Verify keyboard/modal behavior and current-example help.

### Task 3: Verify the Demonstration

**Files:**
- Test: `apps/web/tests/examples.test.ts`

- [ ] Run `npm --prefix apps/web test`.
- [ ] Run `npm --prefix apps/web run build`.
- [ ] Run `cargo test --workspace`, rustfmt, and Clippy.
- [ ] Use Playwright at 1440x900 to load all five examples, inspect expected values,
  check console errors and horizontal overflow, and capture a screenshot.
- [ ] Commit with `feat: add ternary example library`.

