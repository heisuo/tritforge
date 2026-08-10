# Phase 3B Register3 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an editable 3-trit parallel register module composed from three existing DFFs and demonstrate it through the real Rust/WASM browser workbench.

**Architecture:** Register3 is a Project v2 hierarchy module with six inputs, three outputs, and three DFF lanes sharing Clock, enable, and reset. Existing Rust state and hierarchy semantics remain authoritative; TypeScript supplies only a cloned teaching project and presentation.

**Tech Stack:** Rust, serde, WebAssembly, TypeScript, React, React Flow, Vitest, Playwright.

---

## 1. File Map

- `apps/web/src/examples/register3.ts`: exact Project v2 Register3 module and root demo.
- `apps/web/src/examples.ts`: example registry, ID, help metadata, and cloning.
- `apps/web/tests/register3.test.ts`: exact editable topology and defaults.
- `crates/sim-core/tests/project_simulation.rs`: two-instance parallel state acceptance.
- `apps/web/tests/register3.spec.ts`: desktop real-WASM workflow and hierarchy navigation.
- `apps/web/playwright.config.ts`: include Register3 acceptance.
- `apps/web/vite.config.ts`: exclude Playwright spec from Vitest.
- `README.md` and roadmap/spec docs: user-facing Phase 3B status and acceptance.

### Task 1: Freeze and Add the Editable Register3 Project

**Files:**
- Create: `apps/web/tests/register3.test.ts`
- Create: `apps/web/src/examples/register3.ts`
- Modify: `apps/web/src/examples.ts`

- [x] **Step 1: Write the failing example contract test**

Require example ID `register3`, root defaults `D2=1/D1=T/D0=0/EN=1/RST=0`, one Clock,
one `register3` module instance, three Q Probes, exact stable port IDs, exactly three DFFs, and
shared `clk/en/rst` fanout connections.

- [x] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- --run tests/register3.test.ts
```

Expected: fail because `register3` is not an `ExampleId` and no cloned project exists.

- [x] **Step 3: Implement the Project v2 fixture**

Create `register3.ts` using the established `component()` and `connection()` helpers. Freeze
module port IDs as `d2/d1/d0/clk/en/rst/q2/q1/q0`; connect three DFFs and register the example
in `examples.ts` with expected result `1T0` (decimal 6).

- [x] **Step 4: Run GREEN and commit**

```bash
npm --prefix apps/web test -- --run tests/register3.test.ts tests/examples.test.ts
git add apps/web/src/examples apps/web/src/examples.ts apps/web/tests/register3.test.ts
git commit -m "feat: add editable three-trit register module"
```

### Task 2: Prove Parallel and Independent State in Rust

**Files:**
- Modify: `crates/sim-core/tests/project_simulation.rs`

- [x] **Step 1: Add the Register3 project builders**

Build a `register3` module with six module inputs, three DFFs, and three module outputs. Build a
main circuit with two instances, different data words, and shared Clock/EN/RST sources.

- [x] **Step 2: Add the behavioral acceptance test**

Assert one tick captures `1T0` in instance A and `T01` in instance B, source changes do not alter
Q before a tick, `EN=0` holds both words, and `RST=1` clears both to `000`. Assert tick changes do
not increase compile count.

- [x] **Step 3: Run the focused and full core tests**

```bash
cargo test -p sim-core --test project_simulation register3
cargo test -p sim-core
```

The new test is a characterization of already implemented hierarchy/DFF composition, so it may
be GREEN immediately; no production Rust change is permitted unless it exposes a real defect.

- [x] **Step 4: Commit**

```bash
git add crates/sim-core/tests/project_simulation.rs
git commit -m "test: prove three-trit register state semantics"
```

### Task 3: Add the Desktop Real-WASM Demonstration

**Files:**
- Create: `apps/web/tests/register3.spec.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/App.tsx`
- Create: `docs/images/phase3b-register3.png`

- [x] **Step 1: Write the browser flow**

At 1440x900, load `3-trit 并行寄存器`, assert `Q=000`, tick to `1T0`, disable EN and change D,
assert hold after tick, assert synchronous reset to `000`, double-click the module instance and
see all three DFFs, then check no page overflow or console/page errors.

- [x] **Step 2: Run RED**

```bash
npm --prefix apps/web run test:e2e -- tests/register3.spec.ts
```

Expected: fail until the spec is included and the new example is available.

- [x] **Step 3: Wire Playwright and update the phase badge**

Include `register3.spec.ts` in Playwright `testMatch`, exclude it from Vitest, and update the
header badge from `PHASE 3A` to `PHASE 3B`.

- [x] **Step 4: Capture and inspect the desktop screenshot**

Capture the loaded register after its first tick to `docs/images/phase3b-register3.png`. Inspect
the original image for clipped dynamic ports, overlapping wires, unreadable trits, or hidden
toolbar/status controls.

- [x] **Step 5: Run GREEN and commit**

```bash
npm --prefix apps/web run test:e2e -- tests/register3.spec.ts
npm --prefix apps/web test
npm --prefix apps/web run build
git add apps/web docs/images/phase3b-register3.png
git commit -m "test: demonstrate the three-trit register"
```

### Task 4: Document, Verify, and Merge Phase 3B

**Files:**
- Modify: `README.md`
- Modify: `docs/Logsim-Ternary项目总体设计与演进路线.md`
- Modify: `docs/superpowers/specs/2026-08-10-register3-foundation-design.md`
- Modify: this plan

- [x] **Step 1: Document usage and boundaries**

Describe trit order, decimal formula, shared controls, module composition, state lifecycle,
desktop example, screenshot, and deferred buses/waveforms/automatic clocks.

- [x] **Step 2: Run the fast-track verification chain**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
wasm-pack test --node crates/sim-wasm
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web run test:e2e -- tests/register3.spec.ts
git diff --check
```

- [x] **Step 3: Record exact results and commit**

Append exact Rust/WASM/Vitest/Playwright counts and residual tool warnings to the design. Commit:

```bash
git add README.md docs
git commit -m "docs: complete three-trit register phase"
```

- [x] **Step 4: Fast-forward merge and run the main demo**

Require a clean feature worktree, preserve unrelated main changes before merging, fast-forward
`feature/register3-foundation` into `main`, verify both refs match, and start the Web server from
main at `http://localhost:5173/`.
