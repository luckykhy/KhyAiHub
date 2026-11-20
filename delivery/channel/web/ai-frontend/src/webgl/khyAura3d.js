/**
 * khyAura3d — framework-agnostic, zero-dependency WebGL "aura" background.
 *
 * Deliberately small: a single full-screen quad running one fragment shader
 * that paints a slow, low-contrast drift of the brand accent colors. It is a
 * backdrop, not content — alpha stays low so text over it never loses contrast.
 *
 * No npm dependency (no three.js): native WebGL only. Colors come from the CSS
 * variables the theme already owns (--khy-primary / --khy-accent /
 * --khy-accent-end), read off the canvas' computed style so it follows both the
 * light and the `html.dark` theme. When a variable cannot be read the module
 * falls back to the platform baseline values fixed in the aesthetics standard
 * ([DESIGN-FE-012] §3.2 / AESTHETICS-TOKENS.json `color.accent`).
 *
 * Degradation is silent by contract:
 *   - prefers-reduced-motion: reduce -> one static frame, no animation loop.
 *   - WebGL unavailable / context creation fails -> createKhyAura3d() returns
 *     null and nothing is drawn. Callers treat null as "no backdrop".
 *
 * Usage:
 *   import { createKhyAura3d } from './webgl/khyAura3d.js';
 *   const aura = createKhyAura3d(canvas, { intensity: 0.5 });
 *   aura?.pause(); aura?.resume(); aura?.destroy();
 *
 * The canvas must be sized by CSS (e.g. position:absolute; inset:0). This module
 * only sets its backing-store resolution from devicePixelRatio.
 */

// The one query the module needs. Kept as a constant so the reduce path is a
// single, greppable decision point.
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// Platform baseline fallbacks. `accent` is the value fixed by the standard
// (light #2563eb / dark #3b82f6). `accent-mid` / `accent-end` are not fixed by
// the standard (registry valueSemantics = "omitted"); the Web surface is the
// platform's baseline end (standard §7 Q1), so its --khy-accent / --khy-accent-end
// values stand in here only when the CSS variable is unreadable.
const BASELINE = {
  light: { accent: '#2563eb', accentMid: '#8b5cf6', accentEnd: '#d946ef' },
  dark: { accent: '#3b82f6', accentMid: '#a78bfa', accentEnd: '#e879f9' },
};

// GLSL ES 1.00 so the same program runs on WebGL1 and WebGL2 contexts.
const VERT_SRC = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;

uniform vec2 u_res;
uniform float u_time;
uniform float u_intensity;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float blob(vec2 p, vec2 c, float r) {
  return smoothstep(r, 0.0, length(p - c));
}

void main() {
  vec2 res = u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / min(res.x, res.y);
  float t = u_time;

  vec2 c1 = vec2(0.30 * sin(t * 0.11) - 0.04, 0.26 * cos(t * 0.09) + 0.06);
  vec2 c2 = vec2(0.34 * cos(t * 0.07) + 0.06, 0.30 * sin(t * 0.13) - 0.05);
  vec2 c3 = vec2(0.26 * sin(t * 0.05 + 1.7) - 0.02, 0.24 * cos(t * 0.06 + 2.1) - 0.02);

  float b1 = blob(p, c1, 0.95);
  float b2 = blob(p, c2, 0.85);
  float b3 = blob(p, c3, 0.78);

  float wsum = b1 + b2 + b3 + 0.0001;
  vec3 col = (u_c1 * b1 + u_c2 * b2 + u_c3 * b3) / wsum;

  // Fine grain breaks up the gradient banding without adding visible texture.
  float grain = (noise(gl_FragCoord.xy * 0.75 + t * 2.0) - 0.5) * 0.05;
  float a = clamp(b1 * 0.42 + b2 * 0.34 + b3 * 0.28 + grain, 0.0, 1.0) * u_intensity;

  gl_FragColor = vec4(col, a);
}
`;

function parseColor(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent' || s === 'initial' || s.startsWith('var(')) return null;

  if (s[0] === '#') {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if ([r, g, b].some(Number.isNaN)) return null;
      return [r / 255, g / 255, b / 255];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].some(Number.isNaN)) return null;
      return [r / 255, g / 255, b / 255];
    }
    return null;
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length >= 3) {
      const ch = (v) => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / 255);
      const rgb = [ch(parts[0]), ch(parts[1]), ch(parts[2])];
      if (rgb.some(Number.isNaN)) return null;
      return rgb;
    }
  }
  return null;
}

function prefersDark(win) {
  try {
    if (win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches) return true;
  } catch {
    /* matchMedia unavailable — fall through to the class check */
  }
  try {
    const root = win.document && win.document.documentElement;
    if (root && root.classList && root.classList.contains('dark')) return true;
  } catch {
    /* no document (SSR / detached) — treat as light */
  }
  return false;
}

function matchesReduceMotion(win) {
  try {
    return !!(win.matchMedia && win.matchMedia(REDUCED_MOTION_QUERY).matches);
  } catch {
    return false;
  }
}

function resolvePalette(canvas, win) {
  const base = prefersDark(win) ? BASELINE.dark : BASELINE.light;
  let styles = null;
  try {
    const el = canvas || (win.document && win.document.documentElement);
    if (el) styles = win.getComputedStyle(el);
  } catch {
    styles = null;
  }
  const pick = (name, fallbackHex) => {
    let raw = null;
    try {
      raw = styles ? styles.getPropertyValue(name) : null;
    } catch {
      raw = null;
    }
    return parseColor(raw) || parseColor(fallbackHex) || [0, 0, 0];
  };
  return {
    c1: pick('--khy-primary', base.accent),
    c2: pick('--khy-accent', base.accentMid),
    c3: pick('--khy-accent-end', base.accentEnd),
  };
}

function acquireContext(canvas) {
  const opts = {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
    preserveDrawingBuffer: false,
  };
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', opts);
  } catch {
    gl = null;
  }
  if (!gl) {
    try {
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    } catch {
      gl = null;
    }
  }
  return gl || null;
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export class KhyAura3d {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = {
      intensity: typeof options.intensity === 'number' ? options.intensity : 0.5,
      speed: typeof options.speed === 'number' ? options.speed : 1,
      maxDpr: typeof options.maxDpr === 'number' ? options.maxDpr : 2,
    };
    this.available = false;

    this._win =
      (canvas && canvas.ownerDocument && canvas.ownerDocument.defaultView) ||
      (typeof window !== 'undefined' ? window : null);

    this._gl = null;
    this._program = null;
    this._buffer = null;
    this._u = null;
    this._raf = 0;
    this._destroyed = false;
    this._reduced = false;
    this._elapsed = 0;
    this._lastTs = 0;

    this._frame = this._frame.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onMotionChange = this._onMotionChange.bind(this);
    this._onContextLost = this._onContextLost.bind(this);
  }

  /** Build the GL resources. Returns false (silently) if WebGL is unavailable. */
  start() {
    if (this._destroyed || this.available) return this.available;
    if (!this.canvas || !this._win) return false;

    const gl = acquireContext(this.canvas);
    if (!gl) return false;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return false;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return false;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this._gl = gl;
    this._program = program;
    this._buffer = buffer;
    this._u = {
      res: gl.getUniformLocation(program, 'u_res'),
      time: gl.getUniformLocation(program, 'u_time'),
      intensity: gl.getUniformLocation(program, 'u_intensity'),
      c1: gl.getUniformLocation(program, 'u_c1'),
      c2: gl.getUniformLocation(program, 'u_c2'),
      c3: gl.getUniformLocation(program, 'u_c3'),
    };

    const palette = resolvePalette(this.canvas, this._win);
    gl.useProgram(program);
    gl.uniform3fv(this._u.c1, palette.c1);
    gl.uniform3fv(this._u.c2, palette.c2);
    gl.uniform3fv(this._u.c3, palette.c3);
    gl.uniform1f(this._u.intensity, this.options.intensity);

    this.available = true;
    this._reduced = matchesReduceMotion(this._win);

    this._bindEvents();
    this._resize();

    if (this._reduced) {
      // Static equivalent: one frame, no loop. The reduce contract is met by
      // drawing a still image rather than by hiding the element.
      this._render(12.0);
    } else if (this._win.document.visibilityState !== 'hidden') {
      this._startLoop();
    }

    return true;
  }

  pause() {
    this._stopLoop();
  }

  resume() {
    if (this._destroyed || !this.available || this._reduced) return;
    if (this._win && this._win.document.visibilityState === 'hidden') return;
    this._startLoop();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._stopLoop();
    this._unbindEvents();

    const gl = this._gl;
    if (gl) {
      try {
        if (this._buffer) gl.deleteBuffer(this._buffer);
        if (this._program) gl.deleteProgram(this._program);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch {
        /* context already gone — nothing to release */
      }
    }
    this._gl = null;
    this._program = null;
    this._buffer = null;
    this._u = null;
    this.available = false;
  }

  // ── internals ──────────────────────────────────────────────────────────

  _bindEvents() {
    const win = this._win;
    if (!win) return;
    win.addEventListener('resize', this._onResize, { passive: true });
    if (win.document) {
      win.document.addEventListener('visibilitychange', this._onVisibility);
    }
    if (win.matchMedia) {
      try {
        this._motionMq = win.matchMedia(REDUCED_MOTION_QUERY);
        if (this._motionMq.addEventListener) this._motionMq.addEventListener('change', this._onMotionChange);
        else if (this._motionMq.addListener) this._motionMq.addListener(this._onMotionChange);
      } catch {
        this._motionMq = null;
      }
    }
    if (this.canvas) {
      this.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    }
  }

  _unbindEvents() {
    const win = this._win;
    if (win) {
      win.removeEventListener('resize', this._onResize);
      if (win.document) win.document.removeEventListener('visibilitychange', this._onVisibility);
      if (this._motionMq) {
        if (this._motionMq.removeEventListener) this._motionMq.removeEventListener('change', this._onMotionChange);
        else if (this._motionMq.removeListener) this._motionMq.removeListener(this._onMotionChange);
        this._motionMq = null;
      }
    }
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    }
  }

  _onContextLost(event) {
    if (event && event.preventDefault) event.preventDefault();
    this._stopLoop();
    this.available = false;
  }

  _onResize() {
    this._resize();
    if (this._reduced) this._render(12.0);
  }

  _onVisibility() {
    const hidden = this._win.document.visibilityState === 'hidden';
    if (hidden) this._stopLoop();
    else this.resume();
  }

  _onMotionChange() {
    this._reduced = matchesReduceMotion(this._win);
    if (this._reduced) {
      this._stopLoop();
      this._render(12.0);
    } else {
      this.resume();
    }
  }

  _resize() {
    const canvas = this.canvas;
    const gl = this._gl;
    if (!canvas || !gl) return;
    const dpr = Math.min(this._win.devicePixelRatio || 1, this.options.maxDpr);
    const w = Math.max(1, Math.round((canvas.clientWidth || 0) * dpr));
    const h = Math.max(1, Math.round((canvas.clientHeight || 0) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  }

  _startLoop() {
    if (this._raf || this._destroyed || !this.available) return;
    this._lastTs = 0;
    this._raf = this._win.requestAnimationFrame(this._frame);
  }

  _stopLoop() {
    if (this._raf && this._win) this._win.cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _frame(ts) {
    this._raf = 0;
    if (this._destroyed || !this.available) return;
    if (!this._lastTs) this._lastTs = ts;
    const dt = Math.min((ts - this._lastTs) / 1000, 0.05);
    this._lastTs = ts;
    this._elapsed += dt * this.options.speed;
    this._render(this._elapsed);
    this._raf = this._win.requestAnimationFrame(this._frame);
  }

  _render(time) {
    const gl = this._gl;
    if (!gl || !this._program) return;
    gl.useProgram(this._program);
    gl.uniform2f(this._u.res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this._u.time, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/**
 * Create and start the aura on `canvas`. Returns null when WebGL is unavailable
 * (or the canvas/context cannot be initialised) — callers should treat that as
 * "no backdrop" and render nothing.
 */
export function createKhyAura3d(canvas, options = {}) {
  if (!canvas) return null;
  const aura = new KhyAura3d(canvas, options);
  try {
    if (!aura.start()) {
      aura.destroy();
      return null;
    }
  } catch {
    aura.destroy();
    return null;
  }
  return aura;
}

export default createKhyAura3d;
