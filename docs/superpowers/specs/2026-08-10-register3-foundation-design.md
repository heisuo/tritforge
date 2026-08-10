# Phase 3B: 3-trit Parallel Register Design

**Status:** Completed and accepted on 2026-08-10
**Audience:** Logsim Ternary developers and hardware-learning users  
**Depends on:** Phase 2A hierarchy and Phase 3A Clock/DFF tick semantics

## 1. Goal

Phase 3B adds an editable 3-trit parallel register built from three existing single-trit DFFs.
It demonstrates the first word-sized state element without adding a second state implementation
to Rust or TypeScript.

The word is written as `Q2 Q1 Q0`, where `Q2` is the most significant trit:

```text
value = 9 * Q2 + 3 * Q1 + Q0
```

The known range is `-13..13`. For example, `1T0` represents decimal 6.

## 2. Architecture Decision

Register3 is a normal Project v2 module, not a new builtin component kind. Its three DFFs remain
the only state owners. The hierarchy compiler gives each expanded DFF a unique flat ID, and the
existing transactional tick computes and commits all three next states simultaneously.

```text
D2 ----> DFF2 ----> Q2
D1 ----> DFF1 ----> Q1
D0 ----> DFF0 ----> Q0
           ^
       CLK/EN/RST shared fanout
```

This choice matches a hardware implementation, keeps the module openable and editable, and lets
future 6-trit or 9-trit registers reuse the same structure. A native vector/register primitive is
deferred until the editor has a real multi-trit bus model.

## 3. Frozen Module Contract

The module circuit ID is `register3`. Dynamic port IDs are stable and lower case:

| Port | Direction | Meaning |
|---|---|---|
| `d2` | input | most significant data trit |
| `d1` | input | middle data trit |
| `d0` | input | least significant data trit |
| `clk` | input | positive-edge clock |
| `en` | input | positive assertion enables parallel capture |
| `rst` | input | positive assertion synchronously clears all Q trits |
| `q2` | output | most significant stored trit |
| `q1` | output | middle stored trit |
| `q0` | output | least significant stored trit |

Internal DFF IDs are `dff-2`, `dff-1`, and `dff-0`. All three receive the same `clk`, `en`, and
`rst` nets. The module contains no Clock source; the parent circuit owns the Clock.

## 4. Register Semantics

One workbench Tick remains one complete `CLK: 0 -> 1 -> 0` cycle. On the rising edge:

1. `rst=1` commits `Q2Q1Q0=000`.
2. Otherwise, `en=1` captures `D2D1D0` in parallel.
3. Otherwise, `en=T/0` holds all three current Q values.
4. Auxiliary `X/Z/E` behavior is inherited independently from the Phase 3A DFF state table.

Input edits do not change Q before a tick. All three Q values change in one transactional commit.
Loading the project, switching active roots, or recompiling reachable structure restores all Q
values and tick count to zero. Multiple Register3 instances have independent state because their
expanded DFF IDs differ.

## 5. Editable Example

The example ID is `register3`, with Chinese name `3-trit 并行寄存器`. Its root `main` circuit
contains:

- Trit Inputs `D2=1`, `D1=T`, `D0=0`;
- one Clock;
- Trit Inputs `EN=1`, `RST=0`;
- one module instance referencing `register3`;
- Probes `Q2`, `Q1`, and `Q0`.

The root uses six input/control connections and three output connections. The module definition
contains six Module Inputs, three DFFs, three Module Outputs, and fifteen connections. Users can
double-click the instance to inspect the three storage lanes.

The first demo sequence is:

```text
load              Q = 000, ticks = 0
tick              Q = 1T0, ticks = 1
EN=T, change D
tick              Q holds 1T0
RST=1, tick        Q = 000
reload             Q = 000, ticks = 0
```

## 6. Web Presentation

The example remains a normal editable Project v2 clone. Three existing Probe nodes display the
individual trits; the Register3 node concatenates the projected Rust outputs as `q2q1q0` for a
compact word label. This is presentation only: Phase 3B does not add a word probe, word state, or
second semantic calculation in TypeScript. The right-hand example help states the trit order,
decimal interpretation, and control priority.

The header phase badge becomes `PHASE 3B`. Desktop Chromium at 1440x900 is the blocking browser
viewport, following the user-approved fast-track policy from Phase 3A.

## 7. Validation

Rust project simulation proves two Register3 instances capture different words on one shared
clock, retain state while disabled, synchronously reset together, and do not recompile on source
updates. Web unit tests freeze exact circuit/module topology and defaults.

Real browser acceptance proves the editable example loads at `000`, captures `1T0`, holds while
disabled, clears under reset, supports entering the module definition, reports no console/page
errors, and has no desktop horizontal overflow.

## 8. Explicit Exclusions

Phase 3B does not add buses, splitters, word probes, automatic clocks, waveforms, physical delays,
shift behavior, counters, register files, multi-clock domains, or a native `sequential.register3`
kind. Those features build on this module after its parallel storage behavior is accepted.

## 9. Completion Criteria

- Register3 is visibly composed from exactly three DFFs.
- `D2/D1/D0` capture simultaneously under one Clock.
- `EN` holds and synchronous `RST` clears the entire word.
- Multiple instances own independent DFF state.
- The example is editable, exportable, and openable through hierarchy navigation.
- Rust, WASM, Web unit, production build, and desktop Playwright checks pass.

## 10. Acceptance Record

The completed Phase 3B implementation passed the following fresh checks on 2026-08-10:

- `cargo fmt --all -- --check` passed.
- `cargo clippy --workspace --all-targets -- -D warnings` passed with no diagnostics.
- `cargo test --workspace` passed 149 native tests: 147 in `sim-core` and 2 in `sim-wasm`.
- `wasm-pack test --node crates/sim-wasm` passed 11 real WASM tests: 6 project API and 5 flat API.
- `npm --prefix apps/web test` passed 106 tests in 14 files.
- `npm --prefix apps/web run build` passed TypeScript and the Vite production build.
- `npm --prefix apps/web run test:e2e -- tests/register3.spec.ts` passed one desktop Chromium flow.
- `git diff --check` passed.

The inspected 1440x900 screenshot is `docs/images/phase3b-register3.png`. It shows `D=1T0`,
`Q=1T0`, Clock returned to `0`, all three probes, and the phase badge without horizontal page
overflow or clipped controls. Browser acceptance also reported no console or page errors.

Residual non-blocking tool messages were limited to `wasm-pack` recommending optional Cargo
description/repository and a detected Cargo license without a crate-local license file, plus
Playwright's Node process noting that `FORCE_COLOR` overrides `NO_COLOR`.
