pub mod catalog;
pub mod circuit;
pub mod diagnostic;
pub mod gates;
pub mod hierarchy;
pub mod project;
pub mod project_simulator;
pub mod project_validation;
pub mod simulator;
pub mod trit;

pub const fn api_version() -> u32 {
    2
}

#[cfg(test)]
mod tests {
    #[test]
    fn phase_one_workspace_is_alive() {
        assert_eq!(crate::api_version(), 2);
    }
}
