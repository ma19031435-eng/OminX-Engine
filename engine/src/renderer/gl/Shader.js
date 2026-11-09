/**
 * OminX Engine — WebGL2 program wrapper.
 *
 * Compiles a GLSL ES 3.0 program, introspects every uniform/attribute once, then caches
 * uniform locations so the hot path is a plain `gl.uniform*` call. `apply(name, value)`
 * dispatches by JS type, which keeps material code readable at 300+ draws per frame.
 *
 * Supports `#define` permutations (shader variants) keyed by a bitmask — that is how this
 * engine handles shadow cascades, instancing, fog, skinning and per-material features
 * without exploding into dozens of separate shader files.
 * @module engine/renderer/gl/Shader
 */
import { createLogger } from '../../core/Logger.js';

const log = createLogger('Shader');

export class Shader {
  /**
   * @param {import('./GLDevice.js').GLDevice} device
   * @param {object} desc
   * @param {string} desc.name
   * @param {string} desc.vertex
   * @param {string} desc.fragment
   * @param {Record<string,string|number|boolean>} [desc.defines]
   * @param {string[]} [desc.attributes] explicit attribute locations (0=position,1=normal…)
   */
  constructor(device, desc) {
    this.device = device;
    this.name = desc.name ?? 'Shader';
    this.defines = { ...(desc.defines ?? {}) };
    this.source = { vertex: desc.vertex, fragment: desc.fragment };
    this.attributeBindings = desc.attributes ?? null;
    this.uniforms = new Map();     // name → { location, type, size }
    this.attributes = new Map();
    this.program = null;
    this.dirty = true;
    this._uniformCache = new Map();
    this.attributeLocations = {};
    this._compile();
    device.onRestore(() => { this.dirty = true; this._compile(); });
  }

  static create(device, desc) { return new Shader(device, desc); }

  _preprocess(src, isVertex) {
    const defines = Object.entries(this.defines)
      .filter(([, v]) => v !== false && v !== undefined && v !== null)
      .map(([k, v]) => (v === true ? `#define ${k}` : `#define ${k} ${v}`))
      .join('\n');
    const version = '#version 300 es\n';
    const precision = isVertex ? '' : 'precision highp float;\nprecision highp int;\n';
    // Strip any authored #version / precision lines so we control them.
    const body = src
      .replace(/^\s*#version[^\n]*\n/gm, '')
      .replace(/^\s*precision\s+(highp|mediump|lowp)\s+\w+\s*;\s*\n/gm, '');
    return `${version}${precision}${defines}\n${body}`;
  }

  _compile() {
    const gl = this.device.gl;
    const vsSrc = this._preprocess(this.source.vertex, true);
    const fsSrc = this._preprocess(this.source.fragment, false);
    const vs = compileStage(gl, gl.VERTEX_SHADER, vsSrc, this.name, 'vertex');
    const fs = compileStage(gl, gl.FRAGMENT_SHADER, fsSrc, this.name, 'fragment');
    if (!vs || !fs) { this.valid = false; return; }
    if (this.program) gl.deleteProgram(this.program);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    if (this.attributeBindings) {
      for (let i = 0; i < this.attributeBindings.length; i++) {
        gl.bindAttribLocation(program, i, this.attributeBindings[i]);
        this.attributeLocations[this.attributeBindings[i]] = i;
      }
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      log.error(`link failed for "${this.name}": ${info}`);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.valid = false;
      return;
    }
    gl.detachShader(program, vs);
    gl.detachShader(program, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;
    this.valid = true;
    this._introspect();
    this.device._resources.programs++;
    this.dirty = false;
  }

  _introspect() {
    const gl = this.device.gl;
    const program = this.program;
    this.uniforms.clear();
    this.attributes.clear();
    const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(name, {
        location: gl.getUniformLocation(program, info.name),
        type: info.type,
        size: info.size,
        rawName: info.name,
      });
    }
    const attribCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < attribCount; i++) {
      const info = gl.getActiveAttrib(program, i);
      if (!info) continue;
      this.attributes.set(info.name, {
        location: gl.getAttribLocation(program, info.name),
        type: info.type,
        size: info.size,
      });
    }
  }

  has(name) { return this.uniforms.has(name); }

  /** Sets a uniform, dispatching on the JS value's type. Caches to skip redundant uploads. */
  apply(name, value) {
    const u = this.uniforms.get(name);
    if (!u || u.location === null || value === undefined) return this;
    const gl = this.device.gl;
    const cache = this._uniformCache;
    if (typeof value === 'number') {
      if (cache.get(name) === value) return this;
      cache.set(name, value);
      switch (u.type) {
        case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: case gl.SAMPLER_CUBE: case gl.SAMPLER_2D_ARRAY:
          gl.uniform1i(u.location, value); break;
        case gl.UNSIGNED_INT: gl.uniform1ui(u.location, value); break;
        default: gl.uniform1f(u.location, value); break;
      }
      return this;
    }
    if (typeof value === 'boolean') {
      if (cache.get(name) === value) return this;
      cache.set(name, value);
      gl.uniform1i(u.location, value ? 1 : 0);
      return this;
    }
    if (Array.isArray(value) || value instanceof Float32Array) {
      const n = value.length;
      // Declared uniform arrays (light positions, cascade splits) must use the element setter.
      if (u.size > 1) {
        if (u.type === gl.FLOAT) gl.uniform1fv(u.location, value);
        else if (u.type === gl.INT || u.type === gl.BOOL) gl.uniform1iv(u.location, value);
        else if (u.type === gl.FLOAT_VEC3) gl.uniform3fv(u.location, value);
        else if (u.type === gl.FLOAT_VEC4) gl.uniform4fv(u.location, value);
        else if (u.type === gl.FLOAT_MAT4) gl.uniformMatrix4fv(u.location, false, value);
        return this;
      }
      if (n === 2) gl.uniform2fv(u.location, value);
      else if (n === 3) gl.uniform3fv(u.location, value);
      else if (n === 4) gl.uniform4fv(u.location, value);
      else if (n === 9) gl.uniformMatrix3fv(u.location, false, value);
      else if (n === 16) gl.uniformMatrix4fv(u.location, false, value);
      else if (u.type === gl.FLOAT_VEC2) gl.uniform2fv(u.location, value);
      else if (u.type === gl.FLOAT_VEC3) gl.uniform3fv(u.location, value);
      else if (u.type === gl.FLOAT_VEC4) gl.uniform4fv(u.location, value);
      else gl.uniform1fv(u.location, value);
      return this;
    }
    // engine math types
    if (value.x !== undefined && value.y !== undefined && value.z !== undefined && value.w !== undefined) {
      gl.uniform4f(u.location, value.x, value.y, value.z, value.w);
      return this;
    }
    if (value.x !== undefined && value.y !== undefined && value.z !== undefined) {
      gl.uniform3f(u.location, value.x, value.y, value.z);
      return this;
    }
    if (value.x !== undefined && value.y !== undefined) {
      gl.uniform2f(u.location, value.x, value.y);
      return this;
    }
    if (value.r !== undefined) {
      // Color3/Color4
      gl.uniform3f(u.location, value.r, value.g, value.b);
      return this;
    }
    if (value.elements) {
      const n = value.elements.length;
      if (n === 16) gl.uniformMatrix4fv(u.location, false, value.elements);
      else if (n === 9) gl.uniformMatrix3fv(u.location, false, value.elements);
      return this;
    }
    return this;
  }

  /** Bulk-apply: `program.applyAll({ uColor: c, uTime: t })` (unknown uniforms are ignored). */
  applyAll(values) {
    for (const [k, v] of Object.entries(values)) this.apply(k, v);
    return this;
  }

  bindTexture(name, texture, unit) {
    if (!this.uniforms.has(name)) return this;
    if (unit !== undefined) {
      this.apply(name, unit);
      this.device.bindTexture(texture, unit);
    } else {
      this.device.bindTexture(texture, this._autoUnit);
    }
    return this;
  }

  use() { this.device.useProgram(this); return this; }
  destroy() {
    if (this.program) { this.device.gl.deleteProgram(this.program); this.program = null; }
    this._uniformCache.clear();
  }
}

function compileStage(gl, type, src, name, stage) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    log.error(`[${name}] ${stage} compile failed:\n${formatLog(info, src)}`);
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function formatLog(info, src) {
  const lines = src.split('\n');
  const out = [info];
  const m = /ERROR: \d+:(\d+)/.exec(info);
  if (m) {
    const line = parseInt(m[1], 10);
    for (let i = Math.max(0, line - 3); i < Math.min(lines.length, line + 3); i++) {
      out.push(`${String(i + 1).padStart(4)} | ${lines[i]}`);
    }
  }
  return out.join('\n');
}

/**
 * ShaderPermutation — lazily compiles shader variants that differ only by preprocessor
 * defines. Used by the main geometry pass (instancing on/off, shadows on/off, fog mode,
 * skinning, alpha-test, decal projection).
 */
export class ShaderPermutation {
  constructor(device, desc) {
    this.device = device;
    this.desc = desc;
    this.cache = new Map();
    this.base = new Shader(device, desc);
  }
  /** @param {number} key bitmask of enabled features */
  get(key, definesForBits) {
    if (key === 0) return this.base;
    let shader = this.cache.get(key);
    if (!shader) {
      shader = new Shader(this.device, { ...this.desc, defines: { ...this.desc.defines, ...definesForBits(key) } });
      this.cache.set(key, shader);
    }
    return shader;
  }
  destroy() {
    this.base.destroy();
    for (const s of this.cache.values()) s.destroy();
    this.cache.clear();
  }
}

/** Common GLSL snippets shared by many shaders — keeps the GLSL itself readable. */
export const GLSL = {
  constants: /* glsl */`
const float PI = 3.14159265359;
const float TAU = 6.28318530718;
const float EPSILON_F = 1e-5;
`,
  srgb: /* glsl */`
vec3 sRGBToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`,
  toneMapping: /* glsl */`
vec3 tonemapACES(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43;
  const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 tonemapReinhard(vec3 x) { return x / (x + vec3(1.0)); }
vec3 tonemapFilmic(vec3 x) {
  x = max(vec3(0.0), x - 0.004);
  return (x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06);
}
vec3 applyExposure(vec3 c, float exposure) { return c * exposure; }
`,
  rand: /* glsl */`
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
`,
  noise: /* glsl */`
float valueNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * valueNoise(p); p *= 2.02; a *= 0.5; }
  return s;
}
`,
  octahedral: /* glsl */`
vec2 unitVectorToOctahedron(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 uv = n.xy;
  if (n.z <= 0.0) uv = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return uv * 0.5 + 0.5;
}
vec3 octahedronToUnitVector(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec3 n = vec3(uv, 1.0 - abs(uv.x) - abs(uv.y));
  float t = max(-n.z, 0.0);
  n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t);
  return normalize(n);
}
`,
  shadowSampling: /* glsl */`
float sampleShadowPCF(sampler2D shadowMap, vec2 uv, float compare, vec2 texelSize, float softness) {
  float shadow = 0.0;
  float radius = softness;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y)) * texelSize * radius;
      float depth = texture(shadowMap, uv + offset).r;
      shadow += (compare - 0.0015 > depth) ? 0.0 : 1.0;
    }
  }
  return shadow / 9.0;
}
float sampleShadowPoisson(sampler2D shadowMap, vec2 uv, float compare, vec2 texelSize, float softness, float seed) {
  const vec2 POISSON[12] = vec2[12](
    vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
    vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
    vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));
  float angle = seed * TAU;
  float s = sin(angle); float c = cos(angle);
  mat2 rot = mat2(c, -s, s, c);
  float shadow = 0.0;
  for (int i = 0; i < 12; i++) {
    vec2 offset = rot * POISSON[i] * texelSize * softness;
    float depth = texture(shadowMap, uv + offset).r;
    shadow += (compare - 0.0015 > depth) ? 0.0 : 1.0;
  }
  return shadow / 12.0;
}
`,
  packing: /* glsl */`
vec4 packDepthToRGBA(float depth) {
  const vec4 bitSh = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
  const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
  vec4 res = fract(depth * bitSh);
  res -= res.xxyz * bitMask;
  return res;
}
float unpackDepthFromRGBA(vec4 rgba) {
  return dot(rgba, vec4(1.0 / (256.0 * 256.0 * 256.0), 1.0 / (256.0 * 256.0), 1.0 / 256.0, 1.0));
}
`,
  fog: /* glsl */`
vec3 applyFog(vec3 color, float dist, vec3 fogColor, float fogStart, float fogEnd, float density, float mode) {
  if (mode < 0.5) return color;
  float factor;
  if (mode < 1.5) {
    factor = clamp((dist - fogStart) / max(fogEnd - fogStart, 0.001), 0.0, 1.0);
  } else if (mode < 2.5) {
    factor = 1.0 - exp(-density * dist);
  } else {
    factor = 1.0 - exp(-pow(density * dist, 2.0));
  }
  return mix(color, fogColor, factor);
}
`,
  normalMapping: /* glsl */`
vec3 perturbNormal(sampler2D map, vec2 uv, vec3 N, vec3 T, vec3 B, float strength) {
  vec3 texN = texture(map, uv).xyz * 2.0 - 1.0;
  texN.xy *= strength;
  return normalize(mat3(T, B, N) * normalize(texN));
}
`,
};

export default Shader;
