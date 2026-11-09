/**
 * OminX Engine — Quaternion (unit quaternion rotation).
 * @module engine/math/Quaternion
 */
import { clamp, EPSILON, DEG2RAD } from './MathUtils.js';

const _v = { x: 0, y: 0, z: 0 };

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }

  static new(x = 0, y = 0, z = 0, w = 1) { return new Quaternion(x, y, z, w); }
  static identity() { return new Quaternion(0, 0, 0, 1); }
  static fromAxisAngle(axis, angle) { return new Quaternion().setFromAxisAngle(axis, angle); }
  static fromEuler(x, y, z, order = 'XYZ') { return new Quaternion().setFromEuler(x, y, z, order); }
  static fromEulerDegrees(x, y, z, order = 'XYZ') { return new Quaternion().setFromEuler(x * DEG2RAD, y * DEG2RAD, z * DEG2RAD, order); }
  static fromMatrix3(m) { return new Quaternion().setFromMatrix3(m); }
  static fromRotationMatrix(m) { return new Quaternion().setFromMatrix4(m); }
  static lookAt(eye, target, up) { return new Quaternion().setFromLookAt(eye, target, up); }
  static slerp(a, b, t) { return new Quaternion().copy(a).slerp(b, t); }
  static multiply(a, b) { return new Quaternion().copy(a).multiply(b); }
  static fromToRotation(from, to) { return new Quaternion().setFromUnitVectors(from, to); }
  static fromArray(a) { return new Quaternion(a[0], a[1], a[2], a[3]); }

  get X() { return this.x; } set X(v) { this.x = v; }
  get Y() { return this.y; } set Y(v) { this.y = v; }
  get Z() { return this.z; } set Z(v) { this.z = v; }
  get W() { return this.w; } set W(v) { this.w = v; }
  /** Roblox-ish aliases. */
  get X_() { return this.x; } get Y_() { return this.y; } get Z_() { return this.z; }

  set(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
  /** Resets to identity (instance method). */
  identity() { return this.set(0, 0, 0, 1); }
  identity_() { return this.identity(); }
  length() { return Math.hypot(this.x, this.y, this.z, this.w); }
  normalize() {
    let l = this.length();
    if (l === 0) { this.set(0, 0, 0, 1); return this; }
    l = 1 / l;
    this.x *= l; this.y *= l; this.z *= l; this.w *= l;
    return this;
  }
  conjugate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  invert() {
    const l = this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
    if (l === 0) return this;
    const il = 1 / l;
    return this.conjugate().scale_(il);
  }
  scale_(s) { this.x *= s; this.y *= s; this.z *= s; this.w *= s; return this; }
  dot(q) { return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w; }
  multiply(q) { return this.multiplyQuaternions(this, q); }
  premultiply(q) { return this.multiplyQuaternions(q, this); }
  multiplyQuaternions(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w;
    const bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  setFromAxisAngle(axis, angle) {
    const half = angle / 2, s = Math.sin(half);
    const l = Math.hypot(axis.x, axis.y, axis.z) || 1;
    this.x = (axis.x / l) * s; this.y = (axis.y / l) * s; this.z = (axis.z / l) * s;
    this.w = Math.cos(half);
    return this;
  }
  /** Builds from intrinsic Euler angles (radians). order: 'XYZ' (default), 'YXZ', 'ZXY', 'XZY', 'YZX', 'ZYX'. */
  setFromEuler(x, y, z, order = 'XYZ') {
    // Overload: setFromEuler(new Vector3(rx, ry, rz), order) — the Unity/Roblox idiom.
    if (x !== null && typeof x === 'object') {
      const euler = x;
      const ord = typeof y === 'string' ? y : (order ?? 'XYZ');
      return this.setFromEuler(euler.x, euler.y, euler.z, ord);
    }
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    switch (order) {
      case 'XYZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'YXZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'ZXY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'ZYX':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'YZX':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'XZY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      default: throw new Error(`Unknown Euler order: ${order}`);
    }
    return this;
  }
  setFromRotationMatrix(m) {
    const e = m.elements ?? m;
    const m11 = e[0], m12 = e[4], m13 = e[8];
    const m21 = e[1], m22 = e[5], m23 = e[9];
    const m31 = e[2], m32 = e[6], m33 = e[10];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s;
      this.x = (m32 - m23) * s;
      this.y = (m13 - m31) * s;
      this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s;
      this.x = 0.25 * s;
      this.y = (m12 + m21) / s;
      this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s;
      this.x = (m12 + m21) / s;
      this.y = 0.25 * s;
      this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s;
      this.x = (m13 + m31) / s;
      this.y = (m23 + m32) / s;
      this.z = 0.25 * s;
    }
    return this;
  }
  setFromMatrix3(m) { return this.setFromRotationMatrix(m); }
  setFromUnitVectors(from, to) {
    let r = from.dot(to) + 1;
    if (r < EPSILON) {
      r = 0;
      if (Math.abs(from.x) > Math.abs(from.z)) { this.set(-from.y, from.x, 0, r); }
      else { this.set(0, -from.z, from.y, r); }
    } else {
      this.set(
        from.y * to.z - from.z * to.y,
        from.z * to.x - from.x * to.z,
        from.x * to.y - from.y * to.x,
        r,
      );
    }
    return this.normalize();
  }
  /** Builds a rotation that looks down -Z at `target` (Unity/most 3D engines' convention). */
  setFromLookAt(eye, target, up = { x: 0, y: 1, z: 0 }) {
    const zx = eye.x - target.x, zy = eye.y - target.y, zz = eye.z - target.z;
    let l = Math.hypot(zx, zy, zz); l = l || 1;
    const z = { x: zx / l, y: zy / l, z: zz / l };
    // x = up × z
    let xx = up.y * z.z - up.z * z.y, xy = up.z * z.x - up.x * z.z, xz = up.x * z.y - up.y * z.x;
    l = Math.hypot(xx, xy, xz);
    if (l < EPSILON) { xx = 1; xy = 0; xz = 0; } else { xx /= l; xy /= l; xz /= l; }
    const y = { x: z.y * xz - z.z * xy, y: z.z * xx - z.x * xz, z: z.x * xy - z.y * xx };
    const m = [xx, xy, xz, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1];
    return this.setFromRotationMatrix(m);
  }
  angleTo(q) { return 2 * Math.acos(Math.abs(clamp(this.dot(q), -1, 1))); }
  rotateTowards(q, step) {
    const angle = this.angleTo(q);
    if (angle === 0) return this;
    const t = Math.min(1, step / angle);
    return this.slerp(q, t);
  }
  /** Studio/three-style alias: interpolate between two quaternions into this one. */
  slerpQuaternions(qa, qb, t) {
    return this.copy(qa).slerp(qb, t);
  }

  slerp(q, t) {
    if (t === 0) return this;
    if (t === 1) return this.copy(q);
    const x = this.x, y = this.y, z = this.z, w = this.w;
    let cosHalf = w * q.w + x * q.x + y * q.y + z * q.z;
    let qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    if (cosHalf < 0) { cosHalf = -cosHalf; qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
    if (cosHalf >= 1.0) return this;
    const sqrSinHalf = 1 - cosHalf * cosHalf;
    if (sqrSinHalf <= Number.EPSILON) {
      const s = 1 - t;
      this.set(s * x + t * qx, s * y + t * qy, s * z + t * qz, s * w + t * qw);
      return this.normalize();
    }
    const sinHalf = Math.sqrt(sqrSinHalf);
    const halfAngle = Math.atan2(sinHalf, cosHalf);
    const ratioA = Math.sin((1 - t) * halfAngle) / sinHalf;
    const ratioB = Math.sin(t * halfAngle) / sinHalf;
    this.set(x * ratioA + qx * ratioB, y * ratioA + qy * ratioB, z * ratioA + qz * ratioB, w * ratioA + qw * ratioB);
    return this;
  }
  /** Linear blend + renormalize; cheaper than slerp for small deltas. */
  nlerp(q, t) {
    const w = this.w + (q.w - this.w) * t;
    const x = this.x + (q.x - this.x) * t;
    const y = this.y + (q.y - this.y) * t;
    const z = this.z + (q.z - this.z) * t;
    return this.set(x, y, z, w).normalize();
  }
  rotateVector(v) {
    const out = { x: v.x, y: v.y, z: v.z };
    return this.applyToVector3(out);
  }
  applyToVector3(v) {
    const { x, y, z, w } = this;
    const vx = v.x, vy = v.y, vz = v.z;
    const ix = w * vx + y * vz - z * vy;
    const iy = w * vy + z * vx - x * vz;
    const iz = w * vz + x * vy - y * vx;
    const iw = -x * vx - y * vy - z * vz;
    v.x = ix * w + iw * -x + iy * -z - iz * -y;
    v.y = iy * w + iw * -y + iz * -x - ix * -z;
    v.z = iz * w + iw * -z + ix * -y - iy * -x;
    return v;
  }
  equals(q, eps = 1e-6) {
    return Math.abs(this.x - q.x) < eps && Math.abs(this.y - q.y) < eps && Math.abs(this.z - q.z) < eps && Math.abs(this.w - q.w) < eps;
  }
  toEuler(out = { x: 0, y: 0, z: 0 }, order = 'XYZ') {
    // Overload: toEuler('YXZ') allocates and returns the euler triple.
    let ord = order;
    if (typeof out === 'string') { ord = out; out = { x: 0, y: 0, z: 0 }; }
    order = ord;
    const { x, y, z, w } = this;
    switch (order) {
      case 'XYZ': {
        const sinp = 2 * (w * y - z * x);
        out.x = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
        out.y = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(clamp(sinp, -1, 1));
        out.z = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
        break;
      }
      case 'YXZ': {
        const sinp = 2 * (w * x + y * z);
        out.x = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(clamp(sinp, -1, 1));
        out.y = Math.atan2(2 * (w * y - z * x), 1 - 2 * (x * x + y * y));
        out.z = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
        break;
      }
      default: {
        const m = this.toMatrix4Array();
        const e = m;
        if (order === 'ZYX') {
          out.y = Math.asin(-clamp(e[2], -1, 1));
          if (Math.abs(e[2]) < 0.9999999) { out.x = Math.atan2(e[6], e[10]); out.z = Math.atan2(e[1], e[0]); }
          else { out.x = Math.atan2(-e[9], e[5]); out.z = 0; }
        } else {
          out.x = Math.atan2(-e[9], e[10]);
          out.y = Math.asin(clamp(e[8], -1, 1));
          out.z = Math.atan2(-e[1], e[0]);
        }
      }
    }
    return out;
  }
  toEulerDegrees(out) { const e = this.toEuler(out ?? {}); e.x *= 180 / Math.PI; e.y *= 180 / Math.PI; e.z *= 180 / Math.PI; return e; }
  toMatrix4Array(out = []) {
    const { x, y, z, w } = this;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
    out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
    out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  }
  toArray(out = [], o = 0) { out[o] = this.x; out[o + 1] = this.y; out[o + 2] = this.z; out[o + 3] = this.w; return out; }
  fromArray(a, o = 0) { this.x = a[o] || 0; this.y = a[o + 1] || 0; this.z = a[o + 2] || 0; this.w = a[o + 3] ?? 1; return this; }
  toJSON() { return [this.x, this.y, this.z, this.w]; }
  static fromJSON(a) { return new Quaternion(a[0], a[1], a[2], a[3]); }
  *[Symbol.iterator]() { yield this.x; yield this.y; yield this.z; yield this.w; }
  toString() { const e = this.toEulerDegrees(); return `Quaternion(${this.x.toFixed(3)}, ${this.y.toFixed(3)}, ${this.z.toFixed(3)}, ${this.w.toFixed(3)}) [${e.x.toFixed(1)}°, ${e.y.toFixed(1)}°, ${e.z.toFixed(1)}°]`; }
}

export function quat(x = 0, y = 0, z = 0, w = 1) { return new Quaternion(x, y, z, w); }
export default Quaternion;
