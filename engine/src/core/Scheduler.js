/**
 * OminX Engine — task scheduler & frame loop.
 *
 * Mirrors Roblox's scheduler semantics (`RunService.Heartbeat/Stepped/RenderStepped`,
 * `task.spawn/defer/delay/wait`) on top of a fixed-timestep accumulator, which is what
 * an authoritative FPS needs: simulation advances in fixed ticks (deterministic physics,
 * stable gunplay), while rendering can run at any refresh rate.
 *
 * @module engine/core/Scheduler
 */
import { Signal } from './Signal.js';
import { clamp } from '../math/MathUtils.js';

export const RunPhase = {
  /** Before anything else each frame — input sampling, network receive. */
  PreRender: 'PreRender',
  /** Before each simulation step (may run 0..N times per frame). */
  PreSimulation: 'PreSimulation',
  /** Inside each simulation step, after physics integration. */
  Stepped: 'Stepped',
  /** Once per frame after the last simulation step — animation, IK, camera. */
  PreAnimation: 'PreAnimation',
  /** Once per frame — main game logic tick (per-frame, variable dt). */
  Heartbeat: 'Heartbeat',
  /** Once per frame just before rendering — UI, HUD, interpolation. */
  RenderStepped: 'RenderStepped',
  /** Once per frame after the scene was submitted to the GPU. */
  PostRender: 'PostRender',
};

export class Scheduler {
  /**
   * @param {object} [opts]
   * @param {number} [opts.tickRate=60] fixed simulation rate (Hz)
   * @param {number} [opts.maxSubSteps=5] clamp on catch-up steps (prevents death spiral)
   * @param {number} [opts.maxDeltaTime=0.25] clamp on frame delta (seconds)
   */
  constructor(opts = {}) {
    this.tickRate = opts.tickRate ?? 60;
    this.fixedDeltaTime = 1 / this.tickRate;
    this.maxSubSteps = opts.maxSubSteps ?? 5;
    this.maxDeltaTime = opts.maxDeltaTime ?? 0.25;
    this.timeScale = 1;

    this.time = 0;                 // total simulated time (s)
    this.frameCount = 0;           // frames rendered
    this.tickCount = 0;            // simulation steps executed
    this.deltaTime = 0;            // last frame delta (s)
    this.smoothedDelta = 1 / 60;   // EMA of frame delta
    this.alpha = 0;                // interpolation factor between physics ticks
    this.elapsed = 0;              // wall clock since start (s)
    this.paused = false;
    this.stepRequested = 0;        // for debugger single-step

    this._accumulator = 0;
    this._lastWallClock = 0;
    this._running = false;
    this._rafId = null;
    this._now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // phase signals
    this.PreRender = new Signal('PreRender');
    this.PreSimulation = new Signal('PreSimulation');
    this.Stepped = new Signal('Stepped');
    this.PreAnimation = new Signal('PreAnimation');
    this.Heartbeat = new Signal('Heartbeat');
    this.RenderStepped = new Signal('RenderStepped');
    this.PostRender = new Signal('PostRender');
    /** Fires when a frame's budget was exceeded (perf HUD + adaptive quality). */
    this.BudgetExceeded = new Signal('BudgetExceeded');
    this.Frame = new Signal('Frame');

    // frame budget (ms) — exceeded frames are reported to the perf monitor
    this.frameBudgetMs = 16.7;

    this._delayed = [];
    this._deferred = [];
    this._prioritized = new Map();
    this._nextOrder = 0;
    /** Ordered, bindable render/sim callbacks with priority (like Unity's script execution order). */
    this._tickCallbacks = [];

    // perf metrics
    this.metrics = {
      fps: 0, frameMs: 0, simMs: 0, renderMs: 0, uiMs: 0, netMs: 0,
      scriptMs: 0, physicsMs: 0, drawCalls: 0, triangles: 0, subSteps: 0,
    };
    this._fpsSamples = new Float32Array(120);
    this._fpsIndex = 0;
    this._lastFpsUpdate = 0;
    this._frameStart = 0;
    this._simStart = 0;
  }

  // ---------------------------------------------------------------- scheduling
  /** Registers an ordered callback. Lower priority runs first. Returns a disposer. */
  addTickCallback(fn, priority = 0) {
    const entry = { fn, priority, order: this._nextOrder++ };
    this._tickCallbacks.push(entry);
    this._tickCallbacks.sort((a, b) => a.priority - b.priority || a.order - b.order);
    return () => {
      const i = this._tickCallbacks.indexOf(entry);
      if (i >= 0) this._tickCallbacks.splice(i, 1);
    };
  }

  // ---------------------------------------------------------------- task API
  /** Runs immediately (well, on the next microtask) — Roblox `task.defer`. */
  defer(fn, ...args) {
    this._deferred.push({ fn, args, cancelled: false });
    const task = {
      cancel: () => { for (const d of this._deferred) if (d.fn === fn) d.cancelled = true; },
    };
    return task;
  }
  /** Spawns a coroutine-like task from a generator function, resumed each tick. */
  spawn(fnOrGen, ...args) {
    const task = new Task(fnOrGen, args, this);
    task.resume();
    return task;
  }
  /** Schedules a delayed call. */
  delay(seconds, fn, ...args) {
    const handle = {
      time: this.time + Math.max(0, seconds),
      fn, args, cancelled: false,
      cancel() { this.cancelled = true; },
    };
    this._delayed.push(handle);
    return handle;
  }
  /** Yields `seconds` inside a spawned task. */
  wait(seconds) { return { __wait: Math.max(0, seconds ?? 0), scheduledAt: this.time }; }

  /** True if the current frame budget is blown (used to skip cosmetic work). */
  isOverBudget() { return (this._now() - this._frameStart) > this.frameBudgetMs; }

  // ---------------------------------------------------------------- frame loop
  /** Advance one frame. Called by the host (RAF loop, headless server loop or editor). */
  update(deltaOverride) {
    const now = this._now();
    if (deltaOverride === undefined) {
      let delta = this._lastWallClock ? (now - this._lastWallClock) / 1000 : this.fixedDeltaTime;
      this._lastWallClock = now;
      delta = clamp(delta, 0, this.maxDeltaTime);
      this.deltaTime = delta;
    } else {
      this.deltaTime = clamp(deltaOverride, 0, this.maxDeltaTime);
      this._lastWallClock = now;
    }
    this.frameCount++;
    this._frameStart = now;
    const dt = this.deltaTime * this.timeScale;
    this.smoothedDelta = this.smoothedDelta * 0.9 + this.deltaTime * 0.1;
    this.elapsed += this.deltaTime;

    if (this.paused && this.stepRequested <= 0) {
      // Still render, but freeze time — editor pause & multiplayer "pause menu" behaviour.
      this.PreRender.emit(this.deltaTime, this.time);
      for (const cb of this._tickCallbacks) cb.fn(0, this);
      this.RenderStepped.emit(this.deltaTime, this.time);
      this.Frame.emit(this);
      this.PostRender.emit(this.deltaTime);
      this._updateFps(now);
      return;
    }
    if (this.stepRequested > 0) this.stepRequested--;

    // 1) pre-frame (input, network receive)
    this.PreRender.emit(dt, this.time);

    // 2) fixed-step simulation
    this._accumulator += dt;
    let steps = 0;
    const simStart = now;
    const maxSteps = this.paused ? 1 : this.maxSubSteps;
    while (this._accumulator >= this.fixedDeltaTime && steps < maxSteps) {
      this._simStart = this._now();
      this.PreSimulation.emit(this.fixedDeltaTime, this.time);
      this.Stepped.emit(this.fixedDeltaTime, this.time);
      this._accumulator -= this.fixedDeltaTime;
      this.time += this.fixedDeltaTime;
      this.tickCount++;
      steps++;
    }
    if (steps === maxSteps) this._accumulator = Math.min(this._accumulator, this.fixedDeltaTime);
    this.alpha = this._accumulator / this.fixedDeltaTime;
    this.metrics.subSteps = steps;
    this.metrics.simMs = this._now() - simStart;

    // 3) per-frame logic (camera, animation, HUD, bots decisions)
    for (let i = 0; i < this._deferred.length; i++) {
      const d = this._deferred[i];
      if (!d.cancelled) {
        try { d.fn(...d.args); } catch (err) { handleTaskError(err); }
      }
    }
    this._deferred.length = 0;
    for (let i = this._delayed.length - 1; i >= 0; i--) {
      const d = this._delayed[i];
      if (d.cancelled) { this._delayed.splice(i, 1); continue; }
      if (d.time <= this.time) {
        this._delayed.splice(i, 1);
        try { d.fn(...d.args); } catch (err) { handleTaskError(err); }
      }
    }
    const scriptStart = this._now();
    for (const cb of this._tickCallbacks) cb.fn(this.deltaTime, this);
    this.metrics.scriptMs = this._now() - scriptStart;

    this.PreAnimation.emit(this.deltaTime, this.time);
    this.Heartbeat.emit(this.deltaTime, this.time);
    this.RenderStepped.emit(this.deltaTime, this.time);
    this.Frame.emit(this);
    const total = this._now() - this._frameStart;
    this.metrics.frameMs = total;
    this.PostRender.emit(this.deltaTime);
    if (total > this.frameBudgetMs) this.BudgetExceeded.emit(total, this.frameBudgetMs);
    this._updateFps(this._frameStart);
  }

  /** Start a requestAnimationFrame loop (browser). */
  start() {
    if (this._running) return this;
    this._running = true;
    this._lastWallClock = this._now();
    let last = this._now();
    const loop = () => {
      if (!this._running) return;
      // Cap the RAF delta to maxDeltaTime to avoid huge catch-ups after tab throttling.
      const now = this._now();
      this.deltaTime = clamp((now - last) / 1000, 0, this.maxDeltaTime);
      last = now;
      this.update(this.deltaTime);
      this._rafId = raf(loop);
    };
    this._rafId = raf(loop);
    return this;
  }
  stop() {
    this._running = false;
    if (this._rafId !== null) cancelRaf(this._rafId);
    this._rafId = null;
    return this;
  }
  get running() { return this._running; }
  get framerate() { return this.metrics.fps; }

  stepOnce(count = 1) { this.stepRequested += count; return this; }
  setPaused(p) { this.paused = !!p; return this; }
  togglePause() { this.paused = !this.paused; return this; }

  /** Resets simulation clocks (used when loading a new map / restarting a round). */
  resetTime() {
    this.time = 0; this.tickCount = 0; this._accumulator = 0;
    return this;
  }
  /** Sets Time.timeScale — 0.25 = slow-motion death cam, 0 = frozen. */
  setTimeScale(s) { this.timeScale = Math.max(0, s); return this; }

  _updateFps(now) {
    this._fpsSamples[this._fpsIndex] = this.smoothedDelta;
    this._fpsIndex = (this._fpsIndex + 1) % this._fpsSamples.length;
    if (now - this._lastFpsUpdate > 250) {
      let sum = 0;
      for (let i = 0; i < this._fpsSamples.length; i++) sum += this._fpsSamples[i];
      const avg = sum / this._fpsSamples.length;
      this.metrics.fps = avg > 0 ? 1 / avg : 0;
      this._lastFpsUpdate = now;
    }
  }
  /** 1% low frame time in ms (stutter metric — matters for FPS feel). */
  getLowFps(percentile = 0.01) {
    const arr = Array.from(this._fpsSamples).filter((v) => v > 0).sort((a, b) => b - a);
    const idx = Math.max(0, Math.floor(arr.length * percentile) - 1);
    const dt = arr[idx] ?? this.smoothedDelta;
    return dt > 0 ? 1 / dt : 0;
  }
  getMetrics() {
    return { ...this.metrics, fps1Low: this.getLowFps(), time: this.time, ticks: this.tickCount, frames: this.frameCount };
  }
}

/** A generator-driven task, resumed every frame (Roblox `task.spawn` / Unity coroutine). */
export class Task {
  constructor(fnOrGen, args, scheduler) {
    this.scheduler = scheduler;
    this.finished = false;
    this.cancelled = false;
    this._wakeAt = scheduler.time;
    this._iterator = null;
    this._waiting = null;
    if (typeof fnOrGen === 'function') {
      this._iterator = emulateCoroutine(fnOrGen, args);
    } else if (fnOrGen && typeof fnOrGen.next === 'function') {
      this._iterator = fnOrGen;
    } else {
      this.finished = true;
    }
  }
  /** Called by the scheduler each frame. */
  step() {
    if (this.finished || this.cancelled || !this._iterator) return false;
    if (this.scheduler.time < this._wakeAt) return true;
    try {
      const res = this._iterator.next();
      if (res.done) { this.finished = true; return false; }
      const value = res.value;
      if (value && typeof value === 'object' && '__wait' in value) {
        this._wakeAt = this.scheduler.time + value.__wait;
      } else if (typeof value === 'number') {
        this._wakeAt = this.scheduler.time + Math.max(0, value);
      } else {
        this._wakeAt = this.scheduler.time;
      }
    } catch (err) {
      handleTaskError(err);
      this.finished = true;
      return false;
    }
    return true;
  }
  resume() { this.step(); }
  cancel() { this.cancelled = true; this.finished = true; }
  get running() { return !this.finished && !this.cancelled; }
}

/** Lets a plain function that calls `scheduler.wait()` internally behave like a coroutine. */
function* emulateCoroutine(fn, args) {
  yield* fn(...args);
}

function handleTaskError(err) {
  // eslint-disable-next-line no-console
  console.error('[OminX] uncaught error in scheduled task:', err);
}

function raf(fn) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
  return setTimeout(() => fn(), 16);
}
function cancelRaf(id) {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
}

/**
 * Standalone fixed-step driver for headless use (dedicated servers, tests, benchmarks):
 * runs N ticks per second of simulated time as fast as possible or in real time.
 */
export class HeadlessLoop {
  constructor(scheduler, { realtime = true, catchUpLimit = 8 } = {}) {
    this.scheduler = scheduler;
    this.realtime = realtime;
    this.catchUpLimit = catchUpLimit;
    this._timer = null;
    this._last = Date.now();
    this._running = false;
  }
  start() {
    if (this._running) return this;
    this._running = true;
    this._last = Date.now();
    const intervalMs = 1000 / this.scheduler.tickRate;
    const tick = () => {
      if (!this._running) return;
      const now = Date.now();
      let frameTime = (now - this._last) / 1000;
      this._last = now;
      if (!this.realtime) frameTime = this.scheduler.fixedDeltaTime;
      if (frameTime > this.scheduler.maxDeltaTime) frameTime = this.scheduler.maxDeltaTime;
      this.scheduler.update(frameTime);
      this._timer = setTimeout(tick, this.realtime ? Math.max(0, intervalMs - (Date.now() - now)) : 0);
    };
    this._timer = setTimeout(tick, 0);
    return this;
  }
  stop() { this._running = false; if (this._timer) clearTimeout(this._timer); return this; }
  get running() { return this._running; }
}

export default Scheduler;
