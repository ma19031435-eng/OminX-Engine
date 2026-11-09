/**
 * OminX Engine — Color3 (linear-ish sRGB float color, Roblox-compatible API).
 * @module engine/math/Color3
 */
import { clamp01, mod, lerp } from './MathUtils.js';

function toByte(v) { return Math.round(clamp01(v) * 255); }
function fromByte(v) { return clamp01(v / 255); }

export class Color3 {
  constructor(r = 0, g = 0, b = 0) { this.r = r; this.g = g; this.b = b; }

  static new(r = 0, g = 0, b = 0) { return new Color3(r, g, b); }
  /** Roblox: Color3.fromRGB(255, 128, 0) — 0..255 ints. */
  static fromRGB(r, g, b) { return new Color3(fromByte(r), fromByte(g), fromByte(b)); }
  static fromRGBInt(r) { return Color3.fromRGB((r >> 16) & 255, (r >> 8) & 255, r & 255); }
  static fromHSV(h, s, v) { return new Color3().setHSV(h, s, v); }
  static fromHex(hex) {
    const str = String(hex).replace('#', '').trim();
    if (str.length === 3) return Color3.fromRGB(parseInt(str[0] + str[0], 16), parseInt(str[1] + str[1], 16), parseInt(str[2] + str[2], 16));
    if (str.length === 6) return Color3.fromRGB(parseInt(str.slice(0, 2), 16), parseInt(str.slice(2, 4), 16), parseInt(str.slice(4, 6), 16));
    if (str.length === 8) return Color3.fromRGB(parseInt(str.slice(0, 2), 16), parseInt(str.slice(2, 4), 16), parseInt(str.slice(4, 6), 16));
    return new Color3(1, 0, 1); // magenta = invalid
  }
  static fromCSS(css) {
    const s = String(css).trim();
    if (s.startsWith('#')) return Color3.fromHex(s);
    const m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
      return Color3.fromRGB(parts[0] || 0, parts[1] || 0, parts[2] || 0);
    }
    return Color3.fromNamed(s);
  }
  static fromNamed(name) {
    const hex = NAMED_COLORS[String(name).toLowerCase()];
    return hex ? Color3.fromHex(hex) : new Color3(1, 0, 1);
  }
  static fromArray(a) { return new Color3(a[0], a[1], a[2]); }
  static fromJSON(a) { return new Color3(a[0], a[1], a[2]); }
  static lerp(a, b, t) { return new Color3().copy(a).lerp(b, t); }
  static white() { return new Color3(1, 1, 1); }
  static black() { return new Color3(0, 0, 0); }
  static red() { return new Color3(1, 0, 0); }
  static green() { return new Color3(0, 1, 0); }
  static blue() { return new Color3(0, 0, 1); }
  static yellow() { return new Color3(1, 1, 0); }
  static cyan() { return new Color3(0, 1, 1); }
  static magenta() { return new Color3(1, 0, 1); }
  static gray(level = 0.5) { return new Color3(level, level, level); }
  static random(pastel = false) {
    if (pastel) {
      const h = Math.random();
      return Color3.fromHSV(h, 0.45 + Math.random() * 0.2, 0.85 + Math.random() * 0.15);
    }
    return new Color3(Math.random(), Math.random(), Math.random());
  }

  get R() { return this.r; } set R(v) { this.r = v; }
  get G() { return this.g; } set G(v) { this.g = v; }
  get B() { return this.b; } set B(v) { this.b = v; }
  get r255() { return toByte(this.r); }
  get g255() { return toByte(this.g); }
  get b255() { return toByte(this.b); }

  set(r = 0, g = 0, b = 0) { this.r = r; this.g = g; this.b = b; return this; }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  clone() { return new Color3(this.r, this.g, this.b); }
  setRGB(r, g, b) { return this.set(fromByte(r), fromByte(g), fromByte(b)); }
  setHSV(h, s, v) {
    h = mod(h, 1);
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: this.set(v, t, p); break;
      case 1: this.set(q, v, p); break;
      case 2: this.set(p, v, t); break;
      case 3: this.set(p, q, v); break;
      case 4: this.set(t, p, v); break;
      default: this.set(v, p, q); break;
    }
    return this;
  }
  /** Returns { h, s, v } all in 0..1. */
  toHSV() {
    const max = Math.max(this.r, this.g, this.b);
    const min = Math.min(this.r, this.g, this.b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === this.r) h = mod((this.g - this.b) / d, 6) / 6;
      else if (max === this.g) h = ((this.b - this.r) / d + 2) / 6;
      else h = ((this.r - this.g) / d + 4) / 6;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
  }
  toHex(includeHash = true) {
    const h = `#${toByte(this.r).toString(16).padStart(2, '0')}${toByte(this.g).toString(16).padStart(2, '0')}${toByte(this.b).toString(16).padStart(2, '0')}`;
    return includeHash ? h : h.slice(1);
  }
  toCSS(alpha = 1) { return alpha >= 1 ? this.toHex() : `rgba(${toByte(this.r)}, ${toByte(this.g)}, ${toByte(this.b)}, ${alpha})`; }
  toRGB() { return { r: toByte(this.r), g: toByte(this.g), b: toByte(this.b) }; }
  toInt() { return (toByte(this.r) << 16) | (toByte(this.g) << 8) | toByte(this.b); }
  toArray() { return [this.r, this.g, this.b]; }
  toArrayRGB255() { return [this.r255, this.g255, this.b255]; }
  toJSON() { return [this.r, this.g, this.b]; }
  lerp(c, t) { this.r = lerp(this.r, c.r, t); this.g = lerp(this.g, c.g, t); this.b = lerp(this.b, c.b, t); return this; }
  /** Linear interpolation in HSV space (nicer for hue sweeps). */
  lerpHSV(c, t) {
    const a = this.toHSV(), b = c.toHSV();
    let dh = b.h - a.h;
    if (dh > 0.5) dh -= 1; else if (dh < -0.5) dh += 1;
    return this.setHSV(mod(a.h + dh * t, 1), lerp(a.s, b.s, t), lerp(a.v, b.v, t));
  }
  add(c) { this.r += c.r; this.g += c.g; this.b += c.b; return this; }
  sub(c) { this.r -= c.r; this.g -= c.g; this.b -= c.b; return this; }
  multiply(c) { this.r *= c.r; this.g *= c.g; this.b *= c.b; return this; }
  scale(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
  /** Adds a scalar to each channel (post-exposure style). */
  addScalar(s) { return this.add(new Color3(s, s, s)); }
  saturate() { this.r = clamp01(this.r); this.g = clamp01(this.g); this.b = clamp01(this.b); return this; }
  get Luminance() { return 0.2126 * this.r + 0.7152 * this.g + 0.0722 * this.b; }
  get luminance() { return this.Luminance; }
  get maxComponent() { return Math.max(this.r, this.g, this.b); }
  get minComponent() { return Math.min(this.r, this.g, this.b); }
  gammaCorrect(g = 2.2) { this.r = Math.pow(clamp01(this.r), 1 / g); this.g = Math.pow(clamp01(this.g), 1 / g); this.b = Math.pow(clamp01(this.b), 1 / g); return this; }
  /**(linear ← sRGB) */
  toLinear() { this.r = srgbToLinear(this.r); this.g = srgbToLinear(this.g); this.b = srgbToLinear(this.b); return this; }
  /** (sRGB ← linear) */
  toSRGB() { this.r = linearToSRGB(this.r); this.g = linearToSRGB(this.g); this.b = linearToSRGB(this.b); return this; }
  equals(c, eps = 1e-4) { return Math.abs(this.r - c.r) < eps && Math.abs(this.g - c.g) < eps && Math.abs(this.b - c.b) < eps; }
  /** Returns a version nudged by a random amount; useful for procedural variation. */
  jitter(amount = 0.05) { return this.addScalar((Math.random() - 0.5) * amount).saturate(); }
  toString() { return `Color3(${this.r255}, ${this.g255}, ${this.b255})`; }
  *[Symbol.iterator]() { yield this.r; yield this.g; yield this.b; }
}
export function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export function linearToSRGB(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

const NAMED_COLORS = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff',
  silver: '#c0c0c0', gray: '#808080', grey: '#808080', maroon: '#800000', olive: '#808000', purple: '#800080',
  teal: '#008080', navy: '#000080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700',
  skyblue: '#87ceeb', steelblue: '#4682b4', coral: '#ff7f50', crimson: '#dc143c', indigo: '#4b0082',
  violet: '#ee82ee', turquoise: '#40e0d0', salmon: '#fa8072', khaki: '#f0e68c', lavender: '#e6e6fa',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkblue: '#00008b',
  darkgreen: '#006400', darkred: '#8b0000', slategray: '#708090', slategrey: '#708090', midnightblue: '#191970',
  forestgreen: '#228b22', seagreen: '#2e8b57', tomato: '#ff6347', chocolate: '#d2691e', sandybrown: '#f4a460',
  rebeccapurple: '#663399',
};

export function color3(r, g, b) { return new Color3(r, g, b); }
export default Color3;
