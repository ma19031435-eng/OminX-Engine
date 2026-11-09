/**
 * OminX Engine — allocation-aware containers.
 *
 * Game loops cannot afford to allocate on the hot path: a 60 Hz simulation with a few hundred
 * entities issues hundreds of thousands of small array/object allocations per second, and the GC
 * pauses that follow are visible as frame spikes. Every container here exists to remove one
 * specific per-frame allocation pattern:
 *
 *   - `ObjectPool` — bullets, tracers, impact effects, net packets (the classic churn sources).
 *   - `RingBuffer` — the last N snapshots / input frames / frame timings, with overwrite semantics.
 *   - `Deque` — work queues that push and shift every frame.
 *   - `PriorityQueue` — A* open lists (already used by the nav graph), scheduler queues.
 *   - `SparseSet` — entity → component storage: O(1) add/remove/lookup with cache-friendly density.
 *   - `FreeList` — stable integer handles (slots in descriptor heaps, uniform rings).
 *   - `BitSet` — layer masks and visibility sets, with fast and/or/andNot.
 *
 * Nothing here knows about the rest of the engine: they are plain data structures with tests.
 *
 * @module engine/src/core/Containers
 */

/**
 * Fixed-capacity pool. `acquire()` returns a recycled item or creates one; `release()` returns it.
 * The pool never grows past `capacity` unless `grow` is set — that is the point: an unbounded pool
 * is just a leak with extra steps.
 */
export class ObjectPool {
  /**
   * @param {() => any} factory creates a new item when the pool is empty
   * @param {object} [opts] `{ capacity = 64, grow = true, reset = null, onAcquire = null, onRelease = null }`
   */
  constructor(factory, opts = {}) {
    if (typeof factory !== 'function') throw new TypeError('ObjectPool needs a factory function');
    this.factory = factory;
    this.capacity = opts.capacity ?? 64;
    this.grow = opts.grow !== false;
    this.reset = opts.reset ?? null;
    this.onAcquire = opts.onAcquire ?? null;
    this.onRelease = opts.onRelease ?? null;
    /** @type {any[]} */
    this.free = [];
    this.active = new Set();
    this.created = 0;
    this.acquired = 0;
    this.released = 0;
    this.peak = 0;
    this.missed = 0;           // acquire() calls that had to create a new object
    this.rejected = 0;         // acquire() calls refused because the pool was at capacity
  }

  static create(factory, opts) { return new ObjectPool(factory, opts); }

  /** An item plus a stable release function: `const { item, release } = pool.take()`. */
  take() {
    const item = this.acquire();
    return { item, release: () => this.release(item) };
  }

  acquire() {
    this.acquired++;
    const item = this.free.pop();
    if (item !== undefined) {
      this.active.add(item);
      this.peak = Math.max(this.peak, this.active.size);
      this.onAcquire?.(item);
      return item;
    }
    if (!this.grow && this.created >= this.capacity) {
      this.rejected++;
      return null;
    }
    this.missed++;
    const created = this.factory();
    this.created++;
    this.active.add(created);
    this.peak = Math.max(this.peak, this.active.size);
    this.onAcquire?.(created);
    return created;
  }

  /** Returns an item to the pool. Double-release is ignored (a common bug source). */
  release(item) {
    if (item === null || item === undefined) return false;
    if (!this.active.has(item)) return false;
    this.active.delete(item);
    this.released++;
    this.reset?.(item);
    this.onRelease?.(item);
    if (this.free.length < this.capacity) this.free.push(item);
    return true;
  }

  /** Releases everything currently checked out. */
  releaseAll() {
    let count = 0;
    for (const item of [...this.active]) if (this.release(item)) count++;
    return count;
  }

  get available() { return this.free.length; }
  get inUse() { return this.active.size; }
  get size() { return this.created; }

  stats() {
    return {
      created: this.created, available: this.available, inUse: this.inUse, peak: this.peak,
      acquired: this.acquired, released: this.released, missed: this.missed, rejected: this.rejected,
    };
  }
}

/** Preallocated fixed-size pool: no factory calls after construction, no growth, no allocation. */
export class FixedPool extends ObjectPool {
  constructor(factory, count, opts = {}) {
    super(factory, { ...opts, capacity: count, grow: false });
    for (let i = 0; i < count; i++) {
      this.free.push(this.factory());
      this.created++;
    }
  }
}

/**
 * Circular buffer with overwrite semantics — "keep the last N" without array shifting.
 * Used for snapshot history, input redundancy windows and frame-time graphs.
 */
export class RingBuffer {
  constructor(capacity = 64, fill = null) {
    if (capacity <= 0) throw new RangeError('RingBuffer capacity must be positive');
    this.capacity = capacity;
    this.buffer = new Array(capacity).fill(fill);
    this.head = 0;      // next write index
    this.length = 0;    // valid entries
    this.total = 0;     // entries ever written (monotonic — useful for sequence numbers)
  }

  push(value) {
    const overwritten = this.length === this.capacity ? this.buffer[this.head] : undefined;
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.length < this.capacity) this.length++;
    this.total++;
    return overwritten;
  }

  /** Oldest → newest. */
  toArray() {
    const out = new Array(this.length);
    const start = this.length === this.capacity ? this.head : 0;
    for (let i = 0; i < this.length; i++) out[i] = this.buffer[(start + i) % this.capacity];
    return out;
  }

  /** Index 0 is the newest entry. */
  at(index) {
    if (index < 0 || index >= this.length) return undefined;
    return this.buffer[(this.head - 1 - index + this.capacity * 2) % this.capacity];
  }

  get first() { return this.at(this.length - 1); }
  get last() { return this.at(0); }
  get isFull() { return this.length === this.capacity; }
  get isEmpty() { return this.length === 0; }

  /** Average of numeric entries (frame-time smoothing, packet-size stats). */
  average() {
    if (!this.length) return 0;
    let sum = 0;
    for (let i = 0; i < this.length; i++) sum += this.buffer[i];
    return sum / this.length;
  }

  /** Percentile of numeric entries; `0.95` → p95. Copies + sorts, so call it off the hot path. */
  percentile(p) {
    if (!this.length) return 0;
    const values = [];
    for (let i = 0; i < this.length; i++) values.push(this.buffer[i]);
    values.sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.max(0, Math.floor(values.length * p)))];
  }

  clear() {
    this.buffer.fill(undefined);
    this.head = 0;
    this.length = 0;
    return this;
  }

  [Symbol.iterator]() {
    let index = 0;
    const size = this.length;
    const self = this;
    return {
      next() {
        if (index >= size) return { done: true, value: undefined };
        return { done: false, value: self.at(index++) };
      },
    };
  }
}

/** Double-ended queue built on a single array with front spaces (amortised O(1) push/shift). */
export class Deque {
  constructor(iterable = null) {
    this._items = [];
    this._start = 0;
    if (iterable) for (const item of iterable) this.pushBack(item);
  }

  pushBack(item) { this._items.push(item); return this; }
  pushFront(item) {
    if (this._start > 0) this._items[--this._start] = item;
    else { this._items.unshift(item); this._start = 0; }
    return this;
  }
  popBack() { return this.length ? this._items.pop() : undefined; }
  popFront() {
    if (!this.length) return undefined;
    const item = this._items[this._start];
    this._items[this._start++] = undefined;
    if (this._start > 64 && this._start * 2 > this._items.length) {
      this._items = this._items.slice(this._start);
      this._start = 0;
    }
    return item;
  }
  get front() { return this._items[this._start]; }
  get back() { return this._items[this._items.length - 1]; }
  get length() { return this._items.length - this._start; }
  get isEmpty() { return this.length === 0; }
  clear() { this._items.length = 0; this._start = 0; return this; }
  toArray() { return this._items.slice(this._start); }
  [Symbol.iterator]() {
    let index = this._start;
    const end = this._items.length;
    const items = this._items;
    return { next: () => (index < end ? { done: false, value: items[index++] } : { done: true, value: undefined }) };
  }
}

/**
 * Binary-heap priority queue with an optional stable tie-break, used by A* and by the job graph.
 * `pop()` returns [item, priority]; `popItem()` returns just the item.
 */
export class PriorityQueue {
  /**
   * @param {object} [options]
   * @param {(a: number, b: number) => number} [options.compare] priority comparison (default numeric)
   * @param {boolean} [options.stable=true] equal priorities pop in insertion order
   * @param {boolean} [options.minQueue=true] false pops the *highest* priority first, which is what
   *   "priority" almost always means in engine code (delegates, job scheduling, work queues)
   */
  constructor({ compare = null, stable = true, minQueue = true } = {}) {
    /** @type {Array<[any, number, number]>} [item, priority, sequence] */
    this.heap = [];
    this._sequence = 0;
    this.stable = stable;
    this.minQueue = minQueue;
    this.compare = compare ?? ((a, b) => a - b);
  }

  static create(options) { return new PriorityQueue(options); }

  get size() { return this.heap.length; }
  get isEmpty() { return this.heap.length === 0; }
  clear() { this.heap.length = 0; return this; }

  /** Insertion order preserving: deterministic results for equal priorities. */
  push(item, priority = 0) {
    const entry = [item, priority, this._sequence++];
    this.heap.push(entry);
    this._bubbleUp(this.heap.length - 1);
    return this;
  }
  enqueue(item, priority) { return this.push(item, priority); }

  peek() { return this.heap.length ? this.heap[0][0] : undefined; }
  peekPriority() { return this.heap.length ? this.heap[0][1] : undefined; }

  pop() {
    if (!this.heap.length) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top[0];
  }

  popEntry() {
    if (!this.heap.length) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return { item: top[0], priority: top[1] };
  }

  _less(i, j) {
    const a = this.heap[i];
    const b = this.heap[j];
    const result = this.compare(a[1], b[1]);
    if (result === 0) return this.stable ? a[2] < b[2] : false;
    return this.minQueue ? result < 0 : result > 0;
  }

  _bubbleUp(index) {
    const heap = this.heap;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this._less(index, parent)) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
  }

  _sinkDown(index) {
    const heap = this.heap;
    const size = heap.length;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < size && this._less(left, smallest)) smallest = left;
      if (right < size && this._less(right, smallest)) smallest = right;
      if (smallest === index) break;
      [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
      index = smallest;
    }
  }
}

/**
 * Sparse set: the standard entity→component container. Add/remove/contains are O(1), iteration is
 * dense and cache-friendly, and swapping with the last element keeps removals O(1) without holes.
 */
export class SparseSet {
  constructor() {
    /** @type {Map<number, number>} entity → dense index */
    this.sparse = new Map();
    /** @type {any[]} dense values */
    this.dense = [];
    /** @type {number[]} dense entity ids (parallel to `dense`) */
    this.entities = [];
  }

  add(entity, component) {
    const existing = this.sparse.get(entity);
    if (existing !== undefined) {
      this.dense[existing] = component;
      return component;
    }
    this.sparse.set(entity, this.dense.length);
    this.dense.push(component);
    this.entities.push(entity);
    return component;
  }

  get(entity) {
    const index = this.sparse.get(entity);
    return index === undefined ? undefined : this.dense[index];
  }

  has(entity) { return this.sparse.has(entity); }

  remove(entity) {
    const index = this.sparse.get(entity);
    if (index === undefined) return false;
    const lastIndex = this.dense.length - 1;
    if (index !== lastIndex) {
      this.dense[index] = this.dense[lastIndex];
      this.entities[index] = this.entities[lastIndex];
      this.sparse.set(this.entities[index], index);
    }
    this.dense.pop();
    this.entities.pop();
    this.sparse.delete(entity);
    return true;
  }

  get size() { return this.dense.length; }
  clear() { this.sparse.clear(); this.dense.length = 0; this.entities.length = 0; return this; }

  forEach(fn) {
    for (let i = 0; i < this.dense.length; i++) fn(this.dense[i], this.entities[i], i);
    return this;
  }

  [Symbol.iterator]() {
    let index = 0;
    const self = this;
    return {
      next() {
        if (index >= self.dense.length) return { done: true, value: undefined };
        const value = { entity: self.entities[index], component: self.dense[index] };
        index++;
        return { done: false, value };
      },
    };
  }
}

/** Stable integer handle allocator: hand out ids, free them, reuse the lowest first. */
export class FreeList {
  constructor({ capacity = 0, start = 0, validator = null } = {}) {
    this.start = start;
    this.capacity = capacity;
    this.generation = 0;
    this.free = [];
    this.next = start;
    this.alive = new Set();
    this.validator = validator;      // (value) => boolean, used by validate()
    this.validated = 0;
    this.rejected = 0;
  }

  /** Allocates a handle. Returns `-1` when the pool is exhausted and cannot grow. */
  alloc() {
    if (this.free.length) {
      const handle = this.free.pop();
      this.alive.add(handle);
      return handle;
    }
    if (this.capacity > 0 && this.next - this.start >= this.capacity) return -1;
    const handle = this.next++;
    this.alive.add(handle);
    return handle;
  }

  freeHandle(handle) {
    if (!this.alive.delete(handle)) return false;
    this.free.push(handle);
    return true;
  }

  /** Marks a handle busy without going through the free list (restoring a saved state). */
  claim(handle) {
    if (this.alive.has(handle)) return false;
    const index = this.free.indexOf(handle);
    if (index >= 0) this.free.splice(index, 1);
    if (handle >= this.next) this.next = handle + 1;
    this.alive.add(handle);
    return true;
  }

  isAlive(handle) { return this.alive.has(handle); }
  get used() { return this.alive.size; }
  get available() { return this.capacity > 0 ? this.capacity - this.used : Infinity; }

  /** Drops handles the caller's validator rejects (freed GPU resources, stale net ids). */
  validate(predicate = this.validator) {
    if (!predicate) return 0;
    let dropped = 0;
    for (const handle of [...this.alive]) {
      this.validated++;
      if (!predicate(handle)) { this.freeHandle(handle); dropped++; }
    }
    return dropped;
  }

  reset() { this.free.length = 0; this.alive.clear(); this.next = this.start; return this; }
}

/**
 * Bit set over 32-bit words. Layer masks, visibility sets and dirty flags — anywhere a set of small
 * integers is touched every frame.
 */
export class BitSet {
  constructor(capacityOrSource = 64) {
    if (capacityOrSource instanceof BitSet) {
      this.capacity = capacityOrSource.capacity;
      this.words = capacityOrSource.words.slice();
      return;
    }
    const capacity = Math.max(32, Math.ceil(capacityOrSource / 32) * 32);
    this.capacity = capacity;
    this.words = new Uint32Array(capacity / 32);
  }

  set(bit) { this.words[(bit / 32) | 0] |= (1 << (bit % 32)); return this; }
  clearBit(bit) { this.words[(bit / 32) | 0] &= ~(1 << (bit % 32)); return this; }
  get(bit) { return (this.words[(bit / 32) | 0] & (1 << (bit % 32))) !== 0; }
  toggle(bit) { this.words[(bit / 32) | 0] ^= (1 << (bit % 32)); return this; }

  setAll() { this.words.fill(0xffffffff); return this; }
  clear() { this.words.fill(0); return this; }

  or(other) { for (let i = 0; i < this.words.length; i++) this.words[i] |= other.words[i]; return this; }
  and(other) { for (let i = 0; i < this.words.length; i++) this.words[i] &= other.words[i]; return this; }
  andNot(other) { for (let i = 0; i < this.words.length; i++) this.words[i] &= ~other.words[i]; return this; }
  xor(other) { for (let i = 0; i < this.words.length; i++) this.words[i] ^= other.words[i]; return this; }
  copy(other) { this.words.set(other.words); return this; }

  get isEmpty() {
    for (let i = 0; i < this.words.length; i++) if (this.words[i] !== 0) return false;
    return true;
  }

  countBits() {
    let total = 0;
    for (let i = 0; i < this.words.length; i++) {
      let value = this.words[i];
      // Kernighan popcount: faster than a per-bit loop for sparse masks.
      while (value) { value &= value - 1; total++; }
    }
    return total;
  }

  forEach(fn) {
    for (let word = 0; word < this.words.length; word++) {
      let bits = this.words[word];
      while (bits) {
        const bit = 31 - Math.clz32(bits & -bits);
        fn(word * 32 + bit);
        bits &= bits - 1;
      }
    }
    return this;
  }

  toArray() {
    const out = [];
    this.forEach((bit) => out.push(bit));
    return out;
  }

  equals(other) {
    for (let i = 0; i < this.words.length; i++) if (this.words[i] !== other.words[i]) return false;
    return true;
  }
}

/**
 * Grid index for spatial queries that do not need a full collision world (pickups, spawn points,
 * foliage volumes). Buckets hold arbitrary payloads and are reused between frames.
 */
export class SpatialHashGrid {
  constructor({ cellSize = 4, bounds = null } = {}) {
    this.cellSize = cellSize;
    this.bounds = bounds;
    /** @type {Map<string, any[]>} */
    this.cells = new Map();
    this.count = 0;
  }

  _key(x, y, z) {
    const size = this.cellSize;
    return `${Math.floor(x / size)},${Math.floor(y / size)},${Math.floor(z / size)}`;
  }

  insert(position, payload) {
    const key = this._key(position.x, position.y, position.z);
    let bucket = this.cells.get(key);
    if (!bucket) { bucket = []; this.cells.set(key, bucket); }
    bucket.push(payload);
    this.count++;
    return payload;
  }

  /** Everything in the cells overlapping the query sphere (candidates, not exact matches). */
  query(position, radius, out = []) {
    out.length = 0;
    const size = this.cellSize;
    const minX = Math.floor((position.x - radius) / size);
    const maxX = Math.floor((position.x + radius) / size);
    const minY = Math.floor((position.y - radius) / size);
    const maxY = Math.floor((position.y + radius) / size);
    const minZ = Math.floor((position.z - radius) / size);
    const maxZ = Math.floor((position.z + radius) / size);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const bucket = this.cells.get(`${x},${y},${z}`);
          if (bucket) for (const payload of bucket) out.push(payload);
        }
      }
    }
    return out;
  }

  clear() { this.cells.clear(); this.count = 0; return this; }
  get cellCount() { return this.cells.size; }
}

/** Bounded cache with LRU eviction (asset metadata, path results, shader variants). */
export class LRUCache {
  constructor(capacity = 64) {
    this.capacity = capacity;
    /** @type {Map<any, any>} insertion order === recency for Map */
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get(key) {
    const value = this.map.get(key);
    if (value === undefined) { this.misses++; return undefined; }
    this.hits++;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.evictions++;
    }
    this.map.set(key, value);
    return value;
  }

  has(key) { return this.map.has(key); }
  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); return this; }
  get size() { return this.map.size; }
  get hitRate() { return this.hits + this.misses === 0 ? 0 : this.hits / (this.hits + this.misses); }
  stats() { return { size: this.map.size, capacity: this.capacity, hits: this.hits, misses: this.misses, evictions: this.evictions, hitRate: this.hitRate }; }
}

/** Keyed slot table with stable ids and a generation counter (descriptor heaps, uniform rings). */
export class SlotMap {
  constructor(initialCapacity = 8) {
    this.capacity = initialCapacity;
    this.values = new Array(initialCapacity).fill(null);
    this.generations = new Uint32Array(initialCapacity);
    this.keys = new FreeList({ capacity: initialCapacity });
    this.size = 0;
  }

  insert(value) {
    let slot = this.keys.alloc();
    if (slot < 0) { this._grow(); slot = this.keys.alloc(); }
    if (slot >= this.values.length) this._grow(slot + 1);
    this.values[slot] = value;
    this.size++;
    return { index: slot, generation: this.generations[slot] };
  }

  get(handle) {
    if (!handle || handle.index >= this.values.length) return undefined;
    if (this.generations[handle.index] !== handle.generation) return undefined;
    return this.values[handle.index] ?? undefined;
  }

  remove(handle) {
    if (!this.get(handle)) return false;
    this.values[handle.index] = null;
    this.generations[handle.index] = (this.generations[handle.index] + 1) >>> 0;
    this.keys.freeHandle(handle.index);
    this.size--;
    return true;
  }

  _grow(minimum = this.values.length * 2) {
    const next = Math.max(minimum, this.values.length * 2);
    while (this.values.length < next) {
      this.values.push(null);
      this.keys.capacity++;
      this.keys.next = Math.max(this.keys.next, this.values.length - 1 + 1);
    }
    const generations = new Uint32Array(this.values.length);
    generations.set(this.generations);
    this.generations = generations;
    this.capacity = this.values.length;
  }
}

export default {
  ObjectPool, FixedPool, RingBuffer, Deque, PriorityQueue, SparseSet, FreeList, BitSet,
  SpatialHashGrid, LRUCache, SlotMap,
};
