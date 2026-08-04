# Single-Trit Sequential Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Rust-owned transactional clock tick, a Clock source, and an enabled/resettable single-trit DFF that work through hierarchical projects and the browser editor.

**Architecture:** Keep the existing delta-cycle engine for combinational settling and add session-only Clock/DFF state inside `Simulator`. A tick raises all Clock primitives, captures all rising-edge DFF inputs into a separate next-state map, commits them simultaneously, settles, then lowers clocks and settles again. Project simulation delegates to the flattened simulator and projects ticked snapshots back to the active hierarchy; TypeScript only invokes and displays the Rust result.

**Tech Stack:** Rust, serde, wasm-bindgen, WebAssembly, TypeScript, React, React Flow, Vitest, Playwright.

---

## 1. File Map

- `crates/sim-core/src/catalog.rs`: stable Clock/DFF kinds, ports, categories, and property rules.
- `crates/sim-core/src/sequential.rs`: pure DFF next-state semantics, independent of graph propagation.
- `crates/sim-core/src/simulator.rs`: session state, transactional tick phases, reset, and snapshots.
- `crates/sim-core/src/project_simulator.rs`: project-level tick and projected tick count.
- `crates/sim-wasm/src/lib.rs`: flat and project `tick()` WASM methods.
- `apps/web/src/wasm-client.ts`: API v2 snapshot and binding contracts.
- `apps/web/src/project/hierarchy-runtime.ts`: hierarchy tick adapter.
- `apps/web/src/CircuitNode.tsx`: Clock/DFF node icons and Q display.
- `apps/web/src/App.tsx`: Tick command, readiness rules, status count, and sequential palette group.
- `apps/web/src/examples/sequential-dff.ts`: editable DFF demonstration project.
- `apps/web/tests/sequential.spec.ts`: real browser/WASM acceptance.

---

### Task 1: Freeze API v2 and Sequential Catalog Contracts

**Files:**
- Modify: `crates/sim-core/src/lib.rs`
- Modify: `crates/sim-core/src/catalog.rs`
- Modify: `crates/sim-core/src/circuit.rs`
- Modify: `crates/sim-core/tests/catalog_contract.rs`
- Modify: `crates/sim-core/tests/circuit_validation.rs`
- Modify: `crates/sim-wasm/tests/web_api.rs`

- [x] **Step 1: Write failing catalog and API tests**

Extend the stable ID assertion with:

```rust
"source.clock",
"sequential.dff",
```

Freeze exact descriptors:

```rust
assert_descriptor(
    "source.clock",
    "source",
    &[("out", PortDirection::Output)],
    0,
);
assert_descriptor(
    "sequential.dff",
    "sequential",
    &[
        ("d", PortDirection::Input),
        ("clk", PortDirection::Input),
        ("en", PortDirection::Input),
        ("rst", PortDirection::Input),
        ("q", PortDirection::Output),
    ],
    0,
);
assert_eq!(sim_core::api_version(), 2);
assert_eq!(sim_wasm::api_version(), 2);
```

Add validation cases proving Clock and DFF accept empty runtime properties and reject a
`value` property.

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test catalog_contract
cargo test -p sim-core --test circuit_validation sequential
cargo test -p sim-wasm --test web_api api_version
```

Expected: missing variants/IDs and API version mismatch.

- [x] **Step 3: Implement stable kinds and ports**

Add `Clock` and `Dff` to `ComponentKind`, map exact type IDs and ports, and append catalog
entries without reordering existing IDs:

```rust
(ComponentKind::Clock, "Clock", "source"),
(ComponentKind::Dff, "D Flip-Flop", "sequential"),
```

Truth tables remain empty because neither component is a stateless gate. Update
`property_is_valid` so Clock/DFF require `value.is_none()`. Change `api_version()` to 2.

- [x] **Step 4: Run GREEN and commit**

```bash
cargo test -p sim-core --test catalog_contract
cargo test -p sim-core --test circuit_validation
cargo test -p sim-wasm --test web_api
cargo clippy --workspace --all-targets -- -D warnings
git add crates/sim-core crates/sim-wasm/tests/web_api.rs
git commit -m "feat: define clock and dff contracts"
```

---

### Task 2: Implement the Pure DFF State Table

**Files:**
- Create: `crates/sim-core/src/sequential.rs`
- Create: `crates/sim-core/tests/sequential_contract.rs`
- Modify: `crates/sim-core/src/lib.rs`

- [ ] **Step 1: Write the exhaustive failing state-table tests**

Test the frozen priority and all auxiliary states:

```rust
assert_eq!(dff_next(Trit::Neg, Trit::Pos, Trit::Pos, Trit::Pos), Trit::Zero);
assert_eq!(dff_next(Trit::Neg, Trit::Pos, Trit::Pos, Trit::Zero), Trit::Pos);
assert_eq!(dff_next(Trit::Neg, Trit::Pos, Trit::Zero, Trit::Zero), Trit::Neg);
assert_eq!(dff_next(Trit::Pos, Trit::HighZ, Trit::Pos, Trit::Zero), Trit::Unknown);
assert_eq!(dff_next(Trit::Pos, Trit::Neg, Trit::Error, Trit::Zero), Trit::Error);
assert_eq!(dff_next(Trit::Pos, Trit::Neg, Trit::Unknown, Trit::Zero), Trit::Unknown);
```

Loop across all six trit states to prove `rst=1` always wins and both `0/T` mean
deasserted for `en` and `rst`.

- [ ] **Step 2: Run RED**

```bash
cargo test -p sim-core --test sequential_contract
```

Expected: unresolved import `sim_core::sequential`.

- [ ] **Step 3: Implement `dff_next`**

```rust
pub fn dff_next(current: Trit, d: Trit, en: Trit, rst: Trit) -> Trit {
    match rst {
        Trit::Pos => Trit::Zero,
        Trit::Error => Trit::Error,
        Trit::Unknown | Trit::HighZ => Trit::Unknown,
        Trit::Neg | Trit::Zero => match en {
            Trit::Pos => d.normalize_gate_input(),
            Trit::Neg | Trit::Zero => current,
            Trit::Error => Trit::Error,
            Trit::Unknown | Trit::HighZ => Trit::Unknown,
        },
    }
}
```

Use the existing public `Trit::normalize_gate_input` helper so the `Z -> X` rule remains shared
with combinational gates.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p sim-core --test sequential_contract
cargo fmt --all -- --check
git add crates/sim-core
git commit -m "feat: define ternary dff state transitions"
```

---

### Task 3: Add Transactional Tick to the Flat Simulator

**Files:**
- Modify: `crates/sim-core/src/simulator.rs`
- Modify: `crates/sim-core/tests/simulator_propagation.rs`

- [ ] **Step 1: Add failing load, capture, enable, reset, and tick-count tests**

Build a circuit with data/enable/reset Trit Inputs, Clock, DFF, and Probe. Assert:

```rust
let initial = simulator.snapshot();
assert_eq!(initial.output_value("clock", "out"), Some(Trit::Zero));
assert_eq!(initial.output_value("dff", "q"), Some(Trit::Zero));
assert_eq!(initial.tick_count, 0);

let captured = simulator.tick().unwrap();
assert_eq!(captured.output_value("dff", "q"), Some(Trit::Pos));
assert_eq!(captured.output_value("clock", "out"), Some(Trit::Zero));
assert_eq!(captured.tick_count, 1);
```

Then prove `EN=0` holds, `RST=1` overrides, and `reset()` restores Q/tick count.

- [ ] **Step 2: Add the failing simultaneous-capture regression**

Connect two DFFs as a swap register (`q0 -> d1`, `q1 -> d0`) and initialize them through
one reset/capture sequence. On the next tick assert they swap. Repeat with reversed component
IDs and definition order; snapshots must match. This fails if DFFs commit one at a time.

- [ ] **Step 3: Add failing edge and overflow tests**

Prove a DFF whose `clk` stays at 1 does not sample, a clock passing through BUF does sample,
and `tick_count == u64::MAX` returns `TICK_COUNT_OVERFLOW` without changing state. Add a
test-only constructor/helper under `#[cfg(test)]` for the overflow setup.

- [ ] **Step 4: Run RED**

```bash
cargo test -p sim-core --test simulator_propagation tick
```

Expected: no `tick`, no `tick_count`, Clock/DFF are not runtime-evaluable.

- [ ] **Step 5: Implement session state and runtime outputs**

Add private maps and initialize from validated component kinds:

```rust
tick_count: u64,
dff_outputs: BTreeMap<String, Trit>,
clock_levels: BTreeMap<String, Trit>,
```

In `evaluate_component`, Clock reads `clock_levels`, DFF reads `dff_outputs`, and all other
kinds use `gates::evaluate`. Include `tick_count` in `SimulationSnapshot`.

- [ ] **Step 6: Implement transactional `tick()`**

```rust
#[allow(clippy::result_large_err)]
pub fn tick(&mut self) -> Result<SimulationSnapshot, Diagnostic>;
```

Capture old clock inputs, raise all clocks and settle, compute every rising-edge next state
into a separate `BTreeMap`, commit together, settle changed Q outputs, lower clocks, settle,
then increment the checked count. Do not call `set_sources` for Clock.

- [ ] **Step 7: Extend reset and run GREEN**

Reset DFF maps to zero, Clock maps to zero, and tick count to zero before the existing source
reset settle.

```bash
cargo test -p sim-core --test simulator_propagation
cargo test -p sim-core
cargo clippy -p sim-core --all-targets -- -D warnings
```

- [ ] **Step 8: Commit**

```bash
git add crates/sim-core/src/simulator.rs crates/sim-core/tests/simulator_propagation.rs
git commit -m "feat: tick stateful ternary circuits"
```

---

### Task 4: Preserve Independent DFF State Through Hierarchy

**Files:**
- Modify: `crates/sim-core/src/hierarchy.rs`
- Modify: `crates/sim-core/src/project_simulator.rs`
- Modify: `crates/sim-core/src/project_validation.rs`
- Modify: `crates/sim-core/tests/hierarchy_compilation.rs`
- Modify: `crates/sim-core/tests/project_simulation.rs`
- Modify: `crates/sim-core/tests/project_validation.rs`

- [ ] **Step 1: Write failing hierarchical DFF compilation tests**

Create a `BitCell` module containing Module Input `d/en/rst/clk`, one DFF, and Module Output
`q`. Instantiate it twice. Assert both flattened DFF IDs exist and differ, while each module
output projects to its own DFF Q.

- [ ] **Step 2: Write failing independent-state and lifecycle tests**

Drive the two instances with different D values and the same top-level Clock; after one
project tick assert `q0=1`, `q1=T`. Change only D and assert state is retained until the next
tick. Assert an unreachable module edit preserves tick count/state, while active structure
edit and `switch_active` reset them to zero.

- [ ] **Step 3: Run RED**

```bash
cargo test -p sim-core --test hierarchy_compilation dff
cargo test -p sim-core --test project_simulation tick
```

- [ ] **Step 4: Extend project validation and flattening**

Treat Clock/DFF as ordinary builtins with empty runtime properties. Ensure the flattening
match that creates `ComponentProperties` accepts both kinds and keeps their unique structured
flat IDs/provenance.

- [ ] **Step 5: Add project tick and projected count**

Add `tick_count: u64` to `ProjectSnapshot` and:

```rust
pub fn tick(&mut self) -> Result<ProjectSnapshot, ProjectDiagnostic>;
```

Return `PROJECT_NOT_READY` when invalid. Delegate to the flat simulator and pass the flat
snapshot through `project_snapshot`; compile count must not change.

- [ ] **Step 6: Run GREEN and commit**

```bash
cargo test -p sim-core --test hierarchy_compilation
cargo test -p sim-core --test project_validation
cargo test -p sim-core --test project_simulation
cargo test -p sim-core
git add crates/sim-core
git commit -m "feat: simulate dff state through module hierarchy"
```

---

### Task 5: Expose Tick Across WASM API v2

**Files:**
- Modify: `crates/sim-wasm/src/lib.rs`
- Modify: `crates/sim-wasm/tests/web_api.rs`
- Modify: `crates/sim-wasm/tests/project_web_api.rs`
- Modify: `apps/web/src/wasm-client.ts`
- Modify: `apps/web/tests/wasm-client.test.ts`

- [ ] **Step 1: Write failing flat and project WASM tests**

For both handles load a DFF circuit/project, call `tick()`, deserialize the snapshot, and
assert API v2, Q, and tick count. Call tick before load and assert structured `NOT_LOADED` or
`PROJECT_NOT_READY` without a JS trap.

- [ ] **Step 2: Run RED**

```bash
wasm-pack test --node crates/sim-wasm
```

- [ ] **Step 3: Add binding methods and TypeScript contracts**

```rust
pub fn tick(&mut self) -> Result<JsValue, JsValue> {
    let snapshot = self.simulator_mut()?.tick().map_err(boundary_diagnostic)?;
    to_js_value(&snapshot)
}
```

Add the corresponding project method. Extend TypeScript snapshots with `tick_count` for flat
and `tickCount` for project, and add `tick()` to both binding interfaces. Update WASM mocks to
API version 2.

- [ ] **Step 4: Run GREEN and commit**

```bash
wasm-pack test --node crates/sim-wasm
npm --prefix apps/web test -- --run tests/wasm-client.test.ts
git add crates/sim-wasm apps/web/src/wasm-client.ts apps/web/tests/wasm-client.test.ts
git commit -m "feat: expose sequential tick through wasm"
```

---

### Task 6: Adapt Hierarchy Runtime and Web Component Metadata

**Files:**
- Modify: `apps/web/src/editor-model.ts`
- Modify: `apps/web/src/project/hierarchy-runtime.ts`
- Modify: `apps/web/src/component-help.ts`
- Modify: `apps/web/src/CircuitNode.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/hierarchy-runtime.test.ts`
- Modify: `apps/web/tests/app.test.tsx`

- [ ] **Step 1: Write failing runtime and rendering tests**

Mock project snapshots with `tickCount`, call `HierarchyRuntime.tick()`, and assert the value
is preserved. Render Clock/DFF descriptors and assert all exact handle test IDs plus Q as the
primary signal. Assert help text exists for both stable type IDs.

- [ ] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- --run tests/hierarchy-runtime.test.ts tests/app.test.tsx
```

- [ ] **Step 3: Implement runtime and node metadata**

Add `tickCount` to `ProjectSimulationSnapshot`, implement:

```typescript
tick(): ProjectSimulationSnapshot {
  return this.accept(this.simulator.tick());
}
```

Use Lucide `Clock3` for Clock and `PanelTop` for DFF. DFF primary signal is
`outputs.q ?? "Z"`. Add concise Chinese help covering positive
assertion, synchronous reset priority, and full-tick behavior.

- [ ] **Step 4: Add stable sequential styling**

Keep the existing node dimensions and signal palette. Add only a restrained sequential border
accent; do not introduce a new card layer or one-hue theme.

- [ ] **Step 5: Run GREEN and commit**

```bash
npm --prefix apps/web test
npm --prefix apps/web run build
git add apps/web/src apps/web/tests
git commit -m "feat: render ternary sequential components"
```

---

### Task 7: Add Tick Command and Session Lifecycle to the Workbench

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/project/hierarchy-runtime.ts`
- Modify: `apps/web/tests/app.test.tsx`
- Modify: `apps/web/tests/hierarchy-runtime.test.ts`

- [ ] **Step 1: Add failing toolbar and status tests**

Assert a `单步 Tick` icon button exists, is disabled while WASM loads or after project
validation failure, calls the runtime once when ready, and updates status from `0 TICKS` to
`1 TICKS`. Assert source clicks do not change tick count.

- [ ] **Step 2: Add failing reset/recompile/navigation lifecycle tests**

Prove reset/default reload returns to zero, source-only history retains count/state, and active
structure changes or breadcrumb navigation display the reset count returned by Rust.

- [ ] **Step 3: Run RED**

```bash
npm --prefix apps/web test -- --run tests/app.test.tsx tests/hierarchy-runtime.test.ts
```

- [ ] **Step 4: Implement Tick UI**

Add a Lucide `StepForward` icon button with tooltip/ARIA label `单步 Tick`. The handler calls
`runtime.tick()`, routes errors through existing `runtimeFailure`, and never computes state in
TypeScript. Add `{snapshot?.tickCount ?? 0} TICKS` to the status bar.

Include category `sequential` in palette rendering with heading `时序`. Preserve fixed toolbar
dimensions at desktop and compact breakpoints; Tick stays visible as an icon on mobile.

- [ ] **Step 5: Run GREEN, build, and commit**

```bash
npm --prefix apps/web test
npm --prefix apps/web run build
git add apps/web/src/App.tsx apps/web/src/project apps/web/tests
git commit -m "feat: step sequential circuits from the workbench"
```

---

### Task 8: Add the Editable DFF Example and Browser Acceptance

**Files:**
- Create: `apps/web/src/examples/sequential-dff.ts`
- Create: `apps/web/tests/sequential.spec.ts`
- Modify: `apps/web/src/examples.ts`
- Modify: `apps/web/tests/examples.test.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/vite.config.ts`
- Create: `docs/images/phase3a-dff.png`

- [ ] **Step 1: Freeze the example topology in a failing unit test**

Require exact components: D Trit Input, Clock, EN Trit Input, RST Trit Input, DFF, Q Probe;
require the five connections to `d/clk/en/rst` and from `q`. Default values are D=1, EN=1,
RST=0 and initial Q is supplied only by Rust state.

- [ ] **Step 2: Add failing real-WASM browser acceptance**

Automate:

```text
load -> Q=0, ticks=0
tick -> Q=1, ticks=1
EN=0/T -> change D -> tick -> Q holds
RST=1 -> tick -> Q=0
RST=0, EN=1, D=T -> tick -> Q=T
reset/default reload -> Q=0, ticks=0
```

Also load a hierarchical two-instance BitCell fixture and prove distinct D values produce
distinct stored Q values after one shared tick.

- [ ] **Step 3: Add responsive and console acceptance**

At 1440x900, 900x700, and 390x844, load the DFF example, click Tick, open compact palette,
and assert no document/body overflow and no console/page errors.

- [ ] **Step 4: Implement the example and Playwright matching**

Add `sequential.spec.ts` to Playwright `testMatch` and Vitest exclusions. Keep the example a
normal Project v2 clone so it remains editable and exportable.

- [ ] **Step 5: Capture and inspect screenshot**

Capture the working DFF circuit at 1440x900 to `docs/images/phase3a-dff.png`. Inspect it with
`view_image`; reject overlaps, clipped controls, hidden handles, or unreadable signal labels.

- [ ] **Step 6: Run GREEN and commit**

```bash
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web run test:e2e
git add apps/web docs/images/phase3a-dff.png
git commit -m "test: demonstrate a ticked ternary dff"
```

---

### Task 9: Document Phase 3A and Run Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/Logsim-Ternary项目总体设计与演进路线.md`
- Modify: `docs/superpowers/specs/2026-08-04-sequential-foundation-design.md`
- Modify: `.github/workflows/ci.yml` only if the command chain changes

- [ ] **Step 1: Update user and architecture documentation**

Document Clock/DFF ports, positive assertion, synchronous reset priority, one-click full tick,
session-only Q state, hierarchy independence, API v2, reset/recompile/navigation lifecycle, and
the 3A screenshot. Mark 3-trit register, waveforms, automatic clocks, delays, and multi-clock
domains as exclusions.

- [ ] **Step 2: Append actual acceptance results**

Record date, exact Rust/WASM/Vitest/Playwright counts, three viewports, tick propagation timing,
and residual third-party warnings. Do not rewrite frozen requirements to fit implementation.

- [ ] **Step 3: Run the clean-checkout command chain**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
wasm-pack test --node crates/sim-wasm
npm ci --prefix apps/web
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web exec -- playwright install chromium
npm --prefix apps/web run test:e2e
git diff --check
git status --short
```

Expected: all commands exit 0; only documented wasm-pack/Node notices remain.

- [ ] **Step 4: Commit and verify clean status**

```bash
git add README.md docs .github
git commit -m "docs: complete sequential foundation phase"
git status --short
```

Expected: no output.

---

## 2. Spec Coverage

| Frozen requirement | Plan task |
|---|---|
| Clock/DFF stable contracts and API v2 | Tasks 1, 5 |
| Positive assertion and auxiliary-state semantics | Task 2 |
| Transactional full tick and simultaneous capture | Task 3 |
| Reset, overflow, and state lifecycle | Tasks 3, 4, 7 |
| Independent state through shared hierarchy | Task 4 |
| Rust/WASM as only state-semantic source | Tasks 3-7 |
| Workbench Tick UX and status | Tasks 6-7 |
| Editable DFF and hierarchical acceptance | Task 8 |
| Responsive UI, CI, and docs | Tasks 8-9 |

## 3. Completion Checklist

- [ ] Clock returns to 0 after every full tick.
- [ ] DFF reset, enable, data, and auxiliary-state priorities match the frozen table.
- [ ] Multiple DFFs sample simultaneously regardless of ID/order.
- [ ] Shared module instances have independent DFF state.
- [ ] Source updates preserve state; active recompiles/navigation reset it.
- [ ] Tick does not increase compile count.
- [ ] API v2 and flat/project tick counts cross WASM correctly.
- [ ] Desktop, compact, and mobile browser acceptance passes.
- [ ] Full Rust, WASM, Web, build, and Playwright verification passes.
