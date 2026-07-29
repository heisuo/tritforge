use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = apiVersion)]
pub fn api_version() -> u32 {
    sim_core::api_version()
}
