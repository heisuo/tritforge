use crate::trit::Trit;

pub fn dff_next(current: Trit, d: Trit, en: Trit, rst: Trit) -> Trit {
    match rst {
        Trit::Pos => Trit::Zero,
        Trit::Error => Trit::Error,
        Trit::Unknown | Trit::HighZ => Trit::Unknown,
        Trit::Neg | Trit::Zero => match en {
            Trit::Pos => d.normalize_gate_input(),
            Trit::Neg | Trit::Zero => current,
            Trit::Error => Trit::Error,
            Trit::Unknown | Trit::HighZ => Trit::Unknown,
        },
    }
}
