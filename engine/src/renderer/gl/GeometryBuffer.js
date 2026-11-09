/**
 * OminX Engine — GPU geometry: buffers, VAOs and instanced attribute support.
 *
 * `GeometryBuffer` wraps a CPU `Mesh` into a VAO + VBOs once and re-uploads only when the
 * mesh version changes. `InstanceBuffer` handles per-instance transforms (trees, props,
 * tracer streaks, particles) so thousands of objects cost one draw call each batch.
 * @module engine/renderer/gl/GeometryBuffer
 */
import { ATTRIBUTE_LAYOUT } from '../../geometry/Mesh.js';
import { createLogger } from '../../core/Logger.js';

const log = createLogger('GeometryBuffer');

export class GeometryBuffer {
  /**
   * @param {import('./GLDevice.js').GLDevice} device
   * @param {import('../../geometry/Mesh.js').Mesh} mesh
   */
  constructor(device, mesh) {
    this.device = device;
    this.mesh = mesh;
    this.uploadedVersion = -1;
    this.indexCount = mesh.indices.length;
    this.vertexCount = mesh.vertexCount;
    this.vao = null;
    this.buffers = {};
    this._destroyed = false;
    this._build();
    device._resources.vaos++;
    device._resources.buffers += Object.keys(this.buffers).length;
    device._resources.bytes += mesh.byteSize;
    device.onRestore(() => { this.uploadedVersion = -1; this._build(); });
  }

  static create(device, mesh) { return new GeometryBuffer(device, mesh); }

  _build() {
    const gl = this.device.gl;
    if (!this.vao) this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const m = this.mesh;
    this._upload('position', m.positions, 3);
    this._upload('normal', m.normals, 3, true);
    this._upload('uv', m.uvs, 2, true);
    this._upload('uv1', m.uv1s, 2, true);
    this._upload('color', m.colors, 4, true);
    this._upload('tangent', m.tangents, 4, true);
    this._upload('skinIndex', m.skinIndices, 4, true, gl.UNSIGNED_SHORT);
    this._upload('skinWeight', m.skinWeights, 4, true);
    if (m.indices && m.indices.length) {
      const ibo = this.buffers.index ?? (this.buffers.index = gl.createBuffer());
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
      this.indexCount = m.indices.length;
    } else {
      this.indexCount = 0;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.uploadedVersion = m.version;
    this.vertexCount = m.vertexCount;
  }

  _upload(name, data, size, optionalOnly = false, type = 0) {
    const gl = this.device.gl;
    if (!data || data.length === 0) return;
    const layout = ATTRIBUTE_LAYOUT[name];
    const buffer = this.buffers[name] ?? (this.buffers[name] = gl.createBuffer());
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const location = ATTRIBUTE_LOCATIONS[name];
    if (location === undefined) return;
    gl.enableVertexAttribArray(location);
    if (layout.type === 'uint16') gl.vertexAttribIPointer(location, size, gl.UNSIGNED_SHORT, 0, 0);
    else gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  }

  /** Re-uploads if the CPU mesh changed (skinned meshes, destructible props, terrain edits). */
  update() {
    if (this._destroyed) return this;
    if (this.mesh.version === this.uploadedVersion) return this;
    const gl = this.device.gl;
    const m = this.mesh;
    this._rebind('position', m.positions);
    this._rebind('normal', m.normals);
    this._rebind('uv', m.uvs);
    if (m.uv1s) this._rebind('uv1', m.uv1s);
    if (m.colors) this._rebind('color', m.colors);
    if (m.skinIndices) this._rebind('skinIndex', m.skinIndices, gl.UNSIGNED_SHORT);
    if (m.skinWeights) this._rebind('skinWeight', m.skinWeights);
    if (m.indices.length && this.buffers.index) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.DYNAMIC_DRAW);
      this.indexCount = m.indices.length;
    }
    this.uploadedVersion = m.version;
    this.vertexCount = m.vertexCount;
    return this;
  }

  _rebind(name, data, type = 0) {
    const gl = this.device.gl;
    const buffer = this.buffers[name];
    if (!buffer) { this._build(); return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    void type;
  }

  /**
   * Creates a dedicated VAO that reference this mesh's buffers *plus* a per-instance buffer.
   * Instanced attributes live in VAO state, so each batch needs its own VAO sharing the same
   * VBOs — that's how hundreds of instances stay in one draw without duplicating geometry.
   */
  createInstanceVAO(instanceBuffer) {
    const gl = this.device.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const rebind = (name, size) => {
      const buffer = this.buffers[name];
      if (!buffer) return;
      const layout = ATTRIBUTE_LAYOUT[name];
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const location = ATTRIBUTE_LOCATIONS[name];
      if (location === undefined) return;
      gl.enableVertexAttribArray(location);
      if (layout.type === 'uint16') gl.vertexAttribIPointer(location, size, gl.UNSIGNED_SHORT, 0, 0);
      else gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(location, 0);
    };
    rebind('position', 3);
    rebind('normal', 3);
    rebind('uv', 2);
    rebind('uv1', 2);
    rebind('color', 4);
    rebind('tangent', 4);
    rebind('skinIndex', 4);
    rebind('skinWeight', 4);
    if (this.buffers.index) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.index);
    gl.bindVertexArray(null);
    instanceBuffer.attach(vao);
    instanceBuffer.vao = vao;
    this.device._resources.vaos++;
    return vao;
  }

  bind() { this.device.bindVertexArray(this.vao); return this; }
  get isIndexed() { return this.indexCount > 0; }

  destroy() {
    const gl = this.device.gl;
    this._destroyed = true;
    if (this.vao) gl.deleteVertexArray(this.vao);
    for (const b of Object.values(this.buffers)) gl.deleteBuffer(b);
    this.buffers = {};
    this.vao = null;
  }
}

/** Matches the attribute bindings used by all engine shaders. */
export const ATTRIBUTE_LOCATIONS = {
  position: 0,
  normal: 1,
  uv: 2,
  uv1: 3,
  color: 4,
  tangent: 5,
  skinIndex: 6,
  skinWeight: 7,
  // instance attributes
  instanceMatrix0: 8,
  instanceMatrix1: 9,
  instanceMatrix2: 10,
  instanceMatrix3: 11,
  instanceColor: 12,
  instanceParams: 13,
};

export const BASE_ATTRIBUTES = ['position', 'normal', 'uv', 'uv1', 'color', 'tangent', 'skinIndex', 'skinWeight', 'instanceMatrix0', 'instanceMatrix1', 'instanceMatrix2', 'instanceMatrix3', 'instanceColor', 'instanceParams'];

/**
 * InstanceBuffer — per-instance model matrices + tint colors, uploaded straight from a
 * Float32Array. This is the reason the engine can render a forest of 4 000 trees or a
 * wall of bullet decals in a single draw call.
 */
export class InstanceBuffer {
  constructor(device, capacity = 512, layout = 'matrix') {
    this.device = device;
    this.capacity = capacity;
    this.count = 0;
    this.layout = layout;
    const gl = device.gl;
    this.matrixData = new Float32Array(capacity * 16);
    this.colorData = new Float32Array(capacity * 4);
    this.paramData = new Float32Array(capacity * 4);
    this.matrixBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.matrixBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.matrixData.byteLength, gl.DYNAMIC_DRAW);
    this.colorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.colorData.byteLength, gl.DYNAMIC_DRAW);
    this.paramBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.paramBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.paramData.byteLength, gl.DYNAMIC_DRAW);
    device._resources.buffers += 3;
  }

  /** Attaches instance attributes to a VAO. Must be called after the mesh VAO is bound. */
  attach(vao) {
    const gl = this.device.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.matrixBuffer);
    for (let i = 0; i < 4; i++) {
      const loc = ATTRIBUTE_LOCATIONS.instanceMatrix0 + i;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 64, i * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.enableVertexAttribArray(ATTRIBUTE_LOCATIONS.instanceColor);
    gl.vertexAttribPointer(ATTRIBUTE_LOCATIONS.instanceColor, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(ATTRIBUTE_LOCATIONS.instanceColor, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.paramBuffer);
    gl.enableVertexAttribArray(ATTRIBUTE_LOCATIONS.instanceParams);
    gl.vertexAttribPointer(ATTRIBUTE_LOCATIONS.instanceParams, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(ATTRIBUTE_LOCATIONS.instanceParams, 1);
    gl.bindVertexArray(null);
    this.attachedTo = vao;
    return this;
  }

  set(index, matrix, color = null, params = null) {
    const o = index * 16;
    const e = matrix.elements ?? matrix;
    for (let i = 0; i < 16; i++) this.matrixData[o + i] = e[i];
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

  /** Bulk-loads from typed arrays: `matrices` is capacity*16 floats. */
  setRaw(matrices, colors, params, count) {
    if (matrices) this.matrixData.set(matrices.subarray(0, count * 16));
    if (colors) this.colorData.set(colors.subarray(0, count * 4));
    if (params) this.paramData.set(params.subarray(0, count * 4));
    this.count = count;
    return this;
  }

  upload(count = this.count) {
    const gl = this.device.gl;
    this.count = count;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.matrixBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.matrixData, 0, count * 16);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.colorData, 0, count * 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.paramBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.paramData, 0, count * 4);
    return this;
  }

  ensureCapacity(count) {
    if (count <= this.capacity) return this;
    let cap = this.capacity;
    while (cap < count) cap *= 2;
    this.capacity = cap;
    const gl = this.device.gl;
    this.matrixData = new Float32Array(cap * 16);
    this.colorData = new Float32Array(cap * 4);
    this.paramData = new Float32Array(cap * 4);
    for (const [buf, size] of [[this.matrixBuffer, cap * 64], [this.colorBuffer, cap * 16], [this.paramBuffer, cap * 16]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, size, gl.DYNAMIC_DRAW);
    }
    if (this.attachedTo) this.attach(this.attachedTo);
    return this;
  }

  destroy() {
    const gl = this.device.gl;
    gl.deleteBuffer(this.matrixBuffer);
    gl.deleteBuffer(this.colorBuffer);
    gl.deleteBuffer(this.paramBuffer);
  }
}

/**
 * DynamicBuffer — a growable vertex buffer used for CPU-generated geometry streams:
 * tracers, traillines, debug lines, UI quads, text glyphs.
 */
export class DynamicBuffer {
  constructor(device, target = 'array', initialBytes = 4096) {
    this.device = device;
    this.target = target === 'element' ? device.gl.ELEMENT_ARRAY_BUFFER : device.gl.ARRAY_BUFFER;
    this.buffer = device.gl.createBuffer();
    this.capacity = initialBytes;
    device.gl.bindBuffer(this.target, this.buffer);
    device.gl.bufferData(this.target, initialBytes, device.gl.DYNAMIC_DRAW);
    this.data = target === 'element' ? new Uint32Array(initialBytes / 4) : new Float32Array(initialBytes / 4);
    this.byteLength = 0;
    device._resources.buffers++;
  }
  upload(view, byteLength = null) {
    const gl = this.device.gl;
    const bytes = byteLength ?? view.byteLength ?? view.length * (view.BYTES_PER_ELEMENT ?? 4);
    gl.bindBuffer(this.target, this.buffer);
    if (bytes > this.capacity) {
      this.capacity = Math.max(bytes, this.capacity * 2);
      gl.bufferData(this.target, this.capacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(this.target, 0, view);
    this.byteLength = bytes;
    return this;
  }
  destroy() { this.device.gl.deleteBuffer(this.buffer); }
}

export default GeometryBuffer;
