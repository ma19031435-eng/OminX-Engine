/**
 * OminX Engine — Signals: Roblox-style event objects and a lightweight emitter.
 * @module engine/core/Signal
 */

/** A single subscription handle. */
export class Connection {
  constructor(signal, fn, once = false) {
    this.signal = signal;
    this.fn = fn;
    this.once = once;
    this.connected = true;
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.signal._remove(this);
  }
  /** Roblox spelling */
  Disconnect() { return this.disconnect(); }
  reconnect() {
    if (this.connected) return this;
    this.connected = true;
    this.signal._add(this);
    return this;
  }
  get Connected() { return this.connected; }
}

/**
 * `Signal` — an event that listeners connect to. API mirrors Roblox's `RBXScriptSignal`
 * (`Connect`, `Once`, `Wait`, `Disconnect`) while also supporting `on`/`off`/`emit`.
 */
export class Signal {
  constructor(name = 'Signal') {
    this.name = name;
    this._listeners = [];
    this._pendingAdd = null;
    this._pendingRemove = null;
    this._emitting = false;
    this._deferred = null;
    this._waiters = [];
    this.emitCount = 0;
  }
  static new(name) { return new Signal(name); }

  _add(conn) {
    if (this._emitting) {
      (this._pendingAdd ??= []).push(conn);
    } else {
      this._listeners.push(conn);
    }
  }
  _remove(conn) {
    if (this._emitting) {
      (this._pendingRemove ??= []).push(conn);
      return;
    }
    const i = this._listeners.indexOf(conn);
    if (i >= 0) this._listeners.splice(i, 1);
  }
  _flush() {
    this._emitting = false;
    if (this._pendingAdd) { for (const c of this._pendingAdd) if (c.connected) this._listeners.push(c); this._pendingAdd = null; }
    if (this._pendingRemove) { for (const c of this._pendingRemove) { const i = this._listeners.indexOf(c); if (i >= 0) this._listeners.splice(i, 1); } this._pendingRemove = null; }
    if (this._deferred) { const d = this._deferred; this._deferred = null; for (const args of d) this.emit(...args); }
  }

  connect(fn) {
    const conn = new Connection(this, fn);
    this._add(conn);
    return conn;
  }
  Connect(fn) { return this.connect(fn); }
  once(fn) {
    const conn = new Connection(this, fn, true);
    this._add(conn);
    return conn;
  }
  Once(fn) { return this.once(fn); }
  on(fn) { return this.connect(fn); }
  off(fn) {
    for (let i = this._listeners.length - 1; i >= 0; i--) if (this._listeners[i].fn === fn) this._listeners[i].disconnect();
    return this;
  }
  /** Emits immediately, catching listener errors so one bad handler can't kill the frame. */
  emit(...args) {
    this.emitCount++;
    if (this._emitting) { (this._deferred ??= []).push(args); return this; }
    this._emitting = true;
    const list = this._listeners;
    for (let i = 0; i < list.length; i++) {
      const conn = list[i];
      if (!conn.connected) continue;
      if (conn.once) conn.disconnect();
      try {
        conn.fn(...args);
      } catch (err) {
        reportSignalError(this.name, err);
      }
    }
    // resolve waiters
    if (this._waiters.length) {
      const waiters = this._waiters;
      this._waiters = [];
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve(args.length > 1 ? args : args[0]);
      }
    }
    this._flush();
    return this;
  }
  /** Alias so both ecosystems feel natural. */
  fire(...args) { return this.emit(...args); }
  Fire(...args) { return this.emit(...args); }

  /** Returns a Promise that resolves with the next emission's args (or `undefined` on timeout). */
  wait(timeoutSeconds) {
    return new Promise((resolve) => {
      const w = { resolve, timer: null };
      if (timeoutSeconds !== undefined && timeoutSeconds !== null) {
        w.timer = setTimeout(() => {
          this._waiters = this._waiters.filter((x) => x !== w);
          resolve(undefined);
        }, timeoutSeconds * 1000);
      }
      this._waiters.push(w);
    });
  }
  Wait(timeoutSeconds) { return this.wait(timeoutSeconds); }

  get listenerCount() { return this._listeners.length; }
  get connected() { return this._listeners.length > 0; }
  disconnectAll() { for (const c of this._listeners.slice()) c.disconnect(); return this; }
  destroy() { this.disconnectAll(); this._waiters = []; return this; }
  get Stats() { return { listeners: this._listeners.length, emits: this.emitCount }; }
}

let _errorHandler = null;
export function setSignalErrorHandler(fn) { _errorHandler = fn; }
function reportSignalError(name, err) {
  if (_errorHandler) { _errorHandler(name, err); return; }
  // eslint-disable-next-line no-console
  console.error(`[OminX] error in listener of "${name}":`, err);
}

/**
 * EventEmitter — Node-style multi-event bus, used internally by engine subsystems
 * (renderer stats, network transport, editor commands).
 */
export class EventEmitter {
  constructor() { this._events = new Map(); }
  on(event, fn) {
    let s = this._events.get(event);
    if (!s) { s = new Signal(event); this._events.set(event, s); }
    return s.connect(fn);
  }
  once(event, fn) {
    let s = this._events.get(event);
    if (!s) { s = new Signal(event); this._events.set(event, s); }
    return s.once(fn);
  }
  off(event, fn) {
    const s = this._events.get(event);
    if (s) (fn ? s.off(fn) : s.disconnectAll());
    return this;
  }
  addListener(event, fn) { return this.on(event, fn); }
  removeListener(event, fn) { return this.off(event, fn); }
  removeAllListeners(event) { if (event) this._events.get(event)?.disconnectAll(); else for (const s of this._events.values()) s.disconnectAll(); return this; }
  emit(event, ...args) {
    const s = this._events.get(event);
    if (s) s.emit(...args);
    const any = this._events.get('*');
    if (any) any.emit(event, ...args);
    return this;
  }
  getSignal(event) {
    let s = this._events.get(event);
    if (!s) { s = new Signal(event); this._events.set(event, s); }
    return s;
  }
  eventNames() { return [...this._events.keys()]; }
  listenerCount(event) { return this._events.get(event)?.listenerCount ?? 0; }
  waitFor(event, timeout) { return this.getSignal(event).wait(timeout); }
}

/**
 * SignalBag — groups many connections so a subsystem can disconnect everything at once.
 * Critical for entity teardown: no dangling listeners after a player/weapon is destroyed.
 */
export class SignalBag {
  constructor() { this.connections = []; this.disposed = false; }
  add(connection) {
    if (this.disposed) { connection?.disconnect?.(); return connection; }
    if (connection) this.connections.push(connection);
    return connection;
  }
  /** Connects signal → fn and tracks the connection. */
  track(signal, fn) { return this.add(signal.connect(fn)); }
  addMultiple(connections) { for (const c of connections) this.add(c); return this; }
  disconnectAll() {
    for (const c of this.connections) c.disconnect();
    this.connections.length = 0;
    return this;
  }
  dispose() { this.disposed = true; return this.disconnectAll(); }
  /** Disposable-style API for `using` bindings. */
  [Symbol.dispose] = undefined;
}

export default Signal;
