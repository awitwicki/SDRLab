// RDS (Radio Data System) block/group decoder — pure bit-level layer.
//
// Consumes a stream of already-demodulated data bits (one at a time via
// `push_bit`), searches for 26-bit block synchronization against the five
// RDS/RBDS offset words, verifies each block's CRC-10, and assembles
// complete 0A groups (Program Service name) and 2A groups (RadioText).
//
// This module has no DSP dependency — the 57 kHz front-end that turns MPX
// audio into a bitstream and feeds it to `push_bit` is a separate task.

// ETSI EN 50067 offset words (10-bit).
pub const OFFSET_A: u16 = 0x0FC;
pub const OFFSET_B: u16 = 0x198;
pub const OFFSET_C: u16 = 0x168;
pub const OFFSET_C2: u16 = 0x350;
pub const OFFSET_D: u16 = 0x1B4;

// CRC-10 generator polynomial g(x) = x^10+x^8+x^7+x^5+x^4+x^3+1.
const CRC_POLY: u32 = 0x5B9;

/// Compute the CRC-10 syndrome of a 16-bit info word by the same bit-by-bit
/// long division used by RDS transmitters (and mirrored by the test
/// module's independent reference implementation).
fn crc10(info: u16) -> u16 {
    let mut reg: u32 = (info as u32) << 10;
    for i in (10..26).rev() {
        if reg & (1 << i) != 0 {
            reg ^= CRC_POLY << (i - 10);
        }
    }
    (reg & 0x3FF) as u16
}

/// Which of the four block roles within a group we're currently reading.
#[derive(Clone, Copy, PartialEq, Eq)]
enum BlockRole {
    A = 0,
    B = 1,
    C = 2,
    D = 3,
}

impl BlockRole {
    fn next(self) -> BlockRole {
        match self {
            BlockRole::A => BlockRole::B,
            BlockRole::B => BlockRole::C,
            BlockRole::C => BlockRole::D,
            BlockRole::D => BlockRole::A,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SyncState {
    /// No block alignment known yet — sliding-window search on every bit.
    Searching,
    /// A tentative A block was found; confirming B, C/C', D at fixed
    /// 26-bit offsets. Any failure here drops straight back to Searching.
    Acquiring,
    /// Block alignment established; blocks are consumed 26 bits at a time.
    /// A bad block invalidates just that block (kept as part of the
    /// "current group so far"); only a run of bad groups drops sync.
    Synced,
}

/// Streaming RDS block/group decoder.
///
/// Feed one demodulated data bit at a time via [`push_bit`](Self::push_bit).
/// Once block synchronization is found, complete 0A groups update the
/// Program Service name ([`ps`](Self::ps)) and complete 2A groups update
/// RadioText ([`rt`](Self::rt)); the Program Identification code
/// ([`pi`](Self::pi)) updates from every group with a valid A block.
/// [`version`](Self::version) increments whenever any of that visible state
/// actually changes, so a caller can poll cheaply for "is there something
/// new to show" instead of diffing buffers itself.
pub struct RdsBlockDecoder {
    shift_reg: u32,
    state: SyncState,
    role: BlockRole,
    bits_in_block: u8,

    // Accumulator for the group currently being assembled.
    group_a: Option<u16>,
    group_b: Option<u16>,
    group_c: Option<u16>,
    group_d: Option<u16>,

    consecutive_bad_groups: u32,
    sync_lost_bits: u32,

    pi: u16,
    ps: [u8; 8],
    rt: [u8; 64],
    rt_ab_flag: Option<u8>,

    version: u32,
}

const BLOCK_MASK: u32 = (1 << 26) - 1;
const MAX_CONSECUTIVE_BAD_GROUPS: u32 = 4;

impl RdsBlockDecoder {
    pub fn new() -> Self {
        RdsBlockDecoder {
            shift_reg: 0,
            state: SyncState::Searching,
            role: BlockRole::A,
            bits_in_block: 0,
            group_a: None,
            group_b: None,
            group_c: None,
            group_d: None,
            consecutive_bad_groups: 0,
            sync_lost_bits: 0,
            pi: 0,
            ps: [b' '; 8],
            rt: [b' '; 64],
            rt_ab_flag: None,
            version: 0,
        }
    }

    pub fn push_bit(&mut self, bit: u8) {
        self.shift_reg = ((self.shift_reg << 1) | (bit as u32 & 1)) & BLOCK_MASK;

        match self.state {
            SyncState::Searching => self.search_step(),
            SyncState::Acquiring | SyncState::Synced => self.block_step(),
        }

        if self.state != SyncState::Synced {
            self.sync_lost_bits += 1;
        }
    }

    pub fn ps(&self) -> &[u8; 8] {
        &self.ps
    }

    pub fn rt(&self) -> &[u8; 64] {
        &self.rt
    }

    pub fn pi(&self) -> u16 {
        self.pi
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn sync_lost_bits(&self) -> u32 {
        self.sync_lost_bits
    }

    /// Split the 26-bit shift register into its 16-bit info field and
    /// 10-bit trailer (CRC XORed with the block's offset word).
    fn split(&self) -> (u16, u16) {
        let info = ((self.shift_reg >> 10) & 0xFFFF) as u16;
        let trailer = (self.shift_reg & 0x3FF) as u16;
        (info, trailer)
    }

    /// Unsynced: check every bit position for an A-block match.
    fn search_step(&mut self) {
        let (info, trailer) = self.split();
        let syndrome = crc10(info) ^ trailer;
        if syndrome == OFFSET_A {
            self.group_a = Some(info);
            self.group_b = None;
            self.group_c = None;
            self.group_d = None;
            self.role = BlockRole::B;
            self.bits_in_block = 0;
            self.state = SyncState::Acquiring;
        }
    }

    /// Acquiring or Synced: accumulate 26 bits, then check the block due at
    /// the current role.
    fn block_step(&mut self) {
        self.bits_in_block += 1;
        if self.bits_in_block < 26 {
            return;
        }
        self.bits_in_block = 0;

        let (info, trailer) = self.split();
        let syndrome = crc10(info) ^ trailer;
        let valid = match self.role {
            BlockRole::A => syndrome == OFFSET_A,
            BlockRole::B => syndrome == OFFSET_B,
            BlockRole::C => syndrome == OFFSET_C || syndrome == OFFSET_C2,
            BlockRole::D => syndrome == OFFSET_D,
        };
        let value = if valid { Some(info) } else { None };
        match self.role {
            BlockRole::A => self.group_a = value,
            BlockRole::B => self.group_b = value,
            BlockRole::C => self.group_c = value,
            BlockRole::D => self.group_d = value,
        }

        match self.state {
            SyncState::Acquiring => self.acquiring_block_done(valid),
            SyncState::Synced => self.synced_block_done(),
            SyncState::Searching => unreachable!("block_step only runs while Acquiring/Synced"),
        }
    }

    fn acquiring_block_done(&mut self, valid: bool) {
        if !valid {
            // Tentative alignment was wrong — drop back to a fresh search.
            self.state = SyncState::Searching;
            self.role = BlockRole::A;
            self.group_a = None;
            self.group_b = None;
            self.group_c = None;
            self.group_d = None;
            return;
        }
        if self.role == BlockRole::D {
            // All four blocks confirmed: sync acquired.
            self.state = SyncState::Synced;
            self.consecutive_bad_groups = 0;
            self.process_group();
            self.clear_group();
            self.role = BlockRole::A;
        } else {
            self.role = self.role.next();
        }
    }

    fn synced_block_done(&mut self) {
        if self.role != BlockRole::D {
            self.role = self.role.next();
            return;
        }
        // Full group boundary reached, regardless of individual block validity.
        let bad_group = self.group_a.is_none()
            || self.group_b.is_none()
            || self.group_c.is_none()
            || self.group_d.is_none();
        self.process_group();
        if bad_group {
            self.consecutive_bad_groups += 1;
            if self.consecutive_bad_groups >= MAX_CONSECUTIVE_BAD_GROUPS {
                self.state = SyncState::Searching;
            }
        } else {
            self.consecutive_bad_groups = 0;
        }
        self.clear_group();
        self.role = BlockRole::A;
    }

    fn clear_group(&mut self) {
        self.group_a = None;
        self.group_b = None;
        self.group_c = None;
        self.group_d = None;
    }

    /// Interpret whatever blocks were validly received for the group in
    /// progress. Requires valid A+B to know PI and group type/version; PS
    /// segments need a valid D, RadioText segments need valid C and/or D.
    fn process_group(&mut self) {
        let (a, b) = match (self.group_a, self.group_b) {
            (Some(a), Some(b)) => (a, b),
            _ => return,
        };

        let mut changed = false;

        if self.pi != a {
            self.pi = a;
            changed = true;
        }

        let group_type = (b >> 12) & 0xF;
        let version_b = (b >> 11) & 1; // 0 = version A, 1 = version B

        if group_type == 0 {
            let seg = (b & 0x3) as usize;
            if let Some(d) = self.group_d {
                let hi = (d >> 8) as u8;
                let lo = (d & 0xFF) as u8;
                if self.ps[seg * 2] != hi {
                    self.ps[seg * 2] = hi;
                    changed = true;
                }
                if self.ps[seg * 2 + 1] != lo {
                    self.ps[seg * 2 + 1] = lo;
                    changed = true;
                }
            }
        } else if group_type == 2 && version_b == 0 {
            let flag = ((b >> 4) & 1) as u8;
            if let Some(prev) = self.rt_ab_flag {
                if prev != flag {
                    // Text A/B flag toggled: station signals a fresh
                    // RadioText string, so any stale characters must go.
                    if self.rt != [b' '; 64] {
                        changed = true;
                    }
                    self.rt = [b' '; 64];
                }
            }
            self.rt_ab_flag = Some(flag);

            let seg = (b & 0xF) as usize;
            if let Some(c) = self.group_c {
                let hi = (c >> 8) as u8;
                let lo = (c & 0xFF) as u8;
                let i = seg * 4;
                if self.rt[i] != hi {
                    self.rt[i] = hi;
                    changed = true;
                }
                if self.rt[i + 1] != lo {
                    self.rt[i + 1] = lo;
                    changed = true;
                }
            }
            if let Some(d) = self.group_d {
                let hi = (d >> 8) as u8;
                let lo = (d & 0xFF) as u8;
                let i = seg * 4 + 2;
                if self.rt[i] != hi {
                    self.rt[i] = hi;
                    changed = true;
                }
                if self.rt[i + 1] != lo {
                    self.rt[i + 1] = lo;
                    changed = true;
                }
            }
        }

        if changed {
            self.version += 1;
        }
    }
}

impl Default for RdsBlockDecoder {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 57 kHz RDS front-end: MPX samples in, data bits out.
// ---------------------------------------------------------------------------

/// RDS subcarrier: the 3rd harmonic of the 19 kHz stereo pilot.
const RDS_CARRIER_HZ: f32 = 57_000.0;
/// Biphase (half-bit) symbol rate = 2 x 1187.5 bit/s.
const RDS_HALF_RATE_HZ: f32 = 2375.0;
/// Baseband low-pass cutoff applied to I and Q after the 57 kHz mix.
const RDS_LPF_HZ: f32 = 3000.0;
/// Reference sample rate the loop gains below were tuned at.
const GAIN_REF_FS: f32 = 400_000.0;
/// Costas loop proportional (phase) and integral (frequency) gains at
/// `GAIN_REF_FS`; both are rescaled for other rates in `configure`.
/// These correspond to a natural frequency of ~113 Hz and damping ζ ≈ 0.7
/// for the power-normalized discriminator (whose gain is 1.0 rad/rad).
const COSTAS_ALPHA: f32 = 2.5e-3;
const COSTAS_BETA: f32 = 3.1e-6;
/// Absolute floor on the tracked baseband power used to normalize the
/// Costas error, so a silent input cannot divide by ~zero.
const PWR_FLOOR: f32 = 1e-9;
/// Largest frequency error the loop integrator may wind up to. Real
/// subcarriers are pilot-locked at the transmitter, so the only offset is
/// the receiver's sample-clock error (a few Hz at any sane ppm); this bound
/// simply stops the NCO wandering off while no signal is present.
const MAX_FREQ_ERR_HZ: f32 = 200.0;
/// Fraction of the residual timing error taken out on each observed
/// biphase transition.
const TIMING_NUDGE: f32 = 0.05;
/// Sign-slicer hysteresis as a fraction of the tracked |I| envelope.
const SIGN_HYSTERESIS: f32 = 0.25;
/// Flip the biphase half-pairing after this many bits without block sync.
const PARITY_FLIP_BITS: u32 = 3000;
/// Below this rate the 57 kHz subcarrier and its sidebands are not
/// representable, so the front-end stays idle (e.g. narrow-FM channels).
const MIN_USABLE_FS: f32 = 130_000.0;

const TWO_PI_F64: f64 = std::f64::consts::TAU;

/// 57 kHz RDS front-end.
///
/// Consumes FM multiplex (MPX) samples at the channel rate and pushes
/// recovered data bits into an [`RdsBlockDecoder`]. The chain per sample is:
///
/// 1. **Quadrature mix** by an NCO near 57 kHz, producing I/Q.
/// 2. **Baseband low-pass** — two cascaded one-poles per branch, ~3 kHz —
///    which removes the sum-frequency image and the 19 kHz pilot / audio
///    products while passing the biphase spectrum (peaked near 1187 Hz).
/// 3. **Costas loop** — RDS is DSB-SC (no discrete 57 kHz carrier exists to
///    lock a plain PLL to), so carrier phase is recovered from the BPSK
///    signal itself with the `e = I·Q` error term, which is proportional to
///    `sin(2φ)` and therefore independent of the data polarity. A
///    second-order loop (proportional + integral) tracks both phase and any
///    residual frequency error.
/// 4. **Half-bit integrate-and-dump** at 2375 Hz, driven by a phase
///    accumulator, with timing recovered by nudging that accumulator toward
///    the nearest dump boundary whenever the sliced I signal changes sign
///    (biphase transitions only ever occur on half-bit boundaries).
/// 5. **Biphase decode** — pair consecutive half-bit integrals `H1, H2`;
///    the raw bit is `H1 - H2 > 0`. The pairing parity is unobservable from
///    the waveform alone, so it is flipped whenever the block decoder has
///    run [`PARITY_FLIP_BITS`] bits without finding sync.
/// 6. **Differential decode** — `bit = raw ^ prev_raw`, which also removes
///    the Costas loop's inherent 180° phase ambiguity.
pub struct RdsFrontEnd {
    fs: f32,
    active: bool,

    // --- carrier recovery (Costas loop) ---
    /// NCO phase in radians, kept in f64 so 4+ second runs at 400 kHz do not
    /// accumulate a visible rounding drift.
    phase: f64,
    /// Nominal radians/sample for 57 kHz at `fs`.
    phase_inc: f64,
    /// Loop-integrator frequency correction, radians/sample.
    freq: f64,
    /// Symmetric bound on `freq`, radians/sample.
    freq_limit: f64,
    alpha: f32,
    beta: f32,
    /// Slow estimate of baseband power `<I²+Q²>`, used to make the Costas
    /// error term (and hence the loop bandwidth and damping) independent of
    /// how strongly RDS is injected into the multiplex.
    pwr_est: f32,
    pwr_k: f32,

    // --- baseband low-pass: 2 cascaded one-poles per branch ---
    lpf_k: f32,
    i_lp: [f32; 2],
    q_lp: [f32; 2],

    // --- symbol timing / integrate-and-dump ---
    acc: f32,
    acc_inc: f32,
    integ: f32,
    integ_n: u32,
    /// Slow |I| envelope used to scale the sign slicer's hysteresis.
    mag_est: f32,
    mag_k: f32,
    sign: i32,

    // --- biphase / differential decode ---
    expect_second: bool,
    h1: f32,
    prev_raw: u8,
    last_flip_lost: u32,
}

impl RdsFrontEnd {
    pub fn new(fs: f32) -> Self {
        let mut fe = RdsFrontEnd {
            fs: 0.0,
            active: false,
            phase: 0.0,
            phase_inc: 0.0,
            freq: 0.0,
            freq_limit: 0.0,
            alpha: 0.0,
            beta: 0.0,
            pwr_est: 0.0,
            pwr_k: 0.0,
            lpf_k: 0.0,
            i_lp: [0.0; 2],
            q_lp: [0.0; 2],
            acc: 0.0,
            acc_inc: 0.0,
            integ: 0.0,
            integ_n: 0,
            mag_est: 0.0,
            mag_k: 0.0,
            sign: 0,
            expect_second: false,
            h1: 0.0,
            prev_raw: 0,
            last_flip_lost: 0,
        };
        fe.configure(fs);
        fe
    }

    /// Re-design for a new channel sample rate. Every rate-dependent
    /// constant (NCO increment, loop gains, filter coefficient, half-bit
    /// accumulator step) is recomputed and all running state is dropped, so
    /// no accumulator or filter memory survives at the wrong scale. A call
    /// with the current rate is free, so callers may invoke it per chunk.
    pub fn set_rate(&mut self, fs: f32) {
        if (fs - self.fs).abs() < 1.0 {
            return;
        }
        self.configure(fs);
    }

    fn configure(&mut self, fs: f32) {
        self.fs = fs;
        self.active = fs.is_finite() && fs >= MIN_USABLE_FS;

        if self.active {
            self.phase_inc = (TWO_PI_F64 * RDS_CARRIER_HZ as f64) / fs as f64;
            self.acc_inc = RDS_HALF_RATE_HZ / fs;
            // One-pole coefficient for a -3 dB corner at RDS_LPF_HZ.
            self.lpf_k = 1.0 - (-2.0 * std::f32::consts::PI * RDS_LPF_HZ / fs).exp();
            // Envelope tracker: ~10 bit periods of memory.
            self.mag_k = (RDS_HALF_RATE_HZ * 0.5) / (10.0 * fs);
            // Power tracker: ~20 bit periods, i.e. slow enough not to follow
            // the biphase envelope itself (which swings at 1187 Hz).
            self.pwr_k = (RDS_HALF_RATE_HZ * 0.5) / (20.0 * fs);
            // Hold the loop bandwidth (in Hz) and damping constant across
            // rates: the per-sample phase gain scales as 1/fs and the
            // per-sample frequency gain as 1/fs^2.
            let r = GAIN_REF_FS / fs;
            self.alpha = COSTAS_ALPHA * r;
            self.beta = COSTAS_BETA * r * r;
            self.freq_limit = (TWO_PI_F64 * MAX_FREQ_ERR_HZ as f64) / fs as f64;
        } else {
            self.phase_inc = 0.0;
            self.acc_inc = 0.0;
            self.lpf_k = 0.0;
            self.mag_k = 0.0;
            self.pwr_k = 0.0;
            self.alpha = 0.0;
            self.beta = 0.0;
            self.freq_limit = 0.0;
        }

        self.phase = 0.0;
        self.freq = 0.0;
        self.pwr_est = 0.0;
        self.i_lp = [0.0; 2];
        self.q_lp = [0.0; 2];
        self.acc = 0.0;
        self.integ = 0.0;
        self.integ_n = 0;
        self.mag_est = 0.0;
        self.sign = 0;
        self.expect_second = false;
        self.h1 = 0.0;
        self.prev_raw = 0;
        self.last_flip_lost = 0;
    }

    /// True when the configured sample rate can actually carry 57 kHz.
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn process(&mut self, mpx: &[f32], block_decoder: &mut RdsBlockDecoder) {
        if !self.active {
            return;
        }
        for &x in mpx {
            // --- 1. quadrature mix down from 57 kHz -----------------------
            let (sin_p, cos_p) = (self.phase as f32).sin_cos();
            let i_mix = x * cos_p;
            let q_mix = -x * sin_p;

            // --- 2. baseband low-pass (2 cascaded one-poles per branch) ---
            self.i_lp[0] += self.lpf_k * (i_mix - self.i_lp[0]);
            self.i_lp[1] += self.lpf_k * (self.i_lp[0] - self.i_lp[1]);
            self.q_lp[0] += self.lpf_k * (q_mix - self.q_lp[0]);
            self.q_lp[1] += self.lpf_k * (self.q_lp[0] - self.q_lp[1]);
            let i = self.i_lp[1];
            let q = self.q_lp[1];

            // --- 3. Costas loop -------------------------------------------
            // I·Q = -(M²d²/2)·sin(2φ): the data sign squares away, so this is
            // a pure phase-error measurement for a BPSK/DSB-SC carrier.
            // Dividing by the tracked power <I²+Q²> = M²<d²> turns it into
            // -0.5·sin(2φ) with unit slope at φ=0, so loop bandwidth and
            // damping no longer depend on the RDS injection level — without
            // this the damping falls off as ζ ∝ amplitude and the loop rings
            // badly at realistic (few-kHz-deviation) subcarrier levels.
            self.pwr_est += self.pwr_k * (i * i + q * q - self.pwr_est);
            let e = (i * q / self.pwr_est.max(PWR_FLOOR)).clamp(-1.0, 1.0);
            self.freq = (self.freq + (self.beta * e) as f64)
                .clamp(-self.freq_limit, self.freq_limit);
            self.phase += self.phase_inc + self.freq + (self.alpha * e) as f64;
            while self.phase >= TWO_PI_F64 {
                self.phase -= TWO_PI_F64;
            }
            while self.phase < 0.0 {
                self.phase += TWO_PI_F64;
            }

            // --- 4a. timing: nudge on biphase transitions ------------------
            self.mag_est += self.mag_k * (i.abs() - self.mag_est);
            let thr = SIGN_HYSTERESIS * self.mag_est;
            let new_sign = if i > thr {
                1
            } else if i < -thr {
                -1
            } else {
                self.sign
            };
            if new_sign != self.sign && self.sign != 0 {
                // Transitions land on half-bit boundaries, so pull the dump
                // phase toward whichever boundary is nearer.
                if self.acc < 0.5 {
                    self.acc -= TIMING_NUDGE * self.acc;
                } else {
                    self.acc += TIMING_NUDGE * (1.0 - self.acc);
                }
            }
            self.sign = new_sign;

            // --- 4b. half-bit integrate-and-dump --------------------------
            self.integ += i;
            self.integ_n += 1;
            self.acc += self.acc_inc;
            if self.acc >= 1.0 {
                self.acc -= 1.0;
                let h = if self.integ_n > 0 {
                    self.integ / self.integ_n as f32
                } else {
                    0.0
                };
                self.integ = 0.0;
                self.integ_n = 0;
                self.on_half_bit(h, block_decoder);
            }
        }
    }

    /// Steps 5 and 6: biphase pairing then differential decode.
    fn on_half_bit(&mut self, h: f32, block_decoder: &mut RdsBlockDecoder) {
        // The waveform cannot tell us which half-bit starts a symbol, so if
        // the block decoder has gone a long stretch without ever finding
        // sync, assume the pairing is off by one and flip it.
        let lost = block_decoder.sync_lost_bits();
        // The block decoder's counter can go backwards relative to our last
        // snapshot — e.g. reset_rds() swaps in a fresh RdsBlockDecoder (new
        // counter starting at 0) without this front-end being told, such as
        // on every retune or every mousemove during a spectrum-pan drag.
        // Without this guard, wrapping_sub against the old (larger)
        // last_flip_lost would wrap around to a huge value and immediately
        // satisfy the threshold below, forcing one spurious biphase flip
        // right after every reset. Snapping down to the new baseline instead
        // makes the very next check start counting cleanly from it.
        if lost < self.last_flip_lost {
            self.last_flip_lost = lost;
        }
        if lost.wrapping_sub(self.last_flip_lost) >= PARITY_FLIP_BITS {
            self.last_flip_lost = lost;
            self.expect_second = !self.expect_second;
        }

        if self.expect_second {
            let raw = if self.h1 - h > 0.0 { 1u8 } else { 0u8 };
            let bit = raw ^ self.prev_raw;
            self.prev_raw = raw;
            self.expect_second = false;
            block_decoder.push_bit(bit);
        } else {
            self.h1 = h;
            self.expect_second = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crc10_ref(info: u16) -> u16 {
        // Reference bit-by-bit long division of info<<10 by g(x)=0x5B9
        let mut reg: u32 = (info as u32) << 10;
        for i in (10..26).rev() {
            if reg & (1 << i) != 0 { reg ^= 0x5B9 << (i - 10); }
        }
        (reg & 0x3FF) as u16
    }

    fn make_block(info: u16, offset: u16) -> u32 {
        ((info as u32) << 10) | ((crc10_ref(info) ^ offset) as u32)
    }

    fn push_block(d: &mut RdsBlockDecoder, block: u32) {
        for i in (0..26).rev() { d.push_bit(((block >> i) & 1) as u8); }
    }

    fn push_group(d: &mut RdsBlockDecoder, a: u16, b: u16, c: u16, cw: u16, dd: u16, c_prime: bool) {
        push_block(d, make_block(a, OFFSET_A));
        push_block(d, make_block(b, OFFSET_B));
        push_block(d, make_block(c, if c_prime { OFFSET_C2 } else { OFFSET_C }));
        push_block(d, make_block(dd, OFFSET_D));
        let _ = cw;
    }

    #[test]
    fn test_ps_decodes_from_0a_groups() {
        let mut d = RdsBlockDecoder::new();
        let pi = 0x50DC;
        let ps = *b"TESTFM  ";
        // A few garbage bits before sync, then two full passes of 4 segments
        for _ in 0..7 { d.push_bit(1); }
        for _pass in 0..2 {
            for seg in 0..4u16 {
                let b = (0u16 << 12) | (0 << 11) | seg; // group 0A, segment address
                let dd = ((ps[(seg * 2) as usize] as u16) << 8) | ps[(seg * 2 + 1) as usize] as u16;
                push_group(&mut d, pi, b, 0x0000, 0, dd, false);
            }
        }
        assert_eq!(d.pi(), pi);
        assert_eq!(d.ps(), b"TESTFM  ");
        assert!(d.version() > 0);
    }

    #[test]
    fn test_rt_decodes_from_2a_groups() {
        let mut d = RdsBlockDecoder::new();
        let pi = 0x50DC;
        let text = b"HELLO RDS WORLD!";
        for _pass in 0..2 {
            for seg in 0..4u16 {
                let b = (2u16 << 12) | seg; // group 2A, text segment
                let i = (seg * 4) as usize;
                let c = ((text[i] as u16) << 8) | text[i + 1] as u16;
                let dd = ((text[i + 2] as u16) << 8) | text[i + 3] as u16;
                push_group(&mut d, pi, b, c, 0, dd, false);
            }
        }
        assert_eq!(&d.rt()[..16], text);
    }


    // Body is the task brief's end-to-end test verbatim; the attribute only
    // silences a warning about its `let mut push26` and changes no behaviour.
    #[allow(unused_mut)]
    #[test]
    fn test_end_to_end_synthetic_mpx() {
        let fs = 400_000.0f32;
        let pi = 0x50DC;
        let ps = *b"TESTFM  ";
        // Build the data bit stream: repeated 0A groups carrying the PS
        let mut bits: Vec<u8> = Vec::new();
        let mut push26 = |bits: &mut Vec<u8>, info: u16, off: u16| {
            let blk = ((info as u32) << 10) | ((crc10_ref(info) ^ off) as u32);
            for i in (0..26).rev() { bits.push(((blk >> i) & 1) as u8); }
        };
        for _pass in 0..12 {
            for seg in 0..4u16 {
                let b = seg;
                let dd = ((ps[(seg * 2) as usize] as u16) << 8) | ps[(seg * 2 + 1) as usize] as u16;
                push26(&mut bits, pi, OFFSET_A);
                push26(&mut bits, b, OFFSET_B);
                push26(&mut bits, 0, OFFSET_C);
                push26(&mut bits, dd, OFFSET_D);
            }
        }
        // Differential encode, then biphase (each data bit -> +half,-half or inverted)
        let mut diff = Vec::with_capacity(bits.len());
        let mut prev = 0u8;
        for &b in &bits { prev ^= b; diff.push(prev); }
        // Waveform: 57 kHz DSB-SC BPSK + 19 kHz pilot + 1 kHz mono audio
        let half_len = fs / 2375.0; // ~168.4 samples per half-bit
        let total = (diff.len() as f32 * 2.0 * half_len) as usize;
        let mut mpx = vec![0.0f32; total];
        for i in 0..total {
            let t = i as f32 / fs;
            let half_idx = (i as f32 / half_len) as usize;
            let bit_idx = half_idx / 2;
            let first_half = half_idx % 2 == 0;
            let symbol = if bit_idx < diff.len() {
                let d = diff[bit_idx] as i32 * 2 - 1;
                (if first_half { d } else { -d }) as f32
            } else { 0.0 };
            mpx[i] = 0.4 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin()
                   + 0.1 * (2.0 * std::f32::consts::PI * 19_000.0 * t).sin()
                   + 0.3 * symbol * (2.0 * std::f32::consts::PI * 57_000.0 * t).cos();
        }
        // Decode in app-sized chunks
        let mut fe = RdsFrontEnd::new(fs);
        let mut bd = RdsBlockDecoder::new();
        for chunk in mpx.chunks(26_214) { fe.process(chunk, &mut bd); }
        assert_eq!(bd.pi(), pi, "PI not decoded");
        assert_eq!(bd.ps(), b"TESTFM  ", "PS not decoded");
    }

    // --- RdsFrontEnd support: build a standards-shaped MPX with knobs for
    // carrier phase/frequency offset, additive noise and RDS injection level.

    fn rds_bits(pi: u16, ps: &[u8; 8], passes: usize) -> Vec<u8> {
        let mut bits: Vec<u8> = Vec::new();
        let push26 = |bits: &mut Vec<u8>, info: u16, off: u16| {
            let blk = ((info as u32) << 10) | ((crc10_ref(info) ^ off) as u32);
            for i in (0..26).rev() { bits.push(((blk >> i) & 1) as u8); }
        };
        for _ in 0..passes {
            for seg in 0..4u16 {
                let dd = ((ps[(seg * 2) as usize] as u16) << 8) | ps[(seg * 2 + 1) as usize] as u16;
                push26(&mut bits, pi, OFFSET_A);
                push26(&mut bits, seg, OFFSET_B);
                push26(&mut bits, 0, OFFSET_C);
                push26(&mut bits, dd, OFFSET_D);
            }
        }
        bits
    }

    fn rds_mpx(fs: f32, bits: &[u8], phase_off: f32, freq_off: f32, noise: f32, amp: f32) -> Vec<f32> {
        rds_mpx_clk(fs, bits, phase_off, freq_off, noise, amp, 0.0)
    }

    /// `clock_ppm` models a receiver sample-clock error: it scales the
    /// subcarrier *and* the symbol rate together, exactly as a crystal error
    /// does, so the symbol clock drifts and only the timing nudge keeps the
    /// integrate-and-dump aligned.
    fn rds_mpx_clk(fs: f32, bits: &[u8], phase_off: f32, freq_off: f32, noise: f32,
                   amp: f32, clock_ppm: f32) -> Vec<f32> {
        let k = 1.0 + clock_ppm * 1e-6;
        let mut diff = Vec::with_capacity(bits.len());
        let mut prev = 0u8;
        for &b in bits { prev ^= b; diff.push(prev); }
        let half_len = fs / (2375.0 * k);
        let total = (diff.len() as f32 * 2.0 * half_len) as usize;
        let mut mpx = vec![0.0f32; total];
        let mut rng: u32 = 0x1234_5678;
        for i in 0..total {
            let t = i as f32 / fs;
            let half_idx = (i as f32 / half_len) as usize;
            let bit_idx = half_idx / 2;
            let symbol = if bit_idx < diff.len() {
                let d = diff[bit_idx] as i32 * 2 - 1;
                (if half_idx % 2 == 0 { d } else { -d }) as f32
            } else { 0.0 };
            rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
            let n = ((rng >> 8) as f32 / 8_388_608.0 - 1.0) * noise;
            let cph = 2.0 * std::f32::consts::PI * (57_000.0 * k + freq_off) * t + phase_off;
            mpx[i] = 0.4 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin()
                   + 0.1 * (2.0 * std::f32::consts::PI * 19_000.0 * t).sin()
                   + amp * symbol * cph.cos()
                   + n;
        }
        mpx
    }

    fn decode(fs: f32, mpx: &[f32]) -> RdsBlockDecoder {
        let mut fe = RdsFrontEnd::new(fs);
        let mut bd = RdsBlockDecoder::new();
        for chunk in mpx.chunks(26_214) { fe.process(chunk, &mut bd); }
        bd
    }

    /// The Costas loop must acquire from an arbitrary carrier phase — the
    /// headline test happens to start the NCO already in phase, which would
    /// hide a loop that never actually locks.
    #[test]
    fn test_front_end_acquires_from_any_carrier_phase() {
        let fs = 400_000.0f32;
        let bits = rds_bits(0x50DC, b"TESTFM  ", 12);
        for k in 0..8 {
            let phase = k as f32 * std::f32::consts::PI / 4.0;
            let bd = decode(fs, &rds_mpx(fs, &bits, phase, 0.0, 0.0, 0.3));
            assert_eq!(bd.pi(), 0x50DC, "PI lost at carrier phase {k}/8 turn");
            assert_eq!(bd.ps(), b"TESTFM  ", "PS lost at carrier phase {k}/8 turn");
        }
    }

    /// Loop gain is normalized by tracked baseband power, so acquisition must
    /// not depend on how hard RDS is injected into the multiplex. 0.047 is
    /// the realistic level for ~3 kHz RDS deviation inside a 75 kHz-deviation
    /// WFM signal through an atan2 discriminator.
    #[test]
    fn test_front_end_locks_across_injection_levels_and_offsets() {
        let fs = 400_000.0f32;
        let bits = rds_bits(0x50DC, b"TESTFM  ", 12);
        for amp in [0.6f32, 0.3, 0.15, 0.047, 0.02] {
            for foff in [0.0f32, -20.0, 20.0] {
                let bd = decode(fs, &rds_mpx(fs, &bits, 0.7, foff, 0.0, amp));
                assert_eq!(bd.ps(), b"TESTFM  ", "PS lost at amp {amp} offset {foff} Hz");
            }
        }
    }

    /// A wrong biphase half-pairing produces garbage once there is any noise
    /// to spoil the near-tie decisions, so the `sync_lost_bits` flip is the
    /// only thing that recovers it. Starting the stream one half-bit in puts
    /// the pairing on the wrong parity deliberately.
    #[test]
    fn test_front_end_recovers_from_wrong_biphase_pairing() {
        let fs = 400_000.0f32;
        let bits = rds_bits(0x50DC, b"TESTFM  ", 12);
        let mpx = rds_mpx(fs, &bits, 0.0, 0.0, 0.05, 0.3);
        let half = (fs / 2375.0) as usize;
        let bd = decode(fs, &mpx[half + 2..]);
        assert_eq!(bd.pi(), 0x50DC, "PI never recovered after parity flip");
        assert_eq!(bd.ps(), b"TESTFM  ", "PS never recovered after parity flip");
        // Recovery costs one flip interval, and must not cost much more.
        assert!(bd.sync_lost_bits() >= PARITY_FLIP_BITS,
            "expected the wrong-parity start to actually burn the flip timeout");
        assert!(bd.sync_lost_bits() < PARITY_FLIP_BITS + 600,
            "recovery took {} bits, far more than one flip interval", bd.sync_lost_bits());
    }

    /// The headline test's symbol clock is exactly 2375 Hz at exactly the
    /// stated fs, which lets a free-running dump accumulator pass without any
    /// timing recovery at all. A real receiver's crystal is off by tens of
    /// ppm, which drifts the half-bit grid by whole symbols over a few
    /// seconds — only the transition nudge can hold alignment through that.
    #[test]
    fn test_front_end_tracks_sample_clock_error() {
        let fs = 400_000.0f32;
        let bits = rds_bits(0x50DC, b"TESTFM  ", 12);
        for ppm in [-200.0f32, -50.0, 50.0, 200.0] {
            let mpx = rds_mpx_clk(fs, &bits, 0.3, 0.0, 0.0, 0.3, ppm);
            let bd = decode(fs, &mpx);
            assert_eq!(bd.pi(), 0x50DC, "PI lost at {ppm} ppm clock error");
            assert_eq!(bd.ps(), b"TESTFM  ", "PS lost at {ppm} ppm clock error");
            // Latching PS once is not enough: the dump grid must stay locked
            // for the whole run rather than slipping and re-acquiring, so
            // require near-continuous block sync (a clean lock costs ~103).
            assert!(bd.sync_lost_bits() < 250,
                "clock error {ppm} ppm cost {} unsynced bits — timing is slipping, not tracking",
                bd.sync_lost_bits());
        }
    }

    /// Decoding must survive additive broadband noise well above the
    /// subcarrier's own amplitude.
    #[test]
    fn test_front_end_decodes_under_noise() {
        let fs = 400_000.0f32;
        let bits = rds_bits(0x50DC, b"TESTFM  ", 12);
        for noise in [0.1f32, 0.5, 1.0] {
            let bd = decode(fs, &rds_mpx(fs, &bits, 0.7, 0.0, noise, 0.3));
            assert_eq!(bd.ps(), b"TESTFM  ", "PS lost at noise {noise}");
        }
    }

    /// Every rate-dependent constant is re-derived in `set_rate`, so the same
    /// front-end object must decode at a second rate after being driven at a
    /// first one — no accumulator or filter state may survive at the old scale.
    #[test]
    fn test_front_end_set_rate_rescales_state() {
        let bits = rds_bits(0x50DC, b"TESTFM  ", 12);
        let mut fe = RdsFrontEnd::new(400_000.0);

        // Drive it at 400 kHz first so every accumulator holds live state.
        let warm = rds_mpx(400_000.0, &bits, 0.0, 0.0, 0.0, 0.3);
        let mut throwaway = RdsBlockDecoder::new();
        for chunk in warm.chunks(26_214) { fe.process(chunk, &mut throwaway); }
        assert_eq!(throwaway.ps(), b"TESTFM  ");

        // Now switch rate and decode a 250 kHz stream with the same object.
        fe.set_rate(250_000.0);
        let mpx = rds_mpx(250_000.0, &bits, 0.9, 0.0, 0.0, 0.3);
        let mut bd = RdsBlockDecoder::new();
        for chunk in mpx.chunks(26_214) { fe.process(chunk, &mut bd); }
        assert_eq!(bd.pi(), 0x50DC, "PI not decoded after set_rate");
        assert_eq!(bd.ps(), b"TESTFM  ", "PS not decoded after set_rate");

        // Re-setting the same rate is a no-op and must not disturb a lock.
        let before = fe.is_active();
        fe.set_rate(250_000.0);
        assert_eq!(fe.is_active(), before);
    }

    /// A fresh front-end at each supported channel rate decodes the same MPX.
    #[test]
    fn test_front_end_decodes_at_several_channel_rates() {
        for fs in [200_000.0f32, 250_000.0, 400_000.0, 480_000.0, 960_000.0] {
            let bits = rds_bits(0x50DC, b"TESTFM  ", 12);
            let bd = decode(fs, &rds_mpx(fs, &bits, 0.7, 0.0, 0.0, 0.3));
            assert_eq!(bd.ps(), b"TESTFM  ", "PS lost at fs {fs}");
        }
    }

    /// Narrow-FM channel rates cannot represent 57 kHz at all; the front-end
    /// must stay idle rather than emit noise bits into the block decoder.
    #[test]
    fn test_front_end_idle_below_usable_rate() {
        let mut fe = RdsFrontEnd::new(48_000.0);
        assert!(!fe.is_active());
        let mut bd = RdsBlockDecoder::new();
        let noise: Vec<f32> = (0..100_000)
            .map(|i| ((i * 2654435761u64 as usize) as f32).sin())
            .collect();
        fe.process(&noise, &mut bd);
        assert_eq!(bd.sync_lost_bits(), 0, "idle front-end must push no bits");
        assert_eq!(bd.pi(), 0);

        fe.set_rate(400_000.0);
        assert!(fe.is_active(), "raising the rate must re-enable the front-end");
    }

    #[test]
    fn test_corrupted_block_does_not_poison_ps() {
        let mut d = RdsBlockDecoder::new();
        let pi = 0x1234;
        let ps = *b"RADIO 1 ";
        for seg in 0..4u16 {
            let b = seg; // 0A
            let dd = ((ps[(seg * 2) as usize] as u16) << 8) | ps[(seg * 2 + 1) as usize] as u16;
            // Corrupt segment 2's D block by flipping a bit mid-block
            if seg == 2 {
                let blk = make_block(dd, OFFSET_D) ^ (1 << 13);
                push_block(&mut d, make_block(pi, OFFSET_A));
                push_block(&mut d, make_block(b, OFFSET_B));
                push_block(&mut d, make_block(0, OFFSET_C));
                push_block(&mut d, blk);
            } else {
                push_group(&mut d, pi, b, 0, 0, dd, false);
            }
        }
        // Segments 0,1,3 decoded; corrupted segment 2 chars left as spaces/previous
        assert_eq!(&d.ps()[0..4], b"RADI");
        assert_eq!(&d.ps()[6..8], b"1 ");
        assert_ne!(&d.ps()[4..6], b"O ");
    }
}
