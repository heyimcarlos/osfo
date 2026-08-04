use std::time::Duration;

use anyhow::{Result, bail};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrivalDisposition {
    Send { lag: Duration },
    CallerDrop { lag: Duration },
}

#[derive(Debug, Clone, Copy)]
pub struct OpenLoopSchedule {
    interval: Duration,
    offered_count: usize,
    maximum_lag: Duration,
}

impl OpenLoopSchedule {
    pub fn new(rate_per_second: f64, duration: Duration, maximum_lag: Duration) -> Result<Self> {
        if !rate_per_second.is_finite()
            || rate_per_second <= 0.0
            || duration.is_zero()
            || maximum_lag.is_zero()
        {
            bail!("open-loop rate, duration, and maximum lag must be positive");
        }
        let offered_count = (rate_per_second * duration.as_secs_f64()).round() as usize;
        if offered_count == 0 {
            bail!("open-loop schedule must offer at least one arrival");
        }
        Ok(Self {
            interval: Duration::from_secs_f64(1.0 / rate_per_second),
            offered_count,
            maximum_lag,
        })
    }

    pub fn offered_count(&self) -> usize {
        self.offered_count
    }

    pub fn target_offset(&self, ordinal: usize) -> Duration {
        self.interval.mul_f64(ordinal as f64)
    }

    pub fn classify(&self, ordinal: usize, actual_offset: Duration) -> ArrivalDisposition {
        let lag = actual_offset.saturating_sub(self.target_offset(ordinal));
        if lag > self.maximum_lag {
            ArrivalDisposition::CallerDrop { lag }
        } else {
            ArrivalDisposition::Send { lag }
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LinearRampSchedule {
    start_rate_per_second: f64,
    rate_slope_per_second: f64,
    offered_count: usize,
    duration: Duration,
    maximum_lag: Duration,
}

impl LinearRampSchedule {
    pub fn new(
        start_rate_per_second: f64,
        end_rate_per_second: f64,
        duration: Duration,
        maximum_lag: Duration,
    ) -> Result<Self> {
        if !start_rate_per_second.is_finite()
            || !end_rate_per_second.is_finite()
            || start_rate_per_second <= 0.0
            || end_rate_per_second <= start_rate_per_second
            || duration.is_zero()
            || maximum_lag.is_zero()
        {
            bail!("linear ramp rates, duration, and maximum lag must be positive and increasing");
        }
        let seconds = duration.as_secs_f64();
        let offered_count =
            (((start_rate_per_second + end_rate_per_second) / 2.0) * seconds).round() as usize;
        Ok(Self {
            start_rate_per_second,
            rate_slope_per_second: (end_rate_per_second - start_rate_per_second) / seconds,
            offered_count,
            duration,
            maximum_lag,
        })
    }

    pub fn offered_count(&self) -> usize {
        self.offered_count
    }

    pub fn target_offset(&self, ordinal: usize) -> Duration {
        let ordinal = ordinal.min(self.offered_count.saturating_sub(1)) as f64;
        let discriminant =
            self.start_rate_per_second.powi(2) + 2.0 * self.rate_slope_per_second * ordinal;
        let seconds =
            (-self.start_rate_per_second + discriminant.sqrt()) / self.rate_slope_per_second;
        Duration::from_secs_f64(seconds.max(0.0).min(self.duration.as_secs_f64()))
    }

    pub fn classify(&self, ordinal: usize, actual_offset: Duration) -> ArrivalDisposition {
        let lag = actual_offset.saturating_sub(self.target_offset(ordinal));
        if lag > self.maximum_lag {
            ArrivalDisposition::CallerDrop { lag }
        } else {
            ArrivalDisposition::Send { lag }
        }
    }
}
