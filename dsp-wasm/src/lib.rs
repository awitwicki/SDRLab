use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod fft;
mod filter;
mod mixer;
mod demod;
mod ook;
mod pipeline;
mod resampler;
mod rds;

use pipeline::DspState;

thread_local! {
    static STATE: RefCell<DspState> = RefCell::new(DspState::new(2_000_000, 1024));
}

#[wasm_bindgen]
pub fn wasm_init(sample_rate: u32, fft_size: u32, demod_mode: u8,
                 squelch_level: f32, freq_offset: f32, ook_enabled: bool, channel_bw: f32,
                 audio_enabled: bool) {
    STATE.with(|s| {
        *s.borrow_mut() = DspState::new(sample_rate, fft_size);
        s.borrow_mut().update_config(sample_rate, demod_mode, fft_size, squelch_level, freq_offset, ook_enabled, channel_bw, audio_enabled);
    });
}

#[wasm_bindgen]
pub fn wasm_update_config(sample_rate: u32, demod_mode: u8, fft_size: u32,
                          squelch_level: f32, freq_offset: f32, ook_enabled: bool, channel_bw: f32,
                          audio_enabled: bool) {
    STATE.with(|s| {
        s.borrow_mut().update_config(sample_rate, demod_mode, fft_size, squelch_level, freq_offset, ook_enabled, channel_bw, audio_enabled);
    });
}

#[wasm_bindgen]
pub fn wasm_process_iq_raw(raw: &[u8], compute_fft: bool) {
    STATE.with(|s| { s.borrow_mut().process_iq_raw(raw, compute_fft); });
}

#[wasm_bindgen]
pub fn wasm_get_fft_ptr() -> usize {
    STATE.with(|s| s.borrow().fft_out.as_ptr() as usize)
}

#[wasm_bindgen]
pub fn wasm_get_fft_len() -> usize {
    STATE.with(|s| s.borrow().fft_out.len())
}

#[wasm_bindgen]
pub fn wasm_get_audio_ptr() -> usize {
    STATE.with(|s| s.borrow().audio_out.as_ptr() as usize)
}

#[wasm_bindgen]
pub fn wasm_get_audio_len() -> usize {
    STATE.with(|s| s.borrow().audio_out.len())
}

#[wasm_bindgen]
pub fn wasm_get_bits_ptr() -> usize {
    STATE.with(|s| s.borrow().bits_out.as_ptr() as usize)
}

#[wasm_bindgen]
pub fn wasm_get_bits_len() -> usize {
    STATE.with(|s| s.borrow().bits_out.len())
}

#[wasm_bindgen]
pub fn wasm_get_squelch_open() -> bool {
    STATE.with(|s| s.borrow().squelch_open)
}

#[wasm_bindgen]
pub fn wasm_get_rds_version() -> u32 {
    STATE.with(|s| s.borrow().rds_blocks.version())
}

#[wasm_bindgen]
pub fn wasm_get_rds_pi() -> u16 {
    STATE.with(|s| s.borrow().rds_blocks.pi())
}

#[wasm_bindgen]
pub fn wasm_get_rds_ps_ptr() -> usize {
    STATE.with(|s| s.borrow().rds_blocks.ps().as_ptr() as usize)
}

#[wasm_bindgen]
pub fn wasm_get_rds_ps_len() -> usize {
    8
}

#[wasm_bindgen]
pub fn wasm_get_rds_rt_ptr() -> usize {
    STATE.with(|s| s.borrow().rds_blocks.rt().as_ptr() as usize)
}

#[wasm_bindgen]
pub fn wasm_get_rds_rt_len() -> usize {
    64
}

/// Clears decoded RDS station state. Called from the worker when it
/// observes the tuned frequency change (see reset_rds's doc comment in
/// pipeline.rs for why this can't just live inside wasm_update_config).
#[wasm_bindgen]
pub fn wasm_reset_rds() {
    STATE.with(|s| { s.borrow_mut().reset_rds(); });
}
