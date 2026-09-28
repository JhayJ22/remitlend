#![no_std]

use soroban_sdk::{Vec, Env};

pub struct DispersionMetrics {
    pub median: i128,
    pub mad: i128,
    pub dispersion_bps: u32,
    pub accepted_count: u32,
}

pub struct OutlierFilter;

impl OutlierFilter {
    /// Drops reports deviating by more than `k * MAD` from preliminary median,
    /// returning dispersion metrics for risk modeling.
    pub fn filter_outliers(env: &Env, mut reports: Vec<i128>, k: u32) -> DispersionMetrics {
        let n = reports.len();
        if n == 0 {
            return DispersionMetrics { median: 0, mad: 0, dispersion_bps: 0, accepted_count: 0 };
        }

        // 1. Sort reports to find preliminary median
        reports.sort();
        let median = reports.get(n / 2).unwrap();

        // 2. Compute absolute deviations
        let mut deviations = Vec::new(env);
        for i in 0..n {
            let val = reports.get(i).unwrap();
            let diff = if val >= median { val - median } else { median - val };
            deviations.push_back(diff);
        }
        deviations.sort();
        let mad = deviations.get(n / 2).unwrap();

        // 3. Drop reports > k * MAD
        let threshold = mad * k as i128;
        let mut accepted_count = 0u32;
        for i in 0..n {
            let diff = deviations.get(i).unwrap();
            if diff <= threshold {
                accepted_count += 1;
            }
        }

        let dispersion_bps = if median > 0 {
            ((mad * 10_000) / median) as u32
        } else {
            0
        };

        DispersionMetrics {
            median,
            mad,
            dispersion_bps,
            accepted_count,
        }
    }
}
