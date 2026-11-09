/**
 * OminX Engine — WebGPU render device.
 *
 * The engine's renderer is authored against a *device contract* (bind program → set state →
 * bind geometry → draw) rather than an API. This class implements that contract on top of WebGPU:
 *
 *   · one `GPUCommandEncoder` per frame, one render pass per bound target;
 *   · pipelines are built lazily from the program's WGSL entry point + the *current* blend,
 *     depth, cull and MSAA state, and cached (the same draw next frame is a cache hit);
 *   · uniform values are written into an aligned slab and copied into a ring buffer, bound with
 *     dynamic offsets — the WebGPU equivalent of `glUniform*`, without a buffer per draw;
 *   · group 1 bind groups hold the texture/sampler pairs the pass needs, cached by content.
 *
 * Everything is explicit so the engine can stay immediate-mode in authoring style while WebGPU
 * still sees validated, immutable state at draw time.
 *
 * @module engine/src/renderer/webgpu/WebGPUDevice
 */
import { createLogger } from '../../core/Logger.js';
import { Signal } from '../../core/Signal.js';
import { preprocessWGSL } from '../wgsl/preprocess.js';
import { parseUniformLayout, parseVertexInputs, parseBindings } from '../wgsl/layout.js';
import { WGSL_PROGRAMS } from '../wgsl/index.js';
import { ATTRIBUTE_LOCATIONS } from '../gl/GeometryBuffer.js';
import {
  WebGPUShader, WebGPUShaderPermutation, vertexFormat, vertexFormatSize,
} from './WebGPUShader.js';
import {
  WebGPUTexture, WebGPURenderTarget, WebGPUGeometry, WebGPUInstanceBuffer,
  WebGPUDynamicBuffer, WebGPUTimer, VERTEX_FORMATS, vertexFormatStride,
} from './WebGPUResources.js';
import { createLineGeometry } from '../gpu/LineGeometry.js';

const log = createLogger('WebGPUDevice');

/** Compare-function names understood by `setDepthTest`. */
export const CompareFunctions = {
  never: 'never', less: 'less', equal: 'equal', lequal: 'less-equal', lessEqual: 'less-equal',
  greater: 'greater', notequal: 'not-equal', notEqual: 'not-equal', gequal: 'greater-equal', greaterEqual: 'greater-equal', always: 'always',
};

/** Blend mode names understood by `setBlend`, with their WebGPU blend components. */
export const BlendStates = {
  none: null,
  alpha: { src: 'src-alpha', dst: 'one-minus-src-alpha' },
  additive: { src: 'src-alpha', dst: 'one' },
  multiply: { src: 'dst', dst: 'zero' },
  screen: { src: 'one', dst: 'one-minus-src' },
  premultiplied: { src: 'one', dst: 'one-minus-src-alpha' },
  replace: { src: 'one', dst: 'zero' },
};

const INDEX_FORMATS = { uint32: 'uint32', uint16: 'uint16' };

export class WebGPUDevice {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {number} [opts.pixelRatio]
   * @param {number} [opts.samples=1] MSAA sample count for the main pass
   * @param {boolean} [opts.alphaMode] 'opaque' | 'premultiplied'
   * @param {GPUDevice} [opts.device] pre-created device (used by tests)
   * @param {GPUCanvasContext} [opts.context]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.backend = 'webgpu';
    this.pixelRatio = opts.pixelRatio ?? (globalThis.devicePixelRatio ?? 1);
    this.width = canvas?.width ?? 1280;
    this.height = canvas?.height ?? 720;
    this.samples = opts.samples ?? 1;
    this.alphaMode = opts.alphaMode ?? 'opaque';
    this.renderScale = 1;
    this.depthFormat = opts.depthFormat ?? 'depth24plus';
    this.contextLost = false;
    /** Optional timestamp/query support (disabled by default: many drivers need opt-in). */
    this.mipmapsEnabled = opts.mipmaps !== false;
    this.uniformRingBytes = opts.uniformRingBytes ?? 8 * 1024 * 1024;

    this.Signal = { ContextLost: new Signal('WebGPU.ContextLost'), ContextRestored: new Signal('WebGPU.ContextRestored') };

    this.gpu = opts.device ?? null;
    this.adapter = opts.adapter ?? null;
    this.context = opts.context ?? null;
    this.queue = this.gpu?.queue ?? null;
    this.format = opts.format ?? 'bgra8unorm';

    this._restoreHandlers = [];
    this._programCache = new Map();
    this._pipelineCache = new Map();
    this._bindGroupCache = new Map();
    this._samplerCache = new Map();
    this._dummyBuffers = new Map();
    this._uniformGeneration = 0;

    this._state = {
      program: null, geometry: null, target: null,
      blend: 'none', blendSrc: null, blendDst: null, blendSeparate: null,
      depthTest: true, depthFunc: 'less-equal', depthWrite: true,
      cull: 'back', frontFace: 'ccw', colorMask: [true, true, true, true],
      viewport: [0, 0, this.width, this.height], scissor: null, srgb: false,
    };
    this._textures = new Map();
    this._textureKeys = [];
    this._activeTexture = 0;
    this._stats = { drawCalls: 0, triangles: 0, pipelines: 0, bindGroups: 0, uniformBytes: 0, frame: 0 };
    this._resources = { buffers: 0, vaos: 0, textures: 0, fbos: 0, programs: 0, bytes: 0, triangles: 0, drawCalls: 0 };
    this.caps = {
      isMobile: /android|iphone|ipad|mobile/i.test(globalThis.navigator?.userAgent ?? ''),
      isSoftware: false,
      maxSamples: 4,
      maxAnisotropy: 16,
      supportsFloatTextures: true,
      supportsHalfFloat: true,
      supportsSrgbTargets: true,
      renderer: 'WebGPU',
      vendor: '',
      shaderLanguage: 'wgsl',
    };
  }

  /**
   * Requests an adapter + device and configures the canvas context.
   * @returns {Promise<WebGPUDevice|null>} null when WebGPU is unavailable
   */
  static async create(canvas, opts = {}) {
    const gpu = opts.gpu ?? globalThis.navigator?.gpu;
    if (!gpu) return null;
    const device = new WebGPUDevice(canvas, opts);
    if (!opts.device) {
      const adapter = await gpu.requestAdapter({ powerPreference: opts.powerPreference ?? 'high-performance' });
      if (!adapter) return null;
      const gpuDevice = await adapter.requestDevice({ requiredLimits: opts.requiredLimits });
      device.adapter = adapter;
      device.gpu = gpuDevice;
      device.queue = gpuDevice.queue;
      if (adapter.info) {
        device.caps.renderer = adapter.info.description ?? adapter.info.device ?? 'WebGPU';
        device.caps.vendor = adapter.info.vendor ?? '';
        device.caps.isSoftware = /swiftshader|lavapipe|software/i.test(`${adapter.info.description ?? ''} ${adapter.info.device ?? ''}`);
      }
    } else {
      device.gpu = opts.device;
      device.queue = opts.device.queue;
    }
    device.limits = device.gpu.limits ?? {};
    device.uniformAlignment = Math.max(16, device.limits.minUniformBufferOffsetAlignment ?? 256);
    device._configureContext(opts);
    device._createUniformRing();
    device._installDeviceLostHandler();
    return device;
  }

  _configureContext(opts = {}) {
    if (opts.context) { this.context = opts.context; return; }
    this.context = this.canvas?.getContext?.('webgpu') ?? null;
    if (!this.context) {
      log.warn('canvas has no WebGPU context');
      return;
    }
    const preferred = this.gpu.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
    this.format = opts.format ?? preferred;
    this.context.configure({
      device: this.gpu,
      format: this.format,
      alphaMode: this.alphaMode === 'premultiplied' ? 'premultiplied' : 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }

  _installDeviceLostHandler() {
    if (!this.gpu?.lost) return;
    this.gpu.lost.then((info) => {
      this.contextLost = true;
      log.warn(`device lost: ${info?.reason} — ${info?.message ?? ''}`);
      this.Signal.ContextLost.emit({ device: this, reason: info?.reason, message: info?.message });
    });
    this.gpu.onuncapturederror?.((event) => {
      log.error(`uncaptured error: ${event?.error?.message ?? event}`);
    });
  }

  _createUniformRing() {
    this._uniformBufferGeneration = ++this._uniformGeneration;
    this._uniformBuffer?.destroy?.();
    this._uniformBuffer = this.createBuffer(this.uniformRingBytes, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'uniformRing');
    this._uniformCursor = 0;
    this._bindGroupCache.clear();
  }

  // ------------------------------------------------------------------ lifecycle
  onRestore(fn) { this._restoreHandlers.push(fn); return this; }

  /** Starts a frame: acquires the swapchain image and a fresh command encoder. */
  beginFrame() {
    if (this.contextLost || !this.gpu) return this;
    this._resources.drawCalls = 0;
    this._resources.triangles = 0;
    this._encoder = this.gpu.createCommandEncoder({ label: `frame${this._stats.frame}` });
    this._uniformCursor = 0;
    this._textures.clear();
    this._textureKeys = [];
    this._passActive = false;
    this._pendingTarget = this._state.target ?? null;
    this._passDescriptor = null;
    this._stats.drawCalls = 0;
    this._stats.frame++;
    return this;
  }

  /** Ends the active pass and submits the frame. */
  endFrame() {
    if (this.contextLost || !this.gpu || !this._encoder) return this;
    this._endPass();
    this.gpu.queue.submit([this._encoder.finish()]);
    this._encoder = null;
    this._syncStats();
    return this;
  }

  _commandEncoder() {
    if (!this._encoder) this._encoder = this.gpu.createCommandEncoder({ label: 'late' });
    return this._encoder;
  }

  /** Color attachment view for the current target (render target or swapchain). */
  _targetViews() {
    const target = this._pendingTarget ?? this._state.target;
    if (target) {
      return {
        view: target.msaaView ?? target.colors?.[0]?.view ?? target.view,
        resolve: target.msaaView ? target.colors?.[0]?.view ?? null : null,
        depth: target.depthView ?? null,
        sampleCount: target.msaaView ? target.samples : 1,
      };
    }
    const current = this.context?.getCurrentTexture?.();
    this._swapchainTexture = current ?? this._swapchainTexture;
    const view = this._swapchainView = current?.createView?.() ?? this._swapchainView;
    return { view, resolve: null, depth: this._ensureSwapchainDepth(), sampleCount: this.samples };
  }

  _ensureSwapchainDepth() {
    const needsRebuild = !this._swapchainDepth
      || this._swapchainDepth.width !== this.width
      || this._swapchainDepth.height !== this.height
      || (this.samples > 1) !== (this._swapchainDepth.sampleCount > 1);
    if (needsRebuild) {
      this._swapchainDepth?.destroy?.();
      const texture = this.gpu.createTexture({
        size: { width: Math.max(1, this.width), height: Math.max(1, this.height), depthOrArrayLayers: 1 },
        format: this.depthFormat,
        sampleCount: this.samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        label: 'swapchainDepth',
      });
      this._swapchainDepth = Object.assign(texture, { width: this.width, height: this.height, sampleCount: this.samples });
    }
    return this._swapchainDepth.createView({ aspect: 'depth-only' });
  }

  /** Ends the active render pass (if any) so a new target can be bound. */
  _endPass() {
    if (this._passActive && this._pass) {
      this._pass.end();
      this._pass = null;
      this._passActive = false;
    }
  }

  // ------------------------------------------------------------------ targets & clears
  bindFramebuffer(target) {
    if (target === this._pendingTarget && !this._passActive) { this._state.target = target; return this; }
    this._endPass();
    this._pendingTarget = target ?? null;
    this._state.target = target ?? null;
    this._passDescriptor = null;
    return this;
  }

  clear(color = null, depth = true, stencil = false) {
    if (color !== null && color !== undefined) {
      const [r, g, b, a] = Array.isArray(color) || color.length !== undefined ? color : [color, color, color, 1];
      this._clearColor = { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a ?? 1 };
    } else {
      this._clearColor = null;
    }
    this._clearDepth = depth ? (this._clearDepthValue ?? 1) : null;
    this._clearStencil = stencil ? 0 : null;
    // A clear must precede the draws in the pass, so restart it with the new clear values.
    if (this._passActive) this._endPass();
    void CompareFunctions;
    return this;
  }

  /** Clears depth only; any pending colour clear set up by `clear()` is preserved. */
  clearDepth(value = 1) {
    this._clearDepthValue = value;
    this._clearDepth = value;
    if (this._passActive) this._endPass();
    return this;
  }

  _ensurePass() {
    if (this._passActive) return;
    const descriptor = { label: 'pass', colorAttachments: [], depthStencilAttachment: undefined };
    const hadClearColor = this._clearColor !== null && this._clearColor !== undefined;
    const clearColor = hadClearColor ? this._clearColor : { r: 0, g: 0, b: 0, a: 0 };
    const target = this._pendingTarget ?? this._state.target;
    const clearDepth = this._clearDepth;

    if (target) {
      const view = target.msaaView ?? target.colors?.[0]?.view ?? target.view;
      const resolveTarget = target.msaaView ? target.colors?.[0]?.view : null;
      if (!view) { this._passActive = false; return; }
      descriptor.colorAttachments.push({
        view, resolveTarget: resolveTarget ?? undefined,
        clearValue: clearColor, loadOp: hadClearColor ? 'clear' : 'load', storeOp: 'store',
      });
      if (target.depthView) {
        descriptor.depthStencilAttachment = {
          view: target.depthView,
          depthClearValue: clearDepth ?? 1,
          depthLoadOp: clearDepth !== null && clearDepth !== undefined ? 'clear' : 'load',
          depthStoreOp: 'store',
        };
      }
    } else {
      const views = this._targetViews();
      if (!views.view) { return; }
      descriptor.colorAttachments.push({
        view: views.view, clearValue: clearColor,
        loadOp: hadClearColor ? 'clear' : 'load', storeOp: 'store',
      });
      if (views.depth) {
        descriptor.depthStencilAttachment = {
          view: views.depth,
          depthClearValue: clearDepth ?? 1,
          depthLoadOp: clearDepth !== null && clearDepth !== undefined ? 'clear' : 'load',
          depthStoreOp: 'store',
        };
      }
    }

    this._pass = this._commandEncoder().beginRenderPass(descriptor);
    this._passActive = true;
    this._passDescriptor = descriptor;
    // A frame that never issues another clear should not re-clear on later passes.
    this._clearColor = null;
    this._clearDepth = null;
    return this;
  }

  // ------------------------------------------------------------------ state
  setViewport(x, y, w, h) {
    const state = this._state.viewport;
    if (state[0] === x && state[1] === y && state[2] === w && state[3] === h) return this;
    this._state.viewport = [x, y, w, h];
    return this;
  }

  setScissor(x, y, w, h) {
    if (x === null || x === undefined) { this._state.scissor = null; return this; }
    this._state.scissor = [x, y, w, h];
    return this;
  }

  setDepthTest(enabled, func = null) {
    this._state.depthTest = enabled;
    if (func !== null && func !== undefined) this._state.depthFunc = CompareFunctions[func] ?? func;
    return this;
  }

  setDepthWrite(enabled) { this._state.depthWrite = enabled; return this; }

  setCullFace(mode) { this._state.cull = mode === false ? 'none' : mode; return this; }

  setFrontFace(ccw = true) { this._state.frontFace = ccw ? 'ccw' : 'cw'; return this; }

  setBlend(mode, factor = null) {
    const name = typeof mode === 'string' ? mode : (mode?.name ?? 'alpha');
    this._state.blend = name;
    if (factor) {
      this._state.blendSrc = factor.src ?? null;
      this._state.blendDst = factor.dst ?? null;
    } else {
      this._state.blendSrc = null;
      this._state.blendDst = null;
    }
    return this;
  }

  setBlendFuncSeparate(srcRGB, dstRGB, srcA, dstA) {
    this._state.blend = 'custom';
    this._state.blendSeparate = { srcRGB, dstRGB, srcA, dstA };
    return this;
  }

  setColorMask(r, g, b, a) { this._state.colorMask = [r, g, b, a]; return this; }

  setSrgb(enabled) { this._state.srgb = enabled; return this; }

  /** Snapshot of the current pipeline state (the GL `Sprites` code reads this). */
  getState() { return this._state; }

  // ------------------------------------------------------------------ binding
  useProgram(program) {
    if (!program || this._state.program === program) return program;
    this._state.program = program;
    return program;
  }

  bindVertexArray(geometryOrBinding) {
    if (this._state.geometry === geometryOrBinding) return this;
    this._state.geometry = geometryOrBinding;
    return this;
  }

  bindTexture(texture, unit = 0) {
    if (!texture) return this;
    this._textures.set(unit, texture);
    this._textureKeys[unit] = textureKey(texture);
    return this;
  }

  bindTextureCube(texture, unit = 0) { return this.bindTexture(texture, unit); }
  activeTexture(unit) { this._activeTexture = unit; return this; }

  // ------------------------------------------------------------------ draws
  draw(count, offset = 0) {
    this._draw({ kind: 'arrays', count, first: Math.floor(offset), instances: 1 });
    return this;
  }

  /** Line-list draw (debug/nav/grid geometry). */
  drawLines(count, offset = 0) {
    this.setTopology('line-list');
    this._draw({ kind: 'arrays', count, first: Math.floor(offset), instances: 1 });
    return this;
  }

  /** Fullscreen triangle used by blits and post passes. */
  drawFullscreen() {
    this.setTopology('triangle-list');
    this._draw({ kind: 'arrays', count: 3, first: 0, instances: 1 });
    return this;
  }

  /** Depth-test comparison constant matching the GL backend's `gl.LEQUAL`. */
  get LEQUAL() { return 'less-equal'; }

  /** WebGPU has no vertex array objects — kept so shared renderer code works unchanged. */
  deleteVertexArray() { return this; }

  createLineGeometry(maxVertices) { return createLineGeometry(this, maxVertices); }

  drawIndexed(count, offsetBytes = 0) {
    this._draw({ kind: 'indexed', count, first: Math.floor(offsetBytes / 4), instances: 1 });
    return this;
  }

  drawIndexedInstanced(count, instances, offsetBytes = 0) {
    this._draw({ kind: 'indexed', count, first: Math.floor(offsetBytes / 4), instances });
    return this;
  }

  drawInstanced(count, instances, offset = 0) {
    this._draw({ kind: 'arrays', count, first: Math.floor(offset), instances });
    return this;
  }

  /** Line/point topology draws (`'lines' | 'points' | 'triangles' | 'strip'`). */
  drawArraysMode(mode, first, count) {
    this._draw({ kind: 'arrays', count, first, instances: 1, topology: topologyName(mode) });
    return this;
  }

  addTriangles(n) { this._resources.triangles += n; return this; }

  _draw(command) {
    if (!this.gpu || this.contextLost) return;
    const shader = this._state.program;
    const geometry = this._state.geometry;
    if (!shader || !geometry) return;
    this._ensurePass();
    if (!this._passActive) return;

    const target = this._pendingTarget ?? this._state.target;
    const formats = target
      ? { colors: target.colors.map((c) => c.format), depth: target.depthTex ? target.depthTex.format ?? this.depthFormat : null, samples: target.msaaView ? target.samples : 1 }
      : { colors: [this.format], depth: this.depthFormat, samples: this.samples };

    const { pipeline, bindGroupLayouts } = this._getPipeline(shader, formats, command.topology);
    const uniform = this._writeUniforms(shader);
    const group0 = this._getUniformBindGroup(bindGroupLayouts[0], uniform, shader.layout.size);
    const group1 = this._getTextureBindGroup(bindGroupLayouts[1], shader);

    this._pass.setPipeline(pipeline);
    this._pass.setViewport(
      this._state.viewport[0], this._state.viewport[1],
      Math.max(1, this._state.viewport[2]), Math.max(1, this._state.viewport[3]),
      0, 1,
    );
    if (this._state.scissor) {
      this._pass.setScissorRect(
        Math.max(0, Math.floor(this._state.scissor[0])), this._flipY(this._state.scissor[1], this._state.scissor[3]),
        Math.max(1, Math.floor(this._state.scissor[2])), Math.max(1, Math.floor(this._state.scissor[3])),
      );
    }
    this._pass.setBindGroup(0, group0, [uniform.offset]);
    if (group1) this._pass.setBindGroup(1, group1);

    // Vertex buffers, resolved from the shader's declared inputs.
    let slot = 0;
    for (const input of shader.layout.vertexInputs) {
      const buffer = resolveAttributeBuffer(geometry, input.name, this);
      if (!buffer) continue;
      this._pass.setVertexBuffer(slot, buffer.buffer, buffer.offset ?? 0, buffer.size);
      slot++;
    }

    if (command.kind === 'indexed') {
      const index = geometry.indexBuffer
        ?? (geometry.geometry?.indexBuffer)
        ?? null;
      if (index) {
        this._pass.setIndexBuffer(index, geometry.indexFormat ?? 'uint32');
        this._pass.drawIndexed(command.count, command.instances, command.first, 0, 0);
      }
    } else {
      this._pass.draw(command.count, command.instances, command.first, 0);
    }
    this._stats.drawCalls++;
    // `Renderer` reads these counters for its stats panel / debug overlay, same as on WebGL.
    this._resources.drawCalls = (this._resources.drawCalls ?? 0) + 1;
    if (command.kind === 'indexed') this._resources.triangles += Math.floor(command.count / 3) * command.instances;
    else this._resources.triangles += Math.floor(command.count / 3) * command.instances;
  }

  _flipY(y, height) {
    const total = this._pendingTarget?.height ?? this.height;
    return Math.max(0, total - (y + height));
  }

  _writeUniforms(shader) {
    const size = Math.max(16, shader.layout.size);
    const aligned = align(size, this.uniformAlignment);
    if (this._uniformCursor + aligned > this.uniformRingBytes) {
      // Grow rather than wrap: an in-flight frame must never be overwritten mid-submission.
      this.uniformRingBytes *= 2;
      this._createUniformRing();
    }
    const offset = this._uniformCursor;
    this._uniformCursor += aligned;
    // Each draw owns a ring slot: a shader whose values did not change still has to be copied when
    // it lands on a new slot, otherwise the draw would read whatever the previous pass left there.
    const reused = !shader.dirty
      && shader._ringOffset === offset
      && shader._ringGeneration === this._uniformBufferGeneration;
    if (!reused) {
      this.gpu.queue.writeBuffer(this._uniformBuffer, offset, shader.bytes.buffer, 0, shader.bytes.byteLength);
      shader.dirty = false;
      shader._ringOffset = offset;
      shader._ringGeneration = this._uniformBufferGeneration;
    }
    this._stats.uniformBytes += size;
    return { offset, size: aligned };
  }

  _getUniformBindGroup(layout, uniform, size) {
    const key = `u:${layout ?? 'default'}:${uniform.offset}:${this._uniformBufferGeneration}`;
    let group = this._bindGroupCache.get(key);
    if (!group) {
      group = this.gpu.createBindGroup({
        label: 'uniforms',
        layout,
        entries: [{ binding: 0, resource: { buffer: this._uniformBuffer, offset: uniform.offset, size: Math.min(size, this.uniformRingBytes - uniform.offset) } }],
      });
      this._bindGroupCache.set(key, group);
      this._stats.bindGroups++;
    }
    return group;
  }

  _getTextureBindGroup(layout, shader) {
    if (!layout) return null;
    const descriptor = shader.descriptor;
    const slots = layout.__slots ?? (layout.__slots = shader.layout.textureSlots);
    const entries = [];
    const keyParts = [];
    for (const slot of slots) {
      // Engine-side unit: the renderer binds by unit (GL semantics); the WGSL slot index is the
      // same number because `declareTextureSlots` maps unit i to binding 2i. A program descriptor
      // may remap a slot by texture *name* (uShadowMap0 on unit 7, and so on).
      const unit = slot.unit;
      const fallback = slot.depth ? this.whiteDepthTexture : slot.cube ? this.whiteCubeTexture : this.whiteTexture;
      const texture = this._textures.get(unit) ?? fallback;
      const view = texture?.view ?? fallback.view;
      const sampler = slot.depth
        ? this.getSampler('nearest', 'clamp', { comparison: slot.comparison !== false })
        : (texture?.sampler ?? this.getSampler('linear', 'clamp'));
      if (!view || !sampler) continue;
      entries.push({ binding: slot.textureBinding, resource: view });
      entries.push({ binding: slot.samplerBinding, resource: sampler });
      keyParts.push(`${slot.textureBinding}:${textureKey(texture)}`);
    }
    void descriptor;
    if (entries.length === 0) return null;
    const key = `t:${keyParts.join('|')}`;
    let group = this._bindGroupCache.get(key);
    if (!group) {
      group = this.gpu.createBindGroup({ label: 'textures', layout, entries });
      this._bindGroupCache.set(key, group);
      this._stats.bindGroups++;
    }
    return group;
  }

  // ------------------------------------------------------------------ pipelines
  _getPipeline(shader, formats, topology) {
    const state = this._state;
    const key = [
      shader.programName, definesKey(shader.defines),
      formats.colors.join(','), formats.depth ?? 'none', formats.samples,
      state.blend, state.blendSrc ?? '', state.blendDst ?? '', state.blendSeparate ? 'sep' : '',
      state.depthTest ? 1 : 0, state.depthFunc, state.depthWrite ? 1 : 0,
      state.cull, state.frontFace, state.colorMask.join(''), topology ?? 'triangles',
    ].join('|');
    const cached = this._pipelineCache.get(key);
    if (cached) return cached;

    if (!shader.module) {
      shader.module = this.gpu.createShaderModule({ code: shader.code, label: `${shader.programName}` });
      this._resources.programs++;
    }
    const vertexLayout = this._vertexLayout(shader);
    const bindGroupLayouts = this._bindGroupLayouts(shader);
    const pipelineLayout = this.gpu.createPipelineLayout({ bindGroupLayouts });

    const blendState = this._blendState();
    const descriptor = {
      label: `${shader.programName}(${key.slice(0, 48)})`,
      layout: pipelineLayout,
      vertex: {
        module: shader.module,
        entryPoint: shader.descriptor.vertexEntry,
        buffers: vertexLayout,
      },
      fragment: shader.descriptor.fragmentEntry ? {
        module: shader.module,
        entryPoint: shader.descriptor.fragmentEntry,
        targets: formats.colors.map((format, index) => ({
          format,
          blend: index === 0 ? blendState : undefined,
          writeMask: state.colorMask.every(Boolean) ? undefined : colorWriteMask(state.colorMask),
        })),
      } : undefined,
      primitive: {
        topology: topology ?? 'triangle-list',
        cullMode: state.cull === 'front' ? 'front' : state.cull === 'none' || state.cull === 'off' ? 'none' : 'back',
        frontFace: state.frontFace === 'cw' ? 'cw' : 'ccw',
      },
      depthStencil: formats.depth ? {
        format: formats.depth,
        depthWriteEnabled: state.depthWrite,
        depthCompare: state.depthTest ? state.depthFunc : 'always',
      } : undefined,
      multisample: { count: Math.max(1, formats.samples ?? 1) },
    };
    const pipeline = this.gpu.createRenderPipeline(descriptor);
    const entry = { pipeline, bindGroupLayouts };
    this._pipelineCache.set(key, entry);
    this._stats.pipelines++;
    return entry;
  }

  _blendState() {
    const state = this._state;
    if (state.blend === 'none' || !state.blend) return undefined;
    const separate = state.blendSeparate;
    const preset = BlendStates[state.blend] ?? BlendStates.alpha;
    const src = state.blendSrc ?? separate?.srcRGB ?? preset?.src ?? 'src-alpha';
    const dst = state.blendDst ?? separate?.dstRGB ?? preset?.dst ?? 'one-minus-src-alpha';
    const srcAlpha = separate?.srcA ?? src;
    const dstAlpha = separate?.dstA ?? dst;
    return {
      color: { srcFactor: src, dstFactor: dst, operation: 'add' },
      alpha: { srcFactor: srcAlpha, dstFactor: dstAlpha, operation: 'add' },
    };
  }

  _vertexLayout(shader) {
    const inputs = shader.layout.vertexInputs ?? [];
    if (inputs.length === 0) return [];
    const instanceAttributes = inputs.filter((input) => input.name.startsWith('instance'));
    const vertexAttributes = inputs.filter((input) => !input.name.startsWith('instance'));
    const buffers = [];
    if (vertexAttributes.length) {
      // One interleaved-by-attribute buffer set: each attribute lives in its own tightly packed
      // buffer (that is how the mesh uploader writes them), so each gets its own buffer slot.
      for (const input of vertexAttributes) {
        const format = VERTEX_FORMATS[input.name] ?? vertexFormat(input.type);
        buffers.push({
          arrayStride: vertexFormatStride(format),
          stepMode: 'vertex',
          attributes: [{ shaderLocation: input.location, offset: 0, format }],
        });
        input.bufferSlot = buffers.length - 1;
        input.format = format;
      }
    }
    const matrixInputs = instanceAttributes.filter((input) => /^instanceMatrix[0-3]$/.test(input.name));
    const others = instanceAttributes.filter((input) => !/^instanceMatrix[0-3]$/.test(input.name));
    if (matrixInputs.length) {
      const slot = buffers.length;
      buffers.push({
        arrayStride: 64,
        stepMode: 'instance',
        attributes: matrixInputs.map((input) => ({
          shaderLocation: input.location,
          offset: Number(input.name.slice(-1)) * 16,
          format: 'float32x4',
        })),
      });
      for (const input of matrixInputs) { input.bufferSlot = slot; input.format = 'float32x4'; input.offset = Number(input.name.slice(-1)) * 16; }
    }
    for (const input of others) {
      const format = VERTEX_FORMATS[input.name] ?? vertexFormat(input.type);
      buffers.push({
        arrayStride: vertexFormatStride(format),
        stepMode: 'instance',
        attributes: [{ shaderLocation: input.location, offset: 0, format }],
      });
      input.bufferSlot = buffers.length - 1;
      input.format = format;
    }
    return buffers;
  }

  _bindGroupLayouts(shader) {
    if (shader.bindGroupLayouts) return shader.bindGroupLayouts;
    const uniformLayout = this.gpu.createBindGroupLayout({
      label: `${shader.programName}_uniforms`,
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } }],
    });
    const textureEntries = [];
    for (const slot of shader.layout.textureSlots) {
      const dimension = slot.cube ? 'cube' : '2d';
      textureEntries.push({
        binding: slot.textureBinding,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        texture: { sampleType: slot.depth ? 'depth' : 'float', viewDimension: dimension },
      });
      textureEntries.push({
        binding: slot.samplerBinding,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        sampler: { type: slot.depth ? 'comparison' : 'filtering' },
      });
    }
    const textureLayout = textureEntries.length
      ? this.gpu.createBindGroupLayout({ label: `${shader.programName}_textures`, entries: textureEntries })
      : null;
    shader.bindGroupLayouts = [uniformLayout, textureLayout];
    return shader.bindGroupLayouts;
  }

  // ------------------------------------------------------------------ reflection & programs
  getProgramDescriptor(name) { return WGSL_PROGRAMS[name] ?? null; }

  preprocessProgram(descriptor, defines) {
    return preprocessWGSL(descriptor.code, { ...(descriptor.defines ?? {}), ...defines });
  }

  /** Parses a preprocessed program: uniform layout, vertex inputs and texture slots. */
  reflectProgram(code, defines = {}) {
    const cached = this._programCache.get(code);
    if (cached) return cached;
    const layout = parseUniformLayout(code);
    const vertexEntry = /@vertex\s*\n?\s*fn\s+([A-Za-z0-9_]+)/.exec(code)?.[1] ?? 'vs_main';
    const vertexInputs = parseVertexInputs(code, vertexEntry);
    const bindings = parseBindings(code);
    const textureSlots = bindings.textures.map((texture) => {
      const sampler = bindings.samplers.find((s) => s.binding === texture.binding + 1);
      const depth = texture.type.startsWith('texture_depth');
      return {
        name: texture.name,
        unit: Math.floor(texture.binding / 2),
        textureBinding: texture.binding,
        samplerBinding: sampler?.binding ?? texture.binding + 1,
        type: texture.type,
        depth,
        cube: texture.type.startsWith('texture_cube'),
        comparison: depth && /comparison/.test(sampler?.type ?? ''),
      };
    });
    const reflected = { ...layout, vertexEntry, vertexInputs, bindings, textureSlots };
    this._programCache.set(code, reflected);
    void defines;
    return reflected;
  }

  createShader(desc) { return new WebGPUShader(this, desc); }
  createShaderPermutation(desc) { return new WebGPUShaderPermutation(this, desc); }
  createTexture(opts) { return new WebGPUTexture(this, opts); }
  createRenderTarget(opts) { return new WebGPURenderTarget(this, opts); }
  createGeometry(mesh) { return new WebGPUGeometry(this, mesh); }
  createInstanceBuffer(capacity, layout) { return new WebGPUInstanceBuffer(this, capacity, layout); }
  createDynamicBuffer(target, bytes) { return new WebGPUDynamicBuffer(this, target, bytes); }
  createTimer() { return new WebGPUTimer(this); }

  createBuffer(byteLength, usage, label = 'buffer') {
    this._resources.buffers++;
    this._resources.bytes += byteLength;
    return this.gpu.createBuffer({ size: align(Math.max(4, byteLength), 4), usage, label, mappedAtCreation: false });
  }

  /** 1x1 opaque texture used when a pass samples a slot the caller never bound. */
  get whiteTexture() {
    if (!this._whiteTexture) {
      this._whiteTexture = new WebGPUTexture(this, { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]), generateMipmaps: false, name: 'white' });
    }
    return this._whiteTexture;
  }

  /** 1x1x6 white cubemap for sky programs whose cubemap was never loaded. */
  get whiteCubeTexture() {
    if (!this._whiteCubeTexture) {
      this._whiteCubeTexture = new WebGPUTexture(this, {
        width: 1, height: 1, cube: true, generateMipmaps: false, name: 'whiteCube',
        data: new Uint8Array(4 * 6).fill(255),
      });
    }
    return this._whiteCubeTexture;
  }

  get whiteDepthTexture() {
    if (!this._whiteDepthTexture) {
      this._whiteDepthTexture = new WebGPUTexture(this, { width: 1, height: 1, format: this.depthFormat, generateMipmaps: false, name: 'whiteDepth' });
    }
    return this._whiteDepthTexture;
  }

  /** Zero-filled vertex buffer matching a mesh's vertex count, for optional attributes. */
  _zeroVertexBuffer(stride, vertexCount = 1) {
    const key = `${stride}:${vertexCount}`;
    let buffer = this._dummyBuffers.get(key);
    if (!buffer) {
      const size = Math.max(stride, stride * vertexCount);
      buffer = this.createBuffer(size, GPUBufferUsage.VERTEX, `zero_${key}`);
      this.gpu.queue.writeBuffer(buffer, 0, new Float32Array(size / 4));
      this._dummyBuffers.set(key, buffer);
    }
    return { buffer, size: buffer.size };
  }

  getSampler(filter = 'linear', wrap = 'clamp', { comparison = false } = {}) {
    const key = `${filter}|${wrap}|${comparison}`;
    let sampler = this._samplerCache.get(key);
    if (!sampler) {
      sampler = this.gpu.createSampler({
        label: key,
        magFilter: filter === 'nearest' ? 'nearest' : 'linear',
        minFilter: filter === 'nearest' ? 'nearest' : 'linear',
        mipmapFilter: filter === 'nearest' ? 'nearest' : 'linear',
        addressModeU: wrap === 'repeat' ? 'repeat' : wrap === 'mirror' ? 'mirror-repeat' : 'clamp-to-edge',
        addressModeV: wrap === 'repeat' ? 'repeat' : wrap === 'mirror' ? 'mirror-repeat' : 'clamp-to-edge',
        compare: comparison ? 'less-equal' : undefined,
        maxAnisotropy: 1,
      });
      this._samplerCache.set(key, sampler);
    }
    return sampler;
  }

  /** Procedural textures ship without a mip chain unless the device can blit one. */
  generateMipmaps(texture) {
    void texture;
    if (!this.mipmapsEnabled) return this;
    // Mip generation is done on the CPU for procedural art (see `Texture.js` helpers), which is
    // cheaper than a compute pass for the small atlas/sprite textures this engine uploads.
    return this;
  }

  // ------------------------------------------------------------------ canvas
  resize(width, height, pixelRatio = this.pixelRatio) {
    const w = Math.max(1, Math.round(width * this.renderScale));
    const h = Math.max(1, Math.round(height * this.renderScale));
    this.pixelRatio = pixelRatio;
    if (this.canvas) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style && (this.canvas.style.width = `${width}px`);
      this.canvas.style && (this.canvas.style.height = `${height}px`);
    }
    this.width = w;
    this.height = h;
    // The swapchain is reconfigured implicitly by `getCurrentTexture()` after a canvas resize.
    this._swapchainDepth?.destroy?.();
    this._swapchainDepth = null;
    this._state.viewport = [0, 0, w, h];
    return this;
  }

  setRenderScale(scale) {
    this.renderScale = Math.max(0.25, Math.min(2, scale));
    if (this.canvas) this.resize(this.canvas.clientWidth || this.width, this.canvas.clientHeight || this.height);
    return this;
  }

  get aspect() { return this.width / Math.max(1, this.height); }
  get gl() { return null; }

  // ------------------------------------------------------------------ readback & stats
  /** Reads back a pixel. WebGPU readback is asynchronous, so this returns a Promise. */
  async readPixel(x = 0, y = 0) {
    const texture = this._swapchainTexture ?? this._pendingTarget?.colors?.[0]?.texture;
    if (!texture) return null;
    const bytesPerRow = align(4, 256);
    const buffer = this.gpu.createBuffer({ size: bytesPerRow, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.gpu.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture, origin: { x, y: this._flipY(y, 1) } },
      { buffer, bytesPerRow },
      { width: 1, height: 1 },
    );
    this.gpu.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    return data;
  }

  /** Screenshot as a data URL. Asynchronous in WebGPU; returns a Promise<string>. */
  async toDataURL() {
    const texture = this._swapchainTexture;
    if (!texture) return null;
    const bytesPerRow = align(this.width * 4, 256);
    const buffer = this.gpu.createBuffer({ size: bytesPerRow * this.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.gpu.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width: this.width, height: this.height });
    this.gpu.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8ClampedArray(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    const rgba = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i++) {
      rgba[i * 4] = pixels[i * 4 + 2];
      rgba[i * 4 + 1] = pixels[i * 4 + 1];
      rgba[i * 4 + 2] = pixels[i * 4];
      rgba[i * 4 + 3] = pixels[i * 4 + 3];
    }
    if (typeof OffscreenCanvas === 'undefined') return null;
    const offscreen = new OffscreenCanvas(this.width, this.height);
    offscreen.getContext('2d').putImageData(new ImageData(rgba, this.width, this.height), 0, 0);
    const blob = await offscreen.convertToBlob({ type: 'image/png' });
    const Reader = globalThis.FileReader;
    if (!Reader) return null;
    const reader = new Reader();
    return await new Promise((resolve) => {
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  getStats() {
    return {
      ...this._stats,
      triangles: this._resources.triangles,
      buffers: this._resources.buffers,
      textures: this._resources.textures,
      pipelines: this._stats.pipelines,
      backend: 'webgpu',
      renderer: this.caps.renderer,
    };
  }

  _syncStats() { /* per-frame counters already live in _stats */ }

  destroy() {
    this._endPass();
    this._swapchainDepth?.destroy?.();
    this._uniformBuffer?.destroy?.();
    for (const samplers of this._samplerCache.values()) samplers.destroy?.();
    this._pipelineCache.clear();
    this._bindGroupCache.clear();
    this.gpu?.destroy?.();
    this.gpu = null;
  }
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function definesKey(defines) {
  return Object.entries(defines)
    .filter(([, v]) => v !== false && v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

function textureKey(texture) {
  if (!texture) return '-';
  texture.__gpuKey ??= `t${++_textureKeyCounter}`;
  return texture.__gpuKey;
}

function topologyName(mode) {
  if (typeof mode === 'number') {
    // GL enums: 0 POINTS, 1 LINES, 3 LINE_STRIP, 4 TRIANGLES, 5 TRIANGLE_STRIP
    return ['point-list', 'line-list', 'line-strip', 'line-strip', 'triangle-list', 'triangle-strip'][mode] ?? 'triangle-list';
  }
  const value = String(mode);
  if (value === 'points') return 'point-list';
  if (value === 'lines') return 'line-list';
  if (value === 'strip') return 'line-strip';
  return value === 'triangle-strip' ? 'triangle-strip' : 'triangle-list';
}

function colorWriteMask(mask) {
  let value = 0;
  if (mask[0]) value |= 0x1;
  if (mask[1]) value |= 0x2;
  if (mask[2]) value |= 0x4;
  if (mask[3]) value |= 0x8;
  return value;
}

/**
 * Finds the buffer that feeds a shader input. Geometry attributes live in the mesh buffers; the
 * `instance*` attributes come from the instanced batch that was bound with the geometry. Missing
 * optional attributes (uv1/color) fall back to a shared zero buffer so the pipeline stays valid.
 */
function resolveAttributeBuffer(geometry, name, device) {
  const instance = geometry?.instanceBuffer ?? geometry?.instance ?? null;
  const matrixSlots = { instanceMatrix0: 0, instanceMatrix1: 16, instanceMatrix2: 32, instanceMatrix3: 48 };
  if (name in matrixSlots) {
    if (!instance?.matrixBuffer) return device._zeroVertexBuffer(16);
    return { buffer: instance.matrixBuffer, offset: 0, size: instance.capacity * 64 };
  }
  if (name === 'instanceColor') {
    return instance?.colorBuffer ? { buffer: instance.colorBuffer, size: instance.capacity * 16 } : device._zeroVertexBuffer(16);
  }
  if (name === 'instanceParams') {
    return instance?.paramBuffer ? { buffer: instance.paramBuffer, size: instance.capacity * 16 } : device._zeroVertexBuffer(16);
  }
  const entry = geometry?.buffers?.get?.(name);
  if (entry) return { buffer: entry.buffer, size: entry.byteLength };
  if (geometry?.buffers?.[name]) return geometry.buffers[name];
  const stride = vertexFormatStride(VERTEX_FORMATS[name] ?? 'float32x4');
  return device._zeroVertexBuffer(stride, geometry?.vertexCount ?? 1);
}

let _textureKeyCounter = 0;
void ATTRIBUTE_LOCATIONS;
void INDEX_FORMATS;
void WebGPUTexture;
export default WebGPUDevice;
