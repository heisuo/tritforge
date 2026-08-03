# Logsim Ternary Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-based demonstration editor where users place and wire native ternary components, switch `T/0/1` inputs, and observe a Rust/WASM simulation of `T/0/1/X/Z/E`.

**Architecture:** A pure Rust `sim-core` crate owns all trit semantics, component evaluation, network resolution, validation, event propagation, and diagnostics. A thin `sim-wasm` crate exposes batch commands and snapshots. A React/TypeScript application uses React Flow for editing and rendering but never implements gate semantics.

**Tech Stack:** Rust stable, Cargo, `wasm-bindgen`, `serde`, `thiserror`, `proptest`, React 19, TypeScript 7 strict mode, Vite 8, `@xyflow/react`, Zustand, Lucide React, Vitest 4, Playwright.

---

## 1. Locked File Structure

```text
logsim-ternary/
├── .github/workflows/ci.yml
├── .gitignore
├── Cargo.toml
├── LICENSE
├── README.md
├── rust-toolchain.toml
├── crates/
│   ├── sim-core/
│   │   ├── Cargo.toml
│   │   ├── src/
│   │   │   ├── catalog.rs
│   │   │   ├── circuit.rs
│   │   │   ├── diagnostic.rs
│   │   │   ├── gates.rs
│   │   │   ├── lib.rs
│   │   │   ├── simulator.rs
│   │   │   └── trit.rs
│   │   └── tests/
│   │       ├── catalog_contract.rs
│   │       ├── circuit_validation.rs
│   │       ├── gate_truth_tables.rs
│   │       ├── simulator_propagation.rs
│   │       └── trit_contract.rs
│   └── sim-wasm/
│       ├── Cargo.toml
│       ├── src/lib.rs
│       └── tests/web_api.rs
├── apps/web/
│   ├── index.html
│   ├── package.json
│   ├── package-lock.json
│   ├── playwright.config.ts
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── public/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── styles.css
│   │   ├── app/editor-store.ts
│   │   ├── components/ComponentNode.tsx
│   │   ├── components/Inspector.tsx
│   │   ├── components/Palette.tsx
│   │   ├── components/StatusBar.tsx
│   │   ├── components/Toolbar.tsx
│   │   ├── components/signal-style.ts
│   │   ├── editor/circuit-document.ts
│   │   ├── editor/connections.ts
│   │   ├── editor/node-factory.ts
│   │   ├── examples/circuits.ts
│   │   ├── simulation/engine.ts
│   │   ├── simulation/types.ts
│   │   └── wasm/pkg/              # generated, ignored
│   └── tests/
│       ├── app.test.tsx
│       ├── connections.test.ts
│       ├── editor-store.test.ts
│       ├── engine.test.ts
│       ├── examples.test.ts
│       ├── inspector.test.tsx
│       ├── phase1.spec.ts
│       └── setup.ts
├── docs/
│   └── images/phase1-editor.png
└── schemas/
    └── circuit-v1.schema.json
```

Responsibilities are fixed:

- `sim-core` has no browser, WASM, React, or pixel-coordinate dependency.
- `sim-wasm` only converts data and owns simulator handles.
- `apps/web/src/simulation` is an adapter, not a second simulator.
- `editor` owns serializable layout and connections.
- `components` owns visual presentation.

## 2. Environment Preflight

The current machine has Node `v22.22.1` and npm `10.9.4`, but no usable Rust
toolchain. Install Rust before Task 1:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
```

Verify:

```bash
rustc --version
cargo --version
rustup target list --installed | rg '^wasm32-unknown-unknown'
wasm-pack --version
node --version
npm --version
```

Expected: every command exits `0`; Node remains major version 22.

---

### Task 1: Bootstrap the Rust and Web Workspaces

**Files:**
- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Create: `crates/sim-core/Cargo.toml`
- Create: `crates/sim-core/src/lib.rs`
- Create: `crates/sim-wasm/Cargo.toml`
- Create: `crates/sim-wasm/src/lib.rs`
- Create: `apps/web/package.json`
- Create: `apps/web/package-lock.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/tests/setup.ts`
- Create: `apps/web/tests/app.test.tsx`
- Modify: `.gitignore`

- [x] **Step 1: Add a failing Rust workspace smoke test**

Create `crates/sim-core/src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn phase_one_workspace_is_alive() {
        assert_eq!(crate::api_version(), 1);
    }
}
```

- [x] **Step 2: Run the Rust test and verify RED**

Run:

```bash
cargo test --workspace
```

Expected: compilation fails because the workspace manifests and `api_version`
do not exist.

- [x] **Step 3: Add minimal Rust manifests and API**

Root `Cargo.toml`:

```toml
[workspace]
members = ["crates/sim-core", "crates/sim-wasm"]
resolver = "2"
```

`rust-toolchain.toml`:

```toml
[toolchain]
channel = "stable"
profile = "minimal"
targets = ["wasm32-unknown-unknown"]
components = ["clippy", "rustfmt"]
```

`crates/sim-core/Cargo.toml`:

```toml
[package]
name = "sim-core"
version = "0.1.0"
edition = "2024"
license = "GPL-3.0-only"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"

[dev-dependencies]
proptest = "1"
```

Add above the test in `crates/sim-core/src/lib.rs`:

```rust
pub const fn api_version() -> u32 {
    1
}
```

`crates/sim-wasm/Cargo.toml`:

```toml
[package]
name = "sim-wasm"
version = "0.1.0"
edition = "2024"
license = "GPL-3.0-only"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
js-sys = "0.3"
serde = { version = "1", features = ["derive"] }
serde-wasm-bindgen = "0.6"
sim-core = { path = "../sim-core" }
wasm-bindgen = "0.2"

[dev-dependencies]
wasm-bindgen-test = "0.3"
```

`crates/sim-wasm/src/lib.rs`:

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = apiVersion)]
pub fn api_version() -> u32 {
    sim_core::api_version()
}
```

- [x] **Step 4: Add the Web smoke test and scaffold**

`apps/web/package.json`:

```json
{
  "name": "@logsim-ternary/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build:wasm": "wasm-pack build ../../crates/sim-wasm --target web --out-dir ../../apps/web/src/wasm/pkg",
    "dev": "npm run build:wasm && vite",
    "build": "npm run build:wasm && tsc -b && vite build",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@xyflow/react": "12.11.2",
    "lucide-react": "1.27.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zustand": "5.0.14"
  },
  "devDependencies": {
    "@playwright/test": "1.62.0",
    "@testing-library/jest-dom": "6.9.1",
    "@testing-library/react": "16.3.0",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.4",
    "jsdom": "28.0.0",
    "typescript": "7.0.2",
    "vite": "8.1.5",
    "vitest": "4.1.10"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "tests", "vite.config.ts", "playwright.config.ts"]
}
```

`apps/web/vite.config.ts`:

```typescript
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./tests/setup.ts",
  },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Logsim Ternary</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/web/src/App.tsx`:

```tsx
export function App() {
  return <main aria-label="Logsim Ternary 编辑器">WASM loading</main>;
}
```

`apps/web/tests/setup.ts`:

```typescript
import "@testing-library/jest-dom/vitest";
```

`apps/web/tests/app.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";

describe("App", () => {
  it("opens directly into the editor shell", () => {
    render(<App />);
    expect(screen.getByRole("main", { name: "Logsim Ternary 编辑器" }))
      .toBeInTheDocument();
  });
});
```

- [x] **Step 5: Ignore generated files and install dependencies**

Append to `.gitignore`:

```gitignore
target/
apps/web/node_modules/
apps/web/dist/
apps/web/test-results/
apps/web/playwright-report/
apps/web/src/wasm/pkg/
```

Run:

```bash
cd apps/web
npm install
cd ../..
```

Expected: `apps/web/package-lock.json` is created.

- [x] **Step 6: Verify GREEN**

Run:

```bash
cargo test --workspace
npm --prefix apps/web test
npm --prefix apps/web run build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: Rust smoke test and Web smoke test pass; production build succeeds.

- [x] **Step 7: Commit**

```bash
git add .gitignore Cargo.toml rust-toolchain.toml crates apps/web
git commit -m "chore: bootstrap ternary simulator workspace"
```

---

### Task 2: Implement Trit Values and Order-Independent Network Resolution

**Files:**
- Create: `crates/sim-core/src/trit.rs`
- Create: `crates/sim-core/tests/trit_contract.rs`
- Modify: `crates/sim-core/src/lib.rs`

- [x] **Step 1: Write failing Trit contract tests**

`crates/sim-core/tests/trit_contract.rs`:

```rust
use proptest::prelude::*;
use sim_core::trit::{resolve_drivers, Trit};

#[test]
fn trit_serializes_as_stable_symbols() {
    let values = [
        (Trit::Neg, "\"T\""),
        (Trit::Zero, "\"0\""),
        (Trit::Pos, "\"1\""),
        (Trit::Unknown, "\"X\""),
        (Trit::HighZ, "\"Z\""),
        (Trit::Error, "\"E\""),
    ];
    for (value, encoded) in values {
        assert_eq!(serde_json::to_string(&value).unwrap(), encoded);
        assert_eq!(serde_json::from_str::<Trit>(encoded).unwrap(), value);
    }
}

#[test]
fn resolves_known_unknown_high_z_and_conflict() {
    assert_eq!(resolve_drivers(&[]), Trit::HighZ);
    assert_eq!(resolve_drivers(&[Trit::HighZ, Trit::Neg]), Trit::Neg);
    assert_eq!(resolve_drivers(&[Trit::Pos, Trit::Pos]), Trit::Pos);
    assert_eq!(resolve_drivers(&[Trit::Neg, Trit::Pos]), Trit::Error);
    assert_eq!(resolve_drivers(&[Trit::Zero, Trit::Unknown]), Trit::Unknown);
    assert_eq!(resolve_drivers(&[Trit::Error, Trit::HighZ]), Trit::Error);
}

#[test]
fn resolves_the_complete_two_driver_matrix() {
    let values = [
        Trit::Neg,
        Trit::Zero,
        Trit::Pos,
        Trit::Unknown,
        Trit::HighZ,
        Trit::Error,
    ];
    let expected = [
        [Trit::Neg, Trit::Error, Trit::Error, Trit::Unknown, Trit::Neg, Trit::Error],
        [Trit::Error, Trit::Zero, Trit::Error, Trit::Unknown, Trit::Zero, Trit::Error],
        [Trit::Error, Trit::Error, Trit::Pos, Trit::Unknown, Trit::Pos, Trit::Error],
        [Trit::Unknown, Trit::Unknown, Trit::Unknown, Trit::Unknown, Trit::Unknown, Trit::Error],
        [Trit::Neg, Trit::Zero, Trit::Pos, Trit::Unknown, Trit::HighZ, Trit::Error],
        [Trit::Error, Trit::Error, Trit::Error, Trit::Error, Trit::Error, Trit::Error],
    ];

    for (row, left) in values.iter().copied().enumerate() {
        for (column, right) in values.iter().copied().enumerate() {
            assert_eq!(resolve_drivers(&[left, right]), expected[row][column]);
        }
    }
}

proptest! {
    #[test]
    fn resolution_is_permutation_invariant(mut values in prop::collection::vec(0u8..6, 0..12)) {
        let map = |n| match n {
            0 => Trit::Neg, 1 => Trit::Zero, 2 => Trit::Pos,
            3 => Trit::Unknown, 4 => Trit::HighZ, _ => Trit::Error,
        };
        let original: Vec<_> = values.iter().copied().map(map).collect();
        values.reverse();
        let reversed: Vec<_> = values.iter().copied().map(map).collect();
        prop_assert_eq!(resolve_drivers(&original), resolve_drivers(&reversed));
    }
}
```

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test trit_contract
```

Expected: fails because `sim_core::trit` does not exist.

- [x] **Step 3: Implement `Trit` and aggregate resolution**

`crates/sim-core/src/trit.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Trit {
    #[serde(rename = "T")]
    Neg,
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1")]
    Pos,
    #[serde(rename = "X")]
    Unknown,
    #[serde(rename = "Z")]
    HighZ,
    #[serde(rename = "E")]
    Error,
}

impl Trit {
    pub const fn is_known(self) -> bool {
        matches!(self, Self::Neg | Self::Zero | Self::Pos)
    }

    pub const fn balanced_value(self) -> Option<i8> {
        match self {
            Self::Neg => Some(-1),
            Self::Zero => Some(0),
            Self::Pos => Some(1),
            _ => None,
        }
    }

    pub const fn normalize_gate_input(self) -> Self {
        match self {
            Self::HighZ => Self::Unknown,
            other => other,
        }
    }
}

pub fn resolve_drivers(drivers: &[Trit]) -> Trit {
    if drivers.iter().any(|value| *value == Trit::Error) {
        return Trit::Error;
    }

    let mut known = [false; 3];
    let mut has_unknown = false;
    for value in drivers {
        match value {
            Trit::Neg => known[0] = true,
            Trit::Zero => known[1] = true,
            Trit::Pos => known[2] = true,
            Trit::Unknown => has_unknown = true,
            Trit::HighZ => {}
            Trit::Error => unreachable!(),
        }
    }

    if known.iter().filter(|present| **present).count() > 1 {
        Trit::Error
    } else if has_unknown {
        Trit::Unknown
    } else if known[0] {
        Trit::Neg
    } else if known[1] {
        Trit::Zero
    } else if known[2] {
        Trit::Pos
    } else {
        Trit::HighZ
    }
}
```

Export it from `crates/sim-core/src/lib.rs`:

```rust
pub mod trit;
```

- [x] **Step 4: Run GREEN and quality checks**

```bash
cargo test -p sim-core --test trit_contract
cargo fmt --all -- --check
cargo clippy -p sim-core --all-targets -- -D warnings
```

Expected: all Trit tests pass.

- [x] **Step 5: Commit**

```bash
git add crates/sim-core/src crates/sim-core/tests/trit_contract.rs
git commit -m "feat: define native ternary signal states"
```

---

### Task 3: Define the Component Catalog and Gate Truth Tables

**Files:**
- Create: `crates/sim-core/src/catalog.rs`
- Create: `crates/sim-core/src/gates.rs`
- Create: `crates/sim-core/tests/catalog_contract.rs`
- Create: `crates/sim-core/tests/gate_truth_tables.rs`
- Modify: `crates/sim-core/src/lib.rs`

- [x] **Step 1: Write failing catalog and gate tests**

`crates/sim-core/tests/catalog_contract.rs`:

```rust
use sim_core::catalog::component_catalog;

#[test]
fn phase_one_catalog_contains_exactly_twelve_types() {
    let ids: Vec<_> = component_catalog().into_iter().map(|item| item.type_id).collect();
    assert_eq!(ids, vec![
        "source.trit_input", "source.constant", "sink.probe",
        "gate.buf", "gate.neg", "gate.min", "gate.max",
        "gate.is_neg", "gate.is_zero", "gate.is_pos",
        "gate.mux2", "gate.mux3",
    ]);
}
```

`crates/sim-core/tests/gate_truth_tables.rs`:

```rust
use std::collections::BTreeMap;
use sim_core::catalog::{ComponentKind, ComponentProperties};
use sim_core::gates::evaluate;
use sim_core::trit::Trit;

fn inputs(values: &[(&str, Trit)]) -> BTreeMap<String, Trit> {
    values.iter().map(|(name, value)| ((*name).into(), *value)).collect()
}

#[test]
fn neg_min_max_and_decoders_match_the_locked_tables() {
    let p = ComponentProperties::default();
    let known = [Trit::Neg, Trit::Zero, Trit::Pos];
    let neg_expected = [Trit::Pos, Trit::Zero, Trit::Neg];
    let min_expected = [
        Trit::Neg, Trit::Neg, Trit::Neg,
        Trit::Neg, Trit::Zero, Trit::Zero,
        Trit::Neg, Trit::Zero, Trit::Pos,
    ];
    let max_expected = [
        Trit::Neg, Trit::Zero, Trit::Pos,
        Trit::Zero, Trit::Zero, Trit::Pos,
        Trit::Pos, Trit::Pos, Trit::Pos,
    ];

    for (index, a) in known.iter().copied().enumerate() {
        assert_eq!(
            evaluate(ComponentKind::Neg, &p, &inputs(&[("a", a)]))["y"],
            neg_expected[index]
        );
        for (b_index, b) in known.iter().copied().enumerate() {
            let flat = index * 3 + b_index;
            let values = inputs(&[("a", a), ("b", b)]);
            assert_eq!(evaluate(ComponentKind::Min, &p, &values)["y"], min_expected[flat]);
            assert_eq!(evaluate(ComponentKind::Max, &p, &values)["y"], max_expected[flat]);
        }

        for (kind, selected) in [
            (ComponentKind::IsNeg, index == 0),
            (ComponentKind::IsZero, index == 1),
            (ComponentKind::IsPos, index == 2),
        ] {
            let expected = if selected { Trit::Pos } else { Trit::Neg };
            assert_eq!(evaluate(kind, &p, &inputs(&[("a", a)]))["y"], expected);
        }
    }
}

#[test]
fn muxes_use_balanced_selectors_and_ignore_unselected_errors() {
    let p = ComponentProperties::default();
    let known = [Trit::Neg, Trit::Zero, Trit::Pos];
    for a in known {
        for b in known {
            for selector in known {
                let mux2 = inputs(&[("a", a), ("b", b), ("s", selector)]);
                let expected = match selector {
                    Trit::Neg => a,
                    Trit::Zero => Trit::Unknown,
                    Trit::Pos => b,
                    _ => unreachable!(),
                };
                assert_eq!(evaluate(ComponentKind::Mux2, &p, &mux2)["y"], expected);
            }
        }
    }

    for a in known {
        for b in known {
            for c in known {
                for selector in known {
                    let mux3 = inputs(&[
                        ("a", a), ("b", b), ("c", c), ("s", selector),
                    ]);
                    let expected = match selector {
                        Trit::Neg => a,
                        Trit::Zero => b,
                        Trit::Pos => c,
                        _ => unreachable!(),
                    };
                    assert_eq!(evaluate(ComponentKind::Mux3, &p, &mux3)["y"], expected);
                }
            }
        }
    }

    let mux3 = inputs(&[
        ("a", Trit::Error), ("b", Trit::Zero), ("c", Trit::Pos), ("s", Trit::Pos),
    ]);
    assert_eq!(evaluate(ComponentKind::Mux3, &p, &mux3)["y"], Trit::Pos);
}

#[test]
fn ordinary_gates_propagate_meta_states_conservatively() {
    let p = ComponentProperties::default();
    assert_eq!(evaluate(ComponentKind::Buf, &p, &inputs(&[("a", Trit::HighZ)]))["y"], Trit::Unknown);
    assert_eq!(evaluate(ComponentKind::Min, &p, &inputs(&[("a", Trit::Neg), ("b", Trit::Unknown)]))["y"], Trit::Unknown);
    assert_eq!(evaluate(ComponentKind::Max, &p, &inputs(&[("a", Trit::Error), ("b", Trit::Pos)]))["y"], Trit::Error);
}
```

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test catalog_contract --test gate_truth_tables
```

Expected: modules and types are missing.

- [x] **Step 3: Implement stable descriptors**

`catalog.rs` must define:

```rust
use serde::{Deserialize, Serialize};
use crate::trit::Trit;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortDirection { Input, Output }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortDescriptor {
    pub id: String,
    pub direction: PortDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComponentKind {
    TritInput, Constant, Probe, Buf, Neg, Min, Max,
    IsNeg, IsZero, IsPos, Mux2, Mux3,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentProperties {
    pub value: Option<Trit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentDescriptor {
    pub type_id: String,
    pub display_name: String,
    pub category: String,
    pub kind: ComponentKind,
    pub ports: Vec<PortDescriptor>,
    pub truth_table: Vec<TruthTableRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TruthTableRow {
    pub inputs: Vec<Trit>,
    pub outputs: Vec<Trit>,
}
```

Implement `ComponentKind::type_id`, `ComponentKind::from_type_id`,
`ComponentKind::port_descriptors`, and `component_catalog()` in the exact order
asserted by the test. Build truth tables by enumerating `T/0/1` inputs and
calling the Rust evaluator; do not hand-maintain a second table.

Use these exact phase-one port contracts:

```text
source.trit_input: out
source.constant:   out
sink.probe:        in
gate.buf/neg/is_*: a -> y
gate.min/max:      a,b -> y
gate.mux2:         a,b,s -> y
gate.mux3:         a,b,c,s -> y
```

The three non-gate types have an empty `truth_table`. Gate descriptors contain
all known-input rows in lexical input order matching the listed ports.

- [x] **Step 4: Implement gate evaluation**

`gates.rs` must expose:

```rust
pub fn evaluate(
    kind: ComponentKind,
    properties: &ComponentProperties,
    inputs: &BTreeMap<String, Trit>,
) -> BTreeMap<String, Trit>
```

Implement the exact semantics from the approved spec:

```rust
fn neg(value: Trit) -> Trit {
    match value.normalize_gate_input() {
        Trit::Neg => Trit::Pos,
        Trit::Zero => Trit::Zero,
        Trit::Pos => Trit::Neg,
        Trit::Error => Trit::Error,
        Trit::Unknown | Trit::HighZ => Trit::Unknown,
    }
}
```

For ordinary multi-input gates, return `E` if any normalized input is `E`,
otherwise `X` if any is `X`, otherwise calculate over balanced values.

For `MUX2`, selector `T` chooses `a`, selector `1` chooses `b`, selector `0`
returns `X`. For `MUX3`, selector `T/0/1` chooses `a/b/c`. Only normalize the
selected data input.

Source behavior:

```text
TritInput: properties.value.unwrap_or(0) -> out
Constant:  properties.value.unwrap_or(0) -> out
Probe:     no outputs
```

- [x] **Step 5: Add algebraic property tests**

Add to `gate_truth_tables.rs` using `proptest!` over integers `0..3`, mapped to
known trits. Exercise only the public evaluator:

```rust
use proptest::prelude::*;

fn known(index: u8) -> Trit {
    [Trit::Neg, Trit::Zero, Trit::Pos][index as usize]
}

fn unary(kind: ComponentKind, a: Trit) -> Trit {
    evaluate(
        kind,
        &ComponentProperties::default(),
        &inputs(&[("a", a)]),
    )["y"]
}

fn binary(kind: ComponentKind, a: Trit, b: Trit) -> Trit {
    evaluate(
        kind,
        &ComponentProperties::default(),
        &inputs(&[("a", a), ("b", b)]),
    )["y"]
}

proptest! {
    #[test]
    fn known_gate_algebra(a in 0u8..3, b in 0u8..3) {
        let a = known(a);
        let b = known(b);

        prop_assert_eq!(unary(ComponentKind::Neg, unary(ComponentKind::Neg, a)), a);
        prop_assert_eq!(
            binary(ComponentKind::Min, a, b),
            binary(ComponentKind::Min, b, a),
        );
        prop_assert_eq!(
            binary(ComponentKind::Max, a, b),
            binary(ComponentKind::Max, b, a),
        );

        let lhs = binary(ComponentKind::Min, a, b);
        let rhs = unary(
            ComponentKind::Neg,
            binary(
                ComponentKind::Max,
                unary(ComponentKind::Neg, a),
                unary(ComponentKind::Neg, b),
            ),
        );
        prop_assert_eq!(lhs, rhs);
    }
}
```

- [x] **Step 6: Verify GREEN**

```bash
cargo test -p sim-core --test catalog_contract --test gate_truth_tables
cargo clippy -p sim-core --all-targets -- -D warnings
```

Expected: catalog, truth-table, meta-state, and property tests pass.

- [x] **Step 7: Commit**

```bash
git add crates/sim-core/src crates/sim-core/tests
git commit -m "feat: add ternary component catalog and gates"
```

---

### Task 4: Validate Circuit Definitions and Build Input Networks

**Files:**
- Create: `crates/sim-core/src/circuit.rs`
- Create: `crates/sim-core/src/diagnostic.rs`
- Create: `crates/sim-core/tests/circuit_validation.rs`
- Modify: `crates/sim-core/src/lib.rs`

- [x] **Step 1: Write failing validation tests**

```rust
use sim_core::catalog::ComponentProperties;
use sim_core::circuit::{
    validate_circuit, CircuitDefinition, ComponentInstance, Connection,
};

fn component(id: &str, type_id: &str) -> ComponentInstance {
    ComponentInstance {
        id: id.into(),
        type_id: type_id.into(),
        properties: ComponentProperties::default(),
    }
}

fn connection(id: &str, sc: &str, sp: &str, tc: &str, tp: &str) -> Connection {
    Connection {
        id: id.into(),
        source_component_id: sc.into(),
        source_port_id: sp.into(),
        target_component_id: tc.into(),
        target_port_id: tp.into(),
    }
}

#[test]
fn accepts_fanout_and_multiple_drivers_to_one_input() {
    let circuit = CircuitDefinition {
        components: vec![
            component("a", "source.trit_input"),
            component("b", "source.trit_input"),
            component("p1", "sink.probe"),
            component("p2", "sink.probe"),
        ],
        connections: vec![
            connection("e1", "a", "out", "p1", "in"),
            connection("e2", "a", "out", "p2", "in"),
            connection("e3", "b", "out", "p1", "in"),
        ],
    };
    let outcome = validate_circuit(circuit).expect("valid circuit");
    assert_eq!(outcome.circuit.connection_count(), 3);
    assert_eq!(outcome.circuit.drivers_for("p1", "in").len(), 2);
}

#[test]
fn rejects_duplicate_components_unknown_types_and_bad_ports() {
    let duplicate = CircuitDefinition {
        components: vec![component("x", "gate.neg"), component("x", "gate.buf")],
        connections: vec![],
    };
    let codes: Vec<_> = validate_circuit(duplicate)
        .unwrap_err().into_iter().map(|item| item.code).collect();
    assert!(codes.contains(&"DUPLICATE_COMPONENT_ID".into()));

    let unknown = CircuitDefinition {
        components: vec![component("x", "gate.missing")],
        connections: vec![],
    };
    assert_eq!(
        validate_circuit(unknown).unwrap_err()[0].code,
        "UNKNOWN_COMPONENT_TYPE"
    );

    let bad_port = CircuitDefinition {
        components: vec![
            component("a", "source.trit_input"),
            component("p", "sink.probe"),
        ],
        connections: vec![connection("e", "a", "missing", "p", "in")],
    };
    assert_eq!(validate_circuit(bad_port).unwrap_err()[0].code, "UNKNOWN_PORT");
}

#[test]
fn rejects_input_to_input_and_output_to_output_connections() {
    let input_to_input = CircuitDefinition {
        components: vec![component("a", "gate.neg"), component("b", "gate.buf")],
        connections: vec![connection("e", "a", "a", "b", "a")],
    };
    assert_eq!(
        validate_circuit(input_to_input).unwrap_err()[0].code,
        "INVALID_PORT_DIRECTION"
    );

    let output_to_output = CircuitDefinition {
        components: vec![component("a", "gate.neg"), component("b", "gate.buf")],
        connections: vec![connection("e", "a", "y", "b", "y")],
    };
    assert_eq!(
        validate_circuit(output_to_output).unwrap_err()[0].code,
        "INVALID_PORT_DIRECTION"
    );
}

#[test]
fn ignores_duplicate_connections_with_a_warning() {
    let circuit = CircuitDefinition {
        components: vec![
            component("a", "source.trit_input"),
            component("p", "sink.probe"),
        ],
        connections: vec![
            connection("e1", "a", "out", "p", "in"),
            connection("e2", "a", "out", "p", "in"),
        ],
    };
    let outcome = validate_circuit(circuit).expect("duplicates are warnings");
    assert_eq!(outcome.circuit.connection_count(), 1);
    assert_eq!(outcome.warnings[0].code, "DUPLICATE_CONNECTION");
}
```

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test circuit_validation
```

Expected: circuit types are missing.

- [x] **Step 3: Implement serializable circuit types**

`circuit.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentInstance {
    pub id: String,
    pub type_id: String,
    #[serde(default)]
    pub properties: ComponentProperties,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub source_component_id: String,
    pub source_port_id: String,
    pub target_component_id: String,
    pub target_port_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitDefinition {
    pub components: Vec<ComponentInstance>,
    pub connections: Vec<Connection>,
}
```

Define `PortRef`, `ValidatedCircuit`, inbound drivers grouped by target port,
and downstream components grouped by source output. Expose read-only
`connection_count()` and `drivers_for(component_id, port_id)` methods used by
the tests.

- [x] **Step 4: Implement validation and diagnostic codes**

`diagnostic.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity { Info, Warning, Error }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    pub component_ids: Vec<String>,
    pub connection_ids: Vec<String>,
    pub port_ids: Vec<String>,
}
```

`validate_circuit` returns `Result<ValidationOutcome, Vec<Diagnostic>>`.
Use exact codes:

```text
DUPLICATE_COMPONENT_ID
UNKNOWN_COMPONENT_TYPE
UNKNOWN_COMPONENT
UNKNOWN_PORT
INVALID_PORT_DIRECTION
INVALID_PROPERTY
DUPLICATE_CONNECTION
```

Only `DUPLICATE_CONNECTION` is a warning; all other listed codes reject load.

- [x] **Step 5: Verify GREEN**

```bash
cargo test -p sim-core --test circuit_validation
cargo test -p sim-core
```

Expected: validation tests and all prior tests pass.

- [x] **Step 6: Commit**

```bash
git add crates/sim-core/src crates/sim-core/tests/circuit_validation.rs
git commit -m "feat: validate ternary circuit graphs"
```

---

### Task 5: Implement Deterministic Delta-Cycle Simulation

**Files:**
- Create: `crates/sim-core/src/simulator.rs`
- Create: `crates/sim-core/tests/simulator_propagation.rs`
- Modify: `crates/sim-core/src/lib.rs`

- [x] **Step 1: Write failing propagation tests**

Build circuits for:

```text
Input -> NEG -> Probe
Input -> BUF -> two Probes
two Constants -> one Probe input
unconnected Probe
Input -> NEG -> same NEG input
```

Assert:

```rust
assert_eq!(snapshot.input_value("probe", "in"), Some(Trit::Pos));
assert!(snapshot.stable);
assert_eq!(snapshot.diagnostics, vec![]);
```

For multiple different known drivers, assert `E` plus
`MULTIPLE_DRIVER_CONFLICT`. For the unconnected Probe, assert input `Z` plus
`UNDRIVEN_INPUT`. For the self-inverting loop, assert
`stable == false`, `NON_CONVERGENT_COMBINATIONAL_LOOP`, and processed events
do not exceed `max(1024, 64 * (components + connections))`.

- [x] **Step 2: Run RED**

```bash
cargo test -p sim-core --test simulator_propagation
```

Expected: `Simulator` and `SimulationSnapshot` are missing.

- [x] **Step 3: Implement simulator state and snapshots**

Define:

```rust
pub struct Simulator {
    circuit: ValidatedCircuit,
    source_properties: BTreeMap<String, ComponentProperties>,
    component_outputs: BTreeMap<PortRef, Trit>,
    input_nets: BTreeMap<PortRef, Trit>,
    diagnostics: Vec<Diagnostic>,
    processed_events: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationSnapshot {
    pub api_version: u32,
    pub stable: bool,
    pub component_outputs: BTreeMap<String, BTreeMap<String, Trit>>,
    pub input_nets: BTreeMap<String, BTreeMap<String, Trit>>,
    pub diagnostics: Vec<Diagnostic>,
    pub processed_events: usize,
}
```

Expose:

```rust
impl Simulator {
    pub fn load(definition: CircuitDefinition) -> Result<Self, Vec<Diagnostic>>;
    pub fn set_input(&mut self, component_id: &str, value: Trit)
        -> Result<SimulationSnapshot, Diagnostic>;
    pub fn reset(&mut self) -> SimulationSnapshot;
    pub fn snapshot(&self) -> SimulationSnapshot;
}
```

- [x] **Step 4: Implement ordered propagation**

Use a `VecDeque<String>` and a `BTreeSet<String>` to prevent duplicate pending
component IDs within one delta. Always enqueue in component ID order.

On output change:

1. Save the new driver value.
2. Re-resolve every target input reached from that output.
3. Add `MULTIPLE_DRIVER_CONFLICT` if the aggregate becomes `E` because known
   drivers disagree.
4. Enqueue downstream components only if the resolved input changed.

Carry `DUPLICATE_CONNECTION` warnings from validation into every snapshot.
After initial network construction, emit one `UNDRIVEN_INPUT` warning per
unconnected input port whose resolved value is `Z`.

When the event limit is exceeded, mark still-pending outputs and target inputs
`E`, emit `NON_CONVERGENT_COMBINATIONAL_LOOP`, clear the queue, and return.

- [x] **Step 5: Verify GREEN and determinism**

```bash
cargo test -p sim-core --test simulator_propagation
cargo test -p sim-core
cargo clippy -p sim-core --all-targets -- -D warnings
```

Add a test that loads the same circuit with reversed component and connection
array order and asserts identical snapshots.

- [x] **Step 6: Commit**

```bash
git add crates/sim-core
git commit -m "feat: simulate ternary circuits to a stable state"
```

---

### Task 6: Expose a Batch WebAssembly API

**Files:**
- Modify: `crates/sim-wasm/src/lib.rs`
- Create: `crates/sim-wasm/tests/web_api.rs`
- Modify: `crates/sim-wasm/Cargo.toml`

- [x] **Step 1: Write failing WASM boundary tests**

Configure `wasm-bindgen-test` for the Node runner and test:

```rust
#[wasm_bindgen_test]
fn api_version_and_catalog_are_available() {
    assert_eq!(sim_wasm::api_version(), 1);
    assert!(sim_wasm::component_catalog_json().contains("gate.neg"));
}
```

Also cover loading the JSON definition for `Input -> NEG -> Probe`, setting the
input to `"T"`, and checking the serialized snapshot contains probe value
`"1"`. Pass an invalid source `properties.value` and assert a structured
`INVALID_PROPERTY` error rather than a panic string.

- [x] **Step 2: Run RED**

```bash
wasm-pack test --node crates/sim-wasm
```

Expected: batch API functions are missing.

- [x] **Step 3: Implement `WasmSimulator`**

Expose:

```rust
#[wasm_bindgen]
pub struct WasmSimulator {
    inner: Option<Simulator>,
}

#[wasm_bindgen]
impl WasmSimulator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self;

    #[wasm_bindgen(js_name = loadCircuit)]
    pub fn load_circuit(&mut self, definition: JsValue) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_name = setInput)]
    pub fn set_input(&mut self, component_id: String, value: JsValue)
        -> Result<JsValue, JsValue>;

    pub fn reset(&mut self) -> Result<JsValue, JsValue>;
    pub fn snapshot(&self) -> Result<JsValue, JsValue>;
}
```

Expose a Rust helper used by tests and a JS-facing export:

```rust
pub fn component_catalog_json() -> String;

#[wasm_bindgen(js_name = componentCatalog)]
pub fn component_catalog() -> Result<JsValue, JsValue>;
```

Both serialize `sim_core::catalog::component_catalog()` and therefore cannot
drift from the simulator catalog.
Convert every Rust error to a serialized object with `code`, `message`, and
affected IDs. Do not expose panic strings as user-facing results.

- [x] **Step 4: Build and test**

```bash
wasm-pack test --node crates/sim-wasm
npm --prefix apps/web run build:wasm
test -f apps/web/src/wasm/pkg/sim_wasm.js
test -f apps/web/src/wasm/pkg/sim_wasm_bg.wasm
```

Expected: WASM tests pass and generated package exists.

- [x] **Step 5: Commit**

```bash
git add crates/sim-wasm
git commit -m "feat: expose ternary simulator through wasm"
```

---

### Task 7: Build the Operational Editor Shell

**Files:**
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/components/Toolbar.tsx`
- Create: `apps/web/src/components/Palette.tsx`
- Create: `apps/web/src/components/Inspector.tsx`
- Create: `apps/web/src/components/StatusBar.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/tests/app.test.tsx`

- [x] **Step 1: Replace the smoke test with failing shell tests**

Assert the page has:

```tsx
expect(screen.getByRole("toolbar", { name: "电路工具" })).toBeVisible();
expect(screen.getByRole("complementary", { name: "元件库" })).toBeVisible();
expect(screen.getByRole("region", { name: "电路画布" })).toBeVisible();
expect(screen.getByRole("complementary", { name: "属性与状态" })).toBeVisible();
expect(screen.getByRole("status")).toHaveTextContent("WASM");
```

- [x] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- app.test.tsx
```

Expected: regions are missing.

- [x] **Step 3: Implement the shell**

Build a full-height workbench:

- top 48 px toolbar;
- left 220 px palette;
- central unframed canvas;
- right 300 px inspector;
- bottom 28 px status bar.

Import `./styles.css` once from `apps/web/src/main.tsx` so tests, development,
and the production build use the same shell styling.

Use Lucide icons for undo, redo, delete, clear, examples, fit view, menu, and
panel toggles. Every icon button must have `aria-label` and a native `title`.

Use a neutral light workspace with red, gray, green, yellow, blue, and magenta
reserved for signal states. Cards may only represent repeated palette items;
page regions stay unframed.

- [x] **Step 4: Add responsive behavior**

At widths below `760px`, make the canvas fill the body and expose palette and
inspector as side drawers toggled by toolbar icons. Ensure toolbar actions do
not wrap over the canvas.

- [x] **Step 5: Verify GREEN**

```bash
npm --prefix apps/web test -- app.test.tsx
npm --prefix apps/web run build
```

Expected: shell tests and TypeScript build pass.

- [x] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: add ternary editor workbench"
```

---

### Task 8: Add the Serializable Editor Store and Command History

**Files:**
- Create: `apps/web/src/editor/circuit-document.ts`
- Create: `apps/web/src/simulation/types.ts`
- Create: `apps/web/src/app/editor-store.ts`
- Create: `apps/web/tests/editor-store.test.ts`
- Create: `schemas/circuit-v1.schema.json`

- [x] **Step 1: Write failing store tests**

Test exact behavior:

```typescript
const store = createEditorStore();
store.getState().addComponent(negNode);
store.getState().addConnection(edge);
store.getState().undo();
expect(store.getState().document.connections).toEqual([]);
store.getState().redo();
expect(store.getState().document.connections).toEqual([edge]);
store.getState().clear();
expect(store.getState().document.components).toEqual([]);
```

Also assert delete removes connections attached to a deleted component and that
loading an example deep-clones the template.

- [x] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- editor-store.test.ts
```

Expected: store and types are missing.

- [x] **Step 3: Implement the shared boundary types and versioned document**

Define shared WASM boundary types in `apps/web/src/simulation/types.ts`:

```typescript
export type TritSymbol = "T" | "0" | "1" | "X" | "Z" | "E";
export type KnownTrit = "T" | "0" | "1";

export interface PortDescriptor {
  id: string;
  direction: "input" | "output";
}

export interface ComponentDescriptor {
  type_id: string;
  display_name: string;
  category: string;
  ports: PortDescriptor[];
  truth_table: Array<{ inputs: TritSymbol[]; outputs: TritSymbol[] }>;
}
```

Use the approved shape in `apps/web/src/editor/circuit-document.ts`:

```typescript
export interface CircuitDocument {
  format: "logsim-ternary";
  version: 1;
  components: EditorComponent[];
  connections: EditorConnection[];
  viewport?: { x: number; y: number; zoom: number };
}
```

Implement a JSON Schema that requires `format`, `version`, component IDs,
type IDs, positions, and directed connection endpoints. It must disallow
unknown top-level properties.

- [x] **Step 4: Implement history without storing simulation snapshots**

The Zustand store state must contain:

```typescript
{
  past: CircuitDocument[];
  document: CircuitDocument;
  future: CircuitDocument[];
  selection: { componentIds: string[]; connectionIds: string[] };
}
```

Every edit pushes the previous document to `past` and clears `future`.
Selection, viewport movement, and simulation values do not create history
entries.

- [x] **Step 5: Verify GREEN**

```bash
npm --prefix apps/web test -- editor-store.test.ts
npm --prefix apps/web run build
```

- [x] **Step 6: Commit**

```bash
git add apps/web/src/editor apps/web/src/simulation/types.ts apps/web/src/app apps/web/tests schemas
git commit -m "feat: add versioned ternary circuit documents"
```

---

### Task 9: Render Components and Create Valid Connections

**Files:**
- Create: `apps/web/src/editor/node-factory.ts`
- Create: `apps/web/src/editor/connections.ts`
- Create: `apps/web/src/simulation/catalog.ts`
- Create: `apps/web/src/components/ComponentNode.tsx`
- Modify: `apps/web/src/components/Palette.tsx`
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/tests/connections.test.ts`

- [x] **Step 1: Write failing connection tests**

Assert:

```typescript
expect(isValidConnection(outputToInput, catalog)).toBe(true);
expect(isValidConnection(inputToInput, catalog)).toBe(false);
expect(isValidConnection(outputToOutput, catalog)).toBe(false);
expect(isExactDuplicate(existingEdge, candidate)).toBe(true);
```

- [x] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- connections.test.ts
```

- [x] **Step 3: Build catalog-driven nodes**

`simulation/catalog.ts` dynamically initializes the generated WASM module,
calls `componentCatalog()`, deserializes the result into
`ComponentDescriptor[]`, and caches only this immutable descriptor list.

`ComponentNode` must render:

- compact logic symbol or stable short label;
- component label;
- one React Flow Handle per descriptor port;
- input handles left and output handles right;
- current output character when available.

Do not hard-code port lists in React components.

- [x] **Step 4: Add drag/drop and connection creation**

Palette items use HTML drag data containing only `typeId`. On drop, create a
stable UUID, translate screen coordinates with React Flow, and add the
component to the store.

Reject invalid directions and exact duplicates before editing the document.
Allow multiple distinct outputs to connect to one input and one output to
fan out.

- [x] **Step 5: Verify with component tests and build**

```bash
npm --prefix apps/web test
npm --prefix apps/web run build
```

Expected: all 12 catalog types render, valid connections are accepted, invalid
connections are rejected.

- [x] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: place and wire ternary components"
```

---

### Task 10: Connect the Editor to the Rust/WASM Simulator

**Files:**
- Modify: `apps/web/src/simulation/types.ts`
- Create: `apps/web/src/simulation/engine.ts`
- Create: `apps/web/tests/engine.test.ts`
- Modify: `apps/web/src/app/editor-store.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/ComponentNode.tsx`

- [x] **Step 1: Write failing engine adapter tests**

Mock only the generated WASM object and assert:

```typescript
await engine.load(document);
await engine.setInput("input-1", "T");
expect(wasm.loadCircuit).toHaveBeenCalledWith(toCircuitDefinition(document));
expect(wasm.setInput).toHaveBeenCalledWith("input-1", "T");
expect(engine.snapshot()!.inputNets["probe-1"].in).toBe("1");
```

Add a source scan assertion that `apps/web/src` contains no functions named
`evaluateGate`, `ternaryMin`, `ternaryMax`, or truth-table maps.

- [x] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- engine.test.ts
```

- [x] **Step 3: Implement typed WASM loading**

`engine.ts` dynamically imports `../wasm/pkg/sim_wasm.js`, calls its default
initializer once, and wraps `WasmSimulator`.

Expose:

```typescript
export interface SimulationEngine {
  ready(): Promise<void>;
  catalog(): Promise<ComponentDescriptor[]>;
  load(document: CircuitDocument): Promise<SimulationSnapshot>;
  setInput(componentId: string, value: KnownTrit): Promise<SimulationSnapshot>;
  reset(): Promise<SimulationSnapshot>;
  snapshot(): SimulationSnapshot | null;
}
```

Convert editor components and connections to Rust `CircuitDefinition`, dropping
positions and viewport.

- [x] **Step 4: Drive visual values from snapshots**

Compute a topology signature from component IDs, type IDs, and connections.
On component add/remove/type change or connection change, debounce one
animation frame and call `load`. Position, viewport, and selection changes do
not call WASM. A source `properties.value` change calls `setInput` when the
topology signature is unchanged. Undo and redo use the same diff rule.

Store the returned snapshot separately from editor history.

Clicking `Trit Input` cycles:

```text
T -> 0 -> 1 -> T
```

Call `setInput` without rebuilding topology. Update nodes, edges, Probe values,
status bar, and diagnostics from the returned snapshot.

- [x] **Step 5: Verify GREEN**

```bash
npm --prefix apps/web test -- engine.test.ts
npm --prefix apps/web run build
```

- [x] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: run ternary circuits through wasm"
```

---

### Task 11: Add Truth Tables, Diagnostics, and Signal Styling

**Files:**
- Modify: `apps/web/src/components/Inspector.tsx`
- Modify: `apps/web/src/components/ComponentNode.tsx`
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/components/signal-style.ts`
- Create: `apps/web/tests/inspector.test.tsx`

- [x] **Step 1: Write failing display tests**

For every symbol assert both text and a non-color distinction:

```typescript
expect(signalStyle("Z")).toMatchObject({ className: "signal-z", lineStyle: "dashed" });
expect(signalStyle("E")).toMatchObject({ className: "signal-e", warning: true });
```

Render a selected `NEG` and assert the truth table has rows `T -> 1`, `0 -> 0`,
`1 -> T`. Render a conflict diagnostic and assert the affected connection is
identified by ID.

- [x] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- inspector.test.tsx
```

- [x] **Step 3: Implement signal tokens**

Define one map:

```typescript
const SIGNAL_STYLE = {
  T: { color: "#c43c35", lineStyle: "solid", warning: false },
  "0": { color: "#68757a", lineStyle: "solid", warning: false },
  "1": { color: "#2f855a", lineStyle: "solid", warning: false },
  X: { color: "#b7791f", lineStyle: "solid", warning: false },
  Z: { color: "#2878a8", lineStyle: "dashed", warning: false },
  E: { color: "#b83280", lineStyle: "solid", warning: true },
} as const;
```

Nodes, edges, Probe, and inspector badges must all consume this map.

- [x] **Step 4: Implement catalog-driven truth tables and diagnostics**

Truth tables come from `ComponentDescriptor.truth_table`. Inspector displays:

- component type and stable ID;
- current input/output values;
- known-value truth table;
- diagnostics matching the selected component or connection.

Clicking a diagnostic selects and fits the affected elements.

- [x] **Step 5: Verify GREEN**

```bash
npm --prefix apps/web test -- inspector.test.tsx
npm --prefix apps/web run build
```

- [x] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: explain ternary values and simulation errors"
```

---

### Task 12: Add Default and Demonstration Circuits

**Files:**
- Create: `apps/web/src/examples/circuits.ts`
- Create: `apps/web/tests/examples.test.ts`
- Modify: `apps/web/src/components/Toolbar.tsx`
- Modify: `apps/web/src/app/editor-store.ts`
- Modify: `apps/web/src/App.tsx`

- [x] **Step 1: Write failing example tests**

For each example, load it through the real WASM engine and assert:

```text
NEG default: input 0 -> probe 0
MIN/MAX: inputs T and 1 -> min T, max 1
Decoder: input 0 -> IS_ZERO 1, other decoder outputs T
MUX3: selector T/0/1 selects constants T/0/1
```

Also assert each template remains byte-identical after editing its loaded copy.

- [x] **Step 2: Run RED**

```bash
npm --prefix apps/web test -- examples.test.ts
```

- [x] **Step 3: Implement four immutable templates**

Create:

```typescript
export const EXAMPLES = {
  neg: negDocument,
  minMax: minMaxDocument,
  decoder: decoderDocument,
  mux3: mux3Document,
} as const;
```

Every component and connection has a stable human-readable ID. Place nodes so
the signal path reads left-to-right without overlap at a 1280 × 800 viewport.

- [x] **Step 4: Add example menu, clear, and reset**

- `Examples` opens a menu of four choices.
- Selecting an example loads a deep-cloned document and fits the view.
- `Clear` asks for confirmation only when the current circuit is non-empty.
- `Reset` restores component source values and reruns the current topology.

- [x] **Step 5: Verify GREEN**

```bash
npm --prefix apps/web test -- examples.test.ts
npm --prefix apps/web run build
```

- [x] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: add ternary demonstration circuits"
```

---

### Task 13: Complete Browser Acceptance, Performance, CI, and User Documentation

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/tests/phase1.spec.ts`
- Create: `.github/workflows/ci.yml`
- Create: `LICENSE`
- Create: `README.md`
- Create: `docs/images/phase1-editor.png`
- Modify: `docs/superpowers/specs/2026-07-29-logsim-ternary-phase1-design.md`

- [x] **Step 1: Write failing Playwright acceptance**

The test must:

1. open the editor and wait for `WASM ready`;
2. verify the default NEG example;
3. cycle the input and observe `1/T/0`;
4. drag inputs, `MIN`, and Probe to the canvas;
5. connect them and verify `MIN(0,1)=0`;
6. add a conflicting driver and verify `E`;
7. delete the conflict and verify recovery;
8. run at `1440 × 900` and `390 × 844`;
9. assert `document.documentElement.scrollWidth <= clientWidth`;
10. fail on browser console errors.

Run:

```bash
npm --prefix apps/web run test:e2e
```

Expected RED: Playwright configuration or selectors are not complete.

- [x] **Step 2: Add deterministic test IDs only where semantic roles are insufficient**

Use `data-testid` for React Flow handles, canvas elements, and generated edges.
Keep toolbar, palette, inspector, menu, and status queries role-based.

- [x] **Step 3: Add the performance benchmark**

In a browser test, generate 200 alternating BUF/NEG components and 400
connections without a feedback loop. Record only the `setInput` to stable
snapshot duration after WASM initialization.

Assert:

```typescript
const thresholdMs = process.env.CI ? 150 : 50;
console.info({ durationMs, localTargetMs: 50, ciThresholdMs: 150 });
expect(durationMs).toBeLessThan(thresholdMs);
```

Record `50 ms` as the local target. Use `150 ms` as the CI failure threshold
to account for shared-runner variance. Always print the measured value and both
thresholds; do not remove the benchmark when it fails.

- [x] **Step 4: Add CI**

CI runs:

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

Cache Cargo registry/target and npm cache, but never cache generated WASM as a
source artifact.

- [x] **Step 5: Add README and license**

`README.md` must contain:

- one-sentence project purpose;
- the visually checked `docs/images/phase1-editor.png` screenshot;
- prerequisites;
- exact build, test, and local run commands;
- six-state model summary;
- first-stage component list;
- architecture diagram in text;
- explicit attribution to Logisim-evolution and its GPLv3 license;
- current exclusions.

Copy the official GNU GPL v3 text into `LICENSE`.
After both viewports pass visual inspection, capture the desktop editor with
Playwright to `docs/images/phase1-editor.png`; verify the image with
`functions.view_image` before linking it from the README.

- [x] **Step 6: Mark verified acceptance items in the design**

Append a dated verification record to the phase-one design containing actual
test counts, browser sizes, benchmark result, and any residual warning. Do not
change the original requirements to match implementation.

- [x] **Step 7: Run the complete final verification**

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

Expected:

- all commands exit `0`;
- `git status --short` lists only the intended Task 13 files;
- only documented third-party warnings remain.

- [x] **Step 8: Commit**

```bash
git add .github LICENSE README.md apps/web docs
git commit -m "test: verify phase one ternary editor"
```

- [x] **Step 9: Confirm the committed worktree**

```bash
git status --short
```

Expected: no output.

---

## 3. Spec Coverage

| Approved requirement | Implementation task |
|---|---|
| Six-state signal model and net resolution | Task 2 |
| Twelve components, ports, and truth tables | Task 3 |
| Circuit schema and structured validation | Task 4 |
| Deterministic propagation and loop protection | Task 5 |
| Rust/WASM batch boundary | Task 6 |
| Desktop/mobile editor workbench | Tasks 7-9 |
| Live simulation without TypeScript gate logic | Task 10 |
| Signal styling, truth tables, and diagnostics | Task 11 |
| Four immutable demonstration circuits | Task 12 |
| Browser acceptance, performance, CI, and docs | Task 13 |

## 4. Completion Checklist

- [x] Rust is the only source of trit and gate semantics.
- [x] All 12 phase-one component types are available.
- [x] `T/0/1/X/Z/E` serialization and rendering are stable.
- [x] Multi-driver resolution is permutation-invariant.
- [x] Invalid circuits return structured diagnostics.
- [x] Combinational loops terminate with `E`, never freeze the browser.
- [x] WASM uses batch definitions and snapshots.
- [x] The editor supports placement, movement, connection, deletion, undo, and redo.
- [x] The four examples pass through the real Rust/WASM engine.
- [x] Desktop and mobile browser acceptance passes.
- [x] Full verification commands are recorded in the design document.
