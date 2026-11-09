/**
 * OminX Engine — CFrame: Roblox-compatible position + rotation transform.
 * @module engine/math/CFrame
 */
import { Vector3 } from './Vector3.js';
import { Quaternion } from './Quaternion.js';
import { Matrix4 } from './Matrix4.js';
import { DEG2RAD } from './MathUtils.js';

const _m = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();

export class CFrame {
  constructor(position = new Vector3(0, 0, 0), quaternion = new Quaternion()) {
    this.p = position instanceof Vector3 ? position : Vector3.from(position);
    this.q = quaternion instanceof Quaternion ? quaternion : new Quaternion().copy(quaternion);
  }

  static new(pos = Vector3.zero(), rot = Quaternion.identity()) { return new CFrame(pos, rot); }
  static identity() { return new CFrame(); }
  static fromPosition(x, y, z) { return new CFrame(new Vector3(x, y, z)); }
  static fromEuler(x, y, z, order = 'YXZ') { return new CFrame().setEuler(x, y, z, order); }
  static fromAxisAngle(axis, angle) { return new CFrame().setAxisAngle(axis, angle); }
  static Angles(x, y, z) { return CFrame.fromEuler(x, y, z); }
  static fromRotationMatrix(m) { return new CFrame().setRotationMatrix(m); }
  static lookAt(from, to, up = Vector3.up()) {
    return new CFrame(from instanceof Vector3 ? from.clone() : Vector3.from(from), Quaternion.lookAt(from, to, up));
  }

  get Position() { return this.p; }
  get Rotation() { return this.q; }
  get X() { return this.p.x; }
  get Y() { return this.p.y; }
  get Z() { return this.p.z; }
  get LookVector() { return new Vector3(0, 0, -1).applyQuaternion(this.q).normalize(); }
  get RightVector() { return new Vector3(1, 0, 0).applyQuaternion(this.q).normalize(); }
  get UpVector() { return new Vector3(0, 1, 0).applyQuaternion(this.q).normalize(); }

  clone() { return new CFrame(this.p.clone(), this.q.clone()); }
  copy(c) { this.p.copy(c.p); this.q.copy(c.q); return this; }
  setPosition(x, y, z) {
    if (typeof x === 'object') this.p.setFrom(x);
    else this.p.set(x, y, z);
    return this;
  }
  setEuler(x, y, z, order = 'YXZ') { this.q.setFromEuler(x * DEG2RAD, y * DEG2RAD, z * DEG2RAD, order); return this; }
  setAxisAngle(axis, angle) { this.q.setFromAxisAngle(axis, angle); return this; }
  setRotationMatrix(m) { this.q.setFromRotationMatrix(m); return this; }
  /** CFrame * CFrame = compose. */
  multiply(other) { return this.mul(other); }
  mul(other) {
    const newP = other.p.clone().applyQuaternion(this.q).add(this.p);
    const newQ = this.q.clone().multiply(other.q);
    return new CFrame(newP, newQ);
  }
  /** Inverse: undoes this transform. */
  inverse() { const qi = this.q.clone().conjugate().normalize(); return new CFrame(this.p.clone().negate().applyQuaternion(qi), qi); }
  /** Transform a world point into this CFrame's local space. */
  pointToObjectSpace(v) { return v.clone().sub(this.p).applyQuaternion(this.q.clone().conjugate().normalize()); }
  /** Transform a local point into world space. */
  pointToWorldSpace(v) { return v.clone().applyQuaternion(this.q).add(this.p); }
  vectorToWorldSpace(v) { return v.clone().applyQuaternion(this.q); }
  vectorToObjectSpace(v) { return v.clone().applyQuaternion(this.q.clone().conjugate().normalize()); }
  toWorldSpace(other) { return this.mul(other); }
  toObjectSpace(other) { return this.inverse().mul(other); }
  lerp(c, t) {
    this.p.lerp(c.p, t);
    this.q.slerp(c.q, t);
    return this;
  }
  static lerp(a, b, t) { return a.clone().lerp(b, t); }
  /** Moves by a world-space offset. */
  add(v) { this.p.add(v); return this; }
  sub(v) { this.p.sub(v); return this; }
  toMatrix4(out = new Matrix4()) { return out.compose(this.p, this.q, _v.set(1, 1, 1)); }
  toMatrix() { return this.toMatrix4(new Matrix4()); }
  toEuler(order = 'YXZ') { const e = this.q.toEuler({}, order); return { x: e.x / DEG2RAD, y: e.y / DEG2RAD, z: e.z / DEG2RAD }; }
  toJSON() { return { p: this.p.toJSON(), q: this.q.toJSON() }; }
  static fromJSON(j) { return new CFrame(Vector3.fromJSON(j.p), Quaternion.fromJSON(j.q)); }
  equals(c, eps = 1e-5) { return this.p.equals(c.p, eps) && this.q.equals(c.q, eps); }
  toString() { const e = this.toEuler(); return `CFrame(${this.p.toString()}, [${e.x.toFixed(1)}°, ${e.y.toFixed(1)}°, ${e.z.toFixed(1)}°])`; }
}
export default CFrame;
