/**
 * OminX Engine — WebGPU resource objects.
 *
 * Mirrors the GL resource classes (`gl/GeometryBuffer.js`, `gl/Texture.js`) so the renderer can
 * treat them interchangeably: a mesh becomes vertex/index buffers, a CPU texture becomes a
 * `GPUTexture` + sampler, an instance batch becomes three instance-stepped buffers, and a render
 * target becomes a set of colour textures plus a depth texture.
 *
 * @module engine/src/renderer/webgpu/WebGPUResources
 */
import { ATTRIBUTE_LAYOUT } from '../../geometry/Mesh.js';
import { createLogger } from '../../core/Logger.js';

const log = createLogger('WebGPUResources');

/** Attribute → WGSL/vertex format mapping (matches `wgsl/index.js` entry-point declarations). */
export const VERTEX_FORMATS = {
  position: 'float32x3',
  normal: 'float32x3',
  uv: 'float32x2',
  uv1: 'float32x2',
  color: 'float32x4',
  tangent: 'float32x4',
  // WGSL has no 16-bit integer type, so bone indices are widened to uint32 at upload.
  skinIndex: 'uint32x4',
  skinWeight: 'float32x4',
  instanceMatrix0: 'float32x4',
  instanceMatrix1: 'float32x4',
  instanceMatrix2: 'float32x4',
  instanceMatrix3: 'float32x4',
  instanceColor: 'float32x4',
  instanceParams: 'float32x4',
};

export function vertexFormatStride(format) {
  const match = /^(float32|uint32|sint32|uint16)(x([234]))?$/.exec(format);
  if (!match) return 4;
  const base = match[1] === 'uint16' ? 2 : 4;
  return base * Number(match[3] ?? 1);
}

/** Picks the WebGPU texture format for an engine texture format. */
export function gpuFormat(device, format, srgb = false) {
  const name = String(format ?? 'rgba8').toLowerCase();
  switch (name) {
    case 'rgba16f':
    case 'rgba16float':
    case 'half':
      return 'rgba16float';
    case 'rgba32f':
    case 'float':
      return 'rgba32float';
    case 'depth':
    case 'depth24':
    case 'depth24plus':
      return 'depth24plus';
    case 'depth32f':
    case 'depth32float':
      return 'depth32float';
    case 'rg8':
    case 'rg':
      return 'rg8unorm';
    case 'r8':
    case 'red':
      return 'r8unorm';
    case 'rgba8':
    case 'rgba':
    default:
      // The canvas is usually bgra8unorm, but sampled/render targets use rgba8unorm.
      return srgb && device.supportsSrgbTargets ? 'rgba8unorm-srgb' : 'rgba8unorm';
  }
}

export function isDepthFormat(format) {
  return String(format).startsWith('depth');
}

/**
 * WebGPUTexture — a `GPUTexture` + cached view + sampler pair. API-compatible with the GL
 * `Texture` class for everything the renderer touches (width/height/filter/wrap/upload/destroy).
 */
export class WebGPUTexture {
  /**
   * @param {import('./WebGPUDevice.js').WebGPUDevice} device
   * @param {object} opts
   * @param {number} [opts.width] @param {number} [opts.height]
   * @param {Uint8Array|Float32Array|ElectronImageBitmap|HTMLImageElement|HTMLCanvasElement} [opts.data]
   * @param {string} [opts.format] @param {boolean} [opts.srgb]
   * @param {boolean} [opts.generateMipmaps] @param {boolean} [opts.cube]
   */
  constructor(device, opts = {}) {
    this.device = device;
    this.id = ++_textureId;
    this.name = opts.name ?? `texture_${this.id}`;
    this.opts = opts;
    this.width = opts.width ?? opts.source?.width ?? 1;
    this.height = opts.height ?? opts.source?.height ?? 1;
    this.format = gpuFormat(device, opts.format ?? 'rgba8', opts.srgb === true);
    this.srgb = opts.srgb ?? false;
    this.filter = normalizeFilter(opts.filter ?? 'linearMipmapLinear');
    this.wrap = opts.wrap ?? (opts.repeatable === false ? 'clamp' : 'repeat');
    this.anisotropy = opts.anisotropy ?? 1;
    this.generateMipmaps = opts.generateMipmaps !== false && !isDepthFormat(this.format);
    this.mipLevelCount = this.generateMipmaps ? mipLevels(this.width, this.height) : 1;
    this.cube = opts.cube === true || opts.target === 'cube';
    this.layers = opts.layers ?? 1;
    this.data = opts.data ?? null;
    this.source = opts.source ?? null;
    this.destroyed = false;
    this._build();
    if (opts.faces) this.uploadFaces(opts.faces);
    else if (opts.data || opts.source) this.upload(opts.data, { source: opts.source });
    device._resources.textures++;
    device.onRestore(() => { this.destroyed = false; this._build(); if (this.data) this.upload(this.data); });
  }

  static create(device, opts) { return device.createTexture(opts); }
  /** From a loaded HTMLImageElement / ImageBitmap / canvas. */
  static fromImage(device, image, opts = {}) {
    return device.createTexture({ width: image.width, height: image.height, source: image, ...opts });
  }

  _build() {
    const gpu = this.device.gpu;
    if (!gpu) return;
    if (this.cube) {
      this.texture = gpu.createTexture({
        size: { width: this.width, height: this.width, depthOrArrayLayers: 6 },
        format: this.format,
        dimension: '2d',
        mipLevelCount: this.mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        label: this.name,
      });
      this.view = this.texture.createView({ dimension: 'cube', mipLevelCount: this.mipLevelCount });
    } else {
      this.texture = gpu.createTexture({
        size: { width: this.width, height: this.height, depthOrArrayLayers: 1 },
        format: this.format,
        mipLevelCount: this.mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        label: this.name,
      });
      this.view = this.texture.createView({ dimension: '2d', mipLevelCount: this.mipLevelCount });
    }
    this.sampler = this.device.getSampler(this.filter, this.wrap);
  }

  /**
   * Uploads CPU pixel data. Accepts typed-array pixels, `ImageData`, images and canvases
   * (`copyExternalImageToTexture`). Signature matches the GL texture: `upload(data, {width,height})`.
   */
  upload(data = this.data, { width = this.width, height = this.height, source = null, layer = 0 } = {}) {
    if (!this.texture) return this;
    if (data) this.data = data;
    this.width = width;
    this.height = height;
    const device = this.device;
    const { bytesPerPixel } = pixelInfo(this.format);
    const image = source ?? this.source;
    if (!data && image) {
      this._uploadImage(image, layer);
      return this;
    }
    if (!data) return this;
    if (data && typeof data.width === 'number' && typeof data.height === 'number' && !ArrayBuffer.isView(data)) {
      this._uploadImage(data, layer);
      return this;
    }
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const bytesPerRow = align(width * bytesPerPixel, 256);
    const needsPaddedRow = bytesPerRow !== width * bytesPerPixel;
    const payload = needsPaddedRow ? padRows(bytes, width * bytesPerPixel, height, bytesPerRow) : bytes;
    device.queue.writeTexture(
      { texture: this.texture, mipLevel: 0, origin: { x: 0, y: 0, z: layer } },
      payload,
      { bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    return this;
  }

  _uploadImage(image, layer = 0) {
    const device = this.device;
    if (typeof device.queue.copyExternalImageToTexture !== 'function') return this;
    device.queue.copyExternalImageToTexture(
      { source: image },
      { texture: this.texture, origin: { x: 0, y: 0, z: layer }, premultipliedAlpha: false },
      { width: this.width, height: this.height },
    );
    return this;
  }

  /** Uploads the six faces of a cubemap (`opts.faces`, or 6 canvases/images). */
  uploadFaces(faces) {
    for (let face = 0; face < 6; face++) {
      const source = Array.isArray(faces) ? faces[face] : null;
      if (!source) continue;
      if (typeof this.device.queue.copyExternalImageToTexture === 'function' && typeof source.width === 'number') {
        this.device.queue.copyExternalImageToTexture(
          { source },
          { texture: this.texture, origin: { x: 0, y: 0, z: face }, premultipliedAlpha: false },
          { width: this.width, height: this.height },
        );
      } else {
        this.upload(source, { width: this.width, height: this.height, layer: face });
      }
    }
    return this;
  }

  /** Partial update — decal ring buffers and editor terrain painting use this. */
  uploadSubRegion(data, x, y, width, height, layer = 0) {
    if (!this.texture) return this;
    const { bytesPerPixel } = pixelInfo(this.format);
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.device.queue.writeTexture(
      { texture: this.texture, mipLevel: 0, origin: { x, y, z: layer } },
      bytes,
      { bytesPerRow: align(width * bytesPerPixel, 256), rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    return this;
  }

  setFilter(filter) {
    this.filter = normalizeFilter(filter);
    this.sampler = this.device.getSampler(this.filter, this.wrap);
    return this;
  }

  setWrap(wrap) {
    this.wrap = wrap;
    this.sampler = this.device.getSampler(this.filter, this.wrap);
    return this;
  }

  get handle() { return this.texture; }
  get bytes() { return this.width * this.height * pixelInfo(this.format).bytesPerPixel; }
  get target() { return this.cube ? 'cube' : '2d'; }

  resize(width, height) {
    if (width === this.width && height === this.height) return this;
    this.destroy();
    this.destroyed = false;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.mipLevelCount = this.generateMipmaps ? mipLevels(this.width, this.height) : 1;
    this._build();
    return this;
  }

  get size() { return { width: this.width, height: this.height }; }
  set size(v) { void v; }

  destroy() {
    if (this.destroyed) return;
    this.texture?.destroy();
    this.texture = null;
    this.view = null;
    this.destroyed = true;
  }
}

/**
 * WebGPURenderTarget — colour attachments (+ optional depth) with optional MSAA resolve, addressed
 * exactly like the GL `RenderTarget` (`bind(clear, color)`, `.colors`, `.depthTex`, `.resolve()`).
 */
export class WebGPURenderTarget {
  constructor(device, opts = {}) {
    this.device = device;
    this.width = opts.width ?? device.width;
    this.height = opts.height ?? device.height;
    this.format = gpuFormat(device, opts.format ?? 'rgba8', opts.srgb ?? false);
    this.count = opts.count ?? 1;
    this.depth = opts.depth !== false;
    this.depthTexture = opts.depthTexture === true;
    this.samples = Math.min(opts.samples ?? 1, device.caps.maxSamples ?? 1);
    // WebGPU cannot resolve a multisampled depth buffer into a sampleable texture, so targets
    // that need a readable depth texture run at 1 sample and rely on the FXAA pass instead.
    if (this.depthTexture && this.samples > 1) {
      log.warn(`render target "${opts.name ?? 'RenderTarget'}" requested MSAA + readable depth — running at 1 sample`);
      this.samples = 1;
    }
    this.filter = opts.filter ?? 'linear';
    this.wrap = opts.wrap ?? 'clamp';
    this.srgb = opts.srgb ?? false;
    this.name = opts.name ?? 'RenderTarget';
    this.colors = [];
    this._build();
    device._resources.fbos++;
    device.onRestore(() => { this._build(); });
  }

  static create(device, opts) { return new WebGPURenderTarget(device, opts); }

  _build() {
    const gpu = this.device.gpu;
    if (!gpu) return;
    this._destroyAttachments();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.colors = [];
    for (let i = 0; i < this.count; i++) {
      const texture = gpu.createTexture({
        size: { width: this.width, height: this.height, depthOrArrayLayers: 1 },
        format: this.format,
        sampleCount: 1,
        usage,
        label: `${this.name}_color${i}`,
      });
      const wrapper = Object.create(WebGPUTexture.prototype);
      Object.assign(wrapper, {
        device: this.device,
        id: ++_textureId,
        name: `${this.name}_color${i}`,
        width: this.width,
        height: this.height,
        format: this.format,
        srgb: this.srgb,
        filter: this.filter,
        wrap: this.wrap,
        generateMipmaps: false,
        mipLevelCount: 1,
        cube: false,
        texture,
        view: texture.createView(),
        sampler: this.device.getSampler(this.filter, this.wrap),
        destroyed: false,
        upload() { return this; },
      });
      this.colors.push(wrapper);
    }
    if (this.samples > 1) {
      this.msaaTexture = gpu.createTexture({
        size: { width: this.width, height: this.height, depthOrArrayLayers: 1 },
        format: this.format,
        sampleCount: this.samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        label: `${this.name}_msaa`,
      });
      this.msaaView = this.msaaTexture.createView();
    } else {
      this.msaaTexture = null;
      this.msaaView = null;
    }
    if (this.depth) {
      const depthFormat = this.device.depthFormat;
      this.depthTex = gpu.createTexture({
        size: { width: this.width, height: this.height, depthOrArrayLayers: 1 },
        format: depthFormat,
        sampleCount: this.samples > 1 ? this.samples : 1,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        label: `${this.name}_depth`,
      });
      this.depthView = this.depthTex.createView({ aspect: 'depth-only' });
      if (this.depthTexture) {
        const sampled = this.depthTex;
        const wrapper = Object.create(WebGPUTexture.prototype);
        Object.assign(wrapper, {
          device: this.device,
          id: ++_textureId,
          name: `${this.name}_depth`,
          width: this.width,
          height: this.height,
          format: depthFormat,
          depth: true,
          texture: sampled,
          view: sampled.createView({ aspect: 'depth-only' }),
          sampler: this.device.getSampler('nearest', 'clamp', { comparison: true }),
          destroyed: false,
          upload() { return this; },
        });
        this.depthTexRef = wrapper;
      } else {
        this.depthTexRef = null;
      }
    } else {
      this.depthView = null;
      this.depthTexRef = null;
    }
    this.view = this.colors[0]?.view ?? null;
  }

  _destroyAttachments() {
    for (const color of this.colors) color.texture?.destroy();
    this.msaaTexture?.destroy();
    this.depthTex?.destroy();
    this.depthSample?.destroy();
    this.depthView = null;
    this.depthTexRef = null;
    this.msaaTexture = null;
    this.msaaView = null;
  }

  get colorTexture() { return this.colors[0]; }
  get depthTextureRef() { return this.depthTexRef; }
  get handle() { return this; }
  set size(v) { this.resize(v, v); }
  get size() { return { width: this.width, height: this.height }; }

  /** Binds the target as the active pass, applying a clear when asked. */
  bind(clear = false, clearColor = [0, 0, 0, 0]) {
    this.device.bindFramebuffer(this);
    this.device.setViewport(0, 0, this.width, this.height);
    this.device.setScissor(null);
    if (clear) this.device.clear(clearColor, this.depth);
    return this;
  }

  /** MSAA resolve happens automatically in WebGPU at pass end; kept for API parity. */
  resolve() { return this; }

  resize(width, height) {
    if (width === this.width && height === this.height) return this;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this._build();
    return this;
  }

  destroy() { this._destroyAttachments(); }
}

/**
 * WebGPUGeometry — vertex/index buffers for a `Mesh`, re-uploaded when the CPU mesh changes.
 * `bind()` mirrors the GL VAO bind; the device resolves buffers from the *shader's* vertex inputs.
 */
export class WebGPUGeometry {
  constructor(device, mesh) {
    this.device = device;
    this.mesh = mesh;
    this.uploadedVersion = -1;
    this.indexCount = mesh.indices?.length ?? 0;
    this.vertexCount = mesh.vertexCount ?? 0;
    this.buffers = new Map();
    this.strides = new Map();
    this.byLocation = new Map();
    this.destroyed = false;
    this._build();
    device._resources.vaos++;
    device._resources.bytes += mesh.byteSize ?? 0;
    device.onRestore(() => this._build());
  }

  static create(device, mesh) { return new WebGPUGeometry(device, mesh); }

  _build() {
    const mesh = this.mesh;
    const attributeData = {
      position: mesh.positions, normal: mesh.normals, uv: mesh.uvs, uv1: mesh.uv1s,
      color: mesh.colors, tangent: mesh.tangents, skinIndex: mesh.skinIndices, skinWeight: mesh.skinWeights,
    };
    for (const [name, data] of Object.entries(attributeData)) {
      if (!data || data.length === 0) continue;
      this._uploadAttribute(name, data);
    }
    if (mesh.indices && mesh.indices.length) {
      this.indexBuffer = this.indexBuffer && this.indexBuffer.size >= mesh.indices.byteLength
        ? this.indexBuffer
        : this.device.createBuffer(mesh.indices.byteLength, GPUBufferUsage.INDEX, `${mesh.name ?? 'mesh'}_index`);
      this.device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices);
      this.indexCount = mesh.indices.length;
      this.indexFormat = 'uint32';
    } else {
      this.indexCount = 0;
    }
    this.uploadedVersion = mesh.version;
    this.vertexCount = mesh.vertexCount;
  }

  _uploadAttribute(name, data) {
    if (name === 'skinIndex' && data instanceof Uint16Array) data = new Uint32Array(data);
    const layout = ATTRIBUTE_LAYOUT[name];
    const align = layout?.type === 'uint16' ? 2 : 4;
    const byteLength = data.byteLength ?? data.length * align;
    let entry = this.buffers.get(name);
    if (!entry || entry.byteLength < byteLength) {
      entry = {
        buffer: this.device.createBuffer(byteLength, GPUBufferUsage.VERTEX, `${this.mesh.name ?? 'mesh'}_${name}`),
        byteLength,
      };
      this.buffers.set(name, entry);
    }
    this.device.queue.writeBuffer(entry.buffer, 0, data);
    this.strides.set(name, VERTEX_FORMATS[name] ? vertexFormatStride(VERTEX_FORMATS[name]) : byteLength / (this.vertexCount || 1));
  }

  /** Re-uploads when the CPU mesh version changed (destructible geometry, skinned meshes). */
  update() {
    if (this.mesh.version === this.uploadedVersion) return this;
    this._build();
    return this;
  }

  /** Geometry-level bind: remembered by the device until the next draw. */
  bind() { this.device.bindVertexArray(this); return this; }

  destroy() {
    for (const entry of this.buffers.values()) entry.buffer.destroy();
    this.indexBuffer?.destroy();
    this.buffers.clear();
    this.destroyed = true;
  }
}

/**
 * WebGPUInstanceBuffer — per-instance transforms + tint + params, uploaded straight from typed
 * arrays (the reason 4 000 trees or a wall of decals is one draw call).
 */
export class WebGPUInstanceBuffer {
  constructor(device, capacity = 512, layout = 'matrix') {
    this.device = device;
    this.capacity = capacity;
    this.count = 0;
    this.layout = layout;
    this.matrixData = new Float32Array(capacity * 16);
    this.colorData = new Float32Array(capacity * 4);
    this.paramData = new Float32Array(capacity * 4);
    this.matrixBuffer = device.createBuffer(capacity * 64, GPUBufferUsage.VERTEX, 'instanceMatrix');
    this.colorBuffer = device.createBuffer(capacity * 16, GPUBufferUsage.VERTEX, 'instanceColor');
    this.paramBuffer = device.createBuffer(capacity * 16, GPUBufferUsage.VERTEX, 'instanceParams');
    device._resources.buffers += 3;
  }

  static create(device, capacity, layout) { return new WebGPUInstanceBuffer(device, capacity, layout); }

  /** No-op on WebGPU (buffer binds are resolved per pipeline); kept for API parity. */
  attach() { return this; }

  set(index, matrix, color = null, params = null) {
    const offset = index * 16;
    const elements = matrix.elements ?? matrix;
    for (let i = 0; i < 16; i++) this.matrixData[offset + i] = elements[i];
    if (color) {
      const c = index * 4;
      this.colorData[c] = color.r ?? 1; this.colorData[c + 1] = color.g ?? 1;
      this.colorData[c + 2] = color.b ?? 1; this.colorData[c + 3] = color.a ?? 1;
    }
    if (params) {
      const p = index * 4;
      this.paramData[p] = params[0] ?? 0; this.paramData[p + 1] = params[1] ?? 0;
      this.paramData[p + 2] = params[2] ?? 0; this.paramData[p + 3] = params[3] ?? 0;
    }
  }

  setRaw(matrices, colors, params, count) {
    if (matrices) this.matrixData.set(matrices.subarray(0, count * 16));
    if (colors) this.colorData.set(colors.subarray(0, count * 4));
    if (params) this.paramData.set(params.subarray(0, count * 4));
    this.count = count;
    return this;
  }

  upload(count = this.count) {
    this.count = count;
    if (count === 0) return this;
    this.device.queue.writeBuffer(this.matrixBuffer, 0, this.matrixData, 0, count * 16);
    this.device.queue.writeBuffer(this.colorBuffer, 0, this.colorData, 0, count * 4);
    this.device.queue.writeBuffer(this.paramBuffer, 0, this.paramData, 0, count * 4);
    return this;
  }

  ensureCapacity(count) {
    if (count <= this.capacity) return this;
    let capacity = this.capacity;
    while (capacity < count) capacity *= 2;
    this.capacity = capacity;
    this.matrixData = new Float32Array(capacity * 16);
    this.colorData = new Float32Array(capacity * 4);
    this.paramData = new Float32Array(capacity * 4);
    for (const buffer of [this.matrixBuffer, this.colorBuffer, this.paramBuffer]) buffer.destroy();
    this.matrixBuffer = this.device.createBuffer(capacity * 64, GPUBufferUsage.VERTEX, 'instanceMatrix');
    this.colorBuffer = this.device.createBuffer(capacity * 16, GPUBufferUsage.VERTEX, 'instanceColor');
    this.paramBuffer = this.device.createBuffer(capacity * 16, GPUBufferUsage.VERTEX, 'instanceParams');
    return this;
  }

  destroy() {
    this.matrixBuffer.destroy();
    this.colorBuffer.destroy();
    this.paramBuffer.destroy();
  }
}

/** WebGPUDynamicBuffer — growable vertex/index stream for lines, tracers and UI quads. */
export class WebGPUDynamicBuffer {
  constructor(device, target = 'array', initialBytes = 4096) {
    this.device = device;
    this.target = target;
    this.capacity = initialBytes;
    this.byteLength = 0;
    this.usage = target === 'element' ? GPUBufferUsage.INDEX : GPUBufferUsage.VERTEX;
    this.buffer = device.createBuffer(initialBytes, this.usage, `dynamic_${target}`);
    this.data = target === 'element' ? new Uint32Array(initialBytes / 4) : new Float32Array(initialBytes / 4);
    device._resources.buffers++;
  }

  upload(view, byteLength = null) {
    const bytes = byteLength ?? view.byteLength ?? view.length * (view.BYTES_PER_ELEMENT ?? 4);
    if (bytes > this.capacity) {
      this.capacity = Math.max(bytes, this.capacity * 2);
      this.buffer.destroy();
      this.buffer = this.device.createBuffer(this.capacity, this.usage, `dynamic_${this.target}`);
    }
    this.device.queue.writeBuffer(this.buffer, 0, view, 0, bytes / (view.BYTES_PER_ELEMENT ?? 4));
    this.byteLength = bytes;
    return this;
  }

  destroy() { this.buffer.destroy(); }
}

/** Timer stub — WebGPU timing needs timestamp queries, which are optional; report zeros. */
export class WebGPUTimer {
  constructor(device) { this.device = device; this.samples = []; }
  begin() { return this; }
  end() { return this; }
  get average() { return 0; }
  destroy() { return this; }
}

/** Rounds up to a multiple of `alignment`. */
function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

/** Maps the engine's texture filter names onto the two filters WebGPU samplers expose. */
function normalizeFilter(filter) {
  const value = String(filter ?? 'linear').toLowerCase();
  if (value === 'nearest' || value === 'nearestmipmapnearest') return 'nearest';
  return 'linear';
}

/** Re-lays-out tightly packed rows into the 256-byte-aligned rows `writeTexture` requires. */
function padRows(bytes, rowBytes, rows, paddedRowBytes) {
  const out = new Uint8Array(paddedRowBytes * rows);
  for (let y = 0; y < rows; y++) {
    out.set(bytes.subarray(y * rowBytes, (y + 1) * rowBytes), y * paddedRowBytes);
  }
  return out;
}

function mipLevels(width, height) {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

function pixelInfo(format) {
  if (String(format).includes('16float')) return { bytesPerPixel: 8 };
  if (String(format).includes('32float')) return { bytesPerPixel: 16 };
  if (String(format).includes('r8unorm')) return { bytesPerPixel: 1 };
  if (String(format).includes('rg8')) return { bytesPerPixel: 2 };
  return { bytesPerPixel: 4 };
}

let _textureId = 0;
void log;
export default WebGPUGeometry;
