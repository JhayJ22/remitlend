// Timelock-governed liquidation bonus and threshold risk parameters
pub struct RiskParameters {
    pub liquidation_bonus_bps: u32,
    pub liquidation_threshold_bps: u32,
    pub timelock_delay_seconds: u64,
}

impl RiskParameters {
    pub fn new(bonus_bps: u32, threshold_bps: u32, delay_s: u64) -> Self {
        Self {
            liquidation_bonus_bps: bonus_bps,
            liquidation_threshold_bps: threshold_bps,
            timelock_delay_seconds: delay_s,
        }
    }
}
