/**
 * OminX Engine — Color4 (RGBA float color).
 * @module engine/math/Color4
 */
import { clamp01, lerp } from './MathUtils.js';
import { Color3 } from './Color3.js';

export class Color4 {
  constructor(r = 0, g = 0, b = 0, a = 1) { this.r = r; this.g = g; this.b = b; this.a = a; }

  static new(r = 0, g = 0, b = 0, a = 1) { return new Color4(r, g, b, a); }
  static fromRGB(r, g, b, a = 255) { return new Color4(clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), clamp01(a / 255)); }
  static fromHex(hex, alpha = 1) { const c = Color3.fromHex(hex); return new Color4(c.r, c.g, c.b, alpha); }
  static fromColor3(c, a = 1) { return new Color4(c.r, c.g, c.b, a); }
  static fromArray(arr) { return new Color4(arr[0], arr[1], arr[2], arr[3] ?? 1); }
  static fromJSON(arr) { return Color4.fromArray(arr); }
  static white(a = 1) { return new Color4(1, 1, 1, a); }
  static black(a = 1) { return new Color4(0, 0, 0, a); }
  static transparent() { return new Color4(0, 0, 0, 0); }
  static lerp(a, b, t) { return new Color4().copy(a).lerp(b, t); }

  get R() { return this.r; } set R(v) { this.r = v; }
  get G() { return this.g; } set G(v) { this.g = v; }
  get B() { return this.b; } set B(v) { this.b = v; }
  get A() { return this.a; } set A(v) { this.a = v; }
  get alpha() { return this.a; } set alpha(v) { this.a = v; }

  set(r = 0, g = 0, b = 0, a = 1) { this.r = r; this.g = g; this.b = b; this.a = a; return this; }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; this.a = c.a ?? 1; return this; }
  clone() { return new Color4(this.r, this.g, this.b, this.a); }
  setAlpha(a) { this.a = a; return this; }
  toColor3() { return new Color3(this.r, this.g, this.b); }
  lerp(c, t) {
    this.r = lerp(this.r, c.r, t); this.g = lerp(this.g, c.g, t);
    this.b = lerp(this.b, c.b, t); this.a = lerp(this.a, c.a ?? 1, t);
    return this;
  }
  multiply(c) { this.r *= c.r; this.g *= c.g; this.b *= c.b; this.a *= c.a ?? 1; return this; }
  scale(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
  premultiply() { this.r *= this.a; this.g *= this.a; this.b *= this.a; return this; }
  toHex() { return this.toColor3().toHex(); }
  toCSS() { return `rgba(${Math.round(clamp01(this.r) * 255)}, ${Math.round(clamp01(this.g) * 255)}, ${Math.round(clamp01(this.b) * 255)}, ${this.a})`; }
  toArray() { return [this.r, this.g, this.b, this.a]; }
  toJSON() { return [this.r, this.g, this.b, this.a]; }
  equals(c, eps = 1e-4) { return Math.abs(this.r - c.r) < eps && Math.abs(this.g - c.g) < eps && Math.abs(this.b - c.b) < eps && Math.abs(this.a - (c.a ?? 1)) < eps; }
  toString() { return `Color4(${this.r.toFixed(3)}, ${this.g.toFixed(3)}, ${this.b.toFixed(3)}, ${this.a.toFixed(3)})`; }
  *[Symbol.iterator]() { yield this.r; yield this.g; yield this.b; yield this.a; }
}
Color4.fromCSS = function fromCSS(css) {
  if (typeof css !== 'string') return new Color4(1, 1, 1, 1);
  const m = css.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+)\s*)?\)$/i);
  if (m) return new Color4(parseFloat(m[1]) / 255, parseFloat(m[2]) / 255, parseFloat(m[3]) / 255, m[4] === undefined ? 1 : parseFloat(m[4]));
  const c = Color3.fromCSS(css);
  const hex = css.replace('#', '');
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return new Color4(c.r, c.g, c.b, alpha);
};

export default Color4;
