# Basic-Gate Full-Adder Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-trit full-adder example's module node with a visible network of basic MUX3 gates.

**Architecture:** Build separate `sum` and `carry` ternary lookup trees from shared `a`, `b`, `cin`, and `T/0/1` sources. Keep the reusable Rust/WASM full-adder module and the 3-trit ripple example unchanged.

**Tech Stack:** TypeScript, React Flow document fixtures, Vitest, Rust/WASM runtime, Playwright

---

### Task 1: Lock The Example Structure

**Files:**
- Modify: `apps/web/tests/examples.test.ts`

- [ ] Add a test that clones `full-adder`, rejects every `module.*` node, and requires exactly 14 `gate.mux3` nodes.
- [ ] Run `npm test -- tests/examples.test.ts` from `apps/web` and confirm the new assertion fails because the fixture still contains `module.full_adder`.

### Task 2: Build And Verify The Gate Network

**Files:**
- Modify: `apps/web/src/examples.ts`
- Test: `apps/web/tests/examples.test.ts`

- [ ] Replace the module node with three shared inputs, three constants, six sum-path MUX3 gates, eight carry-path MUX3 gates, and two probes.
- [ ] Update the example description and composition text to state that the circuit is built from basic MUX3 gates.
- [ ] Run the focused Vitest test, then all frontend tests and `npm run build`.
- [ ] Load the example in Playwright and verify the default output and all 27 known input combinations against `a+b+cin=sum+3*carry`.
- [ ] Commit the implementation and documentation.
