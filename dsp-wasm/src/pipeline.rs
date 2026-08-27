use crate::fft::{blackman_harris, fft, power_spectrum_shifted};
use crate::filter::{design_low_pass, FirFilter};
use crate::mixer::NcoMixer;
use crate::demod::{demod_fm, demod_am, measure_power, DeEmphasis};
use crate::ook::decode_ook;
use crate::resampler::LinearResampler;
use crate::rds::{RdsBlockDecoder, RdsFrontEnd};

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
    window_norm: f32,
    dc_offset_i: f32,
    dc_offset_q: f32,
    mixer: NcoMixer,
    /// Channel decimation as a chain of `(filter, decimation factor)` stages,
    /// applied in order. Empty ⇒ no channel decimation (passthrough).
    channel_stages: Vec<(FirFilter, usize)>,
    audio_filter: Option<FirFilter>,
    deemphasis: DeEmphasis,
    rds_front: RdsFrontEnd,
    pub rds_blocks: RdsBlockDecoder,
    // Pre-allocated work buffers (reused across calls — no allocation in hot path)
    work_real: Vec<f32>,
    work_imag: Vec<f32>,
    work_mix_r: Vec<f32>,
    work_mix_i: Vec<f32>,
    work_fft_r: Vec<f32>,
    work_fft_i: Vec<f32>,
    work_ch_r: Vec<f32>,
    work_ch_i: Vec<f32>,
    // Second half of the ping-pong pair the channel stages alternate through.
    work_st_r: Vec<f32>,
    work_st_i: Vec<f32>,
    work_audio: Vec<f32>,
    work_audio_imag: Vec<f32>,
    work_dec_r: Vec<f32>,
    work_dec_i: Vec<f32>,
    work_res: Vec<f32>,
    audio_resampler: LinearResampler,
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

/// Tap count floor for a decimating stage. `stage_taps` derives the real length
/// from the stage's transition requirement; this is only a sanity floor for the
/// window design. It is deliberately low: a Blackman-windowed FIR's stopband
/// depth (~-58 dB) comes from the window, not its length, so padding an early
/// stage out to 63 taps buys no extra rejection and doubles the cost of the
/// stage that runs at the highest rate.
const MIN_STAGE_TAPS: usize = 15;
/// Length of the final shaping filter. At the channel rate (>= 2 * ch_bw) 63
/// taps put its transition at ~ch_bw/10, i.e. flat across most of the channel
/// and into the stopband before the band edge.
const SHAPING_TAPS: usize = 63;
/// Tap count ceiling for a channel stage. Only approached when `ch_dec` has a
/// large prime factor, which has to be taken in one big stage (see
/// `stage_factor`). A decimating FIR costs `taps / factor` multiplies per input
/// sample, so a 769× stage with 8192 taps is no more expensive per sample than
/// an 8× stage with 63 — the ceiling is about bounding memory, not CPU.
const MAX_STAGE_TAPS: usize = 8192;

/// How much the channel path decimates the input rate before demodulation.
///
/// `rebuild_filters` splits this across the stage chain while the de-emphasis,
/// audio decimation and output resampler rates are all derived from it, and
/// `process_audio` re-derives it for the audio rate — so all of them have to
/// agree, which is why it lives in one place. The clamp only guards against a
/// zero/negative bandwidth saturating the cast to `usize::MAX`; over every
/// bandwidth the UI can produce it is exactly `floor(sr / (2 * ch_bw))`.
fn channel_decimation(sr: f32, ch_bw: f32) -> usize {
    let dec = (sr / (ch_bw * 2.0)).floor();
    if !(dec >= 1.0) { return 1; } // also catches NaN
    dec.min(sr.max(1.0)) as usize
}

/// Smallest prime factor of `n` (`n >= 2`); `n` itself when `n` is prime.
fn smallest_prime_factor(n: usize) -> usize {
    let mut f = 2usize;
    while f * f <= n {
        if n % f == 0 { return f; }
        f += 1;
    }
    n
}

/// Decimation factor for the next channel stage: the largest divisor of
/// `remaining` that is at most 8, so the chain walks down in small steps and
/// every stage's filter stays short. When `remaining` has no divisor in 2..=8
/// (it is a prime > 8, or a power of one) fall back to its smallest prime
/// factor — a single large stage, which `stage_taps` then sizes for.
///
/// The returned factor always divides `remaining` and is >= 2 for
/// `remaining >= 2`, so the stage loop always terminates.
fn stage_factor(remaining: usize) -> usize {
    for f in (2..=8).rev() {
        if remaining % f == 0 { return f; }
    }
    smallest_prime_factor(remaining)
}

/// Taps a stage needs to decimate `rate` by `factor` without folding anything
/// onto the `ch_bw`-wide channel.
///
/// The stage's output rate is `out = rate / factor`, and decimation folds
/// frequencies modulo `out`, so the lowest frequency that can land inside the
/// channel is `out - ch_bw/2`. The filter therefore has to be flat out to
/// `ch_bw/2` and dead from `out - ch_bw/2` on. Centring the cutoff at `out/2`
/// (see `rebuild_filters`) splits that guard band evenly, leaving a one-sided
/// transition budget of `(out - ch_bw) / 2`.
///
/// A Blackman-windowed FIR reaches its stopband about `3 * rate / taps` past
/// the cutoff, so the budget is met when `taps >= 6 * rate / (out - ch_bw)`.
/// `out > 2 * ch_bw` always holds — `ch_dec` is floored, so the final channel
/// rate is at least `2 * ch_bw`, and every earlier stage runs faster still —
/// which bounds the requirement at `12 * factor` taps.
fn stage_taps(rate: f32, factor: usize, ch_bw: f32) -> usize {
    let guard = rate / factor as f32 - ch_bw;
    if guard <= 0.0 { return MAX_STAGE_TAPS; }
    let need = (6.0 * rate / guard).ceil();
    if need >= MAX_STAGE_TAPS as f32 { return MAX_STAGE_TAPS; }
    (need as usize).max(MIN_STAGE_TAPS)
}

impl DspState {
    pub fn new(sample_rate: u32, fft_size: u32) -> Self {
        let ch_bw = default_bandwidth(0);
        let window = blackman_harris(fft_size as usize);
        let wsum: f32 = window.iter().sum();
        let window_norm = wsum * wsum;

        let mut state = Self {
            config: DspConfig {
                sample_rate, demod_mode: 0, fft_size, squelch_level: -60.0,
                freq_offset: 0.0, ook_enabled: false, channel_bw: ch_bw,
                audio_enabled: true,
            },
            window,
            window_norm,
            dc_offset_i: 0.0,
            dc_offset_q: 0.0,
            mixer: NcoMixer::new(),
            // Both filled in by rebuild_filters() below.
            channel_stages: Vec::new(),
            audio_filter: None,
            deemphasis: DeEmphasis::new(AUDIO_RATE, 75e-6),
            // Rate reconfigured for real by rebuild_filters() below (once
            // ch_rate_actual is known); the placeholder here just needs to be
            // a valid RdsFrontEnd (it stays idle below MIN_USABLE_FS).
            rds_front: RdsFrontEnd::new(AUDIO_RATE),
            rds_blocks: RdsBlockDecoder::new(),
            // Work buffers start empty, resize on first use (no realloc after that)
            work_real: Vec::new(),
            work_imag: Vec::new(),
            work_mix_r: Vec::new(),
            work_mix_i: Vec::new(),
            work_fft_r: Vec::new(),
            work_fft_i: Vec::new(),
            work_ch_r: Vec::new(),
            work_ch_i: Vec::new(),
            work_st_r: Vec::new(),
            work_st_i: Vec::new(),
            work_audio: Vec::new(),
            work_audio_imag: Vec::new(),
            work_dec_r: Vec::new(),
            work_dec_i: Vec::new(),
            work_res: Vec::new(),
            audio_resampler: LinearResampler::new(AUDIO_RATE as f64, AUDIO_RATE as f64),
            fft_out: Vec::new(),
            audio_out: Vec::new(),
            bits_out: Vec::new(),
            squelch_open: false,
        };
        state.rebuild_filters();
        state
    }

    pub fn update_config(&mut self, sample_rate: u32, demod_mode: u8, fft_size: u32,
                         squelch_level: f32, freq_offset: f32, ook_enabled: bool, channel_bw: f32,
                         audio_enabled: bool) {
        let mode_changed = demod_mode != self.config.demod_mode;
        let sr_changed = sample_rate != self.config.sample_rate;
        let fft_changed = fft_size != self.config.fft_size;
        let bw_changed = (channel_bw - self.config.channel_bw).abs() > 1.0;

        self.config = DspConfig { sample_rate, demod_mode, fft_size, squelch_level, freq_offset, ook_enabled, channel_bw, audio_enabled };

        if fft_changed {
            self.window = blackman_harris(fft_size as usize);
            let wsum: f32 = self.window.iter().sum();
            self.window_norm = wsum * wsum;
        }
        if mode_changed || sr_changed || bw_changed { self.rebuild_filters(); self.mixer.reset(); }
    }

    /// Clears decoded RDS station state (PI/PS/RT/version) back to empty.
    /// Called on a retune, from the JS side (see wasm_reset_rds in lib.rs):
    /// nothing in update_config's mode/sample-rate/bandwidth-changed checks
    /// fires on a plain "same mode, different frequency" retune (frequency
    /// isn't even part of this struct's config — see DspConfig), so without
    /// an explicit reset a station's name would linger forever after
    /// tuning away from it. `rds_front`'s own state (Costas loop, timing
    /// recovery) survives a reset since retuning to the same signal
    /// shouldn't require reacquiring carrier lock; its `last_flip_lost`
    /// counter self-corrects on the next half-bit if it observes the block
    /// decoder's counter went backwards (see rds.rs's on_half_bit), so
    /// there's no need for this function to reach into it.
    pub fn reset_rds(&mut self) {
        self.rds_blocks = RdsBlockDecoder::new();
    }

    fn rebuild_filters(&mut self) {
        let sr = self.config.sample_rate as f32;
        let ch_bw = self.config.channel_bw;

        let ch_dec = channel_decimation(sr, ch_bw);
        let ch_rate_actual = sr / ch_dec as f32;

        // Channel decimation, split into stages whose product is exactly
        // `ch_dec` (so every downstream rate is unchanged). A single filter at
        // the full input rate cannot do this job: its transition is a fixed
        // fraction of the rate it runs at — ~sr/21 for 63 taps, i.e. 95 kHz at
        // 2 Msps — so for an 8 kHz channel it passes everything decimation is
        // about to fold on top of the audio. Each stage instead runs at its own
        // successively lower rate, where the same taps buy a proportionally
        // narrower transition, and only has to reject what ITS decimation
        // folds in.
        self.channel_stages.clear();
        let mut rate = sr;
        let mut remaining = ch_dec;
        while remaining > 1 {
            let factor = stage_factor(remaining);
            let taps = stage_taps(rate, factor, ch_bw);
            let out_rate = rate / factor as f32;
            // Halfway between the channel edge (ch_bw/2, which must survive)
            // and the first frequency that folds onto it (out_rate - ch_bw/2,
            // which must not) — the placement that gives the transition equal
            // room on both sides.
            let cutoff = (out_rate / 2.0).max(ch_bw / 2.0);
            self.channel_stages.push((FirFilter::new(design_low_pass(cutoff, rate, taps)), factor));
            rate = out_rate;
            remaining /= factor;
        }
        if !self.channel_stages.is_empty() {
            // Final shaping pass, no decimation. The stages above deliberately
            // keep their cutoffs wide (out_rate/2) to leave transition room;
            // this is what actually narrows the channel to ch_bw. It runs at
            // ch_rate_actual >= 2*ch_bw, so its transition is at most
            // ch_bw/5 — sharp enough to be a real channel filter.
            self.channel_stages.push((
                FirFilter::new(design_low_pass(ch_bw / 2.0, ch_rate_actual, SHAPING_TAPS)), 1));
        }

        let audio_dec = (ch_rate_actual / AUDIO_RATE).floor().max(1.0) as usize;

        self.deemphasis = DeEmphasis::new(ch_rate_actual, 75e-6);
        // RDS is decoded from work_audio, which runs at ch_rate_actual (see
        // process_audio) — every rate-dependent RDS constant is re-derived
        // here whenever that rate changes.
        self.rds_front.set_rate(ch_rate_actual);
        self.audio_filter = if audio_dec > 1 {
            Some(FirFilter::new(design_low_pass(AUDIO_RATE / 2.0, ch_rate_actual, 31)))
        } else { None };

        let pre_resample_rate = ch_rate_actual / audio_dec as f32;
        self.audio_resampler.reset(pre_resample_rate as f64, AUDIO_RATE as f64);
    }

    /// Process raw int8 IQ data from HackRF (avoids float conversion on main thread).
    pub fn process_iq_raw(&mut self, raw: &[u8], compute_fft: bool) {
        let n = raw.len() / 2;

        // Resize work buffers (no-op after first call with same size)
        self.work_real.resize(n, 0.0);
        self.work_imag.resize(n, 0.0);

        // Convert int8 → float32 + deinterleave, conditionally apply DC block
        // DC block is needed for FM (to remove HackRF center spike) but destroys
        // AM/OOK signals that legitimately sit at the carrier center.
        let dc_block = self.config.demod_mode != 2 && !self.config.ook_enabled;
        let dc_rate = 50.0 / self.config.sample_rate as f32;
        if dc_block {
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
        } else {
            for i in 0..n {
                self.work_real[i] = (raw[i * 2] as i8) as f32 / 128.0;
                self.work_imag[i] = (raw[i * 2 + 1] as i8) as f32 / 128.0;
            }
        }

        if compute_fft {
            self.process_fft(n);
        } else {
            self.fft_out.clear();
        }
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
        power_spectrum_shifted(&self.work_fft_r, &self.work_fft_i, self.window_norm, &mut self.fft_out);
    }

    #[cfg(test)]
    pub fn deemphasis_a(&self) -> f32 { self.deemphasis.a() }

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
        let ch_dec = channel_decimation(sr, ch_bw);

        // Run the stage chain, ping-ponging between the two work buffer pairs.
        // The stages are built so their factors multiply to exactly `ch_dec`;
        // an empty chain means ch_dec == 1, i.e. passthrough.
        let (ch_r, ch_i, ch_len) = if !self.channel_stages.is_empty() {
            let mut cur_r = std::mem::take(&mut self.work_ch_r);
            let mut cur_i = std::mem::take(&mut self.work_ch_i);
            let mut alt_r = std::mem::take(&mut self.work_st_r);
            let mut alt_i = std::mem::take(&mut self.work_st_i);
            {
                let stages = &mut self.channel_stages;
                let (filter, factor) = &mut stages[0];
                filter.process_decim(sig_r, sig_i, *factor, &mut cur_r, &mut cur_i);
                for k in 1..stages.len() {
                    let (filter, factor) = &mut stages[k];
                    filter.process_decim(&cur_r, &cur_i, *factor, &mut alt_r, &mut alt_i);
                    std::mem::swap(&mut cur_r, &mut alt_r);
                    std::mem::swap(&mut cur_i, &mut alt_i);
                }
            }
            // `cur_*` holds the last stage's output; park both pairs back in
            // self so their capacity is reused on the next call.
            self.work_ch_r = cur_r;
            self.work_ch_i = cur_i;
            self.work_st_r = alt_r;
            self.work_st_i = alt_i;
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
                // RDS (57 kHz subcarrier) only exists in WFM broadcast MPX,
                // and MUST run before de-emphasis: DeEmphasis is a 75us
                // one-pole low-pass applied in place to work_audio, and at
                // 57 kHz its response is about -28.6 dB — reading work_audio
                // after de-emphasis would starve the RDS front-end of signal.
                if self.config.demod_mode == 0 {
                    self.rds_front.process(&self.work_audio[..ch_len], &mut self.rds_blocks);
                }
                if self.config.demod_mode == 0 { self.deemphasis.process(&mut self.work_audio[..ch_len]); }
            }
            _ => { demod_am(&ch_r[..ch_len], &ch_i[..ch_len], &mut self.work_audio); }
        }

        // Audio decimation to 48 kHz
        let ch_rate = sr / ch_dec as f32;
        let audio_dec = (ch_rate / AUDIO_RATE).floor().max(1.0) as usize;
        let use_decim = audio_dec > 1 && self.audio_filter.is_some();
        if use_decim {
            let af = self.audio_filter.as_mut().unwrap();
            self.work_audio_imag.resize(ch_len, 0.0);
            af.process_decim(&self.work_audio[..ch_len], &self.work_audio_imag[..ch_len],
                     audio_dec, &mut self.work_dec_r, &mut self.work_dec_i);
            std::mem::swap(&mut self.audio_out, &mut self.work_dec_r);
        } else {
            self.audio_out.resize(ch_len, 0.0);
            self.audio_out[..ch_len].copy_from_slice(&self.work_audio[..ch_len]);
        }

        // Fractional resample to exactly AUDIO_RATE (48 kHz)
        self.work_res.clear();
        self.audio_resampler.process(&self.audio_out, &mut self.work_res);
        std::mem::swap(&mut self.audio_out, &mut self.work_res);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goertzel(x: &[f32], freq: f32, rate: f32) -> f32 {
        let w = 2.0 * std::f32::consts::PI * freq / rate;
        let c = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for &v in x { let s0 = v + c * s1 - s2; s2 = s1; s1 = s0; }
        (s1 * s1 + s2 * s2 - c * s1 * s2) / x.len() as f32
    }

    fn feed_silence(s: &mut DspState, chunks: usize) -> f32 {
        let raw = vec![128u8; 262_144]; // 131072 IQ samples per chunk
        let mut total = 0usize;
        for _ in 0..chunks { s.process_iq_raw(&raw, true); total += s.audio_out.len(); }
        let secs = chunks as f32 * 131_072.0 / s.config.sample_rate as f32;
        total as f32 / secs
    }

    #[test]
    fn test_wfm_audio_rate_is_48k() {
        let mut s = DspState::new(2_000_000, 1024);
        let rate = feed_silence(&mut s, 30);
        assert!((rate - 48_000.0).abs() < 100.0, "audio rate {rate}, want 48000");
    }

    #[test]
    fn test_nfm_narrow_bw_audio_rate_is_48k() {
        let mut s = DspState::new(2_000_000, 1024);
        s.update_config(2_000_000, 1, 1024, -100.0, 0.0, false, 12_500.0, true);
        let rate = feed_silence(&mut s, 30);
        assert!((rate - 48_000.0).abs() < 100.0, "audio rate {rate}, want 48000");
    }

    #[test]
    fn test_deemphasis_designed_for_channel_rate() {
        // WFM @ 2 Msps, bw 200 kHz → de-emphasis runs on work_audio at 400 kHz.
        // A correct 75 µs filter at 400 kHz has a = dt/(tau+dt) with dt = 2.5 µs.
        let s = DspState::new(2_000_000, 1024);
        let dt = 1.0f32 / 400_000.0;
        let expected_a = dt / (75e-6 + dt);
        assert!((s.deemphasis_a() - expected_a).abs() < 1e-6,
                "a = {}, want {expected_a}", s.deemphasis_a());
    }

    #[test]
    fn test_full_scale_tone_reads_zero_dbfs() {
        let mut s = DspState::new(2_000_000, 1024);
        let n = 4096usize;
        let mut raw = vec![0u8; n * 2];
        for i in 0..n {
            let ph = 2.0 * std::f32::consts::PI * (i as f32) * 0.125; // bin 128 of 1024
            raw[i * 2] = (127.0 * ph.cos()) as i8 as u8;
            raw[i * 2 + 1] = (127.0 * ph.sin()) as i8 as u8;
        }
        s.process_iq_raw(&raw, true);
        let peak = s.fft_out.iter().cloned().fold(f32::MIN, f32::max);
        assert!(peak < 1.0 && peak > -6.0, "peak {peak} dBFS, want ≈ 0");
    }

    #[test]
    fn test_am_carrier_at_center_survives() {
        // 1 kHz AM tone on a carrier at 0 Hz offset. With the DC blocker active
        // the carrier is nulled and demod output is dominated by 2 kHz distortion.
        let mut s = DspState::new(2_000_000, 1024);
        s.update_config(2_000_000, 2, 1024, -100.0, 0.0, false, 10_000.0, true);
        let n = 131_072usize;
        let mut raw = vec![0u8; n * 2];
        for i in 0..n {
            let t = i as f32 / 2_000_000.0;
            let env = 0.6 * (1.0 + 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * t).cos());
            raw[i * 2] = (127.0 * env) as i8 as u8; // carrier exactly at DC: I = env, Q = 0
            raw[i * 2 + 1] = 0;
        }
        let mut audio = Vec::new();
        for _ in 0..6 { s.process_iq_raw(&raw, true); audio = s.audio_out.clone(); }
        let f1 = goertzel(&audio, 1000.0, 48_000.0);
        let f2 = goertzel(&audio, 2000.0, 48_000.0);
        assert!(f1 > 10.0 * f2, "1 kHz {f1} should dominate 2 kHz {f2}");
    }

    fn tone_iq(freq: f32, sr: f32, n: usize, amp: f32) -> Vec<u8> {
        let mut raw = vec![0u8; n * 2];
        for i in 0..n {
            let ph = 2.0 * std::f32::consts::PI * freq * i as f32 / sr;
            raw[i * 2] = (amp * 127.0 * ph.cos()) as i8 as u8;
            raw[i * 2 + 1] = (amp * 127.0 * ph.sin()) as i8 as u8;
        }
        raw
    }

    #[test]
    fn test_narrowband_alias_rejection() {
        // AM @ 8 kHz bw, 2 Msps. A strong tone 100 kHz away must NOT reach the
        // audio: with proper staged filtering its demodulated power is tiny
        // compared to an in-band (2 kHz) tone of the same input amplitude.
        let sr = 2_000_000u32;
        let mut in_band = DspState::new(sr, 1024);
        in_band.update_config(sr, 2, 1024, -100.0, 0.0, false, 8_000.0, true);
        let mut out_band = DspState::new(sr, 1024);
        out_band.update_config(sr, 2, 1024, -100.0, 0.0, false, 8_000.0, true);

        let rms = |s: &mut DspState, f: f32| {
            let raw = tone_iq(f, sr as f32, 131_072, 0.8);
            let mut acc = 0.0f64; let mut cnt = 0usize;
            for _ in 0..4 {
                s.process_iq_raw(&raw, false);
                for &v in &s.audio_out { acc += (v as f64) * (v as f64); cnt += 1; }
            }
            (acc / cnt.max(1) as f64).sqrt()
        };

        let inband_rms = rms(&mut in_band, 2_000.0);
        let alias_rms = rms(&mut out_band, 100_000.0);
        assert!(alias_rms < inband_rms * 0.03,
                "100 kHz tone leaks into 8 kHz AM audio: alias {alias_rms} vs in-band {inband_rms} (want >30 dB down)");
    }

    /// One chunk of an AM station: a carrier `carrier` Hz off tune, amplitude
    /// modulated by `tone`. `carrier` and `tone` must be exact multiples of
    /// `sr / n`, so replaying the chunk back to back is a seamless continuous
    /// signal — a phase step at the seam splatters broadband energy right
    /// across the channel and would swamp the leakage under test.
    fn am_station_iq(carrier: f32, tone: f32, sr: f32, n: usize, amp: f32) -> Vec<u8> {
        let mut raw = vec![0u8; n * 2];
        for i in 0..n {
            // Phase kept in f64 and wrapped per sample: f32 loses ~0.01 rad on
            // freq * i once the product reaches 10^9, which is itself -38 dB
            // of phase noise.
            let cyc = |f: f32| {
                2.0 * std::f64::consts::PI
                    * ((f as f64) * (i as f64) / (sr as f64)).fract()
            };
            let env = amp * (1.0 + 0.8 * cyc(tone).cos() as f32) / 1.8;
            let ph = cyc(carrier);
            raw[i * 2] = (env * 127.0 * ph.cos() as f32) as i8 as u8;
            raw[i * 2 + 1] = (env * 127.0 * ph.sin() as f32) as i8 as u8;
        }
        raw
    }

    #[test]
    fn test_narrowband_alias_rejection_adjacent_station() {
        // Same premise as test_narrowband_alias_rejection, but with an
        // interferer that is actually audible when it leaks (a modulated
        // station, not a bare carrier whose envelope is flat) and at several
        // offsets, so the result cannot hinge on one frequency happening to
        // land in a null of the channel filter.
        //
        // 8 kHz AM channel at 2 Msps decimates by 125. A single 63-tap filter
        // at 2 Msps has a ~95 kHz transition, so stations tens of kHz off tune
        // are barely attenuated before decimation folds them onto the audio.
        let sr = 2_000_000u32;
        let n = 131_072usize;
        let bin = sr as f32 / n as f32; // seamless-chunk frequency grid
        let tone = 66.0 * bin; // ~1.01 kHz, inside the 4 kHz audio band

        let rms = |carrier: f32| {
            let mut s = DspState::new(sr, 1024);
            s.update_config(sr, 2, 1024, -100.0, 0.0, false, 8_000.0, true);
            let raw = am_station_iq(carrier, tone, sr as f32, n, 0.9);
            let mut acc = 0.0f64;
            let mut cnt = 0usize;
            for k in 0..4 {
                s.process_iq_raw(&raw, false);
                if k == 0 { continue; } // let the filter chain settle
                for &v in &s.audio_out { acc += (v as f64) * (v as f64); cnt += 1; }
            }
            (acc / cnt.max(1) as f64).sqrt()
        };

        let tuned = rms(0.0);
        assert!(tuned > 0.05, "tuned station should demodulate, got {tuned}");
        // 20 / 50 / 100 kHz off tune — all far outside the 8 kHz channel.
        for k in [1311.0f32, 3277.0, 6554.0] {
            let offset = k * bin;
            let leak = rms(offset);
            assert!(leak < tuned * 0.02,
                    "station {offset} Hz off tune leaks into the 8 kHz AM channel: \
                     {leak} vs tuned {tuned} ({:.1} dB, want < -34 dB)",
                    20.0 * (leak / tuned).log10());
        }
    }

    #[test]
    fn test_channel_stages_preserve_total_decimation() {
        // Staging must not change how much the channel path decimates: the
        // de-emphasis rate, the audio decimation and the output resampler are
        // all derived from ch_dec, so the stage factors have to multiply back
        // to exactly what the old single filter used. Checked over the whole
        // UI parameter space (sample-rate dropdown x the 2..250 kHz bandwidth
        // slider), which is also what proves the stage loop always terminates
        // and always splits ch_dec exactly — including primes and prime powers
        // that have no factor <= 8.
        for sr in [2_000_000u32, 4_000_000, 8_000_000, 10_000_000, 16_000_000, 20_000_000] {
            let mut s = DspState::new(sr, 1024);
            for bw in (2_000..=250_000).step_by(1_000) {
                s.update_config(sr, 2, 1024, -100.0, 0.0, false, bw as f32, true);
                let want = (sr as f32 / (bw as f32 * 2.0)).floor().max(1.0) as usize;
                let got: usize = s.channel_stages.iter().map(|(_, f)| *f).product();
                assert_eq!(got, want, "sr {sr} bw {bw}: stage factors must multiply to ch_dec");
                assert_eq!(s.channel_stages.is_empty(), want == 1,
                           "sr {sr} bw {bw}: ch_dec == 1 must mean passthrough");
            }
        }
    }


    #[test]
    fn test_fft_skipped_when_not_requested() {
        let mut s = DspState::new(2_000_000, 1024);
        let raw = vec![128u8; 8192];
        s.process_iq_raw(&raw, true);
        let with_fft = s.fft_out.len();
        s.fft_out.clear();
        s.process_iq_raw(&raw, false);
        assert_eq!(with_fft, 1024);
        assert_eq!(s.fft_out.len(), 0, "fft must not be computed when not requested");
    }

    /// Closes the loop from raw IQ all the way to a decoded station name:
    /// builds an RDS data-bit stream (repeated 0A groups carrying PI + PS,
    /// same construction as rds.rs's own end-to-end test), differentially
    /// and biphase-encodes it onto a synthetic MPX (1 kHz mono tone + 19 kHz
    /// pilot + 57 kHz DSB-SC BPSK RDS at 0.04 injection — close to the
    /// ~0.047 rds.rs documents as realistic, and deliberately NOT Task 9's
    /// headline test's strong 0.3 injection; see the comment below),
    /// then FM-modulates *that* MPX onto a carrier at 75 kHz peak deviation,
    /// sampled at the raw IQ rate (2 Msps) — i.e. what a real HackRF would
    /// actually hand the pipeline for a WFM broadcast carrying RDS. Feeding
    /// the resulting int8 IQ through `process_iq_raw` in real-sized chunks
    /// must decode PI + PS via `state.rds_blocks`, proving the tap point in
    /// `process_audio` sits where it can see a real, undamaged signal — a
    /// strong (0.3) injection passes even with the tap point wrongly moved
    /// after de-emphasis, because the Costas loop's power normalization
    /// absorbs a uniform attenuation when there's enough signal to spare.
    #[test]
    fn test_end_to_end_rds_through_pipeline() {
        use crate::rds::{OFFSET_A, OFFSET_B, OFFSET_C, OFFSET_D};

        // Independent reference CRC-10, duplicated the same way rds.rs's own
        // tests do (see its `crc10_ref`) since the real `crc10` is private.
        fn crc10_ref(info: u16) -> u16 {
            let mut reg: u32 = (info as u32) << 10;
            for i in (10..26).rev() {
                if reg & (1 << i) != 0 {
                    reg ^= 0x5B9 << (i - 10);
                }
            }
            (reg & 0x3FF) as u16
        }

        let pi = 0x50DCu16;
        let ps = *b"TESTFM  ";

        // Build the RDS data-bit stream: repeated 0A groups carrying PI + PS.
        let mut bits: Vec<u8> = Vec::new();
        let push26 = |bits: &mut Vec<u8>, info: u16, off: u16| {
            let blk = ((info as u32) << 10) | ((crc10_ref(info) ^ off) as u32);
            for i in (0..26).rev() {
                bits.push(((blk >> i) & 1) as u8);
            }
        };
        // ~6 passes of 4 segments each is ~2.1s of RDS bits at 1187.5 bit/s —
        // matches the brief's "~2 s of samples" while staying well inside
        // what the front-end/block-decoder need to acquire and lock cleanly.
        for _ in 0..6 {
            for seg in 0..4u16 {
                let b = seg; // group 0A, version A, segment address
                let dd = ((ps[(seg * 2) as usize] as u16) << 8) | ps[(seg * 2 + 1) as usize] as u16;
                push26(&mut bits, pi, OFFSET_A);
                push26(&mut bits, b, OFFSET_B);
                push26(&mut bits, 0, OFFSET_C);
                push26(&mut bits, dd, OFFSET_D);
            }
        }

        // Differential encode (removes the Costas loop's 180 deg ambiguity).
        let mut diff = Vec::with_capacity(bits.len());
        let mut prev = 0u8;
        for &b in &bits {
            prev ^= b;
            diff.push(prev);
        }

        // Synthesize the biphase-coded 57 kHz MPX component, then the full
        // MPX, at the RAW IQ rate (2 Msps) — RDS_CARRIER_HZ/RDS_HALF_RATE_HZ
        // are real Hz, so generating in continuous time at any sample rate
        // and letting the pipeline's own decimation chain band-limit it down
        // to the channel rate is physically equivalent to what a real
        // receiver does.
        let fs_raw = 2_000_000.0f32;
        let half_len = fs_raw / 2375.0; // samples per half-bit at the raw rate
        let total = (diff.len() as f32 * 2.0 * half_len) as usize;

        // FM-modulate: phase-integrate the MPX at 75 kHz peak deviation.
        // Kept in f64 so phase does not visibly drift over ~4M samples.
        let dev_hz = 75_000.0f64;
        let mut phase = 0.0f64;
        let mut raw = vec![0u8; total * 2];
        for i in 0..total {
            let t = i as f32 / fs_raw;
            let half_idx = (i as f32 / half_len) as usize;
            let bit_idx = half_idx / 2;
            let first_half = half_idx % 2 == 0;
            let symbol = if bit_idx < diff.len() {
                let d = diff[bit_idx] as i32 * 2 - 1;
                (if first_half { d } else { -d }) as f32
            } else {
                0.0
            };
            // RDS injection at 0.04, not 0.3: rds.rs (Task 9) documents 0.047
            // as the realistic level for ~3 kHz RDS deviation inside FM's
            // 75 kHz deviation. This matters here specifically because the
            // Costas loop is power-normalized (see rds.rs), so a *uniform*
            // attenuation of an otherwise-noiseless subcarrier (e.g. reading
            // work_audio one line too late, after de-emphasis's ~-28.6 dB at
            // 57 kHz) costs the loop nothing at a strong injection like 0.3 —
            // that value let this test pass even with the tap point moved
            // after de-emphasis, silently defeating its own purpose. At 0.04
            // there isn't enough headroom left to survive that mistake.
            let mpx = 0.4 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin()
                    + 0.1 * (2.0 * std::f32::consts::PI * 19_000.0 * t).sin()
                    + 0.04 * symbol * (2.0 * std::f32::consts::PI * 57_000.0 * t).cos();
            phase += std::f64::consts::TAU * dev_hz * mpx as f64 / fs_raw as f64;
            phase %= std::f64::consts::TAU;
            let (s, c) = (phase as f32).sin_cos();
            raw[i * 2] = (127.0 * c) as i8 as u8;
            raw[i * 2 + 1] = (127.0 * s) as i8 as u8;
        }

        // Feed through the real pipeline entry point, in app-sized chunks
        // (131072 IQ samples, matching the 26214-sample chunks rds.rs's own
        // tests drive the front-end with after this pipeline's 5x channel
        // decimation for a 200 kHz WFM channel at 2 Msps).
        let mut s = DspState::new(2_000_000, 1024);
        for chunk in raw.chunks(262_144) {
            s.process_iq_raw(chunk, false);
        }
        assert_eq!(s.rds_blocks.pi(), pi, "PI not decoded through the full pipeline");
        assert_eq!(s.rds_blocks.ps(), &ps, "PS not decoded through the full pipeline");
    }

    /// A retune must not leave a stale station name on screen forever.
    /// `reset_rds` is the mechanism the worker calls when it observes the
    /// tuned frequency change (App.tsx/worker.ts — frequency isn't part of
    /// DspConfig, so update_config's mode/sample-rate/bandwidth-changed
    /// checks never fire on a plain "same everything else, new frequency"
    /// retune). Drives the block decoder directly with a valid group
    /// (bypassing RdsFrontEnd/demodulation, which is irrelevant to what
    /// this test checks) to get it into a genuinely-decoded state first, so
    /// the assertions below distinguish "reset actually cleared it" from
    /// "it was already empty".
    #[test]
    fn test_reset_rds_clears_decoded_state() {
        use crate::rds::{OFFSET_A, OFFSET_B, OFFSET_C, OFFSET_D};

        fn crc10_ref(info: u16) -> u16 {
            let mut reg: u32 = (info as u32) << 10;
            for i in (10..26).rev() {
                if reg & (1 << i) != 0 {
                    reg ^= 0x5B9 << (i - 10);
                }
            }
            (reg & 0x3FF) as u16
        }
        fn push26(d: &mut RdsBlockDecoder, info: u16, off: u16) {
            let blk = ((info as u32) << 10) | ((crc10_ref(info) ^ off) as u32);
            for i in (0..26).rev() {
                d.push_bit(((blk >> i) & 1) as u8);
            }
        }

        let mut s = DspState::new(2_000_000, 1024);
        let pi = 0x50DCu16;
        let ps = *b"TESTFM  ";
        for seg in 0..4u16 {
            let dd = ((ps[(seg * 2) as usize] as u16) << 8) | ps[(seg * 2 + 1) as usize] as u16;
            push26(&mut s.rds_blocks, pi, OFFSET_A);
            push26(&mut s.rds_blocks, seg, OFFSET_B);
            push26(&mut s.rds_blocks, 0, OFFSET_C);
            push26(&mut s.rds_blocks, dd, OFFSET_D);
        }
        assert_eq!(s.rds_blocks.pi(), pi, "setup: PI should have decoded before reset");
        assert_eq!(s.rds_blocks.ps(), &ps, "setup: PS should have decoded before reset");
        assert!(s.rds_blocks.version() > 0, "setup: version should be nonzero before reset");

        s.reset_rds();

        assert_eq!(s.rds_blocks.pi(), 0, "PI must clear on reset_rds");
        assert_eq!(s.rds_blocks.ps(), &[b' '; 8], "PS must clear on reset_rds");
        assert_eq!(s.rds_blocks.rt(), &[b' '; 64], "RT must clear on reset_rds");
        assert_eq!(s.rds_blocks.version(), 0, "version must clear on reset_rds");
    }
}
