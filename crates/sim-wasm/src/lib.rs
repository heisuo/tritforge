use serde::Serialize;
use sim_core::circuit::CircuitDefinition;
use sim_core::diagnostic::Diagnostic;
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
                BoundaryError::new(
                    "INVALID_CIRCUIT",
                    format!("could not deserialize circuit definition: {error}"),
                    Vec::new(),
                )
                .into_js()
            })?;
        let simulator = Simulator::load(definition).map_err(|diagnostics| {
            BoundaryError::new(
                "CIRCUIT_VALIDATION_FAILED",
                "circuit validation failed".to_owned(),
                diagnostics,
            )
            .into_js()
        })?;
        let snapshot = simulator.snapshot();
        self.simulator = Some(simulator);
        to_js_value(&snapshot)
    }

    #[wasm_bindgen(js_name = setInput)]
    pub fn set_input(&mut self, component_id: &str, value: &str) -> Result<JsValue, JsValue> {
        let value = parse_trit_symbol(value).map_err(|code| {
            BoundaryError::new(
                code,
                format!("'{value}' is not a known ternary input symbol"),
                Vec::new(),
            )
            .into_js()
        })?;
        let snapshot = self
            .simulator_mut()?
            .set_input(component_id, value)
            .map_err(|diagnostic| {
                BoundaryError::new(
                    &diagnostic.code.clone(),
                    diagnostic.message.clone(),
                    vec![diagnostic],
                )
                .into_js()
            })?;
        to_js_value(&snapshot)
    }

    pub fn reset(&mut self) -> Result<JsValue, JsValue> {
        let snapshot = self.simulator_mut()?.reset();
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
struct BoundaryError {
    name: &'static str,
    code: String,
    message: String,
    diagnostics: Vec<Diagnostic>,
}

impl BoundaryError {
    fn new(code: &str, message: String, diagnostics: Vec<Diagnostic>) -> Self {
        Self {
            name: "SimulationError",
            code: code.to_owned(),
            message,
            diagnostics,
        }
    }

    fn not_loaded() -> Self {
        Self::new(
            "SIMULATOR_NOT_LOADED",
            "loadCircuit must be called before simulation".to_owned(),
            Vec::new(),
        )
    }

    fn into_js(self) -> JsValue {
        match self.serialize(&serde_wasm_bindgen::Serializer::json_compatible()) {
            Ok(value) => value,
            Err(_) => JsValue::from_str(&self.message),
        }
    }
}

fn to_js_value<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|error| {
            BoundaryError::new(
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
