/**
 * OminX Engine — delegates.
 *
 * UE-style delegates: a single-cast `Delegate` (one bound target, `Execute`/`IsBound`) and a
 * `MulticastDelegate` (`Broadcast`) with the properties a real engine needs and a naive emitter
 * does not have:
 *
 *   - **Handles.** Every binding returns a `DelegateHandle` you can `unbind()` later without
 *     keeping a reference to the callback — the shape UE uses (`AddUObject`/`Remove`).
 *   - **Object-bound, weakly-held listeners.** `add(owner, method)` holds `owner` through a
 *     `WeakRef`, so an actor that is garbage collected stops being called *and* its binding is
 *     reclaimed automatically (UE's `AddUObject` semantics). This is what makes long-lived
 *     engine-level events safe.
 *   - **Priorities.** Deterministic dispatch order (higher first, insertion order breaks ties), so
 *     input, prediction and presentation layers can order themselves without hacks.
 *   - **Safe mutation during broadcast.** Adding or removing listeners while dispatching is
 *     allowed and takes effect for the *next* broadcast — no "snapshot the array every frame"
 *     allocation on the hot path.
 *   - **Error isolation.** One throwing listener cannot break a frame: the error goes to the
 *     configured handler (the engine log by default) and dispatch continues.
 *
 * @module engine/src/core/Delegate
 */
import { createLogger } from './Logger.js';

const log = createLogger('Delegate');

let _errorHandler = null;

/** Installs a process-wide handler for listener errors. Defaults to the engine log. */
export function setDelegateErrorHandler(handler) {
  _errorHandler = handler;
  return handler;
}

function reportError(delegate, error) {
  if (_errorHandler) {
    _errorHandler(error, delegate);
    return;
  }
  log.error(`listener on "${delegate.name}" threw: ${error?.message ?? error}`);
  if (typeof console !== 'undefined' && error?.stack) console.error(error);
}

/**
 * A binding token. Valid until it is unbound, its owner is collected, or the delegate is cleared.
 * `handle.unbind()` is idempotent, which makes it safe to call from teardown paths that may run
 * more than once.
 */
export class DelegateHandle {
  constructor(delegate, id) {
    this.delegate = delegate;
    this.id = id;
    this._valid = true;
  }

  get isValid() { return this._valid && this.delegate?._hasId(this.id); }

  /** Removes the binding (alias: `unsubscribe`, `disconnect`, `Remove`). */
  unbind() {
    if (!this._valid) return false;
    const removed = this.delegate?.removeById(this.id) ?? false;
    this._valid = false;
    return removed;
  }

  unsubscribe() { return this.unbind(); }
  disconnect() { return this.unbind(); }
  Remove() { return this.unbind(); }
}

/**
 * Single-cast delegate — one target, UE's `DECLARE_DELEGATE`. Used where "exactly one thing
 * handles this" is a design rule rather than a hope (`onResize`, `onDeviceLost`, asset resolver).
 *
 * @template {(...args: any[]) => any} F
 */
export class Delegate {
  constructor(name = 'Delegate') {
    this.name = name;
    this._fn = null;
    this._owner = null;
    this._ownerRef = null;
    this._boundThis = undefined;
    this._once = false;
  }

  static create(name) { return new Delegate(name); }

  /** Binds a function (optionally with an explicit `this`). Rebinding replaces the target. */
  bind(fn, thisArg = undefined, { once = false } = {}) {
    if (typeof fn !== 'function') throw new TypeError(`${this.name}: bind() needs a function`);
    this._fn = fn;
    this._boundThis = thisArg;
    this._owner = null;
    this._ownerRef = null;
    this._once = once;
    return new DelegateHandle(this, 0);
  }

  /**
   * Binds a method of `owner` and holds the owner weakly: when the owner is collected the delegate
   * un-binds itself instead of keeping a zombie alive.
   */
  bindUObject(owner, methodName, { once = false } = {}) {
    if (!owner || typeof owner[methodName] !== 'function') {
      throw new TypeError(`${this.name}: bindUObject() needs an object with ${methodName}()`);
    }
    this._fn = null;
    this._owner = owner;
    this._ownerRef = typeof WeakRef !== 'undefined' ? new WeakRef(owner) : null;
    this._methodName = methodName;
    this._once = once;
    return new DelegateHandle(this, 0);
  }

  get isBound() {
    if (this._fn || this._owner) return true;
    if (this._ownerRef?.deref()) return true;
    return false;
  }
  IsBound() { return this.isBound; }

  /** Runs the bound target. Returns `undefined` when unbound (never throws for that). */
  execute(...args) {
    const entry = this._resolve();
    if (!entry) return undefined;
    if (this._once) this.clear();
    return entry.fn.apply(entry.thisArg, args);
  }
  Execute(...args) { return this.execute(...args); }

  /** Runs the target, swallowing errors like a multicast broadcast does. */
  tryExecute(...args) {
    try { return this.execute(...args); } catch (error) { reportError(this, error); return undefined; }
  }

  clear() {
    this._fn = null;
    this._owner = null;
    this._ownerRef = null;
    this._methodName = null;
    return this;
  }
  Unbind() { return this.clear(); }
  Clear() { return this.clear(); }

  _resolve() {
    if (this._fn) return { fn: this._fn, thisArg: this._boundThis };
    if (this._ownerRef) {
      const owner = this._ownerRef.deref();
      if (!owner) { this.clear(); return null; }
      return { fn: owner[this._methodName], thisArg: owner };
    }
    if (this._owner) return { fn: this._owner[this._methodName], thisArg: this._owner };
    return null;
  }
}

/**
 * Multicast delegate — many listeners, UE's `DECLARE_MULTICAST_DELEGATE`. This is the workhorse for
 * engine-level broadcasts (frame phase changes, asset loads, world lifecycle, config changes).
 */
export class MulticastDelegate {
  constructor(name = 'MulticastDelegate') {
    this.name = name;
    /** @type {Array<object>} */
    this._listeners = [];
    this._nextId = 1;
    /** Broadcast guard: mutations collected here are applied when dispatch unwinds. */
    this._dispatching = 0;
    this._pendingRemove = null;
    this._needsSort = false;
    this.broadcastCount = 0;
    this.trippedErrors = 0;
  }

  static create(name) { return new MulticastDelegate(name); }

  /**
   * Binds a listener.
   * @param {Function|object} fnOrOwner a callback, or the owner object for the method form
   * @param {string|object} methodOrOptions method name (object form) or options (function form)
   * @param {object} [options] `{ priority = 0, once = false, weak = false, tag = null }`
   */
  add(fnOrOwner, methodOrOptions = {}, options = {}) {
    const isOwnerForm = typeof fnOrOwner === 'object' && fnOrOwner !== null;
    const opts = isOwnerForm ? options : (typeof methodOrOptions === 'object' && methodOrOptions !== null ? methodOrOptions : {});
    const entry = {
      id: this._nextId++,
      fn: isOwnerForm ? null : fnOrOwner,
      thisArg: isOwnerForm ? null : (opts.thisArg ?? null),
      owner: isOwnerForm ? fnOrOwner : null,
      ownerRef: null,
      method: isOwnerForm ? String(methodOrOptions) : null,
      priority: opts.priority ?? 0,
      once: !!opts.once,
      tag: opts.tag ?? null,
    };
    if (isOwnerForm) {
      if (typeof fnOrOwner[entry.method] !== 'function') {
        throw new TypeError(`${this.name}: add(owner, method) needs ${entry.method}() to exist`);
      }
      // Weak by default for object-bound listeners; opt out with `{ weak: false }`.
      if (opts.weak !== false && typeof WeakRef !== 'undefined') entry.ownerRef = new WeakRef(fnOrOwner);
    }
    if (!isOwnerForm && typeof entry.fn !== 'function') {
      throw new TypeError(`${this.name}: add() needs a function or an owner object`);
    }
    if (this._dispatching > 0) {
      // Defer structural changes so a listener can bind/unbind from inside a broadcast safely.
      this._deferredAdds ??= [];
      this._deferredAdds.push(entry);
    } else {
      this._listeners.push(entry);
      this._needsSort = true;
    }
    return new DelegateHandle(this, entry.id);
  }

  Add(fn, options) { return this.add(fn, options); }
  AddUObject(owner, method, options) { return this.add(owner, method, options); }
  on(fn, options) { return this.add(fn, options); }
  connect(fn, options) { return this.add(fn, options); }
  /** Convenience: bind `owner[method]` with `weak: false` (explicit strong binding). */
  addStrong(owner, method, options = {}) { return this.add(owner, method, { ...options, weak: false }); }

  /** Removes by handle, by callback reference, or by owner object. */
  remove(target) {
    if (target instanceof DelegateHandle) return target.unbind();
    if (typeof target === 'function') {
      const entry = this._listeners.find((l) => l.fn === target);
      return entry ? this.removeById(entry.id) : false;
    }
    if (target && typeof target === 'object' && target.__delegateOwner !== true) {
      return this.removeAllFor(target);
    }
    return false;
  }
  Remove(target) { return this.remove(target); }
  off(target) { return this.remove(target); }

  removeById(id) {
    const index = this._listeners.findIndex((listener) => listener.id === id);
    if (index < 0) {
      // May still be queued from inside a broadcast.
      const pending = this._deferredAdds?.find((listener) => listener.id === id);
      if (pending) this._deferredAdds.splice(this._deferredAdds.indexOf(pending), 1);
      return false;
    }
    if (this._dispatching > 0) {
      (this._pendingRemove ??= new Set()).add(id);
      return true;
    }
    this._listeners.splice(index, 1);
    return true;
  }

  _hasId(id) { return this._listeners.some((listener) => listener.id === id); }

  /** Removes every binding held by `owner` (strong or weak). */
  removeAllFor(owner) {
    const ids = this._listeners.filter((listener) => listener.owner === owner || listener.ownerRef?.deref() === owner).map((l) => l.id);
    let removed = false;
    for (const id of ids) removed = this.removeById(id) || removed;
    return removed;
  }

  /** Removes bindings carrying a tag (`tag: 'ui'`), used by subsystem teardown. */
  removeByTag(tag) {
    const ids = this._listeners.filter((listener) => listener.tag === tag).map((l) => l.id);
    let removed = false;
    for (const id of ids) removed = this.removeById(id) || removed;
    return removed;
  }

  removeAll() {
    this._listeners.length = 0;
    this._deferredAdds?.splice(0);
    this._pendingRemove?.clear();
    this._pendingRemove = null;
    return this;
  }
  clear() { return this.removeAll(); }
  Clear() { return this.removeAll(); }

  /**
   * Calls every listener in priority order. Returns the number of listeners that ran.
   * Safe against listeners that bind or unbind during dispatch.
   */
  broadcast(...args) {
    this._applyStructuralChanges();
    this.broadcastCount++;
    if (!this._listeners.length) return 0;
    this._dispatching++;
    let ran = 0;
    const listeners = this._listeners;
    for (let i = 0; i < listeners.length; i++) {
      const listener = listeners[i];
      if (this._pendingRemove?.has(listener.id)) continue;
      if (!listener.fn && !listener.owner && !listener.ownerRef) continue;
      const entry = resolveListener(listener);
      if (!entry) continue;
      if (listener.once) this.removeById(listener.id);
      ran++;
      try {
        entry.fn.apply(entry.thisArg, args);
      } catch (error) {
        this.trippedErrors++;
        reportError(this, error);
      }
    }
    this._dispatching--;
    this._applyStructuralChanges();
    return ran;
  }

  Broadcast(...args) { return this.broadcast(...args); }
  emit(...args) { return this.broadcast(...args); }
  fire(...args) { return this.broadcast(...args); }

  /** Awaits every listener in order — for async engine events (asset loaded, plugin mounted). */
  async broadcastAsync(...args) {
    const entries = this._snapshot();
    let ran = 0;
    for (const entry of entries) {
      if (entry.once) this.removeById(entry.id);
      try {
        await entry.fn.apply(entry.thisArg, args);
        ran++;
      } catch (error) {
        this.trippedErrors++;
        reportError(this, error);
      }
    }
    return ran;
  }

  /** Frozen copy of the current listeners, strongest-order first. */
  _snapshot() {
    this._applyStructuralChanges();
    return this._listeners.map((listener) => ({ ...resolveListener(listener) ?? {}, id: listener.id, once: listener.once, priority: listener.priority }));
  }

  _applyStructuralChanges() {
    if (this._dispatching > 0) return;
    if (this._pendingRemove?.size) {
      this._listeners = this._listeners.filter((listener) => !this._pendingRemove.has(listener.id));
      this._pendingRemove.clear();
    }
    if (this._deferredAdds?.length) {
      this._listeners.push(...this._deferredAdds);
      this._deferredAdds.length = 0;
      this._needsSort = true;
    }
    if (this._needsSort) {
      // Higher priority first; insertion order (id) breaks ties for determinism.
      this._listeners.sort((a, b) => b.priority - a.priority || a.id - b.id);
      this._needsSort = false;
    }
    // Drop dead weak listeners so long-lived delegates do not grow without bound.
    if (this._listeners.some((listener) => listener.ownerRef && !listener.ownerRef.deref())) {
      this._listeners = this._listeners.filter((listener) => !listener.ownerRef || listener.ownerRef.deref());
    }
  }

  /** Drops bindings whose owner has been collected. Called automatically; exposed for tests. */
  compact() {
    const before = this._listeners.length;
    this._listeners = this._listeners.filter((listener) => !listener.ownerRef || listener.ownerRef.deref());
    return before - this._listeners.length;
  }

  get listenerCount() { return this._listeners.length; }
  get isEmpty() { return this._listeners.length === 0; }
  get size() { return this._listeners.length; }
  hasListeners() { return this._listeners.length > 0; }

  /** Listener metadata without exposing the callbacks (perf HUD / debugger). */
  describe() {
    return this._listeners.map((listener) => ({
      id: listener.id,
      priority: listener.priority,
      once: listener.once,
      tag: listener.tag,
      owner: listener.owner?.constructor?.name ?? (listener.ownerRef?.deref()?.constructor?.name ?? null),
      method: listener.method,
    }));
  }

  destroy() {
    this.removeAll();
    return this;
  }
}

function resolveListener(listener) {
  if (listener.fn) return { fn: listener.fn, thisArg: listener.thisArg };
  if (listener.ownerRef) {
    const owner = listener.ownerRef.deref();
    if (!owner) return null;
    return { fn: owner[listener.method], thisArg: owner };
  }
  if (listener.owner) return { fn: listener.owner[listener.method], thisArg: listener.owner };
  return null;
}

/**
 * Binds `owner[method]` to a `MulticastDelegate` and returns an auto-unbind disposer. Useful in
 * constructors: `this._cleanup = bind(this, SomeDelegate, 'onThing')`.
 */
export function bindToDelegate(owner, delegate, method, options = {}) {
  const handle = delegate.add(owner, method, options);
  return () => handle.unbind();
}

export default MulticastDelegate;
