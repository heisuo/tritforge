use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::catalog::PortDirection;
use crate::connectivity::{CompiledProjectV3, compile_project_v3};
use crate::diagnostic::{Diagnostic, Severity};
use crate::hierarchy::{CompiledProject, FlatPortRef, compile_project};
use crate::project::{
    ProjectCircuit, ProjectDiagnostic, ProjectDiagnosticSet, ProjectDocument, ProjectDocumentV3,
    ProjectLocation, QualifiedComponentRef, QualifiedConnectionRef, QualifiedPortRef,
};
use crate::project_validation::{ValidatedProject, resolve_project_ports, validate_project};
use crate::signal::{KnownWord, SignalError, SignalShape, WordValue};
use crate::simulator::{ClockPhase, SimulationSnapshot, Simulator};
use crate::trit::{Trit, resolve_drivers};

const MODULE_INPUT: &str = "project.module_input";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub component_outputs: BTreeMap<String, BTreeMap<String, Trit>>,
    pub input_nets: BTreeMap<String, BTreeMap<String, Trit>>,
    /// Width-aware values serialized as MS-first `T/0/1/X/Z/E` strings.
    pub component_output_words: BTreeMap<String, BTreeMap<String, WordValue>>,
    /// Width-aware input-net values serialized as MS-first `T/0/1/X/Z/E` strings.
    pub input_net_words: BTreeMap<String, BTreeMap<String, WordValue>>,
    pub diagnostics: Vec<ProjectDiagnostic>,
    pub stable: bool,
    pub tick_count: u64,
    #[serde(default)]
    pub clock_phase: ClockPhase,
    pub compile_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCompileMetrics {
    pub expanded_components: usize,
    pub expanded_connections: usize,
    pub projection_endpoints: usize,
}

pub struct ProjectSimulator {
    project: ProjectDocument,
    project_v3: Option<ProjectDocumentV3>,
    active_circuit_id: String,
    validated: Option<ValidatedProject>,
    compiled: Option<CompiledProject>,
    compiled_v3: Option<CompiledProjectV3>,
    simulator: Option<Simulator>,
    snapshot: Option<ProjectSnapshot>,
    compile_count: u64,
}

impl ProjectSimulator {
    pub fn load(
        project: ProjectDocument,
        active_circuit_id: &str,
    ) -> Result<Self, Vec<ProjectDiagnostic>> {
        let mut project_simulator = Self {
            project,
            project_v3: None,
            active_circuit_id: active_circuit_id.to_owned(),
            validated: None,
            compiled: None,
            compiled_v3: None,
            simulator: None,
            snapshot: None,
            compile_count: 0,
        };
        project_simulator.rebuild()?;
        Ok(project_simulator)
    }

    pub fn load_v3(
        project: ProjectDocumentV3,
        active_circuit_id: &str,
    ) -> Result<Self, Vec<ProjectDiagnostic>> {
        let compiled_v3 = compile_project_v3(project.clone(), active_circuit_id)?;
        let compiled = compiled_v3.compiled.clone();
        let network_index = FlatNetworkIndex::new(&compiled);
        let simulator = Simulator::load(compiled.circuit.clone()).map_err(|diagnostics| {
            diagnostics
                .iter()
                .map(|diagnostic| {
                    remap_v3_diagnostic(
                        project_flat_diagnostic(diagnostic, &compiled, &network_index),
                        &compiled_v3,
                    )
                })
                .collect::<Vec<_>>()
        })?;
        let flat = simulator.snapshot();
        let mut project_simulator = Self {
            project: compiled_v3.lowered.project.clone(),
            project_v3: Some(project),
            active_circuit_id: active_circuit_id.to_owned(),
            validated: None,
            compiled: Some(compiled),
            compiled_v3: Some(compiled_v3),
            simulator: Some(simulator),
            snapshot: None,
            compile_count: 1,
        };
        project_simulator.snapshot = Some(project_simulator.project_snapshot(&flat));
        Ok(project_simulator)
    }

    pub fn update_project(
        &mut self,
        project: ProjectDocument,
    ) -> Result<ProjectSnapshot, Vec<ProjectDiagnostic>> {
        let validated = match validate_project(project.clone()) {
            Ok(validated) => validated,
            Err(diagnostics) => {
                self.project = project;
                self.invalidate();
                return Err(diagnostics);
            }
        };
        let can_reuse = self.validated.as_ref().is_some_and(|current| {
            self.simulator.is_some()
                && self.compiled.is_some()
                && active_closure_unchanged(current, &validated, &self.active_circuit_id)
        });
        if can_reuse {
            self.project = project;
            self.validated = Some(validated);
            let flat = self
                .simulator
                .as_ref()
                .expect("reusable runtime has a simulator")
                .snapshot();
            self.snapshot = Some(self.project_snapshot(&flat));
            return Ok(self
                .snapshot
                .clone()
                .expect("reused runtime has a snapshot"));
        }
        let can_settle = self.validated.as_ref().is_some_and(|current| {
            self.simulator.is_some()
                && self.compiled.is_some()
                && active_shape_unchanged(current, &validated, &self.active_circuit_id)
        });
        if can_settle {
            let updates = source_updates(
                &self.project,
                &project,
                self.compiled
                    .as_ref()
                    .expect("settleable runtime has compiled provenance"),
            );
            let flat = if updates.is_empty() {
                self.simulator
                    .as_ref()
                    .expect("settleable runtime has a simulator")
                    .snapshot()
            } else {
                self.simulator
                    .as_mut()
                    .expect("settleable runtime has a simulator")
                    .set_sources(updates)
                    .map_err(|diagnostic| {
                        vec![project_error(&diagnostic.code, &diagnostic.message, None)]
                    })?
            };
            self.project = project;
            self.validated = Some(validated);
            self.snapshot = Some(self.project_snapshot(&flat));
            return Ok(self
                .snapshot
                .clone()
                .expect("settled runtime has a snapshot"));
        }
        self.project = project;
        self.invalidate();
        self.install_validated(validated)?;
        Ok(self
            .snapshot
            .clone()
            .expect("successful rebuild has a snapshot"))
    }

    pub fn update_project_v3(
        &mut self,
        project: ProjectDocumentV3,
    ) -> Result<ProjectSnapshot, Vec<ProjectDiagnostic>> {
        if self.project_v3.is_none() {
            return Err(vec![project_error(
                "PROJECT_VERSION_MISMATCH",
                "a v3 project cannot update a v2 project simulator",
                None,
            )]);
        }
        let compiled_v3 = compile_project_v3(project.clone(), &self.active_circuit_id)?;
        let compiled = compiled_v3.compiled.clone();
        let can_reuse = self.simulator.is_some()
            && self.compiled.as_ref().is_some_and(|current| {
                flat_circuit_shape(&current.circuit) == flat_circuit_shape(&compiled.circuit)
            });
        if can_reuse {
            let updates = source_updates(&self.project, &compiled_v3.lowered.project, &compiled);
            let flat = if updates.is_empty() {
                self.simulator
                    .as_ref()
                    .expect("reusable v3 runtime has a simulator")
                    .snapshot()
            } else {
                self.simulator
                    .as_mut()
                    .expect("reusable v3 runtime has a simulator")
                    .set_sources(updates)
                    .map_err(|diagnostic| {
                        vec![remap_v3_diagnostic(
                            project_flat_diagnostic(
                                &diagnostic,
                                &compiled,
                                &FlatNetworkIndex::new(&compiled),
                            ),
                            &compiled_v3,
                        )]
                    })?
            };
            self.project = compiled_v3.lowered.project.clone();
            self.project_v3 = Some(project);
            self.validated = None;
            self.compiled = Some(compiled);
            self.compiled_v3 = Some(compiled_v3);
            self.snapshot = Some(self.project_snapshot(&flat));
            return Ok(self
                .snapshot
                .clone()
                .expect("reused v3 runtime has a snapshot"));
        }
        let network_index = FlatNetworkIndex::new(&compiled);
        let simulator = Simulator::load(compiled.circuit.clone()).map_err(|diagnostics| {
            diagnostics
                .iter()
                .map(|diagnostic| {
                    remap_v3_diagnostic(
                        project_flat_diagnostic(diagnostic, &compiled, &network_index),
                        &compiled_v3,
                    )
                })
                .collect::<Vec<_>>()
        })?;
        let flat = simulator.snapshot();

        self.project = compiled_v3.lowered.project.clone();
        self.project_v3 = Some(project);
        self.validated = None;
        self.compiled = Some(compiled);
        self.compiled_v3 = Some(compiled_v3);
        self.simulator = Some(simulator);
        self.compile_count += 1;
        self.snapshot = Some(self.project_snapshot(&flat));
        Ok(self
            .snapshot
            .clone()
            .expect("successful v3 rebuild has a snapshot"))
    }

    pub fn switch_active(
        &mut self,
        active_circuit_id: &str,
    ) -> Result<ProjectSnapshot, Vec<ProjectDiagnostic>> {
        if let Some(project) = self.project_v3.clone() {
            return self.switch_active_v3(project, active_circuit_id);
        }
        let validated = match &self.validated {
            Some(validated) => validated.clone(),
            None => validate_project(self.project.clone())?,
        };
        let compiled = compile_project(&validated, active_circuit_id)?;
        let network_index = FlatNetworkIndex::new(&compiled);
        let simulator = Simulator::load(compiled.circuit.clone()).map_err(|diagnostics| {
            diagnostics
                .iter()
                .map(|diagnostic| project_flat_diagnostic(diagnostic, &compiled, &network_index))
                .collect::<Vec<_>>()
        })?;
        let flat = simulator.snapshot();
        self.active_circuit_id = active_circuit_id.to_owned();
        self.compile_count += 1;
        self.validated = Some(validated);
        self.compiled = Some(compiled);
        self.simulator = Some(simulator);
        self.snapshot = Some(self.project_snapshot(&flat));
        Ok(self
            .snapshot
            .clone()
            .expect("successful rebuild has a snapshot"))
    }

    fn switch_active_v3(
        &mut self,
        project: ProjectDocumentV3,
        active_circuit_id: &str,
    ) -> Result<ProjectSnapshot, Vec<ProjectDiagnostic>> {
        let compiled_v3 = compile_project_v3(project, active_circuit_id)?;
        let compiled = compiled_v3.compiled.clone();
        let network_index = FlatNetworkIndex::new(&compiled);
        let simulator = Simulator::load(compiled.circuit.clone()).map_err(|diagnostics| {
            diagnostics
                .iter()
                .map(|diagnostic| {
                    remap_v3_diagnostic(
                        project_flat_diagnostic(diagnostic, &compiled, &network_index),
                        &compiled_v3,
                    )
                })
                .collect::<Vec<_>>()
        })?;
        let flat = simulator.snapshot();
        self.project = compiled_v3.lowered.project.clone();
        self.active_circuit_id = active_circuit_id.to_owned();
        self.compile_count += 1;
        self.validated = None;
        self.compiled = Some(compiled);
        self.compiled_v3 = Some(compiled_v3);
        self.simulator = Some(simulator);
        self.snapshot = Some(self.project_snapshot(&flat));
        Ok(self
            .snapshot
            .clone()
            .expect("successful v3 active switch has a snapshot"))
    }

    #[allow(clippy::result_large_err)]
    pub fn set_source(
        &mut self,
        circuit_id: &str,
        component_id: &str,
        value: Trit,
    ) -> Result<ProjectSnapshot, ProjectDiagnostic> {
        if self.project_v3.is_some() {
            return Err(project_error(
                "PROJECT_VERSION_MISMATCH",
                "scalar source updates are not supported by a v3 project simulator",
                None,
            ));
        }
        if self.simulator.is_none() || self.compiled.is_none() {
            return Err(project_error(
                "PROJECT_NOT_READY",
                "project simulation is unavailable until validation succeeds",
                None,
            ));
        }
        if !value.is_known() {
            return Err(project_error(
                "INVALID_SOURCE_UPDATE",
                "project sources require a known T, 0, or 1 value",
                Some(QualifiedComponentRef::new(
                    circuit_id,
                    [] as [&str; 0],
                    component_id,
                )),
            ));
        }

        let Some(circuit) = self
            .project
            .circuits
            .iter()
            .find(|circuit| circuit.id == circuit_id)
        else {
            return Err(invalid_source(circuit_id, component_id));
        };
        let Some(component) = circuit
            .components
            .iter()
            .find(|component| component.id == component_id)
        else {
            return Err(invalid_source(circuit_id, component_id));
        };
        let property = match component.type_id.as_str() {
            "source.trit_input" | "source.constant" => "value",
            "project.module_input" => "previewValue",
            _ => return Err(invalid_source(circuit_id, component_id)),
        };

        let copies: Vec<_> = self
            .compiled
            .as_ref()
            .expect("ready project has compiled provenance")
            .provenance
            .source_copies
            .iter()
            .filter(|(reference, _)| {
                reference.circuit_id == circuit_id && reference.component_id == component_id
            })
            .flat_map(|(_, copies)| copies.iter().cloned())
            .collect();
        if !copies.is_empty() {
            let flat = self
                .simulator
                .as_mut()
                .expect("ready project has a flat simulator")
                .set_sources(copies.into_iter().map(|copy| (copy, value)))
                .map_err(|diagnostic| project_error(&diagnostic.code, &diagnostic.message, None))?;
            self.set_project_source_value(circuit_id, component_id, property, value);
            self.snapshot = Some(self.project_snapshot(&flat));
        } else {
            self.set_project_source_value(circuit_id, component_id, property, value);
        }
        Ok(self.snapshot.clone().expect("ready project has a snapshot"))
    }

    #[allow(clippy::result_large_err)]
    pub fn set_source_word(
        &mut self,
        circuit_id: &str,
        component_id: &str,
        value: &str,
    ) -> Result<ProjectSnapshot, ProjectDiagnostic> {
        let Some(project) = self.project_v3.as_ref() else {
            return Err(project_error(
                "PROJECT_VERSION_MISMATCH",
                "word source updates require a v3 project simulator",
                None,
            ));
        };
        let Some(compiled_v3) = self.compiled_v3.as_ref() else {
            return Err(project_error(
                "PROJECT_NOT_READY",
                "project simulation is unavailable until validation succeeds",
                None,
            ));
        };
        let Some(component) = project
            .circuits
            .iter()
            .find(|circuit| circuit.id == circuit_id)
            .and_then(|circuit| {
                circuit
                    .components
                    .iter()
                    .find(|component| component.id == component_id)
            })
        else {
            return Err(invalid_source(circuit_id, component_id));
        };
        let property = match component.type_id.as_str() {
            "source.trit_input" | "source.constant" => "value",
            MODULE_INPUT => "previewValue",
            _ => return Err(invalid_source(circuit_id, component_id)),
        };
        let shape = resolve_project_ports(&component.type_id, &component.properties)
            .map_err(|error| {
                project_error(
                    error.code(),
                    &error.to_string(),
                    Some(QualifiedComponentRef::new(
                        circuit_id,
                        [] as [&str; 0],
                        component_id,
                    )),
                )
            })?
            .first()
            .expect("mutable source has an output port")
            .shape;
        let word = KnownWord::parse(value, shape).map_err(|error| {
            let code = match error {
                SignalError::WidthMismatch { .. } | SignalError::InvalidWidth { .. } => {
                    "INVALID_SIGNAL_WIDTH"
                }
                SignalError::InvalidSymbol { .. } | SignalError::ValueOverflow => {
                    "INVALID_TRIT_SYMBOL"
                }
            };
            project_error(
                code,
                &error.to_string(),
                Some(QualifiedComponentRef::new(
                    circuit_id,
                    [] as [&str; 0],
                    component_id,
                )),
            )
        })?;

        let mut updates = BTreeMap::new();
        for (reference, bits) in &compiled_v3.reassembly.ports {
            if reference.circuit_id != circuit_id
                || reference.component_id != component_id
                || (component.type_id == MODULE_INPUT && !reference.instance_path.is_empty())
            {
                continue;
            }
            for (bit_index, bit) in bits.iter().enumerate() {
                let Some(scalar_port) = &bit.scalar_port else {
                    continue;
                };
                let Some(copies) =
                    compiled_v3
                        .compiled
                        .provenance
                        .source_copies
                        .get(&QualifiedComponentRef::new(
                            &scalar_port.circuit_id,
                            scalar_port.instance_path.iter().cloned(),
                            &scalar_port.component_id,
                        ))
                else {
                    continue;
                };
                for copy in copies {
                    updates.insert(copy.clone(), word.trit(bit_index as u8));
                }
            }
        }

        let flat = if updates.is_empty() {
            self.simulator
                .as_ref()
                .expect("ready v3 project has a simulator")
                .snapshot()
        } else {
            self.simulator
                .as_mut()
                .expect("ready v3 project has a simulator")
                .set_sources(updates)
                .map_err(|diagnostic| {
                    let compiled = self
                        .compiled
                        .as_ref()
                        .expect("ready v3 project has compiled provenance");
                    let network_index = FlatNetworkIndex::new(compiled);
                    remap_v3_diagnostic(
                        project_flat_diagnostic(&diagnostic, compiled, &network_index),
                        self.compiled_v3
                            .as_ref()
                            .expect("ready v3 project has reassembly provenance"),
                    )
                })?
        };
        set_document_source_word_v3(
            self.project_v3
                .as_mut()
                .expect("ready word source belongs to v3 project"),
            circuit_id,
            component_id,
            property,
            value,
        );
        self.snapshot = Some(self.project_snapshot(&flat));
        Ok(self
            .snapshot
            .clone()
            .expect("ready v3 project has a snapshot"))
    }

    #[allow(clippy::result_large_err)]
    pub fn tick(&mut self) -> Result<ProjectSnapshot, ProjectDiagnostic> {
        self.advance_runtime(Simulator::tick)
    }

    #[allow(clippy::result_large_err)]
    pub fn advance_phase(&mut self) -> Result<ProjectSnapshot, ProjectDiagnostic> {
        self.advance_runtime(Simulator::advance_phase)
    }

    #[allow(clippy::result_large_err)]
    fn advance_runtime(
        &mut self,
        advance: fn(&mut Simulator) -> Result<SimulationSnapshot, Diagnostic>,
    ) -> Result<ProjectSnapshot, ProjectDiagnostic> {
        if (self.project_v3.is_none() && self.validated.is_none())
            || self.simulator.is_none()
            || self.compiled.is_none()
        {
            return Err(project_error(
                "PROJECT_NOT_READY",
                "project simulation is unavailable until validation succeeds",
                None,
            ));
        }

        let flat = match advance(
            self.simulator
                .as_mut()
                .expect("ready project has a flat simulator"),
        ) {
            Ok(flat) => flat,
            Err(diagnostic) => {
                let compiled = self
                    .compiled
                    .as_ref()
                    .expect("ready project has compiled provenance");
                let network_index = FlatNetworkIndex::new(compiled);
                let diagnostic = project_flat_diagnostic(&diagnostic, compiled, &network_index);
                return Err(if let Some(compiled_v3) = &self.compiled_v3 {
                    remap_v3_diagnostic(diagnostic, compiled_v3)
                } else {
                    diagnostic
                });
            }
        };
        self.snapshot = Some(self.project_snapshot(&flat));
        Ok(self.snapshot.clone().expect("ready project has a snapshot"))
    }

    pub fn snapshot(&self) -> Option<ProjectSnapshot> {
        self.snapshot.clone()
    }

    pub fn metrics(&self) -> Option<ProjectCompileMetrics> {
        let compiled = self.compiled.as_ref()?;
        let projection_endpoints = compiled
            .projection
            .ports
            .values()
            .chain(compiled.projection.boundaries.values())
            .map(|entry| match entry.direction {
                PortDirection::Input => entry.endpoints.len() + entry.drivers.len(),
                PortDirection::Output => entry.drivers.len(),
                PortDirection::InOut => {
                    unreachable!("compile-time inout port reached scalar project metrics")
                }
            })
            .sum();
        Some(ProjectCompileMetrics {
            expanded_components: compiled.circuit.components.len(),
            expanded_connections: compiled.circuit.connections.len(),
            projection_endpoints,
        })
    }

    fn rebuild(&mut self) -> Result<(), Vec<ProjectDiagnostic>> {
        let validated = match validate_project(self.project.clone()) {
            Ok(validated) => validated,
            Err(diagnostics) => {
                self.invalidate();
                return Err(diagnostics);
            }
        };
        self.install_validated(validated)
    }

    fn install_validated(
        &mut self,
        validated: ValidatedProject,
    ) -> Result<(), Vec<ProjectDiagnostic>> {
        let compiled = match compile_project(&validated, &self.active_circuit_id) {
            Ok(compiled) => compiled,
            Err(diagnostics) => {
                self.invalidate();
                return Err(diagnostics);
            }
        };
        let simulator = match Simulator::load(compiled.circuit.clone()) {
            Ok(simulator) => simulator,
            Err(diagnostics) => {
                let network_index = FlatNetworkIndex::new(&compiled);
                let projected = diagnostics
                    .iter()
                    .map(|diagnostic| {
                        project_flat_diagnostic(diagnostic, &compiled, &network_index)
                    })
                    .collect();
                self.invalidate();
                return Err(projected);
            }
        };
        self.compile_count += 1;
        let flat = simulator.snapshot();
        self.validated = Some(validated);
        self.compiled = Some(compiled);
        self.project_v3 = None;
        self.compiled_v3 = None;
        self.simulator = Some(simulator);
        self.snapshot = Some(self.project_snapshot(&flat));
        Ok(())
    }

    fn set_project_source_value(
        &mut self,
        circuit_id: &str,
        component_id: &str,
        property: &str,
        value: Trit,
    ) {
        let component = self
            .project
            .circuits
            .iter()
            .find(|circuit| circuit.id == circuit_id)
            .and_then(|circuit| {
                circuit
                    .components
                    .iter()
                    .find(|component| component.id == component_id)
            });
        debug_assert!(component.is_some(), "validated mutable source still exists");
        set_document_source_value(&mut self.project, circuit_id, component_id, property, value);
        if let Some(validated) = &mut self.validated {
            set_document_source_value(
                &mut validated.project,
                circuit_id,
                component_id,
                property,
                value,
            );
        }
    }

    fn invalidate(&mut self) {
        self.validated = None;
        self.compiled = None;
        self.compiled_v3 = None;
        self.simulator = None;
        self.snapshot = None;
    }

    fn project_snapshot(&self, flat: &SimulationSnapshot) -> ProjectSnapshot {
        if self.compiled_v3.is_some() {
            return self.project_snapshot_v3(flat);
        }
        self.project_snapshot_v2(flat)
    }

    fn project_snapshot_v2(&self, flat: &SimulationSnapshot) -> ProjectSnapshot {
        let compiled = self
            .compiled
            .as_ref()
            .expect("project snapshot requires compiled projection");
        let mut component_outputs: BTreeMap<String, BTreeMap<String, Trit>> = BTreeMap::new();
        let mut input_nets: BTreeMap<String, BTreeMap<String, Trit>> = BTreeMap::new();
        let mut component_output_words = BTreeMap::new();
        let mut input_net_words = BTreeMap::new();
        for (reference, entry) in &compiled.projection.ports {
            let value = projected_driver_value(flat, &entry.drivers);
            let target = match entry.direction {
                PortDirection::Input => &mut input_nets,
                PortDirection::Output => &mut component_outputs,
                PortDirection::InOut => {
                    unreachable!("compile-time inout port reached scalar project snapshot")
                }
            };
            target
                .entry(reference.component_id.clone())
                .or_default()
                .insert(reference.port_id.clone(), value);
            let word_target = match entry.direction {
                PortDirection::Input => &mut input_net_words,
                PortDirection::Output => &mut component_output_words,
                PortDirection::InOut => unreachable!(),
            };
            word_target
                .entry(reference.component_id.clone())
                .or_insert_with(BTreeMap::new)
                .insert(reference.port_id.clone(), scalar_word(value));
        }

        let mut diagnostics = ProjectDiagnosticSet::new();
        let network_index = FlatNetworkIndex::new(compiled);
        if let Some(validated) = &self.validated {
            for warning in &validated.warnings {
                diagnostics.insert(warning.clone());
            }
        }
        let boundary_conflicts = self.boundary_conflicts(flat, compiled);
        for conflict in &boundary_conflicts {
            diagnostics.insert(conflict.diagnostic.clone());
        }
        for diagnostic in &flat.diagnostics {
            if !target_conflict_is_covered(diagnostic, &network_index, &boundary_conflicts) {
                diagnostics.insert(project_flat_diagnostic(
                    diagnostic,
                    compiled,
                    &network_index,
                ));
            }
        }
        ProjectSnapshot {
            component_outputs,
            input_nets,
            component_output_words,
            input_net_words,
            diagnostics: diagnostics.into_vec(),
            stable: flat.stable,
            tick_count: flat.tick_count,
            clock_phase: flat.clock_phase,
            compile_count: self.compile_count,
        }
    }

    fn project_snapshot_v3(&self, flat: &SimulationSnapshot) -> ProjectSnapshot {
        let compiled_v3 = self
            .compiled_v3
            .as_ref()
            .expect("v3 snapshot requires reassembly metadata");
        let project = self
            .project_v3
            .as_ref()
            .expect("v3 snapshot requires its source document");
        let active = project
            .circuits
            .iter()
            .find(|circuit| circuit.id == self.active_circuit_id)
            .expect("compiled active v3 circuit still exists");
        let mut component_outputs = BTreeMap::new();
        let mut input_nets = BTreeMap::new();
        let mut component_output_words = BTreeMap::new();
        let mut input_net_words = BTreeMap::new();

        for component in &active.components {
            for port in resolved_v3_component_ports(project, component) {
                let reference =
                    QualifiedPortRef::new(&active.id, [] as [&str; 0], &component.id, &port.id);
                let Some(bits) = compiled_v3.reassembly.ports.get(&reference) else {
                    continue;
                };
                let trits = bits
                    .iter()
                    .map(|bit| {
                        let values = compiled_v3
                            .reassembly
                            .observable_endpoints(bit)
                            .iter()
                            .map(|endpoint| {
                                flat.input_value(&endpoint.component_id, &endpoint.port_id)
                                    .or_else(|| {
                                        flat.output_value(&endpoint.component_id, &endpoint.port_id)
                                    })
                                    .unwrap_or(Trit::HighZ)
                            })
                            .collect::<Vec<_>>();
                        resolve_drivers(&values)
                    })
                    .collect::<Vec<_>>();
                let word = WordValue::new(port.shape, trits)
                    .expect("v3 reassembly has one runtime trit per declared bit");
                let (word_target, scalar_target) = match port.direction {
                    PortDirection::Output => {
                        (&mut component_output_words, Some(&mut component_outputs))
                    }
                    PortDirection::Input | PortDirection::InOut => {
                        (&mut input_net_words, Some(&mut input_nets))
                    }
                };
                if port.shape.width() == 1 {
                    scalar_target
                        .expect("v3 scalar projection target exists")
                        .entry(component.id.clone())
                        .or_insert_with(BTreeMap::new)
                        .insert(port.id.clone(), word.trit(0));
                }
                word_target
                    .entry(component.id.clone())
                    .or_insert_with(BTreeMap::new)
                    .insert(port.id, word);
            }
        }

        let compiled = &compiled_v3.compiled;
        let network_index = FlatNetworkIndex::new(compiled);
        let mut diagnostics = ProjectDiagnosticSet::new();
        let boundary_conflicts = self.boundary_conflicts(flat, compiled);
        for conflict in &boundary_conflicts {
            diagnostics.insert(remap_v3_diagnostic(
                conflict.diagnostic.clone(),
                compiled_v3,
            ));
        }
        for diagnostic in &flat.diagnostics {
            if !target_conflict_is_covered(diagnostic, &network_index, &boundary_conflicts) {
                diagnostics.insert(remap_v3_diagnostic(
                    project_flat_diagnostic(diagnostic, compiled, &network_index),
                    compiled_v3,
                ));
            }
        }
        ProjectSnapshot {
            component_outputs,
            input_nets,
            component_output_words,
            input_net_words,
            diagnostics: diagnostics.into_vec(),
            stable: flat.stable,
            tick_count: flat.tick_count,
            clock_phase: flat.clock_phase,
            compile_count: self.compile_count,
        }
    }

    fn boundary_conflicts(
        &self,
        flat: &SimulationSnapshot,
        compiled: &CompiledProject,
    ) -> Vec<BoundaryConflict> {
        let mut conflicts: Vec<_> = compiled
            .projection
            .boundaries
            .iter()
            .filter_map(|(reference, entry)| {
                let values = driver_values(flat, &entry.drivers);
                let known: BTreeSet<_> = values
                    .iter()
                    .copied()
                    .filter(|value| value.is_known())
                    .collect();
                if known.len() < 2 || resolve_drivers(&values) != Trit::Error {
                    return None;
                }
                let mut component_refs = BTreeSet::from([QualifiedComponentRef::new(
                    &reference.circuit_id,
                    reference.instance_path.iter().cloned(),
                    &reference.component_id,
                )]);
                for driver in &entry.drivers {
                    if let Some(driver_ref) =
                        compiled.provenance.components.get(&driver.component_id)
                    {
                        component_refs.insert(driver_ref.clone());
                    }
                }
                Some(BoundaryConflict {
                    id: BoundaryPortNetId(reference.clone()),
                    drivers: entry.drivers.iter().cloned().collect(),
                    consumers: entry.endpoints.iter().cloned().map(TargetNetId).collect(),
                    upstream_boundaries: entry
                        .upstream_boundaries
                        .iter()
                        .cloned()
                        .map(BoundaryPortNetId)
                        .collect(),
                    direct_drivers: entry.direct_drivers.iter().cloned().collect(),
                    diagnostic: ProjectDiagnostic {
                        code: "MULTIPLE_DRIVER_CONFLICT".into(),
                        severity: Severity::Error,
                        message: format!(
                            "module port '{}.{}' has differing known drivers",
                            reference.component_id, reference.port_id
                        ),
                        primary_location: Some(ProjectLocation::Port(reference.clone())),
                        component_refs: component_refs.into_iter().collect(),
                        connection_refs: Vec::new(),
                        port_refs: vec![reference.clone()],
                    },
                })
            })
            .collect();
        conflicts.sort_by(|left, right| left.id.cmp(&right.id));
        let by_id: BTreeMap<_, _> = conflicts
            .iter()
            .map(|conflict| (conflict.id.clone(), conflict))
            .collect();
        conflicts
            .iter()
            .filter(|conflict| boundary_representative(conflict, &by_id) == conflict.id)
            .map(|conflict| BoundaryConflict {
                id: conflict.id.clone(),
                drivers: conflict.drivers.clone(),
                consumers: conflict.consumers.clone(),
                upstream_boundaries: conflict.upstream_boundaries.clone(),
                direct_drivers: conflict.direct_drivers.clone(),
                diagnostic: conflict.diagnostic.clone(),
            })
            .collect()
    }
}

struct BoundaryConflict {
    id: BoundaryPortNetId,
    drivers: BTreeSet<FlatPortRef>,
    consumers: BTreeSet<TargetNetId>,
    upstream_boundaries: Vec<BoundaryPortNetId>,
    direct_drivers: BTreeSet<FlatPortRef>,
    diagnostic: ProjectDiagnostic,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct TargetNetId(FlatPortRef);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct BoundaryPortNetId(QualifiedPortRef);

struct FlatNetworkIndex {
    connection_targets: BTreeMap<String, TargetNetId>,
    target_drivers: BTreeMap<TargetNetId, BTreeSet<FlatPortRef>>,
}

impl FlatNetworkIndex {
    fn new(compiled: &CompiledProject) -> Self {
        let mut connection_targets = BTreeMap::new();
        let mut target_drivers: BTreeMap<TargetNetId, BTreeSet<FlatPortRef>> = BTreeMap::new();
        for connection in &compiled.circuit.connections {
            let target = TargetNetId(FlatPortRef {
                component_id: connection.target_component_id.clone(),
                port_id: connection.target_port_id.clone(),
            });
            connection_targets.insert(connection.id.clone(), target.clone());
            target_drivers
                .entry(target)
                .or_default()
                .insert(FlatPortRef {
                    component_id: connection.source_component_id.clone(),
                    port_id: connection.source_port_id.clone(),
                });
        }
        Self {
            connection_targets,
            target_drivers,
        }
    }

    fn target_for(&self, connection_ids: &[String]) -> Option<&TargetNetId> {
        connection_ids
            .iter()
            .find_map(|connection_id| self.connection_targets.get(connection_id))
    }
}

fn boundary_representative(
    start: &BoundaryConflict,
    conflicts: &BTreeMap<BoundaryPortNetId, &BoundaryConflict>,
) -> BoundaryPortNetId {
    let mut path = Vec::new();
    let mut positions = BTreeMap::new();
    let mut current = start;
    loop {
        if let Some(&cycle_start) = positions.get(&current.id) {
            return path[cycle_start..]
                .iter()
                .min()
                .cloned()
                .expect("boundary cycle contains at least one node");
        }
        positions.insert(current.id.clone(), path.len());
        path.push(current.id.clone());
        if !current.direct_drivers.is_empty() || current.upstream_boundaries.len() != 1 {
            return current.id.clone();
        }
        let Some(upstream) = conflicts.get(&current.upstream_boundaries[0]) else {
            return current.id.clone();
        };
        if upstream.drivers != current.drivers {
            return current.id.clone();
        }
        current = upstream;
    }
}

fn projected_driver_value(flat: &SimulationSnapshot, drivers: &[FlatPortRef]) -> Trit {
    resolve_drivers(&driver_values(flat, drivers))
}

fn driver_values(flat: &SimulationSnapshot, drivers: &[FlatPortRef]) -> Vec<Trit> {
    drivers
        .iter()
        .map(|driver| {
            flat.output_value(&driver.component_id, &driver.port_id)
                .unwrap_or(Trit::HighZ)
        })
        .collect()
}

fn target_conflict_is_covered(
    diagnostic: &Diagnostic,
    network_index: &FlatNetworkIndex,
    boundary_conflicts: &[BoundaryConflict],
) -> bool {
    if diagnostic.code != "MULTIPLE_DRIVER_CONFLICT" {
        return false;
    }
    let Some(target) = network_index.target_for(&diagnostic.connection_ids) else {
        return false;
    };
    let Some(target_drivers) = network_index.target_drivers.get(target) else {
        return false;
    };
    boundary_conflicts
        .iter()
        .any(|conflict| conflict.consumers.contains(target) && conflict.drivers == *target_drivers)
}

fn project_flat_diagnostic(
    diagnostic: &Diagnostic,
    compiled: &CompiledProject,
    network_index: &FlatNetworkIndex,
) -> ProjectDiagnostic {
    let mut component_refs = BTreeSet::new();
    for component_id in &diagnostic.component_ids {
        if let Some(reference) = compiled.provenance.components.get(component_id) {
            component_refs.insert(reference.clone());
        }
    }
    let mut connection_refs = BTreeSet::<QualifiedConnectionRef>::new();
    for connection_id in &diagnostic.connection_ids {
        if let Some(references) = compiled.provenance.connections.get(connection_id) {
            connection_refs.extend(references.iter().cloned());
        }
    }
    let mut port_refs = BTreeSet::new();
    if diagnostic.component_ids.len() == 1 && diagnostic.port_ids.len() == 1 {
        if let Some(component) = compiled
            .provenance
            .components
            .get(&diagnostic.component_ids[0])
        {
            port_refs.insert(QualifiedPortRef::new(
                &component.circuit_id,
                component.instance_path.iter().cloned(),
                &component.component_id,
                &diagnostic.port_ids[0],
            ));
        }
    } else if diagnostic.code == "MULTIPLE_DRIVER_CONFLICT"
        && let Some(target) = network_index.target_for(&diagnostic.connection_ids)
        && let Some(component) = compiled.provenance.components.get(&target.0.component_id)
    {
        port_refs.insert(QualifiedPortRef::new(
            &component.circuit_id,
            component.instance_path.iter().cloned(),
            &component.component_id,
            &target.0.port_id,
        ));
    }
    let component_refs: Vec<_> = component_refs.into_iter().collect();
    let connection_refs: Vec<_> = connection_refs.into_iter().collect();
    let port_refs: Vec<_> = port_refs.into_iter().collect();
    let primary_location = port_refs
        .first()
        .cloned()
        .map(ProjectLocation::Port)
        .or_else(|| {
            component_refs
                .first()
                .cloned()
                .map(ProjectLocation::Component)
        })
        .or_else(|| {
            connection_refs
                .first()
                .cloned()
                .map(ProjectLocation::Connection)
        });
    let message = match diagnostic.code.as_str() {
        "MULTIPLE_DRIVER_CONFLICT" => "input has differing known drivers".into(),
        "UNDRIVEN_INPUT" => "input has no connected driver".into(),
        "NON_CONVERGENT_COMBINATIONAL_LOOP" => "combinational feedback did not converge".into(),
        _ => diagnostic.message.clone(),
    };
    ProjectDiagnostic {
        code: diagnostic.code.clone(),
        severity: diagnostic.severity,
        message,
        primary_location,
        component_refs,
        connection_refs,
        port_refs,
    }
}

fn active_closure_unchanged(
    current: &ValidatedProject,
    next: &ValidatedProject,
    active_circuit_id: &str,
) -> bool {
    let current_ids = reachable_circuits(current, active_circuit_id);
    let next_ids = reachable_circuits(next, active_circuit_id);
    if current_ids.is_none() || current_ids != next_ids {
        return false;
    }
    let ids = current_ids.expect("checked reachable circuit set");
    let current_circuits: BTreeMap<_, _> = current
        .project
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect();
    let next_circuits: BTreeMap<_, _> = next
        .project
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect();
    ids.iter()
        .all(|id| current_circuits.get(id.as_str()) == next_circuits.get(id.as_str()))
}

fn active_shape_unchanged(
    current: &ValidatedProject,
    next: &ValidatedProject,
    active_circuit_id: &str,
) -> bool {
    let current_ids = reachable_circuits(current, active_circuit_id);
    let next_ids = reachable_circuits(next, active_circuit_id);
    if current_ids.is_none() || current_ids != next_ids {
        return false;
    }
    let ids = current_ids.expect("checked reachable circuit set");
    let current_circuits: BTreeMap<_, _> = current
        .project
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect();
    let next_circuits: BTreeMap<_, _> = next
        .project
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect();
    ids.iter().all(|id| {
        current_circuits
            .get(id.as_str())
            .zip(next_circuits.get(id.as_str()))
            .is_some_and(|(current, next)| circuit_shape(current) == circuit_shape(next))
    })
}

type ComponentShape = (String, String, Option<String>, Option<String>, u8);
type ConnectionShape = (String, String, String, String, String);

fn flat_circuit_shape(
    circuit: &crate::circuit::CircuitDefinition,
) -> (Vec<(String, String)>, Vec<ConnectionShape>) {
    let mut components = circuit
        .components
        .iter()
        .map(|component| (component.id.clone(), component.type_id.clone()))
        .collect::<Vec<_>>();
    components.sort();
    let mut connections = circuit
        .connections
        .iter()
        .map(|connection| {
            (
                connection.id.clone(),
                connection.source_component_id.clone(),
                connection.source_port_id.clone(),
                connection.target_component_id.clone(),
                connection.target_port_id.clone(),
            )
        })
        .collect::<Vec<_>>();
    connections.sort();
    (components, connections)
}

fn circuit_shape(circuit: &ProjectCircuit) -> (Vec<ComponentShape>, Vec<ConnectionShape>) {
    let mut components: Vec<_> = circuit
        .components
        .iter()
        .map(|component| {
            (
                component.id.clone(),
                component.type_id.clone(),
                component.properties.module_id().map(str::to_owned),
                component.properties.port_id().map(str::to_owned),
                component
                    .properties
                    .get("width")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|width| u8::try_from(width).ok())
                    .unwrap_or(1),
            )
        })
        .collect();
    components.sort();
    let mut connections: Vec<_> = circuit
        .connections
        .iter()
        .map(|connection| {
            (
                connection.id.clone(),
                connection.source_component_id.clone(),
                connection.source_port_id.clone(),
                connection.target_component_id.clone(),
                connection.target_port_id.clone(),
            )
        })
        .collect();
    connections.sort();
    (components, connections)
}

fn source_updates(
    current: &ProjectDocument,
    next: &ProjectDocument,
    compiled: &CompiledProject,
) -> Vec<(String, Trit)> {
    let current_circuits: BTreeMap<_, _> = current
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect();
    let mut updates = BTreeMap::new();
    for next_circuit in &next.circuits {
        let Some(current_circuit) = current_circuits.get(next_circuit.id.as_str()) else {
            continue;
        };
        let current_components: BTreeMap<_, _> = current_circuit
            .components
            .iter()
            .map(|component| (component.id.as_str(), component))
            .collect();
        for next_component in &next_circuit.components {
            let Some(current_component) = current_components.get(next_component.id.as_str()) else {
                continue;
            };
            let Some(next_value) = source_value(next_component) else {
                continue;
            };
            if source_value(current_component) == Some(next_value) {
                continue;
            }
            for (reference, copies) in &compiled.provenance.source_copies {
                if reference.circuit_id == next_circuit.id
                    && reference.component_id == next_component.id
                {
                    for copy in copies {
                        updates.insert(copy.clone(), next_value);
                    }
                }
            }
        }
    }
    updates.into_iter().collect()
}

fn source_value(component: &crate::project::ProjectComponent) -> Option<Trit> {
    match component.type_id.as_str() {
        "source.trit_input" | "source.constant" => {
            Some(component.properties.known_value().unwrap_or(Trit::Zero))
        }
        MODULE_INPUT => Some(component.properties.preview_value().unwrap_or(Trit::Zero)),
        _ => None,
    }
}

fn set_document_source_value(
    project: &mut ProjectDocument,
    circuit_id: &str,
    component_id: &str,
    property: &str,
    value: Trit,
) {
    project
        .circuits
        .iter_mut()
        .find(|circuit| circuit.id == circuit_id)
        .and_then(|circuit| {
            circuit
                .components
                .iter_mut()
                .find(|component| component.id == component_id)
        })
        .expect("validated mutable source still exists")
        .properties
        .set_known_value(property, value);
}

fn set_document_source_word_v3(
    project: &mut ProjectDocumentV3,
    circuit_id: &str,
    component_id: &str,
    property: &str,
    value: &str,
) {
    project
        .circuits
        .iter_mut()
        .find(|circuit| circuit.id == circuit_id)
        .and_then(|circuit| {
            circuit
                .components
                .iter_mut()
                .find(|component| component.id == component_id)
        })
        .expect("validated mutable v3 source still exists")
        .properties
        .set_known_word(property, value);
}

fn scalar_word(value: Trit) -> WordValue {
    WordValue::new(
        SignalShape::new(1).expect("scalar signals have width one"),
        vec![value],
    )
    .expect("one trit matches scalar shape")
}

fn resolved_v3_component_ports(
    project: &ProjectDocumentV3,
    component: &crate::project::ProjectComponent,
) -> Vec<crate::project_validation::ResolvedProjectPort> {
    if component.type_id != "project.module_instance" {
        return resolve_project_ports(&component.type_id, &component.properties)
            .unwrap_or_default();
    }
    let Some(module_id) = component.properties.module_id() else {
        return Vec::new();
    };
    let Some(module) = project
        .circuits
        .iter()
        .find(|circuit| circuit.id == module_id)
    else {
        return Vec::new();
    };
    let mut ports = module
        .components
        .iter()
        .filter_map(|boundary| {
            let direction = match boundary.type_id.as_str() {
                "project.module_input" => PortDirection::Input,
                "project.module_output" => PortDirection::Output,
                _ => return None,
            };
            let id = boundary.properties.port_id()?.to_owned();
            let shape = resolve_project_ports(&boundary.type_id, &boundary.properties)
                .ok()?
                .first()?
                .shape;
            Some(crate::project_validation::ResolvedProjectPort {
                id,
                direction,
                shape,
            })
        })
        .collect::<Vec<_>>();
    ports.sort_by(|left, right| left.id.cmp(&right.id));
    ports
}

fn remap_v3_diagnostic(
    diagnostic: ProjectDiagnostic,
    compiled_v3: &CompiledProjectV3,
) -> ProjectDiagnostic {
    let component_refs = diagnostic
        .component_refs
        .iter()
        .map(|reference| remap_v3_component_ref(reference, compiled_v3))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let port_refs = diagnostic
        .port_refs
        .iter()
        .map(|reference| {
            let component = remap_v3_component_ref(
                &QualifiedComponentRef::new(
                    &reference.circuit_id,
                    reference.instance_path.iter().cloned(),
                    &reference.component_id,
                ),
                compiled_v3,
            );
            QualifiedPortRef::new(
                component.circuit_id,
                component.instance_path,
                component.component_id,
                &reference.port_id,
            )
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let connection_refs = diagnostic
        .connection_refs
        .iter()
        .flat_map(|reference| {
            let static_ref = QualifiedConnectionRef::new(
                &reference.circuit_id,
                [] as [&str; 0],
                &reference.connection_id,
            );
            compiled_v3
                .lowered
                .provenance
                .connections
                .get(&static_ref)
                .cloned()
                .unwrap_or_else(|| vec![static_ref])
                .into_iter()
                .map(|wire| {
                    QualifiedConnectionRef::new(
                        wire.circuit_id,
                        reference.instance_path.iter().cloned(),
                        wire.connection_id,
                    )
                })
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let primary_location = port_refs
        .first()
        .cloned()
        .map(ProjectLocation::Port)
        .or_else(|| {
            component_refs
                .first()
                .cloned()
                .map(ProjectLocation::Component)
        })
        .or_else(|| {
            connection_refs
                .first()
                .cloned()
                .map(ProjectLocation::Connection)
        });
    ProjectDiagnostic {
        primary_location,
        component_refs,
        connection_refs,
        port_refs,
        ..diagnostic
    }
}

fn remap_v3_component_ref(
    reference: &QualifiedComponentRef,
    compiled_v3: &CompiledProjectV3,
) -> QualifiedComponentRef {
    let static_ref = QualifiedComponentRef::new(
        &reference.circuit_id,
        [] as [&str; 0],
        &reference.component_id,
    );
    let original = compiled_v3
        .lowered
        .provenance
        .components
        .get(&static_ref)
        .unwrap_or(&static_ref);
    QualifiedComponentRef::new(
        &original.circuit_id,
        reference.instance_path.iter().cloned(),
        &original.component_id,
    )
}

fn reachable_circuits(
    project: &ValidatedProject,
    active_circuit_id: &str,
) -> Option<BTreeSet<String>> {
    project.dependencies.get(active_circuit_id)?;
    let mut reachable = BTreeSet::from([active_circuit_id.to_owned()]);
    let mut stack = vec![active_circuit_id.to_owned()];
    while let Some(circuit_id) = stack.pop() {
        for dependency in project.dependencies.get(&circuit_id)? {
            if reachable.insert(dependency.clone()) {
                stack.push(dependency.clone());
            }
        }
    }
    Some(reachable)
}

fn invalid_source(circuit_id: &str, component_id: &str) -> ProjectDiagnostic {
    project_error(
        "INVALID_SOURCE_UPDATE",
        "component is not a mutable project source",
        Some(QualifiedComponentRef::new(
            circuit_id,
            [] as [&str; 0],
            component_id,
        )),
    )
}

fn project_error(
    code: &str,
    message: &str,
    location: Option<QualifiedComponentRef>,
) -> ProjectDiagnostic {
    ProjectDiagnostic {
        code: code.into(),
        severity: Severity::Error,
        message: message.into(),
        primary_location: location.clone().map(ProjectLocation::Component),
        component_refs: location.into_iter().collect(),
        connection_refs: Vec::new(),
        port_refs: Vec::new(),
    }
}
