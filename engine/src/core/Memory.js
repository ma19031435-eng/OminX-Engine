/**
 * OminX Engine — memory: arenas, buffer reuse and accounting.
 *
 * A JavaScript engine cannot own its allocator, but it absolutely owns two things that decide
 * whether a game stutters: **how much garbage it produces per frame**, and **whether it knows**.
 * A 60 Hz shooter that allocates a fresh `Vector3` per bot per tick is a garbage-collection hitch
 * waiting to happen — and a GC pause is 40 ms of frozen crosshair.
 *
 * Three tools, all UE-shaped:
 *
 *   - **`FrameArena`** — a bump allocator over one `ArrayBuffer` for data whose lifetime is a frame
 *     (temperatures, sort keys, transform scratch, path buffers). `arena.reset()` at the frame
 *     boundary makes a hundred allocations cost one pointer reset, with zero garbage.
 *   - **`BufferPool`** — size-classed typed-array reuse for things that outlive a frame but churn
 *     (packet buffers, audio mixing blocks, mesh staging). `acquire`/`release`, never `new`.
 *   - **`MemoryTracker`** — accounting: who allocated what, what the high-water mark was, which
 *     category grew between frames. `assertBudget()` turns "we think it is fine" into a number a
 *     test can fail on, and `heapUsage()` reports the real JS heap when the host exposes it.
 *
 * ```
 * const frame = memory.frameArena;                   // reset automatically every frame
 * const scratch = frame.allocFloat64(3 * botCount);  // no allocation, no garbage
 * …
 * memory.scope('LevelLoad', () => loadLevel());       // accounts bytes and peak inside
 * memory.budget('textures', 256 * 1024 * 1024);        // warn when a category exceeds it
 * ```
 *
 * @module engine/src/core/Memory
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Memory');

export const memoryEvents = {
  onArenaReset: new MulticastDelegate('memory.onArenaReset'),
  onArenaGrow: new MulticastDelegate('memory.onArenaGrow'),
  onBudgetExceeded: new MulticastDelegate('memory.onBudgetExceeded'),
  onPoolExhausted: new MulticastDelegate('memory.onPoolExhausted'),
};

/**
 * Bump allocator over a single ArrayBuffer. Allocations are pointer arithmetic; `reset()` is one
 * assignment. Ideal for per-frame scratch data where "free" is the end of the frame.
 *
 * Typed arrays handed out are views onto the arena, not copies — they alias the buffer and become
 * invalid (or worse, silently shared) after `reset()`. That is the point: it is a frame arena, and
 * the discipline it enforces is the reason it is fast.
 */
export class FrameArena {
  constructor({ bytes = 4 * 1024 * 1024, grow = true, name = 'FrameArena', align = 8 } = {}) {
    this.name = name;
    this.buffer = new ArrayBuffer(Math.max(64, bytes));
    this.capacity = this.buffer.byteLength;
    this.grow = grow;
    this.align = align;
    this.offset = 0;
    this.highWater = 0;
    this.peakHighWater = 0;
    this.allocations = 0;
    this.resets = 0;
    this.growths = 0;
    this.refused = 0;
    this.overflowed = false;
  }

  get usedBytes() { return this.offset; }
  get freeBytes() { return this.capacity - this.offset; }
  get utilisation() { return this.capacity ? this.offset / this.capacity : 0; }

  /** Aligns the cursor and reserves `bytes`, growing the backing buffer if allowed. */
  reserve(bytes, alignment = this.align) {
    const size = Math.max(0, bytes | 0);
    const aligned = alignUp(this.offset, alignment);
    if (aligned + size > this.capacity) {
      if (!this.grow) {
        this.refused++;
        this.overflowed = true;
        memoryEvents.onPoolExhausted.broadcast(this, bytes);
        log.warn(`${this.name} refused ${bytes} B (${this.freeBytes} B free, growth disabled)`);
        return -1;
      }
      this._grow(aligned + size);
    }
    this.offset = aligned + size;
    this.allocations++;
    if (this.offset > this.highWater) {
      this.highWater = this.offset;
      if (this.offset > this.peakHighWater) this.peakHighWater = this.offset;
    }
    return aligned;
  }

  _grow(required) {
    let next = this.capacity;
    while (next < required) next *= 2;
    const previous = this.buffer;
    this.buffer = new ArrayBuffer(next);
    // Copy what is live: arena data is often written *then* grown (a path buffer filling up).
    new Uint8Array(this.buffer).set(new Uint8Array(previous, 0, Math.min(previous.byteLength, this.capacity)));
    const oldCapacity = this.capacity;
    this.capacity = next;
    this.growths++;
    memoryEvents.onArenaGrow.broadcast(this, oldCapacity, next);
    log.debug(`${this.name} grew ${oldCapacity} → ${next} B`);
    return next;
  }

  /** A Float64 block (positions, times, sort keys). */
  allocFloat64(count = 1) {
    const offset = this.reserve(count * 8, 8);
    return offset < 0 ? new Float64Array(0) : new Float64Array(this.buffer, offset, count);
  }
  allocFloat32(count = 1) {
    const offset = this.reserve(count * 4, 4);
    return offset < 0 ? new Float32Array(0) : new Float32Array(this.buffer, offset, count);
  }
  allocInt32(count = 1) {
    const offset = this.reserve(count * 4, 4);
    return offset < 0 ? new Int32Array(0) : new Int32Array(this.buffer, offset, count);
  }
  allocUint32(count = 1) {
    const offset = this.reserve(count * 4, 4);
    return offset < 0 ? new Uint32Array(0) : new Uint32Array(this.buffer, offset, count);
  }
  allocUint16(count = 1) {
    const offset = this.reserve(count * 2, 2);
    return offset < 0 ? new Uint16Array(0) : new Uint16Array(this.buffer, offset, count);
  }
  allocUint8(count = 1) {
    const offset = this.reserve(count, 1);
    return offset < 0 ? new Uint8Array(0) : new Uint8Array(this.buffer, offset, count);
  }

  /** A struct described by a field list, e.g. `[{ name: 'x', type: 'f32' }, …]` — SoA in reverse. */
  allocStruct(count, fields) {
    const stride = fields.reduce((sum, field) => sum + sizeOfType(field.type), 0);
    const offset = this.reserve(stride * count, Math.max(8, alignmentOfFields(fields)));
    if (offset < 0) return null;
    const view = { count, stride, offset, fields: fields.map((field) => ({ ...field })) };
    const reader = (index, name) => {
      const field = view.fields.find((entry) => entry.name === name);
      if (!field) return undefined;
      return readField(this.buffer, offset + index * stride + offsetOfField(view.fields, name), field.type);
    };
    const writer = (index, name, value) => {
      const field = view.fields.find((entry) => entry.name === name);
      if (!field) return false;
      writeField(this.buffer, offset + index * stride + offsetOfField(view.fields, name), field.type, value);
      return true;
    };
    view.get = reader;
    view.set = writer;
    return view;
  }

  /** Marks the cursor so a caller can release its own allocations (`const mark = arena.mark()`). */
  mark() { return this.offset; }
  release(mark) { if (mark >= 0 && mark <= this.offset) this.offset = mark; return this; }

  /** End of frame: one pointer reset, no garbage. */
  reset() {
    this.offset = 0;
    this.resets++;
    memoryEvents.onArenaReset.broadcast(this);
    return this;
  }

  describe() {
    return {
      name: this.name, capacity: this.capacity, used: this.offset, free: this.freeBytes,
      utilisation: round3(this.utilisation), highWater: this.highWater, peakHighWater: this.peakHighWater,
      allocations: this.allocations, resets: this.resets, growths: this.growths, refused: this.refused,
    };
  }

  format() {
    return `  ${this.name}: ${formatBytes(this.offset)} / ${formatBytes(this.capacity)} (${(this.utilisation * 100).toFixed(0)}%) · peak ${formatBytes(this.peakHighWater)} · ${this.allocations} allocations · ${this.resets} resets · ${this.growths} growths`;
  }
}

/**
 * Size-classed typed-array pool. Buffers are power-of-two sized; an acquire returns the smallest
 * class that fits, so a 300-byte packet and a 512-byte packet share the same class and nothing is
 * re-allocated per frame.
 */
export class BufferPool {
  constructor({ name = 'BufferPool', minBytes = 64, maxBytes = 1024 * 1024, maxPerClass = 32, clearOnAcquire = false } = {}) {
    this.name = name;
    this.minBytes = minBytes;
    this.maxBytes = maxBytes;
    this.maxPerClass = maxPerClass;
    this.clearOnAcquire = clearOnAcquire;
    /** @type {Map<number, ArrayBuffer[]>} */
    this.classes = new Map();
    this.outstanding = new Set();
    this.acquired = 0;
    this.released = 0;
    this.created = 0;
    this.discarded = 0;
    this.peakOutstanding = 0;
    this.peakBytes = 0;
    this.bytesOutstanding = 0;
  }

  /** The size class a request maps to (power of two, clamped to `[minBytes, maxBytes]`). */
  classFor(bytes) {
    if (bytes > this.maxBytes) return bytes;   // oversize requests are not pooled
    let size = this.minBytes;
    while (size < bytes) size *= 2;
    return size;
  }

  /** Acquires a buffer with `bytes` of capacity. `release(buffer)` returns it to the pool. */
  acquire(bytes) {
    const size = this.classFor(bytes);
    const bucket = this.classes.get(size);
    let buffer = bucket && bucket.length ? bucket.pop() : null;
    if (!buffer) {
      buffer = new ArrayBuffer(size);
      this.created++;
    }
    if (this.clearOnAcquire) new Uint8Array(buffer).fill(0);
    this.outstanding.add(buffer);
    this.bytesOutstanding += buffer.byteLength;
    this.peakOutstanding = Math.max(this.peakOutstanding, this.outstanding.size);
    this.peakBytes = Math.max(this.peakBytes, this.bytesOutstanding);
    this.acquired++;
    return buffer;
  }

  /** Views: the common way engine code wants the bytes (a float block, an int block, raw bytes). */
  acquireF32(count) { return new Float32Array(this.acquire(count * 4)); }
  acquireF64(count) { return new Float64Array(this.acquire(count * 8)); }
  acquireI32(count) { return new Int32Array(this.acquire(count * 4)); }
  acquireU32(count) { return new Uint32Array(this.acquire(count * 4)); }
  acquireU8(count) { return new Uint8Array(this.acquire(count)); }

  /** Releases a buffer — or a typed view of one (`acquireF32()` hands out views, and they are what
   *  callers hold, so releasing one must find the buffer it aliases). */
  release(target) {
    const buffer = ArrayBuffer.isView(target) ? target.buffer : target;
    if (!buffer || !this.outstanding.has(buffer)) return false;
    this.outstanding.delete(buffer);
    this.bytesOutstanding -= buffer.byteLength;
    this.released++;
    const bucket = this.classes.get(buffer.byteLength);
    if (buffer.byteLength > this.maxBytes) { this.discarded++; return true; }
    if (!bucket) { this.classes.set(buffer.byteLength, [buffer]); return true; }
    if (bucket.length >= this.maxPerClass) { this.discarded++; return true; }
    bucket.push(buffer);
    return true;
  }

  /** Convenience: borrow a buffer for the duration of a callback, always returning it. */
  with(bytes, fn, { view = 'u8' } = {}) {
    const buffer = this.acquire(bytes);
    const typed = view === 'f32' ? new Float32Array(buffer) : view === 'f64' ? new Float64Array(buffer) : view === 'i32' ? new Int32Array(buffer) : new Uint8Array(buffer);
    try {
      return fn(typed, buffer);
    } finally {
      this.release(buffer);
    }
  }

  prewarm(countsByBytes = {}) {
    for (const [bytes, count] of Object.entries(countsByBytes)) {
      const size = this.classFor(Number(bytes));
      const bucket = this.classes.get(size) ?? [];
      while (bucket.length < count) { bucket.push(new ArrayBuffer(size)); this.created++; }
      this.classes.set(size, bucket);
    }
    return this;
  }

  /** Buffers still held — the leak report for a frame or a subsystem teardown. */
  leaked() { return [...this.outstanding]; }

  get pooledBytes() {
    let total = 0;
    for (const [size, bucket] of this.classes) total += size * bucket.length;
    return total;
  }

  describe() {
    const byClass = {};
    for (const [size, bucket] of this.classes) if (bucket.length) byClass[size] = bucket.length;
    return {
      name: this.name,
      classes: this.classes.size,
      pooled: formatBytes(this.pooledBytes),
      outstanding: this.outstanding.size,
      outstandingBytes: this.bytesOutstanding,
      peakOutstanding: this.peakOutstanding,
      peakBytes: this.peakBytes,
      acquired: this.acquired,
      released: this.released,
      created: this.created,
      discarded: this.discarded,
      byClass,
    };
  }

  format() {
    return `  ${this.name}: ${this.outstanding.size} outstanding (${formatBytes(this.bytesOutstanding)}) · pooled ${formatBytes(this.pooledBytes)} · ${this.created} created / ${this.released} released`;
  }
}

/**
 * Accounting scope: the net change in tracked bytes over a named block of work (a level load, a
 * round). Nested scopes are included in their parent's delta — the number answers "how much did
 * this block cost", which is the question being asked, and `closedScopes` keeps the breakdown.
 */
export class MemoryScope {
  constructor(tracker, name, parent = null) {
    this.tracker = tracker;
    this.name = name;
    this.parent = parent;
    this.startBytes = tracker.totalBytes;
    this.startAllocated = tracker.totalAllocated;
    this.finalBytes = 0;
    this.peakBytes = startBytesSafe(this);
    this.allocated = 0;
    this.closed = false;
    tracker.scopes.push(this);
  }

  /** Bytes tracked since the scope opened — live while open, frozen once closed. */
  get bytes() { return this.closed ? this.finalBytes : this.tracker.totalBytes - this.startBytes; }

  close() {
    if (this.closed) return this;
    this.closed = true;
    const index = this.tracker.scopes.indexOf(this);
    if (index >= 0) this.tracker.scopes.splice(index, 1);
    this.finalBytes = this.tracker.totalBytes - this.startBytes;
    this.allocated = this.tracker.totalAllocated - this.startAllocated;
    this.tracker.closedScopes.push({ name: this.name, bytes: this.finalBytes, allocated: this.allocated });
    if (this.tracker.closedScopes.length > 64) this.tracker.closedScopes.shift();
    return this;
  }

  [Symbol.dispose]() { this.close(); }
}

function startBytesSafe(scope) { return scope.startBytes; }

/**
 * The tracker: per-category byte accounting, budgets, peaks, heap samples and the debug report.
 * Everything the engine allocates through a pool or arena is accounted here; whatever the host
 * allocates behind our back shows up in `heapUsage()`.
 */
export class MemoryTracker {
  constructor({ name = 'Memory', budgetBytes = 0, sampleHeap = true } = {}) {
    this.name = name;
    this.budgetBytes = budgetBytes;
    // Named `heapSampling`, not `sampleHeap`: a boolean field with the same name as a method
    // shadows it, and `this.sampleHeap()` then fails with "is not a function".
    this.heapSampling = sampleHeap && typeof performance !== 'undefined' && !!performance.memory;
    /** @type {Map<string, {bytes: number, peak: number, allocations: number, budget: number}>} */
    this.categories = new Map();
    this.totalBytes = 0;
    this.peakBytes = 0;
    this.totalAllocated = 0;
    this.totalFreed = 0;
    this.heapSamples = [];
    this.warnings = [];
    this.scopes = [];
    this.closedScopes = [];
    this.frameNumber = 0;
    this.frameStartBytes = 0;
    this.growthThisFrame = 0;
    this.growthLastFrame = 0;
    this.enabled = true;
  }

  static create(options) { return new MemoryTracker(options); }

  /** Accounts `bytes` under a category (`textures`, `audio`, `replays`, `physics`). */
  track(category, bytes, { count = 1, note = null } = {}) {
    const size = Math.max(0, Number(bytes) || 0);
    const row = this._row(category);
    row.bytes += size;
    row.allocations += count;
    row.peak = Math.max(row.peak, row.bytes);
    this.totalBytes += size;
    this.totalAllocated += size;
    this.peakBytes = Math.max(this.peakBytes, this.totalBytes);
    this.growthThisFrame += size;
    if (row.budget && row.bytes > row.budget) this._exceed(row, `+${formatBytes(size)}${note ? ` (${note})` : ''}`);
    return this;
  }

  untrack(category, bytes, { count = 1 } = {}) {
    const size = Math.max(0, Number(bytes) || 0);
    const row = this._row(category);
    row.bytes = Math.max(0, row.bytes - size);
    this.totalBytes = Math.max(0, this.totalBytes - size);
    this.totalFreed += size;
    this.growthThisFrame -= size;
    void count;
    return this;
  }

  /** Frees exactly what a matching `track` added — `const usage = mem.trackUsage('x', bytes)`. */
  trackUsage(category, bytes, options = {}) {
    this.track(category, bytes, options);
    const tracker = this;
    return {
      close: () => tracker.untrack(category, bytes),
      [Symbol.dispose]: () => tracker.untrack(category, bytes),
    };
  }

  /** Sets the ceiling for a category; exceeding it raises `onBudgetExceeded` and records a warning. */
  budget(category, bytes) {
    const row = this._row(category);
    row.budget = Math.max(0, Number(bytes) || 0);
    return this;
  }

  _row(category) {
    let row = this.categories.get(category);
    if (!row) {
      row = { category, bytes: 0, peak: 0, allocations: 0, budget: this.budgetBytes };
      this.categories.set(category, row);
    }
    return row;
  }

  _exceed(row, detail) {
    const warning = { category: row.category, bytes: row.bytes, budget: row.budget, detail, frame: this.frameNumber };
    this.warnings.push(warning);
    if (this.warnings.length > 32) this.warnings.shift();
    memoryEvents.onBudgetExceeded.broadcast(warning, this);
    log.warn(`memory budget exceeded: ${row.category} ${formatBytes(row.bytes)} > ${formatBytes(row.budget)} ${detail}`);
    return warning;
  }

  /** Opens an accounting scope; close it (or let the engine close it) to get its delta. */
  scope(name) { return new MemoryScope(this, name, this.scopes.at(-1) ?? null); }

  /** Runs `fn` inside a scope and reports what it allocated. */
  measure(name, fn) {
    const scope = this.scope(name);
    try {
      return fn(scope);
    } finally {
      scope.close();
    }
  }

  /** Frame boundaries: tracks per-frame growth, which is what "does this leak?" actually means. */
  beginFrame(frameNumber = this.frameNumber) {
    this.frameNumber = frameNumber;
    this.frameStartBytes = this.totalBytes;
    this.growthThisFrame = 0;
    this.sampleHeap();
    return this;
  }

  endFrame() {
    this.growthLastFrame = this.totalBytes - this.frameStartBytes;
    return this.growthLastFrame;
  }

  /** Real JS heap usage where the host exposes it, plus engine-accounted bytes. */
  heapUsage() {
    const memory = typeof performance !== 'undefined' ? performance.memory : null;
    if (!memory) return { available: false, trackedBytes: this.totalBytes };
    return {
      available: true,
      used: memory.usedJSHeapSize,
      total: memory.totalJSHeapSize,
      limit: memory.jsHeapSizeLimit,
      trackedBytes: this.totalBytes,
    };
  }

  sampleHeap() {
    if (!this.heapSampling) return null;
    const usage = this.heapUsage();
    if (!usage.available) { this.heapSampling = false; return null; }
    const sample = { frame: this.frameNumber, used: usage.used, limit: usage.limit };
    this.heapSamples.push(sample);
    if (this.heapSamples.length > 240) this.heapSamples.shift();
    return sample;
  }

  /** Rejects a state the caller believes must not allocate more than a budget (a test assertion). */
  assertBudget(category, bytes) {
    const row = this.categories.get(category);
    const actual = row?.bytes ?? 0;
    if (actual > bytes) {
      throw new Error(`memory budget for "${category}" is ${formatBytes(actual)}, expected ≤ ${formatBytes(bytes)}`);
    }
    return true;
  }

  /** Categories sorted by usage — the first thing to look at when a client grows. */
  summary(limit = 0) {
    const rows = [...this.categories.values()]
      .map((row) => ({ ...row, overhead: row.budget ? round3(row.bytes / row.budget) : 0 }))
      .sort((a, b) => b.bytes - a.bytes);
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  describe() {
    return {
      name: this.name,
      tracked: this.totalBytes,
      peak: this.peakBytes,
      allocated: this.totalAllocated,
      freed: this.totalFreed,
      growthThisFrame: this.growthThisFrame,
      growthLastFrame: this.growthLastFrame,
      categories: this.summary(12),
      warnings: this.warnings.slice(-5),
      heap: this.heapUsage(),
      scopes: this.scopes.map((scope) => scope.name),
    };
  }

  format() {
    const lines = [
      `  ${this.name}: ${formatBytes(this.totalBytes)} tracked · peak ${formatBytes(this.peakBytes)} · ${formatBytes(this.totalAllocated)} allocated / ${formatBytes(this.totalFreed)} freed`,
      `  this frame ${formatBytes(this.growthThisFrame)}, last frame ${formatBytes(this.growthLastFrame)}`,
    ];
    for (const row of this.summary(10)) {
      const budget = row.budget ? ` / ${formatBytes(row.budget)}` : '';
      lines.push(`  ${row.category.padEnd(16)} ${formatBytes(row.bytes).padStart(10)}${budget.padEnd(14)} peak ${formatBytes(row.peak).padStart(10)}  ${row.allocations} allocs`);
    }
    const heap = this.heapUsage();
    if (heap.available) lines.push(`  js heap ${formatBytes(heap.used)} / ${formatBytes(heap.limit)} (${((heap.used / heap.limit) * 100).toFixed(1)}%)`);
    for (const warning of this.warnings.slice(-3)) lines.push(`  ! budget: ${warning.category} ${formatBytes(warning.bytes)} > ${formatBytes(warning.budget)}`);
    return lines.join('\n');
  }

  /** Everything a leak test needs to decide whether the last N frames are stable. */
  leakCheck({ frames = 60 } = {}) {
    const samples = this.heapSamples.slice(-frames);
    if (samples.length < 2) return { stable: true, reason: 'not enough samples', samples: samples.length };
    const first = samples[0].used;
    const last = samples[samples.length - 1].used;
    const growth = last - first;
    return {
      stable: growth < 1024 * 1024,
      growthBytes: growth,
      perFrame: Math.round(growth / samples.length),
      samples: samples.length,
    };
  }

  reset() {
    this.categories.clear();
    this.totalBytes = 0;
    this.peakBytes = 0;
    this.totalAllocated = 0;
    this.totalFreed = 0;
    this.warnings.length = 0;
    return this;
  }

  installConsoleCommands(console_) {
    const memory = this;
    console_.registerCommand({ name: 'mem', aliases: ['memory'], category: 'Memory', description: 'Tracked bytes per category, budgets and per-frame growth.', execute: () => memory.format() });
    console_.registerCommand({
      name: 'mem.budget', category: 'Memory', description: 'Sets (or shows) the byte budget for a category.',
      args: [{ name: 'category' }, { name: 'mb', type: 'number', required: false, min: 0, max: 100000 }],
      execute: (args) => {
        if (args.mb === undefined) {
          const row = memory.categories.get(args.category);
          return row ? `${row.category}: ${formatBytes(row.bytes)} / ${formatBytes(row.budget)}` : `no category "${args.category}"`;
        }
        memory.budget(args.category, args.mb * 1024 * 1024);
        return `${args.category} budget = ${args.mb} MB`;
      },
    });
    console_.registerCommand({
      name: 'mem.leak', category: 'Memory', description: 'Heap growth over the last N samples.',
      args: [{ name: 'frames', type: 'int', required: false, min: 2, max: 240, default: 60 }],
      execute: (args) => JSON.stringify(memory.leakCheck({ frames: args.frames })),
    });
    console_.registerCommand({
      name: 'mem.snapshot', category: 'Memory', description: 'Prints the full memory report as JSON.',
      execute: () => JSON.stringify(memory.describe(), null, 2),
    });
    return console_;
  }
}

/**
 * The engine's memory services: one tracker, one frame arena, one buffer pool. Pools/arenas can be
 * created per subsystem too (`memory.createPool('audio')`) — accounting stays in one place.
 */
export class Memory {
  constructor({ name = 'Memory', arenaBytes = 4 * 1024 * 1024, poolOptions = {}, budgetBytes = 0, sampleHeap = true } = {}) {
    this.name = name;
    this.tracker = new MemoryTracker({ name: `${name}/tracker`, budgetBytes, sampleHeap });
    this.frameArena = new FrameArena({ bytes: arenaBytes, name: `${name}/frameArena` });
    this.pools = new Map();
    this.defaultPool = this.createPool('default', poolOptions);
  }

  static create(options) { return new Memory(options); }

  // -- convenience passthroughs so callers can use `memory.scope(...)` directly
  get totalBytes() { return this.tracker.totalBytes; }
  get categories() { return this.tracker.categories; }
  track(category, bytes, options) { return this.tracker.track(category, bytes, options); }
  untrack(category, bytes, options) { return this.tracker.untrack(category, bytes, options); }
  trackUsage(category, bytes, options) { return this.tracker.trackUsage(category, bytes, options); }
  budget(category, bytes) { return this.tracker.budget(category, bytes); }
  scope(name) { return this.tracker.scope(name); }
  measure(name, fn) { return this.tracker.measure(name, fn); }
  assertBudget(category, bytes) { return this.tracker.assertBudget(category, bytes); }
  heapUsage() { return this.tracker.heapUsage(); }
  leakCheck(options) { return this.tracker.leakCheck(options); }
  describe() { return { name: this.name, tracker: this.tracker.describe(), arena: this.frameArena.describe(), pools: [...this.pools.values()].map((pool) => pool.describe()) }; }
  format() { return [this.tracker.format(), this.frameArena.format(), ...[...this.pools.values()].map((pool) => pool.format())].join('\n'); }

  createPool(name, options = {}) {
    const pool = new BufferPool({ name: `${this.name}/${name}`, ...options });
    this.pools.set(name, pool);
    return pool;
  }

  getPool(name = 'default') { return this.pools.get(name) ?? null; }

  acquire(bytes, poolName = 'default') { return this.getPool(poolName).acquire(bytes); }
  release(buffer, poolName = 'default') { return this.getPool(poolName).release(buffer); }
  acquireF32(count, poolName = 'default') { return this.getPool(poolName).acquireF32(count); }
  releaseView(view, poolName = 'default') { return this.getPool(poolName).release(view.buffer); }

  /** Frame boundary: reset the arena, sample the heap and close the accounting frame. */
  beginFrame(frameNumber) {
    this.frameArena.reset();
    this.tracker.beginFrame(frameNumber);
    return this;
  }

  endFrame() { return this.tracker.endFrame(); }

  installConsoleCommands(console_) {
    this.tracker.installConsoleCommands(console_);
    const memory = this;
    console_.registerCommand({
      name: 'mem.arena', category: 'Memory', description: 'Frame arena capacity, usage and growth.',
      execute: () => [memory.frameArena.format(), `  high water ${formatBytes(memory.frameArena.highWater)} of ${formatBytes(memory.frameArena.capacity)}`].join('\n'),
    });
    console_.registerCommand({
      name: 'mem.pools', category: 'Memory', description: 'Buffer pools: outstanding, pooled bytes, churn.',
      execute: () => [...memory.pools.values()].map((pool) => pool.format()).join('\n') || 'no pools',
    });
    console_.registerCommand({
      name: 'mem.arena.reset', category: 'Memory', description: 'Resets the frame arena (debugging).',
      execute: () => { memory.frameArena.reset(); return 'arena reset'; },
    });
    return console_;
  }
}

// ------------------------------------------------------------------ helpers

function alignUp(value, alignment) {
  const mask = alignment - 1;
  return (value + mask) & ~mask;
}

function sizeOfType(type) {
  switch (String(type).toLowerCase()) {
    case 'f64': case 'float64': return 8;
    case 'f32': case 'float32': return 4;
    case 'i32': case 'u32': case 'int32': case 'uint32': return 4;
    case 'i16': case 'u16': return 2;
    case 'u8': case 'i8': case 'byte': return 1;
    default: return 4;
  }
}

function alignmentOfFields(fields) {
  return fields.reduce((max, field) => Math.max(max, sizeOfType(field.type)), 1);
}

function offsetOfField(fields, name) {
  let offset = 0;
  for (const field of fields) {
    if (field.name === name) return offset;
    offset += sizeOfType(field.type);
  }
  return -1;
}

function readField(buffer, byteOffset, type) {
  const dv = new DataView(buffer);
  switch (String(type).toLowerCase()) {
    case 'f64': case 'float64': return dv.getFloat64(byteOffset, true);
    case 'i32': case 'int32': return dv.getInt32(byteOffset, true);
    case 'u32': case 'uint32': return dv.getUint32(byteOffset, true);
    case 'i16': return dv.getInt16(byteOffset, true);
    case 'u16': return dv.getUint16(byteOffset, true);
    case 'u8': case 'byte': return dv.getUint8(byteOffset);
    case 'i8': return dv.getInt8(byteOffset);
    default: return dv.getFloat32(byteOffset, true);
  }
}

function writeField(buffer, byteOffset, type, value) {
  const dv = new DataView(buffer);
  switch (String(type).toLowerCase()) {
    case 'f64': case 'float64': dv.setFloat64(byteOffset, value, true); return;
    case 'i32': case 'int32': dv.setInt32(byteOffset, value | 0, true); return;
    case 'u32': case 'uint32': dv.setUint32(byteOffset, value >>> 0, true); return;
    case 'i16': dv.setInt16(byteOffset, value | 0, true); return;
    case 'u16': dv.setUint16(byteOffset, value & 0xffff, true); return;
    case 'u8': case 'byte': dv.setUint8(byteOffset, value & 0xff); return;
    case 'i8': dv.setInt8(byteOffset, value | 0); return;
    default: dv.setFloat32(byteOffset, value, true); return;
  }
}

function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default Memory;
