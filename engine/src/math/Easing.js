/**
 * OminX Engine — easing functions (Robert Penner set) + cubic bézier solver.
 * Used by tweening, UI animation, camera shake/impulse and weapon recoil curves.
 * @module engine/math/Easing
 */
import { clamp01, TAU } from './MathUtils.js';

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

export const Easing = {
  linear: (t) => t,
  inSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inQuart: (t) => t * t * t * t,
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  inQuint: (t) => t * t * t * t * t,
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOutQuint: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),
  inExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  inCirc: (t) => 1 - Math.sqrt(1 - Math.pow(t, 2)),
  outCirc: (t) => Math.sqrt(1 - Math.pow(t - 1, 2)),
  inOutCirc: (t) => (t < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2),
  inBack: (t) => c3 * t * t * t - c1 * t * t,
  outBack: (t) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  inOutBack: (t) => (t < 0.5
    ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2),
  inElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4)),
  outElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
  inOutElastic: (t) => (t === 0 ? 0 : t === 1 ? 1
    : t < 0.5
      ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
      : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1),
  inBounce: (t) => 1 - Easing.outBounce(1 - t),
  outBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  inOutBounce: (t) => (t < 0.5 ? (1 - Easing.outBounce(1 - 2 * t)) / 2 : (1 + Easing.outBounce(2 * t - 1)) / 2),
  smoothstep: (t) => t * t * (3 - 2 * t),
  smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  /** Sharp attack then long decay — used for recoil and camera punches. */
  impulse: (t) => Math.exp(-6 * t) * Math.sin(TAU * 1.2 * t) + Math.exp(-4 * t),
  /** Weapon kick: instant rise, exponential recovery. */
  kick: (t) => Math.pow(1 - clamp01(t), 2.4),
  snap: (t) => 1 - Math.pow(1 - clamp01(t), 12),
};

/** Named easing styles matching Roblox's Enum.EasingStyle. */
export const EasingStyle = {
  Linear: 'Linear',
  Sine: 'Sine',
  Quad: 'Quad',
  Cubic: 'Cubic',
  Quart: 'Quart',
  Quint: 'Quint',
  Expo: 'Expo',
  Circ: 'Circ',
  Back: 'Back',
  Bounce: 'Bounce',
  Elastic: 'Elastic',
  Smooth: 'Smooth',
  Impulse: 'Impulse',
  Kick: 'Kick',
};

export const EasingDirection = { In: 'In', Out: 'Out', InOut: 'InOut' };

/**
 * Resolves a style+direction pair to a function, e.g. style('Cubic','Out') → outCubic.
 * Accepts either a string or a function (pass-through).
 */
export function resolveEasing(style = 'Quad', direction = 'Out') {
  if (typeof style === 'function') return style;
  if (style === 'Linear') return Easing.linear;
  if (style === 'Smooth') return Easing.smootherstep;
  if (style === 'Impulse') return Easing.impulse;
  if (style === 'Kick') return Easing.kick;
  const dir = direction === 'In' ? 'in' : direction === 'InOut' ? 'inOut' : 'out';
  const name = `${dir}${style}`;
  return Easing[name] ?? Easing.linear;
}

/**
 * Cubic-bézier timing function (CSS-compatible) — returns f(t) for x in [0,1].
 * Uses Newton-Raphson with bisection fallback.
 */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const xEst = sampleX(t) - x;
      if (Math.abs(xEst) < 1e-6) return sampleY(t);
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= xEst / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 32; i++) {
      const xEst = sampleX(t);
      if (Math.abs(xEst - x) < 1e-6) break;
      if (xEst < x) lo = t; else hi = t;
      t = (lo + hi) * 0.5;
    }
    return sampleY(t);
  };
}

export const BezierEasing = {
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
  easeIn: cubicBezier(0.42, 0, 1, 1),
  easeOut: cubicBezier(0, 0, 0.58, 1),
  easeInOut: cubicBezier(0.42, 0, 0.58, 1),
  snappy: cubicBezier(0.2, 0.9, 0.2, 1),
  punchy: cubicBezier(0.5, 1.6, 0.4, 1),
};

export const EasingUtils = {
  Easing, EasingStyle, EasingDirection, resolveEasing, cubicBezier, BezierEasing,
  /** Maps an easing over an arbitrary number range. */
  interpolate: (fn, from, to, t) => from + (to - from) * fn(clamp01(t)),
  /** Envelope with attack/hold/release (seconds) — used for hit markers & UI pops. */
  envelope(t, attack, hold, release) {
    if (t < attack) return attack === 0 ? 1 : clamp01(t / attack);
    if (t < attack + hold) return 1;
    const r = (t - attack - hold) / (release || 1e-6);
    return clamp01(1 - r);
  },
};
export default Easing;
