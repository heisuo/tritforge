pub mod catalog;
pub mod gates;
pub mod trit;

pub const fn api_version() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    #[test]
    fn phase_one_workspace_is_alive() {
        assert_eq!(crate::api_version(), 1);
    }
}
