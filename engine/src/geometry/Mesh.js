/**
 * OminX Engine — Mesh: typed-array geometry container with CPU-side bounds,
 * tangents (normal mapping), and skinning attributes.
 * @module engine/geometry/Mesh
 */
import { AABB } from '../math/Geometry.js';
import { Vector3 } from '../math/Vector3.js';
import { Matrix4 } from '../math/Matrix4.js';

export const Attribute = {
  Position: 'position',
  Normal: 'normal',
  UV: 'uv',
  UV1: 'uv1',
  Color: 'color',
  Tangent: 'tangent',
  BoneIndex: 'skinIndex',
  BoneWeight: 'skinWeight',
};

export const ATTRIBUTE_LAYOUT = {
  position: { size: 3, type: 'float32' },
  normal: { size: 3, type: 'float32' },
  uv: { size: 2, type: 'float32' },
  uv1: { size: 2, type: 'float32' },
  color: { size: 4, type: 'float32' },
  tangent: { size: 4, type: 'float32' },
  skinIndex: { size: 4, type: 'uint16' },
  skinWeight: { size: 4, type: 'float32' },
};

let _meshId = 0;

export class Mesh {
  /**
   * @param {object} [data]
   * @param {Float32Array|number[]} [data.positions]
   * @param {Float32Array|number[]} [data.normals]
   * @param {Float32Array|number[]} [data.uvs]
   * @param {Uint32Array|number[]} [data.indices]
   */
  constructor(data = {}) {
    this.id = ++_meshId;
    this.name = data.name ?? 'Mesh';
    this.positions = toF32(data.positions, 3);
    this.normals = toF32(data.normals, 3);
    this.uvs = toF32(data.uvs, 2);
    this.uv1s = data.uv1s ? toF32(data.uv1s, 2) : null;
    this.colors = data.colors ? toF32(data.colors, 4) : null;
    this.tangents = data.tangents ? toF32(data.tangents, 4) : null;
    this.indices = toU32(data.indices, 3);
    this.skinIndices = data.skinIndices ? toU16(data.skinIndices, 4) : null;
    this.skinWeights = data.skinWeights ? toF32(data.skinWeights, 4) : null;
    this.bounds = new AABB();
    this.boundingSphere = { center: new Vector3(), radius: 0 };
    this.submeshes = data.submeshes ?? null; // [{ start, count, materialIndex }]
    this.materialIndex = data.materialIndex ?? 0;
    /** Marks meshes that are generated at runtime (skin, debug lines, particles). */
    this.dynamic = data.dynamic ?? false;
    this.version = 0; // bumped when CPU data changes → GPU re-upload
    this.computeBounds();
  }

  get vertexCount() { return this.positions.length / 3; }
  get triangleCount() { return this.indices.length / 3; }
  get byteSize() {
    let n = this.positions.byteLength + this.normals.byteLength + this.uvs.byteLength + this.indices.byteLength;
    for (const a of [this.uv1s, this.colors, this.tangents, this.skinWeights]) if (a) n += a.byteLength;
    if (this.skinIndices) n += this.skinIndices.byteLength;
    return n;
  }

  setPositions(arr) { this.positions = toF32(arr, 3); this.version++; return this; }
  setNormals(arr) { this.normals = toF32(arr, 3); this.version++; return this; }
  setUVs(arr) { this.uvs = toF32(arr, 2); this.version++; return this; }
  setIndices(arr) { this.indices = toU32(arr, 3); this.version++; return this; }

  computeBounds() {
    const p = this.positions;
    const box = this.bounds;
    box.makeEmpty();
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < box.min.x) box.min.x = p[i];
      if (p[i + 1] < box.min.y) box.min.y = p[i + 1];
      if (p[i + 2] < box.min.z) box.min.z = p[i + 2];
      if (p[i] > box.max.x) box.max.x = p[i];
      if (p[i + 1] > box.max.y) box.max.y = p[i + 1];
      if (p[i + 2] > box.max.z) box.max.z = p[i + 2];
    }
    if (box.isEmpty()) { box.set(new Vector3(0, 0, 0), new Vector3(0, 0, 0)); }
    const c = box.center(new Vector3());
    let r = 0;
    for (let i = 0; i < p.length; i += 3) {
      const dx = p[i] - c.x, dy = p[i + 1] - c.y, dz = p[i + 2] - c.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r) r = d;
    }
    this.boundingSphere.center.copy(c);
    this.boundingSphere.radius = Math.sqrt(r);
    return this;
  }

  /** Recomputes smooth vertex normals by area-weighted accumulation. */
  computeNormals(smooth = true) {
    const p = this.positions, idx = this.indices;
    const n = new Float32Array(p.length);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
      const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
      if (l > 1e-9) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else { n[i] = 0; n[i + 1] = 1; n[i + 2] = 0; }
    }
    this.normals = n;
    this.version++;
    return this;
  }

  /** Builds per-vertex tangents (for normal maps) from UVs — Lengyel's method. */
  computeTangents() {
    const vc = this.vertexCount;
    const p = this.positions, uv = this.uvs, nrm = this.normals, idx = this.indices;
    const tan = new Float32Array(vc * 4);
    const bitan = new Float32Array(vc * 3);
    for (let i = 0; i < idx.length; i += 3) {
      const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
      const x0 = p[i0 * 3], y0 = p[i0 * 3 + 1], z0 = p[i0 * 3 + 2];
      const x1 = p[i1 * 3], y1 = p[i1 * 3 + 1], z1 = p[i1 * 3 + 2];
      const x2 = p[i2 * 3], y2 = p[i2 * 3 + 1], z2 = p[i2 * 3 + 2];
      const u0 = uv[i0 * 2], v0 = uv[i0 * 2 + 1];
      const u1 = uv[i1 * 2], v1 = uv[i1 * 2 + 1];
      const u2 = uv[i2 * 2], v2 = uv[i2 * 2 + 1];
      const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
      const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
      const du1 = u1 - u0, dv1 = v1 - v0;
      const du2 = u2 - u0, dv2 = v2 - v0;
      const det = du1 * dv2 - du2 * dv1;
      const r = det === 0 ? 0 : 1 / det;
      const tx = (dv2 * e1x - dv1 * e2x) * r;
      const ty = (dv2 * e1y - dv1 * e2y) * r;
      const tz = (dv2 * e1z - dv1 * e2z) * r;
      const bx = (du1 * e2x - du2 * e1x) * r;
      const by = (du1 * e2y - du2 * e1y) * r;
      const bz = (du1 * e2z - du2 * e1z) * r;
      for (const vi of [i0, i1, i2]) {
        tan[vi * 4] += tx; tan[vi * 4 + 1] += ty; tan[vi * 4 + 2] += tz;
        bitan[vi * 3] += bx; bitan[vi * 3 + 1] += by; bitan[vi * 3 + 2] += bz;
      }
    }
    for (let i = 0; i < vc; i++) {
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      let tx = tan[i * 4], ty = tan[i * 4 + 1], tz = tan[i * 4 + 2];
      const bx = bitan[i * 3], by = bitan[i * 3 + 1], bz = bitan[i * 3 + 2];
      // Gram-Schmidt orthogonalize
      const d = nx * tx + ny * ty + nz * tz;
      tx -= nx * d; ty -= ny * d; tz -= nz * d;
      const l = Math.hypot(tx, ty, tz);
      if (l > 1e-9) { tx /= l; ty /= l; tz /= l; }
      // handedness
      const w = (nx * (ty * bz - tz * by) + ny * (tz * bx - tx * bz) + nz * (tx * by - ty * bx)) < 0 ? -1 : 1;
      tan[i * 4] = tx; tan[i * 4 + 1] = ty; tan[i * 4 + 2] = tz; tan[i * 4 + 3] = w;
    }
    this.tangents = tan;
    this.version++;
    return this;
  }

  /** Generates a checkered/UV debug texture coordinate set (for editor UV view). */
  generatePlanarUVs(scale = 1) {
    const vc = this.vertexCount;
    const uv = new Float32Array(vc * 2);
    for (let i = 0; i < vc; i++) {
      uv[i * 2] = this.positions[i * 3] * scale;
      uv[i * 2 + 1] = this.positions[i * 3 + 2] * scale;
    }
    this.uvs = uv;
    this.version++;
    return this;
  }

  /** Applies a matrix to positions + normals in place. */
  applyMatrix(matrix) {
    const p = this.positions, n = this.normals;
    const v = new Vector3();
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(matrix);
      p[i] = v.x; p[i + 1] = v.y; p[i + 2] = v.z;
    }
    const nm = matrix.clone().invert().transpose();
    for (let i = 0; i < n.length; i += 3) {
      v.set(n[i], n[i + 1], n[i + 2]).transformDirection(nm);
      n[i] = v.x; n[i + 1] = v.y; n[i + 2] = v.z;
    }
    this.computeBounds();
    this.version++;
    return this;
  }
  translate(x, y = 0, z = 0) {
    // Accept a Vector3 (or {x,y,z}) as the first argument.
    if (x !== null && typeof x === 'object') { y = x.y ?? 0; z = x.z ?? 0; x = x.x ?? 0; }
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) { p[i] += x; p[i + 1] += y; p[i + 2] += z; }
    this.computeBounds();
    this.version++;
    return this;
  }
  rotateX(a) { return this.applyMatrix(_m4().makeRotationX(a)); }
  rotateY(a) { return this.applyMatrix(_m4().makeRotationY(a)); }
  rotateZ(a) { return this.applyMatrix(_m4().makeRotationZ(a)); }
  scaleMesh(sx, sy = sx, sz = sx) { return this.applyMatrix(_m4().makeScale(sx, sy, sz)); }
  /** Vector-taking alias (`mesh.scale_(new Vector3(2,2,2))`). */
  scale_(v, sy, sz) { return typeof v === 'object' ? this.scaleMesh(v.x, v.y, v.z) : this.scaleMesh(v, sy ?? v, sz ?? v); }
  flipWinding() {
    const idx = this.indices;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    this.version++;
    return this;
  }
  /** Merges another mesh (optionally baking a transform). Returns this. */
  merge(other, matrix = null, materialIndex = null) {
    const baseVertex = this.vertexCount;
    const baseIndex = this.indices.length;
    const otherPositions = matrix ? transformPositions(other.positions, matrix) : other.positions;
    const otherNormals = matrix ? transformNormals(other.normals, matrix) : other.normals;
    this.positions = concatF32(this.positions, otherPositions);
    this.normals = concatF32(this.normals, otherNormals);
    this.uvs = concatF32(ensureUVCount(this.uvs, baseVertex), ensureUVCount(other.uvs, other.vertexCount));
    if (this.uv1s || other.uv1s) this.uv1s = concatF32(ensureUVCount(this.uv1s, baseVertex), ensureUVCount(other.uv1s, other.vertexCount));
    if (this.colors || other.colors) this.colors = concatF32(ensureColorCount(this.colors, baseVertex), ensureColorCount(other.colors, other.vertexCount));
    const newIdx = new Uint32Array(this.indices.length + other.indices.length);
    newIdx.set(this.indices, 0);
    for (let i = 0; i < other.indices.length; i++) newIdx[baseIndex + i] = other.indices[i] + baseVertex;
    this.indices = newIdx;
    if (materialIndex !== null) {
      this.submeshes ??= [];
      this.submeshes.push({ start: baseIndex, count: other.indices.length, materialIndex });
    }
    this.computeBounds();
    this.version++;
    return this;
  }
  /** Appends a second mesh's triangles for one submesh draw range. */
  mergeWithMaterial(other, matrix, materialIndex) { return this.merge(other, matrix, materialIndex); }
  clone() {
    return new Mesh({
      name: this.name,
      positions: this.positions.slice(),
      normals: this.normals.slice(),
      uvs: this.uvs.slice(),
      uv1s: this.uv1s?.slice(),
      colors: this.colors?.slice(),
      tangents: this.tangents?.slice(),
      indices: this.indices.slice(),
      skinIndices: this.skinIndices?.slice(),
      skinWeights: this.skinWeights?.slice(),
      submeshes: this.submeshes ? this.submeshes.map((s) => ({ ...s })) : null,
      materialIndex: this.materialIndex,
    });
  }
  /** Collision-friendly summary (used to auto-derive colliders). */
  describe() {
    const size = this.bounds.getSize(new Vector3());
    return { vertices: this.vertexCount, triangles: this.triangleCount, size, bounds: this.bounds.clone() };
  }
  dispose() { this.disposed = true; }
  toString() { return `Mesh(${this.name}, ${this.vertexCount}v, ${this.triangleCount}t)`; }
}

function _m4() { return new Matrix4(); }

function transformPositions(positions, matrix) {
  const out = new Float32Array(positions.length);
  const v = new Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  return out;
}
function transformNormals(normals, matrix) {
  const out = new Float32Array(normals.length);
  const nm = matrix.clone().invert().transpose();
  const v = new Vector3();
  for (let i = 0; i < normals.length; i += 3) {
    v.set(normals[i], normals[i + 1], normals[i + 2]).transformDirection(nm);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  return out;
}
function concatF32(a, b) {
  if (!a) return b instanceof Float32Array ? b : Float32Array.from(b);
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function ensureUVCount(uv, vertexCount) { return uv && uv.length === vertexCount * 2 ? uv : new Float32Array(vertexCount * 2); }
function ensureColorCount(c, vertexCount) {
  if (c && c.length === vertexCount * 4) return c;
  const out = new Float32Array(vertexCount * 4);
  out.fill(1);
  return out;
}
/** Quantizes UVs to a grid — tiny perf win and it removes texture swim on merged batches. */
export function snapUVs(mesh, grid = 1 / 1024) {
  const uv = mesh.uvs;
  for (let i = 0; i < uv.length; i++) uv[i] = Math.round(uv[i] / grid) * grid;
  mesh.version++;
  return mesh;
}
function toF32(arr, stride) {
  if (!arr) return new Float32Array(0);
  if (arr instanceof Float32Array) return arr;
  return Float32Array.from(arr);
}
function toU32(arr, stride) {
  if (!arr) return new Uint32Array(0);
  if (arr instanceof Uint32Array) return arr;
  return Uint32Array.from(arr);
}
function toU16(arr) {
  if (!arr) return new Uint16Array(0);
  if (arr instanceof Uint16Array) return arr;
  return Uint16Array.from(arr);
}

/** Static convenience mirror of `Mesh.prototype.merge` (also accepts a single array). */
Mesh.merge = function merge(meshes, opts = {}) {
  const list = Array.isArray(meshes) ? meshes : [meshes];
  const first = list.find((m) => m && m.vertexCount > 0) ?? new Mesh({ name: opts.name ?? 'Merged' });
  const out = first.clone();
  out.name = opts.name ?? 'Merged';
  for (const m of list) if (m && m !== first) out.merge(m, opts.transforms?.[list.indexOf(m)] ?? null);
  return out;
};

export default Mesh;
