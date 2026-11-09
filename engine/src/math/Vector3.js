/**
 * OminX Engine — Vector3.
 * Unity-style mutating instance methods plus Roblox-style constructor/aliases.
 * @module engine/math/Vector3
 */
import { clamp, EPSILON, approx, lerp } from './MathUtils.js';
import { Quaternion } from './Quaternion.js';

const _t = { x: 0, y: 0, z: 0 };

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }

  /** Roblox-style constructor: Vector3.new(1, 2, 3). */
  static new(x = 0, y = 0, z = 0) { return new Vector3(x, y, z); }
  /** Roblox-style `Vector3.new(1, 2, 3)` cast from a single number or table. */
  static from(x, y, z) {
    if (typeof x === 'object' && x !== null) return new Vector3(x.x ?? x[0] ?? 0, x.y ?? x[1] ?? 0, x.z ?? x[2] ?? 0);
    if (y === undefined) return new Vector3(x, x, x);
    return new Vector3(x, y, z);
  }
  static zero() { return new Vector3(0, 0, 0); }
  static one() { return new Vector3(1, 1, 1); }
  static up() { return new Vector3(0, 1, 0); }
  static down() { return new Vector3(0, -1, 0); }
  static left() { return new Vector3(-1, 0, 0); }
  static right() { return new Vector3(1, 0, 0); }
  static forward() { return new Vector3(0, 0, 1); }
  static back() { return new Vector3(0, 0, -1); }
  static infinity() { return new Vector3(Infinity, Infinity, Infinity); }
  static negativeInfinity() { return new Vector3(-Infinity, -Infinity, -Infinity); }
  static random(min = 0, max = 1) {
    return new Vector3(min + Math.random() * (max - min), min + Math.random() * (max - min), min + Math.random() * (max - min));
  }
  static randomInUnitSphere() {
    for (let i = 0; i < 16; i++) {
      const v = Vector3.random(-1, 1);
      if (v.lengthSq() < 1) return v;
    }
    return new Vector3(0, 1, 0);
  }
  static distance(a, b) { return a.distanceTo(b); }
  static lerp(a, b, t) { return new Vector3().copy(a).lerp(b, t); }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static cross(a, b) { return new Vector3().copy(a).cross(b); }
  static min(a, b) { return new Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)); }
  static max(a, b) { return new Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)); }
  static add(a, b) { return new Vector3(a.x + b.x, a.y + b.y, a.z + b.z); }
  static sub(a, b) { return new Vector3(a.x - b.x, a.y - b.y, a.z - b.z); }
  static scale(a, s) { return new Vector3(a.x * s, a.y * s, a.z * s); }
  /** Catmull-Rom interpolation over 4 points, t in [0,1] between p1 and p2. */
  static catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return new Vector3(
      0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
    );
  }

  // ---- Unity-style properties
  get X() { return this.x; } set X(v) { this.x = v; }
  get Y() { return this.y; } set Y(v) { this.y = v; }
  get Z() { return this.z; } set Z(v) { this.z = v; }
  get magnitude() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  get sqrMagnitude() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  /** three.js-compatible aliases (square length). */
  get lengthSq() { return this.sqrMagnitude; }
  get squaredLength() { return this.sqrMagnitude; }
  get magnitudeSquared() { return this.sqrMagnitude; }
  getMagSq() { return this.sqrMagnitude; }
  get Magnitude() { return this.magnitude; }
  get Unit() { return this.clone().normalize(); }
  get unit() { return this.clone().normalize(); }
  get normalized() { return this.clone().normalize(); }
  get isZeroVector() { return this.x === 0 && this.y === 0 && this.z === 0; }

  // ---- core mutating ops
  set(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; return this; }
  setFrom(v) { this.x = v.x ?? v[0] ?? 0; this.y = v.y ?? v[1] ?? 0; this.z = v.z ?? v[2] ?? 0; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  addScalar(s) { this.x += s; this.y += s; this.z += s; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subScalar(s) { this.x -= s; this.y -= s; this.z -= s; return this; }
  mul(v) { this.x *= v.x; this.y *= v.y; this.z *= v.z; return this; }
  scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  div(v) { this.x /= v.x; this.y /= v.y; this.z /= v.z; return this; }
  divScalar(s) { this.x /= s; this.y /= s; this.z /= s; return this; }
  negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  abs() { this.x = Math.abs(this.x); this.y = Math.abs(this.y); this.z = Math.abs(this.z); return this; }
  floor() { this.x = Math.floor(this.x); this.y = Math.floor(this.y); this.z = Math.floor(this.z); return this; }
  ceil() { this.x = Math.ceil(this.x); this.y = Math.ceil(this.y); this.z = Math.ceil(this.z); return this; }
  round() { this.x = Math.round(this.x); this.y = Math.round(this.y); this.z = Math.round(this.z); return this; }
  roundTo(step) { this.x = Math.round(this.x / step) * step; this.y = Math.round(this.y / step) * step; this.z = Math.round(this.z / step) * step; return this; }
  normalize() {
    const l = this.magnitude;
    if (l > EPSILON) { this.x /= l; this.y /= l; this.z /= l; } else { this.x = this.y = this.z = 0; }
    return this;
  }
  setLength(len) {
    const l = this.magnitude;
    if (l > EPSILON) this.scale(len / l);
    return this;
  }
  limitLength(max) {
    const l = this.magnitude;
    if (l > max) this.scale(max / l);
    return this;
  }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) {
    const ax = this.x, ay = this.y, az = this.z;
    this.x = ay * v.z - az * v.y;
    this.y = az * v.x - ax * v.z;
    this.z = ax * v.y - ay * v.x;
    return this;
  }
  crossVectors(a, b) {
    this.x = a.y * b.z - a.z * b.y;
    this.y = a.z * b.x - a.x * b.z;
    this.z = a.x * b.y - a.y * b.x;
    return this;
  }
  angleTo(v) {
    const denom = Math.sqrt(this.sqrMagnitude * (v.x * v.x + v.y * v.y + v.z * v.z));
    if (denom < EPSILON) return 0;
    return Math.acos(clamp(this.dot(v) / denom, -1, 1));
  }
  distanceTo(v) { return Math.sqrt(this.distanceToSquared(v)); }
  distanceToSquared(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  magnitudeTo(v) { return this.distanceTo(v); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  lerpVectors(a, b, t) { this.x = lerp(a.x, b.x, t); this.y = lerp(a.y, b.y, t); this.z = lerp(a.z, b.z, t); return this; }
  /** three.js-compatible aliases — heavily used by internal geometry/physics code. */
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  mulVectors(a, b) { this.x = a.x * b.x; this.y = a.y * b.y; this.z = a.z * b.z; return this; }
  divideVectors(a, b) { this.x = a.x / b.x; this.y = a.y / b.y; this.z = a.z / b.z; return this; }
  scaleVectors(a, s) { this.x = a.x * s; this.y = a.y * s; this.z = a.z * s; return this; }
  setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
  setComponent(i, v) { if (i === 0) this.x = v; else if (i === 1) this.y = v; else this.z = v; return this; }
  setX(x) { this.x = x; return this; }
  setY(y) { this.y = y; return this; }
  setZ(z) { this.z = z; return this; }
  getX() { return this.x; }
  getY() { return this.y; }
  getZ() { return this.z; }
  getComponent(i) { return i === 0 ? this.x : i === 1 ? this.y : this.z; }
  fromArraySet(a) { this.x = a[0]; this.y = a[1]; this.z = a[2]; return this; }
  moveTowards(target, maxDelta) {
    const dx = target.x - this.x, dy = target.y - this.y, dz = target.z - this.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist <= maxDelta || dist < EPSILON) return this.copy(target);
    this.x += (dx / dist) * maxDelta; this.y += (dy / dist) * maxDelta; this.z += (dz / dist) * maxDelta;
    return this;
  }
  clampLength(min, max) { return this.limitLength(max).setLength(Math.max(this.magnitude, min)); }
  clampMagnitude(min, max) { return this.clampLength(min, max); }
  min(v) { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); this.z = Math.min(this.z, v.z); return this; }
  max(v) { this.x = Math.max(this.x, v.x); this.y = Math.max(this.y, v.y); this.z = Math.max(this.z, v.z); return this; }
  projectOnVector(v) {
    const denom = v.sqrMagnitude;
    if (denom < EPSILON) return this.set(0, 0, 0);
    return this.copy(v).scale(this.dot(v) / denom);
  }
  projectOnPlane(normal) { return this.sub(_t.set(normal.x, normal.y, normal.z).scale(this.dot(normal) / (normal.sqrMagnitude || 1))); }
  reflect(normal) { return this.sub(_t.copy(normal).scale(2 * this.dot(normal))); }
  rotateAxisAngle(axis, angle) { return this.applyQuaternion(_tmpQuat.setFromAxisAngle(axis, angle)); }
  applyMatrix3(m) {
    const { x, y, z } = this;
    this.x = m[0] * x + m[3] * y + m[6] * z;
    this.y = m[1] * x + m[4] * y + m[7] * z;
    this.z = m[2] * x + m[5] * y + m[8] * z;
    return this;
  }
  applyMatrix4(m) {
    const { x, y, z } = this;
    const e = m.elements ?? m;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const iw = w === 0 || w === 1 ? 1 : 1 / w;
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * iw;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * iw;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * iw;
    return this;
  }
  transformDirection(m) {
    const e = m.elements ?? m;
    const { x, y, z } = this;
    this.x = e[0] * x + e[4] * y + e[8] * z;
    this.y = e[1] * x + e[5] * y + e[9] * z;
    this.z = e[2] * x + e[6] * y + e[10] * z;
    return this.normalize();
  }
  /** Extracts the translation column of a Matrix4 (three.js-compatible helper). */
  setFromMatrixPosition(m) {
    const e = m.elements ?? m;
    return this.set(e[12], e[13], e[14]);
  }
  /** Extracts the translation column and returns a new vector. */
  static fromMatrixPosition(m) { return new Vector3().setFromMatrixPosition(m); }
  applyMatrix4AsPoint(m) {
    const e = m.elements ?? m;
    const x = this.x, y = this.y, z = this.z;
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15] || 1);
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    return this;
  }

  /** Rotates this vector around an arbitrary normalised axis (radians). */
  applyAxisAngle(axis, angle) {
    return this.applyQuaternion(_tmpQuat.setFromAxisAngle(axis, angle));
  }
  applyQuaternion(q) {
    const { x, y, z } = this;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  equals(v, eps = EPSILON) { return approx(this.x, v.x, eps) && approx(this.y, v.y, eps) && approx(this.z, v.z, eps); }
  toArray(out = [], offset = 0) { out[offset] = this.x; out[offset + 1] = this.y; out[offset + 2] = this.z; return out; }
  fromArray(arr, offset = 0) { this.x = arr[offset] || 0; this.y = arr[offset + 1] || 0; this.z = arr[offset + 2] || 0; return this; }
  toJSON() { return [this.x, this.y, this.z]; }
  static fromJSON(arr) { return new Vector3(arr[0], arr[1], arr[2]); }
  *[Symbol.iterator]() { yield this.x; yield this.y; yield this.z; }
  toString() { return `Vector3(${this.x.toFixed(3)}, ${this.y.toFixed(3)}, ${this.z.toFixed(3)})`; }
}

// late-bound temp to avoid circular import cost
const _tmpQuat = new Quaternion();

export function vec3(x, y, z) { return new Vector3(x, y, z); }
export default Vector3;
