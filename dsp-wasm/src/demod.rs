pub fn demod_fm(real: &[f32], imag: &[f32], out: &mut [f32]) {
    out[0] = 0.0;
    for i in 1..real.len() {
        let conj_real = real[i] * real[i - 1] + imag[i] * imag[i - 1];
        let conj_imag = imag[i] * real[i - 1] - real[i] * imag[i - 1];
        out[i] = conj_imag.atan2(conj_real);
    }
}

pub fn demod_am(real: &[f32], imag: &[f32], out: &mut [f32]) {
    let n = real.len();
    let mut dc_sum = 0.0f32;
    for i in 0..n {
        out[i] = (real[i] * real[i] + imag[i] * imag[i]).sqrt();
        dc_sum += out[i];
    }
    let dc = dc_sum / n as f32;
    for i in 0..n { out[i] -= dc; }
}

pub fn measure_power(real: &[f32], imag: &[f32]) -> f32 {
    let mut sum = 0.0f32;
    for i in 0..real.len() { sum += real[i] * real[i] + imag[i] * imag[i]; }
    10.0 * (sum / real.len() as f32 + 1e-20).log10()
}

pub struct DeEmphasis {
    a: f32,
    b: f32,
    prev: f32,
}

impl DeEmphasis {
    pub fn new(sample_rate: f32, tau: f32) -> Self {
        let dt = 1.0 / sample_rate;
        let a = dt / (tau + dt);
        Self { a, b: 1.0 - a, prev: 0.0 }
    }
    pub fn process(&mut self, samples: &mut [f32]) {
        for s in samples.iter_mut() { self.prev = self.a * *s + self.b * self.prev; *s = self.prev; }
    }
    pub fn reset(&mut self) { self.prev = 0.0; }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    #[test]
    fn test_fm_constant_frequency() {
        let n = 256;
        let freq = 0.1f32;
        let mut real = vec![0.0f32; n];
        let mut imag = vec![0.0f32; n];
        for i in 0..n { real[i] = (2.0 * PI * freq * i as f32).cos(); imag[i] = (2.0 * PI * freq * i as f32).sin(); }
        let mut out = vec![0.0f32; n];
        demod_fm(&real, &imag, &mut out);
        let reference = out[2];
        for i in 3..n { assert!((out[i] - reference).abs() < 0.01); }
    }

    #[test]
    fn test_am_envelope() {
        let n = 512;
        let mut real = vec![0.0f32; n];
        let mut imag = vec![0.0f32; n];
        for i in 0..n {
            let env = 0.5 + 0.5 * (2.0 * PI * 0.01 * i as f32).cos();
            real[i] = env * (2.0 * PI * 0.25 * i as f32).cos();
            imag[i] = env * (2.0 * PI * 0.25 * i as f32).sin();
        }
        let mut out = vec![0.0f32; n];
        demod_am(&real, &imag, &mut out);
        let mut crossings = 0u32;
        for i in 1..n { if out[i - 1] * out[i] < 0.0 { crossings += 1; } }
        assert!(crossings > 6 && crossings < 16);
    }

    #[test]
    fn test_deemphasis_attenuates_high_freq() {
        let sr = 48000.0f32;
        let mut de = DeEmphasis::new(sr, 75e-6);
        let mut low = vec![0.0f32; 1000];
        for i in 0..1000 { low[i] = (2.0 * PI * 100.0 * i as f32 / sr).sin(); }
        de.process(&mut low);
        de.reset();
        let mut high = vec![0.0f32; 1000];
        for i in 0..1000 { high[i] = (2.0 * PI * 10000.0 * i as f32 / sr).sin(); }
        de.process(&mut high);
        let low_amp: f32 = low[800..].iter().map(|x| x.abs()).fold(0.0f32, f32::max);
        let high_amp: f32 = high[800..].iter().map(|x| x.abs()).fold(0.0f32, f32::max);
        assert!(low_amp > high_amp * 2.0);
    }
}
