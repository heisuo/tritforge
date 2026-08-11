# Ternary RAM/ROM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add usable 3/9/27-word ternary ROM and single-port RAM components to Project v3, the Web workbench, and a runnable Memory Lab.

**Architecture:** Public width-aware `memory.rom` and `memory.ram` macros lower to one internal scalar memory cell per data trit before hierarchy compilation. Rust owns immutable ROM contents and transactional RAM state; generated cells retain stable provenance so existing snapshots, traces, diagnostics, nesting, and structure inspection continue to work.

**Tech Stack:** Rust 2024, serde, sim-core event simulation, wasm-bindgen, React 19, TypeScript 7, Vitest, Playwright.

---

## File Map

- `crates/sim-core/src/memory.rs`: balanced address decoding, cell properties, ROM lookup, and RAM next-state logic.
- `crates/sim-core/src/structural.rs`: deterministic public-memory-to-cell expansion and memory inspection metadata.
- `crates/sim-core/src/connectivity.rs`: Project v3 lowering, endpoint fanout, provenance, and pre-allocation budgets.
- `crates/sim-core/src/simulator.rs`: internal RAM state ownership, asynchronous reads, and simultaneous rising-edge commits.
- `crates/sim-core/src/catalog.rs`, `circuit.rs`, `project_validation.rs`: public catalog, flat rejection, dynamic ports, and property validation.
- `crates/sim-core/src/project_simulator.rs`: Project v3 lifecycle, trace behavior, and expansion inspection.
- `crates/sim-core/tests/memory_components.rs`: independent ROM/RAM behavior and structural tests.
- `crates/sim-wasm/tests/project_web_api.rs`: real-WASM memory behavior and atomic error tests.
- `apps/web/src/components/PropertyEditor.tsx`: word width, address width, and ROM contents controls.
- `apps/web/src/component-help.ts`: Chinese memory hardware descriptions.
- `apps/web/src/App.tsx`, `CircuitNode.tsx`: memory icons, defaults, and compact live output words.
- `apps/web/src/examples/memory-lab.ts`, `examples.ts`: runnable ROM/RAM example.
- `apps/web/tests/memory-components.test.tsx`, `memory-lab.spec.ts`: Web and desktop acceptance.

### Task 1: Implement Scalar Memory Semantics

**Files:**
- Create: `crates/sim-core/src/memory.rs`
- Modify: `crates/sim-core/src/lib.rs`
- Modify: `crates/sim-core/src/catalog.rs`
- Modify: `crates/sim-core/src/circuit.rs`
- Modify: `crates/sim-core/src/simulator.rs`
- Test: `crates/sim-core/tests/memory_components.rs`

- [ ] Write RED unit tests for MS-first balanced addresses at AW 1/2/3, ROM zero-fill and E/X/Z reads, and RAM `rst > we > hold`.
- [ ] Run `cargo test -p sim-core --test memory_components -- --nocapture` and confirm failures are caused by missing memory APIs.
- [ ] Add internal `MemoryCellKind`, validated depth/contents, and this total address result:

```rust
pub enum DecodedAddress {
    Known(usize),
    Unknown,
    Error,
}

pub fn decode_balanced_address(bits_ms_first: &[Trit], width: u8) -> DecodedAddress;
```

- [ ] Add private scalar kinds `internal.rom_cell` and `internal.ram_cell`; reject public `memory.rom` and `memory.ram` in flat/v2 simulation with `STRUCTURAL_COMPONENT_REQUIRES_PROJECT_V3`.
- [ ] Store RAM cell state as `BTreeMap<String, Vec<Trit>>`; on LowStable-to-HighStable compute every cell from the same old state and commit once. Falling edges do not write.
- [ ] Make ROM/RAM reads asynchronous during settle. E address returns E, X/Z address returns X; unsafe writes return a diagnostic and leave all RAM state unchanged.
- [ ] Preserve flat DFF behavior and run focused simulator tests.
- [ ] Commit `feat: simulate ternary memory cells`.

### Task 2: Lower Project v3 RAM/ROM Macros

**Files:**
- Modify: `crates/sim-core/src/structural.rs`
- Modify: `crates/sim-core/src/connectivity.rs`
- Modify: `crates/sim-core/src/project_validation.rs`
- Modify: `crates/sim-core/src/project_simulator.rs`
- Test: `crates/sim-core/tests/memory_components.rs`
- Test: `crates/sim-core/tests/project_simulation.rs`

- [ ] Write RED tests resolving the exact public ports:

```text
ROM: addr[AW] -> data[W]
RAM: addr[AW], din[W], we, clk, rst -> dout[W]
```

- [ ] Write RED tests proving W 1/3/27 creates exactly W cells, stable collision-safe IDs, shared address/control endpoints, lane-correct data, nested-instance isolation, and actual provenance inspection.
- [ ] Validate `wordWidth` 1..27, `addressWidth` 1..3, contents length <= `3^AW`, and exact known-word width before allocation. Return `INVALID_MEMORY_ADDRESS_WIDTH` or `INVALID_MEMORY_CONTENTS` atomically.
- [ ] Expand macros before scalar hierarchy compilation and account for cells, address/control fanout, generated connections, reassembly, and provenance limits before allocation.
- [ ] Preserve RAM state and clock phase for label-only edits; clear RAM on reset/reachable recompile/active-root switch. ROM content edits recompile and clear trace.
- [ ] Verify trace watches reassemble ROM `data` and RAM `dout` MS-first, including nested instances and fault frames.
- [ ] Run `cargo test --workspace`, strict Clippy, fmt, and diff check.
- [ ] Commit `feat: lower project v3 ternary memories`.

### Task 3: Expose Memory Through WASM and Web

**Files:**
- Modify: `crates/sim-wasm/tests/project_web_api.rs`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/CircuitNode.tsx`
- Modify: `apps/web/src/components/PropertyEditor.tsx`
- Modify: `apps/web/src/component-help.ts`
- Test: `apps/web/tests/memory-components.test.tsx`
- Test: `apps/web/tests/app.test.tsx`

- [ ] Add real-WASM RED tests for ROM async reads, RAM rising-edge writes, hold/reset, dynamic ports, nested copies, atomic invalid updates, and trace values.
- [ ] Add `ROM` and `RAM` catalog entries with defaults `wordWidth=3`, `addressWidth=3`; use memory-related lucide icons and compact output words.
- [ ] Add property controls for word width and address width. For ROM render exactly `3^AW` address-labelled word inputs backed by `contents`; validate as one atomic property commit.
- [ ] Add Chinese help describing async read, rising-edge write, reset priority, depth, and balanced address bias.
- [ ] Ensure structural property edits pause automatic run through the existing compile-count lifecycle.
- [ ] Run real Node/WASM tests, focused Web tests, and `npm --prefix apps/web run build`.
- [ ] Commit `feat: add ternary memories to workbench`.

### Task 4: Add Memory Lab and Desktop Acceptance

**Files:**
- Create: `apps/web/src/examples/memory-lab.ts`
- Modify: `apps/web/src/examples.ts`
- Create: `apps/web/tests/memory-lab.spec.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `README.md`

- [ ] Write a RED example-contract test for one address source driving ROM and RAM, RAM `din/we/clk/rst`, output probes, valid widths, and non-overlapping desktop positions.
- [ ] Build a 3-trit, 27-word Memory Lab with distinct ROM values around addresses `T00`, `000`, and `100`; initialize RAM to zero.
- [ ] Browser-test ROM address switching, one RAM write, hold with `we=0`, reset, at least two phase transitions, and Chronogram values for addr/clk/din/data/dout.
- [ ] Capture a 1440x900 screenshot with visible non-empty ROM and RAM waveforms; assert no page overflow, console errors, node/label overlap, or blank canvas.
- [ ] Run focused Playwright, full Web unit tests, production build, Rust workspace tests, Clippy, fmt, and diff check.
- [ ] Record exact test counts and non-blocking warnings in the design document.
- [ ] Commit `test: demonstrate ternary ram and rom`.

### Task 5: Integrate the Demo Build

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-ternary-memory-components-design.md`
- Modify: this plan

- [ ] Mark tasks complete only after focused browser acceptance and clean worktree.
- [ ] Start the feature build on `http://127.0.0.1:5175/` and verify HTTP 200.
- [ ] Keep `main` unchanged until the wider Project v3 plan is ready to merge.
- [ ] Commit `docs: complete ternary memory components`.
