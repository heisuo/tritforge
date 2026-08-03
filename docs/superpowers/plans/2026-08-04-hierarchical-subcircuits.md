# Logsim Ternary Hierarchical Subcircuits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Project v2 and a dedicated module editor where reusable combinational subcircuits can be nested without recursion and simulated through a Rust hierarchy compiler.

**Architecture:** The editor persists main plus module definitions in a versioned project document. Rust validates the entire project, expands one active circuit into the existing flat simulator under strict resource budgets, and projects signals and diagnostics back through qualified provenance. TypeScript owns editing and presentation only; it does not expand modules or evaluate gates.

**Tech Stack:** Rust stable, `serde`, `wasm-bindgen`, React 19, TypeScript 7 strict mode, Zustand, React Flow, Vitest, Playwright.

---

## 1. Locked File Structure

```text
crates/sim-core/src/
├── project.rs
├── project_validation.rs
├── hierarchy.rs
├── project_simulator.rs
└── simulator.rs
crates/sim-core/tests/
├── project_contract.rs
├── project_validation.rs
├── hierarchy_compilation.rs
└── project_simulation.rs
crates/sim-wasm/tests/project_web_api.rs
apps/web/src/project/
├── project-document.ts
├── project-store.ts
├── project-catalog.ts
└── hierarchy-runtime.ts
apps/web/src/components/
├── ModuleManager.tsx
└── HierarchyBreadcrumbs.tsx
apps/web/src/examples/hierarchical-adder.ts
apps/web/tests/
├── project-document.test.ts
├── project-store.test.ts
├── project-catalog.test.ts
├── hierarchy-runtime.test.ts
└── hierarchy.spec.ts
schemas/project-v2.schema.json
docs/images/phase2a-hierarchy.png
```

The existing `CircuitDefinition` and `Simulator` remain the flat execution
engine. Do not add module semantics to `gates.rs` or TypeScript.

---

### Task 1: Define Project v2 and Qualified Diagnostic Contracts

**Files:**
- Create: `crates/sim-core/src/project.rs`
- Create: `crates/sim-core/tests/project_contract.rs`
- Modify: `crates/sim-core/src/lib.rs`

- [x] **Step 1: Write failing serde and identity tests**

```rust
use sim_core::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectComponent, ProjectDocument,
    QualifiedComponentRef,
};

#[test]
fn project_v2_round_trips_extension_properties() {
    let project = ProjectDocument {
        format: "logsim-ternary".into(),
        version: 2,
        root_circuit_id: "main".into(),
        circuits: vec![ProjectCircuit {
            id: "main".into(),
            name: "Main".into(),
            kind: ProjectCircuitKind::Main,
            components: vec![ProjectComponent::new(
                "input-1",
                "source.trit_input",
                serde_json::json!({"value": "0", "moduleId": 123}),
            ).unwrap()],
            connections: vec![],
        }],
    };
    let restored: ProjectDocument =
        serde_json::from_str(&serde_json::to_string(&project).unwrap()).unwrap();
    assert_eq!(restored, project);
}

#[test]
fn qualified_refs_include_their_own_scope() {
    let parent = QualifiedComponentRef::new("main", ["fa-1"], "input-a");
    let child = QualifiedComponentRef::new(
        "half-adder", ["fa-1", "ha-1"], "input-a",
    );
    assert_ne!(parent, child);
}
```

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test project_contract
```

Expected: compile failure because `sim_core::project` does not exist.

- [x] **Step 3: Add public contracts**

Define serde/ordering contracts for:

```rust
pub struct ProjectDocument {
    pub format: String,
    pub version: u32,
    pub root_circuit_id: String,
    pub circuits: Vec<ProjectCircuit>,
}
pub enum ProjectCircuitKind { Main, Module }
pub struct ProjectCircuit {
    pub id: String,
    pub name: String,
    pub kind: ProjectCircuitKind,
    pub components: Vec<ProjectComponent>,
    pub connections: Vec<ProjectConnection>,
}
pub struct ProjectComponent {
    pub id: String,
    pub type_id: String,
    pub properties: ProjectProperties,
}
pub struct ProjectConnection {
    pub id: String,
    pub source_component_id: String,
    pub source_port_id: String,
    pub target_component_id: String,
    pub target_port_id: String,
}
```

`ProjectProperties` wraps `serde_json::Map<String, Value>` and provides typed
accessors `known_value`, `module_id`, `port_id`, `label`, and `preview_value`
without consuming unrelated keys. Add `QualifiedComponentRef`,
`QualifiedConnectionRef`, `QualifiedPortRef`, and `ProjectDiagnostic` with
stable ordering. Each qualified ref owns its circuit ID and instance path.

- [x] **Step 4: Run GREEN**

```bash
cargo test -p sim-core --test project_contract
cargo fmt --all -- --check
cargo clippy -p sim-core --all-targets -- -D warnings
```

- [x] **Step 5: Commit**

```bash
git add crates/sim-core
git commit -m "feat: define hierarchical project contracts"
```

---

### Task 2: Validate Every Circuit, Interface, and Dependency

**Files:**
- Create: `crates/sim-core/src/project_validation.rs`
- Create: `crates/sim-core/tests/project_validation.rs`
- Modify: `crates/sim-core/src/lib.rs`

- [x] **Step 1: Write failing validation tests**

Create fixture helpers and assert these exact codes:

```rust
assert_code(invalid_root(), "INVALID_ROOT_CIRCUIT");
assert_code(duplicate_circuit_ids(), "DUPLICATE_CIRCUIT_ID");
assert_code(boundary_in_main(), "INVALID_MODULE_BOUNDARY");
assert_code(duplicate_port_ids(), "DUPLICATE_MODULE_PORT_ID");
assert_code(instance_missing_module(), "UNKNOWN_MODULE");
assert_code(instance_points_to_main(), "MODULE_REFERENCE_NOT_MODULE");
assert_code(wrong_dynamic_port_direction(), "INVALID_MODULE_PORT_DIRECTION");
assert_code(indirect_cycle(), "MODULE_DEPENDENCY_CYCLE");
assert_code(unreachable_unknown_gate(), "UNKNOWN_COMPONENT_TYPE");
```

Also assert `project.module_input` owns only `out`,
`project.module_output` owns only `in`, and module instances use dynamic
`portId` handles.

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test project_validation
```

- [x] **Step 3: Implement local validation and DAG analysis**

```rust
pub struct ModulePort {
    pub id: String,
    pub label: String,
    pub direction: PortDirection,
    pub boundary_component_id: String,
}
pub struct ValidatedProject {
    pub project: ProjectDocument,
    pub interfaces: BTreeMap<String, Vec<ModulePort>>,
    pub dependencies: BTreeMap<String, Vec<String>>,
}
pub fn validate_project(
    project: ProjectDocument,
) -> Result<ValidatedProject, Vec<ProjectDiagnostic>>;
```

Validate every circuit before reachability analysis. DFS colors are
`White/Gray/Black`; a Gray edge emits the full deterministic cycle path.
`moduleId` must equal a `kind: module` circuit ID and may never reference main.

- [x] **Step 4: Run GREEN and commit**

```bash
cargo test -p sim-core --test project_validation
cargo test -p sim-core
git add crates/sim-core
git commit -m "feat: validate module interfaces and dependencies"
```

---

### Task 3: Add Atomic Multi-Source Updates

**Files:**
- Modify: `crates/sim-core/src/simulator.rs`
- Modify: `crates/sim-core/tests/simulator_propagation.rs`

- [x] **Step 1: Add failing atomicity tests**

```rust
let before = simulator.snapshot();
let error = simulator.set_sources([
    ("input-1", Trit::Pos),
    ("constant-1", Trit::Neg),
    ("neg-1", Trit::Zero),
]).unwrap_err();
assert_eq!(error.code, "INVALID_SOURCE_UPDATE");
assert_eq!(simulator.snapshot(), before);
```

Add a successful batch that changes Trit Input and Constant together.

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test simulator_propagation set_sources
```

- [x] **Step 3: Implement atomic `set_sources`**

```rust
pub fn set_sources<I, S>(
    &mut self,
    updates: I,
) -> Result<SimulationSnapshot, Diagnostic>
where
    I: IntoIterator<Item = (S, Trit)>,
    S: Into<String>;
```

Collect and validate all updates first. Accept only Trit Input and Constant,
known trits, and unique IDs. Apply all values, then settle once with sorted
IDs. Keep `set_input` as a compatibility wrapper retaining its current error
code.

- [x] **Step 4: Run GREEN and commit**

```bash
cargo test -p sim-core --test simulator_propagation
cargo clippy -p sim-core --all-targets -- -D warnings
git add crates/sim-core
git commit -m "feat: update simulator sources atomically"
```

---

### Task 4: Analyze Budgets and Compile Hierarchies

**Files:**
- Create: `crates/sim-core/src/hierarchy.rs`
- Create: `crates/sim-core/tests/hierarchy_compilation.rs`
- Modify: `crates/sim-core/src/lib.rs`

- [x] **Step 1: Write failing compiler tests**

Assert two- and three-level expansion, deterministic IDs, no remaining
`project.*` types, IDs containing `/`, `~`, and `::`, unconnected `Z` staying
`Z`, and driver/consumer Cartesian rewiring. Add failures for depth 33,
10,001 components, 50,001 connections, 100,001 projection endpoints, and
checked multiplication overflow. Every failure uses
`HIERARCHY_EXPANSION_LIMIT` before a partial flat graph is returned.

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test hierarchy_compilation
```

- [x] **Step 3: Implement two-pass compilation**

```rust
pub const MAX_HIERARCHY_DEPTH: usize = 32;
pub const MAX_EXPANDED_COMPONENTS: usize = 10_000;
pub const MAX_EXPANDED_CONNECTIONS: usize = 50_000;
pub const MAX_PROJECTION_ENDPOINTS: usize = 100_000;

pub struct CompiledProject {
    pub circuit: CircuitDefinition,
    pub projection: ProjectionMap,
    pub provenance: ProvenanceMap,
}
pub fn compile_project(
    project: &ValidatedProject,
    active_circuit_id: &str,
) -> Result<CompiledProject, Vec<ProjectDiagnostic>>;
```

Pass 1 memoizes checked counts. Pass 2 rewires nested boundaries directly:
external drivers to internal targets and internal drivers to external targets.
Never insert BUF. Root module inputs become Trit Input and root outputs become
Probe. Encode path segments with JSON-Pointer escaping.

- [x] **Step 4: Run GREEN, mutation check, and commit**

```bash
cargo test -p sim-core --test hierarchy_compilation
cargo test -p sim-core
```

Temporarily set max depth to 2, confirm the three-level test fails, restore the
constant, and verify no source diff remains. Then commit:

```bash
git add crates/sim-core
git commit -m "feat: compile bounded module hierarchies"
```

---


### Task 5: Project Signals, Provenance, and Diagnostic Projection

**Files:**
- Create: `crates/sim-core/src/project_simulator.rs`
- Create: `crates/sim-core/tests/project_simulation.rs`
- Modify: `crates/sim-core/src/lib.rs`

- [x] **Step 1: Write failing projected-snapshot tests**

Assert logical module ports are returned instead of flat IDs:

```rust
assert_eq!(snapshot.component_outputs["full-adder-1"]["sum"], Trit::Neg);
assert!(snapshot.diagnostics.iter().all(|diagnostic| {
    diagnostic.components.iter().all(|reference| {
        !reference.component_id.contains("generated")
    })
}));
```

Cover boundary conflict without consumers, pure fanout conflict deduplication,
separate target-net conflicts with local drivers, a three-boundary causal chain,
cross-level qualified refs, invalid unreachable module invalidation/repair,
zero-copy source updates, and shared Constant updates across every instance.

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test project_simulation
```

- [x] **Step 3: Implement the active-root simulator**

```rust
pub struct ProjectSnapshot {
    pub component_outputs: BTreeMap<String, BTreeMap<String, Trit>>,
    pub input_nets: BTreeMap<String, BTreeMap<String, Trit>>,
    pub diagnostics: Vec<ProjectDiagnostic>,
    pub stable: bool,
    pub compile_count: u64,
}
pub struct ProjectSimulator { /* validated project, active id, flat simulator */ }
impl ProjectSimulator {
    pub fn load(project: ProjectDocument, active: &str)
        -> Result<Self, Vec<ProjectDiagnostic>>;
    pub fn update_project(&mut self, project: ProjectDocument)
        -> Result<ProjectSnapshot, Vec<ProjectDiagnostic>>;
    pub fn switch_active(&mut self, active: &str)
        -> Result<ProjectSnapshot, Vec<ProjectDiagnostic>>;
    pub fn set_source(&mut self, circuit: &str, component: &str, value: Trit)
        -> Result<ProjectSnapshot, ProjectDiagnostic>;
    pub fn snapshot(&self) -> Option<ProjectSnapshot>;
}
```

Maintain separate `TargetNetId` and `BoundaryPortNetId` maps. A downstream
boundary conflict is covered only when it has one upstream conflicting
boundary, the exact same canonical drivers, and no additional source. Map every
diagnostic ref through qualified provenance. Any project validation failure
drops the flat simulator and snapshot. A valid zero-copy source update changes
only the stored project.

- [x] **Step 4: Run GREEN and commit**

```bash
cargo test -p sim-core --test project_simulation
cargo test --workspace
git add crates/sim-core
git commit -m "feat: simulate and project hierarchical circuits"
```

---

### Task 6: Expose the Project Simulator through WASM

**Files:**
- Modify: `crates/sim-wasm/src/lib.rs`
- Create: `crates/sim-wasm/tests/project_web_api.rs`

- [ ] **Step 1: Write failing Node/WASM tests**

```rust
let mut simulator = WasmProjectSimulator::new();
let first = simulator.load_project(js_project(), "main")?;
assert_eq!(first.compile_count(), 1);
let second = simulator.set_source("main", "input-a", "1")?;
assert_eq!(second.compile_count(), 1);
let third = simulator.switch_active("half-adder")?;
assert_eq!(third.compile_count(), 2);
```

Also verify structured `MODULE_DEPENDENCY_CYCLE` and
`HIERARCHY_EXPANSION_LIMIT` failures.

- [ ] **Step 2: Run RED**

```bash
wasm-pack test --node crates/sim-wasm --test project_web_api
```

- [ ] **Step 3: Add `WasmProjectSimulator`**

Expose exact JS names:

```text
loadProject(project, activeCircuitId)
updateProject(project)
switchActive(activeCircuitId)
setSource(circuitId, componentId, value)
snapshot()
```

Reuse `BoundaryError`; use the first deterministic ProjectDiagnostic code as
the boundary code and serialize all diagnostics. Keep existing
`WasmSimulator` unchanged.

- [ ] **Step 4: Run GREEN and commit**

```bash
wasm-pack test --node crates/sim-wasm
cargo test --workspace
git add crates/sim-wasm
git commit -m "feat: expose hierarchical simulation to wasm"
```

---

### Task 7: Add Web Project v2 Schema, Parsing, and v1 Migration

**Files:**
- Create: `schemas/project-v2.schema.json`
- Create: `apps/web/src/project/project-document.ts`
- Create: `apps/web/tests/project-document.test.ts`
- Modify: `apps/web/src/editor/circuit-document.ts`

- [ ] **Step 1: Write failing migration tests**

```typescript
const migrated = parseProjectDocument(serializeCircuitDocument(v1));
expect(migrated).toMatchObject({
  format: "logsim-ternary",
  version: 2,
  rootCircuitId: "main",
  circuits: [{ id: "main", name: "Main", kind: "main" }],
});
expect(migrated.circuits[0].components).toEqual(v1.components);
```

Include v1 ordinary properties `{ moduleId: 123, portId: false }` and assert
they survive. Reject malformed special properties, two main circuits, invalid
zoom, duplicate circuit IDs, and unknown top-level keys.

- [ ] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- project-document.test.ts
```

- [ ] **Step 3: Implement v2 parsing and Schema**

```typescript
export interface ProjectDocumentV2 {
  format: "logsim-ternary";
  version: 2;
  rootCircuitId: string;
  circuits: ProjectCircuit[];
}
export interface ProjectCircuit {
  id: string;
  name: string;
  kind: "main" | "module";
  components: EditorComponent[];
  connections: EditorConnection[];
  viewport?: { x: number; y: number; zoom: number };
}
```

Dispatch by version. Export pure `migrateV1ToV2`. Schema uses `if/then` so
only `project.*` types constrain module keys. Ordinary extension keys remain
opaque. Deep-clone nested properties.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm --prefix apps/web test -- project-document.test.ts
npx --prefix apps/web tsc -b
node -e "JSON.parse(require('fs').readFileSync('schemas/project-v2.schema.json'))"
git add schemas apps/web/src/project apps/web/src/editor apps/web/tests/project-document.test.ts
git commit -m "feat: add versioned hierarchical project documents"
```

---

### Task 8: Build Project History, Navigation, and Dynamic Catalog

**Files:**
- Create: `apps/web/src/project/project-store.ts`
- Create: `apps/web/src/project/project-catalog.ts`
- Create: `apps/web/tests/project-store.test.ts`
- Create: `apps/web/tests/project-catalog.test.ts`

- [ ] **Step 1: Write failing store tests**

```typescript
store.getState().createModule("Half Adder");
store.getState().enterInstance("main", "ha-instance-1");
expect(store.getState().activePath.map((entry) => entry.circuitId))
  .toEqual(["main", "half-adder-1"]);
```

Also assert collision-free module IDs, used-module deletion protection,
connected-port deletion protection, label rename preserving port ID, separate
structure/value revisions, zero-copy source undo, active-path fallback after
undo, and cycle-causing catalog candidates being excluded.

- [ ] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- project-store.test.ts project-catalog.test.ts
```

- [ ] **Step 3: Implement store and dynamic descriptors**

```typescript
interface ProjectEditorState {
  past: ProjectDocumentV2[];
  project: ProjectDocumentV2;
  future: ProjectDocumentV2[];
  activePath: Array<{ circuitId: string; instanceId?: string }>;
  structureRevision: number;
  valueRevision: number;
}
```

Persist viewport per circuit before navigation. Selection and active path are
session-only. Dynamic descriptors use type `project.module_instance`, category
`project-module`, `moduleId`, and ordered boundary ports.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm --prefix apps/web test -- project-store.test.ts project-catalog.test.ts
npx --prefix apps/web tsc -b
git add apps/web/src/project apps/web/tests/project-store.test.ts apps/web/tests/project-catalog.test.ts
git commit -m "feat: manage project modules and navigation"
```

---

### Task 9: Integrate the Hierarchy Runtime

**Files:**
- Create: `apps/web/src/project/hierarchy-runtime.ts`
- Create: `apps/web/tests/hierarchy-runtime.test.ts`
- Modify: `apps/web/src/wasm-client.ts`
- Modify: `apps/web/src/editor-model.ts`

- [ ] **Step 1: Write failing adapter tests**

Mock `WasmProjectSimulator` and assert one load, value-only `setSource`,
reachable structural `updateProject`, and navigation `switchActive` calls.
An unreachable zero-copy value update must not call WASM. Scan the adapter
source and reject gate equations or a TypeScript module-flattening loop.

```typescript
runtime.load(project, "main");
runtime.setSource("half-adder", "constant-1", "T");
expect(mock.setSource).toHaveBeenCalledWith("half-adder", "constant-1", "T");
expect(mock.loadProject).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- hierarchy-runtime.test.ts
```

- [ ] **Step 3: Implement adapter and projected types**

Add TS types matching `ProjectSnapshot` and every qualified diagnostic ref.
Convert only naming conventions and WASM errors. Before serialization, build a
runtime-only project view that sorts each module's boundary nodes by editor
`position.y` and then component ID, preserves that order in the component
array, and strips editor-only position/label presentation fields. Rust therefore
owns simulation semantics without depending on canvas pixels. Keep the existing
single-circuit runtime until App migration is green. Structure revision changes
call `updateProject`; value revision changes call `setSource`; active ID changes
call `switchActive`.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm --prefix apps/web test -- hierarchy-runtime.test.ts wasm-client.test.ts
npx --prefix apps/web tsc -b
git add apps/web/src/project apps/web/src/wasm-client.ts apps/web/src/editor-model.ts apps/web/tests/hierarchy-runtime.test.ts
git commit -m "feat: adapt hierarchical wasm snapshots"
```

---

### Task 10: Add Module Management and Navigation UI

**Files:**
- Create: `apps/web/src/components/ModuleManager.tsx`
- Create: `apps/web/src/components/HierarchyBreadcrumbs.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/CircuitNode.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/app.test.tsx`

- [ ] **Step 1: Write failing interaction tests**

Assert accessible interactions for:

- `新建模块` creating and entering an empty module;
- `添加模块输入`/`添加模块输出` creating fixed `out`/`in` handles;
- module list `放置` and `编辑` icon buttons with tooltips;
- double-click module instance navigation;
- breadcrumb parent return;
- connected port deletion block with usage location;
- used module deletion block with reference count;
- existing mobile drawers containing module controls without page overflow.

- [ ] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- app.test.tsx
```

- [ ] **Step 3: Implement focused UI components**

Migrate App from single document history to `ProjectEditorState`; only the
active circuit maps to React Flow. Use Lucide `Plus`, `Pencil`, `Boxes`,
`ChevronRight`, and `ArrowLeft` with tooltips. Boundary nodes use stable node
dimensions and existing signal colors. Do not add explanatory feature text or
nested cards.

On validation failure set snapshot null before diagnostics render. Clicking a
qualified diagnostic navigates to its circuit/instance path and selects the
referenced item when present.

- [ ] **Step 4: Run GREEN, build, and commit**

```bash
npm --prefix apps/web test
npm --prefix apps/web run build
git add apps/web/src apps/web/tests/app.test.tsx
git commit -m "feat: edit and navigate reusable subcircuits"
```

---

### Task 11: Add Hierarchical Adder Acceptance and Performance

**Files:**
- Create: `apps/web/src/examples/hierarchical-adder.ts`
- Create: `apps/web/tests/hierarchy.spec.ts`
- Modify: `apps/web/src/examples.ts`
- Modify: `apps/web/playwright.config.ts`
- Create: `docs/images/phase2a-hierarchy.png`

- [ ] **Step 1: Add failing example contracts**

Freeze composition:

```text
Half Adder: 2 Module Input + MOD_SUM + CONSENSUS + 2 Module Output
Full Adder: 3 Module Input + 2 Half Adder instances + MOD_SUM + 2 Module Output
Main:       3 Trit Input + 1 Full Adder instance + 2 Probe
```

Enumerate all 27 known inputs through Rust/WASM and assert
`a + b + cin = sum + 3 * carry`.

- [ ] **Step 2: Add failing Playwright acceptance**

Automate load, output verification, Full Adder -> Half Adder navigation,
breadcrumb return, shared-definition update, port/module deletion protection,
v2 export/clear/import, recursive import diagnostics, and no console errors or
overflow at 1440x900, 900x700, and 390x844.

- [ ] **Step 3: Add 100-Full-Adder performance test**

```typescript
expect(result.fullAdderInstances).toBe(100);
expect(result.compileMs).toBeLessThan(process.env.CI ? 150 : 50);
expect(result.propagateMs).toBeLessThan(process.env.CI ? 150 : 50);
expect(result.compileCountAfterInputs).toBe(result.compileCountBeforeInputs);
```

Print expanded components, connections, projection endpoints, compile time,
propagation time, and compile counts.

- [ ] **Step 4: Implement example and capture screenshot**

Add `hierarchy.spec.ts` to Playwright matching. Capture the Half Adder internal
view at 1440x900 to `docs/images/phase2a-hierarchy.png`; inspect it with
`view_image` before documentation references it.

- [ ] **Step 5: Run GREEN and commit**

```bash
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web run test:e2e
git add apps/web docs/images
git commit -m "test: demonstrate nested ternary adders"
```

---

### Task 12: Documentation, CI, and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/specs/2026-08-04-hierarchical-subcircuits-design.md`

- [ ] **Step 1: Update documentation**

Document Project v2 migration, module creation and fixed handles, nesting,
breadcrumbs, protected deletion, Rust flattening, compile behavior, all four
resource limits, the phase 2A screenshot, and exclusions: recursion, buses,
sequential logic, and one-click packaging.

- [ ] **Step 2: Preserve the clean-checkout CI command chain**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
wasm-pack test --node crates/sim-wasm
npm ci --prefix apps/web
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web exec -- playwright install --with-deps chromium
npm --prefix apps/web run test:e2e
```

`npm test` must still build the ignored WASM package first.

- [ ] **Step 3: Append actual acceptance results**

Record date, test counts, three viewports, exact expanded benchmark size,
compile/propagation timings, compile-count result, and residual third-party
warnings. Never rewrite requirements to match implementation.

- [ ] **Step 4: Run final verification**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
wasm-pack test --node crates/sim-wasm
npm ci --prefix apps/web
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web run test:e2e
git diff --check
git status --short
```

Expected: every command exits 0; only documented wasm-pack metadata notices
remain; status lists only intended Task 12 files before commit.

- [ ] **Step 5: Commit and verify clean status**

```bash
git add README.md .github docs/superpowers/specs/2026-08-04-hierarchical-subcircuits-design.md
git commit -m "docs: complete hierarchical subcircuit phase"
git status --short
```

Expected: no output.

---

## 2. Spec Coverage

| Frozen requirement | Plan task |
|---|---|
| Project v2, v1 migration, Schema conditions | Tasks 1, 7 |
| Dedicated interfaces and protected edits | Tasks 2, 8, 10 |
| Arbitrary acyclic nesting and cycle diagnostics | Tasks 2, 4 |
| Expansion budgets and deterministic paths | Task 4 |
| Z/X/E-preserving rewiring | Tasks 4, 5 |
| Qualified provenance and conflict coverage | Task 5 |
| Shared and zero-copy source updates | Tasks 3, 5, 8 |
| Active-root navigation lifecycle | Tasks 5, 8-10 |
| Rust/WASM as only semantic source | Tasks 1-6, 9 |
| Half Adder -> Full Adder -> main | Task 11 |
| Performance, responsive UI, CI, docs | Tasks 11-12 |

## 3. Completion Checklist

- [ ] A user can create module ports and internal gates from an empty module.
- [ ] Modules can be repeated and nested at least three levels.
- [ ] Recursive, oversized, malformed, and stale-reference projects fail safely.
- [ ] v1 files migrate losslessly and v2 files round-trip.
- [ ] Input changes never increment compile count.
- [ ] Z/X/E and diagnostics cross boundaries without semantic drift.
- [ ] Qualified diagnostics navigate to the correct shared instance path.
- [ ] The hierarchical Full Adder passes all 27 known input combinations.
- [ ] Desktop, compact, and mobile browser acceptance passes.
- [ ] Full Rust, WASM, Web, build, and Playwright verification passes.
