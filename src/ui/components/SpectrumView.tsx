import { useRef, useEffect, useCallback, useState } from 'react';
import type { DemodMode } from '../../devices/types';
import styles from './SpectrumView.module.css';

interface SpectrumViewProps {
  fftData: Float32Array | null;
  frequency: number;
  sampleRate: number;
  tuningOffset: number;
  demodMode: DemodMode;
  displayOffset: number;
  fftSmoothing: number;
  onTuningOffsetChange: (offset: number) => void;
  onCenterFrequencyPan: (hz: number) => void;
}

function getDemodBandwidth(mode: DemodMode): number {
  switch (mode) {
    case 'WFM': return 200_000;
    case 'NFM': return 12_500;
    case 'AM':  return 10_000;
  }
}

const MIN_DB = -80;
const MAX_DB = 0;

const VERT_SHADER = `
  attribute float a_bin;
  attribute float a_power;
  uniform float u_numBins;
  uniform float u_minDb;
  uniform float u_maxDb;
  void main() {
    float x = (a_bin / u_numBins) * 2.0 - 1.0;
    float y = ((a_power - u_minDb) / (u_maxDb - u_minDb)) * 2.0 - 1.0;
    y = clamp(y, -1.0, 1.0);
    gl_Position = vec4(x, y, 0.0, 1.0);
  }
`;

const OVERLAY_VERT = `
  attribute vec2 a_pos;
  void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

const FRAG_SHADER = `
  precision mediump float;
  uniform vec4 u_color;
  void main() {
    gl_FragColor = u_color;
  }
`;

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function createProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vert = createShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = createShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram()!;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  return program;
}

export default function SpectrumView({
  fftData, frequency, sampleRate, tuningOffset, demodMode, displayOffset, fftSmoothing,
  onTuningOffsetChange, onCenterFrequencyPan,
}: SpectrumViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<{
    gl: WebGLRenderingContext;
    specProgram: WebGLProgram;
    overlayProgram: WebGLProgram;
    binBuffer: WebGLBuffer;
    powerBuffer: WebGLBuffer;
    overlayBuffer: WebGLBuffer;
  } | null>(null);

  const [mouseFreq, setMouseFreq] = useState<{ freq: number; power: number } | null>(null);
  const smoothBufRef = useRef<Float32Array | null>(null);
  const dragRef = useRef<{ type: 'cursor' | 'pan'; startX: number; startFreq: number } | null>(null);
  const fpsLabelRef = useRef<HTMLDivElement>(null);
  const fpsCountRef = useRef({ count: 0, lastTime: performance.now() });

  // Init WebGL
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) return;

    glRef.current = {
      gl,
      specProgram: createProgram(gl, VERT_SHADER, FRAG_SHADER),
      overlayProgram: createProgram(gl, OVERLAY_VERT, FRAG_SHADER),
      binBuffer: gl.createBuffer()!,
      powerBuffer: gl.createBuffer()!,
      overlayBuffer: gl.createBuffer()!,
    };

    return () => {
      if (glRef.current) {
        gl.deleteProgram(glRef.current.specProgram);
        gl.deleteProgram(glRef.current.overlayProgram);
        gl.deleteBuffer(glRef.current.binBuffer);
        gl.deleteBuffer(glRef.current.powerBuffer);
        gl.deleteBuffer(glRef.current.overlayBuffer);
        glRef.current = null;
      }
    };
  }, []);

  // Render
  useEffect(() => {
    if (!fftData || !glRef.current) return;

    // FPS counter (update DOM directly to avoid React re-renders)
    const fc = fpsCountRef.current;
    fc.count++;
    const nowFps = performance.now();
    const elapsed = nowFps - fc.lastTime;
    if (elapsed > 1000 && fpsLabelRef.current) {
      fpsLabelRef.current.textContent = `${Math.round(fc.count * 1000 / elapsed)} FPS`;
      fc.count = 0;
      fc.lastTime = nowFps;
    }

    // Spatial smoothing: moving average across frequency bins (smooths jagged peaks)
    // kernelHalf = 0 (no smoothing) to 15 (heavy smoothing)
    const kernelHalf = Math.round((fftSmoothing / 100) * 15);
    const numBins = fftData.length;
    if (!smoothBufRef.current || smoothBufRef.current.length !== numBins) {
      smoothBufRef.current = new Float32Array(numBins);
    }
    const smoothed = smoothBufRef.current;
    if (kernelHalf <= 0) {
      smoothed.set(fftData);
    } else {
      for (let i = 0; i < numBins; i++) {
        const lo = Math.max(0, i - kernelHalf);
        const hi = Math.min(numBins - 1, i + kernelHalf);
        let sum = 0;
        for (let j = lo; j <= hi; j++) sum += fftData[j]!;
        smoothed[i] = sum / (hi - lo + 1);
      }
    }

    const { gl, specProgram, overlayProgram, binBuffer, powerBuffer, overlayBuffer } = glRef.current;
    const canvas = canvasRef.current!;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.clearColor(0.1, 0.1, 0.18, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // --- Grid lines via overlay program ---
    gl.useProgram(overlayProgram);
    const overlayPosLoc = gl.getAttribLocation(overlayProgram, 'a_pos');
    const overlayColorLoc = gl.getUniformLocation(overlayProgram, 'u_color')!;

    const gridVerts: number[] = [];
    // Horizontal dB lines
    for (let db = -60; db >= MIN_DB; db -= 20) {
      const y = ((db - MIN_DB) / (MAX_DB - MIN_DB)) * 2 - 1;
      gridVerts.push(-1, y, 1, y);
    }
    // Vertical lines every 1/8 of width
    for (let i = 1; i < 8; i++) {
      const x = (i / 8) * 2 - 1;
      gridVerts.push(x, -1, x, 1);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridVerts), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(overlayPosLoc);
    gl.vertexAttribPointer(overlayPosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(overlayColorLoc, 0.16, 0.16, 0.29, 1.0);
    gl.drawArrays(gl.LINES, 0, gridVerts.length / 2);

    // --- Spectrum line ---
    gl.useProgram(specProgram);
    const bins = new Float32Array(numBins);
    for (let i = 0; i < numBins; i++) bins[i] = i;

    const specBinLoc = gl.getAttribLocation(specProgram, 'a_bin');
    const specPowerLoc = gl.getAttribLocation(specProgram, 'a_power');

    gl.bindBuffer(gl.ARRAY_BUFFER, binBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, bins, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(specBinLoc);
    gl.vertexAttribPointer(specBinLoc, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, powerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, smoothed, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(specPowerLoc);
    gl.vertexAttribPointer(specPowerLoc, 1, gl.FLOAT, false, 0, 0);

    gl.uniform1f(gl.getUniformLocation(specProgram, 'u_numBins')!, numBins);
    gl.uniform1f(gl.getUniformLocation(specProgram, 'u_minDb')!, MIN_DB + displayOffset);
    gl.uniform1f(gl.getUniformLocation(specProgram, 'u_maxDb')!, MAX_DB + displayOffset);
    gl.uniform4f(gl.getUniformLocation(specProgram, 'u_color')!, 0.0, 0.83, 1.0, 1.0);
    gl.drawArrays(gl.LINE_STRIP, 0, numBins);

    gl.disable(gl.BLEND);
  }, [fftData, fftSmoothing, displayOffset]);

  // Offset to percentage
  const cursorPct = 50 + (tuningOffset / sampleRate) * 100;
  const bw = getDemodBandwidth(demodMode);
  const bwPct = (bw / sampleRate) * 100;

  const CURSOR_HIT = 10; // px hit area for cursor drag

  const xToOffset = useCallback((clientX: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    return (x - 0.5) * sampleRate;
  }, [sampleRate]);

  const isNearCursor = useCallback((clientX: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const cursorX = rect.left + (cursorPct / 100) * rect.width;
    return Math.abs(clientX - cursorX) < CURSOR_HIT;
  }, [cursorPct]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isNearCursor(e.clientX)) {
      dragRef.current = { type: 'cursor', startX: e.clientX, startFreq: tuningOffset };
    } else {
      dragRef.current = { type: 'pan', startX: e.clientX, startFreq: frequency };
    }
    e.preventDefault();
  }, [isNearCursor, tuningOffset, frequency]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Update readout
    if (smoothBufRef.current && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const freq = frequency + (x - 0.5) * sampleRate;
      const buf = smoothBufRef.current;
      const binIdx = Math.round(x * buf.length);
      const power = binIdx >= 0 && binIdx < buf.length ? buf[binIdx]! : MIN_DB;
      setMouseFreq({ freq, power });
    }

    // Handle drag
    if (!dragRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const deltaX = e.clientX - dragRef.current.startX;
    const deltaFreq = (deltaX / rect.width) * sampleRate;

    if (dragRef.current.type === 'cursor') {
      onTuningOffsetChange(dragRef.current.startFreq + deltaFreq);
    } else {
      const dx = Math.abs(e.clientX - dragRef.current.startX);
      if (dx > 3) {
        onCenterFrequencyPan(dragRef.current.startFreq - deltaFreq);
      }
    }
  }, [fftData, frequency, sampleRate, onTuningOffsetChange, onCenterFrequencyPan]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (dragRef.current) {
      const dx = Math.abs(e.clientX - dragRef.current.startX);
      if (dx <= 3 && dragRef.current.type !== 'cursor') {
        // Click-to-tune
        onTuningOffsetChange(xToOffset(e.clientX));
      }
      dragRef.current = null;
    }
  }, [xToOffset, onTuningOffsetChange]);

  const handleMouseLeave = useCallback(() => {
    setMouseFreq(null);
    dragRef.current = null;
  }, []);

  const getCursor = useCallback((e: React.MouseEvent): string => {
    if (dragRef.current?.type === 'pan') return 'grabbing';
    if (dragRef.current?.type === 'cursor') return 'col-resize';
    if (isNearCursor(e.clientX)) return 'col-resize';
    return 'crosshair';
  }, [isNearCursor]);

  return (
    <div
      ref={containerRef}
      className={styles.container}
      onMouseDown={handleMouseDown}
      onMouseMove={e => { handleMouseMove(e); (e.currentTarget as HTMLDivElement).style.cursor = getCursor(e); }}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      <canvas ref={canvasRef} className={styles.canvas} />

      {/* Dynamic dB scale */}
      <div className={styles.dbLabels}>
        {(() => {
          const minDb = MIN_DB + displayOffset;
          const maxDb = MAX_DB + displayOffset;
          const range = maxDb - minDb;
          const labels: { db: number; pct: number }[] = [];
          const step = 10;
          const start = Math.ceil(minDb / step) * step;
          for (let db = start; db < maxDb; db += step) {
            labels.push({ db, pct: 100 - ((db - minDb) / range) * 100 });
          }
          return labels.map(l => (
            <div key={l.db} className={styles.dbLabel} style={{ top: `${l.pct}%` }}>
              {l.db}
            </div>
          ));
        })()}
      </div>

      {/* FPS counter */}
      <div ref={fpsLabelRef} className={styles.fpsLabel}>-- FPS</div>

      {/* Demod bandwidth highlight */}
      <div
        className={styles.bandwidth}
        style={{ left: `${cursorPct - bwPct / 2}%`, width: `${bwPct}%` }}
      />

      {/* Tuning cursor */}
      <div className={styles.cursor} style={{ left: `${cursorPct}%` }} />
      <div className={styles.cursorTriangle} style={{ left: `${cursorPct}%` }} />

      {/* Mouse readout */}
      {mouseFreq && (
        <div className={styles.readout}>
          {(mouseFreq.freq / 1e6).toFixed(3)} MHz &nbsp; {mouseFreq.power.toFixed(1)} dB
        </div>
      )}
    </div>
  );
}
