use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod fft;
mod filter;
mod mixer;
mod demod;
mod ook;
mod pipeline;

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
pub fn wasm_process_iq_raw(raw: &[u8]) {
    STATE.with(|s| { s.borrow_mut().process_iq_raw(raw); });
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
