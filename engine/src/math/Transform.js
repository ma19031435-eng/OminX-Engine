/**
 * OminX Engine — Transform (position / rotation / scale + hierarchy math).
 * @module engine/math/Transform
 */
import { Vector3 } from './Vector3.js';
import { Quaternion } from './Quaternion.js';
import { Matrix4 } from './Matrix4.js';
import { DEG2RAD, RAD2DEG } from './MathUtils.js';

export class Transform {
  constructor() {
    this.position = new Vector3(0, 0, 0);
    this.rotation = new Quaternion();
    this.scale = new Vector3(1, 1, 1);
    this.matrix = new Matrix4();
    this.matrixWorld = new Matrix4();
    this.localEuler = new Vector3(0, 0, 0); // degrees, cached representation
    this.dirty = true;
    this.worldDirty = true;
  }

  static new() { return new Transform(); }
  copy(t) {
    this.position.copy(t.position);
    this.rotation.copy(t.rotation);
    this.scale.copy(t.scale);
    this.dirty = true; this.worldDirty = true;
    return this;
  }
  clone() { return new Transform().copy(this); }
  set(x, y, z) { this.position.set(x, y, z); return this.markDirty(); }
  /** Alias so `scale_` and serialization code can treat scale as a vector. */
  get scaleVector() { return this.scale; }

  /** Multiplies the current scale (Unity's `localScale *= v`). */
  scale_(v) {
    const s = this.scaleVector;
    if (typeof v === 'number') s.set(s.x * v, s.y * v, s.z * v);
    else s.set(s.x * v.x, s.y * v.y, s.z * v.z);
    this.markDirty();
    return this;
  }

  setScale(x, y, z) { this.scale.set(x, y, z); return this.markDirty(); }
  setRotationEuler(xDeg, yDeg, zDeg, order = 'YXZ') {
    this.rotation.setFromEuler(xDeg * DEG2RAD, yDeg * DEG2RAD, zDeg * DEG2RAD, order);
    return this.markDirty();
  }
  setFromQuaternion(q) { this.rotation.copy(q); return this.markDirty(); }
  /** Applies a CFrame-like position+rotation. */
  setFromCFrame(cf) { this.position.copy(cf.p); this.rotation.copy(cf.q); return this.markDirty(); }
  markDirty() { this.dirty = true; this.worldDirty = true; return this; }
  getEulerDegrees(order = 'YXZ') {
    const e = this.rotation.toEuler({}, order);
    this.localEuler.set(e.x * RAD2DEG, e.y * RAD2DEG, e.z * RAD2DEG);
    return this.localEuler;
  }
  /** Recomputes the local matrix. */
  updateMatrix() {
    if (!this.dirty) return this.matrix;
    this.matrix.compose(this.position, this.rotation, this.scale);
    this.dirty = false;
    return this.matrix;
  }
  /** Recomputes the world matrix given an optional parent world matrix. */
  updateMatrixWorld(parentWorld = null) {
    this.updateMatrix();
    if (parentWorld) this.matrixWorld.multiplyMatrices(parentWorld, this.matrix);
    else this.matrixWorld.copy(this.matrix);
    this.worldDirty = false;
    return this.matrixWorld;
  }
  translate(v, local = false) {
    if (local) this.position.add(v.clone().applyQuaternion(this.rotation));
    else this.position.add(v);
    return this.markDirty();
  }
  translateX(d, local = false) { return this.translate(_t.set(d, 0, 0), local); }
  translateY(d, local = false) { return this.translate(_t.set(0, d, 0), local); }
  translateZ(d, local = false) { return this.translate(_t.set(0, 0, d), local); }
  rotate(axis, angleRad) { this.rotation.multiply(_q.setFromAxisAngle(axis, angleRad)); return this.markDirty(); }
  rotateX(a) { return this.rotate(_t.set(1, 0, 0), a); }
  rotateY(a) { return this.rotate(_t.set(0, 1, 0), a); }
  rotateZ(a) { return this.rotate(_t.set(0, 0, 1), a); }
  lookAt(target, up = null) {
    const upv = up ?? new Vector3(0, 1, 0);
    this.rotation.setFromLookAt(this.position, target, upv);
    return this.markDirty();
  }
  getWorldPosition(out = new Vector3()) { return out.set(this.matrixWorld.elements[12], this.matrixWorld.elements[13], this.matrixWorld.elements[14]); }
  /** Converts a world-space point into local space. */
  worldToLocal(point) {
    const inv = _m.copy(this.matrixWorld).invert();
    return point.clone().applyMatrix4(inv);
  }
  localToWorld(point) { return point.clone().applyMatrix4(this.matrixWorld); }
  worldToLocalDirection(dir) { return dir.clone().transformDirection(_m.copy(this.matrixWorld).invert()); }
  localToWorldDirection(dir) { return dir.clone().transformDirection(this.matrixWorld); }
  getForward() { return new Vector3(0, 0, -1).applyQuaternion(this.rotation); }
  getRight() { return new Vector3(1, 0, 0).applyQuaternion(this.rotation); }
  getUp() { return new Vector3(0, 1, 0).applyQuaternion(this.rotation); }
  toCFrame() { return { p: this.position.clone(), q: this.rotation.clone() }; }
  toJSON() {
    return { p: this.position.toJSON(), r: this.rotation.toJSON(), s: this.scale.toJSON() };
  }
  fromJSON(j) {
    if (!j) return this;
    if (j.p) this.position.fromArray(j.p);
    if (j.r) this.rotation.fromArray(j.r);
    if (j.s) this.scale.fromArray(j.s);
    return this.markDirty();
  }
  getHeading() { return this.getForward().setY(0).normalize(); }
  toString() { return `Transform(p=${this.position}, s=${this.scale})`; }
}

const _t = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();
export default Transform;
