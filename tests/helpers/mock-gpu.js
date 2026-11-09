/**
 * Minimal WebGPU mock for the Node test-suite.
 *
 * The engine's WebGPU backend is pure JS plus WebIDL objects, so the whole device layer can be
 * exercised headlessly: this mock records pipelines, bind groups, padded texture writes and draw
 * calls, which is exactly what the tests assert against. It implements the subset of the spec the
 * engine touches — no GLSL, no browser, no GPU required.
 *
 * @module tests/helpers/mock-gpu
 */

/** Defines the WebGPU enum globals when the host (Node) does not provide them. */
export function installGPUGlobals() {
  globalThis.GPUTextureUsage ??= {
    COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
  };
  globalThis.GPUBufferUsage ??= {
    MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008, INDEX: 0x0010,
    VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080, INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
  };
  globalThis.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  globalThis.GPUMapMode ??= { READ: 0x1, WRITE: 0x2 };
  globalThis.GPUMapMode ??= { READ: 1, WRITE: 2 };
}

export class MockGPUBuffer {
  constructor(device, desc = {}) {
    this.device = device;
    this.size = desc.size ?? 0;
    this.usage = desc.usage ?? 0;
    this.label = desc.label ?? 'buffer';
    this.destroyed = false;
  }
  destroy() { this.destroyed = true; }
  async mapAsync() { this.mapped = true; }
  getMappedRange() { return new ArrayBuffer(this.size); }
  unmap() { this.mapped = false; }
}

export class MockGPUTexture {
  constructor(device, desc = {}) {
    this.device = device;
    this.width = desc.size?.width ?? 1;
    this.height = desc.size?.height ?? 1;
    this.depthOrArrayLayers = desc.size?.depthOrArrayLayers ?? 1;
    this.format = desc.format ?? 'rgba8unorm';
    this.sampleCount = desc.sampleCount ?? 1;
    this.mipLevelCount = desc.mipLevelCount ?? 1;
    this.usage = desc.usage ?? 0;
    this.label = desc.label ?? 'texture';
    this.destroyed = false;
  }
  createView(desc = {}) { return new MockGPUTextureView(this, desc); }
  destroy() { this.destroyed = true; }
}

export class MockGPUTextureView {
  constructor(texture, desc = {}) {
    this.texture = texture;
    this.desc = desc;
    this.label = `${texture.label}_view`;
  }
}

export class MockGPURenderPass {
  constructor(device, descriptor) {
    this.device = device;
    this.descriptor = descriptor;
    this.pipeline = null;
    this.bindGroups = [];
    this.vertexBuffers = [];
    this.indexBuffer = null;
    this.draws = [];
    this.viewport = null;
    this.scissor = null;
    this.ended = false;
  }
  setPipeline(pipeline) { this.pipeline = pipeline; }
  setBindGroup(index, group, dynamicOffsets) { this.bindGroups.push({ index, group, dynamicOffsets }); }
  setVertexBuffer(slot, buffer, offset = 0, size = undefined) { this.vertexBuffers[slot] = { buffer, offset, size }; }
  setIndexBuffer(buffer, format) { this.indexBuffer = { buffer, format }; }
  setViewport(x, y, w, h, minDepth = 0, maxDepth = 1) { this.viewport = [x, y, w, h, minDepth, maxDepth]; }
  setScissorRect(x, y, w, h) { this.scissor = [x, y, w, h]; }
  draw(count, instances = 1, first = 0) { this.draws.push({ kind: 'draw', count, instances, first }); }
  drawIndexed(count, instances = 1, first = 0) { this.draws.push({ kind: 'drawIndexed', count, instances, first }); }
  end() { this.ended = true; }
}

export class MockGPUCommandEncoder {
  constructor(device) {
    this.device = device;
    this.passes = [];
    this.copies = [];
    this.finished = false;
    this.device.encoders.push(this);
  }
  beginRenderPass(descriptor) {
    const pass = new MockGPURenderPass(this.device, descriptor);
    this.passes.push(pass);
    return pass;
  }
  copyTextureToBuffer(source, destination) { this.copies.push({ source, destination }); }
  copyBufferToTexture(source, destination) { this.copies.push({ source, destination }); }
  finish() { this.finished = true; return { label: 'commandBuffer', passes: this.passes }; }
}

export class MockGPUCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.configured = null;
    this.currentTextureCount = 0;
  }
  configure(descriptor) { this.configured = descriptor; }
  getCurrentTexture() {
    this.currentTextureCount++;
    return new MockGPUTexture(this.device ?? {}, {
      size: { width: this.canvas.width, height: this.canvas.height, depthOrArrayLayers: 1 },
      format: this.configured?.format ?? 'bgra8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      label: 'swapchain',
    });
  }
}

export class MockGPUDevice {
  constructor() {
    this.createdBuffers = [];
    this.createdTextures = [];
    this.createdSamplers = [];
    this.createdPipelines = [];
    this.createdBindGroups = [];
    this.createdPipelineLayouts = [];
    this.createdBindGroupLayouts = [];
    this.shaderModules = [];
    this.encoders = [];
    this.submitted = [];
    this.textureWrites = [];
    this.bufferWrites = [];
    this.externalImageCopies = [];
    this.limits = { minUniformBufferOffsetAlignment: 256 };
    this.lost = new Promise(() => {});
    const device = this;
    this.queue = {
      writeBuffer(buffer, bufferOffset, data, dataOffset = 0, size = undefined) {
        device.bufferWrites.push({ buffer, bufferOffset, data, dataOffset, size });
      },
      writeTexture(destination, data, layout, size) {
        device.textureWrites.push({ destination, byteLength: data.byteLength ?? data.length, layout, size });
      },
      copyExternalImageToTexture(source, destination, size) {
        device.externalImageCopies.push({ source, destination, size });
      },
      submit(commandBuffers) { device.submitted.push(...commandBuffers); },
    };
  }
  createBuffer(desc) {
    const buffer = new MockGPUBuffer(this, desc);
    this.createdBuffers.push(buffer);
    return buffer;
  }
  createTexture(desc) {
    const texture = new MockGPUTexture(this, desc);
    this.createdTextures.push(texture);
    return texture;
  }
  createSampler(desc) {
    this.createdSamplers.push(desc);
    return { ...desc, isSampler: true };
  }
  createShaderModule(desc) { this.shaderModules.push(desc); return { code: desc.code, label: desc.label }; }
  createBindGroupLayout(desc) { this.createdBindGroupLayouts.push(desc); return { desc, kind: 'bindGroupLayout' }; }
  createPipelineLayout(desc) { this.createdPipelineLayouts.push(desc); return { desc, kind: 'pipelineLayout' }; }
  createRenderPipeline(desc) {
    const pipeline = { desc, label: desc.label, kind: 'renderPipeline' };
    this.createdPipelines.push(pipeline);
    return pipeline;
  }
  createBindGroup(desc) { const group = { desc, kind: 'bindGroup' }; this.createdBindGroups.push(group); return group; }
  createCommandEncoder(desc = {}) { return new MockGPUCommandEncoder(this, desc); }
  destroy() { this.destroyed = true; }
  onuncapturederror() { /* optional hook */ }
}

/** A canvas stub wired to a WebGPU-like context. */
export function mockCanvas(width = 1280, height = 720) {
  const canvas = {
    width, height, clientWidth: width, clientHeight: height, style: {},
    _context: null,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      if (!this._context) {
        this._context = new MockGPUCanvasContext(canvas);
        this._context.device = canvas._device;
      }
      return this._context;
    },
  };
  return canvas;
}

/**
 * Builds a device under test: mock canvas + mock GPU device, with the engine's WebGPUDevice
 * constructed synchronously (no `navigator.gpu` needed).
 */
export function mockWebGPUDevice(WebGPUDevice, opts = {}) {
  installGPUGlobals();
  const canvas = mockCanvas(opts.width ?? 1280, opts.height ?? 720);
  const gpu = new MockGPUDevice();
  canvas._device = gpu;
  const context = canvas.getContext('webgpu');
  context.device = gpu;
  const device = new WebGPUDevice(canvas, { device: gpu, context, ...opts });
  device.limits = gpu.limits;
  device.uniformAlignment = gpu.limits.minUniformBufferOffsetAlignment;
  device._createUniformRing();
  return { device, canvas, gpu, context };
}

/** A tiny standalone mesh, matching the shape `geometry/Mesh.js` produces. */
export function mockMesh({ name = 'testMesh', vertices = 4, indexed = true } = {}) {
  const count = vertices;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i % 2; positions[i * 3 + 1] = i < 2 ? 1 : 0; positions[i * 3 + 2] = 0;
    normals[i * 3 + 2] = 1;
    uvs[i * 2] = i % 2; uvs[i * 2 + 1] = i < 2 ? 1 : 0;
    colors[i * 4 + 3] = 1;
  }
  const indices = indexed ? new Uint32Array([0, 1, 2, 0, 2, 3]) : null;
  return {
    name, positions, normals, uvs, colors, indices,
    vertexCount: count, version: 1, byteSize: positions.byteLength + normals.byteLength + uvs.byteLength + colors.byteLength,
  };
}

export default MockGPUDevice;
