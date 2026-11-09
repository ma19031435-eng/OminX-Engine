/**
 * OminX Engine — textures, render targets and procedural texture generation.
 *
 * All engine textures are either generated procedurally (noise-driven concrete, metal
 * panels, camo, blood, muzzle-flash gradients, glyph atlases) or loaded from data URLs.
 * That keeps the web build tiny and means an artist can drop a PNG in the editor and
 * immediately see it applied.
 *
 * @module engine/renderer/gl/Texture
 */
import { createLogger } from '../../core/Logger.js';
import { Noise } from '../../math/Noise.js';
import { clamp01, lerp } from '../../math/MathUtils.js';

const log = createLogger('Texture');

export const TextureFormat = {
  RGBA8: 'rgba8',
  RGB8: 'rgb8',
  RGBA16F: 'rgba16f',
  RGBA32F: 'rgba32f',
  R8: 'r8',
  RG16F: 'rg16f',
  Depth: 'depth',
  DepthStencil: 'depthStencil',
};

export const TextureFilter = {
  Nearest: 'nearest',
  Linear: 'linear',
  NearestMipmapNearest: 'nearestMipmapNearest',
  LinearMipmapLinear: 'linearMipmapLinear',
};

export const TextureWrap = { Repeat: 'repeat', Clamp: 'clamp', MirroredRepeat: 'mirror' };

let _texId = 0;

export class Texture {
  /**
   * @param {import('./GLDevice.js').GLDevice} device
   * @param {object} [opts]
   * @param {number} [opts.width]
   * @param {number} [opts.height]
   * @param {string} [opts.format]
   * @param {TexImageSource|null} [opts.source] image/bitmap/canvas data
   * @param {boolean} [opts.generateMipmaps=true]
   * @param {boolean} [opts.srgb=false]
   * @param {boolean} [opts.repeatable=true]
   * @param {'2d'|'cube'|'2dArray'} [opts.target='2d']
   */
  constructor(device, opts = {}) {
    this.device = device;
    const gl = device.gl;
    this.id = ++_texId;
    this.width = opts.width ?? 1;
    this.height = opts.height ?? 1;
    this.format = opts.format ?? TextureFormat.RGBA8;
    this.filter = opts.filter ?? TextureFilter.LinearMipmapLinear;
    this.wrap = opts.wrap ?? (opts.repeatable === false ? TextureWrap.Clamp : TextureWrap.Repeat);
    this.anisotropy = opts.anisotropy ?? 1;
    this.generateMipmaps = opts.generateMipmaps !== false;
    this.srgb = opts.srgb ?? false;
    this.target = opts.target ?? '2d';
    this.layers = opts.layers ?? 1;
    this.source = opts.source ?? null;
    this.name = opts.name ?? `texture_${this.id}`;
    this.texture = gl.createTexture();
    device._resources.textures++;
    this._bindAndSetup(opts);
    device.onRestore(() => { this.texture = gl.createTexture(); this._bindAndSetup(opts); });
  }

  static create(device, opts) { return device.createTexture( opts); }
  /** From a loaded HTMLImageElement / ImageBitmap / canvas. */
  static fromImage(device, image, opts = {}) {
    return device.createTexture( {
      width: image.width, height: image.height, source: image, ...opts,
    });
  }

  _bindAndSetup(opts) {
    const gl = this.device.gl;
    const target = this.target === 'cube' ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    gl.bindTexture(target, this.texture);
    const { internal, format, type } = glFormat(this.device, this.format);
    const isDepth = this.format === TextureFormat.Depth || this.format === TextureFormat.DepthStencil;
    if (isDepth) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.width, this.height, 0, format, type, null);
    } else if (this.target === 'cube') {
      const size = this.width;
      for (let face = 0; face < 6; face++) {
        const src = Array.isArray(opts.faces) ? opts.faces[face] : null;
        if (src) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, internal, format, type, src);
        else gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, internal, size, size, 0, format, type, null);
      }
    } else if (opts.data) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.width, this.height, 0, format, type, opts.data);
    } else if (this.source && this.source.width) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, format, type, this.source);
      this.width = this.source.width;
      this.height = this.source.height;
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.width, this.height, 0, format, type, null);
    }
    this._applySampler();
    if (this.target === 'cube') {
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    const c = opts.clearColor;
    if (c) this._clearInitial(c);
  }

  _clearInitial(color) {
    const gl = this.device.gl;
    void color;
    void gl;
  }

  _applySampler() {
    const gl = this.device.gl;
    const target = this.target === 'cube' ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    const min = this.generateMipmaps && this.filter !== TextureFilter.Nearest ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR;
    let mag = gl.LINEAR;
    if (this.filter === TextureFilter.Nearest || this.filter === TextureFilter.NearestMipmapNearest) { mag = gl.NEAREST; }
    let minFilter = min;
    if (this.filter === TextureFilter.Nearest) minFilter = gl.NEAREST;
    else if (this.filter === TextureFilter.NearestMipmapNearest) minFilter = gl.NEAREST_MIPMAP_NEAREST;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, minFilter === gl.LINEAR_MIPMAP_LINEAR && !this.generateMipmaps ? gl.LINEAR : minFilter);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, mag);
    const wrapS = this.wrap === TextureWrap.Clamp ? gl.CLAMP_TO_EDGE : this.wrap === TextureWrap.MirroredRepeat ? gl.MIRRORED_REPEAT : gl.REPEAT;
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrapS);
    const anisoExt = this.device.extensions.EXT_texture_filter_anisotropic;
    if (anisoExt && this.anisotropy > 1) {
      gl.texParameterf(target, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(this.anisotropy, this.device.caps.maxAnisotropy));
    }
    if (this.generateMipmaps && this.target !== 'cube' && !isDepthFormat(this.format)) gl.generateMipmap(target);
  }

  upload(data, { width = this.width, height = this.height } = {}) {
    const gl = this.device.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const { internal, format, type } = glFormat(this.device, this.format);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    if (this.generateMipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    this.width = width; this.height = height;
    return this;
  }
  /** Partial update — used by the decal ring buffer and editor terrain painting. */
  uploadSubRegion(data, x, y, w, h) {
    const gl = this.device.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const { format, type } = glFormat(this.device, this.format);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, format, type, data);
    return this;
  }
  setFilter(filter) {
    this.filter = filter;
    this._bindAndSetup({});
    return this;
  }
  setWrap(wrap) { this.wrap = wrap; this._bindAndSetup({}); return this; }
  get handle() { return this.texture; }
  get bytes() { return this.width * this.height * 4; }
  destroy() {
    this.device.gl.deleteTexture(this.texture);
    this.texture = null;
  }
}

function isDepthFormat(f) { return f === TextureFormat.Depth || f === TextureFormat.DepthStencil; }

export function glFormat(device, format) {
  const gl = device.gl;
  switch (format) {
    case TextureFormat.RGBA16F: return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    case TextureFormat.RGBA32F: return { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
    case TextureFormat.RGB8: return { internal: gl.RGB8, format: gl.RGB, type: gl.UNSIGNED_BYTE };
    case TextureFormat.R8: return { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE };
    case TextureFormat.RG16F: return { internal: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT };
    case TextureFormat.Depth: return { internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT };
    case TextureFormat.DepthStencil: return { internal: gl.DEPTH24_STENCIL8, format: gl.DEPTH_STENCIL, type: gl.UNSIGNED_INT_24_8 };
    default: return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  }
}

// ---------------------------------------------------------------------------
// Render targets
// ---------------------------------------------------------------------------
/**
 * RenderTarget — an offscreen framebuffer with optional depth, MRT color attachments, MSAA.
 * The renderer uses these for the shadow cascade atlas, the HDR scene buffer, bloom mips,
 * the SSAO buffer and the editor's picking buffer.
 */
export class RenderTarget {
  constructor(device, opts = {}) {
    this.device = device;
    const gl = device.gl;
    this.width = opts.width ?? device.width;
    this.height = opts.height ?? device.height;
    this.format = opts.format ?? TextureFormat.RGBA8;
    this.count = opts.count ?? 1;
    this.depth = opts.depth !== false;
    this.depthTexture = opts.depthTexture === true;
    this.samples = opts.samples ?? 0;
    this.filter = opts.filter ?? TextureFilter.Linear;
    this.wrap = opts.wrap ?? TextureWrap.Clamp;
    this.srgb = opts.srgb ?? false;
    this.name = opts.name ?? 'RenderTarget';
    this.colors = [];
    this.renderbuffer = null;
    this.msaaColor = null;
    this.msaaDepth = null;
    this.framebuffer = gl.createFramebuffer();
    device._resources.fbos++;
    this._build();
    device.onRestore(() => {
      this.framebuffer = gl.createFramebuffer();
      this._build();
    });
  }
  static create(device, opts) { return new RenderTarget(device, opts); }

  _build() {
    const gl = this.device.gl;
    this.colors = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    const attachments = [];
    for (let i = 0; i < this.count; i++) {
      const tex = new Texture(this.device, {
        width: this.width, height: this.height, format: this.format,
        generateMipmaps: false, filter: this.filter, wrap: this.wrap, srgb: this.srgb,
        name: `${this.name}_color${i}`,
      });
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex.texture, 0);
      this.colors.push(tex);
      attachments.push(gl.COLOR_ATTACHMENT0 + i);
    }
    if (this.samples > 1) {
      // Multisampled renderbuffers; resolved into the color textures on demand.
      this.msaaColor = this.colors.map((_, i) => {
        void i;
        const rb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        const { internal } = glFormat(this.device, this.format);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, Math.min(this.samples, this.device.caps.maxSamples), internal, this.width, this.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
        return rb;
      });
    }
    if (this.depth) {
      if (this.depthTexture) {
        this.depthTex = new Texture(this.device, {
          width: this.width, height: this.height, format: TextureFormat.Depth,
          generateMipmaps: false, filter: TextureFilter.Nearest, wrap: TextureWrap.Clamp, name: `${this.name}_depth`,
        });
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTex.texture, 0);
      } else {
        this.renderbuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.renderbuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.width, this.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.renderbuffer);
      }
    }
    if (this.count > 1) gl.drawBuffers(attachments);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      log.error(`framebuffer "${this.name}" incomplete (0x${status.toString(16)}) — falling back to 8-bit RGBA`);
      if (this.format !== TextureFormat.RGBA8) {
        this.format = TextureFormat.RGBA8;
        this._build();
        return;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.device._state.fbo);
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return this;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    const gl = this.device.gl;
    for (const c of this.colors) c.destroy();
    this.colors = [];
    if (this.depthTex) { this.depthTex.destroy(); this.depthTex = null; }
    if (this.renderbuffer) { gl.deleteRenderbuffer(this.renderbuffer); this.renderbuffer = null; }
    if (this.msaaColor) { for (const rb of this.msaaColor) gl.deleteRenderbuffer(rb); this.msaaColor = null; }
    this._build();
    return this;
  }

  bind(clear = false, clearColor = [0, 0, 0, 0]) {
    const gl = this.device.gl;
    this.device.bindFramebuffer(this);
    this.device.setViewport(0, 0, this.width, this.height);
    this.device.setScissor(null);
    if (clear) this.device.clear(clearColor, this.depth);
    return this;
  }
  /** Resolves MSAA into the sampled texture (no-op when samples === 1). */
  resolve() {
    if (this.samples <= 1 || !this.msaaColor) return this;
    const gl = this.device.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFramebuffer ?? this.framebuffer);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    return this;
  }
  get colorTexture() { return this.colors[0]; }
  get depthTextureRef() { return this.depthTex; }
  get handle() { return this.framebuffer; }
  set size(v) { this.resize(v, v); }
  get size() { return { width: this.width, height: this.height }; }
  destroy() {
    const gl = this.device.gl;
    for (const c of this.colors) c.destroy();
    this.colors = [];
    if (this.depthTex) this.depthTex.destroy();
    if (this.renderbuffer) gl.deleteRenderbuffer(this.renderbuffer);
    if (this.msaaColor) for (const rb of this.msaaColor) gl.deleteRenderbuffer(rb);
    gl.deleteFramebuffer(this.framebuffer);
  }
}

// ---------------------------------------------------------------------------
// Procedural texture library — the FPS art kit
// ---------------------------------------------------------------------------
/**
 * ProceduralTexture — paints into an OffscreenCanvas/2D context at load time then uploads.
 * Every surface in the game (concrete, brick, sandbag, metal, camo, blood, glass, dirt)
 * is generated here so the engine has zero binary dependencies.
 */
export class ProceduralTexture {
  constructor(size = 256, name = 'procedural') {
    this.size = size;
    this.name = name;
    this.canvas = createCanvas(size, size);
    this.ctx = this.canvas.getContext('2d');
  }
  static create(size, name) { return new ProceduralTexture(size, name); }
  fill(color) { this.ctx.fillStyle = color; this.ctx.fillRect(0, 0, this.size, this.size); return this; }
  noise(amount = 0.08, scale = 4, seed = 1, colored = false) {
    const n = new Noise(seed);
    const img = this.ctx.getImageData(0, 0, this.size, this.size);
    const d = img.data;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const i = (y * this.size + x) * 4;
        const v = n.fbm2(x / this.size * scale, y / this.size * scale, 4) * amount;
        if (colored) {
          d[i] = clamp01(d[i] / 255 + v * 0.5 + n.simplex2(x / 23, y / 31) * amount) * 255;
          d[i + 1] = clamp01(d[i + 1] / 255 + v) * 255;
          d[i + 2] = clamp01(d[i + 2] / 255 + v * 1.2 - 0.1) * 255;
        } else {
          d[i] = clamp01((d[i] / 255) * (1 + v)) * 255;
          d[i + 1] = clamp01((d[i + 1] / 255) * (1 + v)) * 255;
          d[i + 2] = clamp01((d[i + 2] / 255) * (1 + v)) * 255;
        }
      }
    }
    this.ctx.putImageData(img, 0, 0);
    return this;
  }
  /** Multi-octave value noise as a height/roughness map. */
  heightNoise(scale = 6, octaves = 4, seed = 7, contrast = 1) {
    const n = new Noise(seed);
    const img = this.ctx.createImageData(this.size, this.size);
    const d = img.data;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const i = (y * this.size + x) * 4;
        const v = clamp01((n.fbm2(x / this.size * scale, y / this.size * scale, octaves) * 0.5 + 0.5));
        const val = clamp01((v - 0.5) * contrast + 0.5) * 255;
        d[i] = d[i + 1] = d[i + 2] = val;
        d[i + 3] = 255;
      }
    }
    this.ctx.putImageData(img, 0, 0);
    return this;
  }
  rect(x, y, w, h, color) { this.ctx.fillStyle = color; this.ctx.fillRect(x, y, w, h); return this; }
  strokeRect(x, y, w, h, color, lineWidth = 1) {
    this.ctx.strokeStyle = color; this.ctx.lineWidth = lineWidth;
    this.ctx.strokeRect(x, y, w, h);
    return this;
  }
  line(x0, y0, x1, y1, color, width = 1) {
    this.ctx.strokeStyle = color; this.ctx.lineWidth = width;
    this.ctx.beginPath(); this.ctx.moveTo(x0, y0); this.ctx.lineTo(x1, y1); this.ctx.stroke();
    return this;
  }
  circle(x, y, r, color) {
    this.ctx.fillStyle = color; this.ctx.beginPath(); this.ctx.arc(x, y, r, 0, Math.PI * 2); this.ctx.fill();
    return this;
  }
  radialGradient(x, y, r, stops) {
    const g = this.ctx.createRadialGradient(x, y, 0, x, y, r);
    for (const [pos, color] of stops) g.addColorStop(pos, color);
    this.ctx.fillStyle = g;
    this.ctx.fillRect(x - r, y - r, r * 2, r * 2);
    return this;
  }
  linearGradient(x0, y0, x1, y1, stops) {
    const g = this.ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [pos, color] of stops) g.addColorStop(pos, color);
    return g;
  }
  grid(cell = 32, color = 'rgba(255,255,255,0.06)', thickness = 1) {
    for (let i = 0; i <= this.size; i += cell) {
      this.line(i, 0, i, this.size, color, thickness);
      this.line(0, i, this.size, i, color, thickness);
    }
    return this;
  }
  grunge(count = 60, alpha = 0.08, seed = 3) {
    const n = new Noise(seed);
    for (let i = 0; i < count; i++) {
      const x = n.simplex2(i * 1.7, 3.3) * 0.5 + 0.5;
      const y = n.simplex2(i * 2.3, 7.1) * 0.5 + 0.5;
      const r = (n.simplex2(i * 0.7, 11.3) * 0.5 + 0.5) * this.size * 0.2 + 4;
      this.circle(x * this.size, y * this.size, r, `rgba(0,0,0,${alpha})`);
    }
    return this;
  }
  /** Bakes the canvas into a GPU texture. */
  toTexture(device, opts = {}) {
    return device.createTexture( {
      width: this.size, height: this.size,
      source: this.canvas,
      generateMipmaps: opts.generateMipmaps !== false,
      srgb: opts.srgb ?? true,
      name: opts.name ?? this.name,
      repeatable: opts.repeatable !== false,
    });
  }
  /** Returns the canvas so sub-generators can composite into it before upload. */
  get image() { return this.canvas; }
}

function createCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  // Headless fallback: minimal stub so the engine can be exercised in Node tests.
  return {
    width: w, height: h,
    getContext() {
      const data = new Uint8ClampedArray(w * h * 4);
      const noop = () => {};
      return {
        canvas: this,
        fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
        font: '10px monospace', textAlign: 'left', textBaseline: 'alphabetic',
        fillRect: noop, strokeRect: noop, clearRect: noop, beginPath: noop, closePath: noop,
        moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop, ellipse: noop,
        stroke: noop, fill: noop, arc: noop, clip: noop, setTransform: noop, transform: noop,
        fillText: noop, strokeText: noop, measureText: () => ({ width: 0 }),
        createImageData: () => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        getImageData: () => ({ data, width: w, height: h }),
        putImageData: noop,
        createRadialGradient: () => ({ addColorStop: noop }),
        createLinearGradient: () => ({ addColorStop: noop }),
        drawImage: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
        globalAlpha: 1, globalCompositeOperation: 'source-over',
      };
    },
    toDataURL: () => '',
  };
}

/**
 * All engine art, generated at startup. `generateTextureKit(device)` returns a map of
 * ready-to-use textures keyed by material name.
 */
export function generateTextureKit(device, { size = 256, hq = false } = {}) {
  const S = hq ? size * 2 : size;
  const kit = {};

  // --- concrete / urban
  const concrete = new ProceduralTexture(S, 'concrete');
  concrete.fill('#8a8d8f');
  concrete.noise(0.16, 8, 11);
  concrete.grunge(50, 0.05, 21);
  kit.concrete = concrete.toTexture(device);
  kit.concreteNormal = heightToNormalTexture(device, concrete, 1.4, 'concreteNormal');

  const concreteDark = new ProceduralTexture(S, 'concreteDark');
  concreteDark.fill('#5c6063');
  concreteDark.noise(0.2, 10, 31);
  concreteDark.grunge(60, 0.07, 41);
  kit.concreteDark = concreteDark.toTexture(device);

  // --- brick
  const brick = new ProceduralTexture(S, 'brick');
  brick.fill('#6f3b32');
  const bw = S / 4, bh = S / 8;
  for (let row = 0; row < 8; row++) {
    const offset = (row % 2) * bw * 0.5;
    for (let col = -1; col < 5; col++) {
      const x = col * bw + offset;
      const shade = 0.85 + Math.random() * 0.3;
      brick.rect(x + 2, row * bh + 2, bw - 4, bh - 4, `rgb(${Math.floor(122 * shade)}, ${Math.floor(58 * shade)}, ${Math.floor(48 * shade)})`);
    }
  }
  brick.fill('#4a4744');
  brick.ctx.globalCompositeOperation = 'destination-over';
  brick.ctx.fillRect(0, 0, S, S);
  brick.ctx.globalCompositeOperation = 'source-over';
  brick.noise(0.1, 12, 51);
  kit.brick = brick.toTexture(device);

  // --- metal panel (shipping containers, doors)
  const metal = new ProceduralTexture(S, 'metal');
  metal.fill('#7c8288');
  metal.noise(0.1, 6, 61);
  for (let x = 0; x < S; x += S / 16) metal.line(x, 0, x, S, 'rgba(0,0,0,0.16)', 2);
  for (let x = S / 32; x < S; x += S / 16) metal.line(x, 0, x, S, 'rgba(255,255,255,0.07)', 1);
  metal.grunge(30, 0.09, 71);
  kit.metal = metal.toTexture(device);
  kit.metalNormal = heightToNormalTexture(device, metal, 1.0, 'metalNormal');

  // --- rusted metal
  const rust = new ProceduralTexture(S, 'rust');
  rust.fill('#8a5a3c');
  rust.noise(0.3, 14, 81, true);
  rust.grunge(80, 0.12, 91);
  kit.rust = rust.toTexture(device);

  // --- wood (crates)
  const wood = new ProceduralTexture(S, 'wood');
  wood.fill('#9c6b3f');
  for (let y = 0; y < S; y += 4) {
    const v = 0.8 + Math.sin(y * 0.3) * 0.1 + Math.random() * 0.15;
    wood.rect(0, y, S, 3, `rgb(${Math.floor(156 * v)}, ${Math.floor(107 * v)}, ${Math.floor(63 * v)})`);
  }
  wood.noise(0.12, 20, 101);
  for (let i = 0; i < 6; i++) wood.circle(Math.random() * S, Math.random() * S, 3 + Math.random() * 4, 'rgba(80,50,25,0.5)');
  kit.wood = wood.toTexture(device);

  // --- sandbag
  const sandbag = new ProceduralTexture(S, 'sandbag');
  sandbag.fill('#9a8f6a');
  sandbag.noise(0.22, 26, 111);
  for (let i = 0; i < 120; i++) {
    sandbag.line(Math.random() * S, Math.random() * S, Math.random() * S, Math.random() * S, 'rgba(120,110,80,0.12)', 1);
  }
  kit.sandbag = sandbag.toTexture(device);

  // --- rock / dirt ground
  const dirt = new ProceduralTexture(S, 'dirt');
  dirt.fill('#5f5546');
  dirt.noise(0.24, 10, 121, true);
  dirt.grunge(70, 0.08, 131);
  kit.dirt = dirt.toTexture(device);
  kit.dirtNormal = heightToNormalTexture(device, dirt, 1.8, 'dirtNormal');

  const rock = new ProceduralTexture(S, 'rock');
  rock.fill('#6d6a66');
  rock.noise(0.3, 12, 141);
  rock.heightNoise(9, 5, 151, 1.4);
  rock.grunge(40, 0.1, 161);
  kit.rock = rock.toTexture(device);

  // --- grass / foliage
  const grass = new ProceduralTexture(S, 'grass');
  grass.fill('#3f5c2c');
  grass.noise(0.35, 22, 171, true);
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    grass.line(x, y, x + (Math.random() - 0.5) * 3, y - 3 - Math.random() * 4, `rgba(${60 + Math.random() * 60}, ${110 + Math.random() * 70}, ${40 + Math.random() * 40}, 0.5)`, 1);
  }
  kit.grass = grass.toTexture(device);

  const foliage = new ProceduralTexture(S, 'foliage');
  foliage.fill('#41622f');
  foliage.noise(0.4, 28, 181, true);
  kit.foliage = foliage.toTexture(device);
  kit.foliageAlpha = makeFoliageAlpha(device, S);

  // --- tactical camo (player + bot uniforms, weapon skins)
  kit.camoGreen = makeCamo(device, S, ['#3f4a33', '#2c3427', '#5a6348', '#1f2419'], 191);
  kit.camoDesert = makeCamo(device, S, ['#8c7b5a', '#6d5f45', '#a89a78', '#4f4632'], 211);
  kit.camoUrban = makeCamo(device, S, ['#5a5f66', '#3d4249', '#767c84', '#2a2e33'], 221);
  kit.camoRed = makeCamo(device, S, ['#6a3232', '#4a2222', '#8a4a44', '#331616'], 231);
  kit.camoBlue = makeCamo(device, S, ['#2f4a6a', '#213550', '#405f80', '#16233a'], 241);

  // --- skin (hands, faces) — deliberately stylized, reads well through a viewmodel camera
  const skin = new ProceduralTexture(S, 'skin');
  skin.fill('#c08a63');
  skin.noise(0.06, 8, 251);
  kit.skin = skin.toTexture(device);

  // --- blood splatter / impact decals (decal atlas)
  kit.decals = makeDecalAtlas(device, hq ? 1024 : 512);

  // --- muzzle flash (additive, animated across frames in the atlas)
  kit.muzzleFlash = makeMuzzleFlashAtlas(device, hq ? 512 : 256);

  // --- smoke / dust / spark particles
  kit.smoke = makeParticleSprite(device, S, 'smoke');
  kit.spark = makeParticleSprite(device, S, 'spark');
  kit.blood = makeParticleSprite(device, S, 'blood');
  kit.dust = makeParticleSprite(device, S, 'dust');

  // --- tracers & glow
  kit.tracer = makeTracerTexture(device, S);
  kit.glow = makeGlowTexture(device, S);
  kit.ring = makeRingTexture(device, S);

  // --- glass
  const glass = new ProceduralTexture(S, 'glass');
  glass.fill('rgba(180,215,225,0.18)');
  for (let i = 0; i < 14; i++) glass.line(0, Math.random() * S, S, Math.random() * S, 'rgba(255,255,255,0.05)', 2);
  kit.glass = glass.toTexture(device);

  // --- hazard / caution stripes
  const hazard = new ProceduralTexture(S, 'hazard');
  hazard.fill('#d8a418');
  for (let i = -S; i < S * 2; i += S / 6) {
    hazard.ctx.save();
    hazard.ctx.translate(i, 0);
    hazard.ctx.rotate(-Math.PI / 4);
    hazard.ctx.fillStyle = '#1a1a1a';
    hazard.ctx.fillRect(0, -S, S / 12, S * 3);
    hazard.ctx.restore();
  }
  hazard.noise(0.08, 6, 261);
  kit.hazard = hazard.toTexture(device);

  // --- UI/editor support textures
  kit.checker = makeChecker(device, 128);
  kit.white = makeSolid(device, '#ffffff');
  kit.black = makeSolid(device, '#000000');
  kit.gradient = makeGradientLUT(device);

  return kit;
}

/** Sobel height→normal conversion so procedural surfaces get real lighting response. */
export function heightToNormalTexture(device, procTex, strength = 1, name = 'normal') {
  const S = procTex.size;
  const ctx = procTex.ctx;
  const img = ctx.getImageData(0, 0, S, S);
  const src = img.data;
  const out = ctx.createImageData(S, S);
  const d = out.data;
  const at = (x, y) => {
    const xx = (x + S) % S, yy = (y + S) % S;
    const i = (yy * S + xx) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const l = at(x - 1, y), r = at(x + 1, y), u = at(x, y - 1), dn = at(x, y + 1);
      let nx = (l - r) * strength;
      let ny = (dn - u) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len;
      const i = (y * S + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const tex = new ProceduralTexture(S, name);
  tex.ctx.putImageData(out, 0, 0);
  return device.createTexture( { width: S, height: S, source: tex.image, srgb: false, name, repeatable: true });
}

function makeCamo(device, S, colors, seed) {
  const t = new ProceduralTexture(S, 'camo');
  t.fill(colors[0]);
  const n = new Noise(seed);
  const blobs = 90;
  for (let i = 0; i < blobs; i++) {
    const cx = n.simplex2(i * 1.3, 5.5) * 0.5 + 0.5;
    const cy = n.simplex2(i * 2.1, 9.1) * 0.5 + 0.5;
    const r = (n.simplex2(i * 0.5, 2.2) * 0.5 + 0.5) * S * 0.09 + S * 0.02;
    const color = colors[1 + Math.floor((n.simplex2(i * 3.3, 1.7) * 0.5 + 0.5) * (colors.length - 1))];
    t.ctx.save();
    t.ctx.translate(cx * S, cy * S);
    t.ctx.rotate(n.simplex2(i, 4) * Math.PI);
    t.ctx.fillStyle = color;
    t.ctx.beginPath();
    const pts = 7;
    for (let p = 0; p < pts; p++) {
      const a = (p / pts) * Math.PI * 2;
      const rr = r * (0.6 + (n.simplex2(i + p * 0.7, p) * 0.5 + 0.5) * 0.8);
      t.ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    t.ctx.closePath();
    t.ctx.fill();
    t.ctx.restore();
  }
  t.noise(0.16, 30, seed + 1);
  return t.toTexture(device);
}

function makeFoliageAlpha(device, S) {
  const t = new ProceduralTexture(S, 'foliageAlpha');
  t.fill('#000000');
  const n = new Noise(4242);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = n.fbm2(x / S * 14, y / S * 14, 4) * 0.5 + 0.5;
      if (v > 0.52) t.rect(x, y, 1, 1, 'rgba(255,255,255,1)');
    }
  }
  return t.toTexture(device);
}

/**
 * Decal atlas — a 4×4 grid of bullet holes, blood splatters, scorch marks, bullet impacts
 * on metal, glass cracks and blood pools. The decal system picks a cell by impact material.
 */
export function makeDecalAtlas(device, S = 512) {
  const t = new ProceduralTexture(S, 'decals');
  t.fill('rgba(0,0,0,0)');
  t.ctx.clearRect(0, 0, S, S);
  const cell = S / 4;
  const cells = [
    // 0: bullet hole in concrete
    (c) => {
      c.radialGradient(cell / 2, cell / 2, cell * 0.45, [
        [0, 'rgba(20,18,16,0.95)'], [0.35, 'rgba(45,42,38,0.7)'], [0.7, 'rgba(120,115,105,0.28)'], [1, 'rgba(150,145,135,0)'],
      ]);
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2, r = cell * 0.1 + Math.random() * cell * 0.3;
        c.line(cell / 2, cell / 2, cell / 2 + Math.cos(a) * r, cell / 2 + Math.sin(a) * r, 'rgba(30,28,25,0.5)', 1 + Math.random());
      }
      c.circle(cell / 2, cell / 2, cell * 0.055, 'rgba(10,8,6,1)');
    },
    // 1: blood splatter
    (c) => {
      c.radialGradient(cell / 2, cell / 2, cell * 0.48, [
        [0, 'rgba(120,10,12,0.95)'], [0.45, 'rgba(90,8,10,0.6)'], [1, 'rgba(60,5,6,0)'],
      ]);
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * cell * 0.45;
        c.circle(cell / 2 + Math.cos(a) * r, cell / 2 + Math.sin(a) * r, 1 + Math.random() * 5, `rgba(${90 + Math.random() * 50}, 8, 10, ${0.35 + Math.random() * 0.5})`);
      }
    },
    // 2: scorch / explosion mark
    (c) => {
      c.radialGradient(cell / 2, cell / 2, cell * 0.5, [
        [0, 'rgba(0,0,0,0.9)'], [0.5, 'rgba(15,12,10,0.6)'], [0.85, 'rgba(40,35,30,0.25)'], [1, 'rgba(60,55,50,0)'],
      ]);
    },
    // 3: metal impact with exposed steel
    (c) => {
      c.radialGradient(cell / 2, cell / 2, cell * 0.4, [
        [0, 'rgba(30,30,32,0.95)'], [0.4, 'rgba(150,150,155,0.55)'], [0.8, 'rgba(190,190,195,0.2)'], [1, 'rgba(200,200,205,0)'],
      ]);
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * Math.PI * 2, r = cell * 0.12 + Math.random() * cell * 0.28;
        c.line(cell / 2, cell / 2, cell / 2 + Math.cos(a) * r, cell / 2 + Math.sin(a) * r, 'rgba(210,210,215,0.45)', 1);
      }
    },
    // 4: blood pool (ground)
    (c) => {
      c.radialGradient(cell / 2, cell / 2, cell * 0.5, [
        [0, 'rgba(105,8,10,0.9)'], [0.55, 'rgba(75,6,8,0.7)'], [0.9, 'rgba(50,4,5,0.3)'], [1, 'rgba(40,4,4,0)'],
      ]);
    },
    // 5: glass crack
    (c) => {
      c.circle(cell / 2, cell / 2, cell * 0.03, 'rgba(230,240,245,0.9)');
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + Math.random() * 0.3;
        let x = cell / 2, y = cell / 2;
        let len = cell * 0.15 + Math.random() * cell * 0.3;
        for (let seg = 0; seg < 3; seg++) {
          const nx = x + Math.cos(a + (Math.random() - 0.5) * 0.8) * (len / 3);
          const ny = y + Math.sin(a + (Math.random() - 0.5) * 0.8) * (len / 3);
          c.line(x, y, nx, ny, 'rgba(235,245,250,0.55)', 1);
          x = nx; y = ny;
        }
      }
      for (let i = 0; i < 5; i++) {
        const a = Math.random() * Math.PI * 2, r = cell * 0.1 + Math.random() * cell * 0.3;
        c.circle(cell * 0.5 + Math.cos(a) * r, cell * 0.5 + Math.sin(a) * r, 12 + Math.random() * 14, 'rgba(230,240,245,0.12)');
      }
    },
    // 6: sand/gravel impact
    (c) => {
      c.radialGradient(cell / 2, cell / 2, cell * 0.42, [
        [0, 'rgba(60,52,40,0.85)'], [0.4, 'rgba(120,105,80,0.5)'], [1, 'rgba(150,135,105,0)'],
      ]);
      for (let i = 0; i < 30; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * cell * 0.4;
        c.circle(cell / 2 + Math.cos(a) * r, cell / 2 + Math.sin(a) * r, 1 + Math.random() * 2, `rgba(${140 + Math.random() * 40}, ${125 + Math.random() * 35}, ${95 + Math.random() * 30}, 0.6)`);
      }
    },
    // 7: wood impact
    (c) => {
      c.radialGradient(cell / 2, cell / 2, cell * 0.35, [
        [0, 'rgba(50,32,18,0.9)'], [0.5, 'rgba(100,70,40,0.55)'], [1, 'rgba(130,95,55,0)'],
      ]);
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2, r = cell * 0.08 + Math.random() * cell * 0.3;
        c.line(cell / 2, cell / 2, cell / 2 + Math.cos(a) * r, cell / 2 + Math.sin(a) * r, 'rgba(70,48,26,0.6)', 1 + Math.random() * 2);
      }
    },
  ];
  for (let i = 0; i < cells.length; i++) {
    const cx = (i % 4) * cell;
    const cy = Math.floor(i / 4) * cell;
    t.ctx.save();
    t.ctx.translate(cx, cy);
    cells[i](t);
    t.ctx.restore();
  }
  return t.toTexture(device, { name: 'decals', generateMipmaps: true, srgb: true });
}

/** 8-frame animated muzzle flash in a 4×2 atlas (UV scrolled by the viewmodel FX system). */
export function makeMuzzleFlashAtlas(device, S = 256) {
  const t = new ProceduralTexture(S, 'muzzleFlash');
  t.ctx.clearRect(0, 0, S, S);
  const cell = S / 4;
  for (let i = 0; i < 8; i++) {
    const cx = (i % 4) * cell;
    const cy = Math.floor(i / 4) * cell * 2;
    t.ctx.save();
    t.ctx.translate(cx, cy);
    const scale = 0.75 + (i % 3) * 0.12;
    // core
    t.radialGradient(cell / 2, cell / 2 * 1.0, cell * 0.5 * scale, [
      [0, 'rgba(255,255,240,1)'],
      [0.18, 'rgba(255,226,150,0.95)'],
      [0.42, 'rgba(255,150,40,0.6)'],
      [0.75, 'rgba(180,60,10,0.18)'],
      [1, 'rgba(120,30,0,0)'],
    ]);
    // star spikes
    for (let s = 0; s < 6; s++) {
      const a = (s / 6) * Math.PI * 2 + i * 0.3;
      const len = cell * (0.3 + (i % 4) * 0.06);
      t.line(cell / 2, cell / 2, cell / 2 + Math.cos(a) * len, cell / 2 + Math.sin(a) * len, 'rgba(255,215,140,0.5)', 3 + (i % 3));
    }
    t.ctx.restore();
  }
  return t.toTexture(device, { name: 'muzzleFlash' });
}

export function makeParticleSprite(device, S, kind) {
  const t = new ProceduralTexture(S, kind);
  t.ctx.clearRect(0, 0, S, S);
  const useNoise = kind === 'smoke' || kind === 'dust';
  if (useNoise) {
    t.radialGradient(S / 2, S / 2, S / 2, [
      [0, 'rgba(255,255,255,0.85)'],
      [0.35, 'rgba(255,255,255,0.45)'],
      [0.7, 'rgba(255,255,255,0.14)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
    t.ctx.globalCompositeOperation = 'destination-in';
    const n = new Noise(kind === 'smoke' ? 777 : 999);
    const img = t.ctx.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const v = n.fbm2(x / S * 5, y / S * 5, 4) * 0.5 + 0.5;
        const rad = 1 - Math.min(1, Math.hypot(x - S / 2, y - S / 2) / (S / 2));
        d[i + 3] = clamp01(d[i + 3] / 255 * (1 - v) * 1.6 * rad) * 255;
      }
    }
    t.ctx.putImageData(img, 0, 0);
    t.ctx.globalCompositeOperation = 'source-over';
  } else if (kind === 'spark') {
    t.radialGradient(S / 2, S / 2, S / 2, [
      [0, 'rgba(255,255,255,1)'],
      [0.15, 'rgba(255,230,160,0.9)'],
      [0.5, 'rgba(255,150,50,0.35)'],
      [1, 'rgba(255,80,0,0)'],
    ]);
  } else if (kind === 'blood') {
    t.radialGradient(S / 2, S / 2, S / 2, [
      [0, 'rgba(150,12,14,1)'],
      [0.6, 'rgba(105,8,10,0.8)'],
      [1, 'rgba(70,5,6,0)'],
    ]);
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * S * 0.45;
      t.circle(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 1 + Math.random() * 3, 'rgba(90,6,8,0.6)');
    }
  }
  return t.toTexture(device, { name: kind });
}

export function makeTracerTexture(device, S = 128) {
  const t = new ProceduralTexture(S, 'tracer');
  t.ctx.clearRect(0, 0, S, S);
  const g = t.ctx.createLinearGradient(0, 0, S, 0);
  g.addColorStop(0, 'rgba(255,220,150,0)');
  g.addColorStop(0.35, 'rgba(255,220,150,0.55)');
  g.addColorStop(0.75, 'rgba(255,245,210,1)');
  g.addColorStop(0.92, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  t.ctx.fillStyle = g;
  t.ctx.fillRect(0, S * 0.38, S, S * 0.24);
  return t.toTexture(device, { name: 'tracer' });
}

export function makeGlowTexture(device, S = 128) {
  const t = new ProceduralTexture(S, 'glow');
  t.ctx.clearRect(0, 0, S, S);
  t.radialGradient(S / 2, S / 2, S / 2, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
  return t.toTexture(device, { name: 'glow' });
}

export function makeRingTexture(device, S = 128) {
  const t = new ProceduralTexture(S, 'ring');
  t.ctx.clearRect(0, 0, S, S);
  t.ctx.strokeStyle = 'rgba(255,255,255,1)';
  t.ctx.lineWidth = S * 0.06;
  t.ctx.beginPath();
  t.ctx.arc(S / 2, S / 2, S * 0.4, 0, Math.PI * 2);
  t.ctx.stroke();
  return t.toTexture(device, { name: 'ring' });
}

export function makeChecker(device, S = 128) {
  const t = new ProceduralTexture(S, 'checker');
  for (let y = 0; y < S; y += S / 8) {
    for (let x = 0; x < S; x += S / 8) {
      const on = ((x / (S / 8)) + (y / (S / 8))) % 2 === 0;
      t.rect(x, y, S / 8, S / 8, on ? '#3a3d42' : '#4a4e55');
    }
  }
  return t.toTexture(device, { name: 'checker' });
}
export function makeSolid(device, color, name = 'solid') {
  const t = new ProceduralTexture(4, name);
  t.fill(color);
  return t.toTexture(device, { name, generateMipmaps: false });
}
/** Sky/fog gradient LUT: y = sky, mid = horizon, bottom = ground bounce. */
export function makeGradientLUT(device) {
  const t = new ProceduralTexture(4, 'gradientLUT');
  const g = t.ctx.createLinearGradient(0, 0, 0, 4);
  g.addColorStop(0, '#1b3a63');
  g.addColorStop(0.45, '#a8c4d8');
  g.addColorStop(0.55, '#8a7f6a');
  g.addColorStop(1, '#3a3428');
  t.ctx.fillStyle = g;
  t.ctx.fillRect(0, 0, 4, 4);
  return t.toTexture(device, { name: 'gradientLUT', generateMipmaps: false });
}

/** Glyph atlas for the 3D text renderer (damage numbers, player name tags, bot chatter). */
export function makeFontAtlas(device, size = 32, charset = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~') {
  const cols = 16;
  const rows = Math.ceil(charset.length / cols);
  const W = cols * size;
  const H = rows * size;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.floor(size * 0.82)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const metrics = [];
  for (let i = 0; i < charset.length; i++) {
    const cx = (i % cols) * size + size / 2;
    const cy = Math.floor(i / cols) * size + size / 2;
    ctx.fillText(charset[i], cx, cy);
    metrics.push({ char: charset[i], u: (i % cols) / cols, v: 1 - (Math.floor(i / cols) + 1) / rows, w: 1 / cols, h: 1 / rows });
  }
  const texture = device.createTexture( { width: W, height: H, source: canvas, srgb: true, name: 'fontAtlas', repeatable: false });
  return { texture, metrics, charMap: new Map(metrics.map((m) => [m.char, m])), size, cols, rows };
}

export const TextureUtils = {
  Texture, RenderTarget, ProceduralTexture, generateTextureKit, makeDecalAtlas,
  makeMuzzleFlashAtlas, makeParticleSprite, makeFontAtlas, makeChecker, makeSolid, makeGlowTexture,
};
export default Texture;
