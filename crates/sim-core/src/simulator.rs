use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::catalog::{ComponentKind, ComponentProperties, PortDirection};
use crate::circuit::{
    CircuitDefinition, PortRef, ValidatedCircuit, ValidationOutcome, validate_circuit,
};
use crate::diagnostic::Diagnostic;
use crate::gates::evaluate;
use crate::trit::{Trit, resolve_drivers};

pub struct Simulator {
    circuit: ValidatedCircuit,
    original_source_properties: BTreeMap<String, ComponentProperties>,
    source_properties: BTreeMap<String, ComponentProperties>,
    component_outputs: BTreeMap<PortRef, Trit>,
    input_nets: BTreeMap<PortRef, Trit>,
    base_diagnostics: Vec<Diagnostic>,
    diagnostics: Vec<Diagnostic>,
    processed_events: usize,
    stable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimulationSnapshot {
    pub api_version: u32,
    pub stable: bool,
    pub component_outputs: BTreeMap<String, BTreeMap<String, Trit>>,
    pub input_nets: BTreeMap<String, BTreeMap<String, Trit>>,
    pub diagnostics: Vec<Diagnostic>,
    pub processed_events: usize,
}

impl SimulationSnapshot {
    pub fn input_value(&self, component_id: &str, port_id: &str) -> Option<Trit> {
        self.input_nets
            .get(component_id)
            .and_then(|ports| ports.get(port_id))
            .copied()
    }

    pub fn output_value(&self, component_id: &str, port_id: &str) -> Option<Trit> {
        self.component_outputs
            .get(component_id)
            .and_then(|ports| ports.get(port_id))
            .copied()
    }
}

impl Simulator {
    pub fn load(definition: CircuitDefinition) -> Result<Self, Vec<Diagnostic>> {
        let ValidationOutcome { circuit, warnings } = validate_circuit(definition)?;
        let original_source_properties: BTreeMap<String, ComponentProperties> = circuit
            .components()
            .iter()
            .filter(|component| {
                matches!(
                    circuit.component_kind(&component.id),
                    Some(ComponentKind::TritInput | ComponentKind::Constant)
                )
            })
            .map(|component| (component.id.clone(), component.properties.clone()))
            .collect();
        let source_properties = original_source_properties.clone();
        let (component_outputs, input_nets) = signal_maps(&circuit);
        let base_diagnostics = baseline_diagnostics(&circuit, warnings);
        let component_ids = circuit
            .components()
            .iter()
            .filter(|component| {
                matches!(
                    circuit.component_kind(&component.id),
                    Some(ComponentKind::TritInput | ComponentKind::Constant)
                )
            })
            .map(|component| component.id.clone())
            .collect::<Vec<_>>();

        let mut simulator = Self {
            circuit,
            original_source_properties,
            source_properties,
            component_outputs,
            input_nets,
            diagnostics: base_diagnostics.clone(),
            base_diagnostics,
            processed_events: 0,
            stable: false,
        };
        simulator.settle(component_ids);
        Ok(simulator)
    }

    #[allow(clippy::result_large_err)]
    pub fn set_input(
        &mut self,
        component_id: &str,
        value: Trit,
    ) -> Result<SimulationSnapshot, Diagnostic> {
        if self.circuit.component_kind(component_id) != Some(ComponentKind::TritInput) {
            return Err(Diagnostic::error(
                "INVALID_INPUT_UPDATE",
                format!("component '{component_id}' is not a trit input"),
                vec![component_id.to_owned()],
                vec![],
                vec![],
            ));
        }
        if !value.is_known() {
            return Err(Diagnostic::error(
                "INVALID_INPUT_UPDATE",
                format!("component '{component_id}' requires a known T, 0, or 1 value"),
                vec![component_id.to_owned()],
                vec![],
                vec![],
            ));
        }

        self.source_properties
            .get_mut(component_id)
            .expect("validated trit input has source properties")
            .value = Some(value);
        self.settle([component_id.to_owned()]);
        Ok(self.snapshot())
    }

    #[allow(clippy::result_large_err)]
    pub fn set_sources<I, S>(&mut self, updates: I) -> Result<SimulationSnapshot, Diagnostic>
    where
        I: IntoIterator<Item = (S, Trit)>,
        S: Into<String>,
    {
        let mut staged = BTreeMap::new();
        for (component_id, value) in updates {
            let component_id = component_id.into();
            if !matches!(
                self.circuit.component_kind(&component_id),
                Some(ComponentKind::TritInput | ComponentKind::Constant)
            ) {
                return Err(Diagnostic::error(
                    "INVALID_SOURCE_UPDATE",
                    format!("component '{component_id}' is not a mutable source"),
                    vec![component_id],
                    vec![],
                    vec![],
                ));
            }
            if !value.is_known() {
                return Err(Diagnostic::error(
                    "INVALID_SOURCE_UPDATE",
                    format!("component '{component_id}' requires a known T, 0, or 1 value"),
                    vec![component_id],
                    vec![],
                    vec![],
                ));
            }
            if staged.insert(component_id.clone(), value).is_some() {
                return Err(Diagnostic::error(
                    "INVALID_SOURCE_UPDATE",
                    format!("component '{component_id}' is updated more than once"),
                    vec![component_id],
                    vec![],
                    vec![],
                ));
            }
        }

        if staged.is_empty() {
            return Ok(self.snapshot());
        }

        for (component_id, value) in &staged {
            self.source_properties
                .get_mut(component_id)
                .expect("validated source has mutable properties")
                .value = Some(*value);
        }
        self.settle(staged.into_keys());
        Ok(self.snapshot())
    }

    pub fn reset(&mut self) -> SimulationSnapshot {
        self.source_properties
            .clone_from(&self.original_source_properties);
        (self.component_outputs, self.input_nets) = signal_maps(&self.circuit);
        let component_ids = self
            .circuit
            .components()
            .iter()
            .filter(|component| {
                matches!(
                    self.circuit.component_kind(&component.id),
                    Some(ComponentKind::TritInput | ComponentKind::Constant)
                )
            })
            .map(|component| component.id.clone())
            .collect::<Vec<_>>();
        self.settle(component_ids);
        self.snapshot()
    }

    pub fn snapshot(&self) -> SimulationSnapshot {
        SimulationSnapshot {
            api_version: crate::api_version(),
            stable: self.stable,
            component_outputs: nested_signals(&self.component_outputs),
            input_nets: nested_signals(&self.input_nets),
            diagnostics: self.diagnostics.clone(),
            processed_events: self.processed_events,
        }
    }

    fn settle(&mut self, component_ids: impl IntoIterator<Item = String>) {
        let mut queued: BTreeSet<_> = component_ids.into_iter().collect();
        let mut queue: VecDeque<_> = queued.iter().cloned().collect();
        let event_limit = 1024_usize.max(
            64_usize.saturating_mul(
                self.circuit
                    .components()
                    .len()
                    .saturating_add(self.circuit.connection_count()),
            ),
        );

        self.processed_events = 0;
        self.stable = true;

        while !queue.is_empty() {
            if self.processed_events >= event_limit {
                self.fail_pending_components(&queued);
                return;
            }

            let component_id = queue.pop_front().expect("queue is not empty");
            queued.remove(&component_id);
            self.processed_events += 1;
            self.evaluate_component(&component_id, &mut queue, &mut queued);
        }

        let mut diagnostics: BTreeSet<_> = self.base_diagnostics.iter().cloned().collect();
        self.add_multiple_driver_diagnostics(&mut diagnostics);
        self.diagnostics = diagnostics.into_iter().collect();
    }

    fn evaluate_component(
        &mut self,
        component_id: &str,
        queue: &mut VecDeque<String>,
        queued: &mut BTreeSet<String>,
    ) {
        let component = self
            .circuit
            .component(component_id)
            .expect("queued component is validated");
        let kind = self
            .circuit
            .component_kind(component_id)
            .expect("validated component has a known kind");
        let properties = self
            .source_properties
            .get(component_id)
            .unwrap_or(&component.properties);
        let inputs = kind
            .port_descriptors()
            .into_iter()
            .filter(|port| port.direction == PortDirection::Input)
            .map(|port| {
                let value = self
                    .input_nets
                    .get(&PortRef::new(component_id, &port.id))
                    .copied()
                    .expect("declared input has a signal");
                (port.id, value)
            })
            .collect();
        let evaluated_outputs = evaluate(kind, properties, &inputs);

        for (port_id, value) in evaluated_outputs {
            let output = PortRef::new(component_id, &port_id);
            let previous = self
                .component_outputs
                .insert(output.clone(), value)
                .expect("evaluated output is declared");
            if previous == value {
                continue;
            }

            let downstream = self.circuit.downstream_for(component_id, &port_id).to_vec();
            for downstream_id in downstream {
                if self.resolve_component_inputs(&downstream_id)
                    && queued.insert(downstream_id.clone())
                {
                    queue.push_back(downstream_id);
                }
            }
        }
    }

    fn resolve_component_inputs(&mut self, component_id: &str) -> bool {
        let kind = self
            .circuit
            .component_kind(component_id)
            .expect("downstream component is validated");
        let mut changed = false;

        for port in kind
            .port_descriptors()
            .into_iter()
            .filter(|port| port.direction == PortDirection::Input)
        {
            let target = PortRef::new(component_id, &port.id);
            let values = self
                .circuit
                .drivers_for(component_id, &port.id)
                .iter()
                .map(|driver| {
                    self.component_outputs
                        .get(driver)
                        .copied()
                        .expect("validated driver output has a signal")
                })
                .collect::<Vec<_>>();
            let resolved = resolve_drivers(&values);
            let previous = self
                .input_nets
                .insert(target, resolved)
                .expect("declared input has a signal");
            changed |= previous != resolved;
        }

        changed
    }

    fn add_multiple_driver_diagnostics(&self, diagnostics: &mut BTreeSet<Diagnostic>) {
        for (target, value) in &self.input_nets {
            if *value != Trit::Error {
                continue;
            }

            let drivers = self
                .circuit
                .drivers_for(&target.component_id, &target.port_id);
            let known_values = drivers
                .iter()
                .filter_map(|driver| self.component_outputs.get(driver))
                .filter(|value| value.is_known())
                .copied()
                .collect::<BTreeSet<_>>();
            if known_values.len() < 2 {
                continue;
            }

            let mut component_ids = drivers
                .iter()
                .map(|driver| driver.component_id.clone())
                .collect::<BTreeSet<_>>();
            component_ids.insert(target.component_id.clone());
            let connection_ids = self
                .circuit
                .connections()
                .iter()
                .filter(|connection| {
                    connection.target_component_id == target.component_id
                        && connection.target_port_id == target.port_id
                })
                .map(|connection| connection.id.clone())
                .collect();

            diagnostics.insert(Diagnostic::error(
                "MULTIPLE_DRIVER_CONFLICT",
                format!(
                    "input '{}.{}' has differing known drivers",
                    target.component_id, target.port_id
                ),
                component_ids.into_iter().collect(),
                connection_ids,
                vec![target.port_id.clone()],
            ));
        }
    }

    fn fail_pending_components(&mut self, queued: &BTreeSet<String>) {
        let affected_components = self.propagate_error_from_pending(queued);
        let mut diagnostics: BTreeSet<_> = self.base_diagnostics.iter().cloned().collect();
        self.add_multiple_driver_diagnostics(&mut diagnostics);
        diagnostics.insert(self.non_convergent_diagnostic(&affected_components));
        self.diagnostics = diagnostics.into_iter().collect();
        self.stable = false;
    }

    fn propagate_error_from_pending(
        &mut self,
        pending_components: &BTreeSet<String>,
    ) -> BTreeSet<String> {
        let mut queued = pending_components.clone();
        let mut queue: VecDeque<_> = queued.iter().cloned().collect();
        let mut affected_components = BTreeSet::new();

        while let Some(component_id) = queue.pop_front() {
            queued.remove(&component_id);
            affected_components.insert(component_id.clone());
            let kind = self
                .circuit
                .component_kind(&component_id)
                .expect("pending component is validated");
            let output_ids = kind
                .port_descriptors()
                .into_iter()
                .filter(|port| port.direction == PortDirection::Output)
                .map(|port| port.id)
                .collect::<Vec<_>>();

            for port_id in output_ids {
                self.component_outputs
                    .insert(PortRef::new(&component_id, &port_id), Trit::Error)
                    .expect("declared output has a signal");
                let downstream = self
                    .circuit
                    .downstream_for(&component_id, &port_id)
                    .to_vec();
                for downstream_id in downstream {
                    if self.resolve_component_inputs(&downstream_id)
                        && queued.insert(downstream_id.clone())
                    {
                        queue.push_back(downstream_id);
                    }
                }
            }
        }

        affected_components
    }

    fn non_convergent_diagnostic(&self, component_ids: &BTreeSet<String>) -> Diagnostic {
        let connection_ids = self
            .circuit
            .connections()
            .iter()
            .filter(|connection| {
                component_ids.contains(&connection.source_component_id)
                    || component_ids.contains(&connection.target_component_id)
            })
            .map(|connection| connection.id.clone())
            .collect();
        Diagnostic::error(
            "NON_CONVERGENT_COMBINATIONAL_LOOP",
            "circuit exceeded the event limit before reaching a stable state".to_owned(),
            component_ids.iter().cloned().collect(),
            connection_ids,
            vec![],
        )
    }
}

fn signal_maps(circuit: &ValidatedCircuit) -> (BTreeMap<PortRef, Trit>, BTreeMap<PortRef, Trit>) {
    let mut component_outputs = BTreeMap::new();
    let mut input_nets = BTreeMap::new();

    for component in circuit.components() {
        let kind = circuit
            .component_kind(&component.id)
            .expect("validated component has a known kind");
        for port in kind.port_descriptors() {
            let target = PortRef::new(&component.id, port.id);
            match port.direction {
                PortDirection::Input => {
                    input_nets.insert(target, Trit::HighZ);
                }
                PortDirection::Output => {
                    component_outputs.insert(target, Trit::HighZ);
                }
            }
        }
    }

    (component_outputs, input_nets)
}

fn baseline_diagnostics(circuit: &ValidatedCircuit, warnings: Vec<Diagnostic>) -> Vec<Diagnostic> {
    let mut diagnostics: BTreeSet<_> = warnings.into_iter().collect();

    for component in circuit.components() {
        let kind = circuit
            .component_kind(&component.id)
            .expect("validated component has a known kind");
        for port in kind
            .port_descriptors()
            .into_iter()
            .filter(|port| port.direction == PortDirection::Input)
        {
            if circuit.drivers_for(&component.id, &port.id).is_empty() {
                diagnostics.insert(Diagnostic::warning(
                    "UNDRIVEN_INPUT",
                    format!("input '{}.{}' has no drivers", component.id, port.id),
                    vec![component.id.clone()],
                    vec![],
                    vec![port.id],
                ));
            }
        }
    }

    diagnostics.into_iter().collect()
}

fn nested_signals(signals: &BTreeMap<PortRef, Trit>) -> BTreeMap<String, BTreeMap<String, Trit>> {
    let mut nested = BTreeMap::<String, BTreeMap<String, Trit>>::new();
    for (port, value) in signals {
        nested
            .entry(port.component_id.clone())
            .or_default()
            .insert(port.port_id.clone(), *value);
    }
    nested
}
