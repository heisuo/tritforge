use serde::Serialize;
use sim_core::circuit::CircuitDefinition;
use sim_core::diagnostic::Diagnostic;
use sim_core::project::{ProjectDiagnostic, ProjectDocument};
use sim_core::project_simulator::ProjectSimulator;
use sim_core::simulator::Simulator;
use sim_core::trit::Trit;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = apiVersion)]
pub fn api_version() -> u32 {
    sim_core::api_version()
}

#[wasm_bindgen(js_name = componentCatalog)]
pub fn component_catalog() -> Result<JsValue, JsValue> {
    to_js_value(&sim_core::catalog::component_catalog())
}

pub fn component_catalog_json() -> String {
    serde_json::to_string(&sim_core::catalog::component_catalog())
        .expect("component catalog must be serializable")
}

#[wasm_bindgen]
pub struct WasmSimulator {
    simulator: Option<Simulator>,
}

#[wasm_bindgen]
impl WasmSimulator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self { simulator: None }
    }

    #[wasm_bindgen(js_name = loadCircuit)]
    pub fn load_circuit(&mut self, definition: JsValue) -> Result<JsValue, JsValue> {
        let definition: CircuitDefinition =
            serde_wasm_bindgen::from_value(definition).map_err(|error| {
                BoundaryError::<Diagnostic>::new(
                    "INVALID_CIRCUIT",
                    format!("could not deserialize circuit definition: {error}"),
                    Vec::new(),
                )
                .into_js()
            })?;
        let simulator = Simulator::load(definition).map_err(|diagnostics| {
            let code = diagnostics
                .first()
                .map(|diagnostic| diagnostic.code.clone())
                .unwrap_or_else(|| "CIRCUIT_VALIDATION_FAILED".to_owned());
            BoundaryError::new(&code, "circuit validation failed".to_owned(), diagnostics).into_js()
        })?;
        let snapshot = simulator.snapshot();
        self.simulator = Some(simulator);
        to_js_value(&snapshot)
    }

    #[wasm_bindgen(js_name = setInput)]
    pub fn set_input(&mut self, component_id: &str, value: &str) -> Result<JsValue, JsValue> {
        let value = parse_trit_symbol(value).map_err(|code| {
            BoundaryError::<Diagnostic>::new(
                code,
                format!("'{value}' is not a known ternary input symbol"),
                Vec::new(),
            )
            .into_js()
        })?;
        let snapshot = self
            .simulator_mut()?
            .set_input(component_id, value)
            .map_err(boundary_diagnostic)?;
        to_js_value(&snapshot)
    }

    pub fn reset(&mut self) -> Result<JsValue, JsValue> {
        let snapshot = self.simulator_mut()?.reset();
        to_js_value(&snapshot)
    }

    pub fn tick(&mut self) -> Result<JsValue, JsValue> {
        let snapshot = self.simulator_mut()?.tick().map_err(boundary_diagnostic)?;
        to_js_value(&snapshot)
    }

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        let snapshot = self
            .simulator
            .as_ref()
            .ok_or_else(|| BoundaryError::not_loaded().into_js())?
            .snapshot();
        to_js_value(&snapshot)
    }
}

#[wasm_bindgen]
pub struct WasmProjectSimulator {
    simulator: Option<ProjectSimulator>,
}

#[wasm_bindgen]
impl WasmProjectSimulator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self { simulator: None }
    }

    #[wasm_bindgen(js_name = loadProject)]
    pub fn load_project(
        &mut self,
        project: JsValue,
        active_circuit_id: &str,
    ) -> Result<JsValue, JsValue> {
        let project = parse_project(project)?;
        let simulator = ProjectSimulator::load(project, active_circuit_id)
            .map_err(project_diagnostics_error)?;
        let snapshot = simulator
            .snapshot()
            .expect("loaded project simulator has a snapshot");
        self.simulator = Some(simulator);
        to_js_value(&snapshot)
    }

    #[wasm_bindgen(js_name = updateProject)]
    pub fn update_project(&mut self, project: JsValue) -> Result<JsValue, JsValue> {
        let project = parse_project(project)?;
        let snapshot = self
            .simulator_mut()?
            .update_project(project)
            .map_err(project_diagnostics_error)?;
        to_js_value(&snapshot)
    }

    #[wasm_bindgen(js_name = switchActive)]
    pub fn switch_active(&mut self, active_circuit_id: &str) -> Result<JsValue, JsValue> {
        let snapshot = self
            .simulator_mut()?
            .switch_active(active_circuit_id)
            .map_err(project_diagnostics_error)?;
        to_js_value(&snapshot)
    }

    #[wasm_bindgen(js_name = setSource)]
    pub fn set_source(
        &mut self,
        circuit_id: &str,
        component_id: &str,
        value: &str,
    ) -> Result<JsValue, JsValue> {
        let value = parse_trit_symbol(value).map_err(|code| {
            BoundaryError::<ProjectDiagnostic>::new(
                code,
                format!("'{value}' is not a known ternary source symbol"),
                Vec::new(),
            )
            .into_js()
        })?;
        let snapshot = self
            .simulator_mut()?
            .set_source(circuit_id, component_id, value)
            .map_err(project_boundary_diagnostic)?;
        to_js_value(&snapshot)
    }

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        let snapshot = self
            .simulator
            .as_ref()
            .ok_or_else(|| BoundaryError::<ProjectDiagnostic>::project_not_loaded().into_js())?
            .snapshot()
            .ok_or_else(|| {
                BoundaryError::<ProjectDiagnostic>::new(
                    "PROJECT_NOT_READY",
                    "project simulation is unavailable until validation succeeds".into(),
                    Vec::new(),
                )
                .into_js()
            })?;
        to_js_value(&snapshot)
    }

    pub fn tick(&mut self) -> Result<JsValue, JsValue> {
        let snapshot = self
            .simulator_mut()?
            .tick()
            .map_err(project_boundary_diagnostic)?;
        to_js_value(&snapshot)
    }

    pub fn metrics(&self) -> Result<JsValue, JsValue> {
        let metrics = self
            .simulator
            .as_ref()
            .ok_or_else(|| BoundaryError::<ProjectDiagnostic>::project_not_loaded().into_js())?
            .metrics()
            .ok_or_else(|| {
                BoundaryError::<ProjectDiagnostic>::new(
                    "PROJECT_NOT_READY",
                    "project compile metrics are unavailable until validation succeeds".into(),
                    Vec::new(),
                )
                .into_js()
            })?;
        to_js_value(&metrics)
    }
}

impl Default for WasmProjectSimulator {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmProjectSimulator {
    fn simulator_mut(&mut self) -> Result<&mut ProjectSimulator, JsValue> {
        self.simulator
            .as_mut()
            .ok_or_else(|| BoundaryError::<ProjectDiagnostic>::project_not_loaded().into_js())
    }
}

fn parse_project(project: JsValue) -> Result<ProjectDocument, JsValue> {
    serde_wasm_bindgen::from_value(project).map_err(|error| {
        BoundaryError::<ProjectDiagnostic>::new(
            "INVALID_PROJECT",
            format!("could not deserialize project document: {error}"),
            Vec::new(),
        )
        .into_js()
    })
}

fn project_diagnostics_error(diagnostics: Vec<ProjectDiagnostic>) -> JsValue {
    let code = diagnostics
        .first()
        .map(|diagnostic| diagnostic.code.clone())
        .unwrap_or_else(|| "PROJECT_VALIDATION_FAILED".into());
    BoundaryError::new(&code, "project operation failed".into(), diagnostics).into_js()
}

fn boundary_diagnostic(diagnostic: Diagnostic) -> JsValue {
    let code = diagnostic.code.clone();
    let message = diagnostic.message.clone();
    BoundaryError::new(&code, message, vec![diagnostic]).into_js()
}

fn project_boundary_diagnostic(diagnostic: ProjectDiagnostic) -> JsValue {
    let code = diagnostic.code.clone();
    let message = diagnostic.message.clone();
    BoundaryError::new(&code, message, vec![diagnostic]).into_js()
}

impl Default for WasmSimulator {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmSimulator {
    fn simulator_mut(&mut self) -> Result<&mut Simulator, JsValue> {
        self.simulator
            .as_mut()
            .ok_or_else(|| BoundaryError::not_loaded().into_js())
    }
}

fn parse_trit_symbol(symbol: &str) -> Result<Trit, &'static str> {
    match symbol {
        "T" => Ok(Trit::Neg),
        "0" => Ok(Trit::Zero),
        "1" => Ok(Trit::Pos),
        _ => Err("INVALID_TRIT_SYMBOL"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct BoundaryError<D> {
    name: &'static str,
    code: String,
    message: String,
    diagnostics: Vec<D>,
}

impl<D> BoundaryError<D> {
    fn new(code: &str, message: String, diagnostics: Vec<D>) -> Self {
        Self {
            name: "SimulationError",
            code: code.into(),
            message,
            diagnostics,
        }
    }
}

impl BoundaryError<ProjectDiagnostic> {
    fn project_not_loaded() -> Self {
        Self::new(
            "SIMULATOR_NOT_LOADED",
            "loadProject must be called before project simulation".into(),
            Vec::new(),
        )
    }
}

impl<D: Serialize> BoundaryError<D> {
    fn into_js(self) -> JsValue {
        match self.serialize(&serde_wasm_bindgen::Serializer::json_compatible()) {
            Ok(value) => value,
            Err(_) => JsValue::from_str(&self.message),
        }
    }
}

impl BoundaryError<Diagnostic> {
    fn not_loaded() -> Self {
        Self::new(
            "SIMULATOR_NOT_LOADED",
            "loadCircuit must be called before simulation".to_owned(),
            Vec::new(),
        )
    }
}

fn to_js_value<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|error| {
            BoundaryError::<Diagnostic>::new(
                "SERIALIZATION_FAILED",
                format!("could not serialize simulator value: {error}"),
                Vec::new(),
            )
            .into_js()
        })
}

#[cfg(test)]
mod tests {
    use sim_core::trit::Trit;

    use super::{BoundaryError, parse_trit_symbol};

    #[test]
    fn parses_only_known_input_symbols() {
        assert_eq!(parse_trit_symbol("T"), Ok(Trit::Neg));
        assert_eq!(parse_trit_symbol("0"), Ok(Trit::Zero));
        assert_eq!(parse_trit_symbol("1"), Ok(Trit::Pos));
        assert_eq!(parse_trit_symbol("X"), Err("INVALID_TRIT_SYMBOL"));
    }

    #[test]
    fn not_loaded_error_has_a_stable_machine_code() {
        let error = BoundaryError::not_loaded();

        assert_eq!(error.name, "SimulationError");
        assert_eq!(error.code, "SIMULATOR_NOT_LOADED");
        assert!(error.diagnostics.is_empty());
    }
}
