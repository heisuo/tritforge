use std::cell::Cell;
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
use crate::structural::{
    StructuralExpansionInspection, StructuralPrimitiveInspection, register_lane_index,
};
use crate::trace::{
    MAX_TRACE_WATCHES, TraceBinding, TraceFrame, TraceFrameReason, TracePerformanceCounters,
    TraceRecorder, TraceValue, TraceWatch,
};
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

struct SourceUpdateOutcome {
    snapshot: ProjectSnapshot,
    runtime_changed: bool,
}

pub struct ProjectSimulator {
    project: ProjectDocument,
    project_v3: Option<ProjectDocumentV3>,
    active_circuit_id: String,
    validated: Option<ValidatedProject>,
    compiled: Option<CompiledProject>,
    compiled_v3: Option<CompiledProjectV3>,
    v3_boundary_port_origins: BTreeMap<QualifiedPortRef, QualifiedPortRef>,
    network_index: Option<FlatNetworkIndex>,
    simulator: Option<Simulator>,
    snapshot: Option<ProjectSnapshot>,
    compile_count: u64,
    trace: TraceRecorder,
    trace_diagnostics: Vec<ProjectDiagnostic>,
    trace_performance: Cell<TracePerformanceCounters>,
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
            v3_boundary_port_origins: BTreeMap::new(),
            network_index: None,
            simulator: None,
            snapshot: None,
            compile_count: 0,
            trace: TraceRecorder::default(),
            trace_diagnostics: vec![],
            trace_performance: Cell::new(TracePerformanceCounters::default()),
        };
        project_simulator.rebuild()?;
        Ok(project_simulator)
    }

    pub fn load_v3(
        project: ProjectDocumentV3,
        active_circuit_id: &str,
    ) -> Result<Self, Vec<ProjectDiagnostic>> {
        let compiled_v3 = compile_project_v3(project.clone(), active_circuit_id)?;
        let v3_boundary_port_origins = build_v3_boundary_port_origins(&compiled_v3);
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
            v3_boundary_port_origins,
            network_index: Some(network_index),
            simulator: Some(simulator),
            snapshot: None,
            compile_count: 1,
            trace: TraceRecorder::default(),
            trace_diagnostics: vec![],
            trace_performance: Cell::new(TracePerformanceCounters::default()),
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
                self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
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
            let before = self
                .simulator
                .as_ref()
                .expect("settleable runtime has a simulator")
                .snapshot();
            let flat = if updates.is_empty() {
                self.simulator
                    .as_ref()
                    .expect("settleable runtime has a simulator")
                    .snapshot()
            } else {
                match self
                    .simulator
                    .as_mut()
                    .expect("settleable runtime has a simulator")
                    .set_sources(updates)
                {
                    Ok(flat) => flat,
                    Err(diagnostic) => {
                        let diagnostics =
                            vec![project_error(&diagnostic.code, &diagnostic.message, None)];
                        self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
                        return Err(diagnostics);
                    }
                }
            };
            self.project = project;
            self.validated = Some(validated);
            self.snapshot = Some(self.project_snapshot(&flat));
            if runtime_signals_changed(&before, &flat) {
                self.record_trace_frame(TraceFrameReason::InputChange, vec![]);
            }
            return Ok(self
                .snapshot
                .clone()
                .expect("settled runtime has a snapshot"));
        }
        self.project = project;
        self.invalidate();
        if let Err(diagnostics) = self.install_validated(validated) {
            self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
            return Err(diagnostics);
        }
        self.refresh_trace_after_lifecycle(TraceFrameReason::Load);
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
            let diagnostics = vec![project_error(
                "PROJECT_VERSION_MISMATCH",
                "a v3 project cannot update a v2 project simulator",
                None,
            )];
            self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
            return Err(diagnostics);
        }
        let logical_topology_changed =
            v3_logical_topology_fingerprint(
                self.project_v3
                    .as_ref()
                    .expect("v3 update has an existing v3 project"),
                &self.active_circuit_id,
            ) != v3_logical_topology_fingerprint(&project, &self.active_circuit_id);
        let compiled_v3 = match compile_project_v3(project.clone(), &self.active_circuit_id) {
            Ok(compiled) => compiled,
            Err(diagnostics) => {
                self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
                return Err(diagnostics);
            }
        };
        let compiled = compiled_v3.compiled.clone();
        let can_reuse = self.simulator.is_some()
            && self.compiled.as_ref().is_some_and(|current| {
                flat_circuit_shape(&current.circuit) == flat_circuit_shape(&compiled.circuit)
            });
        if can_reuse {
            let updates = source_updates(&self.project, &compiled_v3.lowered.project, &compiled);
            let before = self
                .simulator
                .as_ref()
                .expect("reusable v3 runtime has a simulator")
                .snapshot();
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
            self.v3_boundary_port_origins = build_v3_boundary_port_origins(&compiled_v3);
            self.compiled_v3 = Some(compiled_v3);
            self.network_index = Some(FlatNetworkIndex::new(
                self.compiled
                    .as_ref()
                    .expect("reused v3 project is compiled"),
            ));
            self.snapshot = Some(self.project_snapshot(&flat));
            if logical_topology_changed {
                self.refresh_trace_after_lifecycle(TraceFrameReason::Load);
            } else if runtime_signals_changed(&before, &flat) {
                self.record_trace_frame(TraceFrameReason::InputChange, vec![]);
            }
            return Ok(self
                .snapshot
                .clone()
                .expect("reused v3 runtime has a snapshot"));
        }
        let network_index = FlatNetworkIndex::new(&compiled);
        let simulator = match Simulator::load(compiled.circuit.clone()) {
            Ok(simulator) => simulator,
            Err(diagnostics) => {
                let diagnostics = diagnostics
                    .iter()
                    .map(|diagnostic| {
                        remap_v3_diagnostic(
                            project_flat_diagnostic(diagnostic, &compiled, &network_index),
                            &compiled_v3,
                        )
                    })
                    .collect::<Vec<_>>();
                self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
                return Err(diagnostics);
            }
        };
        let flat = simulator.snapshot();

        self.project = compiled_v3.lowered.project.clone();
        self.project_v3 = Some(project);
        self.validated = None;
        self.compiled = Some(compiled);
        self.v3_boundary_port_origins = build_v3_boundary_port_origins(&compiled_v3);
        self.compiled_v3 = Some(compiled_v3);
        self.network_index = Some(network_index);
        self.simulator = Some(simulator);
        self.compile_count += 1;
        self.snapshot = Some(self.project_snapshot(&flat));
        self.refresh_trace_after_lifecycle(TraceFrameReason::Load);
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
            None => match validate_project(self.project.clone()) {
                Ok(validated) => validated,
                Err(diagnostics) => {
                    self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
                    return Err(diagnostics);
                }
            },
        };
        let compiled = match compile_project(&validated, active_circuit_id) {
            Ok(compiled) => compiled,
            Err(diagnostics) => {
                self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
                return Err(diagnostics);
            }
        };
        let network_index = FlatNetworkIndex::new(&compiled);
        let simulator = match Simulator::load(compiled.circuit.clone()) {
            Ok(simulator) => simulator,
            Err(diagnostics) => {
                let diagnostics = diagnostics
                    .iter()
                    .map(|diagnostic| {
                        project_flat_diagnostic(diagnostic, &compiled, &network_index)
                    })
                    .collect::<Vec<_>>();
                self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
                return Err(diagnostics);
            }
        };
        let flat = simulator.snapshot();
        self.active_circuit_id = active_circuit_id.to_owned();
        self.compile_count += 1;
        self.validated = Some(validated);
        self.compiled = Some(compiled);
        self.network_index = Some(network_index);
        self.simulator = Some(simulator);
        self.snapshot = Some(self.project_snapshot(&flat));
        self.refresh_trace_after_lifecycle(TraceFrameReason::Load);
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
        let compiled_v3 = match compile_project_v3(project, active_circuit_id) {
            Ok(compiled) => compiled,
            Err(diagnostics) => {
                self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
                return Err(diagnostics);
            }
        };
        let compiled = compiled_v3.compiled.clone();
        let network_index = FlatNetworkIndex::new(&compiled);
        let simulator = match Simulator::load(compiled.circuit.clone()) {
            Ok(simulator) => simulator,
            Err(diagnostics) => {
                let diagnostics = diagnostics
                    .iter()
                    .map(|diagnostic| {
                        remap_v3_diagnostic(
                            project_flat_diagnostic(diagnostic, &compiled, &network_index),
                            &compiled_v3,
                        )
                    })
                    .collect::<Vec<_>>();
                self.record_trace_frame(TraceFrameReason::Fault, diagnostics.clone());
                return Err(diagnostics);
            }
        };
        let flat = simulator.snapshot();
        self.project = compiled_v3.lowered.project.clone();
        self.active_circuit_id = active_circuit_id.to_owned();
        self.compile_count += 1;
        self.validated = None;
        self.compiled = Some(compiled);
        self.v3_boundary_port_origins = build_v3_boundary_port_origins(&compiled_v3);
        self.compiled_v3 = Some(compiled_v3);
        self.network_index = Some(network_index);
        self.simulator = Some(simulator);
        self.snapshot = Some(self.project_snapshot(&flat));
        self.refresh_trace_after_lifecycle(TraceFrameReason::Load);
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
        match self.set_source_inner(circuit_id, component_id, value) {
            Ok(outcome) => {
                if outcome.runtime_changed {
                    self.record_trace_frame(TraceFrameReason::InputChange, vec![]);
                }
                Ok(outcome.snapshot)
            }
            Err(diagnostic) => {
                self.record_trace_frame(TraceFrameReason::Fault, vec![diagnostic.clone()]);
                Err(diagnostic)
            }
        }
    }

    #[allow(clippy::result_large_err)]
    fn set_source_inner(
        &mut self,
        circuit_id: &str,
        component_id: &str,
        value: Trit,
    ) -> Result<SourceUpdateOutcome, ProjectDiagnostic> {
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
        let runtime_changed = if !copies.is_empty() {
            let before = self
                .simulator
                .as_ref()
                .expect("ready project has a flat simulator")
                .snapshot();
            let flat = self
                .simulator
                .as_mut()
                .expect("ready project has a flat simulator")
                .set_sources(copies.into_iter().map(|copy| (copy, value)))
                .map_err(|diagnostic| project_error(&diagnostic.code, &diagnostic.message, None))?;
            self.set_project_source_value(circuit_id, component_id, property, value);
            self.snapshot = Some(self.project_snapshot(&flat));
            runtime_signals_changed(&before, &flat)
        } else {
            self.set_project_source_value(circuit_id, component_id, property, value);
            false
        };
        Ok(SourceUpdateOutcome {
            snapshot: self.snapshot.clone().expect("ready project has a snapshot"),
            runtime_changed,
        })
    }

    #[allow(clippy::result_large_err)]
    pub fn set_source_word(
        &mut self,
        circuit_id: &str,
        component_id: &str,
        value: &str,
    ) -> Result<ProjectSnapshot, ProjectDiagnostic> {
        match self.set_source_word_inner(circuit_id, component_id, value) {
            Ok(outcome) => {
                if outcome.runtime_changed {
                    self.record_trace_frame(TraceFrameReason::InputChange, vec![]);
                }
                Ok(outcome.snapshot)
            }
            Err(diagnostic) => {
                self.record_trace_frame(TraceFrameReason::Fault, vec![diagnostic.clone()]);
                Err(diagnostic)
            }
        }
    }

    #[allow(clippy::result_large_err)]
    fn set_source_word_inner(
        &mut self,
        circuit_id: &str,
        component_id: &str,
        value: &str,
    ) -> Result<SourceUpdateOutcome, ProjectDiagnostic> {
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
        let include_nested_occurrences = component.type_id != MODULE_INPUT;
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

        let before = self
            .simulator
            .as_ref()
            .expect("ready v3 project has a simulator")
            .snapshot();
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
        self.synchronize_lowered_source_word(
            circuit_id,
            component_id,
            property,
            &word,
            include_nested_occurrences,
        );
        self.snapshot = Some(self.project_snapshot(&flat));
        Ok(SourceUpdateOutcome {
            snapshot: self
                .snapshot
                .clone()
                .expect("ready v3 project has a snapshot"),
            runtime_changed: runtime_signals_changed(&before, &flat),
        })
    }

    pub fn set_trace_watches(
        &mut self,
        watches: Vec<TraceWatch>,
    ) -> Result<TraceFrame, Vec<ProjectDiagnostic>> {
        let Some(flat) = self.simulator.as_ref().map(Simulator::snapshot) else {
            let diagnostics = vec![project_error(
                "PROJECT_NOT_READY",
                "project simulation is unavailable until validation succeeds",
                None,
            )];
            self.trace_diagnostics.clone_from(&diagnostics);
            return Err(diagnostics);
        };
        if watches.len() > MAX_TRACE_WATCHES {
            let diagnostics = vec![project_error(
                "TRACE_WATCH_LIMIT_EXCEEDED",
                &format!(
                    "trace watch count {} exceeds the limit {MAX_TRACE_WATCHES}",
                    watches.len()
                ),
                None,
            )];
            self.trace_diagnostics.clone_from(&diagnostics);
            return Err(diagnostics);
        }
        let mut ids = BTreeSet::new();
        let mut signals = BTreeSet::new();
        let mut diagnostics = Vec::new();
        for watch in &watches {
            if !ids.insert(watch.id.clone()) {
                diagnostics.push(trace_watch_error(
                    "DUPLICATE_TRACE_WATCH",
                    format!("trace watch id '{}' is duplicated", watch.id),
                    watch.signal.port(),
                ));
            }
            if !signals.insert(watch.signal.clone()) {
                diagnostics.push(trace_watch_error(
                    "DUPLICATE_TRACE_SIGNAL",
                    "a qualified signal can be watched only once".into(),
                    watch.signal.port(),
                ));
            }
        }
        if !diagnostics.is_empty() {
            self.trace_diagnostics.clone_from(&diagnostics);
            return Err(diagnostics);
        }

        let (bindings, unavailable) = self.resolve_trace_bindings(&watches, &flat);
        if !unavailable.is_empty() {
            self.trace_diagnostics.clone_from(&unavailable);
            return Err(unavailable);
        }

        self.trace_diagnostics.clear();
        self.trace
            .replace_watches(watches, bindings.into_iter().flatten().collect());
        self.record_trace_frame(TraceFrameReason::Load, vec![]);
        Ok(self
            .trace
            .last_frame()
            .cloned()
            .unwrap_or_else(|| empty_trace_frame(&flat, TraceFrameReason::Load)))
    }

    pub fn trace_watches(&self) -> &[TraceWatch] {
        self.trace.watches()
    }

    pub fn trace_frames(&self) -> &std::collections::VecDeque<TraceFrame> {
        self.trace.frames()
    }

    pub fn trace_diagnostics(&self) -> &[ProjectDiagnostic] {
        &self.trace_diagnostics
    }

    pub fn clear_trace(&mut self) {
        self.trace.clear();
    }

    pub fn trace_performance_counters(&self) -> TracePerformanceCounters {
        self.trace_performance.get()
    }

    #[allow(clippy::result_large_err)]
    pub fn reset(&mut self) -> Result<ProjectSnapshot, ProjectDiagnostic> {
        if self.simulator.is_none() || self.compiled.is_none() {
            let diagnostic = project_error(
                "PROJECT_NOT_READY",
                "project simulation is unavailable until validation succeeds",
                None,
            );
            self.record_trace_frame(TraceFrameReason::Fault, vec![diagnostic.clone()]);
            return Err(diagnostic);
        }
        let flat = self
            .simulator
            .as_mut()
            .expect("ready project has a simulator")
            .reset_preserving_sources();
        self.snapshot = Some(self.project_snapshot(&flat));
        self.trace.clear();
        self.trace_diagnostics.clear();
        self.record_trace_frame(TraceFrameReason::Reset, vec![]);
        Ok(self.snapshot.clone().expect("reset project has a snapshot"))
    }

    #[allow(clippy::result_large_err)]
    pub fn tick(&mut self) -> Result<ProjectSnapshot, ProjectDiagnostic> {
        if let Err(diagnostic) = self.ensure_runtime_ready() {
            self.record_trace_frame(TraceFrameReason::Fault, vec![diagnostic.clone()]);
            return Err(diagnostic);
        }
        if !self.trace.is_active() {
            let flat = match self
                .simulator
                .as_mut()
                .expect("ready project has a flat simulator")
                .tick()
            {
                Ok(flat) => flat,
                Err(diagnostic) => return Err(self.project_runtime_diagnostic(&diagnostic)),
            };
            self.snapshot = Some(self.project_snapshot(&flat));
            return Ok(self.snapshot.clone().expect("ready project has a snapshot"));
        }

        self.update_trace_performance(|counters| {
            counters.phase_snapshot_captures = counters.phase_snapshot_captures.saturating_add(2);
        });
        let phases = self
            .simulator
            .as_mut()
            .expect("ready project has a flat simulator")
            .tick_with_phase_snapshots();
        let (first, second) = match phases {
            Ok(phases) => phases,
            Err(diagnostic) => {
                let diagnostic = self.project_runtime_diagnostic(&diagnostic);
                self.record_trace_frame(TraceFrameReason::Fault, vec![diagnostic.clone()]);
                return Err(diagnostic);
            }
        };
        let first_diagnostics = self.trace_diagnostics_for_flat(&first);
        self.record_phase_snapshot(&first, first_diagnostics);
        self.snapshot = Some(self.project_snapshot(&second));
        let second_diagnostics = self.current_error_diagnostics();
        self.record_phase_snapshot(&second, second_diagnostics);
        Ok(self.snapshot.clone().expect("ready project has a snapshot"))
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
        if let Err(diagnostic) = self.ensure_runtime_ready() {
            self.record_trace_frame(TraceFrameReason::Fault, vec![diagnostic.clone()]);
            return Err(diagnostic);
        }

        let flat = match advance(
            self.simulator
                .as_mut()
                .expect("ready project has a flat simulator"),
        ) {
            Ok(flat) => flat,
            Err(diagnostic) => {
                let diagnostic = self.project_runtime_diagnostic(&diagnostic);
                self.record_trace_frame(TraceFrameReason::Fault, vec![diagnostic.clone()]);
                return Err(diagnostic);
            }
        };
        self.snapshot = Some(self.project_snapshot(&flat));
        let diagnostics = self.current_error_diagnostics();
        self.record_phase_snapshot(&flat, diagnostics);
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

    #[allow(clippy::result_large_err)]
    pub fn inspect_structural_expansion(
        &self,
        source: &QualifiedComponentRef,
    ) -> Result<StructuralExpansionInspection, ProjectDiagnostic> {
        let Some(compiled_v3) = self.compiled_v3.as_ref() else {
            return Err(project_error(
                "STRUCTURAL_EXPANSION_REQUIRES_PROJECT_V3",
                "structural expansion inspection requires a ready Project v3 simulator",
                Some(source.clone()),
            ));
        };

        let component_types = compiled_v3
            .compiled
            .circuit
            .components
            .iter()
            .map(|component| (component.id.as_str(), component.type_id.as_str()))
            .collect::<BTreeMap<_, _>>();
        let mut primitives = Vec::new();

        for (flat_id, generated_ref) in &compiled_v3.compiled.provenance.components {
            let static_generated = QualifiedComponentRef::new(
                &generated_ref.circuit_id,
                [] as [&str; 0],
                &generated_ref.component_id,
            );
            let Some(static_origin) = compiled_v3
                .lowered
                .provenance
                .components
                .get(&static_generated)
            else {
                continue;
            };
            let qualified_origin = QualifiedComponentRef::new(
                &static_origin.circuit_id,
                generated_ref.instance_path.iter().cloned(),
                &static_origin.component_id,
            );
            if &qualified_origin != source {
                continue;
            }

            let Some(type_id) = component_types.get(flat_id.as_str()) else {
                continue;
            };
            let port_origins = compiled_v3
                .lowered
                .provenance
                .ports
                .iter()
                .filter(|(generated_port, _)| {
                    generated_port.circuit_id == generated_ref.circuit_id
                        && generated_port.instance_path.is_empty()
                        && generated_port.component_id == generated_ref.component_id
                })
                .map(|(generated_port, origin_port)| {
                    (
                        generated_port.port_id.clone(),
                        QualifiedPortRef::new(
                            &origin_port.circuit_id,
                            generated_ref.instance_path.iter().cloned(),
                            &origin_port.component_id,
                            &origin_port.port_id,
                        ),
                    )
                })
                .collect();
            primitives.push(StructuralPrimitiveInspection {
                component_id: flat_id.clone(),
                type_id: (*type_id).to_owned(),
                port_origins,
            });
        }

        primitives.sort_by(|left, right| {
            register_lane_index(&left.component_id)
                .cmp(&register_lane_index(&right.component_id))
                .then_with(|| left.component_id.cmp(&right.component_id))
        });
        if primitives.is_empty() {
            return Err(project_error(
                "STRUCTURAL_EXPANSION_NOT_FOUND",
                &format!(
                    "component '{}:{}' has no structural expansion in the active circuit",
                    source.circuit_id, source.component_id
                ),
                Some(source.clone()),
            ));
        }

        Ok(StructuralExpansionInspection {
            source: source.clone(),
            primitives,
        })
    }

    #[allow(clippy::result_large_err)]
    fn ensure_runtime_ready(&self) -> Result<(), ProjectDiagnostic> {
        if (self.project_v3.is_none() && self.validated.is_none())
            || self.simulator.is_none()
            || self.compiled.is_none()
        {
            Err(project_error(
                "PROJECT_NOT_READY",
                "project simulation is unavailable until validation succeeds",
                None,
            ))
        } else {
            Ok(())
        }
    }

    fn project_runtime_diagnostic(&self, diagnostic: &Diagnostic) -> ProjectDiagnostic {
        let compiled = self
            .compiled
            .as_ref()
            .expect("ready project has compiled provenance");
        let network_index = self
            .network_index
            .as_ref()
            .expect("ready project has a cached network index");
        let diagnostic = project_flat_diagnostic(diagnostic, compiled, network_index);
        if let Some(compiled_v3) = &self.compiled_v3 {
            remap_v3_diagnostic(diagnostic, compiled_v3)
        } else {
            diagnostic
        }
    }

    fn record_phase_snapshot(
        &mut self,
        flat: &SimulationSnapshot,
        diagnostics: Vec<ProjectDiagnostic>,
    ) {
        let reason = match flat.clock_phase {
            ClockPhase::LowStable => TraceFrameReason::ClockFall,
            ClockPhase::HighStable => TraceFrameReason::ClockRise,
        };
        self.record_trace_frame_from_flat(flat, reason, diagnostics);
    }

    fn record_trace_frame(
        &mut self,
        reason: TraceFrameReason,
        diagnostics: Vec<ProjectDiagnostic>,
    ) {
        if !self.trace.is_active() {
            return;
        }
        let diagnostics = merge_trace_diagnostics(self.current_error_diagnostics(), diagnostics);
        if let Some(flat) = self.simulator.as_ref().map(Simulator::snapshot) {
            self.record_trace_frame_from_flat(&flat, reason, diagnostics);
            return;
        }
        let Some(previous) = self.trace.last_frame().cloned() else {
            return;
        };
        self.trace.push(TraceFrame {
            cycle: previous.cycle,
            clock_phase: previous.clock_phase,
            reason: TraceFrameReason::Fault,
            values: previous.values,
            diagnostics,
        });
    }

    fn record_trace_frame_from_flat(
        &mut self,
        flat: &SimulationSnapshot,
        requested_reason: TraceFrameReason,
        extra_diagnostics: Vec<ProjectDiagnostic>,
    ) {
        if !self.trace.is_active() {
            return;
        }
        let diagnostics = merge_trace_diagnostics(vec![], extra_diagnostics);
        let values = self.trace_values_from_bindings(flat);
        let watched_error = values.iter().any(|value| {
            (0..value.value.shape().width()).any(|index| value.value.trit(index) == Trit::Error)
        });
        let reason = if requested_reason == TraceFrameReason::Fault
            || !flat.stable
            || !diagnostics.is_empty()
            || watched_error
        {
            TraceFrameReason::Fault
        } else {
            requested_reason
        };
        self.trace.push(TraceFrame {
            cycle: flat.tick_count,
            clock_phase: flat.clock_phase,
            reason,
            values,
            diagnostics,
        });
    }

    fn trace_values_from_bindings(&self, flat: &SimulationSnapshot) -> Vec<TraceValue> {
        let mut endpoint_reads = 0_u64;
        let values = self
            .trace
            .bindings()
            .iter()
            .map(|binding| {
                let trits = binding
                    .bits
                    .iter()
                    .map(|endpoints| {
                        endpoint_reads = endpoint_reads.saturating_add(endpoints.len() as u64);
                        let values = endpoints
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
                TraceValue {
                    watch_id: binding.watch_id.clone(),
                    value: WordValue::new(binding.shape, trits)
                        .expect("trace binding has one endpoint set per signal trit"),
                }
            })
            .collect();
        self.update_trace_performance(|counters| {
            counters.endpoint_reads = counters.endpoint_reads.saturating_add(endpoint_reads);
        });
        values
    }

    fn current_error_diagnostics(&self) -> Vec<ProjectDiagnostic> {
        self.snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .diagnostics
                    .iter()
                    .filter(|diagnostic| diagnostic.severity == Severity::Error)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn trace_diagnostics_for_flat(&self, flat: &SimulationSnapshot) -> Vec<ProjectDiagnostic> {
        let compiled = self
            .compiled
            .as_ref()
            .expect("trace diagnostics require compiled provenance");
        let network_index = self
            .network_index
            .as_ref()
            .expect("trace diagnostics require a cached network index");
        let boundary_conflicts = self.boundary_conflicts(flat, compiled);
        let mut diagnostics = ProjectDiagnosticSet::new();
        for conflict in &boundary_conflicts {
            let diagnostic = self.compiled_v3.as_ref().map_or_else(
                || conflict.diagnostic.clone(),
                |compiled_v3| {
                    remap_v3_diagnostic_with_port_origins(
                        conflict.diagnostic.clone(),
                        compiled_v3,
                        &self.v3_boundary_port_origins,
                    )
                },
            );
            diagnostics.insert(diagnostic);
        }
        for diagnostic in flat
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Error)
        {
            if target_conflict_is_covered(diagnostic, network_index, &boundary_conflicts) {
                continue;
            }
            let diagnostic = project_flat_diagnostic(diagnostic, compiled, network_index);
            diagnostics.insert(self.compiled_v3.as_ref().map_or(
                diagnostic.clone(),
                |compiled_v3| {
                    remap_v3_diagnostic_with_port_origins(
                        diagnostic,
                        compiled_v3,
                        &self.v3_boundary_port_origins,
                    )
                },
            ));
        }
        diagnostics.into_vec()
    }

    fn resolve_trace_bindings(
        &self,
        watches: &[TraceWatch],
        flat: &SimulationSnapshot,
    ) -> (Vec<Option<TraceBinding>>, Vec<ProjectDiagnostic>) {
        if watches.is_empty() {
            return (vec![], vec![]);
        }
        let compiled = self
            .compiled
            .as_ref()
            .expect("ready trace binding has compiled provenance");
        let mut components_by_ref = BTreeMap::<QualifiedComponentRef, Vec<String>>::new();
        for (flat_component, reference) in &compiled.provenance.components {
            components_by_ref
                .entry(reference.clone())
                .or_default()
                .push(flat_component.clone());
        }
        self.update_trace_performance(|counters| {
            counters.binding_index_builds = counters.binding_index_builds.saturating_add(1);
            counters.binding_component_entries = counters
                .binding_component_entries
                .saturating_add(compiled.provenance.components.len() as u64);
            counters.binding_resolutions = counters
                .binding_resolutions
                .saturating_add(watches.len() as u64);
        });

        let mut bindings = Vec::with_capacity(watches.len());
        let mut unavailable = Vec::new();
        for watch in watches {
            let reference = watch.signal.port();
            let binding = if let Some(compiled_v3) = &self.compiled_v3 {
                compiled_v3
                    .reassembly
                    .ports
                    .get(reference)
                    .and_then(|bits| {
                        let shape = SignalShape::new(u8::try_from(bits.len()).ok()?).ok()?;
                        Some(TraceBinding {
                            watch_id: watch.id.clone(),
                            shape,
                            bits: bits
                                .iter()
                                .map(|bit| {
                                    compiled_v3.reassembly.observable_endpoints(bit).to_vec()
                                })
                                .collect(),
                        })
                    })
            } else if let Some(entry) = compiled
                .projection
                .ports
                .get(reference)
                .or_else(|| compiled.projection.boundaries.get(reference))
            {
                Some(TraceBinding {
                    watch_id: watch.id.clone(),
                    shape: SignalShape::new(1).expect("v2 projection is scalar"),
                    bits: vec![entry.drivers.clone()],
                })
            } else {
                let component = QualifiedComponentRef::new(
                    &reference.circuit_id,
                    reference.instance_path.iter().cloned(),
                    &reference.component_id,
                );
                components_by_ref.get(&component).and_then(|component_ids| {
                    let endpoints = component_ids
                        .iter()
                        .filter(|component_id| {
                            flat.output_value(component_id, &reference.port_id)
                                .is_some()
                                || flat.input_value(component_id, &reference.port_id).is_some()
                        })
                        .map(|component_id| FlatPortRef {
                            component_id: component_id.clone(),
                            port_id: reference.port_id.clone(),
                        })
                        .collect::<Vec<_>>();
                    (!endpoints.is_empty()).then(|| TraceBinding {
                        watch_id: watch.id.clone(),
                        shape: SignalShape::new(1).expect("v2 fallback is scalar"),
                        bits: vec![endpoints],
                    })
                })
            };
            if binding.is_none() {
                unavailable.push(trace_unavailable(watch));
            }
            bindings.push(binding);
        }
        (bindings, unavailable)
    }

    fn refresh_trace_after_lifecycle(&mut self, reason: TraceFrameReason) {
        let Some(flat) = self.simulator.as_ref().map(Simulator::snapshot) else {
            self.trace.clear();
            return;
        };
        let watches = self.trace.watches().to_vec();
        let (bindings, unavailable) = self.resolve_trace_bindings(&watches, &flat);
        let (available, bindings): (Vec<_>, Vec<_>) = watches
            .into_iter()
            .zip(bindings)
            .filter_map(|(watch, binding)| binding.map(|binding| (watch, binding)))
            .unzip();
        self.trace.replace_watches(available, bindings);
        self.trace_diagnostics = unavailable;
        self.append_trace_diagnostics_to_snapshot();
        let diagnostics = self.current_error_diagnostics();
        self.record_trace_frame_from_flat(&flat, reason, diagnostics);
    }

    fn append_trace_diagnostics_to_snapshot(&mut self) {
        let Some(snapshot) = &mut self.snapshot else {
            return;
        };
        let mut diagnostics = ProjectDiagnosticSet::new();
        for diagnostic in snapshot
            .diagnostics
            .iter()
            .cloned()
            .chain(self.trace_diagnostics.iter().cloned())
        {
            diagnostics.insert(diagnostic);
        }
        snapshot.diagnostics = diagnostics.into_vec();
    }

    fn update_trace_performance(&self, update: impl FnOnce(&mut TracePerformanceCounters)) {
        let mut counters = self.trace_performance.get();
        update(&mut counters);
        self.trace_performance.set(counters);
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
        self.network_index = Some(FlatNetworkIndex::new(
            self.compiled
                .as_ref()
                .expect("installed project is compiled"),
        ));
        self.project_v3 = None;
        self.compiled_v3 = None;
        self.v3_boundary_port_origins.clear();
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

    fn synchronize_lowered_source_word(
        &mut self,
        circuit_id: &str,
        component_id: &str,
        property: &str,
        word: &KnownWord,
        include_nested_occurrences: bool,
    ) {
        let compiled_v3 = self
            .compiled_v3
            .as_ref()
            .expect("ready word source has v3 reassembly");
        let mut scalar_values = BTreeMap::new();
        for (reference, bits) in &compiled_v3.reassembly.ports {
            if reference.circuit_id != circuit_id
                || reference.component_id != component_id
                || (!include_nested_occurrences && !reference.instance_path.is_empty())
            {
                continue;
            }
            for (bit_index, bit) in bits.iter().enumerate() {
                let Some(scalar) = &bit.scalar_port else {
                    continue;
                };
                let source = QualifiedComponentRef::new(
                    &scalar.circuit_id,
                    scalar.instance_path.iter().cloned(),
                    &scalar.component_id,
                );
                if !compiled_v3
                    .compiled
                    .provenance
                    .source_copies
                    .contains_key(&source)
                {
                    continue;
                }
                let key = (scalar.circuit_id.clone(), scalar.component_id.clone());
                let value = word.trit(bit_index as u8);
                if let Some(previous) = scalar_values.insert(key, value) {
                    debug_assert_eq!(previous, value);
                }
            }
        }

        for ((scalar_circuit, scalar_component), value) in &scalar_values {
            set_document_source_value(
                &mut self.project,
                scalar_circuit,
                scalar_component,
                property,
                *value,
            );
        }
        let lowered = &mut self
            .compiled_v3
            .as_mut()
            .expect("ready word source has lowered project")
            .lowered
            .project;
        for ((scalar_circuit, scalar_component), value) in scalar_values {
            set_document_source_value(lowered, &scalar_circuit, &scalar_component, property, value);
        }
    }

    fn invalidate(&mut self) {
        self.validated = None;
        self.compiled = None;
        self.compiled_v3 = None;
        self.v3_boundary_port_origins.clear();
        self.network_index = None;
        self.simulator = None;
        self.snapshot = None;
    }

    fn project_snapshot(&self, flat: &SimulationSnapshot) -> ProjectSnapshot {
        self.update_trace_performance(|counters| {
            counters.project_snapshot_projections =
                counters.project_snapshot_projections.saturating_add(1);
        });
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
        let network_index = self
            .network_index
            .as_ref()
            .expect("project snapshot has a cached network index");
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
            if !target_conflict_is_covered(diagnostic, network_index, &boundary_conflicts) {
                diagnostics.insert(project_flat_diagnostic(diagnostic, compiled, network_index));
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
        let network_index = self
            .network_index
            .as_ref()
            .expect("project snapshot has a cached network index");
        let mut diagnostics = ProjectDiagnosticSet::new();
        let boundary_conflicts = self.boundary_conflicts(flat, compiled);
        for conflict in &boundary_conflicts {
            diagnostics.insert(remap_v3_diagnostic(
                conflict.diagnostic.clone(),
                compiled_v3,
            ));
        }
        for diagnostic in &flat.diagnostics {
            if !target_conflict_is_covered(diagnostic, network_index, &boundary_conflicts) {
                diagnostics.insert(remap_v3_diagnostic(
                    project_flat_diagnostic(diagnostic, compiled, network_index),
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

type V3LogicalComponent = (String, String, Vec<(String, String)>);
type V3LogicalWire = ((String, String), (String, String));
type V3LogicalCircuit = (String, Vec<V3LogicalComponent>, Vec<V3LogicalWire>);

fn v3_logical_topology_fingerprint(
    project: &ProjectDocumentV3,
    active_circuit_id: &str,
) -> Option<Vec<V3LogicalCircuit>> {
    let circuits = project
        .circuits
        .iter()
        .map(|circuit| (circuit.id.as_str(), circuit))
        .collect::<BTreeMap<_, _>>();
    circuits.get(active_circuit_id)?;
    let mut reachable = BTreeSet::from([active_circuit_id.to_owned()]);
    let mut stack = vec![active_circuit_id.to_owned()];
    while let Some(circuit_id) = stack.pop() {
        let circuit = circuits.get(circuit_id.as_str())?;
        for module_id in circuit
            .components
            .iter()
            .filter(|component| component.type_id == "project.module_instance")
            .filter_map(|component| component.properties.module_id())
        {
            circuits.get(module_id)?;
            if reachable.insert(module_id.to_owned()) {
                stack.push(module_id.to_owned());
            }
        }
    }

    let mut fingerprint = Vec::with_capacity(reachable.len());
    for circuit_id in reachable {
        let circuit = circuits.get(circuit_id.as_str())?;
        let mut components = circuit
            .components
            .iter()
            .map(|component| {
                let mut properties = component
                    .properties
                    .keys()
                    .filter(|key| {
                        !matches!(
                            *key,
                            "value" | "previewValue" | "x" | "y" | "position" | "layout" | "label"
                        )
                    })
                    .filter_map(|key| {
                        component.properties.get(key).map(|value| {
                            (
                                key.to_owned(),
                                serde_json::to_string(value)
                                    .expect("validated property value serializes"),
                            )
                        })
                    })
                    .collect::<Vec<_>>();
                if component.type_id == "wiring.tunnel"
                    && let Some(label) = component.properties.label()
                {
                    properties.push(("label".into(), label.into()));
                }
                properties.sort();
                (component.id.clone(), component.type_id.clone(), properties)
            })
            .collect::<Vec<_>>();
        components.sort();
        let mut wires = circuit
            .wires
            .iter()
            .map(|wire| {
                let mut endpoints = [
                    (
                        wire.endpoint_a.component_id.clone(),
                        wire.endpoint_a.port_id.clone(),
                    ),
                    (
                        wire.endpoint_b.component_id.clone(),
                        wire.endpoint_b.port_id.clone(),
                    ),
                ];
                endpoints.sort();
                (endpoints[0].clone(), endpoints[1].clone())
            })
            .collect::<Vec<_>>();
        wires.sort();
        fingerprint.push((circuit.id.clone(), components, wires));
    }
    fingerprint.sort_by(|left, right| left.0.cmp(&right.0));
    Some(fingerprint)
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

fn runtime_signals_changed(before: &SimulationSnapshot, after: &SimulationSnapshot) -> bool {
    before.component_outputs != after.component_outputs || before.input_nets != after.input_nets
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
    remap_v3_diagnostic_with_port_origins(diagnostic, compiled_v3, &BTreeMap::new())
}

fn remap_v3_diagnostic_with_port_origins(
    diagnostic: ProjectDiagnostic,
    compiled_v3: &CompiledProjectV3,
    port_origins: &BTreeMap<QualifiedPortRef, QualifiedPortRef>,
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
            if let Some(original) = port_origins.get(reference) {
                return original.clone();
            }
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

fn build_v3_boundary_port_origins(
    compiled_v3: &CompiledProjectV3,
) -> BTreeMap<QualifiedPortRef, QualifiedPortRef> {
    let mut origins = BTreeMap::new();
    for (logical, bits) in &compiled_v3.reassembly.ports {
        for scalar in bits.iter().filter_map(|bit| bit.scalar_port.as_ref()) {
            if !compiled_v3
                .compiled
                .projection
                .boundaries
                .contains_key(scalar)
            {
                continue;
            }
            origins
                .entry(scalar.clone())
                .or_insert_with(|| logical.clone());
        }
    }
    origins
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

fn merge_trace_diagnostics(
    current: Vec<ProjectDiagnostic>,
    extra: Vec<ProjectDiagnostic>,
) -> Vec<ProjectDiagnostic> {
    let mut diagnostics = ProjectDiagnosticSet::new();
    for diagnostic in current.into_iter().chain(extra) {
        diagnostics.insert(diagnostic);
    }
    diagnostics.into_vec()
}

fn trace_unavailable(watch: &TraceWatch) -> ProjectDiagnostic {
    let reference = watch.signal.port().clone();
    ProjectDiagnostic {
        code: "TRACE_SIGNAL_UNAVAILABLE".into(),
        severity: Severity::Warning,
        message: format!(
            "trace watch '{}' no longer resolves to an active compiled signal",
            watch.id
        ),
        primary_location: Some(ProjectLocation::Port(reference.clone())),
        component_refs: vec![QualifiedComponentRef::new(
            &reference.circuit_id,
            reference.instance_path.iter().cloned(),
            &reference.component_id,
        )],
        connection_refs: vec![],
        port_refs: vec![reference],
    }
}

fn trace_watch_error(
    code: &str,
    message: String,
    reference: &QualifiedPortRef,
) -> ProjectDiagnostic {
    ProjectDiagnostic {
        code: code.into(),
        severity: Severity::Error,
        message,
        primary_location: Some(ProjectLocation::Port(reference.clone())),
        component_refs: vec![QualifiedComponentRef::new(
            &reference.circuit_id,
            reference.instance_path.iter().cloned(),
            &reference.component_id,
        )],
        connection_refs: vec![],
        port_refs: vec![reference.clone()],
    }
}

fn empty_trace_frame(flat: &SimulationSnapshot, reason: TraceFrameReason) -> TraceFrame {
    TraceFrame {
        cycle: flat.tick_count,
        clock_phase: flat.clock_phase,
        reason,
        values: vec![],
        diagnostics: vec![],
    }
}
