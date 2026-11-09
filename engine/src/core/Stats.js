/**
 * OminX Engine — instrumentation, scoped timers and performance capture.
 *
 * Every engine subsystem reports through this one object, so the perf HUD, the editor's stat panels,
 * the CI benchmark and the console commands all read the same numbers. Two rules keep it usable in a
 * shipping build:
 *
 *   1. **Off means off.** `setEnabled(false)` makes `scope()`/`count()` no-ops; the hot path pays one
 *      boolean check, and the scopes themselves never allocate.
 *   2. **Cheap in the middle.** Timings accumulate into preallocated structures; a *frame* record is
 *      only materialized when a consumer asks (`captureFrame()`), which is once per frame at most.
 *
 * `Stats.scope('Physics')` returns a reusable scope object: `scope.begin(); …; scope.end();`. For
 * one-liners use the `measure(name, fn)` helper, or `withScope(name, fn)` which is exception-safe.
 *
 * @module engine/src/core/Stats
 */
import { RingBuffer } from './Containers.js';
import { createLogger } from './Logger.js';

const log = createLogger('Stats');

export const StatUnit = { Time: 'ms', Bytes: 'B', Count: 'count', Ratio: '%', Rate: 'per s' };

/** A single tracked value: accumulator, peak, count and a rolling history for graphs. */
export class Stat {
  constructor(name, { unit = StatUnit.Time, history = 120, group = 'General' } = {}) {
    this.name = name;
    this.unit = unit;
    this.group = group;
    this.value = 0;         // last committed value (per frame / per tick)
    this.accumulator = 0;   // in-flight accumulation (nested timers)
    this.total = 0;
    this.count = 0;
    this.peak = 0;
    this.min = Infinity;
    this.average = 0;
    this.history = new RingBuffer(history, 0);
    this.lastFrameValue = 0;
  }

  add(amount) {
    this.accumulator += amount;
    return this;
  }

  set(value) {
    this.accumulator = value;
    return this;
  }

  /** Commits the accumulator into the per-frame value and pushes it to history. */
  commit() {
    this.value = this.accumulator;
    this.lastFrameValue = this.value;
    this.total += this.value;
    this.count++;
    this.peak = Math.max(this.peak, this.value);
    this.min = Math.min(this.min, this.value);
    this.average = this.count ? this.total / this.count : 0;
    this.history.push(this.value);
    this.accumulator = 0;
    return this;
  }

  reset() {
    this.value = 0; this.accumulator = 0; this.total = 0; this.count = 0;
    this.peak = 0; this.min = Infinity; this.average = 0;
    this.history.clear();
    return this;
  }

  describe() {
    return {
      name: this.name, group: this.group, unit: this.unit,
      value: round(this.value), average: round(this.average), peak: round(this.peak),
      min: this.min === Infinity ? 0 : round(this.min), count: this.count,
      total: round(this.total),
    };
  }
}

function round(value) { return Math.round(value * 1000) / 1000; }

/** Reusable scope handle handed out by `Stats.scope()`. Nesting is supported per stat. */
export class StatScope {
  constructor(stats, stat) {
    this.stats = stats;
    this.stat = stat;
    this.depth = 0;
    this._start = 0;
  }

  begin() {
    if (!this.stats.enabled) return this;
    if (this.depth === 0) this._start = this.stats.now();
    this.depth++;
    return this;
  }

  end() {
    if (!this.stats.enabled || this.depth === 0) return this;
    this.depth--;
    if (this.depth === 0) this.stat.add(this.stats.now() - this._start);
    return this;
  }

  /** Runs `fn` inside the scope; the scope closes even if it throws. */
  measure(fn) {
    this.begin();
    try { return fn(); } finally { this.end(); }
  }

  async measureAsync(fn) {
    this.begin();
    try { return await fn(); } finally { this.end(); }
  }
}

/** Histogram with fixed buckets — frame times, packet sizes, path lengths. */
export class Histogram {
  constructor(name, { buckets = null, unit = StatUnit.Time } = {}) {
    this.name = name;
    this.unit = unit;
    this.buckets = buckets ?? [1, 2, 4, 8, 16, 33, 66, 133, 266, 1000];
    this.counts = new Uint32Array(this.buckets.length + 1);
    this.count = 0;
    this.total = 0;
    this.max = 0;
  }

  record(value) {
    this.count++;
    this.total += value;
    this.max = Math.max(this.max, value);
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) { this.counts[i]++; return this; }
    }
    this.counts[this.buckets.length]++;
    return this;
  }

  get average() { return this.count ? this.total / this.count : 0; }
  get p50() { return this.percentile(0.5); }

  percentile(p) {
    if (!this.count) return 0;
    const target = this.count * p;
    let running = 0;
    for (let i = 0; i < this.counts.length; i++) {
      running += this.counts[i];
      if (running >= target) return i < this.buckets.length ? this.buckets[i] : this.max;
    }
    return this.max;
  }

  reset() { this.counts.fill(0); this.count = 0; this.total = 0; this.max = 0; return this; }

  describe() {
    return {
      name: this.name, unit: this.unit, count: this.count,
      average: round(this.average), p50: round(this.p50), p95: round(this.percentile(0.95)),
      max: round(this.max),
    };
  }
}

/**
 * The stats system. One instance per engine; subsystems call `stats.scope('Name')` once at
 * construction and reuse the scope every frame.
 */
export class Stats {
  constructor({ enabled = true, history = 120, budgetMs = 16.7 } = {}) {
    this.enabled = !!enabled;
    this.budgetMs = budgetMs;
    /** @type {Map<string, Stat>} */
    this.stats = new Map();
    /** @type {Map<string, StatScope>} */
    this.scopes = new Map();
    /** @type {Map<string, Histogram>} */
    this.histograms = new Map();
    /** @type {Map<string, number>} gauges: current value, not accumulated */
    this.gauges = new Map();
    /** @type {Map<string, number>} counters: monotonically increasing totals */
    this.counters = new Map();
    this.frame = 0;
    this.frames = new RingBuffer(history, null);
    this.frameHistory = new RingBuffer(history, 0);
    this.slowFrames = 0;
    this.captureCount = 0;
    this._frameStart = 0;
    this._frameStats = [];
    this.now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  static create(options) { return new Stats(options); }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) {
      for (const stat of this.stats.values()) stat.reset();
      this.scopes.clear();
    }
    return this;
  }

  // ------------------------------------------------------------------ timings
  _stat(name, options = {}) {
    let stat = this.stats.get(name);
    if (!stat) {
      stat = new Stat(name, options);
      this.stats.set(name, stat);
      this._frameStats.push(stat);
    }
    return stat;
  }

  /** A reusable timing scope. Call once per subsystem, then begin/end every frame. */
  scope(name, options = {}) {
    let scope = this.scopes.get(name);
    if (!scope) {
      scope = new StatScope(this, this._stat(name, options));
      this.scopes.set(name, scope);
    }
    return scope;
  }

  /** Times a synchronous function. */
  measure(name, fn, options = {}) {
    if (!this.enabled) return fn();
    const scope = this.scope(name, options);
    scope.begin();
    try { return fn(); } finally { scope.end(); }
  }

  /** Times an async function. */
  async measureAsync(name, fn, options = {}) {
    if (!this.enabled) return fn();
    const scope = this.scope(name, options);
    scope.begin();
    try { return await fn(); } finally { scope.end(); }
  }

  /** Adds a time sample directly (already-measured durations). */
  timing(name, ms, options = {}) {
    if (!this.enabled) return this;
    this._stat(name, options).add(ms);
    return this;
  }

  // ------------------------------------------------------------------ values
  /** Increments a monotonic counter (bullets fired, packets dropped, chunks streamed). */
  count(name, amount = 1) {
    if (!this.enabled) return 0;
    const next = (this.counters.get(name) ?? 0) + amount;
    this.counters.set(name, next);
    return next;
  }

  getCounter(name) { return this.counters.get(name) ?? 0; }

  /** Sets a gauge (current entity count, memory in use, active clients). */
  gauge(name, value) {
    this.gauges.set(name, value);
    return value;
  }

  getGauge(name, fallback = 0) { return this.gauges.get(name) ?? fallback; }

  /** Accumulates a value that is reported per frame (bytes allocated, damage dealt). */
  accumulate(name, amount, options = {}) {
    if (!this.enabled) return this;
    this._stat(name, { unit: StatUnit.Count, ...options }).add(amount);
    return this;
  }

  /** Feeds a histogram (frame time distribution, packet size distribution). */
  record(name, value, options = {}) {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = new Histogram(name, options);
      this.histograms.set(name, histogram);
    }
    histogram.record(value);
    return this;
  }

  getHistogram(name) { return this.histograms.get(name) ?? null; }

  get(name) { return this.stats.get(name) ?? null; }
  value(name) { return this.stats.get(name)?.value ?? 0; }

  // ------------------------------------------------------------------ frames
  /** Marks the start of a frame; every stat's accumulator is committed at the end. */
  beginFrame() {
    this._frameStart = this.now();
    this.frame++;
    return this;
  }

  /**
   * Ends the frame: commits every stat, records frame time, detects budget overruns and captures a
   * frame record. Returns the frame record.
   */
  endFrame(extra = null) {
    const frameMs = this.now() - this._frameStart;
    for (const stat of this._frameStats) stat.commit();
    this.frameHistory.push(frameMs);
    if (frameMs > this.budgetMs) this.slowFrames++;
    return this.captureFrame({ frameMs, ...extra });
  }

  /** Materializes this frame's numbers (for the HUD, the logs or the CI benchmark). */
  captureFrame(extra = {}) {
    this.captureCount++;
    const record = {
      frame: this.frame,
      frameMs: round(extra.frameMs ?? (this.now() - this._frameStart)),
      stats: {},
      gauges: Object.fromEntries(this.gauges),
      counters: Object.fromEntries(this.counters),
      ...extra,
    };
    for (const [name, stat] of this.stats) record.stats[name] = round(stat.value);
    this.frames.push(record);
    return record;
  }

  /** Latest capture (HUD). */
  get latestFrame() { return this.frames.last; }

  /** Rolling frame-time statistics: mean, p50, p95, p99 and the slow-frame percentage. */
  getFrameStats() {
    const history = this.frameHistory;
    if (!history.length) return { frames: 0, mean: 0, p50: 0, p95: 0, p99: 0, slowPct: 0, fps: 0, budgetMs: this.budgetMs };
    const mean = history.average();
    return {
      frames: history.length,
      mean: round(mean),
      p50: round(history.percentile(0.5)),
      p95: round(history.percentile(0.95)),
      p99: round(history.percentile(0.99)),
      slowPct: round((this.slowFrames / Math.max(1, this.frame)) * 100),
      fps: mean > 0 ? Math.round(1000 / mean) : 0,
      budgetMs: this.budgetMs,
    };
  }

  /** Everything an operator needs, as one plain object. */
  getReport() {
    const groups = {};
    for (const [name, stat] of this.stats) {
      groups[stat.group] ??= {};
      groups[stat.group][name] = stat.describe();
    }
    return {
      enabled: this.enabled,
      frame: this.frame,
      frames: this.getFrameStats(),
      stats: groups,
      gauges: Object.fromEntries(this.gauges),
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries([...this.histograms].map(([name, histogram]) => [name, histogram.describe()])),
    };
  }

  /** Human-readable table — the `stats` console command and the perf overlay source. */
  format({ group = null, limit = 24 } = {}) {
    const rows = [];
    for (const stat of this.stats.values()) {
      if (group && stat.group !== group) continue;
      rows.push(stat);
    }
    rows.sort((a, b) => b.value - a.value);
    const lines = [`  ${'stat'.padEnd(26)} ${'current'.padStart(10)} ${'avg'.padStart(10)} ${'peak'.padStart(10)}  unit`];
    for (const stat of rows.slice(0, limit)) {
      lines.push(`  ${stat.name.padEnd(26)} ${String(round(stat.value)).padStart(10)} ${String(round(stat.average)).padStart(10)} ${String(round(stat.peak)).padStart(10)}  ${stat.unit}`);
    }
    if (this.gauges.size) {
      lines.push('', '  gauges');
      for (const [name, value] of this.gauges) lines.push(`  ${name.padEnd(26)} ${String(round(typeof value === 'number' ? value : Number(value) || 0)).padStart(10)}`);
    }
    if (this.counters.size) {
      lines.push('', '  counters');
      for (const [name, value] of this.counters) lines.push(`  ${name.padEnd(26)} ${String(value).padStart(10)}`);
    }
    const frame = this.getFrameStats();
    lines.push('', `  frame ${frame.mean} ms mean · ${frame.p95} ms p95 · ${frame.fps} fps · ${frame.slowPct}% over budget`);
    return lines.join('\n');
  }

  /** Writes the report through the engine log (console `stats` command). */
  dump(options = {}) {
    log.info(`\n${this.format(options)}`);
    return this;
  }

  reset() {
    for (const stat of this.stats.values()) stat.reset();
    for (const histogram of this.histograms.values()) histogram.reset();
    this.counters.clear();
    this.frames.clear();
    this.frameHistory.clear();
    this.frame = 0;
    this.slowFrames = 0;
    return this;
  }
}

/** Process-wide default instance: subsystems that do not get one injected use this. */
export const stats = new Stats();

/** Shorthand for the pattern `const s = scope('Thing'); s.begin(); …; s.end();`. */
export function withScope(name, fn, options) {
  return stats.measure(name, fn, options);
}

export default Stats;
