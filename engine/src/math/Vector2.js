/**
 * OminX Engine — Vector2.
 * @module engine/math/Vector2
 */
import { EPSILON, approx } from './MathUtils.js';

export class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  static new(x = 0, y = 0) { return new Vector2(x, y); }
  static zero() { return new Vector2(0, 0); }
  static one() { return new Vector2(1, 1); }
  static up() { return new Vector2(0, 1); }
  static down() { return new Vector2(0, -1); }
  static left() { return new Vector2(-1, 0); }
  static right() { return new Vector2(1, 0); }
  static random(min = 0, max = 1) { return new Vector2(min + Math.random() * (max - min), min + Math.random() * (max - min)); }
  static distance(a, b) { return a.distanceTo(b); }
  static dot(a, b) { return a.x * b.x + a.y * b.y; }
  static lerp(a, b, t) { return new Vector2().copy(a).lerp(b, t); }
  static add(a, b) { return new Vector2(a.x + b.x, a.y + b.y); }
  static sub(a, b) { return new Vector2(a.x - b.x, a.y - b.y); }
  static scale(a, s) { return new Vector2(a.x * s, a.y * s); }

  get X() { return this.x; } set X(v) { this.x = v; }
  get Y() { return this.y; } set Y(v) { this.y = v; }
  get width() { return this.x; } set width(v) { this.x = v; }
  get height() { return this.y; } set height(v) { this.y = v; }
  get magnitude() { return Math.hypot(this.x, this.y); }
  get sqrMagnitude() { return this.x * this.x + this.y * this.y; }
  get Magnitude() { return this.magnitude; }
  get Unit() { return this.clone().normalize(); }

  set(x = 0, y = 0) { this.x = x; this.y = y; return this; }
  copy(v) { this.x = v.x; this.y = v.y; return this; }
  clone() { return new Vector2(this.x, this.y); }
  add(v) { this.x += v.x; this.y += v.y; return this; }
  addScalar(s) { this.x += s; this.y += s; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; return this; }
  subScalar(s) { this.x -= s; this.y -= s; return this; }
  mul(v) { this.x *= v.x; this.y *= v.y; return this; }
  scale(s) { this.x *= s; this.y *= s; return this; }
  div(v) { this.x /= v.x; this.y /= v.y; return this; }
  divScalar(s) { this.x /= s; this.y /= s; return this; }
  negate() { this.x = -this.x; this.y = -this.y; return this; }
  abs() { this.x = Math.abs(this.x); this.y = Math.abs(this.y); return this; }
  dot(v) { return this.x * v.x + this.y * v.y; }
  cross(v) { return this.x * v.y - this.y * v.x; }
  normalize() { const l = this.magnitude; if (l > EPSILON) { this.x /= l; this.y /= l; } return this; }
  setLength(len) { return this.normalize().scale(len); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y); }
  distanceToSquared(v) { const dx = this.x - v.x, dy = this.y - v.y; return dx * dx + dy * dy; }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; return this; }
  lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; return this; }
  min(v) { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); return this; }
  max(v) { this.x = Math.max(this.x, v.x); this.y = Math.max(this.y, v.y); return this; }
  floor() { this.x = Math.floor(this.x); this.y = Math.floor(this.y); return this; }
  ceil() { this.x = Math.ceil(this.x); this.y = Math.ceil(this.y); return this; }
  round() { this.x = Math.round(this.x); this.y = Math.round(this.y); return this; }
  angle() { return Math.atan2(this.y, this.x); }
  rotate(radians) {
    const c = Math.cos(radians), s = Math.sin(radians);
    const x = this.x, y = this.y;
    this.x = x * c - y * s; this.y = x * s + y * c;
    return this;
  }
  perpendicular() { return this.set(-this.y, this.x); }
  equals(v, eps = EPSILON) { return approx(this.x, v.x, eps) && approx(this.y, v.y, eps); }
  toArray(out = [], offset = 0) { out[offset] = this.x; out[offset + 1] = this.y; return out; }
  fromArray(arr, offset = 0) { this.x = arr[offset] || 0; this.y = arr[offset + 1] || 0; return this; }
  toJSON() { return [this.x, this.y]; }
  static fromJSON(a) { return new Vector2(a[0], a[1]); }
  *[Symbol.iterator]() { yield this.x; yield this.y; }
  toString() { return `Vector2(${this.x.toFixed(3)}, ${this.y.toFixed(3)})`; }
}
export function vec2(x, y) { return new Vector2(x, y); }
export default Vector2;
