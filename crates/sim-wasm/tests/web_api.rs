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
    assert_eq!(api_version(), 2);
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

#[derive(Deserialize)]
struct BoundaryErrorView {
    code: String,
    diagnostics: Vec<Diagnostic>,
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
