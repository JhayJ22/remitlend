// Oracle adapter staleness guard and dispersion filter integration
pub struct OracleGuard {
    pub max_staleness_seconds: u64,
    pub max_dispersion_basis_points: u32,
}

impl OracleGuard {
    pub fn new(max_staleness: u64, max_dispersion: u32) -> Self {
        Self {
            max_staleness_seconds: max_staleness,
            max_dispersion_basis_points: max_dispersion,
        }
    }

    pub fn validate_price(&self, current_time: u64, price_timestamp: u64, dispersion_bps: u32) -> bool {
        if current_time.saturating_sub(price_timestamp) > self.max_staleness_seconds {
            return false;
        }
        if dispersion_bps > self.max_dispersion_basis_points {
            return false;
        }
        true
    }
}
