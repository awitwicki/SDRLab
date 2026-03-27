// src/devices/hackrf.ts
import type { SDRDevice, DeviceInfo } from './types';

const HACKRF_VID = 0x1d50;
const HACKRF_PID = 0x6089;

const enum VendorRequest {
  SET_TRANSCEIVER_MODE = 1,
  SET_SAMPLE_RATE = 6,
  SET_BASEBAND_FILTER_BW = 7,
  SET_FREQ = 0x10,
  AMP_ENABLE = 0x11,
  SET_LNA_GAIN = 0x13,
  SET_VGA_GAIN = 0x14,
}

const enum TransceiverMode {
  OFF = 0,
  RECEIVE = 1,
  TRANSMIT = 2,
}

export class HackRF implements SDRDevice {
  private device: USBDevice | null = null;
  private streaming = false;
  private rxCallback: ((iq: Float32Array) => void) | null = null;
  private gains: Record<string, number> = { amp: 0, lna: 16, vga: 20 };

  async connect(): Promise<void> {
    this.device = await navigator.usb.requestDevice({
      filters: [{ vendorId: HACKRF_VID, productId: HACKRF_PID }],
    });
    await this.device.open();
    // Always select configuration — even if already active, this ensures
    // macOS releases any kernel driver claiming the device
    await this.device.selectConfiguration(1);
    await this.device.claimInterface(0);
    // Explicitly activate the interface — required on macOS to fully
    // transfer control from the kernel USB driver to Chrome
    await this.device.selectAlternateInterface(0, 0);

    // Verify connectivity with a board ID read
    try {
      const result = await this.device.controlTransferIn(
        { requestType: 'vendor', recipient: 'device', request: 14 /* BOARD_ID_READ */, value: 0, index: 0 },
        1,
      );
      console.log('[HackRF] Connected, board ID:', result.data?.getUint8(0));
    } catch {
      console.warn('[HackRF] Board ID read failed — control transfers may not work. Try unplugging and replugging the device.');
    }

    // Reset to known state (non-fatal)
    try {
      await this.device.controlTransferOut(
        { requestType: 'vendor', recipient: 'device', request: VendorRequest.SET_TRANSCEIVER_MODE, value: TransceiverMode.OFF, index: 0 },
      );
    } catch {
      // Device may already be idle
    }
  }

  async disconnect(): Promise<void> {
    if (this.streaming) await this.stop();
    if (this.device) {
      await this.device.releaseInterface(0);
      await this.device.close();
      this.device = null;
    }
  }

  async setFrequency(hz: number): Promise<void> {
    if (!this.device) return;
    const mhz = Math.floor(hz / 1_000_000);
    const remainder = Math.floor(hz % 1_000_000);
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    view.setUint32(0, mhz, true);
    view.setUint32(4, remainder, true);
    await this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: VendorRequest.SET_FREQ, value: 0, index: 0 },
      data,
    );
  }

  async setSampleRate(hz: number): Promise<void> {
    if (!this.device) return;
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    view.setUint32(0, Math.floor(hz), true);
    view.setUint32(4, 1, true);
    await this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: VendorRequest.SET_SAMPLE_RATE, value: 0, index: 0 },
      data,
    );
    await this.setBasebandFilterBW(hz);
  }

  private async setBasebandFilterBW(hz: number): Promise<void> {
    if (!this.device) return;
    const supported = [1_750_000, 2_500_000, 3_500_000, 5_000_000, 5_500_000,
      6_000_000, 7_000_000, 8_000_000, 9_000_000, 10_000_000, 12_000_000,
      14_000_000, 15_000_000, 20_000_000, 24_000_000, 28_000_000];
    let bw = supported[0]!;
    for (const s of supported) {
      if (s <= hz) bw = s;
    }
    // libhackrf encodes bandwidth in value (low 16 bits) and index (high 16 bits), no data payload
    await this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: VendorRequest.SET_BASEBAND_FILTER_BW, value: bw & 0xffff, index: bw >> 16 },
    );
  }

  async setGain(stage: string, value: number): Promise<void> {
    this.gains[stage] = value;
    if (!this.device) return;

    switch (stage) {
      case 'amp': {
        const enabled = value > 0 ? 1 : 0;
        await this.device.controlTransferOut(
          { requestType: 'vendor', recipient: 'device', request: VendorRequest.AMP_ENABLE, value: enabled, index: 0 },
        );
        break;
      }
      case 'lna': {
        // libhackrf uses controlTransferIn — reads back 1-byte success flag
        const clamped = Math.round(value / 8) * 8;
        await this.device.controlTransferIn(
          { requestType: 'vendor', recipient: 'device', request: VendorRequest.SET_LNA_GAIN, value: 0, index: clamped },
          1,
        );
        break;
      }
      case 'vga': {
        const clamped = Math.round(value / 2) * 2;
        await this.device.controlTransferIn(
          { requestType: 'vendor', recipient: 'device', request: VendorRequest.SET_VGA_GAIN, value: 0, index: clamped },
          1,
        );
        break;
      }
    }
  }

  async startRx(callback: (iq: Float32Array) => void): Promise<void> {
    if (!this.device || this.streaming) return;
    this.rxCallback = callback;
    this.streaming = true;

    // Parameters (freq, sample rate, gains) must be set BEFORE entering RX mode.
    // The caller is responsible for configuring them via setFrequency/setSampleRate/setGain.
    await this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: VendorRequest.SET_TRANSCEIVER_MODE, value: TransceiverMode.RECEIVE, index: 0 },
    );

    this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const TRANSFER_SIZE = 262144;
    while (this.streaming && this.device) {
      try {
        const result = await this.device.transferIn(1, TRANSFER_SIZE);
        if (result.data && result.data.byteLength > 0 && this.rxCallback) {
          const raw = new Int8Array(result.data.buffer);
          const floats = new Float32Array(raw.length);
          for (let i = 0; i < raw.length; i++) {
            floats[i] = raw[i]! / 128;
          }
          this.rxCallback(floats);
        }
      } catch (err) {
        if (this.streaming) {
          console.error('HackRF read error:', err);
        }
        break;
      }
    }
  }

  async startTx(_callback: () => Float32Array): Promise<void> {
    throw new Error('TX not implemented');
  }

  async stop(): Promise<void> {
    this.streaming = false;
    this.rxCallback = null;
    if (this.device) {
      // Release interface to abort any pending transferIn, then reclaim
      try {
        await this.device.releaseInterface(0);
        await this.device.claimInterface(0);
        await this.device.selectAlternateInterface(0, 0);
      } catch {
        // Interface may already be released
      }
      try {
        await this.device.controlTransferOut(
          { requestType: 'vendor', recipient: 'device', request: VendorRequest.SET_TRANSCEIVER_MODE, value: TransceiverMode.OFF, index: 0 },
        );
      } catch {
        // Device may already be disconnected
      }
    }
  }

  getInfo(): DeviceInfo {
    return {
      name: 'HackRF One',
      serial: this.device?.serialNumber ?? '',
      firmwareVersion: '',
      minFrequency: 1_000_000,
      maxFrequency: 6_000_000_000,
      minSampleRate: 2_000_000,
      maxSampleRate: 20_000_000,
      gainStages: [
        { name: 'amp', min: 0, max: 14, step: 14, value: this.gains['amp'] ?? 0 },
        { name: 'lna', min: 0, max: 40, step: 8, value: this.gains['lna'] ?? 16 },
        { name: 'vga', min: 0, max: 62, step: 2, value: this.gains['vga'] ?? 20 },
      ],
    };
  }
}
