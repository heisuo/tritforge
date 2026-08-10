use serde::Deserialize;
use sim_core::catalog::ComponentProperties;
use sim_core::circuit::{CircuitDefinition, ComponentInstance, Connection};
use sim_core::diagnostic::Diagnostic;
use sim_core::simulator::SimulationSnapshot;
use sim_core::trit::Trit;
use sim_wasm::{WasmSimulator, api_version, component_catalog_json};
use wasm_bindgen_test::wasm_bindgen_test;

fn component(id: &str, type_id: &str, value: Option<Trit>) -> ComponentInstance {
    ComponentInstance {
        id: id.to_owned(),
        type_id: type_id.to_owned(),
        properties: ComponentProperties { value },
    }
}

fn connection(
    id: &str,
    source: &str,
    source_port: &str,
    target: &str,
    target_port: &str,
) -> Connection {
    Connection {
        id: id.to_owned(),
        source_component_id: source.to_owned(),
        source_port_id: source_port.to_owned(),
        target_component_id: target.to_owned(),
        target_port_id: target_port.to_owned(),
    }
}

#[wasm_bindgen_test]
fn api_version_and_catalog_are_available() {
    assert_eq!(api_version(), 3);
    assert!(component_catalog_json().contains("gate.neg"));
}

#[wasm_bindgen_test]
fn loads_and_updates_a_circuit_across_the_wasm_boundary() {
    let definition = CircuitDefinition {
        components: vec![
            component("input", "source.trit_input", Some(Trit::Zero)),
            component("neg", "gate.neg", None),
            component("probe", "sink.probe", None),
        ],
        connections: vec![
            connection("input-neg", "input", "out", "neg", "a"),
            connection("neg-probe", "neg", "y", "probe", "in"),
        ],
    };
    let value = serde_wasm_bindgen::to_value(&definition).expect("serialize definition");
    let mut simulator = WasmSimulator::new();
    simulator.load_circuit(value).expect("load circuit");

    let snapshot: SimulationSnapshot =
        serde_wasm_bindgen::from_value(simulator.set_input("input", "T").expect("set input"))
            .expect("deserialize snapshot");

    assert_eq!(snapshot.input_value("probe", "in"), Some(Trit::Pos));
}

#[wasm_bindgen_test]
fn flat_wasm_api_rejects_structural_registers() {
    let definition = CircuitDefinition {
        components: vec![component("register", "sequential.register", None)],
        connections: vec![],
    };
    let value = serde_wasm_bindgen::to_value(&definition).expect("serialize definition");
    let error = WasmSimulator::new()
        .load_circuit(value)
        .expect_err("flat Wasm API must reject structural macros");
    let error: BoundaryErrorView =
        serde_wasm_bindgen::from_value(error).expect("deserialize boundary error");

    assert_eq!(error.code, "STRUCTURAL_COMPONENT_REQUIRES_PROJECT_V3");
    assert_eq!(
        error.diagnostics[0].code,
        "STRUCTURAL_COMPONENT_REQUIRES_PROJECT_V3"
    );
    assert_eq!(error.diagnostics[0].component_ids, vec!["register"]);
}

#[wasm_bindgen_test]
fn ticks_a_dff_and_returns_the_clock_low_across_the_wasm_boundary() {
    let definition = CircuitDefinition {
        components: vec![
            component("data", "source.constant", Some(Trit::Pos)),
            component("enable", "source.constant", Some(Trit::Pos)),
            component("reset", "source.constant", Some(Trit::Zero)),
            component("clock", "source.clock", None),
            component("dff", "sequential.dff", None),
        ],
        connections: vec![
            connection("data-dff", "data", "out", "dff", "d"),
            connection("enable-dff", "enable", "out", "dff", "en"),
            connection("reset-dff", "reset", "out", "dff", "rst"),
            connection("clock-dff", "clock", "out", "dff", "clk"),
        ],
    };
    let value = serde_wasm_bindgen::to_value(&definition).expect("serialize definition");
    let mut simulator = WasmSimulator::new();
    simulator.load_circuit(value).expect("load circuit");

    let snapshot: SimulationSnapshot =
        serde_wasm_bindgen::from_value(simulator.tick().expect("tick circuit"))
            .expect("deserialize snapshot");

    assert_eq!(snapshot.api_version, 3);
    assert_eq!(snapshot.output_value("dff", "q"), Some(Trit::Pos));
    assert_eq!(snapshot.output_value("clock", "out"), Some(Trit::Zero));
    assert_eq!(snapshot.input_value("dff", "clk"), Some(Trit::Zero));
    assert_eq!(snapshot.tick_count, 1);
}

#[derive(Deserialize)]
struct BoundaryErrorView {
    code: String,
    diagnostics: Vec<Diagnostic>,
}

#[wasm_bindgen_test]
fn tick_before_load_returns_a_structured_not_loaded_error() {
    let error = WasmSimulator::new()
        .tick()
        .expect_err("tick before load must fail");
    let error: BoundaryErrorView =
        serde_wasm_bindgen::from_value(error).expect("deserialize boundary error");

    assert_eq!(error.code, "SIMULATOR_NOT_LOADED");
    assert!(error.diagnostics.is_empty());
}

#[wasm_bindgen_test]
fn invalid_component_properties_return_a_structured_error() {
    let definition = CircuitDefinition {
        components: vec![component("neg", "gate.neg", Some(Trit::Pos))],
        connections: vec![],
    };
    let value = serde_wasm_bindgen::to_value(&definition).expect("serialize definition");
    let error = WasmSimulator::new()
        .load_circuit(value)
        .expect_err("gate property must be rejected");
    let error: BoundaryErrorView =
        serde_wasm_bindgen::from_value(error).expect("deserialize boundary error");

    assert_eq!(error.code, "INVALID_PROPERTY");
    assert_eq!(error.diagnostics[0].code, "INVALID_PROPERTY");
}
