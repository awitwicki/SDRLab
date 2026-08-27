# SDRLab

Browser-based SDR app for HackRF: React + TypeScript + Vite frontend, WebUSB device access, Rust/WASM DSP pipeline (`dsp-wasm/`), AudioWorklet playback.

## Rules

- **Do NOT create git commits unless the user explicitly asks for one.** No auto-commits after finishing work.

## Commands

- `npm run dev` — build WASM (requires `wasm-pack` on PATH via `~/.cargo/bin`) then start Vite dev server
- `npm test` — run vitest once
- `npm run wasm:test` — run Rust tests in `dsp-wasm/`
- `npm run build` — typecheck + production build (also rebuilds WASM via `prebuild`)

## Structure

- `src/devices/hackrf.ts` — WebUSB HackRF driver
- `src/dsp/worker.ts` — DSP web worker wrapping the WASM pipeline
- `src/audio/` — AudioWorklet engine, recorder
- `src/ui/` — React components and hooks
- `dsp-wasm/` — Rust DSP (FFT, mixer, filter, demod, OOK decoder), built with wasm-pack into `dsp-wasm/pkg/`
