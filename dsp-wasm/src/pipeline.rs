use crate::fft::{blackman_harris, fft, power_spectrum_shifted};
use crate::filter::{design_low_pass, decimate, FirFilter};
use crate::mixer::NcoMixer;
use crate::demod::{demod_fm, demod_am, measure_power, DeEmphasis};
use crate::ook::decode_ook;

const AUDIO_RATE: f32 = 48000.0;

pub struct DspConfig {
    pub sample_rate: u32,
    pub demod_mode: u8,
    pub fft_size: u32,
    pub squelch_level: f32,
    pub freq_offset: f32,
    pub ook_enabled: bool,
    pub channel_bw: f32,
    pub audio_enabled: bool,
}

pub struct DspState {
    pub config: DspConfig,
    window: Vec<f32>,
    dc_offset_i: f32,
    dc_offset_q: f32,
    mixer: NcoMixer,
    channel_filter: FirFilter,
    audio_filter: Option<FirFilter>,
    deemphasis: DeEmphasis,
    // Pre-allocated work buffers (reused across calls — no allocation in hot path)
    work_real: Vec<f32>,
    work_imag: Vec<f32>,
    work_mix_r: Vec<f32>,
    work_mix_i: Vec<f32>,
    work_fft_r: Vec<f32>,
    work_fft_i: Vec<f32>,
    work_ch_r: Vec<f32>,
    work_ch_i: Vec<f32>,
    work_audio: Vec<f32>,
    work_audio_imag: Vec<f32>,
    work_dec_r: Vec<f32>,
    work_dec_i: Vec<f32>,
    // Output buffers
    pub fft_out: Vec<f32>,
    pub audio_out: Vec<f32>,
    pub bits_out: Vec<u8>,
    pub squelch_open: bool,
}

fn default_bandwidth(mode: u8) -> f32 {
    match mode {
        0 => 200_000.0,
        1 => 12_500.0,
        2 => 10_000.0,
        _ => 200_000.0,
    }
}

impl DspState {
    pub fn new(sample_rate: u32, fft_size: u32) -> Self {
        let ch_bw = default_bandwidth(0);
        let channel_filter = FirFilter::new(design_low_pass(ch_bw / 2.0, sample_rate as f32, 63));
        let ch_rate = (sample_rate as f32).min(ch_bw * 2.0);
        let audio_filter = if ch_rate > AUDIO_RATE {
            Some(FirFilter::new(design_low_pass(AUDIO_RATE / 2.0, ch_rate, 31)))
        } else {
            None
        };

        Self {
            config: DspConfig {
                sample_rate, demod_mode: 0, fft_size, squelch_level: -60.0,
                freq_offset: 0.0, ook_enabled: false, channel_bw: ch_bw,
                audio_enabled: true,
            },
            window: blackman_harris(fft_size as usize),
            dc_offset_i: 0.0,
            dc_offset_q: 0.0,
            mixer: NcoMixer::new(),
            channel_filter,
            audio_filter,
            deemphasis: DeEmphasis::new(AUDIO_RATE, 75e-6),
            // Work buffers start empty, resize on first use (no realloc after that)
            work_real: Vec::new(),
            work_imag: Vec::new(),
            work_mix_r: Vec::new(),
            work_mix_i: Vec::new(),
            work_fft_r: Vec::new(),
            work_fft_i: Vec::new(),
            work_ch_r: Vec::new(),
            work_ch_i: Vec::new(),
            work_audio: Vec::new(),
            work_audio_imag: Vec::new(),
            work_dec_r: Vec::new(),
            work_dec_i: Vec::new(),
            fft_out: Vec::new(),
            audio_out: Vec::new(),
            bits_out: Vec::new(),
            squelch_open: false,
        }
    }

    pub fn update_config(&mut self, sample_rate: u32, demod_mode: u8, fft_size: u32,
                         squelch_level: f32, freq_offset: f32, ook_enabled: bool, channel_bw: f32,
                         audio_enabled: bool) {
        let mode_changed = demod_mode != self.config.demod_mode;
        let sr_changed = sample_rate != self.config.sample_rate;
        let fft_changed = fft_size != self.config.fft_size;
        let bw_changed = (channel_bw - self.config.channel_bw).abs() > 1.0;

        self.config = DspConfig { sample_rate, demod_mode, fft_size, squelch_level, freq_offset, ook_enabled, channel_bw, audio_enabled };

        if fft_changed { self.window = blackman_harris(fft_size as usize); }
        if mode_changed || sr_changed || bw_changed { self.rebuild_filters(); self.mixer.reset(); }
    }

    fn rebuild_filters(&mut self) {
        let sr = self.config.sample_rate as f32;
        let ch_bw = self.config.channel_bw;
        self.channel_filter = FirFilter::new(design_low_pass(ch_bw / 2.0, sr, 63));
        let ch_rate = sr.min(ch_bw * 2.0);
        self.audio_filter = if ch_rate > AUDIO_RATE {
            Some(FirFilter::new(design_low_pass(AUDIO_RATE / 2.0, ch_rate, 31)))
        } else { None };
        self.deemphasis.reset();
    }

    /// Process raw int8 IQ data from HackRF (avoids float conversion on main thread).
    pub fn process_iq_raw(&mut self, raw: &[u8]) {
        let n = raw.len() / 2;

        // Resize work buffers (no-op after first call with same size)
        self.work_real.resize(n, 0.0);
        self.work_imag.resize(n, 0.0);

        // Convert int8 → float32 + deinterleave + DC block in one pass
        let dc_rate = 50.0 / self.config.sample_rate as f32;
        for i in 0..n {
            let raw_i = (raw[i * 2] as i8) as f32 / 128.0;
            let raw_q = (raw[i * 2 + 1] as i8) as f32 / 128.0;
            let corr_i = raw_i - self.dc_offset_i;
            self.dc_offset_i += corr_i * dc_rate;
            self.work_real[i] = corr_i;
            let corr_q = raw_q - self.dc_offset_q;
            self.dc_offset_q += corr_q * dc_rate;
            self.work_imag[i] = corr_q;
        }

        self.process_fft(n);
        if self.config.audio_enabled {
            self.process_audio(n);
        } else {
            self.audio_out.clear();
            self.squelch_open = false;
        }
        if self.config.ook_enabled {
            decode_ook(&self.work_real[..n], &self.work_imag[..n],
                       self.config.sample_rate as f32, &mut self.bits_out);
        } else {
            self.bits_out.clear();
        }
    }

    fn process_fft(&mut self, sample_count: usize) {
        let n = self.config.fft_size as usize;
        self.work_fft_r.resize(n, 0.0);
        self.work_fft_i.resize(n, 0.0);
        let offset = if sample_count > n { sample_count - n } else { 0 };
        let copy_len = n.min(sample_count);
        for i in 0..n {
            if i < copy_len {
                self.work_fft_r[i] = self.work_real[offset + i] * self.window[i];
                self.work_fft_i[i] = self.work_imag[offset + i] * self.window[i];
            } else {
                self.work_fft_r[i] = 0.0;
                self.work_fft_i[i] = 0.0;
            }
        }
        fft(&mut self.work_fft_r, &mut self.work_fft_i);
        power_spectrum_shifted(&self.work_fft_r, &self.work_fft_i, &mut self.fft_out);
    }

    fn process_audio(&mut self, sample_count: usize) {
        let sr = self.config.sample_rate as f32;
        let n = sample_count;

        // Mixer (frequency offset)
        let (sig_r, sig_i) = if self.config.freq_offset != 0.0 {
            self.work_mix_r.resize(n, 0.0);
            self.work_mix_i.resize(n, 0.0);
            self.mixer.mix(
                &self.work_real[..n], &self.work_imag[..n],
                -self.config.freq_offset, sr,
                &mut self.work_mix_r, &mut self.work_mix_i,
            );
            (&self.work_mix_r[..n], &self.work_mix_i[..n])
        } else {
            (&self.work_real[..n], &self.work_imag[..n])
        };

        // Channel decimation
        let ch_bw = self.config.channel_bw;
        let ch_dec = (sr / (ch_bw * 2.0)).floor().max(1.0) as usize;

        let (ch_r, ch_i, ch_len) = if ch_dec > 1 {
            decimate(sig_r, sig_i, ch_dec, &mut self.channel_filter,
                     &mut self.work_ch_r, &mut self.work_ch_i);
            let l = self.work_ch_r.len();
            (&self.work_ch_r[..], &self.work_ch_i[..], l)
        } else {
            (sig_r, sig_i, n)
        };

        // Squelch
        let power = measure_power(&ch_r[..ch_len], &ch_i[..ch_len]);
        self.squelch_open = power > self.config.squelch_level;

        // Demodulate
        self.work_audio.resize(ch_len, 0.0);
        match self.config.demod_mode {
            0 | 1 => {
                demod_fm(&ch_r[..ch_len], &ch_i[..ch_len], &mut self.work_audio);
                if self.config.demod_mode == 0 { self.deemphasis.process(&mut self.work_audio[..ch_len]); }
            }
            _ => { demod_am(&ch_r[..ch_len], &ch_i[..ch_len], &mut self.work_audio); }
        }

        // Audio decimation to 48 kHz
        let ch_rate = sr / ch_dec as f32;
        let audio_dec = (ch_rate / AUDIO_RATE).floor().max(1.0) as usize;
        if audio_dec > 1 {
            if let Some(ref mut af) = self.audio_filter {
                self.work_audio_imag.resize(ch_len, 0.0);
                self.work_audio_imag[..ch_len].fill(0.0);
                decimate(&self.work_audio[..ch_len], &self.work_audio_imag[..ch_len],
                         audio_dec, af, &mut self.work_dec_r, &mut self.work_dec_i);
                // Swap into audio_out without allocation
                std::mem::swap(&mut self.audio_out, &mut self.work_dec_r);
            } else {
                self.audio_out.resize(ch_len, 0.0);
                self.audio_out[..ch_len].copy_from_slice(&self.work_audio[..ch_len]);
            }
        } else {
            self.audio_out.resize(ch_len, 0.0);
            self.audio_out[..ch_len].copy_from_slice(&self.work_audio[..ch_len]);
        }
    }
}
