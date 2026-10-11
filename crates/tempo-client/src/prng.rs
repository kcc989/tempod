use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// SplitMix64, for reconnect jitter and multipart boundaries. Not for secrets.
pub(crate) struct Prng(u64);

static STREAM: AtomicU64 = AtomicU64::new(0);

impl Prng {
    pub(crate) fn seeded() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let stream = STREAM.fetch_add(1, Ordering::Relaxed);
        Self(nanos ^ stream.wrapping_mul(0x9E37_79B9_7F4A_7C15))
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub(crate) fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_stay_in_the_unit_interval_and_cover_it() {
        let mut p = Prng::seeded();
        let xs: Vec<f64> = (0..10_000).map(|_| p.next_f64()).collect();
        assert!(xs.iter().all(|x| (0.0..1.0).contains(x)));
        assert!(xs.iter().any(|x| *x < 0.05) && xs.iter().any(|x| *x > 0.95));
    }
}
