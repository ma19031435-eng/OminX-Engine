/**
 * OminX Engine — curves.
 *
 * Half of a shooter's feel is a curve. Recoil climb over the first eight rounds, damage falloff past
 * 25 metres, sprint acceleration, the fade of a muzzle flash, the sensitivity ramp of an aim-down-
 * sights transition — all of them are "value as a function of something", and none of them belong in
 * a hand-written `if` chain. UE ships `UCurveFloat`/`FRichCurve` for exactly this reason.
 *
 * ```
 * const falloff = new FloatCurve({ name: 'DamageFalloff' });
 * falloff.addKey(0, 1).addKey(25, 1).addKey(60, 0.45).addKey(120, 0.2);
 * const damage = baseDamage * falloff.evaluate(distance);
 *
 * const recoil = VectorCurve.fromPattern([[0, 0], [0.4, 1.2], [0.9, 2.1], [1.6, 2.6]], { step: 0.08 });
 * ```
 *
 * What makes it usable rather than decorative:
 *   - **Interpolation modes per key** — constant (stepped), linear, and cubic Hermite with explicit
 *     tangents or automatically computed (monotone) ones, which is what stops a damage curve from
 *     overshooting and healing at long range.
 *   - **Outside the range** the curve clamps by default (or loops, or extrapolates) — a decision, not
 *     an accident.
 *   - **`VectorCurve`** evaluates x/y/z independently with one shared key time, so a recoil pattern is
 *     one asset.
 *   - **Text round-trip** (CSV/JSON), because a designer's spreadsheet is where these numbers live,
 *     and because it makes a curve diffable in a code review.
 *   - **`sample()`/`bake()`** for the places that cannot afford an evaluation per use (shader
 *     uniforms, precomputed tables).
 *
 * @module engine/src/core/Curve
 */
import { MulticastDelegate } from './Delegate.js';

export const curveEvents = {
  onChanged: new MulticastDelegate('curve.onChanged'),
};

/** Interpolation from this key to the next. */
export const CurveInterp = {
  Constant: 'constant',   // holds the value, then steps
  Linear: 'linear',
  Cubic: 'cubic',         // Hermite with explicit tangents
  Auto: 'auto',           // Hermite with monotone automatic tangents
};

/** What happens outside the last key. */
export const CurveExtrap = {
  Clamp: 'clamp',
  Loop: 'loop',
  Cycle: 'cycle',         // loop back and forth
  Linear: 'linear',       // continue at the final tangent
};

function clamp01(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }

/**
 * A scalar keyed curve. Keys are kept sorted by time; evaluation is a binary search plus an
 * interpolation, so a curve with a thousand keys costs the same as one with four.
 */
export class FloatCurve {
  constructor({ name = 'Curve', defaultValue = 0, interp = CurveInterp.Auto, extrap = CurveExtrap.Clamp, keys = null } = {}) {
    this.name = name;
    this.defaultValue = defaultValue;
    this.interp = interp;
    this.extrap = extrap;
    /** @type {Array<{time:number,value:number,interp:string,arrive:number|null,leave:number|null}>} */
    this.keys = [];
    if (keys) for (const key of keys) this.addKey(key.time ?? key[0], key.value ?? key[1], key);
  }

  static create(options) { return new FloatCurve(options); }

  get count() { return this.keys.length; }
  get isEmpty() { return this.keys.length === 0; }
  /** Inclusive key time range `[first, last]`. */
  get timeRange() { return this.keys.length ? [this.keys[0].time, this.keys[this.keys.length - 1].time] : [0, 0]; }
  get duration() { const [start, end] = this.timeRange; return end - start; }

  // ------------------------------------------------------------------ editing
  /** Adds or replaces a key. Returns `this` so calls chain. */
  addKey(time, value, { interp = null, arrive = null, leave = null } = {}) {
    const key = { time: Number(time) || 0, value: Number(value) || 0, interp: interp ?? this.interp, arrive, leave };
    const existing = this.keys.findIndex((entry) => Math.abs(entry.time - key.time) < 1e-9);
    if (existing >= 0) this.keys[existing] = key;
    else {
      this.keys.push(key);
      this.keys.sort((a, b) => a.time - b.time);
    }
    curveEvents.onChanged.broadcast(this);
    return this;
  }

  /** Adds several keys at once: `addKeys([[0, 1], [1, 0.5]])`. */
  addKeys(entries) {
    for (const entry of entries) {
      if (Array.isArray(entry)) this.addKey(entry[0], entry[1], entry[2] ?? {});
      else this.addKey(entry.time, entry.value, entry);
    }
    return this;
  }

  removeKey(time) {
    const before = this.keys.length;
    this.keys = this.keys.filter((entry) => Math.abs(entry.time - time) >= 1e-9);
    if (this.keys.length !== before) curveEvents.onChanged.broadcast(this);
    return before !== this.keys.length;
  }

  clear() { this.keys.length = 0; curveEvents.onChanged.broadcast(this); return this; }

  /** Sets a tangent explicitly (`arrive`/`leave` mean the same thing for interior keys). */
  setTangent(time, leave, arrive = leave) {
    const key = this.keys.find((entry) => Math.abs(entry.time - time) < 1e-9);
    if (!key) return false;
    key.leave = leave;
    key.arrive = arrive;
    return true;
  }

  /**
   * Computes monotone (Fritsch–Carlson) tangents for every interior key. This is what keeps a
   * damage or accuracy curve from overshooting past its keys — an unconstrained Catmull-Rom spline
   * happily returns 1.08 for a value that never exceeds 1.
   */
  autoTangents() {
    const keys = this.keys;
    for (const key of keys) { key.leave = 0; key.arrive = 0; }
    for (let i = 1; i < keys.length - 1; i++) {
      const previous = keys[i - 1];
      const current = keys[i];
      const next = keys[i + 1];
      const deltaBefore = (current.value - previous.value) / Math.max(1e-9, current.time - previous.time);
      const deltaAfter = (next.value - current.value) / Math.max(1e-9, next.time - current.time);
      if (deltaBefore * deltaAfter <= 0) { current.leave = 0; current.arrive = 0; continue; }
      // Weighted harmonic mean: monotone, and stable when the time gaps are uneven.
      const weightBefore = 2 * (next.time - current.time) + (current.time - previous.time);
      const weightAfter = (next.time - current.time) + 2 * (current.time - previous.time);
      const tangent = (weightBefore + weightAfter) / (weightBefore / deltaBefore + weightAfter / deltaAfter);
      current.leave = tangent;
      current.arrive = tangent;
    }
    if (keys.length > 1) {
      const first = keys[0];
      const second = keys[1];
      const slope = (second.value - first.value) / Math.max(1e-9, second.time - first.time);
      if (first.leave === null) first.leave = slope;
      const last = keys[keys.length - 1];
      const previous = keys[keys.length - 2];
      const lastSlope = (last.value - previous.value) / Math.max(1e-9, last.time - previous.time);
      if (last.arrive === null) last.arrive = lastSlope;
    }
    return this;
  }

  // ------------------------------------------------------------------ evaluation
  /** Value at `time`. Empty curves return `defaultValue`. */
  evaluate(time) {
    const t = Number(time) || 0;
    if (!this.keys.length) return this.defaultValue;
    if (this.keys.length === 1) return this.keys[0].value;
    const [start, end] = this.timeRange;

    if (t <= start) {
      if (this.extrap === CurveExtrap.Clamp) return this.keys[0].value;
      if (this.extrap === CurveExtrap.Linear) return this.keys[0].value + (this._slopeAt(0) * (t - start));
    }
    if (t >= end) {
      if (this.extrap === CurveExtrap.Clamp) return this.keys[this.keys.length - 1].value;
      if (this.extrap === CurveExtrap.Linear) return this.keys[this.keys.length - 1].value + (this._slopeAt(this.keys.length - 1) * (t - end));
    }
    if (t < start || t > end) {
      const duration = Math.max(1e-9, end - start);
      if (this.extrap === CurveExtrap.Loop) return this.evaluate(start + (((t - start) % duration) + duration) % duration);
      if (this.extrap === CurveExtrap.Cycle) {
        const phase = ((((t - start) / duration) % 2) + 2) % 2;
        return phase <= 1 ? this.evaluate(start + phase * duration) : this.evaluate(end - (phase - 1) * duration);
      }
    }

    const index = this._indexBefore(t);
    const keyA = this.keys[index];
    const keyB = this.keys[index + 1];
    if (!keyB) return keyA.value;
    const span = Math.max(1e-9, keyB.time - keyA.time);
    const alpha = clamp01((t - keyA.time) / span);
    switch (keyA.interp) {
      case CurveInterp.Constant: return keyA.value;
      case CurveInterp.Linear: return keyA.value + (keyB.value - keyA.value) * alpha;
      case CurveInterp.Cubic: {
        const out = keyA.leave ?? 0;
        const incoming = keyB.arrive ?? 0;
        return hermite(keyA.value, keyB.value, out * span, incoming * span, alpha);
      }
      case CurveInterp.Auto:
      default: {
        const out = keyA.leave ?? autoSlope(this.keys, index);
        const incoming = keyB.arrive ?? autoSlope(this.keys, index + 1);
        return hermite(keyA.value, keyB.value, out * span, incoming * span, alpha);
      }
    }
  }

  /** Rate of change at `time` (numerical: one evaluation pair, exact enough for gameplay). */
  derivative(time, epsilon = 1e-3) {
    const a = this.evaluate(time - epsilon);
    const b = this.evaluate(time + epsilon);
    return (b - a) / (2 * epsilon);
  }

  /** Normalizes the curve to 0..1 over its own range — HUD bars and probability tables want this. */
  normalized(time) {
    const [start, end] = this.timeRange;
    const values = this.keys.map((key) => key.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    void start; void end;
    if (max - min < 1e-9) return 0;
    return (this.evaluate(time) - min) / (max - min);
  }

  /** `count` evenly spaced samples over `[start, end]` (bake to a table for hot paths). */
  bake(count = 32, { start = null, end = null, asFloat32 = false } = {}) {
    const [keyStart, keyEnd] = this.timeRange;
    const from = start ?? keyStart;
    const to = end ?? keyEnd;
    const out = asFloat32 ? new Float32Array(count) : new Array(count);
    const span = to - from;
    for (let i = 0; i < count; i++) out[i] = this.evaluate(from + (span * i) / Math.max(1, count - 1));
    return out;
  }

  /** Integral over the range (trapezoidal) — total damage, total impulse, total rotation. */
  integrate({ start = null, end = null, steps = 128 } = {}) {
    const [keyStart, keyEnd] = this.timeRange;
    const from = start ?? keyStart;
    const to = end ?? keyEnd;
    const step = (to - from) / steps;
    let total = 0;
    for (let i = 0; i < steps; i++) total += (this.evaluate(from + i * step) + this.evaluate(from + (i + 1) * step)) / 2 * step;
    return total;
  }

  /** Where the curve peaks — muzzle-flash timing, camera-shake envelopes. */
  extrema() {
    if (!this.keys.length) return { min: this.defaultValue, max: this.defaultValue, minTime: 0, maxTime: 0 };
    let min = Infinity;
    let max = -Infinity;
    let minTime = 0;
    let maxTime = 0;
    const [start, end] = this.timeRange;
    const samples = Math.max(64, this.keys.length * 16);
    for (let i = 0; i <= samples; i++) {
      const time = start + ((end - start) * i) / samples;
      const value = this.evaluate(time);
      if (value < min) { min = value; minTime = time; }
      if (value > max) { max = value; maxTime = time; }
    }
    return { min, max, minTime, maxTime };
  }

  _indexBefore(time) {
    let low = 0;
    let high = this.keys.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.keys[mid].time <= time) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  _slopeAt(index) {
    const key = this.keys[index];
    if (key.leave !== null && key.leave !== undefined) return key.leave;
    return autoSlope(this.keys, index);
  }

  // ------------------------------------------------------------------ serialization
  /**
   * CSV: `time,value,interp,leave,arrive` — the format a designer's spreadsheet exports and a code
   * review can read.
   */
  toCsv({ includeHeader = true } = {}) {
    const lines = [];
    if (includeHeader) lines.push('time,value,interp,leave,arrive');
    for (const key of this.keys) {
      lines.push([key.time, key.value, key.interp, key.leave ?? '', key.arrive ?? ''].join(','));
    }
    return lines.join('\n');
  }

  fromCsv(text) {
    this.keys.length = 0;
    const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const [index, line] of lines.entries()) {
      if (index === 0 && line.toLowerCase().startsWith('time,')) continue;
      const [time, value, interp, leave, arrive] = line.split(',').map((cell) => cell.trim());
      if (time === undefined || value === undefined) continue;
      this.addKey(Number(time), Number(value), {
        interp: interp || null,
        leave: leave === '' || leave === undefined ? null : Number(leave),
        arrive: arrive === '' || arrive === undefined ? null : Number(arrive),
      });
    }
    return this;
  }

  toJSON() {
    return { name: this.name, interp: this.interp, extrap: this.extrap, defaultValue: this.defaultValue, keys: this.keys.map((key) => ({ ...key })) };
  }

  static fromJSON(data) {
    if (data instanceof FloatCurve) return data;
    return new FloatCurve(data ?? {});
  }

  // ------------------------------------------------------------------ reporting
  /** ASCII plot — when a designer asks "what does this curve look like", answer in the console. */
  plot({ width = 60, height = 12, start = null, end = null } = {}) {
    if (!this.keys.length) return `${this.name}: (empty)`;
    const [keyStart, keyEnd] = this.timeRange;
    const from = start ?? keyStart;
    const to = end ?? keyEnd;
    const samples = [];
    for (let i = 0; i < width; i++) samples.push(this.evaluate(from + ((to - from) * i) / Math.max(1, width - 1)));
    let min = Math.min(...samples);
    let max = Math.max(...samples);
    if (max - min < 1e-9) { max = min + 1; }
    const rows = [];
    for (let row = height - 1; row >= 0; row--) {
      const threshold = min + ((max - min) * row) / (height - 1);
      let line = '';
      for (const value of samples) line += value >= threshold ? '#' : ' ';
      rows.push(`${row === height - 1 ? max.toFixed(2).padStart(7) : row === 0 ? min.toFixed(2).padStart(7) : '       '} |${line}`);
    }
    return [`${this.name}  [${from.toFixed(2)} … ${to.toFixed(2)}]  ${this.keys.length} keys`, ...rows].join('\n');
  }

  describe() {
    return {
      name: this.name, keys: this.keys.length, interp: this.interp, extrap: this.extrap,
      range: this.timeRange, extrema: this.extrema(),
      keyList: this.keys.map((key) => ({ time: key.time, value: round3(key.value) })),
    };
  }
}

/** x/y/z curves sharing one key-time list: recoil patterns, camera shake, colour ramps. */
export class VectorCurve {
  constructor({ name = 'VectorCurve', interp = CurveInterp.Auto, extrap = CurveExtrap.Clamp } = {}) {
    this.name = name;
    this.x = new FloatCurve({ name: `${name}.x`, interp, extrap });
    this.y = new FloatCurve({ name: `${name}.y`, interp, extrap });
    this.z = new FloatCurve({ name: `${name}.z`, interp, extrap });
  }

  static create(options) { return new VectorCurve(options); }

  /** Adds the same key time to all three axes. */
  addKey(time, x, y = 0, z = 0, options = {}) {
    this.x.addKey(time, x, options);
    this.y.addKey(time, y, options);
    this.z.addKey(time, z, options);
    return this;
  }

  /** Builds a curve from `[[time, x, y], …]` pairs — the shape a recoil pattern is authored in. */
  static fromPattern(points, { name = 'Pattern', step = null } = {}) {
    const curve = new VectorCurve({ name });
    points.forEach((point, index) => {
      const time = step === null ? index : index * step;
      curve.addKey(time, point[0], point[1] ?? 0, point[2] ?? 0);
    });
    return curve;
  }

  evaluate(time) {
    return { x: this.x.evaluate(time), y: this.y.evaluate(time), z: this.z.evaluate(time) };
  }

  get keys() { return this.x.keys.length; }
  get timeRange() { return this.x.timeRange; }
  describe() { return { name: this.name, keys: this.keys, x: this.x.describe(), y: this.y.describe(), z: this.z.describe() }; }
  toJSON() { return { name: this.name, x: this.x.toJSON(), y: this.y.toJSON(), z: this.z.toJSON() }; }

  static fromJSON(data) {
    if (data instanceof VectorCurve) return data;
    const curve = new VectorCurve({ name: data?.name ?? 'VectorCurve' });
    if (data?.x) curve.x = FloatCurve.fromJSON(data.x);
    if (data?.y) curve.y = FloatCurve.fromJSON(data.y);
    if (data?.z) curve.z = FloatCurve.fromJSON(data.z);
    return curve;
  }
}

/**
 * A named set of curves, looked up by string — what a weapon config or a VFX asset stores.
 */
export class CurveLibrary {
  constructor({ name = 'Curves' } = {}) {
    this.name = name;
    /** @type {Map<string, FloatCurve|VectorCurve>} */
    this.curves = new Map();
  }

  add(name, curve) {
    this.curves.set(name, curve ?? new FloatCurve({ name }));
    return this.curves.get(name);
  }

  /** Curves are looked up case-insensitively: assets, console commands and code disagree on case. */
  get(name) {
    if (this.curves.has(name)) return this.curves.get(name);
    const lower = String(name).toLowerCase();
    for (const [key, curve] of this.curves) if (key.toLowerCase() === lower) return curve;
    return null;
  }
  has(name) { return this.get(name) !== null; }
  /** The registered key for a (possibly differently-cased) name. */
  keyFor(name) {
    if (this.curves.has(name)) return name;
    const lower = String(name).toLowerCase();
    for (const key of this.curves.keys()) if (key.toLowerCase() === lower) return key;
    return null;
  }
  names() { return [...this.curves.keys()].sort(); }
  evaluate(name, time, fallback = 0) {
    const curve = this.curves.get(name);
    if (!curve) return fallback;
    const value = curve.evaluate(time);
    return typeof value === 'object' ? value : value;
  }

  /** Bulk load: `{ 'DamageFalloff': [[0, 1], [40, 0.5]] }`. */
  load(definition) {
    for (const [name, data] of Object.entries(definition ?? {})) {
      if (Array.isArray(data)) this.add(name).addKeys(data);
      else if (data && typeof data === 'object' && data.keys) this.add(name, data.keys.length && Array.isArray(data.keys[0]) ? undefined : FloatCurve.fromJSON(data));
    }
    return this;
  }

  describe() { return { name: this.name, curves: this.names().map((name) => ({ name, keys: this.curves.get(name).keys?.length ?? this.curves.get(name).count ?? 0 })) }; }

  installConsoleCommands(console_) {
    const library = this;
    console_.registerCommand({
      name: 'curves', aliases: ['curve.list'], category: 'Curves', description: 'Lists curves and their key counts.',
      execute: () => library.names().map((name) => `${name.padEnd(24)} ${(library.get(name).count ?? library.get(name).keys)} keys`).join('\n') || 'no curves',
    });
    console_.registerCommand({
      name: 'curve.plot', category: 'Curves', description: 'Plots a curve in the console.',
      args: [{ name: 'name' }, { name: 'width', type: 'int', required: false, min: 20, max: 120, default: 60 }],
      execute: (args) => library.get(args.name)?.plot?.({ width: args.width }) ?? `no curve "${args.name}"`,
    });
    console_.registerCommand({
      name: 'curve.eval', category: 'Curves', description: 'Evaluates a curve at a time.',
      args: [{ name: 'name' }, { name: 'time', type: 'number' }],
      execute: (args) => {
        const curve = library.get(args.name);
        if (!curve) return `no curve "${args.name}"`;
        return JSON.stringify(curve.evaluate(args.time));
      },
    });
    return console_;
  }
}

/** Shooter-ready presets, so the common curves are named rather than re-derived per project. */
export function shooterCurvePresets() {
  const damageFalloff = new FloatCurve({ name: 'DamageFalloff', interp: CurveInterp.Linear });
  damageFalloff.addKeys([[0, 1], [25, 1], [50, 0.6], [100, 0.25]]);

  const accuracySpread = new FloatCurve({ name: 'AccuracySpread', interp: CurveInterp.Auto });
  accuracySpread.addKeys([[0, 1], [10, 0.85], [30, 0.6], [80, 0.4]]);

  // Recoil climb: fast rise over the first six rounds, then it settles into a plateau.
  const recoilPitch = new FloatCurve({ name: 'RecoilPitch', interp: CurveInterp.Auto });
  recoilPitch.addKeys([[0, 0], [0.08, 0.55], [0.16, 0.95], [0.4, 1.4], [0.9, 1.55], [1.6, 1.6]]);

  const recoilYaw = new FloatCurve({ name: 'RecoilYaw', interp: CurveInterp.Auto });
  recoilYaw.addKeys([[0, 0], [0.1, 0.3], [0.3, -0.2], [0.6, 0.15], [1.2, -0.05], [1.6, 0]]);

  const adsTransition = new FloatCurve({ name: 'AdsTransition', interp: CurveInterp.Cubic });
  adsTransition.addKeys([[0, 0], [0.12, 0.75], [0.22, 1]]);

  const muzzleFlash = new FloatCurve({ name: 'MuzzleFlash', interp: CurveInterp.Linear });
  muzzleFlash.addKeys([[0, 1], [0.04, 0.35], [0.09, 0]]);

  return { damageFalloff, accuracySpread, recoilPitch, recoilYaw, adsTransition, muzzleFlash };
}

// ------------------------------------------------------------------ helpers

/** Cubic Hermite basis, with tangents already scaled by the segment length. */
function hermite(valueA, valueB, outTangent, inTangent, alpha) {
  const alpha2 = alpha * alpha;
  const alpha3 = alpha2 * alpha;
  return (2 * alpha3 - 3 * alpha2 + 1) * valueA
    + (alpha3 - 2 * alpha2 + alpha) * outTangent
    + (-2 * alpha3 + 3 * alpha2) * valueB
    + (alpha3 - alpha2) * inTangent;
}

/** Catmull-Rom slope for a key, used when a tangent was not set explicitly. */
function autoSlope(keys, index) {
  if (index <= 0) {
    const next = keys[1];
    const first = keys[0];
    return next ? (next.value - first.value) / Math.max(1e-9, next.time - first.time) : 0;
  }
  if (index >= keys.length - 1) {
    const previous = keys[keys.length - 2];
    const last = keys[keys.length - 1];
    return previous ? (last.value - previous.value) / Math.max(1e-9, last.time - previous.time) : 0;
  }
  const before = keys[index - 1];
  const after = keys[index + 1];
  const slopeIn = (keys[index].value - before.value) / Math.max(1e-9, keys[index].time - before.time);
  const slopeOut = (after.value - keys[index].value) / Math.max(1e-9, after.time - keys[index].time);
  // A peak or trough keeps a zero tangent, which is what stops overshoot at a maximum.
  if (slopeIn * slopeOut <= 0) return 0;
  return (slopeIn + slopeOut) / 2;
}

function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }

export default FloatCurve;
