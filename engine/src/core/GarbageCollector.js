/**
 * OminX Engine — object references, ownership and garbage collection.
 *
 * JavaScript already collects cycles, so this is *not* a tracing GC for gameplay memory. It solves
 * the two problems that actually bite a long-running engine, both of them UE's:
 *
 *   1. **Lifetime scoping.** Entities, components, views and render targets need to die together
 *      (a level unload, a match rest, a map reload) without every factory remembering to unwire
 *      itself. `ObjectHandle` + scopes give that: a handle either points at a live object or says
 *      so, and destroying a scope tears down everything it owns in reverse creation order.
 *   2. **Dangling-reference detection.** A `WeakHandle` never keeps an object alive, and
 *      `validate()`/`get()` reports a collected target instead of throwing from deep inside a
 *      frame. This is what makes hot-reload, editor undo and netcode reconciliation tractable.
 *
 * Two handle flavours, mirroring UE's strong vs weak pointers:
 *   - `ObjectHandle` (strong): keeps the object alive and pins it against collection.
 *   - `WeakHandle`: only observes; the target may disappear at any time.
 *
 * `Collector` tracks weak handles per object, sweeps dead entries on demand (or once per frame from
 * the engine loop), and can run *deferred destruction*: objects marked `pendingKill` are destroyed
 * at a safe point (end of frame), never in the middle of a broadcast — the classic crash source in
 * event-driven engines.
 *
 * @module engine/src/core/GarbageCollector
 */
import { createLogger } from './Logger.js';
import { engineEvents } from './Object.js';

const log = createLogger('GC');

export const HandleState = {
  Valid: 'valid',
  Null: 'null',
  Collected: 'collected',
  Destroyed: 'destroyed',
};

/** Strong reference to an engine object; keeps it alive and pins it against collection. */
export class ObjectHandle {
  constructor(target = null) {
    this.target = target;
    if (target) Collector.pin(target);
  }

  static of(target) { return new ObjectHandle(target); }

  get() { return this.target && !this.target.isDestroyed ? this.target : null; }
  get isValid() { return !!this.get(); }
  get state() { return resolveState(this.target); }

  /** Replaces the referent, unpinning the previous one. */
  set(target) {
    if (this.target === target) return this;
    if (this.target) Collector.unpin(this.target);
    this.target = target;
    if (target) Collector.pin(target);
    return this;
  }

  /** Releases the strong reference (the object may now be collected). */
  release() {
    if (this.target) Collector.unpin(this.target);
    this.target = null;
    return this;
  }

  toString() { return `ObjectHandle(${this.target ? this.target.toString() : 'null'})`; }
}

/** Non-owning reference. Holds a weak pointer when the platform provides one. */
export class WeakHandle {
  constructor(target = null) {
    this.id = target?.id ?? 0;
    this._ref = target && typeof WeakRef !== 'undefined' ? new WeakRef(target) : null;
    this._fallback = this._ref ? null : target;
  }

  static of(target) { return new WeakHandle(target); }

  get() {
    const target = this._ref ? this._ref.deref() : this._fallback;
    if (!target || target.isDestroyed) return null;
    return target;
  }

  get isValid() { return !!this.get(); }
  /** `valid` | `null` | `destroyed` | `collected` — the raw target is inspected, not the filtered one. */
  get state() {
    const raw = this._ref ? this._ref.deref() : this._fallback;
    if (raw) return resolveState(raw);
    return Collector.wasDestroyed(this.id) ? HandleState.Destroyed : HandleState.Collected;
  }

  /** True when the target is gone *because it was collected*, not because it was destroyed. */
  get wasCollected() { return !this.get() && !Collector.wasDestroyed(this.id); }

  clear() { this._ref = null; this._fallback = null; return this; }

  toString() { return `WeakHandle(#${this.id}, ${this.get() ? 'alive' : 'collected'})`; }
}

function resolveState(target) {
  if (!target) return HandleState.Null;
  if (target.isDestroyed) return HandleState.Destroyed;
  return HandleState.Valid;
}

/**
 * A lifetime scope: everything created through it is destroyed when the scope is. Scopes nest, so a
 * level scope can contain a match scope.
 */
export class ObjectScope {
  constructor(name = 'Scope', parent = null) {
    this.name = name;
    this.parent = parent;
    this.children = new Set();
    /** @type {Set<object>} */
    this.objects = new Set();
    parent?.children.add(this);
  }

  /** Registers an object with this scope (and therefore with every ancestor scope). */
  own(object) {
    if (!object) return object;
    this._refs ??= new Set();
    // One entry per object: a WeakRef when the platform has them (so a scope never keeps its own
    // objects alive), otherwise a strong entry. Storing both double-counts the object and makes
    // `objectCount` wrong.
    if (typeof WeakRef !== 'undefined') this._refs.add(new WeakRef(object));
    else this.objects.add(object);
    return object;
  }

  /** Creates a nested scope that dies with this one. */
  create(name) { return new ObjectScope(name, this); }

  /** Constructs objects through a factory and owns the result. */
  spawn(factory, ...args) {
    const object = factory(...args);
    this.own(object);
    return object;
  }

  get objectCount() { return [...this._alive()].length; }

  *_alive() {
    const seen = new Set();
    for (const entry of this._refs ?? []) {
      const object = entry instanceof WeakRef ? entry.deref() : entry;
      if (object && !object.isDestroyed && !seen.has(object)) { seen.add(object); yield object; }
    }
    for (const object of this.objects) {
      if (!object.isDestroyed && !seen.has(object)) { seen.add(object); yield object; }
    }
  }

  /** Destroys owned objects (newest first) and then child scopes, then detaches from the parent. */
  destroy() {
    const owned = [...this._alive()];
    // Reverse creation order: dependents die before their dependencies.
    for (let i = owned.length - 1; i >= 0; i--) {
      try { owned[i].destroy?.(); } catch (error) { log.warn(`${this.name}: destroy failed — ${error?.message ?? error}`); }
    }
    for (const child of [...this.children]) child.destroy();
    this.children.clear();
    this.objects.clear();
    this._refs?.clear();
    this.parent?.children.delete(this);
    this.parent = null;
    return this;
  }
}

/**
 * The collector: pins, weak-tracking, deferred destruction and sweeps.
 *
 * Deferred destruction is the important part for gameplay code. A bullet impact that kills the
 * shooter's target must not pull the actor out from under an `onHit` broadcast in flight; marking it
 * `pendingKill` and letting the frame boundary destroy it keeps every callback observing a coherent
 * world.
 */
export class Collector {
  /**
   * The collector store is process-wide (one object graph per runtime), so instances are lightweight
   * handles onto it: `engine.collector.sweep()` and `Collector.sweep()` are the same call. Several
   * collectors can exist — one per engine, one per test — without splitting the object graph, and
   * `statsSink` lets each report into its own stats object.
   */
  constructor({ stats = null, name = 'collector' } = {}) {
    this.name = name;
    this.statsSink = stats;
    this.collections = 0;
  }

  get pinnedCount() { return Collector.pinned.size; }
  get pendingCount() { return Collector.pendingKill.size; }
  get destroyedCount() { return Collector.destroyedIds.size; }

  pin(object) { this.statsSink?.count('GC/Pinned'); return Collector.pin(object); }
  unpin(object) { return Collector.unpin(object); }
  isPinned(object) { return Collector.isPinned(object); }
  pinCount(object) { return Collector.pinCount(object); }
  track(handle) { return Collector.track(handle); }
  untrack(handle) { return Collector.untrack(handle); }
  weak(object) { return Collector.weak(object); }
  strong(object) { return Collector.strong(object); }
  markPendingKill(object, options) { return Collector.markPendingKill(object, options); }
  isPendingKill(object) { return Collector.isPendingKill(object); }
  wasDestroyed(id) { return Collector.wasDestroyed(id); }

  /** Runs a collection pass: pending kills are destroyed, unreachable handles are dropped. */
  sweep(options = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const before = Collector.pendingKill.size;
    const removed = Collector.sweep(options);
    this.collections++;
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
    this.statsSink?.timing('GC/Sweep', elapsed, { removed });
    this.statsSink?.count('GC/Collections');
    this.lastSweepMs = elapsed;
    this.lastRemoved = removed;
    this.lastPending = before;
    return removed;
  }

  flushPendingKill() { return Collector.flushPendingKill(); }
  stats() { return { ...Collector.stats(), collections: this.collections, lastSweepMs: this.lastSweepMs ?? 0 }; }
  reset() { return Collector.reset(); }

  /** @type {Map<number, { object: object, count: number }>} strongly pinned objects */
  static pinned = new Map();
  /** @type {Set<object>} objects waiting for the end-of-frame sweep */
  static pendingKill = new Set();
  /** @type {Set<WeakHandle>} handles to validate on sweep */
  static weakHandles = new Set();
  /** @type {Map<number, number>} ids that have been destroyed this run (dangling detection) */
  static destroyedIds = new Map();
  static sweepCount = 0;
  static lastSweepRemoved = 0;

  static pin(object) {
    if (!object || typeof object.id !== 'number') return false;
    const entry = Collector.pinned.get(object.id);
    if (entry) entry.count++;
    else Collector.pinned.set(object.id, { object, count: 1 });
    return true;
  }

  static unpin(object) {
    if (!object || typeof object.id !== 'number') return false;
    const entry = Collector.pinned.get(object.id);
    if (!entry) return false;
    entry.count--;
    if (entry.count <= 0) Collector.pinned.delete(object.id);
    return true;
  }

  static isPinned(object) { return !!object && Collector.pinned.has(object.id); }
  static pinCount(object) { return object ? (Collector.pinned.get(object.id)?.count ?? 0) : 0; }

  /** Tracks a weak handle so a sweep can drop collected entries and report them. */
  static track(handle) {
    Collector.weakHandles.add(handle);
    return handle;
  }

  static untrack(handle) {
    Collector.weakHandles.delete(handle);
    return handle;
  }

  /** Creates a tracked weak handle (the common case: components referring to actors). */
  static weak(object) { return Collector.track(new WeakHandle(object)); }

  /** Creates a tracked strong handle. */
  static strong(object) { return new ObjectHandle(object); }

  /**
   * Marks an object for end-of-frame destruction. Returns false when it is pinned by a strong
   * handle — callers can then decide to force it.
   */
  static markPendingKill(object, { force = false } = {}) {
    if (!object || object.isDestroyed) return false;
    if (Collector.isPinned(object) && !force) {
      log.debug(`${object} is pinned (${Collector.pinCount(object)} handles) — deferring kill`);
      return false;
    }
    Collector.pendingKill.add(object);
    return true;
  }

  static isPendingKill(object) { return Collector.pendingKill.has(object); }

  /** Destroys everything queued by `markPendingKill`. Called at the end of every frame. */
  static flushPendingKill() {
    if (!Collector.pendingKill.size) return 0;
    const queue = [...Collector.pendingKill];
    Collector.pendingKill.clear();
    let destroyed = 0;
    for (const object of queue) {
      if (object.isDestroyed) continue;
      // A strong handle taken *after* the kill was queued rescues the object: it stays pending and
      // is destroyed by a later pass once the last handle is released. Destroying it anyway is how
      // a "collected" object ends up in a live handle.
      if (Collector.isPinned(object)) { Collector.pendingKill.add(object); continue; }
      try {
        object.destroy();
        destroyed++;
      } catch (error) {
        log.error(`deferred destroy of ${object} threw: ${error?.message ?? error}`);
      }
    }
    return destroyed;
  }

  /**
   * Validates weak handles, dropping dead ones. `compact` also asks the platform to reclaim
   * (only exposed because a test can force it with `--expose-gc`).
   */
  static sweep({ compact = false } = {}) {
    Collector.sweepCount++;
    let removed = 0;
    for (const handle of Collector.weakHandles) {
      if (!handle.get()) {
        // A collected target cannot be recovered; stop tracking it.
        Collector.weakHandles.delete(handle);
        removed++;
      }
    }
    Collector.flushPendingKill();
    Collector.lastSweepRemoved = removed;
    if (compact && typeof globalThis.gc === 'function') globalThis.gc();
    return removed;
  }

  static wasDestroyed(id) { return Collector.destroyedIds.has(id); }

  /** Statistics for the profiler and leak tests. */
  static stats() {
    return {
      pinned: Collector.pinned.size,
      pinnedObjects: [...Collector.pinned.values()].reduce((sum, entry) => sum + entry.count, 0),
      pendingKill: Collector.pendingKill.size,
      trackedWeak: Collector.weakHandles.size,
      destroyedHistory: Collector.destroyedIds.size,
      sweeps: Collector.sweepCount,
      lastSweepRemoved: Collector.lastSweepRemoved,
    };
  }

  /** Test/leak-support hook: forget everything (does not destroy objects). */
  static reset() {
    Collector.pinned.clear();
    Collector.pendingKill.clear();
    Collector.weakHandles.clear();
    Collector.destroyedIds.clear();
    Collector.sweepCount = 0;
    Collector.lastSweepRemoved = 0;
    return Collector;
  }
}

// Remember destroyed ids so a weak handle can distinguish "collected" from "destroyed".
engineEvents.onObjectDestroyed.add((object) => {
  Collector.destroyedIds.set(object.id, 1);
  Collector.pendingKill.delete(object);
  if (Collector.destroyedIds.size > 8192) {
    // Bounded history: enough to explain a dangling reference, not a leak.
    const excess = Collector.destroyedIds.size - 8192;
    let removed = 0;
    for (const key of Collector.destroyedIds.keys()) {
      Collector.destroyedIds.delete(key);
      if (++removed >= excess) break;
    }
  }
}, { weak: false });

/** Convenience factory: a scope rooted at a name, used by world/level loading. */
export function createScope(name, parent = null) { return new ObjectScope(name, parent); }

export default Collector;
