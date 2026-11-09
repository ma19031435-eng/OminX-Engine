/**
 * OminX Engine — Matrix3 (3x3, column-major compatible with Matrix4 upper-left).
 * @module engine/math/Matrix3
 */
export class Matrix3 {
  /** @param {number[]} [elements] 9 elements in column-major order. */
  constructor(elements) { this.elements = elements ? Float32Array.from(elements) : new Float32Array(9); this.identity(); }
  static new() { return new Matrix3(); }
  identity() {
    const e = this.elements;
    e[0] = 1; e[1] = 0; e[2] = 0; e[3] = 0; e[4] = 1; e[5] = 0; e[6] = 0; e[7] = 0; e[8] = 1;
    return this;
  }
  set(n11, n12, n13, n21, n22, n23, n31, n32, n33) {
    const e = this.elements;
    e[0] = n11; e[3] = n12; e[6] = n13;
    e[1] = n21; e[4] = n22; e[7] = n23;
    e[2] = n31; e[5] = n32; e[8] = n33;
    return this;
  }
  setFromMatrix4(m) {
    const e = m.elements;
    return this.set(e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]);
  }
  copy(m) { this.elements.set(m.elements); return this; }
  clone() { return new Matrix3().copy(this); }
  multiply(m) { return this.multiplyMatrices(this, m); }
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements;
    const a11 = ae[0], a12 = ae[3], a13 = ae[6];
    const a21 = ae[1], a22 = ae[4], a23 = ae[7];
    const a31 = ae[2], a32 = ae[5], a33 = ae[8];
    const b11 = be[0], b12 = be[3], b13 = be[6];
    const b21 = be[1], b22 = be[4], b23 = be[7];
    const b31 = be[2], b32 = be[5], b33 = be[8];
    te[0] = a11 * b11 + a12 * b21 + a13 * b31;
    te[3] = a11 * b12 + a12 * b22 + a13 * b32;
    te[6] = a11 * b13 + a12 * b23 + a13 * b33;
    te[1] = a21 * b11 + a22 * b21 + a23 * b31;
    te[4] = a21 * b12 + a22 * b22 + a23 * b32;
    te[7] = a21 * b13 + a22 * b23 + a23 * b33;
    te[2] = a31 * b11 + a32 * b21 + a33 * b31;
    te[5] = a31 * b12 + a32 * b22 + a33 * b32;
    te[8] = a31 * b13 + a32 * b23 + a33 * b33;
    return this;
  }
  transpose() {
    const e = this.elements;
    let t;
    t = e[1]; e[1] = e[3]; e[3] = t;
    t = e[2]; e[2] = e[6]; e[6] = t;
    t = e[5]; e[5] = e[7]; e[7] = t;
    return this;
  }
  determinant() {
    const e = this.elements;
    return e[0] * (e[4] * e[8] - e[7] * e[5]) - e[3] * (e[1] * e[8] - e[7] * e[2]) + e[6] * (e[1] * e[5] - e[4] * e[2]);
  }
  invert() {
    const e = this.elements;
    const n11 = e[0], n21 = e[1], n31 = e[2];
    const n12 = e[3], n22 = e[4], n32 = e[5];
    const n13 = e[6], n23 = e[7], n33 = e[8];
    const t11 = n33 * n22 - n32 * n23;
    const t12 = n32 * n13 - n33 * n12;
    const t13 = n23 * n12 - n22 * n13;
    const det = n11 * t11 + n21 * t12 + n31 * t13;
    if (det === 0) return this.set(0, 0, 0, 0, 0, 0, 0, 0, 0);
    const detInv = 1 / det;
    e[0] = t11 * detInv;
    e[1] = (n31 * n23 - n33 * n21) * detInv;
    e[2] = (n32 * n21 - n31 * n22) * detInv;
    e[3] = t12 * detInv;
    e[4] = (n33 * n11 - n31 * n13) * detInv;
    e[5] = (n31 * n12 - n32 * n11) * detInv;
    e[6] = t13 * detInv;
    e[7] = (n21 * n13 - n23 * n11) * detInv;
    e[8] = (n22 * n11 - n21 * n12) * detInv;
    return this;
  }
  normalMatrix(m4) {
    const e = m4.elements;
    this.set(e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]);
    return this.invert().transpose();
  }
  toArray(out = [], o = 0) { const e = this.elements; for (let i = 0; i < 9; i++) out[o + i] = e[i]; return out; }
  equals(m) { const a = this.elements, b = m.elements; for (let i = 0; i < 9; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false; return true; }
  toString() { return `Matrix3(${Array.from(this.elements).map((v) => v.toFixed(3)).join(', ')})`; }
}
Object.assign(Matrix3, {
  new(...args) { return new Matrix3(...args); },
  /** Identity matrix — `Matrix3.identity()`. */
  identity() { return new Matrix3(); },
  identity_() { return new Matrix3(); },
  zero() { const m = new Matrix3(); m.elements.fill(0); return m; },
});

export default Matrix3;
