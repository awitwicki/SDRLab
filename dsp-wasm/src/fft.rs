use std::f32::consts::PI;

pub fn blackman_harris(n: usize) -> Vec<f32> {
    let mut w = vec![0.0f32; n];
    let a0: f32 = 0.35875;
    let a1: f32 = 0.48829;
    let a2: f32 = 0.14128;
    let a3: f32 = 0.01168;
    for i in 0..n {
        let x = 2.0 * PI * i as f32 / (n - 1) as f32;
        w[i] = a0 - a1 * x.cos() + a2 * (2.0 * x).cos() - a3 * (3.0 * x).cos();
    }
    w
}

pub fn fft(real: &mut [f32], imag: &mut [f32]) {
    let n = real.len();
    let mut j: usize = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 { j ^= bit; bit >>= 1; }
        j ^= bit;
        if i < j { real.swap(i, j); imag.swap(i, j); }
    }
    let mut len = 2;
    while len <= n {
        let half = len / 2;
        let angle = -2.0 * PI / len as f32;
        let w_real = angle.cos();
        let w_imag = angle.sin();
        let mut i = 0;
        while i < n {
            let mut cur_real = 1.0f32;
            let mut cur_imag = 0.0f32;
            for k in 0..half {
                let u_real = real[i + k];
                let u_imag = imag[i + k];
                let v_real = real[i + k + half] * cur_real - imag[i + k + half] * cur_imag;
                let v_imag = real[i + k + half] * cur_imag + imag[i + k + half] * cur_real;
                real[i + k] = u_real + v_real;
                imag[i + k] = u_imag + v_imag;
                real[i + k + half] = u_real - v_real;
                imag[i + k + half] = u_imag - v_imag;
                let next_real = cur_real * w_real - cur_imag * w_imag;
                cur_imag = cur_real * w_imag + cur_imag * w_real;
                cur_real = next_real;
            }
            i += len;
        }
        len *= 2;
    }
}

pub fn power_spectrum_shifted(real: &[f32], imag: &[f32], out: &mut Vec<f32>) {
    let n = real.len();
    out.resize(n, 0.0);
    let half = n / 2;
    for i in 0..n {
        let src = (i + half) % n;
        let mag2 = real[src] * real[src] + imag[src] * imag[src];
        out[i] = 10.0 * (mag2 + 1e-20).log10();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blackman_harris_length() {
        assert_eq!(blackman_harris(256).len(), 256);
    }

    #[test]
    fn test_blackman_harris_symmetric() {
        let w = blackman_harris(256);
        for i in 0..128 { assert!((w[i] - w[255 - i]).abs() < 1e-5); }
    }

    #[test]
    fn test_fft_dc_signal() {
        let n = 64;
        let mut real = vec![1.0f32; n];
        let mut imag = vec![0.0f32; n];
        fft(&mut real, &mut imag);
        let mag0 = (real[0] * real[0] + imag[0] * imag[0]).sqrt();
        assert!((mag0 - n as f32).abs() < 0.1);
        for i in 1..n {
            let mag = (real[i] * real[i] + imag[i] * imag[i]).sqrt();
            assert!(mag < 1e-4);
        }
    }

    #[test]
    fn test_fft_cosine_bin() {
        let n = 256;
        let mut real = vec![0.0f32; n];
        let mut imag = vec![0.0f32; n];
        for i in 0..n { real[i] = (2.0 * PI * 10.0 * i as f32 / n as f32).cos(); }
        fft(&mut real, &mut imag);
        let mag10 = (real[10] * real[10] + imag[10] * imag[10]).sqrt();
        assert!((mag10 - n as f32 / 2.0).abs() < 1.0);
    }
}
