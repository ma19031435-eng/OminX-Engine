/**
 * OminX Engine — timers.
 *
 * A shooter is full of "in 1.5 seconds": a reload finishes, a grenade cooks off, a respawn timer
 * expires, a bot re-evaluates its route, a muzzle flash fades. Writing those as `setTimeout` is how
 * they become untestable and untraceable — the callback fires on the host's clock, keeps the page
 * alive after shutdown, ignores pause, and cannot be inspected.
 *
 * This is UE's `FTimerManager`: timers advance on the *engine's* clock, are queryable while they run,
 * and can be paused, rate-scaled and cleared by owner.
 *
 * ```
 * const timers = engine.timers;
 * const reload = timers.setTimer('Reload', weapon.finishReload.bind(weapon), { time: 1.5, owner: weapon });
 * timers.isActive(reload);                 // still reloading?
 * timers.getRemaining(reload);             // what the HUD shows
 * timers.setRate(reload, 2);                // fast-forward (a perk, a replay at 2×)
 * timers.pause(reload);                    // a cutscene freezes the reload
 * timers.clear(reload);                    // the player died mid-reload
 * ```
 *
 * Properties that matter:
 *   - **Deterministic.** `advance(dt)` is driven by the engine's fixed step, so a headless soak run
 *     and a live client agree on when things happen.
 *   - **First delay + looping.** `{ time: 0.2, looping: true, firstDelay: 1 }` waits a full second and
 *     then repeats every 0.2 s — the pattern every ability cooldown and burst-fire weapon needs.
 *   - **Owned.** `clearAllFor(owner)` exists so a destroyed weapon takes its timers with it instead
 *     of leaving a callback holding a dead object.
 *   - **Weak by default.** Object-bound callbacks hold their owner weakly, so a leaked timer is a
 *     debug line, not a leak.
 *
 * @module engine/src/core/TimerManager
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Timers');

export const timerEvents = {
  onTimerSet: new MulticastDelegate('timers.onTimerSet'),
  onTimerFired: new MulticastDelegate('timers.onTimerFired'),
  onTimerCleared: new MulticastDelegate('timers.onTimerCleared'),
  onTimerPaused: new MulticastDelegate('timers.onTimerPaused'),
};

/** How a finished timer behaves. */
export const TimerMode = {
  Once: 'once',
  Looping: 'looping',
};

let _nextTimerId = 1;

/**
 * A live timer. Handles stay meaningful after the timer fires (`isValid` goes false; `firedCount`
 * and `lastFiredAt` remain, which is what makes "did it run?" testable).
 */
export class TimerHandle {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.valid = true;
    this.paused = false;
    this.cancelled = false;
    this.firedCount = 0;
    this.lastFiredAt = null;
    this.age = 0;
  }

  get isValid() { return this.valid && !this.cancelled; }

  clear() {
    if (!this.manager) return false;
    return this.manager.clear(this);
  }

  toString() { return `Timer(${this.name}#${this.id}${this.valid ? '' : ' ended'})`; }
}

/**
 * Owns every timer: registration, advancing, pausing, rate scaling, owner-based cleanup and the
 * report a debug HUD shows.
 */
export class TimerManager {
  constructor({ name = 'Timers', stats = null, maxTimers = 4096, timeScale = 1 } = {}) {
    this.name = name;
    this.stats = stats;
    this.maxTimers = maxTimers;
    this.timeScale = timeScale;
    this.paused = false;
    /** @type {Map<number, object>} */
    this.timers = new Map();
    this.time = 0;                 // total advanced time (seconds)
    this.totalFired = 0;
    this.totalCleared = 0;
    this.dropped = 0;
    this.overflowWarned = false;
  }

  static create(options) { return new TimerManager(options); }

  get count() { return this.timers.size; }
  get activeCount() { return [...this.timers.values()].filter((timer) => timer.valid && !timer.cancelled).length; }

  // ------------------------------------------------------------------ creation
  /**
   * Sets a timer.
   * @param {string|TimerHandle|Function} handleOrName a name, a reusable handle, or the callback
   * @param {Function|object|Delegate} [callbackOrOptions] callback (function, owner, or delegate)
   * @param {object} [options] `{ time, firstDelay, looping, rate, owner, method, args, paused }`
   * @returns {TimerHandle}
   */
  setTimer(handleOrName, callbackOrOptions = {}, options = {}) {
    let name = 'Timer';
    let handle = null;
    let callback = callbackOrOptions;

    if (handleOrName instanceof TimerHandle) {
      handle = handleOrName;
      name = handleOrName.name;
      callback = typeof callbackOrOptions === 'function' ? callbackOrOptions : handleOrName.callback;
      options = { ...(handleOrName.options ?? {}), ...options };
    } else if (typeof handleOrName === 'string') {
      name = handleOrName;
    } else if (typeof handleOrName === 'function') {
      callback = handleOrName;
      options = typeof callbackOrOptions === 'object' && callbackOrOptions !== null ? callbackOrOptions : options;
    }

    const {
      time = 0, firstDelay = null, looping = false, rate = 1, owner = options.owner ?? null,
      method = null, args = null, paused = false, category = 'default',
    } = options;

    // `setTimer('Reload', weapon, { method: 'finishReload', time: 1.5 })`: the second argument is the
    // owner, not the callback. Without this the timer is registered with no callable at all and
    // silently does nothing when it expires.
    let resolvedOwner = owner;
    let resolvedCallback = callback;
    if (resolvedCallback && typeof resolvedCallback === 'object' && !resolvedCallback.broadcast && !resolvedCallback.execute) {
      resolvedOwner = resolvedCallback;
      resolvedCallback = null;
    }
    if (resolvedOwner && !resolvedCallback && !method) {
      throw new TypeError(`timers.setTimer("${name}"): an owner needs a method to call`);
    }

    if (!this.canAdd()) {
      log.warn(`timer "${name}" refused — ${this.maxTimers} timers already live`);
      return handle ?? new TimerHandle(0, name);
    }

    const entry = {
      id: _nextTimerId++,
      name,
      callback: resolvedCallback,
      owner: resolvedOwner,
      method,
      ownerRef: resolvedOwner && typeof WeakRef !== 'undefined' && options.weak !== false ? new WeakRef(resolvedOwner) : null,
      args,
      interval: Math.max(0, Number(time) || 0),
      firstDelay: firstDelay === null || firstDelay === undefined ? Math.max(0, Number(time) || 0) : Math.max(0, Number(firstDelay) || 0),
      remaining: firstDelay === null || firstDelay === undefined ? Math.max(0, Number(time) || 0) : Math.max(0, Number(firstDelay) || 0),
      looping: !!looping,
      rate: Number.isFinite(rate) && rate !== 0 ? Math.abs(rate) : 1,
      pauseCount: paused ? 1 : 0,
      category,
      setAt: this.time,
      firedCount: 0,
      firedLastTick: false,
      valid: true,
      cancelled: false,
    };

    if (handle) {
      // Re-arming a handle is the UE pattern (`SetTimer(ReloadHandle, …)` reuses the variable).
      handle.valid = true;
      handle.cancelled = false;
      handle.manager = this;
      handle.callback = entry.callback;
      handle.options = { ...options };
      handle.id = entry.id;
      handle.paused = entry.pauseCount > 0;
      entry.handle = handle;
    } else {
      handle = new TimerHandle(entry.id, name);
      handle.manager = this;
      handle.callback = entry.callback;
      handle.options = { ...options };
      handle.paused = entry.pauseCount > 0;
      entry.handle = handle;
    }
    // The handle keeps its own record so `getFiredCount(handle)`, `getRemaining(handle)` and friends
    // still answer after the timer has fired or been cleared — "did it run, and how often?" is a
    // question asked after the fact.
    handle.entry = entry;
    this.timers.set(entry.id, entry);
    timerEvents.onTimerSet.broadcast(handle, entry, this);
    this.stats?.count('Timers/Set');
    this.stats?.gauge('Timers/Active', this.timers.size);
    return handle;
  }

  /** `setTimeout` shape: runs once after `seconds`. */
  after(seconds, callback, options = {}) {
    return this.setTimer(options.name ?? 'After', callback, { ...options, time: seconds });
  }

  /** `setInterval` shape: runs every `seconds` until cleared or its owner dies. */
  every(seconds, callback, options = {}) {
    return this.setTimer(options.name ?? 'Every', callback, { ...options, time: seconds, looping: true });
  }

  /** Runs on the next advance — one frame later, no guessing. */
  nextTick(callback, options = {}) {
    return this.setTimer(options.name ?? 'NextTick', callback, { ...options, time: 0 });
  }

  /** Runs after `delay` *seconds after* the first interval (the ability-cooldown shape). */
  everyWithDelay(delay, seconds, callback, options = {}) {
    return this.setTimer(options.name ?? 'EveryDelayed', callback, { ...options, time: seconds, firstDelay: delay, looping: true });
  }

  canAdd() { return this.timers.size < this.maxTimers || this.overflowWarned; }

  // ------------------------------------------------------------------ queries
  get(handle) {
    const id = handle instanceof TimerHandle ? handle.id : handle;
    return this.timers.get(id) ?? (handle instanceof TimerHandle ? handle.entry ?? null : null);
  }
  isActive(handle) {
    const entry = handle instanceof TimerHandle ? this.timers.get(handle.id) : this.timers.get(handle);
    return !!entry && entry.valid && !entry.cancelled;
  }
  isPaused(handle) { return (this.get(handle)?.pauseCount ?? 0) > 0; }
  getRemaining(handle) { return Math.max(0, this.get(handle)?.remaining ?? 0); }
  getElapsed(handle) {
    const entry = this.get(handle);
    if (!entry) return 0;
    return this.time - entry.setAt - entry.remaining;
  }
  getRate(handle) { return this.get(handle)?.rate ?? 1; }
  getFiredCount(handle) { return this.get(handle)?.firedCount ?? 0; }
  /** Total duration of the timer when it was set (the `time` it will fire on). */
  getInterval(handle) { return this.get(handle)?.interval ?? 0; }
  getProgress(handle) {
    const entry = this.get(handle);
    if (!entry) return 1;
    const total = entry.firedCount === 0 ? entry.firstDelay : entry.interval;
    if (total <= 0) return 1;
    return Math.min(1, Math.max(0, 1 - entry.remaining / total));
  }

  /** Every timer belonging to an owner (a weapon, a bot, a subsystem) — used by debug tooling. */
  handlersFor(owner) {
    if (!owner) return [];
    return [...this.timers.values()]
      .filter((entry) => entry.owner === owner || entry.ownerRef?.deref() === owner)
      .map((entry) => entry.handle);
  }

  /** Names of active timers, for a HUD or a test assertion. */
  activeNames() { return [...this.timers.values()].filter((entry) => entry.valid).map((entry) => entry.name); }
  entries() { return [...this.timers.values()].filter((entry) => entry.valid); }

  // ------------------------------------------------------------------ control
  setRate(handle, rate) {
    const entry = this.get(handle);
    if (!entry) return false;
    entry.rate = Number.isFinite(rate) && rate !== 0 ? Math.abs(rate) : 1;
    return true;
  }

  pause(handle = null) {
    if (handle === null) { this.paused = true; return true; }
    const entry = this.get(handle);
    if (!entry) return false;
    entry.pauseCount++;
    if (entry.handle) entry.handle.paused = true;
    timerEvents.onTimerPaused.broadcast(entry.handle, true, this);
    return true;
  }

  resume(handle = null) {
    if (handle === null) { this.paused = false; return true; }
    const entry = this.get(handle);
    if (!entry) return false;
    entry.pauseCount = Math.max(0, entry.pauseCount - 1);
    if (entry.handle) entry.handle.paused = entry.pauseCount > 0;
    timerEvents.onTimerPaused.broadcast(entry.handle, false, this);
    return true;
  }

  togglePaused(handle) { return this.isPaused(handle) ? this.resume(handle) : this.pause(handle); }

  /** Re-arms a timer with the same callback and interval, keeping its handle. */
  reset(handle, { firstDelay = null } = {}) {
    const entry = this.get(handle);
    if (!entry) return false;
    entry.remaining = firstDelay ?? entry.firstDelay;
    entry.setAt = this.time;
    entry.firedCount = 0;
    return true;
  }

  /** Replaces the interval of a live timer (a weapon swap changes its cycle time). */
  setInterval(handle, seconds) {
    const entry = this.get(handle);
    if (!entry) return false;
    entry.interval = Math.max(0, Number(seconds) || 0);
    entry.remaining = Math.min(entry.remaining, entry.interval);
    return true;
  }

  /** Clears one timer. The handle stays usable (its counters remain for inspection). */
  clear(handle) {
    const id = handle instanceof TimerHandle ? handle.id : handle;
    const entry = this.timers.get(id);
    if (!entry) {
      if (handle instanceof TimerHandle) { handle.valid = false; handle.cancelled = true; }
      return false;
    }
    this.timers.delete(entry.id);
    entry.valid = false;
    entry.cancelled = true;
    if (entry.handle) { entry.handle.valid = false; entry.handle.cancelled = true; }
    this.totalCleared++;
    this.stats?.count('Timers/Cleared');
    this.stats?.gauge('Timers/Active', this.timers.size);
    timerEvents.onTimerCleared.broadcast(entry.handle, this);
    return true;
  }

  /** Clears every timer for an owner — what a destroyed weapon/actor does in its teardown. */
  clearAllFor(owner) {
    let cleared = 0;
    for (const handle of this.handlersFor(owner)) if (this.clear(handle)) cleared++;
    return cleared;
  }

  /** Clears everything matching a name or category (a gamemode restart). */
  clearMatching({ name = null, category = null } = {}) {
    let cleared = 0;
    for (const entry of [...this.timers.values()]) {
      if (name && entry.name !== name) continue;
      if (category && entry.category !== category) continue;
      if (this.clear(entry.handle)) cleared++;
    }
    return cleared;
  }

  clearAll() {
    const cleared = this.timers.size;
    for (const entry of this.timers.values()) {
      entry.valid = false;
      entry.cancelled = true;
      if (entry.handle) { entry.handle.valid = false; entry.handle.cancelled = true; }
    }
    this.timers.clear();
    this.totalCleared += cleared;
    return cleared;
  }

  // ------------------------------------------------------------------ advancing
  /**
   * Advances every timer by `deltaSeconds` (already scaled by the caller's clock). Fires callbacks
   * whose time elapsed, in deterministic order (soonest first, then insertion order).
   */
  advance(deltaSeconds) {
    if (deltaSeconds <= 0) return 0;
    const delta = this.paused ? 0 : deltaSeconds * this.timeScale;
    if (delta <= 0) return 0;
    this.time += delta;
    if (!this.timers.size) return 0;

    let fired = 0;
    const ready = [];
    for (const entry of this.timers.values()) {
      if (!entry.valid) continue;
      entry.firedLastTick = false;
      if (entry.pauseCount > 0) continue;
      if (entry.ownerRef && !entry.ownerRef.deref()) {
        // The owner was collected: the timer is dead weight, drop it quietly.
        this.clear(entry.handle);
        continue;
      }
      entry.remaining -= delta * entry.rate;
      // Epsilon: 1/60 s steps do not add up to exactly 0.1 s, and "fires on the 7th tick instead of
      // the 6th" is a 16 % rate error that accumulates for the whole match.
      if (entry.remaining <= TIMER_EPSILON) ready.push(entry);
    }

    ready.sort((a, b) => (a.remaining === b.remaining ? a.id - b.id : a.remaining - b.remaining));
    for (const entry of ready) {
      if (!entry.valid) continue;
      entry.firedCount++;
      entry.firedLastTick = true;
      fired++;
      this.totalFired++;
      this.stats?.count('Timers/Fired');
      if (entry.handle) entry.handle.firedCount = entry.firedCount;
      if (entry.handle) entry.handle.lastFiredAt = this.time;
      // Reschedule before invoking: a callback that clears or re-arms itself must not double-fire.
      if (entry.looping) {
        // Phase-correct reschedule: a timer that fired 5 ms late keeps that 5 ms instead of drifting.
        // Each timer fires at most once per advance (UE's behaviour), so a large `deltaSeconds`
        // restarts the cycle rather than firing a burst — the fixed-step clock keeps the rate honest.
        const overshoot = entry.remaining;
        let next = entry.interval + overshoot;
        if (entry.interval <= 0) next = 0;
        else if (!(next > 0) || overshoot <= -entry.interval) next = entry.interval;
        entry.remaining = next;
      } else {
        this.timers.delete(entry.id);
        entry.valid = false;
        if (entry.handle) entry.handle.valid = false;
      }
      try {
        this._invoke(entry);
        timerEvents.onTimerFired.broadcast(entry.handle, entry, this);
      } catch (error) {
        // One bad callback must not stop the rest of the frame's timers.
        log.error(`timer "${entry.name}" threw: ${error?.message ?? error}`);
      }
    }
    this.stats?.gauge('Timers/Active', this.timers.size);
    return fired;
  }

  _invoke(entry) {
    const owner = entry.ownerRef ? entry.ownerRef.deref() : entry.owner;
    if (entry.ownerRef && !owner) return;
    if (entry.args) {
      if (typeof entry.callback === 'function') entry.callback(...entry.args);
      else if (entry.callback?.broadcast) entry.callback.broadcast(...entry.args);
      else if (owner && entry.method && typeof owner[entry.method] === 'function') owner[entry.method](...entry.args);
      return;
    }
    if (typeof entry.callback === 'function') { entry.callback(); return; }
    if (entry.callback?.execute) { entry.callback.execute(); return; }
    if (entry.callback?.broadcast) { entry.callback.broadcast(); return; }
    if (owner && entry.method && typeof owner[entry.method] === 'function') owner[entry.method]();
  }

  /** Alias matching the engine vocabulary (`engine.frame()` calls `advance`). */
  tick(deltaSeconds) { return this.advance(deltaSeconds); }

  // ------------------------------------------------------------------ reporting
  describe() {
    return {
      name: this.name,
      time: round3(this.time),
      scale: this.timeScale,
      paused: this.paused,
      active: this.timers.size,
      fired: this.totalFired,
      cleared: this.totalCleared,
      timers: [...this.timers.values()].slice(0, 40).map((entry) => ({
        id: entry.id, name: entry.name, category: entry.category, remaining: round3(entry.remaining),
        interval: round3(entry.interval), rate: entry.rate, looping: entry.looping, fired: entry.firedCount,
        paused: entry.pauseCount > 0, owner: entry.owner?.constructor?.name ?? null,
      })),
    };
  }

  format() {
    const lines = [
      `  ${this.name}: ${this.timers.size} active · ${this.totalFired} fired · ${this.totalCleared} cleared · clock ${round3(this.time)}s${this.paused ? ' (paused)' : ''}`,
    ];
    for (const entry of this.describe().timers.slice(0, 12)) {
      lines.push(`  ${String(entry.name).padEnd(20)} ${String(entry.remaining).padStart(9)}s / ${String(entry.interval).padStart(8)}s ×${entry.rate} ${entry.looping ? 'loop ' : 'once '} fired ${entry.fired}${entry.paused ? ' [paused]' : ''}`);
    }
    return lines.join('\n');
  }

  /** Console commands: inspect, clear, pause and rate-scale timers live. */
  installConsoleCommands(console_) {
    const timers = this;
    console_.registerCommand({ name: 'timers', aliases: ['timer.list'], category: 'Timers', description: 'Live timers with remaining time, rate and fire count.', execute: () => timers.format() });
    console_.registerCommand({
      name: 'timer.clear', category: 'Timers', description: 'Clears timers by name, category or all of them.',
      args: [{ name: 'name', required: false, description: 'timer name (omit for all)' }],
      execute: (args) => {
        const cleared = args.name ? timers.clearMatching({ name: args.name }) : timers.clearAll();
        return `cleared ${cleared} timers`;
      },
    });
    console_.registerCommand({
      name: 'timers.pause', category: 'Timers', description: 'Pauses every timer (or all of them).',
      execute: () => { timers.pause(); return 'timers paused'; },
    });
    console_.registerCommand({
      name: 'timers.resume', category: 'Timers', description: 'Resumes timer advancement.',
      execute: () => { timers.resume(); return 'timers resumed'; },
    });
    console_.registerCommand({
      name: 'timers.scale', category: 'Timers', description: 'Scales how fast timers advance.',
      args: [{ name: 'scale', type: 'number', min: 0, max: 20 }],
      execute: (args) => { timers.timeScale = args.scale; return `timer scale = ${args.scale}`; },
    });
    return console_;
  }
}

const TIMER_EPSILON = 1e-9;

function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }

export default TimerManager;
