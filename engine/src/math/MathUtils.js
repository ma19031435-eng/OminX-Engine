/**
 * OminX Engine — math utilities.
 * @module engine/math/MathUtils
 */

export const EPSILON = 1e-6;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }
export function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function lerpClamped(a, b, t) { return a + (b - a) * clamp01(t); }
export function invLerp(a, b, v) { return a === b ? 0 : (v - a) / (b - a); }
export function remap(v, inMin, inMax, outMin, outMax) { return lerp(outMin, outMax, invLerp(inMin, inMax, v)); }
export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || EPSILON));
  return t * t * (3 - 2 * t);
}
export function smootherstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || EPSILON));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function sign(v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); }
export function fract(v) { return v - Math.floor(v); }
export function mod(a, n) { return ((a % n) + n) % n; }
export function approx(a, b, eps = EPSILON) { return Math.abs(a - b) <= eps; }
export function degToRad(d) { return d * DEG2RAD; }
export function radToDeg(r) { return r * RAD2DEG; }
export function isPowerOfTwo(v) { return (v & (v - 1)) === 0 && v !== 0; }
export function nextPowerOfTwo(v) { let p = 1; while (p < v) p <<= 1; return p; }
export function roundTo(v, step) { return step === 0 ? v : Math.round(v / step) * step; }
export function floorTo(v, step) { return step === 0 ? v : Math.floor(v / step) * step; }
export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + sign(d) * maxDelta;
}
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}
export function dampAngle(current, target, lambda, dt) {
  return current + shortestAngle(current, target) * (1 - Math.exp(-lambda * dt));
}
export function wrapAngle(a) { return mod(a + PI, TAU) - PI; }
/** Wraps a value into [0, range) — ammo counters, index cycling, angle maths. */
export function wrap(value, range) { return range === 0 ? value : mod(value, range); }
/** -1 / 0 / +1, where 0 stays 0 (unlike Math.sign for -0 and NaN). */
export function signOrZero(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
/** Snaps a value to the nearest multiple of `step`. */
export function snap(value, step) { return step === 0 ? value : Math.round(value / step) * step; }
/** Exponential smoothing that is safe for large dt (used by recoil/ADS blends). */
export function smoothStep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
export function shortestAngle(from, to) { return wrapAngle(to - from); }
export function pingPong(t, length) {
  t = mod(t, length * 2);
  return length - Math.abs(t - length);
}
export function randomRange(min, max) { return min + Math.random() * (max - min); }
export function randomInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
export function randomPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
export function approximatelyEqualVec(a, b, eps = EPSILON) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
}
export function isFiniteVec(v) { return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z); }
export function sum(arr) { let s = 0; for (const v of arr) s += v; return s; }
export function avg(arr) { return arr.length ? sum(arr) / arr.length : 0; }
export function minOf(arr) { let m = Infinity; for (const v of arr) if (v < m) m = v; return m; }
export function maxOf(arr) { let m = -Infinity; for (const v of arr) if (v > m) m = v; return m; }
/** Solves a quadratic a*x^2+b*x+c=0, returns [t0, t1] or null. */
export function solveQuadratic(a, b, c) {
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) < EPSILON) return null;
    return [-c / b, -c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const q = -0.5 * (b + sign(b || 1) * sq);
  const t0 = q / a, t1 = c / q;
  return t0 < t1 ? [t0, t1] : [t1, t0];
}
/** Solves a cubic x^3+a*x^2+b*x+c=0 for the smallest root >= tmin (used by sweeps). */
export function solveCubic(a, b, c) {
  const p = b - (a * a) / 3;
  const q = (2 * a * a * a) / 27 - (a * b) / 3 + c;
  const disc = (q * q) / 4 + (p * p * p) / 27;
  const shift = -a / 3;
  if (disc > 0) {
    const sq = Math.sqrt(disc);
    return [Math.cbrt(-q / 2 + sq) + Math.cbrt(-q / 2 - sq) + shift];
  }
  if (disc === 0) {
    const u = Math.cbrt(-q / 2);
    return [2 * u + shift, -u + shift];
  }
  const r = Math.sqrt(-(p * p * p) / 27);
  const phi = Math.acos(clamp(-q / (2 * r), -1, 1));
  const m = 2 * Math.sqrt(-p / 3);
  return [
    m * Math.cos(phi / 3) + shift,
    m * Math.cos((phi + TAU) / 3) + shift,
    m * Math.cos((phi + 2 * TAU) / 3) + shift,
  ];
}
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
export function formatNumber(n, digits = 2) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(digits);
}
export const MathUtils = {
  EPSILON, DEG2RAD, RAD2DEG, PI, TAU, HALF_PI,
  clamp, clamp01, lerp, lerpClamped, invLerp, remap, smoothstep, smootherstep, sign, fract, mod,
  approx, degToRad, radToDeg, isPowerOfTwo, nextPowerOfTwo, roundTo, floorTo, moveTowards, damp,
  dampAngle, wrapAngle, shortestAngle, pingPong, randomRange, randomInt, randomPick, shuffle,
  solveQuadratic, solveCubic, formatBytes, formatNumber, sum, avg, minOf, maxOf,
};
export default MathUtils;
