/**
 * OminX Engine — Matrix4 (column-major, WebGL compatible).
 * @module engine/math/Matrix4
 */
import { Vector3 } from './Vector3.js';
import { Quaternion } from './Quaternion.js';

const _v1 = new Vector3();
const _q1 = new Quaternion();
const _normalScratch = new Float32Array(9);

export class Matrix4 {
  /** @param {number[]} [elements] 16 elements in column-major order. */
  constructor(elements) {
    this.elements = elements ? Float32Array.from(elements) : new Float32Array(16);
    if (!elements) this.identity();
  }
  static new() { return new Matrix4(); }
  static identity() { return new Matrix4(); }
  static translation(x = 0, y = 0, z = 0) { return new Matrix4().makeTranslation(x, y, z); }
  static rotationX(a) { return new Matrix4().makeRotationX(a); }
  static rotationY(a) { return new Matrix4().makeRotationY(a); }
  static rotationZ(a) { return new Matrix4().makeRotationZ(a); }
  static rotationAxis(axis, a) { return new Matrix4().makeRotationAxis(axis, a); }
  static scale(x = 1, y = 1, z = 1) { return new Matrix4().makeScale(x, y, z); }
  static compose(pos, quat, scale) { return new Matrix4().compose(pos, quat, scale); }
  static fromQuaternion(q) { return new Matrix4().makeRotationFromQuaternion(q); }
  /** Returns a matrix that builds a look-at (view) transform. */
  static lookAt(eye, target, up) { return new Matrix4().lookAt(eye, target, up); }
  static perspective(fovRadians, aspect, near, far) { return new Matrix4().makePerspective(fovRadians, aspect, near, far); }
  static orthographic(l, r, b, t, n, f) { return new Matrix4().makeOrthographic(l, r, b, t, n, f); }
  static multiply(a, b) { return new Matrix4().multiplyMatrices(a, b); }
  static invert(m) { return m.clone().invert(); }
  static fromArray(a) { return new Matrix4(a); }
  static fromJSON(a) { return new Matrix4(a); }

  get position() { return new Vector3(this.elements[12], this.elements[13], this.elements[14]); }
  get rightVector() { return new Vector3(this.elements[0], this.elements[1], this.elements[2]); }
  get upVector() { return new Vector3(this.elements[4], this.elements[5], this.elements[6]); }
  get forwardVector() { return new Vector3(-this.elements[8], -this.elements[9], -this.elements[10]); }
  get determinant() {
    const e = this.elements;
    const n11 = e[0], n12 = e[4], n13 = e[8], n14 = e[12];
    const n21 = e[1], n22 = e[5], n23 = e[9], n24 = e[13];
    const n31 = e[2], n32 = e[6], n33 = e[10], n34 = e[14];
    const n41 = e[3], n42 = e[7], n43 = e[11], n44 = e[15];
    return (n41 * (+n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34)
      + n42 * (+n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33 - n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31)
      + n43 * (+n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32 + n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31)
      + n44 * (-n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33 + n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31));
  }

  set(n11, n12, n13, n14, n21, n22, n23, n24, n31, n32, n33, n34, n41, n42, n43, n44) {
    const e = this.elements;
    e[0] = n11; e[4] = n12; e[8] = n13; e[12] = n14;
    e[1] = n21; e[5] = n22; e[9] = n23; e[13] = n24;
    e[2] = n31; e[6] = n32; e[10] = n33; e[14] = n34;
    e[3] = n41; e[7] = n42; e[11] = n43; e[15] = n44;
    return this;
  }
  /** Resets to the identity matrix (instance method; `Matrix4.identity()` is the factory). */
  identity() { return this.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1); }
  identity_() { return this.identity(); }
  copy(m) { this.elements.set(m.elements); return this; }
  clone() { return new Matrix4().copy(this); }
  copyPosition(m) { const e = this.elements, me = m.elements; e[12] = me[12]; e[13] = me[13]; e[14] = me[14]; return this; }
  multiply(m) { return this.multiplyMatrices(this, m); }
  premultiply(m) { return this.multiplyMatrices(m, this); }
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements;
    const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
    const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
    const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
    const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];
    const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
    const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
    const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
    const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];
    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
    return this;
  }
  multiplyScalar(s) { for (let i = 0; i < 16; i++) this.elements[i] *= s; return this; }
  premultiplyMatrix(a) { return this.multiplyMatrices(a, this); }
  transpose() {
    const e = this.elements;
    let t;
    t = e[1]; e[1] = e[4]; e[4] = t;
    t = e[2]; e[2] = e[8]; e[8] = t;
    t = e[6]; e[6] = e[9]; e[9] = t;
    t = e[3]; e[3] = e[12]; e[12] = t;
    t = e[7]; e[7] = e[13]; e[13] = t;
    t = e[11]; e[11] = e[14]; e[14] = t;
    return this;
  }
  invert() {
    const e = this.elements;
    const n11 = e[0], n21 = e[1], n31 = e[2], n41 = e[3];
    const n12 = e[4], n22 = e[5], n32 = e[6], n42 = e[7];
    const n13 = e[8], n23 = e[9], n33 = e[10], n43 = e[11];
    const n14 = e[12], n24 = e[13], n34 = e[14], n44 = e[15];
    const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
    if (det === 0) { this.identity(); return this; }
    const detInv = 1 / det;
    e[0] = t11 * detInv;
    e[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv;
    e[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv;
    e[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv;
    e[4] = t12 * detInv;
    e[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv;
    e[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv;
    e[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv;
    e[8] = t13 * detInv;
    e[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv;
    e[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv;
    e[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv;
    e[12] = t14 * detInv;
    e[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv;
    e[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv;
    e[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv;
    return this;
  }
  makeTranslation(x, y, z) { return this.set(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1); }
  makeScale(x, y, z) { return this.set(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1); }
  makeRotationX(theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return this.set(1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1);
  }
  makeRotationY(theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return this.set(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1);
  }
  makeRotationZ(theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return this.set(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  }
  makeRotationAxis(axis, angle) {
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    const x = axis.x, y = axis.y, z = axis.z;
    const l = Math.hypot(x, y, z) || 1;
    const ax = x / l, ay = y / l, az = z / l;
    return this.set(
      t * ax * ax + c, t * ax * ay - az * s, t * ax * az + ay * s, 0,
      t * ax * ay + az * s, t * ay * ay + c, t * ay * az - ax * s, 0,
      t * ax * az - ay * s, t * ay * az + ax * s, t * az * az + c, 0,
      0, 0, 0, 1,
    );
  }
  makeRotationFromQuaternion(q) {
    const te = this.elements;
    const { x, y, z, w } = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    te[0] = 1 - (yy + zz); te[4] = xy - wz; te[8] = xz + wy;
    te[1] = xy + wz; te[5] = 1 - (xx + zz); te[9] = yz - wx;
    te[2] = xz - wy; te[6] = yz + wx; te[10] = 1 - (xx + yy);
    te[3] = 0; te[7] = 0; te[11] = 0;
    te[12] = 0; te[13] = 0; te[14] = 0; te[15] = 1;
    return this;
  }
  makeRotationFromEuler(x, y, z, order = 'XYZ') { return this.makeRotationFromQuaternion(_q1.setFromEuler(x, y, z, order)); }
  compose(position, quaternion, scale) {
    const te = this.elements;
    const sx = scale.x, sy = scale.y, sz = scale.z;
    const { x, y, z, w } = quaternion;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    te[0] = (1 - (yy + zz)) * sx;
    te[1] = (xy + wz) * sx;
    te[2] = (xz - wy) * sx;
    te[3] = 0;
    te[4] = (xy - wz) * sy;
    te[5] = (1 - (xx + zz)) * sy;
    te[6] = (yz + wx) * sy;
    te[7] = 0;
    te[8] = (xz + wy) * sz;
    te[9] = (yz - wx) * sz;
    te[10] = (1 - (xx + yy)) * sz;
    te[11] = 0;
    te[12] = position.x;
    te[13] = position.y;
    te[14] = position.z;
    te[15] = 1;
    return this;
  }
  decompose(position, quaternion, scale) {
    const te = this.elements;
    let sx = Math.hypot(te[0], te[1], te[2]);
    const sy = Math.hypot(te[4], te[5], te[6]);
    const sz = Math.hypot(te[8], te[9], te[10]);
    if (this.determinant < 0) sx = -sx;
    position.set(te[12], te[13], te[14]);
    const m = this.clone();
    const invSX = 1 / (sx || 1), invSY = 1 / (sy || 1), invSZ = 1 / (sz || 1);
    const me = m.elements;
    me[0] *= invSX; me[1] *= invSX; me[2] *= invSX;
    me[4] *= invSY; me[5] *= invSY; me[6] *= invSY;
    me[8] *= invSZ; me[9] *= invSZ; me[10] *= invSZ;
    quaternion.setFromRotationMatrix(m);
    scale.set(sx, sy, sz);
    return this;
  }
  /** Builds a right-handed look-at VIEW matrix (camera at eye looking at target). */
  lookAt(eye, target, up) {
    const te = this.elements;
    const zx = eye.x - target.x, zy = eye.y - target.y, zz = eye.z - target.z;
    let zl = Math.hypot(zx, zy, zz);
    if (zl < 1e-9) { zl = 1; }
    const zx1 = zx / zl, zy1 = zy / zl, zz1 = zz / zl;
    let xx = up.y * zz1 - up.z * zy1;
    let xy = up.z * zx1 - up.x * zz1;
    let xz = up.x * zy1 - up.y * zx1;
    let xl = Math.hypot(xx, xy, xz);
    if (xl < 1e-9) { xx = 1; xy = 0; xz = 0; xl = 1; }
    xx /= xl; xy /= xl; xz /= xl;
    const yx = zy1 * xz - zz1 * xy;
    const yy = zz1 * xx - zx1 * xz;
    const yz = zx1 * xy - zy1 * xx;
    te[0] = xx; te[4] = xy; te[8] = xz; te[12] = -(xx * eye.x + xy * eye.y + xz * eye.z);
    te[1] = yx; te[5] = yy; te[9] = yz; te[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);
    te[2] = zx1; te[6] = zy1; te[10] = zz1; te[14] = -(zx1 * eye.x + zy1 * eye.y + zz1 * eye.z);
    te[3] = 0; te[7] = 0; te[11] = 0; te[15] = 1;
    return this;
  }
  makePerspective(fovRadians, aspect, near, far) {
    const te = this.elements;
    const f = 1 / Math.tan(fovRadians / 2);
    te[0] = f / aspect; te[1] = 0; te[2] = 0; te[3] = 0;
    te[4] = 0; te[5] = f; te[6] = 0; te[7] = 0;
    te[8] = 0; te[9] = 0; te[11] = -1;
    te[12] = 0; te[13] = 0; te[15] = 0;
    if (far === Infinity || far === null) { te[10] = -1; te[14] = -2 * near; }
    else if (isFinite(far)) { te[10] = (far + near) / (near - far); te[14] = (2 * far * near) / (near - far); }
    else { te[10] = (1 + near) / (near - 1); te[14] = (2 * near) / (near - 1); }
    return this;
  }
  /** Perspective matrix with an OFF-CENTER frustum — used for tiled/cascaded shadows and VR. */
  makePerspectiveOffCenter(left, right, bottom, top, near, far) {
    const te = this.elements;
    te[0] = (2 * near) / (right - left); te[1] = 0; te[2] = 0; te[3] = 0;
    te[4] = 0; te[5] = (2 * near) / (top - bottom); te[6] = 0; te[7] = 0;
    te[8] = (right + left) / (right - left); te[9] = (top + bottom) / (top - bottom); te[11] = -1;
    te[12] = 0; te[13] = 0; te[15] = 0;
    te[10] = (far + near) / (near - far); te[14] = (2 * far * near) / (near - far);
    return this;
  }
  makeOrthographic(left, right, top, bottom, near, far) {
    const te = this.elements;
    const w = 1.0 / (right - left);
    const h = 1.0 / (top - bottom);
    const p = 1.0 / (far - near);
    const x = (right + left) * w;
    const y = (top + bottom) * h;
    const z = (far + near) * p;
    te[0] = 2 * w; te[1] = 0; te[2] = 0; te[3] = 0;
    te[4] = 0; te[5] = 2 * h; te[6] = 0; te[7] = 0;
    te[8] = 0; te[9] = 0; te[10] = -2 * p; te[11] = 0;
    te[12] = -x; te[13] = -y; te[14] = -z; te[15] = 1;
    return this;
  }
  makeFrustum(left, right, bottom, top, near, far) {
    const te = this.elements;
    const x = (2 * near) / (right - left);
    const y = (2 * near) / (top - bottom);
    const a = (right + left) / (right - left);
    const b = (top + bottom) / (top - bottom);
    const c = -(far + near) / (far - near);
    const d = (-2 * far * near) / (far - near);
    te[0] = x; te[1] = 0; te[2] = 0; te[3] = 0;
    te[4] = 0; te[5] = y; te[6] = 0; te[7] = 0;
    te[8] = a; te[9] = b; te[10] = c; te[11] = -1;
    te[12] = 0; te[13] = 0; te[14] = d; te[15] = 0;
    return this;
  }
  scale_(v) {
    const te = this.elements;
    const x = v.x, y = v.y, z = v.z;
    te[0] *= x; te[4] *= y; te[8] *= z;
    te[1] *= x; te[5] *= y; te[9] *= z;
    te[2] *= x; te[6] *= y; te[10] *= z;
    te[3] *= x; te[7] *= y; te[11] *= z;
    return this;
  }
  /** Inverse-transpose of the upper-left 3×3, written into a scratch Float32Array(9). */
  toNormalMatrix(out = _normalScratch) {
    const e = this.elements;
    const a00 = e[0], a01 = e[1], a02 = e[2];
    const a10 = e[4], a11 = e[5], a12 = e[6];
    const a20 = e[8], a21 = e[9], a22 = e[10];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (Math.abs(det) < 1e-12) det = 1;
    const id = 1 / det;
    out[0] = (a22 * a11 - a12 * a21) * id;
    out[3] = (a12 * a20 - a22 * a10) * id;
    out[6] = (a11 * a10 - a21 * a20) * id;
    out[1] = (a02 * a21 - a01 * a22) * id;
    out[4] = (a00 * a22 - a02 * a20) * id;
    out[7] = (a01 * a20 - a00 * a21) * id;
    out[2] = (a01 * a12 - a02 * a11) * id;
    out[5] = (a02 * a10 - a00 * a12) * id;
    out[8] = (a00 * a11 - a01 * a10) * id;
    return out;
  }
  getMaxScaleOnAxis() {
    const te = this.elements;
    const sx = te[0] * te[0] + te[1] * te[1] + te[2] * te[2];
    const sy = te[4] * te[4] + te[5] * te[5] + te[6] * te[6];
    const sz = te[8] * te[8] + te[9] * te[9] + te[10] * te[10];
    return Math.sqrt(Math.max(sx, sy, sz));
  }
  setPosition(x, y = 0, z = 0) {
    if (typeof x === 'object') { this.elements[12] = x.x; this.elements[13] = x.y; this.elements[14] = x.z; }
    else { this.elements[12] = x; this.elements[13] = y; this.elements[14] = z; }
    return this;
  }
  translate(x, y = 0, z = 0) {
    if (typeof x === 'object') { return this.translate(x.x, x.y, x.z); }
    const e = this.elements;
    e[12] += e[0] * x + e[4] * y + e[8] * z;
    e[13] += e[1] * x + e[5] * y + e[9] * z;
    e[14] += e[2] * x + e[6] * y + e[10] * z;
    e[15] += e[3] * x + e[7] * y + e[11] * z;
    return this;
  }
  equals(m, eps = 1e-6) {
    const a = this.elements, b = m.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
    return true;
  }
  lerpMatrix(m, t) {
    const a = this.elements, b = m.elements;
    for (let i = 0; i < 16; i++) a[i] += (b[i] - a[i]) * t;
    return this;
  }
  toArray(out = [], o = 0) { const e = this.elements; for (let i = 0; i < 16; i++) out[o + i] = e[i]; return out; }
  toJSON() { return Array.from(this.elements); }
  static fromJSONArr(a) { return new Matrix4(a); }
  toString() { return `Matrix4(${Array.from(this.elements).map((v) => v.toFixed(3)).join(', ')})`; }
}

export default Matrix4;
