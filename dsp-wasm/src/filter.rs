use std::f32::consts::PI;

pub fn design_low_pass(cutoff_hz: f32, sample_rate: f32, num_taps: usize) -> Vec<f32> {
    let mut taps = vec![0.0f32; num_taps];
    let fc = cutoff_hz / sample_rate;
    let m = (num_taps - 1) as f32 / 2.0;
    for i in 0..num_taps {
        let x = i as f32 - m;
        taps[i] = if x.abs() < 1e-10 { 2.0 * fc } else { (2.0 * PI * fc * x).sin() / (PI * x) };
        let w = 0.42 - 0.5 * (2.0 * PI * i as f32 / (num_taps - 1) as f32).cos()
               + 0.08 * (4.0 * PI * i as f32 / (num_taps - 1) as f32).cos();
        taps[i] *= w;
    }
    let sum: f32 = taps.iter().sum();
    for t in &mut taps { *t /= sum; }
    while taps.len() % 4 != 0 { taps.push(0.0); }
    taps
}

/// FIR filter using a double-buffer delay line for zero-allocation SIMD.
/// Each sample is written at pos AND pos+num_taps, so the SIMD inner loop
/// always reads a contiguous slice without copying or linearizing.
pub struct FirFilter {
    rev_taps: Vec<f32>,    // taps reversed — for direct dot product with delay line
    delay_r: Vec<f32>,     // length = 2 * num_taps
    delay_i: Vec<f32>,
    pos: usize,            // write position, 0..num_taps-1
    num_taps: usize,
}

impl FirFilter {
    pub fn new(taps: Vec<f32>) -> Self {
        let n = taps.len();
        let mut rev_taps = taps;
        rev_taps.reverse();
        Self {
            rev_taps,
            delay_r: vec![0.0; 2 * n],
            delay_i: vec![0.0; 2 * n],
            pos: 0,
            num_taps: n,
        }
    }

    pub fn reset(&mut self) {
        self.delay_r.fill(0.0);
        self.delay_i.fill(0.0);
        self.pos = 0;
    }

    pub fn process(&mut self, real_in: &[f32], imag_in: &[f32], real_out: &mut [f32], imag_out: &mut [f32]) {
        for i in 0..real_in.len() {
            // Write to both halves of the double buffer
            self.delay_r[self.pos] = real_in[i];
            self.delay_r[self.pos + self.num_taps] = real_in[i];
            self.delay_i[self.pos] = imag_in[i];
            self.delay_i[self.pos + self.num_taps] = imag_in[i];

            self.pos = (self.pos + 1) % self.num_taps;

            // Contiguous slice from pos..pos+num_taps = oldest to newest
            // dot product with rev_taps (which is taps reversed) = FIR convolution
            let (sr, si) = self.convolve();
            real_out[i] = sr;
            imag_out[i] = si;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn convolve(&self) -> (f32, f32) {
        let mut sum_r = 0.0f32;
        let mut sum_i = 0.0f32;
        let start = self.pos; // oldest sample
        for j in 0..self.num_taps {
            sum_r += self.rev_taps[j] * self.delay_r[start + j];
            sum_i += self.rev_taps[j] * self.delay_i[start + j];
        }
        (sum_r, sum_i)
    }

    #[cfg(target_arch = "wasm32")]
    fn convolve(&self) -> (f32, f32) {
        use core::arch::wasm32::*;
        unsafe {
            let mut acc_r = f32x4_splat(0.0);
            let mut acc_i = f32x4_splat(0.0);
            let start = self.pos;
            for j in (0..self.num_taps).step_by(4) {
                let t = v128_load(self.rev_taps[j..].as_ptr() as *const v128);
                let sr = v128_load(self.delay_r[start + j..].as_ptr() as *const v128);
                let si = v128_load(self.delay_i[start + j..].as_ptr() as *const v128);
                acc_r = f32x4_add(acc_r, f32x4_mul(t, sr));
                acc_i = f32x4_add(acc_i, f32x4_mul(t, si));
            }
            let sum_r = f32x4_extract_lane::<0>(acc_r) + f32x4_extract_lane::<1>(acc_r)
                      + f32x4_extract_lane::<2>(acc_r) + f32x4_extract_lane::<3>(acc_r);
            let sum_i = f32x4_extract_lane::<0>(acc_i) + f32x4_extract_lane::<1>(acc_i)
                      + f32x4_extract_lane::<2>(acc_i) + f32x4_extract_lane::<3>(acc_i);
            (sum_r, sum_i)
        }
    }
}

/// Decimate: filter then downsample. Uses pre-allocated output buffers.
pub fn decimate(
    real_in: &[f32], imag_in: &[f32], factor: usize, filter: &mut FirFilter,
    real_out: &mut Vec<f32>, imag_out: &mut Vec<f32>,
) {
    let n = real_in.len();
    // Resize output buffers (no alloc if already large enough)
    let out_len = n / factor;
    real_out.resize(out_len, 0.0);
    imag_out.resize(out_len, 0.0);

    // Process directly into decimated output — skip filter for non-output samples
    // For simplicity, filter all then pick. Use a scratch buffer in the filter.
    // TODO: optimize to only compute output samples
    let mut filtered_r = vec![0.0f32; n];
    let mut filtered_i = vec![0.0f32; n];
    filter.process(real_in, imag_in, &mut filtered_r, &mut filtered_i);
    for i in 0..out_len {
        real_out[i] = filtered_r[i * factor];
        imag_out[i] = filtered_i[i * factor];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_taps_padded() {
        let taps = design_low_pass(1000.0, 10000.0, 31);
        assert_eq!(taps.len() % 4, 0);
    }

    #[test]
    fn test_taps_unity_dc() {
        let taps = design_low_pass(1000.0, 10000.0, 31);
        let sum: f32 = taps.iter().sum();
        assert!((sum - 1.0).abs() < 0.05);
    }

    #[test]
    fn test_filter_dc_passthrough() {
        let taps = design_low_pass(5000.0, 48000.0, 31);
        let mut filter = FirFilter::new(taps);
        let real_in = vec![1.0f32; 100];
        let imag_in = vec![0.0f32; 100];
        let mut real_out = vec![0.0f32; 100];
        let mut imag_out = vec![0.0f32; 100];
        filter.process(&real_in, &imag_in, &mut real_out, &mut imag_out);
        for i in 40..100 { assert!((real_out[i] - 1.0).abs() < 0.1); }
    }

    #[test]
    fn test_decimate_length() {
        let taps = design_low_pass(5000.0, 48000.0, 31);
        let mut filter = FirFilter::new(taps);
        let mut r = Vec::new();
        let mut i = Vec::new();
        decimate(&vec![1.0f32; 100], &vec![0.0f32; 100], 4, &mut filter, &mut r, &mut i);
        assert_eq!(r.len(), 25);
    }
}
