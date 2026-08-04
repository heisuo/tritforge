use serde::Deserialize;
use sim_core::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectComponent, ProjectConnection, ProjectDiagnostic,
    ProjectDocument,
};
use sim_core::project_simulator::{ProjectCompileMetrics, ProjectSnapshot};
use sim_core::trit::Trit;
use sim_wasm::WasmProjectSimulator;
use wasm_bindgen_test::wasm_bindgen_test;

fn component(id: &str, type_id: &str, properties: serde_json::Value) -> ProjectComponent {
    ProjectComponent::new(id, type_id, properties).unwrap()
}

fn module_instance(id: &str, module_id: &str) -> ProjectComponent {
    component(
        id,
        "project.module_instance",
        serde_json::json!({"moduleId": module_id, "label": id}),
    )
}

fn circuit(
    id: impl Into<String>,
    kind: ProjectCircuitKind,
    components: Vec<ProjectComponent>,
) -> ProjectCircuit {
    let id = id.into();
    ProjectCircuit {
        name: id.clone(),
        id,
        kind,
        components,
        connections: vec![],
    }
}

fn connected_circuit(
    id: impl Into<String>,
    kind: ProjectCircuitKind,
    components: Vec<ProjectComponent>,
    connections: Vec<ProjectConnection>,
) -> ProjectCircuit {
    let id = id.into();
    ProjectCircuit {
        name: id.clone(),
        id,
        kind,
        components,
        connections,
    }
}

fn connection(
    id: &str,
    source_component_id: &str,
    source_port_id: &str,
    target_component_id: &str,
    target_port_id: &str,
) -> ProjectConnection {
    ProjectConnection {
        id: id.into(),
        source_component_id: source_component_id.into(),
        source_port_id: source_port_id.into(),
        target_component_id: target_component_id.into(),
        target_port_id: target_port_id.into(),
    }
}

fn project(circuits: Vec<ProjectCircuit>) -> ProjectDocument {
    ProjectDocument {
        format: "logsim-ternary".into(),
        version: 2,
        root_circuit_id: "main".into(),
        circuits,
    }
}

fn js_project(project: &ProjectDocument) -> wasm_bindgen::JsValue {
    serde_wasm_bindgen::to_value(project).expect("serialize project")
}

fn sequential_project() -> ProjectDocument {
    let main = connected_circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component("data", "source.constant", serde_json::json!({"value": "1"})),
            component(
                "enable",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            component(
                "reset",
                "source.constant",
                serde_json::json!({"value": "0"}),
            ),
            component("clock", "source.clock", serde_json::json!({})),
            component("dff", "sequential.dff", serde_json::json!({})),
        ],
        vec![
            connection("data-dff", "data", "out", "dff", "d"),
            connection("enable-dff", "enable", "out", "dff", "en"),
            connection("reset-dff", "reset", "out", "dff", "rst"),
            connection("clock-dff", "clock", "out", "dff", "clk"),
        ],
    );
    project(vec![main])
}

#[wasm_bindgen_test]
fn project_handle_loads_updates_and_switches_active_roots() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("spare-1", "spare")],
    );
    let spare = circuit(
        "spare",
        ProjectCircuitKind::Module,
        vec![component(
            "constant",
            "source.constant",
            serde_json::json!({"value": "0"}),
        )],
    );
    let project = project(vec![main, spare]);
    let mut simulator = WasmProjectSimulator::new();

    let first: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .load_project(js_project(&project), "main")
            .expect("load project"),
    )
    .unwrap();
    let second: ProjectSnapshot = serde_wasm_bindgen::from_value(
        simulator
            .set_source("spare", "constant", "1")
            .expect("set shared source"),
    )
    .unwrap();
    let third: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.switch_active("spare").expect("preview module"))
            .unwrap();

    assert_eq!(first.compile_count, 1);
    assert_eq!(second.compile_count, 1);
    assert_eq!(third.compile_count, 2);
    let metrics: ProjectCompileMetrics =
        serde_wasm_bindgen::from_value(simulator.metrics().expect("compiled project metrics"))
            .unwrap();
    assert_eq!(metrics.expanded_components, 1);
}

#[wasm_bindgen_test]
fn project_handle_ticks_and_projects_dff_state() {
    let project = sequential_project();
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .expect("load project");

    let snapshot: ProjectSnapshot =
        serde_wasm_bindgen::from_value(simulator.tick().expect("tick project"))
            .expect("deserialize project snapshot");

    assert_eq!(snapshot.component_outputs["dff"]["q"], Trit::Pos);
    assert_eq!(snapshot.component_outputs["clock"]["out"], Trit::Zero);
    assert_eq!(snapshot.input_nets["dff"]["clk"], Trit::Zero);
    assert_eq!(snapshot.tick_count, 1);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectBoundaryErrorView {
    code: String,
    diagnostics: Vec<ProjectDiagnostic>,
}

#[wasm_bindgen_test]
fn tick_before_project_load_returns_a_structured_not_loaded_error() {
    let error = WasmProjectSimulator::new()
        .tick()
        .expect_err("tick before project load must fail");
    let error: ProjectBoundaryErrorView =
        serde_wasm_bindgen::from_value(error).expect("deserialize project boundary error");

    assert_eq!(error.code, "SIMULATOR_NOT_LOADED");
    assert!(error.diagnostics.is_empty());
}

#[wasm_bindgen_test]
fn tick_after_project_invalidation_returns_project_not_ready() {
    let project = sequential_project();
    let mut simulator = WasmProjectSimulator::new();
    simulator
        .load_project(js_project(&project), "main")
        .expect("load project");
    let mut invalid = project;
    invalid.circuits[0].components.push(component(
        "invalid",
        "gate.not_real",
        serde_json::json!({}),
    ));
    simulator
        .update_project(js_project(&invalid))
        .expect_err("invalid project update must fail");

    let error = simulator
        .tick()
        .expect_err("invalid project tick must fail");
    let error: ProjectBoundaryErrorView =
        serde_wasm_bindgen::from_value(error).expect("deserialize project boundary error");

    assert_eq!(error.code, "PROJECT_NOT_READY");
    assert_eq!(error.diagnostics[0].code, "PROJECT_NOT_READY");
}

#[wasm_bindgen_test]
fn dependency_cycles_return_structured_project_diagnostics() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("a-1", "a")],
    );
    let a = circuit(
        "a",
        ProjectCircuitKind::Module,
        vec![module_instance("b-1", "b")],
    );
    let b = circuit(
        "b",
        ProjectCircuitKind::Module,
        vec![module_instance("a-1", "a")],
    );
    let error = WasmProjectSimulator::new()
        .load_project(js_project(&project(vec![main, a, b])), "main")
        .expect_err("dependency cycle must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();

    assert_eq!(error.code, "MODULE_DEPENDENCY_CYCLE");
    assert_eq!(error.diagnostics[0].code, "MODULE_DEPENDENCY_CYCLE");
}

#[wasm_bindgen_test]
fn hierarchy_limits_return_structured_project_diagnostics() {
    let mut circuits = vec![circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("next", "module-00")],
    )];
    for index in 0..32 {
        let components = if index < 31 {
            vec![module_instance("next", &format!("module-{:02}", index + 1))]
        } else {
            vec![]
        };
        circuits.push(circuit(
            format!("module-{index:02}"),
            ProjectCircuitKind::Module,
            components,
        ));
    }
    let error = WasmProjectSimulator::new()
        .load_project(js_project(&project(circuits)), "main")
        .expect_err("depth 33 must fail");
    let error: ProjectBoundaryErrorView = serde_wasm_bindgen::from_value(error).unwrap();

    assert_eq!(error.code, "HIERARCHY_EXPANSION_LIMIT");
    assert_eq!(error.diagnostics[0].code, "HIERARCHY_EXPANSION_LIMIT");
}
