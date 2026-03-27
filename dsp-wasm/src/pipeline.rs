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
}

pub struct DspState {
    pub config: DspConfig,
    window: Vec<f32>,
    mixer: NcoMixer,
    channel_filter: FirFilter,
    audio_filter: Option<FirFilter>,
    deemphasis: DeEmphasis,
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
            },
            window: blackman_harris(fft_size as usize),
            mixer: NcoMixer::new(),
            channel_filter,
            audio_filter,
            deemphasis: DeEmphasis::new(AUDIO_RATE, 75e-6),
            fft_out: Vec::new(),
            audio_out: Vec::new(),
            bits_out: Vec::new(),
            squelch_open: false,
        }
    }

    pub fn update_config(&mut self, sample_rate: u32, demod_mode: u8, fft_size: u32,
                         squelch_level: f32, freq_offset: f32, ook_enabled: bool, channel_bw: f32) {
        let mode_changed = demod_mode != self.config.demod_mode;
        let sr_changed = sample_rate != self.config.sample_rate;
        let fft_changed = fft_size != self.config.fft_size;
        let bw_changed = (channel_bw - self.config.channel_bw).abs() > 1.0;

        self.config = DspConfig { sample_rate, demod_mode, fft_size, squelch_level, freq_offset, ook_enabled, channel_bw };

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

    pub fn process_iq(&mut self, iq: &[f32]) {
        let n = iq.len() / 2;
        let mut real = vec![0.0f32; n];
        let mut imag = vec![0.0f32; n];
        for i in 0..n {
            real[i] = iq[i * 2];
            imag[i] = iq[i * 2 + 1];
        }
        self.process_fft(&real, &imag);
        self.process_audio(&mut real, &mut imag);
        if self.config.ook_enabled {
            self.process_ook(&real, &imag);
        } else {
            self.bits_out.clear();
        }
    }

    fn process_fft(&mut self, real: &[f32], imag: &[f32]) {
        let n = self.config.fft_size as usize;
        let mut fft_r = vec![0.0f32; n];
        let mut fft_i = vec![0.0f32; n];
        let offset = if real.len() > n { real.len() - n } else { 0 };
        let copy_len = n.min(real.len());
        for i in 0..copy_len {
            fft_r[i] = real[offset + i] * self.window[i];
            fft_i[i] = imag[offset + i] * self.window[i];
        }
        fft(&mut fft_r, &mut fft_i);
        power_spectrum_shifted(&fft_r, &fft_i, &mut self.fft_out);
    }

    fn process_audio(&mut self, real: &mut [f32], imag: &mut [f32]) {
        let sr = self.config.sample_rate as f32;
        let n = real.len();

        if self.config.freq_offset != 0.0 {
            let mut mix_r = vec![0.0f32; n];
            let mut mix_i = vec![0.0f32; n];
            self.mixer.mix(real, imag, -self.config.freq_offset, sr, &mut mix_r, &mut mix_i);
            real.copy_from_slice(&mix_r);
            imag.copy_from_slice(&mix_i);
        }

        let ch_bw = self.config.channel_bw;
        let ch_dec = (sr / (ch_bw * 2.0)).floor().max(1.0) as usize;
        let (ch_r, ch_i) = if ch_dec > 1 {
            let mut out_r = Vec::new();
            let mut out_i = Vec::new();
            decimate(real, imag, ch_dec, &mut self.channel_filter, &mut out_r, &mut out_i);
            (out_r, out_i)
        } else {
            (real.to_vec(), imag.to_vec())
        };

        let power = measure_power(&ch_r, &ch_i);
        self.squelch_open = power > self.config.squelch_level;

        let mut audio = vec![0.0f32; ch_r.len()];
        match self.config.demod_mode {
            0 | 1 => {
                demod_fm(&ch_r, &ch_i, &mut audio);
                if self.config.demod_mode == 0 { self.deemphasis.process(&mut audio); }
            }
            _ => { demod_am(&ch_r, &ch_i, &mut audio); }
        }

        let ch_rate = sr / ch_dec as f32;
        let audio_dec = (ch_rate / AUDIO_RATE).floor().max(1.0) as usize;
        if audio_dec > 1 {
            if let Some(ref mut af) = self.audio_filter {
                let imag_zeros = vec![0.0f32; audio.len()];
                let mut out_r = Vec::new();
                let mut out_i = Vec::new();
                decimate(&audio, &imag_zeros, audio_dec, af, &mut out_r, &mut out_i);
                self.audio_out = out_r;
            } else { self.audio_out = audio; }
        } else { self.audio_out = audio; }
    }

    fn process_ook(&mut self, real: &[f32], imag: &[f32]) {
        decode_ook(real, imag, self.config.sample_rate as f32, &mut self.bits_out);
    }
}
