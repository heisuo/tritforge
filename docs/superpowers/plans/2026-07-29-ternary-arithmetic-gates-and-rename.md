# Ternary Arithmetic Gates And Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MOD_SUM and CONSENSUS gates, rebuild the half/full-adder teaching examples hierarchically, and support double-click node renaming.

**Architecture:** Rust remains the only source of gate semantics and exports the new truth tables through WASM. TypeScript only defines editable example documents and updates presentation-only node labels.

**Tech Stack:** Rust, WebAssembly, React, TypeScript, React Flow, Vitest, Playwright

---

### Task 1: Add Arithmetic Gate Semantics

**Files:**
- Modify: `crates/sim-core/src/catalog.rs`
- Modify: `crates/sim-core/src/gates.rs`
- Modify: `crates/sim-core/src/circuit.rs`
- Modify: `crates/sim-core/tests/gate_truth_tables.rs`
- Modify: `crates/sim-core/tests/catalog_contract.rs`

- [ ] Add failing exhaustive tests for `MOD_SUM` and `CONSENSUS`.
- [ ] Add stable IDs, ports, catalog rows, evaluator logic, and property validation.
- [ ] Run focused and workspace Rust tests.

### Task 2: Rebuild Teaching Examples

**Files:**
- Modify: `apps/web/src/examples.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/component-help.ts`
- Modify: `apps/web/tests/examples.test.ts`

- [ ] Add failing catalog-help and example-structure tests.
- [ ] Add a two-gate half-adder example.
- [ ] Replace the flat full-adder example with two Half Adder nodes and one `MOD_SUM`.
- [ ] Verify the half adder's 9 and full adder's 27 known input combinations in Playwright.

### Task 3: Add Double-Click Rename

**Files:**
- Modify: `apps/web/src/editor-model.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/tests/editor-model.test.ts`

- [ ] Add a failing pure document-label update test.
- [ ] Add the immutable rename helper and wire it to React Flow's `onNodeDoubleClick`.
- [ ] Verify accepted, cancelled, and blank names; confirm topology and simulation remain unchanged.

### Task 4: Final Verification

- [ ] Run `cargo fmt --all`, `cargo test --workspace`, and Clippy with warnings denied.
- [ ] Run all Vitest tests and the production WASM/Vite build.
- [ ] Run Playwright interaction checks and inspect desktop screenshots.
- [ ] Commit implementation and update workspace memory.
