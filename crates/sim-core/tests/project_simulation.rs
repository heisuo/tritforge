use std::collections::BTreeSet;

use sim_core::project::{
    ProjectCircuit, ProjectCircuitKind, ProjectComponent, ProjectConnection, ProjectDocument,
};
use sim_core::project_simulator::ProjectSimulator;
use sim_core::trit::Trit;

fn component(id: &str, type_id: &str, properties: serde_json::Value) -> ProjectComponent {
    ProjectComponent::new(id, type_id, properties).unwrap()
}

fn module_input(id: &str, port_id: &str) -> ProjectComponent {
    component(
        id,
        "project.module_input",
        serde_json::json!({"portId": port_id, "label": port_id, "previewValue": "0"}),
    )
}

fn module_output(id: &str, port_id: &str) -> ProjectComponent {
    component(
        id,
        "project.module_output",
        serde_json::json!({"portId": port_id, "label": port_id}),
    )
}

fn module_instance(id: &str, module_id: &str) -> ProjectComponent {
    component(
        id,
        "project.module_instance",
        serde_json::json!({"moduleId": module_id, "label": id}),
    )
}

fn connection(
    id: impl Into<String>,
    source_component_id: impl Into<String>,
    source_port_id: impl Into<String>,
    target_component_id: impl Into<String>,
    target_port_id: impl Into<String>,
) -> ProjectConnection {
    ProjectConnection {
        id: id.into(),
        source_component_id: source_component_id.into(),
        source_port_id: source_port_id.into(),
        target_component_id: target_component_id.into(),
        target_port_id: target_port_id.into(),
    }
}

fn circuit(
    id: &str,
    kind: ProjectCircuitKind,
    components: Vec<ProjectComponent>,
    connections: Vec<ProjectConnection>,
) -> ProjectCircuit {
    ProjectCircuit {
        id: id.into(),
        name: id.into(),
        kind,
        components,
        connections,
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

fn inverter_module() -> ProjectCircuit {
    circuit(
        "inverter",
        ProjectCircuitKind::Module,
        vec![
            module_input("input", "a"),
            component("neg", "gate.neg", serde_json::json!({})),
            module_output("output", "y"),
        ],
        vec![
            connection("input-neg", "input", "out", "neg", "a"),
            connection("neg-output", "neg", "y", "output", "in"),
        ],
    )
}

fn bit_cell_module() -> ProjectCircuit {
    circuit(
        "bit-cell",
        ProjectCircuitKind::Module,
        vec![
            module_input("d-input", "d"),
            module_input("en-input", "en"),
            module_input("rst-input", "rst"),
            module_input("clk-input", "clk"),
            component("dff", "sequential.dff", serde_json::json!({})),
            module_output("q-output", "q"),
        ],
        vec![
            connection("d", "d-input", "out", "dff", "d"),
            connection("en", "en-input", "out", "dff", "en"),
            connection("rst", "rst-input", "out", "dff", "rst"),
            connection("clk", "clk-input", "out", "dff", "clk"),
            connection("q", "dff", "q", "q-output", "in"),
        ],
    )
}

fn sequential_project() -> ProjectDocument {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component("d0", "source.trit_input", serde_json::json!({"value": "1"})),
            component("d1", "source.trit_input", serde_json::json!({"value": "T"})),
            component("en", "source.constant", serde_json::json!({"value": "1"})),
            component("rst", "source.constant", serde_json::json!({"value": "0"})),
            component("clock", "source.clock", serde_json::json!({})),
            module_instance("cell-0", "bit-cell"),
            module_instance("cell-1", "bit-cell"),
        ],
        vec![
            connection("d0", "d0", "out", "cell-0", "d"),
            connection("d1", "d1", "out", "cell-1", "d"),
            connection("en0", "en", "out", "cell-0", "en"),
            connection("en1", "en", "out", "cell-1", "en"),
            connection("rst0", "rst", "out", "cell-0", "rst"),
            connection("rst1", "rst", "out", "cell-1", "rst"),
            connection("clk0", "clock", "out", "cell-0", "clk"),
            connection("clk1", "clock", "out", "cell-1", "clk"),
        ],
    );
    let spare = circuit("spare", ProjectCircuitKind::Module, vec![], vec![]);
    project(vec![main, bit_cell_module(), spare])
}

#[test]
fn ticks_shared_dff_instances_independently_and_retains_state_for_value_updates() {
    let initial = sequential_project();
    let mut simulator = ProjectSimulator::load(initial.clone(), "main").unwrap();

    let captured = simulator.tick().unwrap();
    assert_eq!(captured.component_outputs["cell-0"]["q"], Trit::Pos);
    assert_eq!(captured.component_outputs["cell-1"]["q"], Trit::Neg);
    assert_eq!(captured.tick_count, 1);
    assert_eq!(captured.compile_count, 1);
    let serialized = serde_json::to_value(&captured).unwrap();
    assert_eq!(serialized["tickCount"], 1);
    assert!(serialized.get("tick_count").is_none());

    let mut changed_data = initial;
    changed_data.circuits[0].components[0] =
        component("d0", "source.trit_input", serde_json::json!({"value": "0"}));
    let retained = simulator.update_project(changed_data).unwrap();
    assert_eq!(retained.component_outputs["cell-0"]["q"], Trit::Pos);
    assert_eq!(retained.component_outputs["cell-1"]["q"], Trit::Neg);
    assert_eq!(retained.tick_count, 1);
    assert_eq!(retained.compile_count, 1);

    let next = simulator.tick().unwrap();
    assert_eq!(next.component_outputs["cell-0"]["q"], Trit::Zero);
    assert_eq!(next.component_outputs["cell-1"]["q"], Trit::Neg);
    assert_eq!(next.tick_count, 2);
    assert_eq!(next.compile_count, 1);
}

#[test]
fn preserves_sequential_runtime_for_unreachable_edits_but_resets_for_active_structure() {
    let initial = sequential_project();
    let mut simulator = ProjectSimulator::load(initial.clone(), "main").unwrap();
    simulator.tick().unwrap();

    let mut unreachable_edit = initial;
    unreachable_edit.circuits[2].components.push(component(
        "unused",
        "source.constant",
        serde_json::json!({"value": "0"}),
    ));
    let retained = simulator.update_project(unreachable_edit.clone()).unwrap();
    assert_eq!(retained.component_outputs["cell-0"]["q"], Trit::Pos);
    assert_eq!(retained.component_outputs["cell-1"]["q"], Trit::Neg);
    assert_eq!(retained.tick_count, 1);
    assert_eq!(retained.compile_count, 1);

    unreachable_edit.circuits[0].components.push(component(
        "unused-probe",
        "sink.probe",
        serde_json::json!({}),
    ));
    let rebuilt = simulator.update_project(unreachable_edit).unwrap();
    assert_eq!(rebuilt.component_outputs["cell-0"]["q"], Trit::Zero);
    assert_eq!(rebuilt.component_outputs["cell-1"]["q"], Trit::Zero);
    assert_eq!(rebuilt.tick_count, 0);
    assert_eq!(rebuilt.compile_count, 2);
}

#[test]
fn switching_active_circuits_resets_sequential_runtime() {
    let mut simulator = ProjectSimulator::load(sequential_project(), "main").unwrap();
    let captured = simulator.tick().unwrap();
    assert_eq!(captured.tick_count, 1);

    let switched = simulator.switch_active("bit-cell").unwrap();
    assert_eq!(switched.component_outputs["dff"]["q"], Trit::Zero);
    assert_eq!(switched.tick_count, 0);
    assert_eq!(switched.compile_count, 2);
}

#[test]
fn tick_returns_project_not_ready_after_runtime_invalidation() {
    let initial = sequential_project();
    let mut simulator = ProjectSimulator::load(initial.clone(), "main").unwrap();
    simulator.tick().unwrap();
    let mut invalid = initial;
    invalid.circuits[2].components.push(component(
        "invalid",
        "gate.not_real",
        serde_json::json!({}),
    ));
    simulator.update_project(invalid).unwrap_err();

    let diagnostic = simulator.tick().unwrap_err();
    assert_eq!(diagnostic.code, "PROJECT_NOT_READY");
    assert!(simulator.snapshot().is_none());
}

#[test]
fn projects_active_canvas_signals_to_logical_module_ports() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source",
                "source.trit_input",
                serde_json::json!({"value": "T"}),
            ),
            module_instance("inverter-1", "inverter"),
            component("probe", "sink.probe", serde_json::json!({})),
        ],
        vec![
            connection("drive", "source", "out", "inverter-1", "a"),
            connection("read", "inverter-1", "y", "probe", "in"),
        ],
    );

    let simulator = ProjectSimulator::load(project(vec![main, inverter_module()]), "main")
        .expect("valid project");
    let snapshot = simulator.snapshot().expect("loaded project has a snapshot");

    assert_eq!(snapshot.compile_count, 1);
    assert_eq!(snapshot.input_nets["inverter-1"]["a"], Trit::Neg);
    assert_eq!(snapshot.component_outputs["inverter-1"]["y"], Trit::Pos);
    assert_eq!(snapshot.input_nets["probe"]["in"], Trit::Pos);
    assert!(
        snapshot
            .component_outputs
            .keys()
            .all(|id| !id.contains('/'))
    );

    let metrics = simulator
        .metrics()
        .expect("loaded project has compile metrics");
    assert_eq!(metrics.expanded_components, 3);
    assert_eq!(metrics.expanded_connections, 2);
    assert_eq!(metrics.projection_endpoints, 9);
}

#[test]
fn updates_every_reachable_copy_of_a_shared_module_source_without_recompiling() {
    let constant_module = circuit(
        "constant-module",
        ProjectCircuitKind::Module,
        vec![
            component(
                "constant",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            module_output("output", "y"),
        ],
        vec![connection(
            "constant-output",
            "constant",
            "out",
            "output",
            "in",
        )],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            module_instance("left", "constant-module"),
            module_instance("right", "constant-module"),
            component("left-probe", "sink.probe", serde_json::json!({})),
            component("right-probe", "sink.probe", serde_json::json!({})),
        ],
        vec![
            connection("left-read", "left", "y", "left-probe", "in"),
            connection("right-read", "right", "y", "right-probe", "in"),
        ],
    );
    let mut simulator =
        ProjectSimulator::load(project(vec![main, constant_module]), "main").unwrap();

    let snapshot = simulator
        .set_source("constant-module", "constant", Trit::Pos)
        .unwrap();

    assert_eq!(snapshot.compile_count, 1);
    assert_eq!(snapshot.component_outputs["left"]["y"], Trit::Pos);
    assert_eq!(snapshot.component_outputs["right"]["y"], Trit::Pos);
}

#[test]
fn persists_a_zero_copy_source_update_until_the_module_becomes_active() {
    let spare = circuit(
        "spare",
        ProjectCircuitKind::Module,
        vec![
            component(
                "constant",
                "source.constant",
                serde_json::json!({"value": "0"}),
            ),
            module_output("output", "y"),
        ],
        vec![connection("read", "constant", "out", "output", "in")],
    );
    let main = circuit("main", ProjectCircuitKind::Main, vec![], vec![]);
    let mut simulator = ProjectSimulator::load(project(vec![main, spare]), "main").unwrap();

    let unchanged = simulator
        .set_source("spare", "constant", Trit::Neg)
        .unwrap();
    assert_eq!(unchanged.compile_count, 1);

    let preview = simulator.switch_active("spare").unwrap();
    assert_eq!(preview.compile_count, 2);
    assert_eq!(preview.component_outputs["constant"]["out"], Trit::Neg);
    assert_eq!(preview.input_nets["output"]["in"], Trit::Neg);
}

#[test]
fn invalid_unreachable_edits_drop_the_old_snapshot_until_repaired() {
    let main = circuit("main", ProjectCircuitKind::Main, vec![], vec![]);
    let spare = circuit("spare", ProjectCircuitKind::Module, vec![], vec![]);
    let valid = project(vec![main.clone(), spare.clone()]);
    let mut simulator = ProjectSimulator::load(valid.clone(), "main").unwrap();

    let mut invalid = valid.clone();
    invalid.circuits[1]
        .components
        .push(component("bad", "gate.unknown", serde_json::json!({})));
    let diagnostics = simulator.update_project(invalid).unwrap_err();

    assert!(
        diagnostics
            .iter()
            .any(|item| item.code == "UNKNOWN_COMPONENT_TYPE")
    );
    assert!(simulator.snapshot().is_none());
    let disabled = simulator
        .set_source("spare", "bad", Trit::Zero)
        .unwrap_err();
    assert_eq!(disabled.code, "PROJECT_NOT_READY");

    let repaired = simulator.update_project(valid).unwrap();
    assert_eq!(repaired.compile_count, 2);
    assert!(simulator.snapshot().is_some());
}

#[test]
fn reports_a_conflicting_module_output_even_without_consumers() {
    let conflict = circuit(
        "conflict",
        ProjectCircuitKind::Module,
        vec![
            component(
                "negative",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            module_output("output", "y"),
        ],
        vec![
            connection("negative-output", "negative", "out", "output", "in"),
            connection("positive-output", "positive", "out", "output", "in"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("conflict-1", "conflict")],
        vec![],
    );

    let simulator = ProjectSimulator::load(project(vec![main, conflict]), "main").unwrap();
    let snapshot = simulator.snapshot().unwrap();
    let conflicts: Vec<_> = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "MULTIPLE_DRIVER_CONFLICT")
        .collect();

    assert_eq!(snapshot.component_outputs["conflict-1"]["y"], Trit::Error);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].port_refs[0].component_id, "conflict-1");
    assert_eq!(conflicts[0].port_refs[0].port_id, "y");
}

#[test]
fn one_boundary_conflict_covers_identical_fanout_target_conflicts() {
    let fanout = circuit(
        "fanout",
        ProjectCircuitKind::Module,
        vec![
            module_input("input", "a"),
            component("probe-1", "sink.probe", serde_json::json!({})),
            component("probe-2", "sink.probe", serde_json::json!({})),
        ],
        vec![
            connection("fanout-1", "input", "out", "probe-1", "in"),
            connection("fanout-2", "input", "out", "probe-2", "in"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "negative",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            module_instance("fanout-1", "fanout"),
        ],
        vec![
            connection("negative-input", "negative", "out", "fanout-1", "a"),
            connection("positive-input", "positive", "out", "fanout-1", "a"),
        ],
    );

    let snapshot = ProjectSimulator::load(project(vec![main, fanout]), "main")
        .unwrap()
        .snapshot()
        .unwrap();
    let conflicts: Vec<_> = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "MULTIPLE_DRIVER_CONFLICT")
        .collect();

    assert_eq!(snapshot.input_nets["fanout-1"]["a"], Trit::Error);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].port_refs[0].component_id, "fanout-1");
}

#[test]
fn keeps_a_target_conflict_when_the_target_adds_a_local_driver() {
    let mixed = circuit(
        "mixed",
        ProjectCircuitKind::Module,
        vec![
            module_input("input", "a"),
            component(
                "local",
                "source.constant",
                serde_json::json!({"value": "0"}),
            ),
            component("probe", "sink.probe", serde_json::json!({})),
        ],
        vec![
            connection("input-probe", "input", "out", "probe", "in"),
            connection("local-probe", "local", "out", "probe", "in"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "negative",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            module_instance("mixed-1", "mixed"),
        ],
        vec![
            connection("negative-input", "negative", "out", "mixed-1", "a"),
            connection("positive-input", "positive", "out", "mixed-1", "a"),
        ],
    );

    let snapshot = ProjectSimulator::load(project(vec![main, mixed]), "main")
        .unwrap()
        .snapshot()
        .unwrap();
    let conflicts: Vec<_> = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "MULTIPLE_DRIVER_CONFLICT")
        .collect();

    assert_eq!(conflicts.len(), 2);
    assert!(conflicts.iter().any(|diagnostic| {
        diagnostic
            .port_refs
            .iter()
            .any(|reference| reference.component_id == "mixed-1")
    }));
    assert!(conflicts.iter().any(|diagnostic| {
        diagnostic
            .component_refs
            .iter()
            .any(|reference| reference.instance_path == ["mixed-1"])
    }));
}

#[test]
fn keeps_separate_target_conflicts_for_distinct_local_driver_sets() {
    let split = circuit(
        "split",
        ProjectCircuitKind::Module,
        vec![
            module_input("input", "a"),
            component(
                "local-zero",
                "source.constant",
                serde_json::json!({"value": "0"}),
            ),
            component(
                "local-positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            component("probe-1", "sink.probe", serde_json::json!({})),
            component("probe-2", "sink.probe", serde_json::json!({})),
        ],
        vec![
            connection("input-probe-1", "input", "out", "probe-1", "in"),
            connection("zero-probe-1", "local-zero", "out", "probe-1", "in"),
            connection("input-probe-2", "input", "out", "probe-2", "in"),
            connection("positive-probe-2", "local-positive", "out", "probe-2", "in"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "negative",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            module_instance("split-1", "split"),
        ],
        vec![
            connection("negative-input", "negative", "out", "split-1", "a"),
            connection("positive-input", "positive", "out", "split-1", "a"),
        ],
    );

    let snapshot = ProjectSimulator::load(project(vec![main, split]), "main")
        .unwrap()
        .snapshot()
        .unwrap();
    let conflicts: Vec<_> = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "MULTIPLE_DRIVER_CONFLICT")
        .collect();

    assert_eq!(conflicts.len(), 3);
    assert!(conflicts.iter().any(|diagnostic| {
        diagnostic
            .component_refs
            .iter()
            .any(|reference| reference.component_id == "probe-1")
    }));
    assert!(conflicts.iter().any(|diagnostic| {
        diagnostic
            .component_refs
            .iter()
            .any(|reference| reference.component_id == "probe-2")
    }));
}

#[test]
fn reports_only_the_upstream_boundary_across_three_transparent_levels() {
    let leaf = circuit(
        "leaf",
        ProjectCircuitKind::Module,
        vec![
            module_input("input", "a"),
            component("probe", "sink.probe", serde_json::json!({})),
        ],
        vec![connection("read", "input", "out", "probe", "in")],
    );
    let middle = circuit(
        "middle",
        ProjectCircuitKind::Module,
        vec![
            module_input("input", "a"),
            module_instance("leaf-1", "leaf"),
        ],
        vec![connection("forward", "input", "out", "leaf-1", "a")],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "negative",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            module_instance("middle-1", "middle"),
        ],
        vec![
            connection("negative-input", "negative", "out", "middle-1", "a"),
            connection("positive-input", "positive", "out", "middle-1", "a"),
        ],
    );

    let snapshot = ProjectSimulator::load(project(vec![main, middle, leaf]), "main")
        .unwrap()
        .snapshot()
        .unwrap();
    let conflicts: Vec<_> = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "MULTIPLE_DRIVER_CONFLICT")
        .collect();

    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].port_refs[0].component_id, "middle-1");
    assert!(conflicts[0].component_refs.iter().all(|reference| {
        !reference.component_id.contains('/') && !reference.component_id.contains("generated")
    }));
}

#[test]
fn valid_unreachable_structure_changes_do_not_recompile_the_active_root() {
    let main = circuit("main", ProjectCircuitKind::Main, vec![], vec![]);
    let spare = circuit("spare", ProjectCircuitKind::Module, vec![], vec![]);
    let initial = project(vec![main.clone(), spare.clone()]);
    let mut simulator = ProjectSimulator::load(initial.clone(), "main").unwrap();
    let mut changed = initial;
    changed.circuits[1].components.push(component(
        "constant",
        "source.constant",
        serde_json::json!({"value": "0"}),
    ));

    let snapshot = simulator.update_project(changed).unwrap();

    assert_eq!(snapshot.compile_count, 1);
}

#[test]
fn reachable_value_only_project_updates_settle_without_recompiling() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "source",
                "source.trit_input",
                serde_json::json!({"value": "T"}),
            ),
            component("probe", "sink.probe", serde_json::json!({})),
        ],
        vec![connection("read", "source", "out", "probe", "in")],
    );
    let initial = project(vec![main]);
    let mut changed = initial.clone();
    changed.circuits[0].components[0] = component(
        "source",
        "source.trit_input",
        serde_json::json!({"value": "1"}),
    );
    let mut simulator = ProjectSimulator::load(initial, "main").unwrap();

    let snapshot = simulator.update_project(changed).unwrap();

    assert_eq!(snapshot.compile_count, 1);
    assert_eq!(snapshot.component_outputs["source"]["out"], Trit::Pos);
    assert_eq!(snapshot.input_nets["probe"]["in"], Trit::Pos);
}

#[test]
fn reports_a_nested_boundary_that_adds_a_driver_without_consumers() {
    let leaf = circuit(
        "leaf",
        ProjectCircuitKind::Module,
        vec![module_input("input", "a")],
        vec![],
    );
    let middle = circuit(
        "middle",
        ProjectCircuitKind::Module,
        vec![
            module_input("input", "a"),
            component(
                "local-positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            module_instance("leaf-1", "leaf"),
        ],
        vec![
            connection("forward", "input", "out", "leaf-1", "a"),
            connection("local-forward", "local-positive", "out", "leaf-1", "a"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "negative",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            module_instance("middle-1", "middle"),
        ],
        vec![connection("drive", "negative", "out", "middle-1", "a")],
    );

    let snapshot = ProjectSimulator::load(project(vec![main, middle, leaf]), "main")
        .unwrap()
        .snapshot()
        .unwrap();
    let conflicts: Vec<_> = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "MULTIPLE_DRIVER_CONFLICT")
        .collect();

    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].port_refs[0].circuit_id, "middle");
    assert_eq!(conflicts[0].port_refs[0].instance_path, ["middle-1"]);
    assert_eq!(conflicts[0].port_refs[0].component_id, "leaf-1");
}

#[test]
fn projects_non_convergent_diagnostics_to_cross_level_component_refs() {
    let oscillator = circuit(
        "oscillator",
        ProjectCircuitKind::Module,
        vec![
            component("data", "source.constant", serde_json::json!({"value": "T"})),
            component(
                "selector",
                "source.trit_input",
                serde_json::json!({"value": "T"}),
            ),
            component("mux", "gate.mux2", serde_json::json!({})),
            component("neg", "gate.neg", serde_json::json!({})),
            module_output("output", "y"),
        ],
        vec![
            connection("data-mux-a", "data", "out", "mux", "a"),
            connection("selector-mux-s", "selector", "out", "mux", "s"),
            connection("neg-mux-b", "neg", "y", "mux", "b"),
            connection("mux-neg", "mux", "y", "neg", "a"),
            connection("mux-output", "mux", "y", "output", "in"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![module_instance("oscillator-1", "oscillator")],
        vec![],
    );

    let mut simulator = ProjectSimulator::load(project(vec![main, oscillator]), "main").unwrap();
    let snapshot = simulator
        .set_source("oscillator", "selector", Trit::Pos)
        .unwrap();
    let diagnostic = snapshot
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "NON_CONVERGENT_COMBINATIONAL_LOOP")
        .expect("oscillator must report a projected runtime diagnostic");

    assert!(!snapshot.stable);
    assert!(diagnostic.component_refs.iter().any(|reference| {
        reference.circuit_id == "oscillator"
            && reference.instance_path == ["oscillator-1"]
            && reference.component_id == "mux"
    }));
    assert!(diagnostic.component_refs.iter().all(|reference| {
        !reference.component_id.contains('/') && !reference.component_id.contains("generated")
    }));
    assert!(!diagnostic.message.contains("oscillator-1/"));
}

#[test]
fn output_boundary_conflict_covers_its_downstream_targets() {
    let conflict = circuit(
        "conflict-output",
        ProjectCircuitKind::Module,
        vec![
            component(
                "negative",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            module_output("output", "y"),
        ],
        vec![
            connection("negative-output", "negative", "out", "output", "in"),
            connection("positive-output", "positive", "out", "output", "in"),
        ],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            module_instance("conflict-1", "conflict-output"),
            component("probe-1", "sink.probe", serde_json::json!({})),
            component("probe-2", "sink.probe", serde_json::json!({})),
        ],
        vec![
            connection("read-1", "conflict-1", "y", "probe-1", "in"),
            connection("read-2", "conflict-1", "y", "probe-2", "in"),
        ],
    );

    let snapshot = ProjectSimulator::load(project(vec![main, conflict]), "main")
        .unwrap()
        .snapshot()
        .unwrap();
    let conflicts: Vec<_> = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "MULTIPLE_DRIVER_CONFLICT")
        .collect();

    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].port_refs[0].component_id, "conflict-1");
    assert_eq!(conflicts[0].port_refs[0].port_id, "y");
}

#[test]
fn independent_sibling_boundaries_with_the_same_drivers_remain_distinct() {
    let sink = circuit(
        "sink",
        ProjectCircuitKind::Module,
        vec![module_input("input", "a")],
        vec![],
    );
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![
            component(
                "negative",
                "source.constant",
                serde_json::json!({"value": "T"}),
            ),
            component(
                "positive",
                "source.constant",
                serde_json::json!({"value": "1"}),
            ),
            module_instance("left", "sink"),
            module_instance("right", "sink"),
        ],
        vec![
            connection("negative-left", "negative", "out", "left", "a"),
            connection("positive-left", "positive", "out", "left", "a"),
            connection("negative-right", "negative", "out", "right", "a"),
            connection("positive-right", "positive", "out", "right", "a"),
        ],
    );

    let snapshot = ProjectSimulator::load(project(vec![main, sink]), "main")
        .unwrap()
        .snapshot()
        .unwrap();
    let boundary_ids: BTreeSet<_> = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "MULTIPLE_DRIVER_CONFLICT")
        .flat_map(|diagnostic| diagnostic.port_refs.iter())
        .map(|reference| reference.component_id.as_str())
        .collect();

    assert_eq!(boundary_ids, BTreeSet::from(["left", "right"]));
}

#[test]
fn a_failed_active_switch_preserves_the_previous_runtime() {
    let main = circuit(
        "main",
        ProjectCircuitKind::Main,
        vec![component(
            "source",
            "source.constant",
            serde_json::json!({"value": "1"}),
        )],
        vec![],
    );
    let mut simulator = ProjectSimulator::load(project(vec![main]), "main").unwrap();
    let before = simulator.snapshot().unwrap();

    let diagnostics = simulator.switch_active("missing").unwrap_err();

    assert_eq!(diagnostics[0].code, "INVALID_ACTIVE_CIRCUIT");
    assert_eq!(simulator.snapshot(), Some(before));
}
