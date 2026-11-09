/**
 * OminX Engine — async tasks, cancellation and a bounded worker pool.
 *
 * Not every job belongs on the frame graph. Decoding a texture, baking a navmesh tile, compressing
 * a replay or exporting a save can take milliseconds that a 16 ms frame cannot spare. This is the
 * layer those jobs go through, with the rules UE's `Async`/`TaskGraph` teach:
 *
 *   - **Explicit tasks, not naked promises.** Every unit of work has an id, a name, a group, a
 *     priority, a state, attempts, progress, elapsed time and a cancellable token. Debug tooling
 *     can therefore answer "what is running, who submitted it, and how long has it taken?".
 *   - **Bounded concurrency.** A scheduler starts at most `concurrency` tasks per drain; the rest
 *     wait in a priority queue. Draining is deterministic (higher priority first, insertion order
 *     on ties) and can be driven by the engine's frame or by a test loop.
 *   - **Cancellation is cooperative and observable.** A `CancellationToken` reaches the task's
 *     body; cancel rejects the task promptly, and an `AsyncScope` cancels everything it submitted
 *     on teardown (a map change must not leave a dozen decodes running).
 *   - **Pluggable execution.** The default executor runs work on the main thread (correct in Node,
 *     in a browser, and in a test). A `WorkerPool` can be plugged in for real off-thread work
 *     without changing any caller.
 *
 * ```
 * const scheduler = engine.tasks;
 * const task = scheduler.submit('navmesh.bake', async ({ token, progress }) => {
 *   for (const tile of tiles) { token.throwIfCancelled(); bake(tile); progress(done++ / tiles.length); }
 *   return navmesh;
 * }, { priority: TaskPriority.High, group: 'navigation' });
 * const navmesh = await task.promise;
 * ```
 *
 * @module engine/src/core/Async
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Async');

/** Observable task lifecycle. Listener errors are isolated by the delegates. */
export const asyncEvents = {
  onSubmitted: new MulticastDelegate('async.onSubmitted'),
  onStarted: new MulticastDelegate('async.onStarted'),
  onProgress: new MulticastDelegate('async.onProgress'),
  onCompleted: new MulticastDelegate('async.onCompleted'),
  onFailed: new MulticastDelegate('async.onFailed'),
  onRetried: new MulticastDelegate('async.onRetried'),
  onCancelled: new MulticastDelegate('async.onCancelled'),
  onDrained: new MulticastDelegate('async.onDrained'),
};

export const TaskState = Object.freeze({
  Pending: 'pending', Queued: 'queued', Running: 'running',
  Succeeded: 'succeeded', Failed: 'failed', Cancelled: 'cancelled',
});

export const TaskPriority = Object.freeze({
  Lowest: -100, Low: -10, Normal: 0, High: 10, Highest: 100,
});

export class CancellationError extends Error {
  constructor(reason = 'cancelled') {
    super(typeof reason === 'string' ? reason : (reason?.message ?? 'cancelled'));
    this.name = 'CancellationError';
    this.reason = reason;
  }
}

/** Owns a token and cancels every listener exactly once. */
export class CancellationSource {
  constructor(name = 'token') {
    this.name = name;
    this._cancelled = false;
    this._reason = null;
    this._listeners = [];
    this._token = null;
  }

  get token() { return this._token ??= new CancellationToken(this); }
  get cancelled() { return this._cancelled; }
  get reason() { return this._reason; }

  cancel(reason = 'cancelled') {
    if (this._cancelled) return false;
    this._cancelled = true;
    this._reason = reason;
    const listeners = this._listeners.splice(0);
    for (const listener of listeners) {
      if (listener.handle) {
        if (!listener.handle._valid) continue;
        listener.handle._valid = false; // a fired cancellation listener is spent, like `once`
      }
      try { listener.fn(reason); } catch (error) { log.error(`cancellation listener threw: ${error?.message ?? error}`); }
    }
    return true;
  }

  onCancelled(fn) { return this.token.onCancelled(fn); }
  describe() { return { name: this.name, cancelled: this._cancelled, reason: this._reason, listeners: this._listeners.length }; }
}

/** Read-only view of a `CancellationSource`, passed into task bodies. */
export class CancellationToken {
  constructor(source) { this.source = source; }

  static get none() { return _noneToken; }

  get cancelled() { return this.source.cancelled; }
  get reason() { return this.source.reason; }

  throwIfCancelled() { if (this.cancelled) throw new CancellationError(this.reason); }

  onCancelled(fn) {
    if (typeof fn !== 'function') throw new TypeError('CancellationToken.onCancelled() needs a function');
    const source = this.source;
    if (source.cancelled) {
      try { fn(source.reason); } catch { /* isolated like every callback */ }
      return { _valid: false, get isValid() { return this._valid; }, unbind: () => false };
    }
    const handle = {
      _valid: true,
      get isValid() { return this._valid; },
      unbind() {
        if (!this._valid) return false;
        this._valid = false;
        const index = source._listeners.findIndex((listener) => listener.handle === handle);
        if (index >= 0) source._listeners.splice(index, 1);
        return true;
      },
    };
    source._listeners.push({ fn, handle });
    return handle;
  }
}

const _noneSource = new CancellationSource('none');
const _noneToken = new CancellationToken(_noneSource);

/** One unit of asynchronous work. `promise` settles once; a no-op catch avoids unhandled warnings. */
export class AsyncTask {
  constructor({ id, name = 'task', run, priority = TaskPriority.Normal, group = 'default', token = null, retries = 0, metadata = null, timeoutMs = 0 }) {
    this.id = id;
    this.name = name;
    this.run = run;
    this.priority = priority;
    this.group = group;
    this.token = token ?? CancellationToken.none;
    this.retries = Math.max(0, Math.floor(retries));
    this.metadata = metadata ?? {};
    this.timeoutMs = Math.max(0, Number(timeoutMs) || 0);
    this.state = TaskState.Pending;
    this.result = undefined;
    this.error = null;
    this.cancelReason = null;
    this.progress = 0;
    this.attempts = 0;
    this.startedAt = null;
    this.finishedAt = null;
    this.durationMs = 0;
    this.submittedAt = nowMs();
    this.scheduler = null;
    this._timer = null;
    this.promise = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    this.promise.catch(() => {});
  }

  get isDone() {
    return this.state === TaskState.Succeeded || this.state === TaskState.Failed || this.state === TaskState.Cancelled;
  }

  /** Called by the task body to report 0…1 progress. */
  reportProgress(value) {
    const next = Math.min(1, Math.max(0, Number(value) || 0));
    if (next <= this.progress || this.isDone) return this.progress;
    this.progress = next;
    asyncEvents.onProgress.broadcast(this, next);
    return next;
  }

  cancel(reason = 'cancelled') {
    if (this.scheduler) return this.scheduler.cancelTask(this, reason);
    return this._cancel(reason);
  }

  _cancel(reason) {
    if (this.isDone) return false;
    this.state = TaskState.Cancelled;
    this.cancelReason = reason;
    this.error = new CancellationError(reason);
    this.finishedAt = nowMs();
    this.durationMs = this.finishedAt - (this.startedAt ?? this.submittedAt);
    this._clearTimer();
    this._reject(this.error);
    asyncEvents.onCancelled.broadcast(this, reason);
    return true;
  }

  _clearTimer() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

  describe() {
    return {
      id: this.id, name: this.name, group: this.group, priority: this.priority,
      state: this.state, progress: this.progress, attempts: this.attempts,
      retries: this.retries, durationMs: round3(this.durationMs),
      cancelled: this.token.cancelled, timeoutMs: this.timeoutMs,
      error: this.error?.message ?? null, hasResult: this.result !== undefined,
    };
  }
}

/**
 * A priority-queued, concurrency-bounded task scheduler. Nothing starts implicitly unless
 * `autoRun` is set; the engine pumps `drain()` on its frame, and tests drive it explicitly.
 */
export class TaskScheduler {
  constructor({ name = 'Tasks', concurrency = 4, stats = null, maxQueue = 1024, executor = null, autoRun = false, paused = false } = {}) {
    this.name = name;
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.stats = stats;
    this.maxQueue = Math.max(1, Math.floor(maxQueue));
    this.executor = executor ?? defaultExecutor;
    this.autoRun = !!autoRun;
    this.paused = !!paused;
    this.queue = [];
    this.running = new Map();
    this.history = [];
    this.tick = 0;
    this._seq = 0;
    this.submitted = 0;
    this.completed = 0;
    this.failed = 0;
    this.cancelled = 0;
    this.retried = 0;
    this.dropped = 0;
    this._draining = false;
    this._autoScheduled = false;
  }

  static create(options) { return new TaskScheduler(options); }

  get count() { return this.queue.length; }
  get runningCount() { return this.running.size; }
  get activeCount() { return this.queue.length + this.running.size; }

  /**
   * `submit('nav.bake', fn, { priority })` or `submit({ name, run, priority, … })`.
   * Returns an `AsyncTask`; `await task.promise` for the result.
   */
  submit(nameOrOptions, run = null, options = {}) {
    let spec;
    if (nameOrOptions && typeof nameOrOptions === 'object') spec = { ...nameOrOptions };
    else spec = { ...options, name: nameOrOptions ?? 'task', run: run ?? options.run ?? null };
    if (typeof spec.run !== 'function') throw new TypeError('TaskScheduler.submit() needs a run function');
    if (this.queue.length + this.running.size >= this.maxQueue) {
      this.dropped++;
      log.warn(`task queue \"${this.name}\" is full — dropped \"${spec.name}\"`);
      const rejected = new AsyncTask({ id: -1, name: spec.name, run: spec.run, priority: spec.priority ?? 0, group: spec.group ?? 'default' });
      rejected._reject(new Error(`task queue full (${this.maxQueue})`));
      rejected.state = TaskState.Failed;
      rejected.error = new Error(`task queue full (${this.maxQueue})`);
      return rejected;
    }
    const task = new AsyncTask({
      id: ++this._seq, name: spec.name, run: spec.run,
      priority: spec.priority ?? TaskPriority.Normal, group: spec.group ?? 'default',
      token: spec.token ?? null, retries: spec.retries ?? 0, metadata: spec.metadata ?? null,
      timeoutMs: spec.timeoutMs ?? 0,
    });
    task.scheduler = this;
    task.state = TaskState.Queued;
    this.queue.push(task);
    this.submitted++;
    this.stats?.count('Async/Submitted');
    this.stats?.gauge('Async/Queued', this.queue.length);
    asyncEvents.onSubmitted.broadcast(task, this);
    if (this.autoRun) this._scheduleAutoDrain();
    return task;
  }

  _scheduleAutoDrain() {
    // A frame-pumped scheduler must stay fully deterministic: only `autoRun` hosts kick a microtask.
    if (!this.autoRun || this._autoScheduled) return;
    this._autoScheduled = true;
    const kick = () => { this._autoScheduled = false; try { this.drain(); } catch (error) { log.error(`auto drain failed: ${error?.message ?? error}`); } };
    if (typeof queueMicrotask === 'function') queueMicrotask(kick);
    else Promise.resolve().then(kick);
  }

  /** Replaces the executor (e.g. with a `WorkerPool`-backed one). */
  setExecutor(fn) {
    if (typeof fn !== 'function') throw new TypeError('TaskScheduler.setExecutor() needs a function');
    this.executor = fn;
    return this;
  }

  /**
   * Starts up to `concurrency` queued tasks. Synchronous work settles inside the drain; promise
   * work settles later and remains in `running` until `settle()`/`runAll()` (or its own resolution).
   */
  drain({ maxTasks = this.concurrency, budgetMs = Infinity } = {}) {
    if (this._draining) return { started: 0, queued: this.queue.length, running: this.running.size, tick: this.tick, reentrant: true };
    this._draining = true;
    this.tick++;
    const startedAt = nowMs();
    let started = 0;
    try {
      if (!this.paused) {
        this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
        while (this.queue.length && this.running.size < this.concurrency && started < maxTasks) {
          if (nowMs() - startedAt >= budgetMs) break;
          const task = this.queue.shift();
          if (!task || task.isDone) continue;
          if (task.token.cancelled) { task._cancel(task.token.reason); this.cancelled++; continue; }
          this._start(task);
          started++;
        }
      }
    } finally {
      this._draining = false;
    }
    const report = {
      started, queued: this.queue.length, running: this.running.size,
      tick: this.tick, paused: this.paused, reentrant: false,
    };
    this.stats?.gauge('Async/Queued', this.queue.length);
    this.stats?.gauge('Async/Running', this.running.size);
    asyncEvents.onDrained.broadcast(report, this);
    return report;
  }

  _start(task) {
    task.state = TaskState.Running;
    task.attempts++;
    task.startedAt = nowMs();
    this.running.set(task.id, task);
    asyncEvents.onStarted.broadcast(task, this);
    this.stats?.count('Async/Started');
    const context = {
      task, token: task.token,
      progress: (value) => task.reportProgress(value),
      signal: task.token,
    };
    let outcome;
    try { outcome = this.executor(task, context); }
    catch (error) { this._handleFailure(task, error); return; }
    if (outcome && typeof outcome.then === 'function') {
      // A wall-clock timeout is optional; the token is the deterministic cancellation path.
      if (task.timeoutMs > 0 && typeof setTimeout === 'function') {
        task._timer = setTimeout(() => {
          if (!task.isDone) this.cancelTask(task, `timed out after ${task.timeoutMs} ms`);
        }, task.timeoutMs);
        if (task._timer && typeof task._timer.unref === 'function') task._timer.unref();
      }
      Promise.resolve(outcome).then(
        (value) => this._complete(task, value),
        (error) => this._handleFailure(task, error),
      );
    } else {
      this._complete(task, outcome);
    }
  }

  _complete(task, value) {
    if (task.isDone) return;
    task.state = TaskState.Succeeded;
    task.result = value;
    task.progress = 1;
    task.finishedAt = nowMs();
    task.durationMs = task.finishedAt - (task.startedAt ?? task.submittedAt);
    task._clearTimer();
    this.running.delete(task.id);
    this.completed++;
    this._remember(task);
    task._resolve(value);
    this.stats?.count('Async/Completed');
    this.stats?.timing('Async/Duration', task.durationMs);
    this._scheduleAutoDrain();
    asyncEvents.onCompleted.broadcast(task, value, this);
  }

  _handleFailure(task, error) {
    if (task.isDone) return;
    if (error instanceof CancellationError) { this.cancelTask(task, error.reason); return; }
    const attemptsLeft = Math.max(0, task.retries - (task.attempts - 1));
    if (attemptsLeft > 0) {
      task.state = TaskState.Queued;
      task.error = null;
      task.startedAt = null;
      task._clearTimer();
      this.running.delete(task.id);
      this.queue.push(task);
      this.retried++;
      this.stats?.count('Async/Retried');
      asyncEvents.onRetried.broadcast(task, error, attemptsLeft, this);
      this._scheduleAutoDrain();
      return;
    }
    task.state = TaskState.Failed;
    task.error = error instanceof Error ? error : new Error(String(error));
    task.finishedAt = nowMs();
    task.durationMs = task.finishedAt - (task.startedAt ?? task.submittedAt);
    task._clearTimer();
    this.running.delete(task.id);
    this.failed++;
    this._remember(task);
    task._reject(task.error);
    log.error(`task \"${task.name}\" failed: ${task.error.message}`);
    asyncEvents.onFailed.broadcast(task, task.error, this);
    this._scheduleAutoDrain();
  }

  _remember(task) {
    this.history.push(task.describe());
    if (this.history.length > 64) this.history.shift();
  }

  /** Waits for the currently running tasks, then drains anything they queued. */
  async settle() {
    const pending = [...this.running.values()].map((task) => task.promise);
    if (pending.length) await Promise.allSettled(pending);
    return this.drain();
  }

  /** Runs until the queue and running set are empty (tests, shutdown flushes, headless bakes). */
  async runAll({ maxPasses = 64 } = {}) {
    let drain = this.drain();
    let passes = 0;
    while (passes < maxPasses && (this.queue.length || this.running.size)) {
      passes++;
      await this.settle();
      drain = this.drain();
    }
    return { passes, queued: this.queue.length, running: this.running.size, tick: this.tick, lastDrain: drain };
  }

  // ------------------------------------------------------------------ control
  pause() { this.paused = true; return this; }
  resume() { this.paused = false; this._scheduleAutoDrain(); return this; }

  cancelTask(task, reason = 'cancelled') {
    const found = task instanceof AsyncTask ? task : this.running.get(task) ?? this.queue.find((entry) => entry.id === task);
    if (!found || found.isDone) return false;
    const removedFromQueue = this.queue.indexOf(found);
    if (removedFromQueue >= 0) this.queue.splice(removedFromQueue, 1);
    this.running.delete(found.id);
    const cancelled = found._cancel(reason);
    if (cancelled) { this.cancelled++; this._remember(found); }
    return cancelled;
  }

  cancelAll(reason = 'cancelled all') {
    const targets = [...this.queue, ...this.running.values()];
    let count = 0;
    for (const task of targets) if (this.cancelTask(task, reason)) count++;
    return count;
  }

  cancelGroup(group, reason = 'group cancelled') {
    const targets = [...this.queue, ...this.running.values()].filter((task) => task.group === group);
    let count = 0;
    for (const task of targets) if (this.cancelTask(task, reason)) count++;
    return count;
  }

  cancelMatching({ name = null, group = null } = {}, reason = 'cancelled') {
    const targets = [...this.queue, ...this.running.values()].filter((task) =>
      (!name || task.name === name) && (!group || task.group === group));
    let count = 0;
    for (const task of targets) if (this.cancelTask(task, reason)) count++;
    return count;
  }

  /** Clears completed history without touching live work. */
  clearHistory() { const count = this.history.length; this.history.length = 0; return count; }

  // ------------------------------------------------------------------ reporting
  describe() {
    return {
      name: this.name, concurrency: this.concurrency, maxQueue: this.maxQueue,
      paused: this.paused, autoRun: this.autoRun, tick: this.tick,
      queued: this.queue.length, running: this.running.size,
      submitted: this.submitted, completed: this.completed, failed: this.failed,
      cancelled: this.cancelled, retried: this.retried, dropped: this.dropped,
      executor: this.executor === defaultExecutor ? 'inline' : 'custom',
      queue: this.queue.map((task) => task.describe()),
      runningTasks: [...this.running.values()].map((task) => task.describe()),
      history: this.history.slice(-8),
    };
  }

  format() {
    const lines = [
      `  ${this.name} — ${this.queue.length} queued · ${this.running.size}/${this.concurrency} running · tick ${this.tick}${this.paused ? ' (paused)' : ''}`,
      `  submitted ${this.submitted} · completed ${this.completed} · failed ${this.failed} · cancelled ${this.cancelled} · retried ${this.retried} · dropped ${this.dropped}`,
      `  executor  ${this.executor === defaultExecutor ? 'inline' : 'custom'}`,
    ];
    for (const task of [...this.running.values()].slice(0, 6)) {
      lines.push(`  ${String(task.id).padStart(4)} ${task.name.padEnd(22)} ${task.state.padEnd(10)} ${Math.round(task.progress * 100)}% · ${task.attempts} attempts`);
    }
    if (!this.running.size && !this.queue.length) lines.push('  (no active work)');
    return lines.join('\n');
  }

  installConsoleCommands(console_) {
    const scheduler = this;
    console_.registerCommand({
      name: 'tasks', aliases: ['tasks.list'], category: 'Async', description: 'Task scheduler state.',
      execute: () => scheduler.format(),
    });
    console_.registerCommand({
      name: 'tasks.drain', category: 'Async', description: 'Starts queued tasks up to the concurrency limit.',
      args: [{ name: 'max', type: 'int', min: 1, max: 1000, required: false, default: 0 }],
      execute: (args) => {
        const report = scheduler.drain(args.max ? { maxTasks: args.max } : {});
        return `started ${report.started} · queued ${report.queued} · running ${report.running}`;
      },
    });
    console_.registerCommand({
      name: 'tasks.cancel', category: 'Async', description: 'Cancels matching tasks (or all).',
      args: [{ name: 'name', required: false }, { name: 'group', required: false }],
      execute: (args) => {
        if (!args.name && !args.group) return `cancelled ${scheduler.cancelAll('console')} tasks`;
        return `cancelled ${scheduler.cancelMatching({ name: args.name ?? null, group: args.group ?? null }, 'console')} tasks`;
      },
    });
    console_.registerCommand({
      name: 'tasks.pause', category: 'Async', description: 'Pauses or resumes task starts.',
      args: [{ name: 'state', type: 'boolean', required: false, default: true }],
      execute: (args) => { if (args.state) scheduler.pause(); else scheduler.resume(); return scheduler.paused ? 'tasks paused' : 'tasks running'; },
    });
    return console_;
  }
}

function defaultExecutor(task, context) { return task.run(context); }
function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }
function nowMs() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

/** Groups tasks so a level change or subsystem teardown can cancel all of them at once. */
export class AsyncScope {
  constructor(scheduler, name = 'Scope') {
    this.scheduler = scheduler;
    this.name = name;
    this.tasks = [];
    this.disposed = false;
  }

  submit(...args) {
    const task = this.scheduler.submit(...args);
    this.tasks.push(task);
    return task;
  }

  cancelAll(reason = 'scope disposed') {
    let count = 0;
    for (const task of this.tasks) if (this.scheduler.cancelTask(task, reason)) count++;
    return count;
  }

  dispose(reason = 'scope disposed') { this.disposed = true; return this.cancelAll(reason); }
  get pending() { return this.tasks.filter((task) => !task.isDone).length; }
  describe() { return { name: this.name, disposed: this.disposed, tasks: this.tasks.length, pending: this.pending }; }
}

/**
 * A bounded pool of worker-like objects. `createWorker()` must return something with
 * `postMessage(message)` and either `onmessage` or `addEventListener('message', …)`; the worker
 * replies with `{ id, ok: true, result }` or `{ id, ok: false, error }`. That one protocol works
 * for a browser `Worker`, a Node `worker_threads` wrapper, or a test double — the scheduler does
 * not care which.
 */
export class WorkerPool {
  constructor({ name = 'Workers', size = 2, createWorker } = {}) {
    if (typeof createWorker !== 'function') throw new TypeError('WorkerPool needs a createWorker() factory');
    this.name = name;
    this.size = Math.max(1, Math.floor(size));
    this.createWorker = createWorker;
    this.slots = [];
    this.waiting = [];
    this.inFlight = new Map();
    this._seq = 0;
    this.completed = 0;
    this.failed = 0;
    this.created = 0;
    this.terminated = false;
  }

  static create(options) { return new WorkerPool(options); }

  /** Returns a function usable as `TaskScheduler.setExecutor(pool.asExecutor())`. */
  asExecutor() { return (task) => this.execute({ name: task.name, ...task.metadata }); }

  /** Queues one job; resolves with the worker's `result`. */
  execute(payload, { transfer = null } = {}) {
    if (this.terminated) return Promise.reject(new Error(`worker pool \"${this.name}\" is terminated`));
    return new Promise((resolve, reject) => {
      this.waiting.push({ id: ++this._seq, payload, transfer, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.waiting.length) {
      let slot = this.slots.find((candidate) => !candidate.current);
      if (!slot && this.slots.length < this.size) slot = this._createSlot();
      if (!slot) return;
      const job = this.waiting.shift();
      if (!job) return;
      slot.current = job;
      this.inFlight.set(job.id, { job, slot });
      try { slot.worker.postMessage({ id: job.id, payload: job.payload }, job.transfer ?? undefined); }
      catch (error) {
        slot.current = null;
        this.inFlight.delete(job.id);
        this.failed++;
        job.reject(error);
      }
    }
  }

  _createSlot() {
    const slot = { worker: null, current: null };
    const worker = this.createWorker(this.slots.length);
    slot.worker = worker;
    const onMessage = (event) => this._receive(slot, event?.data ?? event);
    if (typeof worker.addEventListener === 'function') worker.addEventListener('message', onMessage);
    else worker.onmessage = onMessage;
    if (typeof worker.addEventListener === 'function') worker.addEventListener('error', (event) => this._failSlot(slot, new Error(event?.message ?? 'worker error')));
    else worker.onerror = (event) => this._failSlot(slot, new Error(event?.message ?? 'worker error'));
    this.slots.push(slot);
    this.created++;
    return slot;
  }

  _receive(slot, data) {
    const job = slot.current;
    if (!job || !data || data.id !== job.id) return;
    slot.current = null;
    this.inFlight.delete(job.id);
    if (data.ok === false) { this.failed++; job.reject(new Error(String(data.error ?? 'worker failed'))); }
    else { this.completed++; job.resolve(data.result); }
    this._pump();
  }

  _failSlot(slot, error) {
    const job = slot.current;
    if (job) {
      slot.current = null;
      this.inFlight.delete(job.id);
      this.failed++;
      job.reject(error);
    }
    this._pump();
  }

  /** Terminates every worker and rejects anything still queued. */
  terminate(reason = 'pool terminated') {
    this.terminated = true;
    for (const job of this.waiting) { this.failed++; job.reject(new Error(reason)); }
    this.waiting.length = 0;
    for (const { job } of this.inFlight.values()) { this.failed++; job.reject(new Error(reason)); }
    this.inFlight.clear();
    for (const slot of this.slots) {
      slot.current = null;
      try { slot.worker.terminate?.(); } catch { /* already gone */ }
    }
    return this.slots.length;
  }

  describe() {
    return {
      name: this.name, size: this.size, created: this.created, busy: this.slots.filter((slot) => slot.current).length,
      queued: this.waiting.length, inFlight: this.inFlight.size,
      completed: this.completed, failed: this.failed, terminated: this.terminated,
    };
  }

  format() {
    return [
      `  ${this.name} — ${this.created}/${this.size} workers · ${this.inFlight.size} in flight · ${this.waiting.length} queued`,
      `  completed ${this.completed} · failed ${this.failed}${this.terminated ? ' · terminated' : ''}`,
    ].join('\n');
  }
}

// ------------------------------------------------------------------ helpers

/** A cancellable delay. */
export function delay(ms, value = undefined, token = null) {
  return new Promise((resolve, reject) => {
    if (token?.cancelled) { reject(new CancellationError(token.reason)); return; }
    const timer = setTimeout(() => { handle?.unbind?.(); resolve(value); }, Math.max(0, Number(ms) || 0));
    const handle = token?.onCancelled((reason) => { clearTimeout(timer); reject(new CancellationError(reason)); });
  });
}

/** Runs `fn` up to `attempts` times with an optional delay between tries. */
export async function retry(fn, { attempts = 3, backoffMs = 0, token = null } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    token?.throwIfCancelled();
    try { return await fn(attempt); }
    catch (error) {
      if (error instanceof CancellationError) throw error;
      lastError = error;
      if (attempt < attempts && backoffMs > 0) await delay(backoffMs, undefined, token);
    }
  }
  throw lastError;
}

/** Runs functions with bounded concurrency, preserving input order in the result array. */
export async function parallel(work, { concurrency = 4, scheduler = null } = {}) {
  const owned = scheduler ?? new TaskScheduler({ concurrency, name: 'Parallel', autoRun: true });
  const tasks = work.map((fn, index) => owned.submit({ name: `parallel.${index}`, run: typeof fn === 'function' ? fn : fn.run, ...(typeof fn === 'object' ? fn : {}) }));
  await owned.runAll();
  return tasks.map((task) => ({ ok: task.state === TaskState.Succeeded, value: task.result, error: task.error, task: task.describe() }));
}

/** Runs functions in order, stopping at (but recording) the first failure. */
export async function series(work) {
  const results = [];
  for (const fn of work) {
    try { results.push({ ok: true, value: await fn() }); }
    catch (error) { results.push({ ok: false, error }); break; }
  }
  return results;
}

export default TaskScheduler;
