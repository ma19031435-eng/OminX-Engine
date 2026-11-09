/**
 * OminX Engine — WebGL2 device.
 *
 * Owns the context and, crucially, *caches* GL state so the renderer can issue natural,
 * call-heavy code (`device.setDepthTest(true)` on every draw) without drowning in driver
 * round-trips. It also tracks GPU resource allocation so the editor's profiler can show
 * where the frame's budget goes, and it survives context loss (tab throttling, driver reset)
 * with a re-upload pass driven by the resource registry.
 * @module engine/renderer/gl/GLDevice
 */
import { Signal } from '../../core/Signal.js';
import { createLogger } from '../../core/Logger.js';

import { Shader, ShaderPermutation } from './Shader.js';
import { GeometryBuffer, InstanceBuffer, DynamicBuffer } from './GeometryBuffer.js';
import { Texture, RenderTarget } from './Texture.js';
import { createLineGeometry } from '../gpu/LineGeometry.js';

const log = createLogger('GLDevice');

export const BlendMode = {
  None: 'none',
  Alpha: 'alpha',
  Premultiplied: 'premultiplied',
  Additive: 'additive',
  Multiply: 'multiply',
  Screen: 'screen',
  Replace: 'replace',
};

export const BlendFactor = {
  zero: 0, one: 1,
  srcColor: 0x0300, oneMinusSrcColor: 0x0301,
  dstColor: 0x0306, oneMinusDstColor: 0x0307,
  srcAlpha: 0x0302, oneMinusSrcAlpha: 0x0303,
  dstAlpha: 0x0304, oneMinusDstAlpha: 0x0305,
  srcAlphaSaturate: 0x0308,
  constantColor: 0x8001, oneMinusConstantColor: 0x8002,
  constantAlpha: 0x8003, oneMinusConstantAlpha: 0x8004,
};

export class GLDevice {
  /**
   * @param {HTMLCanvasElement|OffscreenCanvas} canvas
   * @param {object} [opts]
   * @param {boolean} [opts.antialias=false] MSAA on the default framebuffer (we usually do our own)
   * @param {boolean} [opts.alpha=false]
   * @param {number} [opts.powerPreference='high-performance']
   * @param {boolean} [opts.desynchronized=false]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    /** Tag read by `renderer/gpu/index.js` and by the engine to branch on backend. */
    this.backend = 'webgl';
    this.opts = {
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
      desynchronized: opts.desynchronized ?? false,
      ...opts,
    };
    const attributes = {
      alpha: this.opts.alpha,
      antialias: this.opts.antialias,
      depth: this.opts.depth,
      stencil: this.opts.stencil,
      premultipliedAlpha: this.opts.premultipliedAlpha,
      preserveDrawingBuffer: this.opts.preserveDrawingBuffer,
      powerPreference: this.opts.powerPreference,
      failIfMajorPerformanceCaveat: this.opts.failIfMajorPerformanceCaveat,
      desynchronized: this.opts.desynchronized,
      xrCompatible: true,
    };
    const gl = canvas.getContext('webgl2', attributes);
    if (!gl) throw new Error('OminX: WebGL2 is not available in this browser. A WebGL2-capable browser (Chrome, Edge, Firefox, Safari 15+) is required.');
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    this.isWebGL2 = true;
    this.width = canvas.width;
    this.height = canvas.height;
    this.pixelRatio = opts.pixelRatio ?? (typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    this.renderScale = 1;

    this.extensions = this._enableExtensions();
    this.caps = this._detectCapabilities();

    this.ContextLost = new Signal('ContextLost');
    this.ContextRestored = new Signal('ContextRestored');
    this.ResourceCreated = new Signal('ResourceCreated');
    this.contextLost = false;
    this._restoreHandlers = [];
    this._resources = { buffers: 0, textures: 0, programs: 0, vaos: 0, fbos: 0, bytes: 0, drawCalls: 0 };

    // state cache
    this._state = {
      program: null,
      vao: null,
      fbo: null,
      blend: null,
      blendFunc: null,
      depthTest: null,
      depthWrite: null,
      depthFunc: null,
      cullFace: null,
      frontFace: null,
      viewport: [0, 0, 0, 0],
      scissor: null,
      colorMask: null,
      activeTexture: -1,
      textures: new Array(16).fill(null),
      srgb: null,
      lineWidth: null,
      stencilTest: null,
    };
    this._clearColor = [0, 0, 0, 1];
    this._depthClear = 1;

    // defaults
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    this._state.depthTest = true;
    this._state.depthFunc = gl.LEQUAL;
    gl.disable(gl.CULL_FACE);
    this._state.cullFace = false;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this._state.blend = true;
    this._state.blendFunc = [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA];
    gl.frontFace(gl.CCW);
    this._state.frontFace = gl.CCW;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

    this._installContextLossHandlers();
    log.debug(`WebGL2 context ready — renderer: ${this.caps.renderer}, vendor: ${this.caps.vendor}`);
  }

  static create(canvas, opts) { return new GLDevice(canvas, opts); }

  _enableExtensions() {
    const gl = this.gl;
    const wanted = [
      'EXT_color_buffer_float',
      'EXT_color_buffer_half_float',
      'OES_texture_float_linear',
      'EXT_texture_filter_anisotropic',
      'EXT_disjoint_timer_query_webgl2',
      'OVR_multiview2',
      'WEBGL_multi_draw',
      'WEBGL_debug_renderer_info',
      'EXT_float_blend',
      'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_astc',
    ];
    const out = {};
    for (const name of wanted) {
      try { out[name] = gl.getExtension(name) ?? false; } catch { out[name] = false; }
    }
    return out;
  }

  _detectCapabilities() {
    const gl = this.gl;
    const dbg = this.extensions.WEBGL_debug_renderer_info;
    const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxTexUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES);
    const anisotropic = this.extensions.EXT_texture_filter_anisotropic;
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      version: gl.getParameter(gl.VERSION),
      glslVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTextureSize: maxTexSize,
      maxTextureUnits: maxTexUnits,
      maxSamples,
      maxAnisotropy: anisotropic ? gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1,
      maxVertexAttributes: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      maxUniformBlockSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE),
      maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS),
      supportsFloatTextures: !!this.extensions.EXT_color_buffer_float,
      supportsHalfFloat: !!this.extensions.EXT_color_buffer_half_float,
      floatLinear: !!this.extensions.OES_texture_float_linear,
      timerQueries: !!this.extensions.EXT_disjoint_timer_query_webgl2,
      multiDraw: !!this.extensions.WEBGL_multi_draw,
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
      isSoftware: /swiftshader|software|llvmpipe|basic render/i.test(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ''),
      maxElementsIndices: gl.getParameter(gl.MAX_ELEMENTS_INDICES),
      uniformBufferOffsetAlignment: gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT),
      maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
      isMobile: typeof navigator !== 'undefined' && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent ?? ''),
    };
  }

  _installContextLossHandlers() {
    const canvas = this.canvas;
    if (!canvas.addEventListener) return;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      log.warn('WebGL context lost — waiting for restore');
      this.ContextLost.emit();
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      log.info('WebGL context restored — re-uploading GPU resources');
      // Force a full state reset: a fresh context has no cached state.
      this._state.program = null;
      this._state.vao = null;
      this._state.textures.fill(null);
      this._state.blend = null;
      this._state.depthTest = null;
      for (const h of this._restoreHandlers) { try { h(); } catch (err) { log.exception(err, 'restore handler'); } }
      this.ContextRestored.emit();
    }, false);
  }

  /** Registers a re-upload callback invoked after context restore (textures, buffers, programs). */
  onRestore(fn) { this._restoreHandlers.push(fn); return this; }

  // ------------------------------------------------------------------ sizing
  resize(width, height, pixelRatio = this.pixelRatio) {
    const w = Math.max(1, Math.floor(width * pixelRatio * this.renderScale));
    const h = Math.max(1, Math.floor(height * pixelRatio * this.renderScale));
    if (w === this.canvas.width && h === this.canvas.height) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
    this.pixelRatio = pixelRatio;
    const cssW = Math.floor(width);
    const cssH = Math.floor(height);
    if (this.canvas.style) {
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
    }
    return true;
  }
  /** Changes the internal render resolution without touching CSS size (dynamic resolution). */
  setRenderScale(scale) {
    this.renderScale = Math.max(0.4, Math.min(1.5, scale));
    const cssW = this.canvas.clientWidth || this.width;
    const cssH = this.canvas.clientHeight || this.height;
    this.resize(cssW, cssH, this.pixelRatio);
    return this;
  }
  get aspect() { return this.width / Math.max(1, this.height); }

  // ------------------------------------------------------------------ state
  setViewport(x, y, w, h) {
    const s = this._state.viewport;
    if (s[0] === x && s[1] === y && s[2] === w && s[3] === h) return;
    s[0] = x; s[1] = y; s[2] = w; s[3] = h;
    this.gl.viewport(x, y, w, h);
  }
  setScissor(x, y, w, h) {
    const gl = this.gl;
    if (x === null) {
      if (this._state.scissor !== null) { gl.disable(gl.SCISSOR_TEST); this._state.scissor = null; }
      return;
    }
    if (!this._state.scissor) gl.enable(gl.SCISSOR_TEST);
    const s = this._state.scissor;
    if (!s || s[0] !== x || s[1] !== y || s[2] !== w || s[3] !== h) {
      gl.scissor(x, y, w, h);
      this._state.scissor = [x, y, w, h];
    }
  }
  setDepthTest(enabled, func = null) {
    const gl = this.gl;
    if (this._state.depthTest !== enabled) {
      if (enabled) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      this._state.depthTest = enabled;
    }
    if (func !== null && this._state.depthFunc !== func) { gl.depthFunc(func); this._state.depthFunc = func; }
  }
  setDepthWrite(enabled) {
    if (this._state.depthWrite === enabled) return;
    this.gl.depthMask(enabled);
    this._state.depthWrite = enabled;
  }
  setCullFace(mode) {
    const gl = this.gl;
    if (mode === false || mode === null) {
      if (this._state.cullFace !== false) { gl.disable(gl.CULL_FACE); this._state.cullFace = false; }
      return;
    }
    const glMode = mode === 'front' ? gl.FRONT : mode === 'back' ? gl.BACK : gl.FRONT_AND_BACK;
    if (this._state.cullFace !== glMode) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(glMode);
      this._state.cullFace = glMode;
    }
  }
  setFrontFace(ccw) {
    const gl = this.gl;
    const v = ccw ? gl.CCW : gl.CW;
    if (this._state.frontFace !== v) { gl.frontFace(v); this._state.frontFace = v; }
  }
  setBlend(mode, factor = null) {
    const gl = this.gl;
    if (mode === BlendMode.None) {
      if (this._state.blend !== false) { gl.disable(gl.BLEND); this._state.blend = false; }
      return;
    }
    if (this._state.blend !== true) { gl.enable(gl.BLEND); this._state.blend = true; }
    let src = gl.SRC_ALPHA, dst = gl.ONE_MINUS_SRC_ALPHA;
    switch (mode) {
      case BlendMode.Additive: src = gl.SRC_ALPHA; dst = gl.ONE; break;
      case BlendMode.Multiply: src = gl.DST_COLOR; dst = gl.ZERO; break;
      case BlendMode.Screen: src = gl.ONE; dst = gl.ONE_MINUS_SRC_COLOR; break;
      case BlendMode.Premultiplied: src = gl.ONE; dst = gl.ONE_MINUS_SRC_ALPHA; break;
      case BlendMode.Replace: src = gl.ONE; dst = gl.ZERO; break;
      default: break;
    }
    if (factor) { src = factor.src ?? src; dst = factor.dst ?? dst; }
    const cur = this._state.blendFunc;
    if (!cur || cur[0] !== src || cur[1] !== dst) {
      gl.blendFunc(src, dst);
      this._state.blendFunc = [src, dst];
    }
  }
  setBlendFuncSeparate(srcRGB, dstRGB, srcA, dstA) {
    const gl = this.gl;
    gl.blendFuncSeparate(srcRGB, dstRGB, srcA, dstA);
    this._state.blendFunc = [srcRGB, dstRGB, srcA, dstA];
    this._state.blend = true;
  }
  setColorMask(r, g, b, a) {
    const s = this._state.colorMask;
    if (s && s[0] === r && s[1] === g && s[2] === b && s[3] === a) return;
    this.gl.colorMask(r, g, b, a);
    this._state.colorMask = [r, g, b, a];
  }
  useProgram(program) {
    if (!program || this._state.program === program.program) return program;
    this.gl.useProgram(program.program);
    this._state.program = program.program;
    return program;
  }
  bindVertexArray(vao) {
    if (this._state.vao === vao) return;
    this.gl.bindVertexArray(vao);
    this._state.vao = vao;
  }
  bindFramebuffer(fbo) {
    const raw = fbo?.framebuffer ?? null;
    if (this._state.fbo === raw) return;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, raw);
    this._state.fbo = raw;
  }
  activeTexture(unit) {
    if (this._state.activeTexture === unit) return;
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this._state.activeTexture = unit;
  }
  bindTexture(texture, unit = 0) {
    this.activeTexture(unit);
    const raw = texture?.texture ?? null;
    if (this._state.textures[unit] !== raw) {
      this.gl.bindTexture(this.gl.TEXTURE_2D, raw);
      this._state.textures[unit] = raw;
    }
  }
  bindTextureCube(texture, unit = 0) {
    this.activeTexture(unit);
    const raw = texture?.texture ?? null;
    if (this._state.textures[unit] !== raw) {
      this.gl.bindTexture(this.gl.TEXTURE_CUBE_MAP, raw);
      this._state.textures[unit] = raw;
    }
  }
  setSrgb(enabled) {
    if (this._state.srgb === enabled) return;
    if (enabled) this.gl.enable(this.gl.FRAMEBUFFER_SRGB);
    else this.gl.disable(this.gl.FRAMEBUFFER_SRGB);
    this._state.srgb = enabled;
  }

  // ------------------------------------------------------------------ clears
  clear(color = null, depth = true, stencil = false) {
    const gl = this.gl;
    let mask = 0;
    if (color) {
      gl.clearColor(color[0], color[1], color[2], color[3]);
      mask |= gl.COLOR_BUFFER_BIT;
    }
    if (depth) { gl.depthMask(true); this._state.depthWrite = true; mask |= gl.DEPTH_BUFFER_BIT; }
    if (stencil) mask |= gl.STENCIL_BUFFER_BIT;
    if (mask) gl.clear(mask);
  }
  clearDepth(value = 1) { const gl = this.gl; gl.depthMask(true); this._state.depthWrite = true; gl.clearDepth(value); gl.clear(gl.DEPTH_BUFFER_BIT); }

  // ------------------------------------------------------------------ draws
  draw(count, offset = 0) {
    this.gl.drawArrays(this.gl.TRIANGLES, offset, count);
    this._resources.drawCalls++;
  }
  /** Draws `count` line vertices from the currently bound buffers. */
  drawLines(count, offset = 0) {
    this.gl.drawArrays(this.gl.LINES, offset, count);
    this._resources.drawCalls++;
  }
  /** Fullscreen triangle (post-processing passes, blits). */
  drawFullscreen() {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    this._resources.drawCalls++;
  }
  /** Depth-test comparison constant — the API is `gl.LEQUAL` here and `'less-equal'` on WebGPU. */
  get LEQUAL() { return this.gl.LEQUAL; }
  deleteVertexArray(vao) { if (vao) this.gl.deleteVertexArray(vao); }
  createLineGeometry(maxVertices) { return createLineGeometry(this, maxVertices); }
  drawIndexed(count, offsetBytes = 0, type = null) {
    const gl = this.gl;
    const indexType = type ?? gl.UNSIGNED_INT;
    gl.drawElements(gl.TRIANGLES, count, indexType, offsetBytes);
    this._resources.drawCalls++;
  }
  drawInstanced(count, instances, offset = 0) {
    const gl = this.gl;
    if (gl.drawArraysInstanced) gl.drawArraysInstanced(gl.TRIANGLES, offset, count, instances);
    this._resources.drawCalls++;
  }
  drawIndexedInstanced(count, instances, offsetBytes = 0) {
    const gl = this.gl;
    gl.drawElementsInstanced(gl.TRIANGLES, count, gl.UNSIGNED_INT, offsetBytes, instances);
    this._resources.drawCalls++;
  }
  drawArraysMode(mode, first, count) {
    const gl = this.gl;
    gl.drawArrays(glMode(mode), first, count);
    this._resources.drawCalls++;
  }

  // ------------------------------------------------------------------ stats
  beginFrame() {
    this._resources.drawCalls = 0;
    this._resources.triangles = 0;
  }
  addTriangles(n) { this._resources.triangles = (this._resources.triangles ?? 0) + n; }
  getStats() {
    return {
      drawCalls: this._resources.drawCalls,
      triangles: this._resources.triangles ?? 0,
      buffers: this._resources.buffers,
      textures: this._resources.textures,
      programs: this._resources.programs,
      vaos: this._resources.vaos,
      framebuffers: this._resources.fbos,
      gpuBytes: this._resources.bytes,
      renderer: this.caps.renderer,
      isSoftware: this.caps.isSoftware,
    };
  }

  /** GPU timer wrapper (returns null when EXT_disjoint_timer_query_webgl2 is missing). */
  // ------------------------------------------------------------------ resource factories
  // The renderer builds everything through the device so a WebGPU device can hand back WebGPU
  // resources for the same call site (`renderer/gpu/index.js` forwards to these).
  createShader(desc) { return new Shader(this, desc); }
  createShaderPermutation(desc) { return new ShaderPermutation(this, desc); }
  createTexture(opts) { return new Texture(this, opts); }
  createRenderTarget(opts) { return new RenderTarget(this, opts); }
  createGeometry(mesh) { return new GeometryBuffer(this, mesh); }
  createInstanceBuffer(capacity, layout) { return new InstanceBuffer(this, capacity, layout); }
  createDynamicBuffer(target, bytes) { return new DynamicBuffer(this, target, bytes); }

  createTimer() {
    const gl = this.gl;
    const ext = this.extensions.EXT_disjoint_timer_query_webgl2;
    if (!ext) return { available: false, begin() {}, end() { return null; }, poll() { return null; } };
    let query = gl.createQuery();
    let running = false;
    let lastResult = null;
    let pendingQueries = [];
    return {
      available: true,
      begin() { if (!running) { gl.beginQuery(ext.TIME_ELAPSED_EXT, query); running = true; } },
      end() { if (running) { gl.endQuery(ext.TIME_ELAPSED_EXT); running = false; pendingQueries.push(query); query = gl.createQuery(); } },
      poll() {
        if (pendingQueries.length && gl.getQueryParameter(pendingQueries[0], gl.QUERY_RESULT_AVAILABLE)) {
          lastResult = gl.getQueryParameter(pendingQueries.shift(), gl.QUERY_RESULT) / 1e6;
        }
        return lastResult;
      },
    };
  }

  /** Reads a pixel — used by tests and the editor's picking debug view. */
  readPixel(x, y) {
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  /** Captures the canvas as a data URL (editor "screenshot" button, bug reports). */
  toDataURL(type = 'image/png', quality = 0.92) {
    this.gl.finish?.();
    return this.canvas.toDataURL?.(type, quality) ?? null;
  }

  destroy() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext?.();
  }
}

function glMode(mode) {
  switch (mode) {
    case 'lines': return 0x0001;
    case 'lineStrip': return 0x0003;
    case 'points': return 0x0000;
    default: return 0x0004;
  }
}

export default GLDevice;
