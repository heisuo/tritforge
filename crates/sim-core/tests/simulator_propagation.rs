use sim_core::catalog::ComponentProperties;
use sim_core::circuit::{CircuitDefinition, ComponentInstance, Connection};
use sim_core::diagnostic::DiagnosticSeverity;
use sim_core::simulator::{SimulationSnapshot, Simulator};
use sim_core::trit::Trit;

fn component(id: &str, type_id: &str) -> ComponentInstance {
    ComponentInstance {
        id: id.to_owned(),
        type_id: type_id.to_owned(),
        properties: ComponentProperties::default(),
    }
}

fn valued_component(id: &str, type_id: &str, value: Trit) -> ComponentInstance {
    ComponentInstance {
        id: id.to_owned(),
        type_id: type_id.to_owned(),
        properties: ComponentProperties { value: Some(value) },
    }
}

fn connection(
    id: &str,
    source_component_id: &str,
    source_port_id: &str,
    target_component_id: &str,
    target_port_id: &str,
) -> Connection {
    Connection {
        id: id.to_owned(),
        source_component_id: source_component_id.to_owned(),
        source_port_id: source_port_id.to_owned(),
        target_component_id: target_component_id.to_owned(),
        target_port_id: target_port_id.to_owned(),
    }
}

fn definition(
    components: Vec<ComponentInstance>,
    connections: Vec<Connection>,
) -> CircuitDefinition {
    CircuitDefinition {
        components,
        connections,
    }
}

fn diagnostic_codes(snapshot: &SimulationSnapshot) -> Vec<&str> {
    snapshot
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect()
}

fn oscillator_definition() -> CircuitDefinition {
    definition(
        vec![
            valued_component("data", "source.constant", Trit::Neg),
            valued_component("selector", "source.trit_input", Trit::Neg),
            component("mux", "gate.mux2"),
            component("neg", "gate.neg"),
            component("probe", "sink.probe"),
        ],
        vec![
            connection("data-mux-a", "data", "out", "mux", "a"),
            connection("selector-mux-s", "selector", "out", "mux", "s"),
            connection("neg-mux-b", "neg", "y", "mux", "b"),
            connection("mux-neg", "mux", "y", "neg", "a"),
            connection("mux-probe", "mux", "y", "probe", "in"),
        ],
    )
}

fn clock_activated_oscillator_definition() -> CircuitDefinition {
    definition(
        vec![
            component("clock", "source.clock"),
            valued_component("data", "source.constant", Trit::Neg),
            component("clock-is-pos", "gate.is_pos"),
            component("mux", "gate.mux2"),
            component("neg", "gate.neg"),
            component("probe", "sink.probe"),
        ],
        vec![
            connection("data-mux-a", "data", "out", "mux", "a"),
            connection("clock-is-pos", "clock", "out", "clock-is-pos", "a"),
            connection("is-pos-mux-s", "clock-is-pos", "y", "mux", "s"),
            connection("neg-mux-b", "neg", "y", "mux", "b"),
            connection("mux-neg", "mux", "y", "neg", "a"),
            connection("mux-probe", "mux", "y", "probe", "in"),
        ],
    )
}

fn dff_definition(clock_through_buffer: bool) -> CircuitDefinition {
    let mut components = vec![
        valued_component("data", "source.trit_input", Trit::Pos),
        valued_component("enable", "source.trit_input", Trit::Pos),
        valued_component("reset", "source.trit_input", Trit::Zero),
        component("clock", "source.clock"),
        component("dff", "sequential.dff"),
        component("probe", "sink.probe"),
    ];
    let mut connections = vec![
        connection("data-dff", "data", "out", "dff", "d"),
        connection("enable-dff", "enable", "out", "dff", "en"),
        connection("reset-dff", "reset", "out", "dff", "rst"),
        connection("dff-probe", "dff", "q", "probe", "in"),
    ];

    if clock_through_buffer {
        components.push(component("clock-buffer", "gate.buf"));
        connections.extend([
            connection("clock-buffer", "clock", "out", "clock-buffer", "a"),
            connection("buffer-dff", "clock-buffer", "y", "dff", "clk"),
        ]);
    } else {
        connections.push(connection("clock-dff", "clock", "out", "dff", "clk"));
    }

    definition(components, connections)
}

fn run_swap(dff0_id: &str, dff1_id: &str, reverse_definition: bool) -> (Trit, Trit) {
    let mut components = vec![
        component("clock", "source.clock"),
        valued_component("enable", "source.constant", Trit::Pos),
        valued_component("reset", "source.constant", Trit::Zero),
        valued_component("select", "source.trit_input", Trit::Neg),
        valued_component("init-0", "source.constant", Trit::Pos),
        valued_component("init-1", "source.constant", Trit::Zero),
        component("mux-0", "gate.mux2"),
        component("mux-1", "gate.mux2"),
        component(dff0_id, "sequential.dff"),
        component(dff1_id, "sequential.dff"),
    ];
    let mut connections = vec![
        connection("init-0-mux-0", "init-0", "out", "mux-0", "a"),
        connection("dff-1-mux-0", dff1_id, "q", "mux-0", "b"),
        connection("select-mux-0", "select", "out", "mux-0", "s"),
        connection("mux-0-dff-0", "mux-0", "y", dff0_id, "d"),
        connection("init-1-mux-1", "init-1", "out", "mux-1", "a"),
        connection("dff-0-mux-1", dff0_id, "q", "mux-1", "b"),
        connection("select-mux-1", "select", "out", "mux-1", "s"),
        connection("mux-1-dff-1", "mux-1", "y", dff1_id, "d"),
        connection("clock-dff-0", "clock", "out", dff0_id, "clk"),
        connection("clock-dff-1", "clock", "out", dff1_id, "clk"),
        connection("enable-dff-0", "enable", "out", dff0_id, "en"),
        connection("enable-dff-1", "enable", "out", dff1_id, "en"),
        connection("reset-dff-0", "reset", "out", dff0_id, "rst"),
        connection("reset-dff-1", "reset", "out", dff1_id, "rst"),
    ];

    if reverse_definition {
        components.reverse();
        connections.reverse();
    }

    let mut simulator = Simulator::load(definition(components, connections)).expect("valid swap");
    let initialized = simulator.tick().expect("initialize both DFFs");
    assert_eq!(initialized.output_value(dff0_id, "q"), Some(Trit::Pos));
    assert_eq!(initialized.output_value(dff1_id, "q"), Some(Trit::Zero));

    simulator
        .set_input("select", Trit::Pos)
        .expect("select feedback inputs");
    let swapped = simulator.tick().expect("capture swap");
    (
        swapped.output_value(dff0_id, "q").unwrap(),
        swapped.output_value(dff1_id, "q").unwrap(),
    )
}

#[test]
fn dff_loads_low_and_tick_captures_on_a_complete_clock_pulse() {
    let mut simulator = Simulator::load(dff_definition(false)).expect("valid DFF circuit");

    let initial = simulator.snapshot();
    assert_eq!(initial.output_value("clock", "out"), Some(Trit::Zero));
    assert_eq!(initial.output_value("dff", "q"), Some(Trit::Zero));
    assert_eq!(initial.input_value("probe", "in"), Some(Trit::Zero));
    assert_eq!(initial.tick_count, 0);

    let captured = simulator.tick().expect("tick succeeds");
    assert_eq!(captured.output_value("dff", "q"), Some(Trit::Pos));
    assert_eq!(captured.input_value("probe", "in"), Some(Trit::Pos));
    assert_eq!(captured.output_value("clock", "out"), Some(Trit::Zero));
    assert_eq!(captured.input_value("dff", "clk"), Some(Trit::Zero));
    assert_eq!(captured.processed_events, 6);
    assert_eq!(captured.tick_count, 1);
}

#[test]
fn dff_enable_reset_priority_and_reset_restore_session_state() {
    let mut simulator = Simulator::load(dff_definition(false)).expect("valid DFF circuit");

    simulator.tick().expect("capture initial one");
    simulator.set_input("data", Trit::Neg).unwrap();
    simulator.set_input("enable", Trit::Zero).unwrap();
    let held = simulator.tick().expect("disabled tick");
    assert_eq!(held.output_value("dff", "q"), Some(Trit::Pos));
    assert_eq!(held.tick_count, 2);

    simulator.set_input("enable", Trit::Pos).unwrap();
    simulator.set_input("reset", Trit::Pos).unwrap();
    let reset_wins = simulator.tick().expect("synchronous reset tick");
    assert_eq!(reset_wins.output_value("dff", "q"), Some(Trit::Zero));
    assert_eq!(reset_wins.tick_count, 3);

    simulator.set_input("reset", Trit::Zero).unwrap();
    simulator.set_input("data", Trit::Pos).unwrap();
    let recaptured = simulator.tick().expect("capture after reset");
    assert_eq!(recaptured.output_value("dff", "q"), Some(Trit::Pos));

    let reset = simulator.reset();
    assert_eq!(reset.output_value("dff", "q"), Some(Trit::Zero));
    assert_eq!(reset.output_value("clock", "out"), Some(Trit::Zero));
    assert_eq!(reset.input_value("dff", "clk"), Some(Trit::Zero));
    assert_eq!(reset.tick_count, 0);
}

#[test]
fn dffs_swap_with_one_simultaneous_commit_independent_of_ids_and_definition_order() {
    let ascending_ids = run_swap("a-dff", "z-dff", false);
    let reversed_ids_and_definition = run_swap("z-dff", "a-dff", true);

    assert_eq!(ascending_ids, (Trit::Zero, Trit::Pos));
    assert_eq!(reversed_ids_and_definition, ascending_ids);
}

#[test]
fn tick_does_not_sample_a_dff_whose_clock_is_already_positive() {
    let mut simulator = Simulator::load(definition(
        vec![
            valued_component("data", "source.constant", Trit::Pos),
            valued_component("clock-high", "source.constant", Trit::Pos),
            valued_component("enable", "source.constant", Trit::Pos),
            valued_component("reset", "source.constant", Trit::Zero),
            component("dff", "sequential.dff"),
        ],
        vec![
            connection("data-dff", "data", "out", "dff", "d"),
            connection("clock-dff", "clock-high", "out", "dff", "clk"),
            connection("enable-dff", "enable", "out", "dff", "en"),
            connection("reset-dff", "reset", "out", "dff", "rst"),
        ],
    ))
    .expect("valid constant-clock DFF");

    let initial = simulator.snapshot();
    assert_eq!(initial.input_value("dff", "clk"), Some(Trit::Pos));
    assert_eq!(initial.output_value("dff", "q"), Some(Trit::Zero));

    let ticked = simulator.tick().expect("tick without a clock source");
    assert_eq!(ticked.output_value("dff", "q"), Some(Trit::Zero));
    assert_eq!(ticked.tick_count, 1);
}

#[test]
fn clock_through_a_buffer_produces_a_rising_edge() {
    let mut simulator = Simulator::load(dff_definition(true)).expect("valid buffered clock");

    let captured = simulator.tick().expect("buffered clock tick");

    assert_eq!(captured.output_value("dff", "q"), Some(Trit::Pos));
    assert_eq!(captured.output_value("clock", "out"), Some(Trit::Zero));
    assert_eq!(captured.output_value("clock-buffer", "y"), Some(Trit::Zero));
    assert_eq!(captured.input_value("dff", "clk"), Some(Trit::Zero));
    assert_eq!(captured.tick_count, 1);
}

#[test]
fn input_through_neg_reaches_probe_at_a_stable_value() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("input", "source.trit_input", Trit::Neg),
            component("neg", "gate.neg"),
            component("probe", "sink.probe"),
        ],
        vec![
            connection("input-neg", "input", "out", "neg", "a"),
            connection("neg-probe", "neg", "y", "probe", "in"),
        ],
    ))
    .expect("valid circuit");

    let snapshot = simulator.snapshot();
    assert_eq!(snapshot.input_value("probe", "in"), Some(Trit::Pos));
    assert_eq!(snapshot.output_value("neg", "y"), Some(Trit::Pos));
    assert!(snapshot.stable);
    assert!(snapshot.diagnostics.is_empty());
}

#[test]
fn three_trit_ripple_adder_propagates_carry_between_full_adders() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("a0", "source.trit_input", Trit::Pos),
            valued_component("a1", "source.trit_input", Trit::Zero),
            valued_component("a2", "source.trit_input", Trit::Zero),
            valued_component("b0", "source.trit_input", Trit::Pos),
            valued_component("b1", "source.trit_input", Trit::Zero),
            valued_component("b2", "source.trit_input", Trit::Zero),
            valued_component("cin", "source.constant", Trit::Zero),
            component("fa0", "module.full_adder"),
            component("fa1", "module.full_adder"),
            component("fa2", "module.full_adder"),
        ],
        vec![
            connection("a0-fa0", "a0", "out", "fa0", "a"),
            connection("b0-fa0", "b0", "out", "fa0", "b"),
            connection("cin-fa0", "cin", "out", "fa0", "cin"),
            connection("carry0-fa1", "fa0", "carry", "fa1", "cin"),
            connection("a1-fa1", "a1", "out", "fa1", "a"),
            connection("b1-fa1", "b1", "out", "fa1", "b"),
            connection("carry1-fa2", "fa1", "carry", "fa2", "cin"),
            connection("a2-fa2", "a2", "out", "fa2", "a"),
            connection("b2-fa2", "b2", "out", "fa2", "b"),
        ],
    ))
    .expect("valid ripple adder");

    let snapshot = simulator.snapshot();
    assert!(snapshot.stable);
    assert!(snapshot.diagnostics.is_empty());
    assert_eq!(snapshot.output_value("fa0", "sum"), Some(Trit::Neg));
    assert_eq!(snapshot.output_value("fa1", "sum"), Some(Trit::Pos));
    assert_eq!(snapshot.output_value("fa2", "sum"), Some(Trit::Zero));
    assert_eq!(snapshot.output_value("fa2", "carry"), Some(Trit::Zero));
}

#[test]
fn buffer_output_fans_out_to_two_probes() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("input", "source.trit_input", Trit::Pos),
            component("buffer", "gate.buf"),
            component("probe-a", "sink.probe"),
            component("probe-b", "sink.probe"),
        ],
        vec![
            connection("input-buffer", "input", "out", "buffer", "a"),
            connection("buffer-a", "buffer", "y", "probe-a", "in"),
            connection("buffer-b", "buffer", "y", "probe-b", "in"),
        ],
    ))
    .expect("valid fanout circuit");

    let snapshot = simulator.snapshot();
    assert_eq!(snapshot.input_value("probe-a", "in"), Some(Trit::Pos));
    assert_eq!(snapshot.input_value("probe-b", "in"), Some(Trit::Pos));
    assert!(snapshot.stable);
    assert!(snapshot.diagnostics.is_empty());
}

#[test]
fn equal_known_drivers_resolve_without_conflict() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("constant-a", "source.constant", Trit::Neg),
            valued_component("constant-b", "source.constant", Trit::Neg),
            component("probe", "sink.probe"),
        ],
        vec![
            connection("a-probe", "constant-a", "out", "probe", "in"),
            connection("b-probe", "constant-b", "out", "probe", "in"),
        ],
    ))
    .expect("equal drivers are valid");

    let snapshot = simulator.snapshot();
    assert_eq!(snapshot.input_value("probe", "in"), Some(Trit::Neg));
    assert!(!diagnostic_codes(&snapshot).contains(&"MULTIPLE_DRIVER_CONFLICT"));
    assert!(snapshot.stable);
}

#[test]
fn different_known_constants_resolve_to_error_with_one_conflict() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("constant-neg", "source.constant", Trit::Neg),
            valued_component("constant-pos", "source.constant", Trit::Pos),
            component("probe", "sink.probe"),
        ],
        vec![
            connection("constant-neg-probe", "constant-neg", "out", "probe", "in"),
            connection("constant-pos-probe", "constant-pos", "out", "probe", "in"),
        ],
    ))
    .expect("multiple constant drivers are valid");

    let snapshot = simulator.snapshot();
    assert_eq!(snapshot.input_value("probe", "in"), Some(Trit::Error));
    assert_eq!(
        diagnostic_codes(&snapshot),
        vec!["MULTIPLE_DRIVER_CONFLICT"]
    );
}

#[test]
fn driver_conflict_does_not_duplicate_and_recovers_after_input_change() {
    let mut simulator = Simulator::load(definition(
        vec![
            valued_component("constant", "source.constant", Trit::Pos),
            valued_component("input", "source.trit_input", Trit::Neg),
            component("probe", "sink.probe"),
        ],
        vec![
            connection("constant-probe", "constant", "out", "probe", "in"),
            connection("input-probe", "input", "out", "probe", "in"),
        ],
    ))
    .expect("multiple drivers are valid");

    let conflicted = simulator.snapshot();
    assert_eq!(conflicted.input_value("probe", "in"), Some(Trit::Error));
    assert_eq!(
        diagnostic_codes(&conflicted),
        vec!["MULTIPLE_DRIVER_CONFLICT"]
    );

    let repeated = simulator
        .set_input("input", Trit::Neg)
        .expect("repeating a known input is valid");
    assert_eq!(
        diagnostic_codes(&repeated),
        vec!["MULTIPLE_DRIVER_CONFLICT"]
    );

    let recovered = simulator
        .set_input("input", Trit::Pos)
        .expect("known input update");
    assert_eq!(recovered.input_value("probe", "in"), Some(Trit::Pos));
    assert!(!diagnostic_codes(&recovered).contains(&"MULTIPLE_DRIVER_CONFLICT"));
    assert!(recovered.stable);
}

#[test]
fn unconnected_probe_starts_high_impedance_with_one_warning() {
    let simulator = Simulator::load(definition(vec![component("probe", "sink.probe")], vec![]))
        .expect("unconnected inputs are warnings");

    let snapshot = simulator.snapshot();
    assert_eq!(snapshot.input_value("probe", "in"), Some(Trit::HighZ));
    assert_eq!(diagnostic_codes(&snapshot), vec!["UNDRIVEN_INPUT"]);
    assert_eq!(
        snapshot.diagnostics[0].severity,
        DiagnosticSeverity::Warning
    );
    assert!(snapshot.stable);
}

#[test]
fn source_free_self_inverting_feedback_remains_quiescent_at_high_impedance() {
    let simulator = Simulator::load(definition(
        vec![component("neg", "gate.neg")],
        vec![connection("feedback", "neg", "y", "neg", "a")],
    ))
    .expect("feedback is structurally valid");

    let snapshot = simulator.snapshot();
    assert!(snapshot.stable);
    assert_eq!(snapshot.output_value("neg", "y"), Some(Trit::HighZ));
    assert_eq!(snapshot.input_value("neg", "a"), Some(Trit::HighZ));
    assert_eq!(snapshot.processed_events, 0);
    assert!(!diagnostic_codes(&snapshot).contains(&"NON_CONVERGENT_COMBINATIONAL_LOOP"));
}

#[test]
fn cyclic_mux_with_unselected_feedback_can_reach_a_known_stable_point() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("data", "source.constant", Trit::Pos),
            valued_component("selector", "source.constant", Trit::Neg),
            component("mux", "gate.mux3"),
        ],
        vec![
            connection("data-a", "data", "out", "mux", "a"),
            connection("data-b", "data", "out", "mux", "b"),
            connection("selector-s", "selector", "out", "mux", "s"),
            connection("feedback-c", "mux", "y", "mux", "c"),
        ],
    ))
    .expect("stable feedback is structurally valid");

    let snapshot = simulator.snapshot();
    assert!(snapshot.stable);
    assert_eq!(snapshot.output_value("mux", "y"), Some(Trit::Pos));
    assert_eq!(snapshot.input_value("mux", "c"), Some(Trit::Pos));
    assert!(!diagnostic_codes(&snapshot).contains(&"NON_CONVERGENT_COMBINATIONAL_LOOP"));
}

#[test]
fn cyclic_mux_with_unselected_feedback_can_stabilize_at_external_unknown() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("data", "source.constant", Trit::Neg),
            valued_component("selector", "source.constant", Trit::Neg),
            component("mux", "gate.mux2"),
            component("unknown-source", "gate.mux2"),
            valued_component("zero", "source.constant", Trit::Zero),
        ],
        vec![
            connection("data-unknown-a", "data", "out", "unknown-source", "a"),
            connection("data-unknown-b", "data", "out", "unknown-source", "b"),
            connection("zero-unknown-s", "zero", "out", "unknown-source", "s"),
            connection("unknown-mux-a", "unknown-source", "y", "mux", "a"),
            connection("selector-mux-s", "selector", "out", "mux", "s"),
            connection("feedback", "mux", "y", "mux", "b"),
        ],
    ))
    .expect("unknown feedback circuit is structurally valid");

    let snapshot = simulator.snapshot();
    assert!(snapshot.stable);
    assert_eq!(
        snapshot.output_value("unknown-source", "y"),
        Some(Trit::Unknown)
    );
    assert_eq!(snapshot.output_value("mux", "y"), Some(Trit::Unknown));
    assert_eq!(snapshot.input_value("mux", "a"), Some(Trit::Unknown));
    assert_eq!(snapshot.input_value("mux", "b"), Some(Trit::Unknown));
    assert_eq!(snapshot.input_value("mux", "s"), Some(Trit::Neg));
    assert!(!diagnostic_codes(&snapshot).contains(&"NON_CONVERGENT_COMBINATIONAL_LOOP"));
}

#[test]
fn cyclic_mux_with_unselected_feedback_can_stabilize_at_external_error() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("negative", "source.constant", Trit::Neg),
            valued_component("positive", "source.constant", Trit::Pos),
            valued_component("selector", "source.constant", Trit::Neg),
            component("mux", "gate.mux2"),
        ],
        vec![
            connection("negative-mux-a", "negative", "out", "mux", "a"),
            connection("positive-mux-a", "positive", "out", "mux", "a"),
            connection("selector-mux-s", "selector", "out", "mux", "s"),
            connection("feedback", "mux", "y", "mux", "b"),
        ],
    ))
    .expect("error feedback circuit is structurally valid");

    let snapshot = simulator.snapshot();
    assert!(snapshot.stable);
    assert_eq!(snapshot.output_value("mux", "y"), Some(Trit::Error));
    assert_eq!(snapshot.input_value("mux", "a"), Some(Trit::Error));
    assert_eq!(snapshot.input_value("mux", "b"), Some(Trit::Error));
    assert_eq!(snapshot.input_value("mux", "s"), Some(Trit::Neg));
    assert_eq!(
        diagnostic_codes(&snapshot),
        vec!["MULTIPLE_DRIVER_CONFLICT"]
    );
}

#[test]
fn active_mux_neg_oscillator_hits_the_event_bound_and_propagates_error() {
    let mut simulator = Simulator::load(oscillator_definition()).expect("valid oscillator");
    let initial = simulator.snapshot();
    assert!(initial.stable);
    assert_eq!(initial.output_value("mux", "y"), Some(Trit::Neg));
    assert_eq!(initial.output_value("neg", "y"), Some(Trit::Pos));

    let snapshot = simulator
        .set_input("selector", Trit::Pos)
        .expect("activate feedback");

    assert!(!snapshot.stable);
    assert_eq!(snapshot.processed_events, 1024);
    assert_eq!(
        diagnostic_codes(&snapshot),
        vec!["NON_CONVERGENT_COMBINATIONAL_LOOP"]
    );
    assert_eq!(snapshot.output_value("mux", "y"), Some(Trit::Error));
    assert_eq!(snapshot.output_value("neg", "y"), Some(Trit::Error));
    assert_eq!(snapshot.input_value("neg", "a"), Some(Trit::Error));
    assert_eq!(snapshot.input_value("probe", "in"), Some(Trit::Error));
    assert_eq!(snapshot.input_value("mux", "b"), Some(Trit::Error));
    assert_eq!(snapshot.input_value("mux", "a"), Some(Trit::Neg));
    assert_eq!(snapshot.input_value("mux", "s"), Some(Trit::Pos));

    let recovered = simulator
        .set_input("selector", Trit::Neg)
        .expect("deactivate feedback");
    assert!(recovered.stable);
    assert_eq!(recovered.output_value("mux", "y"), Some(Trit::Neg));
    assert_eq!(recovered.output_value("neg", "y"), Some(Trit::Pos));
    assert_eq!(recovered.input_value("probe", "in"), Some(Trit::Neg));
    assert!(!diagnostic_codes(&recovered).contains(&"NON_CONVERGENT_COMBINATIONAL_LOOP"));
}

#[test]
fn tick_without_clocks_preserves_a_preexisting_non_convergent_failure() {
    let mut simulator = Simulator::load(oscillator_definition()).expect("valid oscillator");
    let failed = simulator
        .set_input("selector", Trit::Pos)
        .expect("activate feedback");
    assert!(!failed.stable);
    assert_eq!(failed.processed_events, 1024);

    let ticked = simulator.tick().expect("tick without clocks");

    assert!(!ticked.stable);
    assert_eq!(
        diagnostic_codes(&ticked),
        vec!["NON_CONVERGENT_COMBINATIONAL_LOOP"]
    );
    assert_eq!(ticked.processed_events, failed.processed_events);
    assert_eq!(ticked.output_value("mux", "y"), Some(Trit::Error));
    assert_eq!(ticked.output_value("neg", "y"), Some(Trit::Error));
    assert_eq!(ticked.input_value("probe", "in"), Some(Trit::Error));
}

#[test]
fn unrelated_clock_tick_preserves_a_preexisting_non_convergent_failure() {
    let mut circuit = oscillator_definition();
    circuit
        .components
        .push(component("unrelated-clock", "source.clock"));
    let mut simulator = Simulator::load(circuit).expect("valid oscillator with clock");
    let failed = simulator
        .set_input("selector", Trit::Pos)
        .expect("activate feedback");
    assert!(!failed.stable);
    assert_eq!(failed.processed_events, 1024);

    let ticked = simulator.tick().expect("tick unrelated clock");

    assert!(!ticked.stable);
    assert_eq!(
        diagnostic_codes(&ticked),
        vec!["NON_CONVERGENT_COMBINATIONAL_LOOP"]
    );
    assert_eq!(ticked.processed_events, failed.processed_events + 2);
    assert_eq!(ticked.output_value("mux", "y"), Some(Trit::Error));
    assert_eq!(ticked.output_value("neg", "y"), Some(Trit::Error));
    assert_eq!(ticked.input_value("probe", "in"), Some(Trit::Error));
    assert_eq!(
        ticked.output_value("unrelated-clock", "out"),
        Some(Trit::Zero)
    );
}

#[test]
fn tick_sums_all_phase_events_when_clock_rise_triggers_non_convergence() {
    let mut simulator = Simulator::load(clock_activated_oscillator_definition())
        .expect("valid clock-activated oscillator");
    let initial = simulator.snapshot();
    assert!(initial.stable);
    assert_eq!(initial.output_value("clock", "out"), Some(Trit::Zero));

    let ticked = simulator.tick().expect("tick oscillator");

    assert!(!ticked.stable);
    assert_eq!(
        diagnostic_codes(&ticked),
        vec!["NON_CONVERGENT_COMBINATIONAL_LOOP"]
    );
    assert_eq!(ticked.processed_events, 1030);
    assert_eq!(ticked.output_value("clock", "out"), Some(Trit::Zero));
}

#[test]
fn event_bound_failure_preserves_an_unrelated_stable_network() {
    let mut circuit = oscillator_definition();
    circuit.components.extend([
        valued_component("unrelated", "source.constant", Trit::Pos),
        component("unrelated-probe", "sink.probe"),
    ]);
    circuit.connections.push(connection(
        "unrelated-probe",
        "unrelated",
        "out",
        "unrelated-probe",
        "in",
    ));
    let mut simulator = Simulator::load(circuit).expect("valid circuit");

    let snapshot = simulator
        .set_input("selector", Trit::Pos)
        .expect("activate feedback");

    assert!(!snapshot.stable);
    assert_eq!(snapshot.processed_events, 1024);
    assert_eq!(snapshot.output_value("unrelated", "out"), Some(Trit::Pos));
    assert_eq!(
        snapshot.input_value("unrelated-probe", "in"),
        Some(Trit::Pos)
    );
}

#[test]
fn set_input_cycles_known_values_and_rejects_invalid_updates_atomically() {
    let mut simulator = Simulator::load(definition(
        vec![
            component("input", "source.trit_input"),
            valued_component("constant", "source.constant", Trit::Zero),
            component("probe", "sink.probe"),
        ],
        vec![connection("input-probe", "input", "out", "probe", "in")],
    ))
    .expect("valid circuit");

    for value in [Trit::Neg, Trit::Zero, Trit::Pos] {
        let snapshot = simulator.set_input("input", value).expect("known value");
        assert_eq!(snapshot.output_value("input", "out"), Some(value));
        assert_eq!(snapshot.input_value("probe", "in"), Some(value));
    }

    for (component_id, value) in [
        ("missing", Trit::Neg),
        ("constant", Trit::Neg),
        ("probe", Trit::Neg),
        ("input", Trit::Unknown),
        ("input", Trit::HighZ),
        ("input", Trit::Error),
    ] {
        let before = simulator.snapshot();
        let diagnostic = simulator
            .set_input(component_id, value)
            .expect_err("invalid update must fail");
        assert_eq!(diagnostic.code, "INVALID_INPUT_UPDATE");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert_eq!(simulator.snapshot(), before);
    }
}

#[test]
fn set_sources_updates_inputs_and_constants_in_one_batch() {
    let mut simulator = Simulator::load(definition(
        vec![
            valued_component("input", "source.trit_input", Trit::Zero),
            valued_component("constant", "source.constant", Trit::Zero),
            component("input-probe", "sink.probe"),
            component("constant-probe", "sink.probe"),
        ],
        vec![
            connection("input-wire", "input", "out", "input-probe", "in"),
            connection("constant-wire", "constant", "out", "constant-probe", "in"),
        ],
    ))
    .expect("valid circuit");

    let snapshot = simulator
        .set_sources([("input", Trit::Pos), ("constant", Trit::Neg)])
        .expect("both source kinds are mutable");

    assert_eq!(snapshot.input_value("input-probe", "in"), Some(Trit::Pos));
    assert_eq!(
        snapshot.input_value("constant-probe", "in"),
        Some(Trit::Neg)
    );
}

#[test]
fn set_sources_rejects_the_whole_batch_before_mutating_any_source() {
    let mut simulator = Simulator::load(definition(
        vec![
            valued_component("input", "source.trit_input", Trit::Zero),
            valued_component("constant", "source.constant", Trit::Zero),
            component("neg", "gate.neg"),
        ],
        vec![],
    ))
    .expect("valid circuit");

    let invalid_batches = [
        vec![
            ("input", Trit::Pos),
            ("constant", Trit::Neg),
            ("neg", Trit::Zero),
        ],
        vec![("input", Trit::Pos), ("missing", Trit::Neg)],
        vec![("input", Trit::Pos), ("constant", Trit::Unknown)],
        vec![("input", Trit::Pos), ("input", Trit::Neg)],
    ];

    for updates in invalid_batches {
        let before = simulator.snapshot();
        let diagnostic = simulator
            .set_sources(updates)
            .expect_err("invalid batch must fail atomically");
        assert_eq!(diagnostic.code, "INVALID_SOURCE_UPDATE");
        assert_eq!(simulator.snapshot(), before);
    }
}

#[test]
fn reset_restores_the_definition_input_value() {
    let mut simulator = Simulator::load(definition(
        vec![
            valued_component("explicit", "source.trit_input", Trit::Neg),
            component("default", "source.trit_input"),
            component("explicit-probe", "sink.probe"),
            component("default-probe", "sink.probe"),
        ],
        vec![
            connection("explicit-probe", "explicit", "out", "explicit-probe", "in"),
            connection("default-probe", "default", "out", "default-probe", "in"),
        ],
    ))
    .expect("valid circuit");

    simulator.set_input("explicit", Trit::Pos).unwrap();
    let changed = simulator.set_input("default", Trit::Pos).unwrap();
    assert_eq!(changed.input_value("explicit-probe", "in"), Some(Trit::Pos));
    assert_eq!(changed.input_value("default-probe", "in"), Some(Trit::Pos));

    let reset = simulator.reset();
    assert_eq!(reset.output_value("explicit", "out"), Some(Trit::Neg));
    assert_eq!(reset.input_value("explicit-probe", "in"), Some(Trit::Neg));
    assert_eq!(reset.output_value("default", "out"), Some(Trit::Zero));
    assert_eq!(reset.input_value("default-probe", "in"), Some(Trit::Zero));
    assert!(reset.stable);
}

#[test]
fn reversed_definition_arrays_produce_identical_snapshots_and_diagnostics() {
    let components = vec![
        valued_component("input", "source.trit_input", Trit::Neg),
        valued_component("constant", "source.constant", Trit::Pos),
        component("probe", "sink.probe"),
        component("unused-neg", "gate.neg"),
    ];
    let connections = vec![
        connection("z-duplicate", "input", "out", "probe", "in"),
        connection("constant-probe", "constant", "out", "probe", "in"),
        connection("a-duplicate", "input", "out", "probe", "in"),
    ];
    let mut reversed_components = components.clone();
    reversed_components.reverse();
    let mut reversed_connections = connections.clone();
    reversed_connections.reverse();

    let forward = Simulator::load(definition(components, connections))
        .expect("forward definition")
        .snapshot();
    let reversed = Simulator::load(definition(reversed_components, reversed_connections))
        .expect("reversed definition")
        .snapshot();

    assert_eq!(forward, reversed);
    assert_eq!(
        diagnostic_codes(&forward),
        vec![
            "DUPLICATE_CONNECTION",
            "MULTIPLE_DRIVER_CONFLICT",
            "UNDRIVEN_INPUT"
        ]
    );
}

#[test]
fn duplicate_connection_warning_is_retained_without_a_false_conflict() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("constant", "source.constant", Trit::Zero),
            component("probe", "sink.probe"),
        ],
        vec![
            connection("z-duplicate", "constant", "out", "probe", "in"),
            connection("a-kept", "constant", "out", "probe", "in"),
        ],
    ))
    .expect("duplicate endpoint only warns");

    let initial = simulator.snapshot();
    let repeated = simulator.snapshot();
    assert_eq!(initial.input_value("probe", "in"), Some(Trit::Zero));
    assert_eq!(diagnostic_codes(&initial), vec!["DUPLICATE_CONNECTION"]);
    assert_eq!(initial.diagnostics, repeated.diagnostics);
}

#[test]
fn multi_stage_chain_propagates_to_its_final_probe() {
    let simulator = Simulator::load(definition(
        vec![
            valued_component("input", "source.trit_input", Trit::Neg),
            component("neg-a", "gate.neg"),
            component("buffer", "gate.buf"),
            component("neg-b", "gate.neg"),
            component("probe", "sink.probe"),
        ],
        vec![
            connection("01", "input", "out", "neg-a", "a"),
            connection("02", "neg-a", "y", "buffer", "a"),
            connection("03", "buffer", "y", "neg-b", "a"),
            connection("04", "neg-b", "y", "probe", "in"),
        ],
    ))
    .expect("valid chain");

    let snapshot = simulator.snapshot();
    assert_eq!(snapshot.output_value("neg-a", "y"), Some(Trit::Pos));
    assert_eq!(snapshot.output_value("buffer", "y"), Some(Trit::Pos));
    assert_eq!(snapshot.output_value("neg-b", "y"), Some(Trit::Neg));
    assert_eq!(snapshot.input_value("probe", "in"), Some(Trit::Neg));
    assert!(snapshot.stable);
}

#[test]
fn snapshot_round_trips_through_serde() {
    let snapshot = Simulator::load(definition(
        vec![
            valued_component("input", "source.trit_input", Trit::Zero),
            component("probe", "sink.probe"),
        ],
        vec![connection("input-probe", "input", "out", "probe", "in")],
    ))
    .expect("valid circuit")
    .snapshot();

    let json = serde_json::to_string(&snapshot).expect("serialize snapshot");
    let round_trip: SimulationSnapshot = serde_json::from_str(&json).expect("deserialize snapshot");

    assert_eq!(round_trip, snapshot);
    assert!(json.contains(r#""api_version":3"#));
    assert!(json.contains(r#""tick_count":0"#));
}
