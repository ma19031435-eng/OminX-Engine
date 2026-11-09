/**
 * OminX Engine — Vector4.
 * @module engine/math/Vector4
 */
export class Vector4 {
  constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; }
  static new(x = 0, y = 0, z = 0, w = 0) { return new Vector4(x, y, z, w); }
  static zero() { return new Vector4(0, 0, 0, 0); }
  static one() { return new Vector4(1, 1, 1, 1); }
  get X() { return this.x; } set X(v) { this.x = v; }
  get Y() { return this.y; } set Y(v) { this.y = v; }
  get Z() { return this.z; } set Z(v) { this.z = v; }
  get W() { return this.w; } set W(v) { this.w = v; }
  get magnitude() { return Math.hypot(this.x, this.y, this.z, this.w); }
  get sqrMagnitude() { return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w; }
  set(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; this.w = v.w; return this; }
  clone() { return new Vector4(this.x, this.y, this.z, this.w); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; this.w += v.w; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; this.w -= v.w; return this; }
  scale(s) { this.x *= s; this.y *= s; this.z *= s; this.w *= s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z + this.w * v.w; }
  normalize() { const l = this.magnitude; if (l > 1e-6) this.scale(1 / l); return this; }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; this.w += (v.w - this.w) * t; return this; }
  equals(v, eps = 1e-6) { return Math.abs(this.x - v.x) < eps && Math.abs(this.y - v.y) < eps && Math.abs(this.z - v.z) < eps && Math.abs(this.w - v.w) < eps; }
  toArray(out = [], o = 0) { out[o] = this.x; out[o + 1] = this.y; out[o + 2] = this.z; out[o + 3] = this.w; return out; }
  fromArray(a, o = 0) { this.x = a[o] || 0; this.y = a[o + 1] || 0; this.z = a[o + 2] || 0; this.w = a[o + 3] || 0; return this; }
  toJSON() { return [this.x, this.y, this.z, this.w]; }
  static fromJSON(a) { return new Vector4(a[0], a[1], a[2], a[3]); }
  toString() { return `Vector4(${this.x}, ${this.y}, ${this.z}, ${this.w})`; }
}
export default Vector4;
