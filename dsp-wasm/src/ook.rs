pub fn decode_ook(real: &[f32], imag: &[f32], sample_rate: f32, out: &mut Vec<u8>) {
    out.clear();
    let n = real.len();
    if n == 0 { return; }

    let mut envelope = vec![0.0f32; n];
    for i in 0..n { envelope[i] = (real[i] * real[i] + imag[i] * imag[i]).sqrt(); }

    let window = (sample_rate / 200_000.0).max(1.0) as usize;
    let mut smoothed = vec![0.0f32; n];
    let mut running_sum = 0.0f32;
    for i in 0..n {
        running_sum += envelope[i];
        if i >= window { running_sum -= envelope[i - window]; }
        smoothed[i] = running_sum / window.min(i + 1) as f32;
    }

    let min_val = smoothed.iter().cloned().fold(f32::INFINITY, f32::min);
    let max_val = smoothed.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let threshold = (min_val + max_val) / 2.0;

    let mut current_bit: u8 = if smoothed[0] > threshold { 1 } else { 0 };
    let mut start_sample: u32 = 0;

    for i in 1..n {
        let bit: u8 = if smoothed[i] > threshold { 1 } else { 0 };
        if bit != current_bit {
            let duration = i as u32 - start_sample;
            let duration_us = duration as f64 / sample_rate as f64 * 1e6;
            serialize_event(out, current_bit, start_sample, duration, duration_us);
            current_bit = bit;
            start_sample = i as u32;
        }
    }
    let duration = n as u32 - start_sample;
    let duration_us = duration as f64 / sample_rate as f64 * 1e6;
    serialize_event(out, current_bit, start_sample, duration, duration_us);
}

fn serialize_event(out: &mut Vec<u8>, bit: u8, start: u32, duration: u32, duration_us: f64) {
    out.push(bit);
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&duration.to_le_bytes());
    out.extend_from_slice(&duration_us.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generate_ook(bits: &[u8], samples_per_bit: usize) -> (Vec<f32>, Vec<f32>) {
        let n = bits.len() * samples_per_bit;
        let mut real = vec![0.0f32; n];
        let imag = vec![0.0f32; n];
        for (b, &bit) in bits.iter().enumerate() {
            for s in 0..samples_per_bit {
                real[b * samples_per_bit + s] = if bit == 1 { 1.0 } else { 0.0 };
            }
        }
        (real, imag)
    }

    #[test]
    fn test_alternating_bits() {
        let (real, imag) = generate_ook(&[1, 0, 1, 0, 1, 0], 100);
        let mut out = Vec::new();
        decode_ook(&real, &imag, 100_000.0, &mut out);
        assert_eq!(out.len() / 17, 6);
        assert_eq!(out[0], 1);
        assert_eq!(out[17], 0);
    }

    #[test]
    fn test_silence_is_zero() {
        let real = vec![0.0f32; 1000];
        let imag = vec![0.0f32; 1000];
        let mut out = Vec::new();
        decode_ook(&real, &imag, 100_000.0, &mut out);
        assert_eq!(out.len(), 17);
        assert_eq!(out[0], 0);
    }
}
