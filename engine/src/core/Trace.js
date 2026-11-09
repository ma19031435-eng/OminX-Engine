/**
 * OminX Engine — tracing and profiling.
 *
 * A frame budget is spent in places the FPS counter cannot show you: a 3 ms job that only runs on
 * map load, a physics broadphase that spikes when four bots step out of cover, a texture upload that
 * blocks the GPU. UE answers this with Unreal Insights and `TRACE_CPUPROFILER_EVENT_SCOPE`; this is
 * the same idea sized for a browser tab.
 *
 * ```
 * const scope = trace.begin('PlayerThink', 'ai');        // ~50 ns when tracing is off
 * …work…
 * scope.end();
 *
 * trace.scope('PhysicsStep', 'physics', () => world.step(dt));   // wraps automatically
 * trace.instant('ShotFired', 'combat', { weapon: 'rifle' });     // a marker, not a duration
 * trace.counter('Bots/Alive', 7);
 * ```
 *
 * Design rules that make it usable in a shipping build:
 *   - **Off by default, and free when off.** Disabled trace points check one boolean; nothing is
 *     allocated, no timestamps are read.
 *   - **Bounded memory.** Events land in a fixed-capacity ring buffer, so a 40-minute session records
 *     the *recent* past instead of growing until the tab dies. Overflow is counted, never silent.
 *   - **Categories.** `trace.setCategories(['physics', 'render'])` records only what you are chasing —
 *     the difference between a 5 % and a 40 % frame overhead.
 *   - **Chrome/Perfetto export.** `trace.exportChrome()` produces the trace-event JSON that
 *     `chrome://tracing` and Perfetto load directly, with durations, counters and frame markers.
 *   - **Aggregates.** `trace.top(10)` is the same data summarised per name (calls, total, average,
 *     worst) for a headless soak run or a test assertion.
 *
 * @module engine/src/core/Trace
 */
import { MulticastDelegate } from './Delegate.js';
import { RingBuffer } from './Containers.js';
import { createLogger } from './Logger.js';

const log = createLogger('Trace');

export const traceEvents = {
  onStarted: new MulticastDelegate('trace.onStarted'),
  onStopped: new MulticastDelegate('trace.onStopped'),
  onFrame: new MulticastDelegate('trace.onFrame'),
  onOverflow: new MulticastDelegate('trace.onOverflow'),
};

/**
 * A single recorded event, stored in a packed form so a ring of 200k events stays reasonable.
 * Durations are microseconds, matching the Chrome trace format.
 */
export class TraceEvent {
  constructor(name, category, phase, start, duration = 0, args = null, thread = 0, level = 'default') {
    this.name = name;
    this.category = category;
    this.phase = phase;          // 'B'/'E' begin/end, 'X' complete, 'i' instant, 'C' counter
    this.start = start;          // µs since trace start
    this.duration = duration;    // µs
    this.args = args;            // small objects only; large payloads belong in a log
    this.thread = thread;
    this.level = level;
  }

  get end() { return this.start + this.duration; }
  get durationMs() { return this.duration / 1000; }
  /** Chrome trace event form. */
  toChrome(pid = 1) {
    const event = { name: this.name, cat: this.category, ph: this.phase, ts: round3(this.start), pid, tid: this.thread, s: 't' };
    if (this.phase === 'X') { event.dur = round3(this.duration); delete event.s; }
    if (this.phase === 'C') { delete event.s; event.args = this.args ?? {}; }
    else if (this.args) event.args = this.args;
    return event;
  }
}

/** Handle returned by `begin()`. Calling `end()` twice is a no-op, not a double-counted event. */
export class TraceScope {
  constructor(trace, name, category, args = null, thread = 0) {
    this.trace = trace;
    this.name = name;
    this.category = category;
    this.args = args;
    this.thread = thread;
    this.startUs = trace.nowUs();
    this.ended = false;
    this.paused = false;
    this.accumulated = 0;
    this.childMs = 0;
    this.parent = null;
  }

  /** Pauses the clock (I/O waits that should not count against the frame). */
  pause() { if (!this.ended && !this.paused) { this.accumulated += this.trace.nowUs() - this.startUs; this.paused = true; } return this; }
  resume() { if (!this.ended && this.paused) { this.startUs = this.trace.nowUs(); this.paused = false; } return this; }

  /** Records a nested scope inside this one, tracking inclusive/exclusive time. */
  child(name, category = null, args = null) {
    const scope = this.trace.begin(name, category ?? this.category, args, this.thread);
    scope.parent = this;
    return scope;
  }

  end(args = null) {
    if (this.ended) return 0;
    this.ended = true;
    if (!this.paused) this.accumulated += this.trace.nowUs() - this.startUs;
    const selfMs = this.accumulated / 1000;
    if (this.parent) this.parent.childMs += selfMs;
    this.trace.record(new TraceEvent(this.name, this.category, 'X', this.startUs, Math.max(0, this.accumulated), { ...(this.args ?? {}), ...(args ?? {}) }, this.thread));
    return selfMs;
  }

  /** Inclusive duration in ms — the wall time of the scope, children included. */
  get endMs() { return this.accumulated / 1000; }

  [Symbol.dispose]() { this.end(); }
}

/**
 * The recorder. Owns the ring buffer, category filter, aggregation table and export.
 * Disabled by default; enable per session (a console command, a URL flag, a test).
 */
export class Trace {
  constructor({ capacity = 200000, enabled = false, categories = null, stats = null, threads = null, sampleCounters = true } = {}) {
    this.capacity = Math.max(1024, capacity);
    this.enabled = !!enabled;
    this.categories = categories ? new Set(categories) : null;
    this.stats = stats;
    this.sampleCounters = sampleCounters;
    /** @type {RingBuffer} fixed-capacity event ring — the recent past, never unbounded. */
    this.buffer = new RingBuffer(this.capacity);
    this.threads = new Map([[0, 'main']]);
    if (threads) for (const [id, name] of Object.entries(threads)) this.threads.set(Number(id), name);
    this.startUs = 0;
    this.eventCount = 0;
    this.dropped = 0;
    this.overflowEvents = 0;
    this.frameNumber = 0;
    this.frameStartUs = 0;
    this.frameMarkers = new RingBuffer(4096);
    this.counters = new Map();
    this.aggregates = new Map();
    this.activeScopes = [];
    this.depth = 0;
    this.maxDepth = 0;
    this._now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.startUs = this.nowUs();
    if (this.enabled) this._startClock();
  }

  static create(options) { return new Trace(options); }

  // ------------------------------------------------------------------ control
  start({ categories = null } = {}) {
    this.enabled = true;
    if (categories) this.categories = new Set(categories);
    this._startClock();
    traceEvents.onStarted.broadcast(this);
    log.info(`tracing on — ${this.buffer.capacity} event ring, categories ${this.categories ? [...this.categories].join('/') : 'all'}`);
    return this;
  }

  stop() {
    if (!this.enabled) return this;
    this.enabled = false;
    traceEvents.onStopped.broadcast(this);
    log.info(`tracing off — ${this.eventCount} events, ${this.dropped} dropped`);
    return this;
  }

  _startClock() {
    // Emit `W` (metadata) events for the thread names so a viewer labels rows correctly.
    for (const [id, name] of this.threads) this.recordInstant(`thread_name`, 'metadata', { name }, id);
  }

  setCategories(categories) {
    this.categories = categories ? new Set(categories) : null;
    return this;
  }

  /** True when an event with this category would be recorded (checked by hot paths). */
  accepts(category) {
    if (!this.enabled) return false;
    if (!this.categories) return true;
    return this.categories.has(category);
  }

  registerThread(id, name) {
    this.threads.set(id, name);
    if (this.enabled) this.recordInstant('thread_name', 'metadata', { name }, id);
    return this;
  }

  nowUs() { return this._now() * 1000; }

  /** A scope on the named thread — workers call this with their own id. */
  withThread(id, name = null) {
    if (name) this.registerThread(id, name);
    const trace = this;
    return {
      begin: (eventName, category = 'default', args = null) => trace.begin(eventName, category, args, id),
      scope: (eventName, category, fn, args) => trace.scope(eventName, category, fn, id, args),
      instant: (eventName, category = 'default', eventArgs = null) => trace.instant(eventName, category, eventArgs, id),
    };
  }

  // ------------------------------------------------------------------ recording
  /**
   * Opens a scope. Returns a lightweight handle whose `end()` records the duration. Hot paths can
   * check `trace.enabled` once and keep a permanent handle.
   */
  begin(name, category = 'default', args = null, thread = 0) {
    const scope = new TraceScope(this, name, category, args, thread);
    if (this.accepts(category)) {
      this.depth++;
      if (this.depth > this.maxDepth) this.maxDepth = this.depth;
    }
    return scope;
  }

  /** Convenience for a synchronous block (kept allocation-light: one handle, one event). */
  scope(name, category, fn, thread = 0, args = null) {
    if (!this.accepts(category)) return fn();
    const scope = this.begin(name, category, args, thread);
    try {
      return fn(scope);
    } catch (error) {
      scope.end({ error: error?.message ?? String(error) });
      throw error;
    } finally {
      scope.end();
    }
  }

  /** Wraps an async function; the await time counts toward the scope unless you `pause()` it. */
  async scopeAsync(name, category, fn, thread = 0, args = null) {
    if (!this.accepts(category)) return fn();
    const scope = this.begin(name, category, args, thread);
    try {
      return await fn(scope);
    } catch (error) {
      scope.end({ error: error?.message ?? String(error) });
      throw error;
    } finally {
      scope.end();
    }
  }

  /** A point-in-time marker (`ShotFired`, `MapLoaded`, `Alloc/Stall`). */
  instant(name, category = 'default', args = null, thread = 0) {
    if (!this.accepts(category)) return null;
    return this.recordInstant(name, category, args, thread);
  }

  recordInstant(name, category, args, thread) {
    const event = new TraceEvent(name, category, 'i', this.nowUs() - this.startUs, 0, args, thread);
    this.record(event);
    return event;
  }

  /** A counter sample; counters are exported as time series and keep the last value for the HUD. */
  counter(name, value, { category = 'counter', args = null } = {}) {
    this.counters.set(name, value);
    if (!this.sampleCounters || !this.accepts(category)) return value;
    const event = new TraceEvent(name, category, 'C', this.nowUs() - this.startUs, 0, { value, ...(args ?? {}) }, 0);
    this.record(event);
    return value;
  }

  getCounter(name, fallback = 0) { return this.counters.get(name) ?? fallback; }

  /** Frame boundaries: every event can then be attributed to a frame by a viewer or by a test. */
  beginFrame(frameNumber = ++this.frameNumber) {
    this.frameNumber = frameNumber;
    this.frameStartUs = this.nowUs();
    if (this.enabled) this.recordInstant(`Frame ${frameNumber}`, 'frame');
    traceEvents.onFrame.broadcast(frameNumber, this);
    return this;
  }

  endFrame() {
    const duration = this.nowUs() - this.frameStartUs;
    this.frameMarkers.push({ frame: this.frameNumber, start: this.frameStartUs - this.startUs, duration });
    return duration;
  }

  /** Writes an event into the ring, aggregating it and reporting overflow. */
  record(event) {
    if (!this.enabled) return event;
    const overwritten = this.buffer.push(event);
    if (overwritten !== undefined) {
      this.dropped++;
      this.overflowEvents++;
      // Report once per ring's worth of losses, not once per event.
      if (this.overflowEvents % this.capacity === 0) traceEvents.onOverflow.broadcast(this, this.overflowEvents);
    }
    this.eventCount++;
    if (event.phase === 'X') this._aggregate(event);
    this.stats?.timing(`Trace/${event.category}`, event.durationMs);
    return event;
  }

  _aggregate(event) {
    let row = this.aggregates.get(event.name);
    if (!row) {
      row = { name: event.name, category: event.category, calls: 0, totalMs: 0, maxMs: 0, lastMs: 0, totalCalls: 0 };
      this.aggregates.set(event.name, row);
    }
    row.calls++;
    row.totalCalls++;
    row.lastMs = event.durationMs;
    row.totalMs += event.durationMs;
    if (event.durationMs > row.maxMs) row.maxMs = event.durationMs;
    // Keep the per-window average honest across resets.
    row.averageMs = row.totalMs / row.calls;
    return row;
  }

  // ------------------------------------------------------------------ analysis
  /** Aggregates sorted by total time (or by name/category with `sortBy`). */
  top(limit = 10, { sortBy = 'total', category = null, minMs = 0 } = {}) {
    let rows = [...this.aggregates.values()];
    if (category) rows = rows.filter((row) => row.category === category);
    if (minMs > 0) rows = rows.filter((row) => row.totalMs >= minMs);
    rows.sort((a, b) => (sortBy === 'calls' ? b.calls - a.calls : sortBy === 'max' ? b.maxMs - a.maxMs : b.totalMs - a.totalMs));
    return rows.slice(0, limit).map((row) => ({
      ...row,
      averageMs: round3(row.calls ? row.totalMs / row.calls : 0),
      totalMs: round3(row.totalMs),
      maxMs: round3(row.maxMs),
      lastMs: round3(row.lastMs),
    }));
  }

  /** Everything recorded for one frame (or every event when `frame` is null). */
  events({ category = null, name = null, phase = null, since = 0, limit = 0 } = {}) {
    let rows = this.buffer.toArray().filter((event) => event.start >= since);
    if (category) rows = rows.filter((event) => event.category === category);
    if (name) rows = rows.filter((event) => event.name === name);
    if (phase) rows = rows.filter((event) => event.phase === phase);
    if (limit > 0) rows = rows.slice(-limit);
    return rows;
  }

  /** Categories seen so far, with event counts — what to pass to `setCategories`. */
  categorySummary() {
    const summary = new Map();
    for (const event of this.buffer.toArray()) {
      const row = summary.get(event.category) ?? { category: event.category, events: 0, totalMs: 0 };
      row.events++;
      row.totalMs += event.durationMs;
      summary.set(event.category, row);
    }
    return [...summary.values()].sort((a, b) => b.totalMs - a.totalMs).map((row) => ({ ...row, totalMs: round3(row.totalMs) }));
  }

  /** Frame durations recorded via `beginFrame`/`endFrame` (µs → ms). */
  frameTimes({ limit = 240 } = {}) {
    const markers = this.frameMarkers.toArray();
    return (limit > 0 ? markers.slice(-limit) : markers).map((marker) => ({ frame: marker.frame, ms: round3(marker.duration / 1000) }));
  }

  /** Chrome trace-event JSON. Browser: download or POST it. Node: write it and open Perfetto. */
  exportChrome({ pid = 1, metadata = true } = {}) {
    const out = [];
    if (metadata) {
      out.push({ name: 'process_name', ph: 'M', pid, tid: 0, args: { name: 'OminX' } });
      for (const [id, name] of this.threads) out.push({ name: 'thread_name', ph: 'M', pid, tid: id, args: { name } });
    }
    for (const event of this.buffer.toArray()) {
      if (event.name === 'thread_name' && event.args?.name) continue;   // already emitted as metadata
      out.push(event.toChrome(pid));
    }
    for (const marker of this.frameMarkers.toArray()) {
      out.push({ name: 'Frame', cat: 'frame', ph: 'X', ts: round3(marker.start), dur: round3(marker.duration), pid, tid: 0 });
    }
    return { traceEvents: out, displayTimeUnit: 'ms' };
  }

  exportJson(options) { return JSON.stringify(this.exportChrome(options)); }

  // ------------------------------------------------------------------ reporting
  /** Text table for a console command, a CI log, or a soak-run report. */
  format({ limit = 12, sortBy = 'total', category = null } = {}) {
    const rows = this.top(limit, { sortBy, category });
    const lines = [
      `  trace ${this.enabled ? 'ON ' : 'off'} · ${this.eventCount} events (${this.dropped} dropped) · ${this.buffer.length}/${this.buffer.capacity} in ring · depth ${this.maxDepth}`,
      '',
      `  ${'name'.padEnd(28)} ${'calls'.padStart(8)} ${'total ms'.padStart(10)} ${'avg ms'.padStart(9)} ${'max ms'.padStart(9)}  category`,
    ];
    for (const row of rows) {
      lines.push(`  ${row.name.padEnd(28)} ${String(row.calls).padStart(8)} ${String(row.totalMs).padStart(10)} ${String(row.averageMs).padStart(9)} ${String(row.maxMs).padStart(9)}  ${row.category}`);
    }
    if (!rows.length) lines.push('  (no events recorded)');
    const categories = this.categorySummary().slice(0, 6);
    if (categories.length) lines.push('', `  categories: ${categories.map((row) => `${row.category} ${row.totalMs}ms/${row.events}`).join('  ')}`);
    return lines.join('\n');
  }

  describe() {
    return {
      enabled: this.enabled,
      filter: this.categories ? [...this.categories] : null,
      events: this.eventCount,
      dropped: this.dropped,
      capacity: this.capacity,
      buffered: this.buffer.length,
      frames: this.frameMarkers.length,
      depth: this.depth,
      maxDepth: this.maxDepth,
      counters: Object.fromEntries(this.counters),
      top: this.top(8),
      categories: this.categorySummary(),
    };
  }

  /** Clears events and aggregates but keeps the configuration (a fresh measurement window). */
  reset({ keepEnabled = true } = {}) {
    this.buffer.clear();
    this.frameMarkers.clear();
    this.aggregates.clear();
    this.counters.clear();
    this.eventCount = 0;
    this.dropped = 0;
    this.maxDepth = 0;
    this.startUs = this.nowUs();
    if (!keepEnabled) this.enabled = false;
    return this;
  }

  /** Console commands: `trace on physics`, `trace top 15`, `trace reset`, `trace export`. */
  installConsoleCommands(console_) {
    const trace = this;
    console_.registerCommand({
      name: 'trace', aliases: ['trace.status'], category: 'Trace', description: 'Tracing state and the hottest recorded scopes.',
      args: [{ name: 'count', type: 'int', min: 1, max: 100, required: false, default: 12 }],
      execute: (args) => trace.format({ limit: args.count }),
    });
    console_.registerCommand({
      name: 'trace.start', aliases: ['trace.on'], category: 'Trace', description: 'Starts recording, optionally limited to categories.',
      args: [{ name: 'categories', required: false, description: 'comma-separated category filter' }],
      execute: (args) => {
        const categories = args.categories ? String(args.categories).split(',').map((entry) => entry.trim()).filter(Boolean) : null;
        trace.start({ categories });
        return `tracing on${categories ? ` (${categories.join(', ')})` : ''}`;
      },
    });
    console_.registerCommand({
      name: 'trace.stop', aliases: ['trace.off'], category: 'Trace', description: 'Stops recording.',
      execute: () => { trace.stop(); return 'tracing off'; },
    });
    console_.registerCommand({
      name: 'trace.top', category: 'Trace', description: 'Hottest scopes by total, average or worst time.',
      args: [{ name: 'sort', type: 'enum', values: ['total', 'average', 'max', 'calls'], required: false, default: 'total' }, { name: 'count', type: 'int', min: 1, max: 100, required: false, default: 15 }],
      execute: (args) => { const sortBy = args.sort === 'average' ? 'total' : args.sort; return trace.format({ limit: args.count, sortBy }); },
    });
    console_.registerCommand({
      name: 'trace.reset', category: 'Trace', description: 'Clears recorded events and aggregates.',
      execute: () => { trace.reset(); return 'trace reset'; },
    });
    console_.registerCommand({
      name: 'trace.export', aliases: ['trace.dump'], category: 'Trace', description: 'Prints Chrome trace-event JSON (pipe it to a file to open in Perfetto).',
      execute: () => trace.exportJson(),
    });
    console_.registerCommand({
      name: 'trace.categories', category: 'Trace', description: 'Categories recorded so far, with total time.',
      execute: () => trace.categorySummary().map((row) => `${row.category.padEnd(16)} ${String(row.events).padStart(8)} events ${String(row.totalMs).padStart(10)} ms`).join('\n') || 'nothing recorded',
    });
    return console_;
  }
}

function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }

/** A trace point that costs one boolean check when tracing is off. */
export function traceScope(trace, name, category, fn) {
  if (!trace || !trace.accepts(category)) return fn();
  return trace.scope(name, category, fn);
}

/** The process-wide trace, so libraries can `begin()` without plumbing a reference. */
export const trace = new Trace({ enabled: false });

/** `traceScoped('Physics', () => …)` — module-level convenience on the shared trace. */
export function traceScoped(name, category, fn) {
  return trace.accepts(category) ? trace.scope(name, category, fn) : fn();
}

export default Trace;
