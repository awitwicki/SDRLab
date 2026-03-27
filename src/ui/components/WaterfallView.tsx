import { useRef, useEffect, useCallback } from 'react';
import type { ColorMap, DemodMode } from '../../devices/types';
import styles from './WaterfallView.module.css';

interface WaterfallViewProps {
  fftData: Float32Array | null;
  frequency: number;
  sampleRate: number;
  colorMap: ColorMap;
  tuningOffset: number;
  demodMode: DemodMode;
  waterfallSpeed: number;
  displayOffset: number;
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

const VERT_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = (a_position + 1.0) / 2.0;
  }
`;

const FRAG_SHADER = `
  precision mediump float;
  uniform sampler2D u_texture;
  uniform float u_scrollOffset;
  uniform int u_colorMap;
  varying vec2 v_texCoord;

  vec3 thermal(float v) {
    if (v < 0.33) return mix(vec3(0.0, 0.0, 0.3), vec3(1.0, 1.0, 0.0), v * 3.0);
    if (v < 0.66) return mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.2, 0.0), (v - 0.33) * 3.0);
    return mix(vec3(1.0, 0.2, 0.0), vec3(1.0, 1.0, 1.0), (v - 0.66) * 3.0);
  }

  vec3 green(float v) {
    return vec3(0.0, v, v * 0.3);
  }

  void main() {
    float y = fract(v_texCoord.y + u_scrollOffset);
    float value = texture2D(u_texture, vec2(v_texCoord.x, y)).r;
    vec3 color;
    if (u_colorMap == 0) { color = thermal(value); }
    else if (u_colorMap == 1) { color = vec3(value); }
    else { color = green(value); }
    gl_FragColor = vec4(color, 1.0);
  }
`;

const WATERFALL_ROWS = 512;
const CURSOR_HIT = 10;

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

const COLOR_MAP_INDEX: Record<ColorMap, number> = { thermal: 0, grayscale: 1, green: 2 };

export default function WaterfallView({
  fftData, frequency, sampleRate, colorMap, tuningOffset, demodMode, waterfallSpeed, displayOffset,
  onTuningOffsetChange, onCenterFrequencyPan,
}: WaterfallViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    gl: WebGLRenderingContext;
    program: WebGLProgram;
    texture: WebGLTexture;
    currentRow: number;
    fftWidth: number;
    u_scrollOffset: WebGLUniformLocation;
    u_colorMap: WebGLUniformLocation;
  } | null>(null);

  const dragRef = useRef<{ type: 'cursor' | 'pan'; startX: number; startVal: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { alpha: false });
    if (!gl) return;

    const vert = createShader(gl, gl.VERTEX_SHADER, VERT_SHADER);
    const frag = createShader(gl, gl.FRAGMENT_SHADER, FRAG_SHADER);
    const program = gl.createProgram()!;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const fftWidth = 1024;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, fftWidth, WATERFALL_ROWS, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(fftWidth * WATERFALL_ROWS));

    stateRef.current = {
      gl, program, texture, currentRow: 0, fftWidth,
      u_scrollOffset: gl.getUniformLocation(program, 'u_scrollOffset')!,
      u_colorMap: gl.getUniformLocation(program, 'u_colorMap')!,
    };

    return () => {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      stateRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!fftData || !stateRef.current) return;
    const s = stateRef.current;
    const { gl, program, texture } = s;
    const canvas = canvasRef.current!;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    gl.viewport(0, 0, canvas.width, canvas.height);

    if (fftData.length !== s.fftWidth) {
      s.fftWidth = fftData.length;
      s.currentRow = 0;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, s.fftWidth, WATERFALL_ROWS, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(s.fftWidth * WATERFALL_ROWS));
    }

    const row = new Uint8Array(s.fftWidth);
    for (let i = 0; i < s.fftWidth; i++) {
      const val = i < fftData.length ? fftData[i]! : -80;
      const minDb = -80 + displayOffset;
      const maxDb = 0 + displayOffset;
      const norm = (val - minDb) / (maxDb - minDb);
      row[i] = Math.max(0, Math.min(255, Math.floor(norm * 255)));
    }

    // Write multiple rows per frame based on speed (1-5)
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (let r = 0; r < waterfallSpeed; r++) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, s.currentRow, s.fftWidth, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, row);
      s.currentRow = (s.currentRow + 1) % WATERFALL_ROWS;
    }

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform1f(s.u_scrollOffset, s.currentRow / WATERFALL_ROWS);
    gl.uniform1i(s.u_colorMap, COLOR_MAP_INDEX[colorMap] ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, [fftData, colorMap, waterfallSpeed]);

  useEffect(() => {
    if (!stateRef.current) return;
    const s = stateRef.current;
    s.currentRow = 0;
    s.gl.bindTexture(s.gl.TEXTURE_2D, s.texture);
    s.gl.texImage2D(s.gl.TEXTURE_2D, 0, s.gl.LUMINANCE, s.fftWidth, WATERFALL_ROWS, 0, s.gl.LUMINANCE, s.gl.UNSIGNED_BYTE, new Uint8Array(s.fftWidth * WATERFALL_ROWS));
  }, [sampleRate]);

  const cursorPct = 50 + (tuningOffset / sampleRate) * 100;
  const bw = getDemodBandwidth(demodMode);
  const bwPct = (bw / sampleRate) * 100;

  const isNearCursor = useCallback((clientX: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const cursorX = rect.left + (cursorPct / 100) * rect.width;
    return Math.abs(clientX - cursorX) < CURSOR_HIT;
  }, [cursorPct]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isNearCursor(e.clientX)) {
      dragRef.current = { type: 'cursor', startX: e.clientX, startVal: tuningOffset };
    } else {
      dragRef.current = { type: 'pan', startX: e.clientX, startVal: frequency };
    }
    e.preventDefault();
  }, [isNearCursor, tuningOffset, frequency]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const deltaX = e.clientX - dragRef.current.startX;
    const deltaFreq = (deltaX / rect.width) * sampleRate;

    if (dragRef.current.type === 'cursor') {
      onTuningOffsetChange(dragRef.current.startVal + deltaFreq);
    } else if (Math.abs(deltaX) > 3) {
      onCenterFrequencyPan(dragRef.current.startVal - deltaFreq);
    }

    const el = e.currentTarget as HTMLDivElement;
    if (dragRef.current.type === 'pan') el.style.cursor = 'grabbing';
    else el.style.cursor = 'col-resize';
  }, [sampleRate, onTuningOffsetChange, onCenterFrequencyPan]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (dragRef.current) {
      const dx = Math.abs(e.clientX - dragRef.current.startX);
      if (dx <= 3 && dragRef.current.type !== 'cursor') {
        const rect = containerRef.current!.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        onTuningOffsetChange((x - 0.5) * sampleRate);
      }
      dragRef.current = null;
      (e.currentTarget as HTMLDivElement).style.cursor = 'crosshair';
    }
  }, [sampleRate, onTuningOffsetChange]);

  const handleMouseLeave = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleCursorStyle = useCallback((e: React.MouseEvent) => {
    if (dragRef.current) return;
    (e.currentTarget as HTMLDivElement).style.cursor = isNearCursor(e.clientX) ? 'col-resize' : 'grab';
  }, [isNearCursor]);

  return (
    <div
      ref={containerRef}
      className={styles.container}
      onMouseDown={handleMouseDown}
      onMouseMove={e => { handleMouseMove(e); if (!dragRef.current) handleCursorStyle(e); }}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      <canvas ref={canvasRef} className={styles.canvas} />
      <div className={styles.bandwidth} style={{ left: `${cursorPct - bwPct / 2}%`, width: `${bwPct}%` }} />
      <div className={styles.cursor} style={{ left: `${cursorPct}%` }} />
      {!fftData && <div className={styles.hint}>drag to pan &bull; click to tune</div>}
    </div>
  );
}
