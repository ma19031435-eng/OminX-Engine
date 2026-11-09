/**
 * Mock WebGL2 context for headless engine tests.
 *
 * This is not a rasteriser. It is a *faithful API simulator*: it parses shader sources as
 * they are compiled, so the introspection paths (`getActiveUniform`, `getActiveAttrib`,
 * `getProgramParameter`) return the uniforms and attributes the GLSL actually declares —
 * including array sizes. That makes it possible to run the whole renderer in Node and catch
 * real bugs (a uniform the renderer sets that the shader never declares, an attribute bound
 * to the wrong location, a shader that fails to compile because of a duplicate uniform) with
 * no browser installed.
 *
 * It also records draw calls so tests can assert the pipeline produced geometry.
 */

/** The real WebGL2 constant values we care about; anything else gets a stable synthetic id. */
const CONSTANTS = {
  NONE: 0, ZERO: 0, ONE: 1,
  DEPTH_BUFFER_BIT: 0x00000100, STENCIL_BUFFER_BIT: 0x00000400, COLOR_BUFFER_BIT: 0x00004000,
  POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
  CULL_FACE: 0x0B44, BLEND: 0x0BE2, DEPTH_TEST: 0x0B71, SCISSOR_TEST: 0x0C11, STENCIL_TEST: 0x0B90,
  DITHER: 0x0BD0, POLYGON_OFFSET_FILL: 0x8037, SAMPLE_ALPHA_TO_COVERAGE: 0x809E,
  FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408,
  CW: 0x0900, CCW: 0x0901,
  NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204, NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
  KEEP: 0x1E00, REPLACE: 0x1E01,
  ZERO_F: 0x0000, ONE_F: 0x0001, SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301, SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303, DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305, DST_COLOR: 0x0306,
  ONE_MINUS_DST_COLOR: 0x0307, SRC_ALPHA_SATURATE: 0x0308, FUNC_ADD: 0x8006,
  MIN: 0x8007, MAX: 0x8008, BLEND_EQUATION: 0x8009, BLEND_EQUATION_ALPHA: 0x883D,
  BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403,
  INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406, HALF_FLOAT: 0x140B,
  DEPTH_COMPONENT: 0x1902, RED: 0x1903, RGB: 0x1907, RGBA: 0x1908, RG: 0x8227,
  RED_INTEGER: 0x8D94, RGB_INTEGER: 0x8D98, RGBA_INTEGER: 0x8D99, RG_INTEGER: 0x8228,
  R8: 0x8229, R16F: 0x822D, R32F: 0x822E, RG16F: 0x822F, RGB16F: 0x881B, RGBA16F: 0x881A,
  RGB8: 0x8051, RGBA8: 0x8058, SRGB8_ALPHA8: 0x8C43, RGB10_A2: 0x8059, RGBA32F: 0x8814,
  DEPTH_COMPONENT16: 0x81A5, DEPTH_COMPONENT24: 0x81A6, DEPTH_COMPONENT32F: 0x8CAC,
  DEPTH24_STENCIL8: 0x88F0, DEPTH_STENCIL: 0x84F9, UNSIGNED_INT_24_8: 0x84FA,
  TEXTURE_2D: 0x0DE1, TEXTURE_3D: 0x806F, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_2D_ARRAY: 0x8C1A,
  TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
  FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41, READ_FRAMEBUFFER: 0x8CA8, DRAW_FRAMEBUFFER: 0x8CA9,
  FRAMEBUFFER_COMPLETE: 0x8CD5, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
  DEPTH_STENCIL_ATTACHMENT: 0x821A, COLOR_ATTACHMENT1: 0x8CE1, COLOR_ATTACHMENT2: 0x8CE2, COLOR_ATTACHMENT3: 0x8CE3,
  LINEAR: 0x2601, NEAREST: 0x2600, LINEAR_MIPMAP_LINEAR: 0x2703, NEAREST_MIPMAP_NEAREST: 0x2700,
  REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,
  TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
  TEXTURE_WRAP_R: 0x8072, TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, TEXTURE_BASE_LEVEL: 0x813C, TEXTURE_MAX_LEVEL: 0x813D,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, UNIFORM_BUFFER: 0x8A11,
  DYNAMIC_DRAW: 0x88E8, STATIC_DRAW: 0x88E4, STREAM_DRAW: 0x88E0,
  VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
  ACTIVE_UNIFORMS: 0x8B86, ACTIVE_ATTRIBUTES: 0x8B89,
  UNPACK_ALIGNMENT: 0x0CF5, UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  MAX_TEXTURE_SIZE: 0x0D33, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VARYING_VECTORS: 0x8DFC, MAX_SAMPLES: 0x8D57, MAX_DRAW_BUFFERS: 0x8824, MAX_ARRAY_TEXTURE_LAYERS: 0x88FF,
  MAX_ELEMENTS_INDICES: 0x80E9, MAX_UNIFORM_BLOCK_SIZE: 0x8A30, UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8A34,
  VERSION: 0x1F02, VENDOR: 0x1F00, RENDERER: 0x1F01, SHADING_LANGUAGE_VERSION: 0x8B8C,
  LINE_WIDTH: 0x0B21, FRAMEBUFFER_SRGB: 0x8DB9, FRAMEBUFFER_BINDING: 0x8CA6, CURRENT_PROGRAM: 0x8B8D,
  FLOAT_MAT2: 0x8B5A, FLOAT_MAT3: 0x8B5B, FLOAT_MAT4: 0x8B5C,
  FLOAT_VEC2: 0x8B50, FLOAT_VEC3: 0x8B51, FLOAT_VEC4: 0x8B52,
  INT_VEC2: 0x8B53, INT_VEC3: 0x8B54, INT_VEC4: 0x8B55,
  BOOL: 0x8B56, BOOL_VEC2: 0x8B57, BOOL_VEC3: 0x8B58, BOOL_VEC4: 0x8B59,
  SAMPLER_2D: 0x8B5E, SAMPLER_CUBE: 0x8B60, SAMPLER_2D_ARRAY: 0x8DC1, UINT_VEC4: 0x8DC8,
  NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502,
  OUT_OF_MEMORY: 0x0505, INVALID_FRAMEBUFFER_OPERATION: 0x0506,
};

const TYPE_BY_GLSL = {
  float: 'FLOAT', int: 'INT', uint: 'UNSIGNED_INT', bool: 'BOOL',
  vec2: 'FLOAT_VEC2', vec3: 'FLOAT_VEC3', vec4: 'FLOAT_VEC4',
  ivec2: 'INT_VEC2', ivec3: 'INT_VEC3', ivec4: 'INT_VEC4',
  uvec2: 'UINT_VEC2', uvec3: 'UINT_VEC3', uvec4: 'UINT_VEC4',
  mat2: 'FLOAT_MAT2', mat3: 'FLOAT_MAT3', mat4: 'FLOAT_MAT4',
  sampler2D: 'SAMPLER_2D', samplerCube: 'SAMPLER_CUBE', sampler2DArray: 'SAMPLER_2D_ARRAY',
};

/** Strips comments so the declarations we parse are the real ones. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Parses `uniform <type> <name>[<size>];` declarations out of a shader stage. */
export function parseUniforms(source) {
  const src = stripComments(source);
  const out = [];
  const seen = new Map();
  const re = /uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;
  let m;
  while ((m = re.exec(src))) {
    const [, type, name, size] = m;
    const entry = {
      name: size ? `${name}[0]` : name,
      baseName: name,
      type: TYPE_BY_GLSL[type] ?? 'FLOAT',
      size: size ? parseInt(size, 10) : 1,
      glslType: type,
    };
    if (seen.has(entry.name)) {
      // Duplicate declarations are illegal in GLSL ES 3.0 — record so tests can assert.
      out.find((u) => u.name === entry.name).duplicate = true;
    } else {
      seen.set(entry.name, entry);
      out.push(entry);
    }
  }
  return out;
}

/** Parses `layout(location = N) in <type> <name>;` attributes. */
export function parseAttributes(source) {
  const src = stripComments(source);
  const out = [];
  const re = /layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(?:highp\s+|mediump\s+|lowp\s+)?([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\s*;/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({ location: parseInt(m[1], 10), type: TYPE_BY_GLSL[m[2]] ?? 'FLOAT', name: m[3] });
  }
  // Unqualified `in` declarations (bound explicitly via bindAttribLocation).
  const re2 = /^[ \t]*in\s+(?:highp\s+|mediump\s+|lowp\s+)?([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\s*;/gm;
  while ((m = re2.exec(src))) {
    if (out.some((a) => a.name === m[2])) continue;
    out.push({ location: -1, type: TYPE_BY_GLSL[m[1]] ?? 'FLOAT', name: m[2] });
  }
  return out;
}

/** Vertex `out` / fragment `in` varyings, for interface matching checks. */
export function parseVaryings(source, keyword = 'out') {
  const src = stripComments(source);
  const out = [];
  const re = new RegExp(`^[ \\t]*${keyword}\\s+(?:flat\\s+)?(?:highp\\s+|mediump\\s+|lowp\\s+)?([A-Za-z0-9_]+)\\s+([A-Za-z0-9_]+)\\s*(?:\\[\\s*(\\d+)\\s*\\])?\\s*;`, 'gm');
  let m;
  while ((m = re.exec(src))) out.push({ type: m[1], name: m[2], size: m[3] ? parseInt(m[3], 10) : 1 });
  return out;
}

export class MockGL {
  constructor(opts = {}) {
    this.name = opts.name ?? 'MockGL';
    this.calls = new Map();          // method name → count
    this.draws = [];                 // { mode, count, instances }
    this.uniformSets = [];           // { program, name, value }
    this.textures = new Map();
    this.buffers = new Map();
    this.vaos = new Map();
    this.programs = new Map();
    this.framebuffers = new Map();
    this.errors = [];
    this.shaders = new Map();
    this._nextId = 1;
    this._boundVAO = null;
    this._boundProgram = null;
    this._boundFBO = null;
    this._shaderSources = new Map();
    this._programShaders = new Map();
    this._uniformLocations = new Map();
    this._activeTextureUnit = 0;
    this._attrs = new Map();
    this._bufferBindings = { ARRAY_BUFFER: null, ELEMENT_ARRAY_BUFFER: null };
    this.debug = opts.debug ?? false;
    // Expose the constant table directly, exactly like a real WebGL context does.
    for (const [name, value] of Object.entries(CONSTANTS)) this[name] = value;
  }

  _count(method) { this.calls.set(method, (this.calls.get(method) ?? 0) + 1); }

  // ---- shader compilation ------------------------------------------------
  createShader(type) {
    this._count('createShader');
    const shader = { id: this._nextId++, type };
    this.shaders.set(shader.id, { shader, source: '' });
    return shader;
  }
  shaderSource(shader, source) {
    this._count('shaderSource');
    const entry = this.shaders.get(shader.id);
    if (entry) entry.source = source;
  }
  compileShader(shader) {
    this._count('compileShader');
    const entry = this.shaders.get(shader.id);
    if (entry) {
      entry.uniforms = parseUniforms(entry.source);
      entry.attributes = parseAttributes(entry.source);
      entry.varyingsOut = parseVaryings(entry.source, 'out');
      entry.varyingsIn = parseVaryings(entry.source, 'in');
      // Minimal real validation: balanced braces, a main(), matching version header.
      const body = stripComments(entry.source);
      const open = (body.match(/\{/g) ?? []).length;
      const close = (body.match(/\}/g) ?? []).length;
      entry.errors = [];
      if (!/^#version\s+300\s+es/m.test(body)) entry.errors.push('missing "#version 300 es"');
      if (!/void\s+main\s*\(/.test(body)) entry.errors.push('missing void main()');
      if (open !== close) entry.errors.push(`unbalanced braces (${open} open, ${close} close)`);
      for (const u of entry.uniforms) if (u.duplicate) entry.errors.push(`duplicate uniform ${u.name}`);
      if (entry.errors.length) {
        this.errors.push({ kind: 'compile', name: shader.id, errors: entry.errors.slice() });
      }
    }
  }
  getShaderParameter(shader, pname) {
    if (pname === CONSTANTS.COMPILE_STATUS) {
      const entry = this.shaders.get(shader.id);
      return !entry || entry.errors.length === 0;
    }
    return true;
  }
  getShaderInfoLog(shader) {
    const entry = this.shaders.get(shader.id);
    return entry?.errors?.join('\n') ?? '';
  }
  deleteShader(shader) { this._count('deleteShader'); this.shaders.delete(shader.id); }
  createProgram() {
    this._count('createProgram');
    const program = { id: this._nextId++, uniforms: [], attributes: [], varyingsOut: [], varyingsIn: [], errors: [] };
    this.programs.set(program.id, program);
    return program;
  }
  attachShader(program, shader) {
    this._count('attachShader');
    const p = this.programs.get(program.id);
    const s = this.shaders.get(shader.id);
    if (!p || !s) return;
    p.uniforms.push(...(s.uniforms ?? []));
    p.attributes.push(...(s.attributes ?? []));
    p._stages = p._stages ?? [];
    p._stages.push({ shader, ...s });
  }
  linkProgram(program) {
    this._count('linkProgram');
    const p = this.programs.get(program.id);
    if (!p) return;
    p.errors = [];
    for (const s of p._stages ?? []) p.errors.push(...(s.errors ?? []));
    // Fragment inputs must be produced by the vertex stage.
    const vertexStage = p._stages?.find((s) => s.shader.type === CONSTANTS.VERTEX_SHADER);
    const fragmentStage = p._stages?.find((s) => s.shader.type === CONSTANTS.FRAGMENT_SHADER);
    p.varyingsOut = vertexStage?.varyingsOut ?? [];
    p.varyingsIn = fragmentStage?.varyingsIn ?? [];
    const produced = new Map(p.varyingsOut.map((v) => [v.name, v]));
    for (const v of p.varyingsIn) {
      const out = produced.get(v.name);
      if (!out) { p.errors.push(`fragment input "${v.name}" is not written by the vertex stage`); continue; }
      if (out.type !== v.type) p.errors.push(`fragment input "${v.name}" is ${v.type} but the vertex stage writes ${out.type}`);
    }
    // A uniform declared in both stages is legal when the types match (they share a location);
    // a type mismatch is a link error.
    const seen = new Map();
    p.uniforms = p.uniforms.filter((u) => {
      const prior = seen.get(u.name);
      if (prior) {
        if (prior.type !== u.type) p.errors.push(`uniform "${u.name}" declared with types ${prior.type} and ${u.type}`);
        if (prior.size !== u.size) p.errors.push(`uniform "${u.name}" declared with array sizes ${prior.size} and ${u.size}`);
        return false;   // same location, don't double-report
      }
      seen.set(u.name, u);
      return true;
    });
    if (p.errors.length) this.errors.push({ kind: 'link', name: p.id, errors: p.errors.slice() });
  }
  getProgramParameter(program, pname) {
    const p = this.programs.get(program.id);
    if (pname === CONSTANTS.LINK_STATUS) return !p || p.errors.length === 0;
    if (!p) return 0;
    if (pname === CONSTANTS.ACTIVE_UNIFORMS) return p.uniforms.length;
    if (pname === CONSTANTS.ACTIVE_ATTRIBUTES) return p.attributes.length;
    return 0;
  }
  getProgramInfoLog(program) {
    const p = this.programs.get(program.id);
    return p?.errors?.join('\n') ?? '';
  }
  getActiveUniform(program, i) {
    const p = this.programs.get(program.id);
    const u = p?.uniforms?.[i];
    return u ? { name: u.name, type: CONSTANTS[u.type] ?? CONSTANTS.FLOAT, size: u.size } : null;
  }
  getActiveAttrib(program, i) {
    const p = this.programs.get(program.id);
    const a = p?.attributes?.[i];
    return a ? { name: a.name, type: CONSTANTS[a.type] ?? CONSTANTS.FLOAT, size: 1 } : null;
  }
  getUniformLocation(program, name) {
    const p = this.programs.get(program.id);
    const declared = p?.uniforms?.some((u) => u.name === name || u.baseName === name);
    if (!declared) {
      // Real GL returns null for inactive/unknown uniforms.
      return null;
    }
    const key = `${program.id}:${name}`;
    if (!this._uniformLocations.has(key)) this._uniformLocations.set(key, { program: program.id, name });
    return this._uniformLocations.get(key);
  }
  getAttribLocation(program, name) {
    const p = this.programs.get(program.id);
    const attr = p?.attributes?.find((a) => a.name === name);
    return attr ? (attr.location >= 0 ? attr.location : p.attributes.indexOf(attr)) : -1;
  }
  bindAttribLocation(program, location, name) {
    const p = this.programs.get(program.id);
    const attr = p?.attributes?.find((a) => a.name === name);
    if (attr) attr.location = location;
  }
  detachShader() { this._count('detachShader'); }
  deleteProgram(program) { this._count('deleteProgram'); this.programs.delete(program.id); }
  useProgram(program) {
    this._count('useProgram');
    this._boundProgram = program;
    return this;
  }

  // ---- uniforms ----------------------------------------------------------
  _recordUniform(name, value) {
    const p = this.programs.get(this._boundProgram?.id);
    this.uniformSets.push({ program: p?.id ?? 0, name: typeof name === 'object' ? name?.name : name, value });
  }
  uniform1f(loc, x) { this._count('uniform1f'); this._recordUniform(loc, x); }
  uniform1i(loc, x) { this._count('uniform1i'); this._recordUniform(loc, x); }
  uniform1ui(loc, x) { this._count('uniform1ui'); this._recordUniform(loc, x); }
  uniform1fv(loc, x) { this._count('uniform1fv'); this._recordUniform(loc, x); }
  uniform1iv(loc, x) { this._count('uniform1iv'); this._recordUniform(loc, x); }
  uniform2f(loc, x, y) { this._count('uniform2f'); this._recordUniform(loc, [x, y]); }
  uniform2fv(loc, x) { this._count('uniform2fv'); this._recordUniform(loc, x); }
  uniform3f(loc, x, y, z) { this._count('uniform3f'); this._recordUniform(loc, [x, y, z]); }
  uniform3fv(loc, x) { this._count('uniform3fv'); this._recordUniform(loc, x); }
  uniform4f(loc, x, y, z, w) { this._count('uniform4f'); this._recordUniform(loc, [x, y, z, w]); }
  uniform4fv(loc, x) { this._count('uniform4fv'); this._recordUniform(loc, x); }
  uniformMatrix3fv(loc, transpose, x) { this._count('uniformMatrix3fv'); this._recordUniform(loc, x); }
  uniformMatrix4fv(loc, transpose, x) { this._count('uniformMatrix4fv'); this._recordUniform(loc, x); }

  /** Names of every uniform the renderer attempted to set on a program. */
  uniformNamesFor(programId) {
    return new Set(this.uniformSets.filter((u) => u.program === programId).map((u) => u.name));
  }

  // ---- buffers / vaos ----------------------------------------------------
  createBuffer() { this._count('createBuffer'); const b = { id: this._nextId++ }; this.buffers.set(b.id, b); return b; }
  bindBuffer(target, buffer) {
    this._count('bindBuffer');
    const name = Object.keys(CONSTANTS).find((k) => CONSTANTS[k] === target) ?? String(target);
    this._bufferBindings[name] = buffer;
  }
  bufferData(target, sizeOrData, usage) {
    this._count('bufferData');
    const b = this._bufferBindings.ARRAY_BUFFER ?? this._bufferBindings.ELEMENT_ARRAY_BUFFER;
    if (b) b.bytes = typeof sizeOrData === 'number' ? sizeOrData : sizeOrData.byteLength;
  }
  bufferSubData(target, offset, data) { this._count('bufferSubData'); void target; void offset; void data; }
  deleteBuffer(buffer) { this._count('deleteBuffer'); this.buffers.delete(buffer?.id); }
  createVertexArray() { this._count('createVertexArray'); const v = { id: this._nextId++, attribs: [] }; this.vaos.set(v.id, v); return v; }
  bindVertexArray(vao) { this._count('bindVertexArray'); this._boundVAO = vao; }
  deleteVertexArray(vao) { this._count('deleteVertexArray'); this.vaos.delete(vao?.id); }
  enableVertexAttribArray(loc) { if (this._boundVAO) this._boundVAO.attribs[loc] = true; }
  disableVertexAttribArray(loc) { if (this._boundVAO) this._boundVAO.attribs[loc] = false; }
  vertexAttribPointer(loc, size, type, normalized, stride, offset) {
    this._count('vertexAttribPointer');
    this._attrs.set(loc, { size, type, stride, offset });
  }
  vertexAttribIPointer(loc, size, type, stride, offset) {
    this._count('vertexAttribIPointer');
    this._attrs.set(loc, { size, type, stride, offset, integer: true });
  }
  vertexAttribDivisor(loc, divisor) { if (this._boundVAO) this._boundVAO.attribs[loc] = { divisor }; }

  // ---- textures ----------------------------------------------------------
  createTexture() { this._count('createTexture'); const t = { id: this._nextId++, levels: 0 }; this.textures.set(t.id, t); return t; }
  bindTexture(target, texture) {
    this._count('bindTexture');
    const unit = this._activeTextureUnit;
    this._texturesByUnit ??= {};
    this._texturesByUnit[unit] = { target, texture };
  }
  activeTexture(unit) { this._count('activeTexture'); this._activeTextureUnit = unit; }
  texImage2D(...args) { this._count('texImage2D'); void args; }
  texImage3D(...args) { this._count('texImage3D'); void args; }
  texSubImage2D(...args) { this._count('texSubImage2D'); void args; }
  texParameteri(...args) { this._count('texParameteri'); void args; }
  texParameterf(...args) { this._count('texParameterf'); void args; }
  generateMipmap() { this._count('generateMipmap'); }
  deleteTexture(t) { this._count('deleteTexture'); this.textures.delete(t?.id); }
  pixelStorei() { this._count('pixelStorei'); }
  getTexImage() { return new Uint8Array(4); }

  // ---- framebuffers ------------------------------------------------------
  createFramebuffer() { this._count('createFramebuffer'); const f = { id: this._nextId++, attachments: [] }; this.framebuffers.set(f.id, f); return f; }
  bindFramebuffer(target, fbo) { this._count('bindFramebuffer'); if (target === CONSTANTS.FRAMEBUFFER || target === CONSTANTS.DRAW_FRAMEBUFFER) this._boundFBO = fbo; }
  framebufferTexture2D(target, attachment, textarget, texture, level) {
    this._count('framebufferTexture2D');
    const f = this._boundFBO;
    if (f) f.attachments.push({ attachment, textarget, texture, level });
  }
  framebufferRenderbuffer(target, attachment, rbtarget, rb) {
    this._count('framebufferRenderbuffer');
    const f = this._boundFBO;
    if (f) f.attachments.push({ attachment, rb });
  }
  createRenderbuffer() { this._count('createRenderbuffer'); return { id: this._nextId++ }; }
  bindRenderbuffer() { this._count('bindRenderbuffer'); }
  renderbufferStorage(format, w, h) { this._count('renderbufferStorage'); void format; void w; void h; }
  renderbufferStorageMultisample(target, samples, format, w, h) {
    this._count('renderbufferStorageMultisample');
    this.lastMultisample = { samples, format, w, h };
  }
  deleteRenderbuffer() { this._count('deleteRenderbuffer'); }
  deleteFramebuffer(fbo) { this._count('deleteFramebuffer'); this.framebuffers.delete(fbo?.id); }
  checkFramebufferStatus() { this._count('checkFramebufferStatus'); return CONSTANTS.FRAMEBUFFER_COMPLETE; }
  drawBuffers(list) { this._count('drawBuffers'); this.lastDrawBuffers = list; }
  blitFramebuffer() { this._count('blitFramebuffer'); }
  readBuffer() { this._count('readBuffer'); }

  // ---- state + draws -----------------------------------------------------
  enable(cap) { this._count('enable'); this._enabled ??= new Set(); this._enabled.add(cap); }
  disable(cap) { this._count('disable'); this._enabled ??= new Set(); this._enabled.delete(cap); }
  isEnabled(cap) { return !!this._enabled?.has(cap); }
  blendFunc(src, dst) { this._count('blendFunc'); this._blendFunc = [src, dst]; }
  blendFuncSeparate(s, d, sa, da) { this._count('blendFuncSeparate'); this._blendFunc = [s, d, sa, da]; }
  blendEquation() { this._count('blendEquation'); }
  depthFunc() { this._count('depthFunc'); }
  depthMask(mask) { this._count('depthMask'); this._depthMask = mask; }
  colorMask(...m) { this._count('colorMask'); this._colorMask = m; }
  cullFace(mode) { this._count('cullFace'); this._cullFace = mode; }
  frontFace(mode) { this._count('frontFace'); this._frontFace = mode; }
  viewport(x, y, w, h) { this._count('viewport'); this.viewportState = [x, y, w, h]; }
  scissor() { this._count('scissor'); }
  clearColor(...c) { this._count('clearColor'); this.clearColorState = c; }
  clearDepth(v) { this._count('clearDepth'); this.clearDepthState = v; }
  clearStencil() { this._count('clearStencil'); }
  clear(mask) { this._count('clear'); this.clearMask = mask; }
  lineWidth() { this._count('lineWidth'); }
  finish() { this._count('finish'); }
  flush() { this._count('flush'); }
  readPixels(x, y, w, h, format, type, pixels) {
    this._count('readPixels');
    if (pixels) pixels.fill(0);
  }
  fenceSync() { this._count('fenceSync'); return { id: this._nextId++ }; }
  clientWaitSync() { this._count('clientWaitSync'); return CONSTANTS.CONDITION_SATISFIED ?? 0x911A; }
  deleteSync() { this._count('deleteSync'); }
  drawArrays(mode, first, count) { this.draws.push({ mode, first, count, instances: 1 }); this._count('drawArrays'); }
  drawElements(mode, count, type, offset) { this.draws.push({ mode, count, offset, instances: 1 }); this._count('drawElements'); }
  drawArraysInstanced(mode, first, count, instances) { this.draws.push({ mode, first, count, instances }); this._count('drawArraysInstanced'); }
  drawElementsInstanced(mode, count, type, offset, instances) { this.draws.push({ mode, count, offset, instances }); this._count('drawElementsInstanced'); }
  multiDrawArraysWEBGL() { this._count('multiDrawArraysWEBGL'); }
  getError() { return CONSTANTS.NO_ERROR; }
  getExtension(name) {
    this._count('getExtension');
    if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 };
    if (name === 'EXT_texture_filter_anisotropic') return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: CONSTANTS.TEXTURE_MAX_ANISOTROPY_EXT, TEXTURE_MAX_ANISOTROPY_EXT: CONSTANTS.TEXTURE_MAX_ANISOTROPY_EXT };
    if (name === 'EXT_disjoint_timer_query_webgl2') return { TIME_ELAPSED_EXT: 0x88BF, GPU_DISJOINT_EXT: 0x8FBB };
    if (name === 'WEBGL_multi_draw') return { multiDrawArraysWEBGL: true };
    if (name === 'EXT_color_buffer_float' || name === 'EXT_color_buffer_half_float' || name === 'OES_texture_float_linear') return {};
    return null;
  }
  get supportedExtensions() { return ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear', 'EXT_texture_filter_anisotropic', 'WEBGL_debug_renderer_info']; }
  getParameter(pname) {
    switch (pname) {
      case CONSTANTS.MAX_TEXTURE_SIZE: return 8192;
      case CONSTANTS.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return 32;
      case CONSTANTS.MAX_VERTEX_ATTRIBS: return 16;
      case CONSTANTS.MAX_VARYING_VECTORS: return 30;
      case CONSTANTS.MAX_SAMPLES: return 4;
      case CONSTANTS.MAX_DRAW_BUFFERS: return 8;
      case CONSTANTS.MAX_ARRAY_TEXTURE_LAYERS: return 256;
      case CONSTANTS.MAX_ELEMENTS_INDICES: return 262144;
      case CONSTANTS.MAX_UNIFORM_BLOCK_SIZE: return 65536;
      case CONSTANTS.UNIFORM_BUFFER_OFFSET_ALIGNMENT: return 256;
      case 0x9246: return 'MockGL Hardware Accelerated';   // UNMASKED_RENDERER_WEBGL
      case 0x9245: return 'OminX Mock Vendor';
      case CONSTANTS.RENDERER: return 'MockGL';
      case CONSTANTS.VENDOR: return 'OminX Mock';
      case CONSTANTS.VERSION: return 'WebGL 2.0 (Mock)';
      case CONSTANTS.SHADING_LANGUAGE_VERSION: return 'WebGL GLSL ES 3.00 (Mock)';
      default: return 0;
    }
  }
  isContextLost() { return false; }
}

/** A canvas-shaped object that hands out a MockGL context. */
export function createMockCanvas(width = 1280, height = 720, opts = {}) {
  const gl = new MockGL(opts);
  const canvas = {
    width, height, clientWidth: width, clientHeight: height,
    style: {},
    _listeners: new Map(),
    addEventListener(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(fn); },
    removeEventListener(type, fn) {
      const list = this._listeners.get(type) ?? [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, ev = {}) { for (const fn of this._listeners.get(type) ?? []) fn({ preventDefault() {}, ...ev }); },
    getContext(kind) { return kind === 'webgl2' ? gl : null; },
    toDataURL() { return 'data:image/png;base64,'; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; },
  };
  canvas.gl = gl;
  return canvas;
}

export default MockGL;
