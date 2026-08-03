use serde::Deserialize;
use sim_core::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectComponent, ProjectDiagnostic, ProjectDocument,
};
use sim_core::project_simulator::ProjectSnapshot;
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectBoundaryErrorView {
    code: String,
    diagnostics: Vec<ProjectDiagnostic>,
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
