use std::f32::consts::PI;

pub struct NcoMixer {
    phase: f32,
}

impl NcoMixer {
    pub fn new() -> Self { Self { phase: 0.0 } }
    pub fn reset(&mut self) { self.phase = 0.0; }

    pub fn mix(&mut self, real_in: &[f32], imag_in: &[f32], offset_hz: f32, sample_rate: f32, real_out: &mut [f32], imag_out: &mut [f32]) {
        let phase_inc = 2.0 * PI * offset_hz / sample_rate;
        for i in 0..real_in.len() {
            let cos_val = self.phase.cos();
            let sin_val = self.phase.sin();
            real_out[i] = real_in[i] * cos_val - imag_in[i] * sin_val;
            imag_out[i] = real_in[i] * sin_val + imag_in[i] * cos_val;
            self.phase += phase_inc;
            if self.phase > 2.0 * PI { self.phase -= 2.0 * PI; }
            if self.phase < -2.0 * PI { self.phase += 2.0 * PI; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mixer_dc_to_tone() {
        let mut mixer = NcoMixer::new();
        let n = 1024;
        let mut real_out = vec![0.0f32; n];
        let mut imag_out = vec![0.0f32; n];
        mixer.mix(&vec![1.0f32; n], &vec![0.0f32; n], 1000.0, 48000.0, &mut real_out, &mut imag_out);
        let mut crossings = 0u32;
        for i in 1..n { if real_out[i - 1] * real_out[i] < 0.0 { crossings += 1; } }
        assert!(crossings > 35 && crossings < 50);
    }
}
