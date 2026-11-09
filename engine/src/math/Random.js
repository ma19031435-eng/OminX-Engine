/**
 * OminX Engine — deterministic pseudo-random generators.
 * Includes a Roblox-style `Random` (with `NextNumber`, `NextInteger`, `NextUnitVector`)
 * and fast non-seeded helpers used by gameplay code (spread patterns, bot aim error).
 * @module engine/math/Random
 */
import { Vector3 } from './Vector3.js';

/** SplitMix64-ish 32-bit mixer — good distribution, no state setup needed. */
export function hash32(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}
export function hashStringToSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** xoshiro128** — small, fast, high-quality, seedable. */
export class RNG {
  constructor(seed = Date.now() >>> 0) {
    this.s = new Uint32Array(4);
    this.seed(seed);
  }
  seed(seed) {
    let s = seed >>> 0;
    if (s === 0) s = 0x9e3779b9;
    for (let i = 0; i < 4; i++) {
      s = (s + 0x9e3779b9) >>> 0;
      this.s[i] = hash32(s);
    }
    // avoid all-zero state
    if ((this.s[0] | this.s[1] | this.s[2] | this.s[3]) === 0) this.s[0] = 1;
    return this;
  }
  /** 32-bit unsigned int. */
  nextUint32() {
    const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl(s[3], 11);
    return result;
  }
  /** float in [0, 1) */
  nextNumber(min = 0, max = 1) {
    if (min === 0 && max === 1) return this.nextUint32() / 4294967296;
    if (min > max) { const t = min; min = max; max = t; }
    return min + (this.nextUint32() / 4294967296) * (max - min);
  }
  /** float in [0,1) — alias */
  random() { return this.nextUint32() / 4294967296; }
  /** integer in [min, max] inclusive */
  nextInteger(min, max) {
    if (min > max) { const t = min; min = max; max = t; }
    const range = max - min + 1;
    return min + Math.floor((this.nextUint32() / 4294967296) * range);
  }
  /** true with probability p */
  chance(p) { return this.random() < p; }
  /** normal distribution (Box–Muller) */
  gaussian(mean = 0, stdDev = 1) {
    let u = 0, v = 0;
    while (u === 0) u = this.random();
    while (v === 0) v = this.random();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  nextUnitVector() {
    const z = this.nextNumber(-1, 1);
    const a = this.nextNumber(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    return new Vector3(r * Math.cos(a), r * Math.sin(a), z);
  }
  nextVector(min = 0, max = 1) { return new Vector3(this.nextNumber(min, max), this.nextNumber(min, max), this.nextNumber(min, max)); }
  /** Uniform point inside a unit sphere. */
  nextInsideUnitSphere() {
    for (let i = 0; i < 32; i++) {
      const v = this.nextVector(-1, 1);
      if (v.sqrMagnitude <= 1) return v;
    }
    return this.nextUnitVector();
  }
  /** Direction inside a cone of `angleRadians` half-angle around `axis`. */
  nextConeDirection(axis, halfAngleRadians) {
    const cosLimit = Math.cos(halfAngleRadians);
    const cosTheta = this.nextNumber(cosLimit, 1);
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = this.nextNumber(0, Math.PI * 2);
    // Build an orthonormal basis around axis
    const n = axis.clone().normalize();
    const helper = Math.abs(n.y) < 0.99 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const t = new Vector3().crossVectors(helper, n).normalize();
    const b = new Vector3().crossVectors(n, t);
    return new Vector3()
      .addScaled(t, Math.cos(phi) * sinTheta)
      .addScaled(b, Math.sin(phi) * sinTheta)
      .addScaled(n, cosTheta)
      .normalize();
  }
  pick(arr) { if (!arr || arr.length === 0) return undefined; return arr[this.nextInteger(0, arr.length - 1)]; }
  pickWeighted(items, weightFn) {
    let total = 0;
    for (const it of items) total += weightFn(it);
    let r = this.nextNumber(0, total);
    for (const it of items) { r -= weightFn(it); if (r <= 0) return it; }
    return items[items.length - 1];
  }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.nextInteger(0, i);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  /** Returns a getter function producing floats in [min,max) from this stream. */
  numberGenerator(min, max) { return () => this.nextNumber(min, max); }
  clone() { const r = new RNG(1); r.s.set(this.s); return r; }
  getState() { return Array.from(this.s); }
  setState(state) { this.s.set(state); return this; }
}

// Global (non-deterministic) helpers — used for cosmetics only.
const globalRng = new RNG((Math.random() * 0xffffffff) >>> 0 || 12345);
export const random = () => globalRng.random();
export function randomRange(min, max) { return globalRng.nextNumber(min, max); }
export function randomInt(min, max) { return globalRng.nextInteger(min, max); }
export function chance(p) { return globalRng.chance(p); }
export function gaussian(mean, std) { return globalRng.gaussian(mean, std); }
export function randomUnitVector() { return globalRng.nextUnitVector(); }
export function randomConeDirection(axis, halfAngle) { return globalRng.nextConeDirection(axis, halfAngle); }
/** Returns a random point in a disc (x,z) — handy for spawn scatter. */
export function randomInDisc(radius, out = new Vector3()) {
  const a = globalRng.nextNumber(0, Math.PI * 2);
  const r = Math.sqrt(globalRng.random()) * radius;
  return out.set(Math.cos(a) * r, 0, Math.sin(a) * r);
}

export function createRandom(seed) { return new RNG(seed); }
export default RNG;
