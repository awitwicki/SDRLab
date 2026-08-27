/// Streaming linear-interpolation resampler. Carries fractional phase and the
/// last sample across process() calls so chunk boundaries are seamless.
pub struct LinearResampler {
    step: f64, // input samples per output sample = in_rate / out_rate
    pos: f64,  // next output position relative to input[0]; may be in [-1, 0)
    prev: f32, // last input sample of the previous chunk
    primed: bool,
}

impl LinearResampler {
    pub fn new(in_rate: f64, out_rate: f64) -> Self {
        Self { step: in_rate / out_rate, pos: 0.0, prev: 0.0, primed: false }
    }
    pub fn reset(&mut self, in_rate: f64, out_rate: f64) {
        self.step = in_rate / out_rate;
        self.pos = 0.0;
        self.prev = 0.0;
        self.primed = false;
    }
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() { return; }
        let n = input.len() as f64;
        let mut pos = self.pos;
        while pos < n - 1.0 {
            let i = pos.floor();
            let frac = (pos - i) as f32;
            let idx = i as isize;
            let a = if idx < 0 {
                if self.primed { self.prev } else { input[0] }
            } else {
                input[idx as usize]
            };
            let b = input[(idx + 1).max(0) as usize];
            out.push(a + (b - a) * frac);
            pos += self.step;
        }
        self.pos = pos - n; // relative to the next chunk's first sample; in [-1, step)
        self.prev = input[input.len() - 1];
        self.primed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    #[test]
    fn test_output_rate_and_tone_preserved() {
        // 1 s of a 1 kHz sine at 50 kHz in, resampled to 48 kHz out.
        let (in_rate, out_rate) = (50_000.0f64, 48_000.0f64);
        let mut rs = LinearResampler::new(in_rate, out_rate);
        let mut out = Vec::new();
        let mut cycles = 0.0f64;
        for _ in 0..10 {
            let chunk: Vec<f32> = (0..5000)
                .map(|_| { let s = (2.0 * PI * cycles as f32).sin(); cycles += 1000.0 / in_rate; s })
                .collect();
            rs.process(&chunk, &mut out);
        }
        assert!((out.len() as i64 - 48_000).abs() <= 2, "got {} samples", out.len());
        let crossings = out.windows(2).filter(|w| w[0] * w[1] < 0.0).count();
        assert!((crossings as i64 - 2000).abs() < 20, "got {crossings} crossings");
    }

    #[test]
    fn test_upsampling() {
        // 25 kHz → 48 kHz (the NFM case that currently plays 1.92x too fast).
        let mut rs = LinearResampler::new(25_000.0, 48_000.0);
        let mut out = Vec::new();
        for _ in 0..10 { rs.process(&vec![1.0f32; 2500], &mut out); }
        assert!((out.len() as i64 - 48_000).abs() <= 2, "got {} samples", out.len());
    }
}
