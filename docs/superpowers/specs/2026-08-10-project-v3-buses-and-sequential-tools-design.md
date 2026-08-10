# Project v3 Buses, Timing, and Sequential Tools Design

**Status:** Approved for implementation on 2026-08-10

**Scope:** Phase 2B through Phase 3E

**Depends on:** Project v2 hierarchy, scalar six-state networks, DFF state, complete-cycle Tick,
and the editable Register3 module

## 1. Goal

This design adds the engineering facilities needed before the first 3-trit ALU and processor
datapath:

- multi-trit buses and strict width checking;
- explicit junctions, configurable splitters, and local named-network tunnels;
- half-cycle stepping, automatic clocks, and a bounded Chronogram;
- parameterized registers, shift registers, counters, and a 2R1W register file.

The work is deliberately split into independently accepted phases. It is not one large UI patch.
Rust remains the sole source of connectivity, signal-shape, virtual-time, and state-transition
semantics. TypeScript edits documents, schedules wall-clock calls, and renders Rust results.

## 2. Approved Delivery Order

1. **Phase 2B:** Project v3 signal shapes, undirected wires, migration, and scalar lowering.
2. **Phase 2C:** Junction, Tunnel, Splitter, bus ports, and bus rendering.
3. **Phase 3C:** Half-cycle virtual clock and bounded watched-signal history.
4. **Phase 3D:** Automatic clock controls and the compact Chronogram.
5. **Phase 3E:** Register, Shift Register, Counter, and 2R1W Register File structural macros.
6. **Integration:** An automatic-clock example combining counters, registers, named buses, and
   waveform observation.

Each phase must leave main usable, preserve older project imports, and have its own focused Rust,
WASM, Web, and browser acceptance.

## 3. Signal Shape and Word Convention

### 3.1 Width

A signal shape contains a trit width from 1 through 27 inclusive. The editor offers quick choices
for `1`, `3`, `6`, `9`, `18`, and `27`, but any integer in the range is legal.

The format stores a numeric width, so a future implementation may raise the runtime limit without
another file-format migration. Expanded scalar endpoints continue to count against hierarchy and
projection safety budgets.

### 3.2 Indexing and Numeric Meaning

Words are written `[width-1:0]`. Index 0 is the least-significant trit. A displayed word places
the most-significant trit on the left:

```text
Q[2:0] = Q2 Q1 Q0
value = sum(trit[i] * 3^i)
1T0 = 1*9 + (-1)*3 + 0 = 6
```

Known editable values contain exactly `width` symbols from `T/0/1`. Runtime values may also
contain `X/Z/E` independently at each index.

### 3.3 Rust-Owned Port Resolution

Port direction and shape are resolved from component type plus validated properties by one Rust
resolver exposed through WASM. This is required for dynamic module interfaces, Splitter branches,
and parameterized sequential components. TypeScript must not independently calculate widths.

Resolved ports use `input`, `output`, or `inout` direction. Primitive gates retain scalar input
and output ports. Wiring helpers use `inout` because they describe connectivity rather than logic
flow.

## 4. Project v3 Document

### 4.1 Top-Level Contract

Project v3 retains `format`, `rootCircuitId`, circuit IDs, component positions, properties,
viewports, and module hierarchy. Each circuit replaces directed `connections` with undirected
`wires`:

```json
{
  "format": "logsim-ternary",
  "version": 3,
  "rootCircuitId": "main",
  "circuits": [
    {
      "id": "main",
      "name": "Main",
      "kind": "main",
      "components": [],
      "wires": [
        {
          "id": "wire-1",
          "endpointA": { "componentId": "input-1", "portId": "out" },
          "endpointB": { "componentId": "tunnel-1", "portId": "net" }
        }
      ]
    }
  ]
}
```

Wire endpoints are component ports. Multiple wires may use the same port endpoint, naturally
forming fanout or a visual junction. Wire direction is derived only after component ports have
been resolved.

### 4.2 Migration

- Project v1 first migrates to the existing v2 representation and then to v3.
- Every v2 directed connection becomes one undirected wire between the same two ports.
- Existing components and module ports default to width 1.
- Shared source or target endpoints naturally become one electrical network during v3 union.
- Component positions, labels, properties, circuit order, module IDs, and viewports are preserved.
- Import accepts v1, v2, and v3. Export writes v3 only.
- There is no lossy v3-to-v2 downgrade.

Migration must be deterministic and idempotent after serialization.

## 5. Connectivity Compilation

Project v3 adds a connectivity pass before the existing hierarchy and scalar simulation passes:

```text
Project v3 wires and dynamic ports
        |
        v
endpoint union + local Tunnel-name union
        |
        v
shape and driver validation
        |
        v
Splitter bit mapping + bus scalar lowering
        |
        v
existing hierarchy expansion and scalar Simulator
```

The compiler uses union-find to group directly wired endpoints and same-circuit Tunnel endpoints.
It resolves each grouped net's width, drivers, consumers, provenance, and diagnostics before
allocating scalar expansion.

One width-W logical net lowers to W independent scalar nets. Existing six-state resolution,
delta-cycle propagation, multi-driver conflict detection, oscillation bounds, and DFF behavior
remain unchanged on those scalar nets. Project snapshots reassemble scalar values in original
word order.

Ordinary wires require equal endpoint widths. Width conversion, extraction, concatenation, or
index reordering must pass through an explicit Splitter. There is no implicit truncation,
extension, or numeric cast.

## 6. Wiring Helpers

### 6.1 Junction

`wiring.junction` has one `inout` port named `net` and a `width` property. Multiple attached wires
are one net. The canvas renders it as a filled connection dot. It has no runtime evaluator.

### 6.2 Tunnel

`wiring.tunnel` has one `inout` port named `net` and properties:

```text
label: non-empty network name
width: 1..27
```

All Tunnels with the same exact label in one circuit are electrically merged. Labels do not cross
module boundaries. Module communication remains explicit through Module Input and Module Output.

Same-label Tunnels with different widths produce `TUNNEL_WIDTH_CONFLICT`. Multiple drivers merged
through a Tunnel use normal six-state resolution and may produce `MULTIPLE_DRIVER_CONFLICT`.

### 6.3 Splitter

`wiring.splitter` is bidirectional and has one trunk plus dynamic branch ports. Properties are:

```text
width: 1..27
branchCount: 1..width
mapping: array of width branch indexes
```

`mapping[i]` identifies the branch containing trunk bit `i`. Every branch must receive at least
one bit. A branch word displays its selected trunk indexes in descending numeric order; scalar
lowering preserves the exact index mapping in both split and combine directions.

The default mapping distributes contiguous ranges as evenly as possible. For width 3 and three
branches, bit 0 maps to branch 0, bit 1 to branch 1, and bit 2 to branch 2.

Splitter is compile-time connectivity and does not enter the event queue.

### 6.4 Widened Sources, Probes, and Module Ports

Trit Input, Constant, Probe, Module Input, and Module Output gain width-aware forms while retaining
their existing type IDs and width-1 behavior. A width-W source property contains a W-symbol known
word. Module instance port shapes come from the referenced module boundaries.

Clock, DFF, control pins, and current scalar gates remain width 1.

## 7. Editor Interaction

### 7.1 Rendering

- Scalar wires render at 2 px.
- Bus wires render at 6 px with a stable neutral bus color and signal-state accents.
- Bus labels show optional network name, width, and current word value without changing routing.
- Junction is a filled dot.
- Tunnel shows its label and `[width]`.
- Splitter shows trunk and branch widths next to their handles.

A connection preview rejects mismatched widths before document mutation and names both widths, for
example `cannot connect 3 trit to 1 trit`. Imported invalid documents receive structured Rust
diagnostics at the responsible ports and wire.

### 7.2 Inspector

Width uses a numeric stepper plus common presets. Tunnel label is a validated text field. Splitter
configuration displays trunk bits and branch assignments explicitly; changing width or mapping is
one undoable transaction.

Ports, Tunnels, and buses provide an `Add to waveform` command. The command records a stable
qualified reference, not a display label.

## 8. Virtual Clock

### 8.1 Phase Model

Rust owns virtual clock phase and counters. A simulation starts at stable low:

```text
LowStable -> HighStable -> LowStable -> ...
```

The low-to-high transition propagates Clock, computes every sequential next state from old state,
commits all next states simultaneously, and settles downstream combinational logic. The
high-to-low transition lowers Clock and settles combinational logic without another state commit.

`advance_phase()` advances one transition. Existing `tick()` advances two transitions and returns
to its starting phase. From the normal low phase this preserves the current complete
`0 -> 1 -> 0` Tick contract. `tickCount` increases after a completed full period.

### 8.2 Automatic Run

The Web scheduler owns wall-clock timing only. It serially invokes Rust phase advancement and
never modifies Clock or component state directly.

Speed is expressed in complete cycles per second with presets `0.5`, `1`, `2`, `5`, `10`, and
`20`. Each cycle contains two phase calls. A delayed or backgrounded page does not enqueue an
unbounded catch-up burst; at most a small bounded number of transitions run per callback, and
wall-clock delay does not alter virtual circuit ordering.

Automatic run pauses on:

- project load, reset, or active-circuit switch;
- reachable structural edits or recompilation;
- non-convergence or an error diagnostic;
- a failed WASM boundary call.

Input changes are serialized with phase commands and may occur while running.

## 9. Trace Recorder and Chronogram

### 9.1 Trace Contract

The trace recorder watches only user-selected qualified component ports, Tunnel nets, or logical
buses. It does not retain complete project snapshots.

Each frame contains:

```text
cycle
phase
reason: load | input_change | clock_rise | clock_fall | reset | fault
watched values
```

History is a 512-frame ring buffer. Initial load creates one frame. Input changes append an
`input_change` frame. Every phase transition appends a frame after propagation settles. Faults
append and retain the failing frame before automatic pause.

Project reload, reset, active-root switch, or reachable structural recompile clears history and
invalid selections. A disappeared watch produces `TRACE_SIGNAL_UNAVAILABLE` and is removed
without crashing simulation.

### 9.2 Chronogram UI

The Chronogram is a collapsible, vertically resizable bottom dock in the existing workbench. It
must not hide the status bar or make toolbar controls overlap at supported desktop and compact
viewports.

First-version controls are:

- run and pause;
- advance one phase;
- advance one complete cycle;
- clear history;
- speed selection;
- add, remove, and reorder watched signals;
- movable time cursor;
- bus display as balanced ternary, decimal, or individual trits.

Known scalar trits use three vertical levels. `X/Z/E` use distinct non-level styling. Bus rows use
value bands with text at transitions instead of pretending the bus is one analog level.

VCD, trigger conditions, delta-event frames, unlimited history, advanced measurement cursors, and
physical-time delays are excluded.

## 10. Structural Sequential Components

All word-sized sequential components are structural compiler macros. They expand before scalar
simulation, and their DFFs remain the only state owners. Expanded IDs are stable and include the
source component's qualified hierarchy path.

### 10.1 Register

`sequential.register` generalizes Register3:

```text
inputs:  d[W], clk, en, rst
outputs: q[W]
width:   1..27
```

It expands to W DFFs with shared controls. `rst=1` clears, otherwise `en=1` captures in parallel,
otherwise state holds.

### 10.2 Shift Register

`sequential.shift_register` ports are:

```text
inputs:  din[W], sin, clk, en, load, rst
outputs: q[W], sout
width:   1..27
direction: toward_lst | toward_mst
```

Priority is `rst > load > en > hold`. `load=1` captures `din`. With `en=1`, toward-MST places
`sin` at index 0 and shifts each old index toward `W-1`; `sout` is the old index `W-1` value.
Toward-LST is symmetric.

It expands to W DFFs and input MUX logic.

### 10.3 Counter

`sequential.counter` ports are:

```text
inputs:  d[W], dir, clk, en, load, rst
outputs: q[W], carry
width:   1..27
```

Priority is `rst > load > en > hold`. Under enable, `dir=1` increments, `dir=T` decrements, and
`dir=0` holds. Arithmetic wraps at fixed width; `carry` exposes the balanced-ternary carry beyond
the most-significant trit.

It expands to a width-W Register and ripple arithmetic network.

### 10.4 Register File 2R1W

`sequential.register_file` has two asynchronous read ports and one rising-edge synchronous write
port:

```text
inputs:  read_addr_a[AW], read_addr_b[AW]
         write_addr[AW], write_data[W], write_enable, clk, rst
outputs: read_data_a[W], read_data_b[W]
wordWidth: 1..27
addressWidth: 1 | 2
registerCount: 3^AW
```

Balanced addresses map to physical indexes by adding bias `(3^AW - 1) / 2`:

```text
AW=1: T -> R0, 0 -> R1, 1 -> R2
AW=2: TT -> R0, ..., 00 -> R4, ..., 11 -> R8
```

All registers are writable; a CPU architecture may add a hardwired zero-register convention
later. Reset clears every register. If a read address equals a writing address, the asynchronous
read shows the old value before the rising edge and the newly committed value after propagation.

It expands to 3 or 9 word Registers, write-address decoding, and two read MUX trees.

## 11. Diagnostics

New stable diagnostic codes include:

| Code | Meaning |
|---|---|
| `INVALID_SIGNAL_WIDTH` | width is outside 1..27 |
| `WIDTH_MISMATCH` | directly connected port shapes differ |
| `INVALID_SPLITTER_MAP` | mapping length, branch index, or coverage is invalid |
| `TUNNEL_WIDTH_CONFLICT` | same local label has conflicting widths |
| `TRACE_SIGNAL_UNAVAILABLE` | a watched qualified signal no longer exists |
| `AUTOMATION_PAUSED` | automatic run stopped because the simulator cannot safely continue |

Existing duplicate, invalid endpoint, hierarchy-cycle, expansion-limit, multi-driver,
non-convergence, and project-readiness diagnostics remain authoritative.

All invalid edits are atomic. A failed width, Splitter, or sequential-property update leaves the
previous document and runtime intact.

## 12. Verification Strategy

### 12.1 Rust

- v1/v2-to-v3 migration preserves circuits, components, hierarchy, and connectivity.
- Union-find networks are permutation invariant.
- Tunnel names merge only inside one circuit.
- Bus lowering is equivalent to independently wiring every scalar index.
- Splitter mappings are exhaustive for small widths and property-tested through width 27.
- Width and expansion-limit failures occur before large scalar allocation.
- Phase stepping preserves simultaneous DFF commits and complete-Tick compatibility.
- Trace history is ordered, bounded, and fault-preserving.
- Register, Shift Register, Counter, and Register File expansions match independent behavioral
  oracles, including priority, wraparound, address bias, instance isolation, and read/write
  collision semantics.

### 12.2 WASM and Web

- Dynamic port shapes cross the WASM boundary without TypeScript recomputation.
- v1/v2 imports export stable v3 JSON.
- Invalid property edits are transactional.
- Automatic scheduling serializes calls and avoids unbounded catch-up.
- Chronogram selection uses stable qualified references and displays six-state words.

### 12.3 Browser

Blocking desktop and compact-browser flows cover:

- a 3-trit bus split into three scalar probes and recombined;
- two disconnected wire segments joined by a local Tunnel label;
- a width mismatch rejected without document damage;
- run, pause, phase step, complete Tick, cursor, and bounded waveform history;
- a Counter driving a Register and 2R1W Register File under automatic Clock;
- entering expanded structural definitions and seeing stable DFF lanes;
- no horizontal page overflow, clipped dynamic ports, incoherent overlap, or console/page errors.

## 13. Explicit Exclusions

This program does not add:

- project-global or cross-module Tunnel names;
- implicit bus truncation, extension, or numeric casts;
- arbitrary analog values, physical propagation time, setup/hold timing, or clock-domain analysis;
- VCD import/export, waveform triggers, or delta-event display;
- register files larger than nine words;
- RAM, ROM, stack, PC, IR, CPU FSM, or the ALU itself;
- native hidden word-state arrays that bypass structural DFF expansion.

Those features may build on this foundation in later phases.

## 14. Completion Criteria

- Project v3 is the only export format and imports v1/v2 without behavioral loss.
- Width-aware buses, Junctions, Tunnels, and Splitters work through nested modules.
- Rust lowers buses deterministically into the existing scalar simulator.
- Manual phase, complete Tick, and automatic run share one Rust time model.
- The Chronogram accurately displays selected scalar and bus values with bounded memory.
- Register, Shift Register, Counter, and 2R1W Register File are visibly hardware-expanded.
- Every phase passes fresh Rust, WASM, Web, production build, desktop, compact, and diff checks.
