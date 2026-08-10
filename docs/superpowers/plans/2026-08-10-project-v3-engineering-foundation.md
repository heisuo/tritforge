# Project v3 Engineering Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add width-aware buses, explicit wiring helpers, phase-based automatic clocks, a bounded Chronogram, and structurally expanded word-sized sequential components without replacing the verified scalar Rust simulator.

**Architecture:** Project v3 stores undirected wires and width-aware dynamic ports. A new Rust connectivity pass unions ordinary endpoints and local Tunnel names, validates shapes, lowers Splitter mappings and buses to scalar nets, then hands the result to the existing hierarchy compiler and Simulator. Rust also owns virtual clock phases and watched-signal history; React schedules wall time and renders controls and traces.

**Tech Stack:** Rust, serde, proptest, wasm-bindgen, TypeScript, React, Zustand, React Flow, Vitest, Playwright.

---

## 1. File Map

### Rust Core

- Create `crates/sim-core/src/signal.rs`: `SignalShape`, known/runtime word values, indexing helpers.
- Create `crates/sim-core/src/connectivity.rs`: v3 undirected-net union, Tunnel union, width validation, Splitter scalar lowering.
- Create `crates/sim-core/src/trace.rs`: phase metadata, qualified watch references, 512-frame trace recorder.
- Create `crates/sim-core/src/structural.rs`: Register, Shift Register, Counter, and Register File deterministic expansion.
- Modify `crates/sim-core/src/project.rs`: v3 wire contract and v2 compatibility input types.
- Modify `crates/sim-core/src/project_validation.rs`: dynamic property/port validation and v3 diagnostics.
- Modify `crates/sim-core/src/catalog.rs`: `inout`, dynamic shape descriptors, wiring and sequential macro kinds.
- Modify `crates/sim-core/src/hierarchy.rs`: invoke connectivity and structural lowering before existing scalar hierarchy compilation.
- Modify `crates/sim-core/src/simulator.rs`: public half-phase stepping while preserving complete Tick.
- Modify `crates/sim-core/src/project_simulator.rs`: v3 load/update, phase projection, watch configuration, trace access.
- Modify `crates/sim-core/src/lib.rs`: export focused modules and contracts.

### WASM

- Modify `crates/sim-wasm/src/lib.rs`: API v3, dynamic port resolution, phase, watch, and trace methods.
- Add focused tests to `crates/sim-wasm/tests/project_web_api.rs` and `crates/sim-wasm/tests/web_api.rs`.

### Web

- Create `apps/web/src/project/project-v3.ts`: v1/v2/v3 parse, deterministic migration, v3 serialization.
- Create `apps/web/src/project/signal-shape.ts`: TypeScript wire types only; all semantic resolution comes from WASM.
- Create `apps/web/src/components/Chronogram.tsx`: bounded trace controls and rendering.
- Create `apps/web/src/app/auto-clock.ts`: serialized, bounded wall-clock scheduler.
- Create `apps/web/src/components/PropertyEditor.tsx`: width, Tunnel, Splitter, and sequential macro properties.
- Modify `apps/web/src/editor-model.ts`: undirected wire endpoints and dynamic resolved port metadata.
- Modify `apps/web/src/project/project-document.ts`: delegate to Project v3 parser and remove v2-only export.
- Modify `apps/web/src/project/project-store.ts`: transactional v3 edits and width-aware wire creation.
- Modify `apps/web/src/project/project-catalog.ts`: consume Rust-resolved dynamic ports.
- Modify `apps/web/src/project/hierarchy-runtime.ts`: API v3, phase, trace, and word projections.
- Modify `apps/web/src/wasm-client.ts`: typed v3 bindings.
- Modify `apps/web/src/App.tsx`: wiring palette, run controls, context commands, and Chronogram dock.
- Modify `apps/web/src/CircuitNode.tsx`: dynamic widths and wiring/sequential visuals.
- Modify `apps/web/src/LogicWireEdge.tsx`: scalar/bus rendering without layout shift.
- Modify `apps/web/src/index.css`: workbench dock, bus, Junction, Tunnel, Splitter, and waveform styling.

### Tests and Docs

- Add Rust tests: `project_v3_contract.rs`, `connectivity_lowering.rs`, `trace_contract.rs`, `structural_components.rs`.
- Add Web tests: `project-v3.test.ts`, `signal-shape.test.ts`, `auto-clock.test.ts`, `chronogram.test.tsx`.
- Add Playwright tests: `bus-wiring.spec.ts`, `chronogram.spec.ts`, `sequential-tools.spec.ts`.
- Add editable example project `apps/web/src/examples/sequential-lab.ts`.
- Update `README.md`, roadmap, phase badge, and the approved design with exact acceptance results.

## 2. Phase 2B: Project v3 and Scalar Lowering

### Task 1: Freeze Signal Shapes and Word Ordering

**Files:**
- Create: `crates/sim-core/src/signal.rs`
- Modify: `crates/sim-core/src/lib.rs`
- Test: `crates/sim-core/tests/project_v3_contract.rs`

- [x] **Step 1: Write failing shape and value tests**

Test widths `1`, `3`, `27`, reject `0` and `28`, parse known words only when symbol count equals width,
and prove `1T0` indexes as `[q0=0,q1=T,q2=1]` with decimal value 6.

```rust
assert_eq!(SignalShape::new(3).unwrap().width(), 3);
assert_eq!(KnownWord::parse("1T0", SignalShape::new(3).unwrap()).unwrap().trit(0), Trit::Zero);
assert_eq!(KnownWord::parse("1T0", SignalShape::new(3).unwrap()).unwrap().balanced_value(), 6);
```

- [x] **Step 2: Run RED**

Run `cargo test -p sim-core --test project_v3_contract signal_shape -- --nocapture`.
Expected: unresolved imports for `signal::SignalShape` and `signal::KnownWord`.

- [x] **Step 3: Implement minimal immutable contracts**

Implement checked `u8` width, MS-to-LS serde strings, index-0 LST access, and runtime `WordValue(Vec<Trit>)`.
Do not add bus propagation here.

- [x] **Step 4: Run GREEN and quality checks**

Run the focused test, `cargo fmt --all -- --check`, and `cargo clippy -p sim-core --all-targets -- -D warnings`.

- [x] **Step 5: Commit**

Commit `feat: define width-aware ternary signals`.

### Task 2: Add the Project v3 Wire Contract and Migration

**Files:**
- Modify: `crates/sim-core/src/project.rs`
- Modify: `apps/web/src/project/project-document.ts` (compatibility re-exports only until Task 5)
- Create: `apps/web/src/project/project-v3.ts`
- Test: `crates/sim-core/tests/project_v3_contract.rs`
- Test: `apps/web/tests/project-v3.test.ts`

- [x] **Step 1: Write failing migration tests**

Freeze `WireEndpoint { componentId, portId }`, undirected `ProjectWire { endpointA, endpointB }`, v3-only
serialization, and exact v1/v2 migration preserving IDs, positions, properties, viewports, and hierarchy. Add
the v3 DTO beside the current v2 runtime contract; Task 5 switches the application after Rust lowering exists.

- [x] **Step 2: Run RED**

Run `cargo test -p sim-core --test project_v3_contract migration` and
`npm --prefix apps/web test -- --run tests/project-v3.test.ts`.
Expected: v3 is unsupported and `connections` are still required.

- [x] **Step 3: Implement parser and deterministic migration**

Use discriminated document interfaces for v1/v2/v3. Convert every v2 connection to one v3 wire without
sorting user arrays; default all legacy widths to 1. Reject mixed `connections` and `wires` in v3. Keep the
existing v2 parser callable as a temporary compatibility adapter so every intermediate commit still builds.

- [x] **Step 4: Prove round-trip stability**

Parse v1 and v2 fixtures, serialize v3, parse again, and compare the typed document exactly.

- [x] **Step 5: Commit**

Commit `feat: migrate projects to undirected v3 wires`.

### Task 3: Resolve Dynamic Ports in Rust

**Files:**
- Modify: `crates/sim-core/src/catalog.rs`
- Modify: `crates/sim-core/src/project_validation.rs`
- Modify: `crates/sim-core/src/project.rs`
- Test: `crates/sim-core/tests/project_v3_contract.rs`

- [x] **Step 1: Write failing resolved-port tests**

Require `PortDirection::InOut`, width-aware Input/Constant/Probe/module boundaries, dynamic Splitter ports,
and exact validation of `width`, `branchCount`, and `mapping`.

```rust
let ports = resolve_project_ports("wiring.splitter", props!({
    "width": 3, "branchCount": 3, "mapping": [0, 1, 2]
}))?;
assert_eq!(ports.iter().map(|p| (p.id.as_str(), p.shape.width())).collect::<Vec<_>>(),
           vec![("trunk", 3), ("branch0", 1), ("branch1", 1), ("branch2", 1)]);
```

- [x] **Step 2: Run RED**

Run `cargo test -p sim-core --test project_v3_contract resolved_ports`.

- [x] **Step 3: Implement one resolver and diagnostic codes**

Add `INVALID_SIGNAL_WIDTH` and `INVALID_SPLITTER_MAP`. Return dynamic port IDs in deterministic order.
Keep Clock, DFF, and scalar gates at width 1.

- [x] **Step 4: Run validation and catalog suites**

Run `cargo test -p sim-core --test project_validation`, `catalog_contract`, and `project_v3_contract`.

- [x] **Step 5: Commit**

Commit `feat: resolve dynamic project port shapes`.

### Task 4: Compile Undirected Nets, Tunnels, and Splitters

**Files:**
- Create: `crates/sim-core/src/connectivity.rs`
- Modify: `crates/sim-core/src/hierarchy.rs`
- Modify: `crates/sim-core/src/lib.rs`
- Test: `crates/sim-core/tests/connectivity_lowering.rs`

- [x] **Step 1: Write failing network equivalence tests**

Cover wire-order permutation, shared endpoints, circuit-local Tunnel union, Tunnel width conflicts, scalar
fanout, same-value multiple drivers, conflicting drivers, Splitter split/combine, arbitrary mappings, and nested
module bus boundaries.

- [x] **Step 2: Run RED**

Run `cargo test -p sim-core --test connectivity_lowering`.
Expected: no v3 connectivity compiler exists.

- [x] **Step 3: Implement symbolic union before allocation**

Use union-find over qualified logical endpoints. Union direct wire endpoints and same-circuit Tunnel ports.
Validate widths before allocating `width` scalar representatives. Consume Junction/Tunnel as wiring helpers.

- [x] **Step 4: Lower Splitter bit equivalences and scalar nets**

Map each trunk scalar index to its branch-local scalar index. Produce deterministic flat IDs, provenance for
every original wire, and reassembly entries for Project snapshots.

- [x] **Step 5: Enforce existing safety budgets before expansion**

Count logical width multiplication and reject over-limit projects at the original v3 component/wire location.

- [x] **Step 6: Run core regression**

Run `cargo test -p sim-core` and Clippy. Existing scalar, hierarchy, and Register3 tests must remain green.

- [x] **Step 7: Commit**

Commit `feat: lower v3 buses into scalar networks`.

### Task 5: Expose Project v3 Through WASM and Web Runtime

**Files:**
- Modify: `crates/sim-wasm/src/lib.rs`
- Modify: `crates/sim-wasm/tests/project_web_api.rs`
- Modify: `apps/web/src/wasm-client.ts`
- Modify: `apps/web/src/project/hierarchy-runtime.ts`
- Modify: `apps/web/src/project/project-catalog.ts`
- Test: `apps/web/tests/hierarchy-runtime.test.ts`

- [x] **Step 1: Write failing real-WASM API tests**

Require API version 3, v3 load, dynamic resolved ports, word-valued projections, and structured width errors.

- [x] **Step 2: Run RED**

Run `wasm-pack test --node crates/sim-wasm` and the focused Web runtime test.

- [x] **Step 3: Add narrow bindings**

Expose `resolve_project_ports(type_id, properties)`, v3 project load/update, and reassembled string word values.
Do not expose Rust union-find or scalar lowered IDs as public Web semantics.

- [x] **Step 4: Run GREEN and build**

Run real-WASM tests, focused Vitest, and `npm --prefix apps/web run build`.

- [x] **Step 5: Commit**

Commit `feat: expose project v3 signal shapes through wasm`.

## 3. Phase 2C: Wiring Workbench

### Task 6: Make the Editor Store Transactionally Width-Aware

**Files:**
- Modify: `apps/web/src/editor-model.ts`
- Modify: `apps/web/src/project/project-store.ts`
- Create: `apps/web/src/project/signal-shape.ts`
- Test: `apps/web/tests/project-store.test.ts`
- Test: `apps/web/tests/signal-shape.test.ts`

- [x] Write RED tests for undirected wire creation, mismatched-width rejection, multi-wire endpoints, one-step
undo for width/mapping edits, and unchanged document/runtime after invalid edits.
- [x] Run focused Vitest and confirm failures mention v2 connection assumptions.
- [x] Implement endpoint-normalized wires and consume only WASM-resolved port shapes.
- [x] Run focused and full Web tests.
- [x] Commit `feat: edit width-aware v3 wiring transactionally`.

### Task 7: Render Junction, Tunnel, Splitter, and Bus Wires

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/CircuitNode.tsx`
- Modify: `apps/web/src/LogicWireEdge.tsx`
- Modify: `apps/web/src/index.css`
- Create: `apps/web/src/components/PropertyEditor.tsx`
- Test: `apps/web/tests/app.test.tsx`
- Test: `apps/web/tests/bus-wiring.spec.ts`

- [x] Write a 1440x900 RED browser flow that places a width-3 input, Splitter, three Probes, Junction, and two
same-name Tunnels; assert word/scalar values and an atomic width-rejection message.
- [x] Add wiring palette entries and property controls using icon buttons, steppers, text fields, and mapping menus.
- [x] Render stable 2 px scalar and 6 px bus routes, width/value labels, dynamic handles, and tooltips without
changing route geometry when values change.
- [x] Add one 1024x720 compact acceptance for no overlap or hidden status controls.
- [x] Run Playwright, Vitest, production build, and inspect screenshots.
- [x] Commit `feat: add bus splitter and tunnel workbench`.

### Task 8: Add a Bus and Tunnel Teaching Example

**Files:**
- Create: `apps/web/src/examples/bus-wiring.ts`
- Modify: `apps/web/src/examples.ts`
- Test: `apps/web/tests/examples.test.ts`

- [x] Freeze an editable Project v3 example that splits `1T0`, routes one branch through a named Tunnel, and
recombines all branches into the same word.
- [x] Test exact component IDs, widths, mapping, local label behavior, and cloned-project isolation.
- [x] Add Chinese inspector explanations for bus order, Tunnel scope, and width errors.
- [x] Run example tests and browser loading.
- [x] Commit `feat: teach named three-trit buses`.

## 4. Phase 3C and 3D: Time and Chronogram

### Task 9: Add Rust Half-Phase Stepping

**Files:**
- Modify: `crates/sim-core/src/simulator.rs`
- Modify: `crates/sim-core/src/project_simulator.rs`
- Test: `crates/sim-core/tests/simulator_propagation.rs`
- Test: `crates/sim-core/tests/project_simulation.rs`

- [x] Write RED tests for initial LowStable, rise-only DFF commit, fall-only propagation, two-phase Tick
compatibility, phase/cycle overflow atomicity, and sibling instance simultaneous commits.
- [x] Implement `ClockPhase`, `advance_phase()`, and `tick()` as two phase calls with conservative diagnostic
aggregation.
- [x] Preserve existing `tickCount` JSON and add `clockPhase` without changing source-update semantics.
- [x] Run all sim-core tests, fmt, and Clippy.
- [x] Commit `feat: advance ternary simulation by clock phase`.

### Task 10: Add a Bounded Watched-Signal Trace Recorder

**Files:**
- Create: `crates/sim-core/src/trace.rs`
- Modify: `crates/sim-core/src/project_simulator.rs`
- Test: `crates/sim-core/tests/trace_contract.rs`

- [x] Write RED tests for stable qualified watches, initial/input/rise/fall/fault reasons, scalar and bus values,
512-frame eviction, unavailable-watch removal, reset/recompile clearing, and no full-snapshot retention.
- [x] Implement `TraceRecorder` separately from `Simulator`; store only selected values and immutable frame
metadata.
- [x] Append fault frames before returning errors and leave them queryable.
- [x] Run trace, project, and full core tests.
- [x] Commit `feat: record bounded watched-signal traces`.

### Task 11: Expose Phase and Trace Through WASM

**Files:**
- Modify: `crates/sim-wasm/src/lib.rs`
- Modify: `crates/sim-wasm/tests/project_web_api.rs`
- Modify: `apps/web/src/wasm-client.ts`
- Modify: `apps/web/src/project/hierarchy-runtime.ts`

- [x] Add failing real-WASM tests for phase stepping, watch add/remove, trace retrieval, fault preservation, and
structured unavailable-signal errors.
- [x] Add API v3 methods `advance_phase`, `set_trace_watches`, `trace_frames`, and `clear_trace`.
- [x] Type bindings with discriminated frame reasons and word strings.
- [x] Run real-WASM, focused Web, and production build.
- [x] Commit `feat: expose phase traces through wasm`.

### Task 12: Implement the Serialized Automatic Clock Scheduler

**Files:**
- Create: `apps/web/src/app/auto-clock.ts`
- Test: `apps/web/tests/auto-clock.test.ts`

- [x] Use fake timers to write RED tests for 0.5/1/2/5/10/20 cycles per second, two calls per cycle, no
reentrant WASM calls, bounded lag catch-up, pause-on-error, visibility pause, and disposal.
- [x] Implement one scheduler state machine with `start`, `pause`, `setRate`, and `dispose`.
- [x] Keep all circuit ordering in Rust; scheduler callbacks only invoke one queued `advancePhase` command.
- [x] Run focused tests and typecheck.
- [x] Commit `feat: schedule automatic ternary clocks`.

### Task 13: Build the Compact Chronogram

**Files:**
- Create: `apps/web/src/components/Chronogram.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/index.css`
- Test: `apps/web/tests/chronogram.test.tsx`
- Test: `apps/web/tests/chronogram.spec.ts`

- [ ] Write RED component and browser tests for add/remove/reorder, collapse/resize, run/pause, phase/full step,
clear, cursor values, 512-frame display, and balanced/decimal/per-trit bus modes.
- [ ] Add toolbar play/pause, half-step, Tick, and speed menu with lucide icons and accessible labels.
- [ ] Render scalar three-level traces and bus value bands; render X/Z/E distinctly without analog interpolation.
- [ ] Pause and retain a fault frame on runtime errors; clear on structural lifecycle events.
- [ ] Validate desktop and compact screenshots and no page/console errors.
- [ ] Commit `feat: add automatic clock chronogram`.

## 5. Phase 3E: Structural Sequential Library

### Task 14: Expand a Generic Width-W Register

**Files:**
- Create: `crates/sim-core/src/structural.rs`
- Modify: `crates/sim-core/src/hierarchy.rs`
- Test: `crates/sim-core/tests/structural_components.rs`

- [x] Write RED tests proving width 1/3/27 expands to exactly W DFFs, shared controls, simultaneous capture,
hold/reset priority, stable IDs, nested-instance isolation, and expansion-limit accounting.
- [x] Implement deterministic `sequential.register` expansion before scalar hierarchy compilation.
- [x] Rebuild the Register3 example with width-3 Register while preserving its visible contract and add an
internal-expansion view.
- [x] Run structural, hierarchy, project, and full core tests.
- [x] Commit `feat: structurally expand width-aware registers`.

### Task 15: Expand the Shift Register and Counter

**Files:**
- Modify: `crates/sim-core/src/structural.rs`
- Test: `crates/sim-core/tests/structural_components.rs`

- [ ] Write independent oracle tests for reset/load/enable priority, both shift directions, `sin/sout`,
increment/decrement/hold, wraparound, carry, meta controls, and widths 1/3/6.
- [ ] Expand Shift Register to DFFs and MUX gates with exact source provenance.
- [ ] Expand Counter to Register plus generated ripple arithmetic, not native array state.
- [ ] Run full Rust quality chain.
- [ ] Commit `feat: structurally expand shifts and counters`.

### Task 16: Expand the 2R1W Register File

**Files:**
- Modify: `crates/sim-core/src/structural.rs`
- Test: `crates/sim-core/tests/structural_components.rs`

- [ ] Write RED tests for AW1/AW2 bias mapping, two independent asynchronous reads, synchronous write,
write disable, reset-all, same-address read-after-edge, all-register writability, and instance isolation.
- [ ] Expand to 3 or 9 Register macros, one write decoder, and two read MUX trees.
- [ ] Fail before allocation for illegal AW or expansion-budget overflow.
- [ ] Run structural, hierarchy, project, and full core tests.
- [ ] Commit `feat: structurally expand ternary register files`.

### Task 17: Add Sequential Components to the Web Catalog

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/CircuitNode.tsx`
- Modify: `apps/web/src/components/PropertyEditor.tsx`
- Modify: `apps/web/src/component-help.ts`
- Test: `apps/web/tests/app.test.tsx`

- [ ] Add RED tests for width/direction/address controls and dynamically resolved ports.
- [ ] Add Register, Shift Register, Counter, and Register File palette entries and Chinese hardware explanations.
- [ ] Show compact live bus words on each node and allow expansion inspection without nested cards.
- [ ] Run Web unit and production build.
- [ ] Commit `feat: add structural sequential components to workbench`.

## 6. Integration and Completion

### Task 18: Build the Sequential Lab Example and Browser Acceptance

**Files:**
- Create: `apps/web/src/examples/sequential-lab.ts`
- Modify: `apps/web/src/examples.ts`
- Create: `apps/web/tests/sequential-tools.spec.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/vite.config.ts`

- [ ] Build a Project v3 example where an automatic Clock drives a 3-trit Counter, writes selected values into a
3-word 2R1W Register File, routes buses through Tunnels, and exposes Clock, Counter, addresses, and read data in
the Chronogram.
- [ ] Browser-test run/pause, at least four rising edges, counter progression, one register-file write/read,
Tunnel propagation, waveform cursor values, reset, and structural inspection.
- [ ] Capture desktop and compact screenshots and inspect dynamic labels, routes, ports, and dock layout.
- [ ] Run focused Playwright and commit `test: demonstrate the project v3 sequential lab`.

### Task 19: Update Documentation and Run Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/Logsim-Ternary项目总体设计与演进路线.md`
- Modify: `docs/superpowers/specs/2026-08-10-project-v3-buses-and-sequential-tools-design.md`
- Modify: this plan
- Create: acceptance screenshots under `docs/images/`

- [ ] Document Project v3, bus indexing, Tunnel scope, Splitter mapping, phase/Tick distinction, automatic run,
Chronogram limits, and each sequential component's ports and priority.
- [ ] Mark roadmap Phase 2 wiring and Phase 3 waveform/sequential items complete only after browser acceptance.
- [ ] Run fresh verification:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
wasm-pack test --node crates/sim-wasm
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web run test:e2e
git diff --check
```

- [ ] Record exact test counts and all non-blocking tool warnings in the design.
- [ ] Require clean feature worktree, fast-forward merge into main, verify branch refs match, stop the feature
server, and restart main at `http://127.0.0.1:5173/`.
- [ ] Commit `docs: complete project v3 engineering foundation`.
