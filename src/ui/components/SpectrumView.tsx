import { useRef, useEffect, useCallback } from 'react';
import styles from './SpectrumView.module.css';

interface SpectrumViewProps {
  fftData: Float32Array | null;
  frequency: number;
  sampleRate: number;
  onTune: (hz: number) => void;
}

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
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compile error: ' + info);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext, vert: WebGLShader, frag: WebGLShader): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Program link error: ' + info);
  }
  return program;
}

export default function SpectrumView({ fftData, frequency, sampleRate, onTune }: SpectrumViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<{
    gl: WebGLRenderingContext;
    program: WebGLProgram;
    binBuffer: WebGLBuffer;
    powerBuffer: WebGLBuffer;
    locs: {
      a_bin: number;
      a_power: number;
      u_numBins: WebGLUniformLocation;
      u_minDb: WebGLUniformLocation;
      u_maxDb: WebGLUniformLocation;
      u_color: WebGLUniformLocation;
    };
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) return;

    const vert = createShader(gl, gl.VERTEX_SHADER, VERT_SHADER);
    const frag = createShader(gl, gl.FRAGMENT_SHADER, FRAG_SHADER);
    const program = createProgram(gl, vert, frag);

    glRef.current = {
      gl, program,
      binBuffer: gl.createBuffer()!,
      powerBuffer: gl.createBuffer()!,
      locs: {
        a_bin: gl.getAttribLocation(program, 'a_bin'),
        a_power: gl.getAttribLocation(program, 'a_power'),
        u_numBins: gl.getUniformLocation(program, 'u_numBins')!,
        u_minDb: gl.getUniformLocation(program, 'u_minDb')!,
        u_maxDb: gl.getUniformLocation(program, 'u_maxDb')!,
        u_color: gl.getUniformLocation(program, 'u_color')!,
      },
    };

    return () => {
      gl.deleteBuffer(glRef.current!.binBuffer);
      gl.deleteBuffer(glRef.current!.powerBuffer);
      gl.deleteProgram(program);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      glRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!fftData || !glRef.current) return;
    const { gl, program, binBuffer, powerBuffer, locs } = glRef.current;
    const canvas = canvasRef.current!;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.clearColor(0.1, 0.1, 0.18, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const numBins = fftData.length;
    const bins = new Float32Array(numBins);
    for (let i = 0; i < numBins; i++) bins[i] = i;

    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, binBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, bins, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(locs.a_bin);
    gl.vertexAttribPointer(locs.a_bin, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, powerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, fftData, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(locs.a_power);
    gl.vertexAttribPointer(locs.a_power, 1, gl.FLOAT, false, 0, 0);

    gl.uniform1f(locs.u_numBins, numBins);
    gl.uniform1f(locs.u_minDb, -80);
    gl.uniform1f(locs.u_maxDb, 0);
    gl.uniform4f(locs.u_color, 0.0, 0.83, 1.0, 1.0);

    gl.drawArrays(gl.LINE_STRIP, 0, numBins);
  }, [fftData]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const freqOffset = (x - 0.5) * sampleRate;
    onTune(frequency + freqOffset);
  }, [frequency, sampleRate, onTune]);

  return (
    <div className={styles.container}>
      <canvas ref={canvasRef} className={styles.canvas} onClick={handleClick} />
    </div>
  );
}
