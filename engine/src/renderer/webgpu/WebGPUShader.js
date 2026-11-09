/**
 * OminX Engine — WebGPU shader objects.
 *
 * WebGPU has no `useProgram`/`uniform*(location, value)`: a program is a module + pipeline, and
 * uniforms are bytes in an aligned buffer. This class keeps the *authoring* API the engine
 * already uses — `shader.use().applyAll({ uModelMatrix: matrix, uTint: color })` — and turns it
 * into bytes inside a slab that the device copies into its uniform ring buffer at draw time.
 *
 * The member layout comes from `wgsl/layout.js`, which parses the program's own `struct
 * Uniforms` block, so the CPU writer and the GPU shader can never disagree about offsets
 * (`tests/webgpu.test.js` cross-checks every offset against `wgsl_reflect`).
 *
 * @module engine/src/renderer/webgpu/WebGPUShader
 */
import { createLogger } from '../../core/Logger.js';
import { normalizeType } from '../wgsl/layout.js';
import { WGSL_PROGRAMS } from '../wgsl/index.js';
import { GLSL_PROGRAMS } from '../shaders/programs.js';

const log = createLogger('WebGPUShader');

/**
 * Names the renderer uses that differ from the registry key. The GLSL library was written pass by
 * pass, so a few programs picked up descriptive names (`brightPass`) or were built inline for a
 * single call site (`blit`, `skyColor`, `text3d`); the WGSL registry keeps one canonical key per
 * pass and this table is the bridge.
 */
export const PROGRAM_ALIASES = {
  editorGrid: 'grid',
  brightPass: 'bright',
  bloom: 'bright',
  ssaoApply: 'applySsao',
  applySSAO: 'applySsao',
  skyboxCubemap: 'cubemap',
  skyCube: 'cubemap',
  skyColor: 'skyColor',
  text3d: 'text',
  glyphs: 'text',
  lines: 'line',
  wireframe: 'line',
  blit: 'blit',
  copy: 'blit',
  normals: 'normalFromDepth',
  normal: 'normalFromDepth',
  compositeSource: 'composite',
  sceneHDR: 'composite',
  muzzle: 'particle',
};

/** Fragment-source heuristics for programs the renderer composes inline. */
const FRAGMENT_HEURISTICS = [
  [/uBloomTexture|uBlendAmount|uChromaticAberration/, 'composite'],
  [/uFontAtlas|uGlyph/, 'text'],
  [/samplerCube|uCubemap/, 'cubemap'],
  [/uGamma\b/, 'blit'],
  [/uNormalTexture|viewPositionFromDepth/, 'normalFromDepth'],
  [/uAoTexture/, 'ssao'],
  [/uGlyphSize|gl_PointSize/, 'particle'],
  [/uUVOffset/, 'sprite'],
  [/uColor\b/, 'skyColor'],
];

/**
 * Resolves the WGSL program for a shader descriptor, whatever shape the caller used.
 *
 * Resolution order: explicit `program` key → registry name → alias table → exact match against the
 * GLSL registry's fragment source (so a pass that changes its display name still finds its WGSL
 * twin) → fragment-text heuristics. Returns `null` when nothing matches, which the constructor
 * turns into a descriptive error.
 */
export function resolveProgramDescriptor(desc = {}) {
  const name = desc.program ?? desc.name;
  if (name && WGSL_PROGRAMS[name]) return WGSL_PROGRAMS[name];
  const alias = PROGRAM_ALIASES[name];
  if (alias && WGSL_PROGRAMS[alias]) return WGSL_PROGRAMS[alias];

  const fragment = desc.fragment;
  if (fragment) {
    for (const [key, entry] of Object.entries(GLSL_PROGRAMS)) {
      if (entry.fragment && entry.fragment === fragment && WGSL_PROGRAMS[key]) return WGSL_PROGRAMS[key];
    }
  }
  const vertex = desc.vertex;
  if (vertex) {
    for (const [key, entry] of Object.entries(GLSL_PROGRAMS)) {
      if (entry.vertex && entry.vertex === vertex && WGSL_PROGRAMS[key]) return WGSL_PROGRAMS[key];
    }
  }
  const haystack = `${fragment ?? ''}\n${vertex ?? ''}`;
  if (haystack.trim()) {
    for (const [pattern, key] of FRAGMENT_HEURISTICS) {
      if (pattern.test(haystack) && WGSL_PROGRAMS[key]) {
        if (name) log.info(`shader "${name}" resolved to WGSL program "${key}" by source match`);
        return WGSL_PROGRAMS[key];
      }
    }
  }
  return null;
}

/** Every program key the WebGPU backend knows, including aliases (used by tests and tooling). */
export function knownProgramNames() {
  return [...Object.keys(WGSL_PROGRAMS), ...Object.keys(PROGRAM_ALIASES)];
}

/** Scalar/vector component counts, used to size writes. */
const COMPONENTS = /^vec([234])</;

export class WebGPUShader {
  /**
   * @param {import('./WebGPUDevice.js').WebGPUDevice} device
   * @param {object} desc
   * @param {string} desc.program program key registered in `WGSL_PROGRAMS`
   * @param {object} [desc.programDescriptor] resolved registry entry
   * @param {Record<string, string|number|boolean>} [desc.defines]
   * @param {string} [desc.name]
   * @param {Array<{location:number, bufferIndex:number, offset:number, format:string, size:number}>} [desc.attributes]
   */
  constructor(device, desc = {}) {
    this.device = device;
    this.name = desc.name ?? desc.program ?? 'Shader';
    this.programName = desc.program ?? desc.name;
    this.descriptor = desc.programDescriptor ?? device.getProgramDescriptor(this.programName) ?? resolveProgramDescriptor(desc);
    if (!this.descriptor) {
      throw new Error(`WebGPUShader: no WGSL program for "${this.programName}" — known programs: ${Object.keys(WGSL_PROGRAMS).join(', ')}`);
    }
    if (desc.textures) this.descriptor = { ...this.descriptor, textures: { ...(this.descriptor.textures ?? {}), ...desc.textures } };
    this.programName = this.descriptor.name;
    this.defines = { ...(this.descriptor.defines ?? {}), ...(desc.defines ?? {}) };
    this.code = device.preprocessProgram(this.descriptor, this.defines);
    this.layout = device.reflectProgram(this.code, this.defines);
    this.attributes = desc.attributes ?? this.layout.vertexInputs;
    this.slab = new Float32Array(Math.ceil(this.layout.size / 4) || 4);
    this.bytes = new Uint8Array(this.slab.buffer);
    this.dirty = true;
    this.validationErrors = 0;
    this.pipelineKey = null;
  }

  static create(device, desc) { return new WebGPUShader(device, desc); }

  /** True when the WGSL declares this uniform (unknown names are silently ignored, like GL). */
  has(name) { return this.layout.members.has(stripIndex(name).name); }

  /**
   * Writes a uniform value. Supports the same value shapes as the GL shader plus array element
   * syntax (`uShadowMatrices[2]`) which the shadow manager uses.
   */
  apply(name, value) {
    if (value === undefined || value === null) return this;
    const { name: base, index } = stripIndex(name);
    const member = this.layout.members.get(base);
    if (!member) return this;
    this.dirty = true;
    try {
      writeValue(this.bytes, member, index, value);
    } catch (error) {
      this.validationErrors++;
      if (this.validationErrors <= 3) log.warn(`uniform ${name} on ${this.name}: ${error.message}`);
    }
    return this;
  }

  /** Bulk-apply, matching the GL shader's `applyAll`. */
  applyAll(values) {
    for (const [key, value] of Object.entries(values)) this.apply(key, value);
    return this;
  }

  /** Texture bindings are resolved by the device, not the shader — kept for API parity. */
  bindTexture(name, texture, unit) {
    const slot = this.descriptor.textures?.[name];
    this.device.bindTexture(texture, unit ?? slot ?? 0);
    return this;
  }

  /** Texture unit a uniform name maps to in the WGSL slot table (or -1 when it is not a texture). */
  textureUnit(name) {
    return this.descriptor.textures?.[name] ?? -1;
  }

  /** Marks this program as the one subsequent draws use (parity with `glUseProgram`). */
  use() { this.device.useProgram(this); return this; }

  /** Validates that every uniform the renderer sets exists in the WGSL program. */
  validateUniformNames(names) {
    const missing = [];
    for (const name of names) if (!this.has(name)) missing.push(name);
    return missing;
  }

  destroy() { this.dirty = true; this.destroyed = true; }
}

/**
 * `ShaderPermutation` equivalent: lazily materialises variants that differ only by defines.
 */
export class WebGPUShaderPermutation {
  constructor(device, desc) {
    this.device = device;
    this.desc = desc;
    this.cache = new Map();
    this.base = new WebGPUShader(device, desc);
  }

  get(key, definesForBits) {
    if (key === 0) return this.base;
    let shader = this.cache.get(key);
    if (!shader) {
      shader = new WebGPUShader(this.device, {
        ...this.desc,
        defines: { ...(this.desc.defines ?? {}), ...(definesForBits ? definesForBits(key) : {}) },
      });
      this.cache.set(key, shader);
    }
    return shader;
  }

  destroy() {
    this.base.destroy();
    for (const shader of this.cache.values()) shader.destroy();
    this.cache.clear();
  }
}

function stripIndex(name) {
  const match = /^([^[\]]+)\[(\d+)\]$/.exec(name);
  if (match) return { name: match[1], index: Number(match[2]) };
  return { name, index: null };
}

/** Writes a JS value into the slab at the member's offset, honouring the WGSL type. */
function writeValue(bytes, member, index, value) {
  const stride = member.stride || member.size;
  const baseOffset = member.offset + (index !== null ? index * stride : 0);
  const scalarCount = scalarCountOf(member, index);
  const floats = toFloatArray(value, scalarCount);
  if (!floats) return;
  const view = new Float32Array(bytes.buffer, baseOffset, Math.min(floats.length, scalarCount));
  view.set(floats.subarray(0, view.length));
}

function scalarCountOf(member, index) {
  const elementSize = member.elementSize || member.size;
  const size = index !== null ? elementSize : member.size;
  return Math.max(1, Math.floor(size / 4));
}

/**
 * Normalises the value shapes the engine passes: numbers, bools, arrays, typed arrays, Vector2/3/4,
 * Color3/4, Matrix3/4 and `{elements}` wrappers.
 */
export function toFloatArray(value, capacity) {
  if (typeof value === 'number') {
    const out = new Float32Array(capacity);
    out[0] = value;
    return out;
  }
  if (typeof value === 'boolean') {
    const out = new Float32Array(capacity);
    out[0] = value ? 1 : 0;
    return out;
  }
  if (value instanceof Float32Array) {
    if (value.length <= capacity) return value;
    return value.subarray(0, capacity);
  }
  if (Array.isArray(value)) {
    const out = new Float32Array(capacity);
    const n = Math.min(value.length, capacity);
    for (let i = 0; i < n; i++) out[i] = value[i];
    return out;
  }
  if (value.elements) return toFloatArray(value.elements, capacity);
  if (value.x !== undefined) {
    const out = new Float32Array(capacity);
    out[0] = value.x;
    if (capacity > 1) out[1] = value.y ?? 0;
    if (capacity > 2) out[2] = value.z ?? 0;
    if (capacity > 3) out[3] = value.w ?? 0;
    return out;
  }
  if (value.r !== undefined) {
    const out = new Float32Array(capacity);
    out[0] = value.r;
    if (capacity > 1) out[1] = value.g ?? 0;
    if (capacity > 2) out[2] = value.b ?? 0;
    if (capacity > 3) out[3] = value.a ?? 1;
    return out;
  }
  return null;
}

/** Vertex format for a WGSL vertex input type. */
export function vertexFormat(wgslType) {
  const type = normalizeType(wgslType);
  const formats = {
    f32: 'float32',
    'vec2<f32>': 'float32x2',
    'vec3<f32>': 'float32x3',
    'vec4<f32>': 'float32x4',
    i32: 'sint32',
    'vec2<i32>': 'sint32x2',
    'vec3<i32>': 'sint32x3',
    'vec4<i32>': 'sint32x4',
    u32: 'uint32',
    'vec2<u32>': 'uint32x2',
    'vec3<u32>': 'uint32x3',
    'vec4<u32>': 'uint32x4',
  };
  return formats[type] ?? 'float32x4';
}

/** Byte size of a vertex format, used for vertex buffer strides. */
export function vertexFormatSize(format) {
  const match = /(float32|sint32|uint32)(x([234]))?/.exec(format);
  if (!match) return 4;
  return Number(match[3] ?? 1) * 4;
}

export { COMPONENTS };
export default WebGPUShader;
