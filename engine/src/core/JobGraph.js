/**
 * OminX Engine — the job graph.
 *
 * Frame work has order and dependencies: input before movement, movement before physics, physics
 * before animation, animation before render submission, and asset streaming alongside all of it.
 * Expressing that with a chain of function calls per frame works until something needs to move, and
 * then it is a refactor. A graph makes it data:
 *
 * ```js
 * jobs.add({ name: 'physics', group: 'simulation', run: (ctx, dt) => physics.step(dt) });
 * jobs.add({ name: 'ai', group: 'simulation', dependsOn: ['physics'], run: (ctx, dt) => ai.update(dt) });
 * jobs.executeAsync({ dt });
 * ```
 *
 * Properties that matter for a renderer/simulation loop:
 *   - **Deterministic order.** Topological order, and inside a "level" the declared priority then
 *     registration order. Two runs of the same graph execute identically.
 *   - **Bounded concurrency.** Jobs that do not depend on each other run concurrently (up to
 *     `concurrency`), which is how asset loads overlap with simulation without starving the frame.
 *   - **Groups.** `physics`, `render`, `streaming`, `editor` — a group can be enabled/disabled or
 *     profiled as a unit, and dependencies may be expressed on groups.
 *   - **Failure isolation.** A throwing job fails, its dependents are skipped and reported, and the
 *     rest of the frame still runs — a broken plugin must not stop the game.
 *   - **Instrumentation.** Per-job timings feed `Stats`, and every graph run produces a record with
 *     per-job milliseconds for the profiler.
 *
 * @module engine/src/core/JobGraph
 */
import { createLogger } from './Logger.js';
import { MulticastDelegate } from './Delegate.js';
import { PriorityQueue } from './Containers.js';

const log = createLogger('Jobs');

export const JobState = {
  Idle: 'idle',
  Waiting: 'waiting',
  Running: 'running',
  Done: 'done',
  Failed: 'failed',
  Skipped: 'skipped',
};

export const jobEvents = {
  onJobStarted: new MulticastDelegate('jobs.onJobStarted'),
  onJobFinished: new MulticastDelegate('jobs.onJobFinished'),
  onJobFailed: new MulticastDelegate('jobs.onJobFailed'),
  onGraphFinished: new MulticastDelegate('jobs.onGraphFinished'),
};

/** One node in the graph. */
export class Job {
  constructor({ name, run, group = 'default', priority = 0, dependsOn = [], enabled = true, repeat = 1, budgetMs = null, metadata = {} } = {}) {
    if (!name) throw new Error('Job needs a name');
    if (typeof run !== 'function') throw new TypeError(`Job "${name}" needs a run function`);
    this.name = name;
    this.run = run;
    this.group = group;
    this.priority = priority;
    this.dependsOn = [...dependsOn];
    /** Names this job's group depends on — lets a whole phase be ordered without listing jobs. */
    this.groupDependsOn = [];
    this.enabled = enabled;
    this.repeat = Math.max(1, repeat | 0);
    this.budgetMs = budgetMs;
    this.metadata = { ...metadata };
    this.state = JobState.Idle;
    this.lastError = null;
    this.runs = 0;
    this.totalMs = 0;
    this.lastMs = 0;
    this.peakMs = 0;
    this.budgetStrikes = 0;
  }

  get averageMs() { return this.runs ? this.totalMs / this.runs : 0; }

  describe() {
    return {
      name: this.name, group: this.group, enabled: this.enabled, priority: this.priority,
      dependsOn: [...this.dependsOn], state: this.state, runs: this.runs,
      lastMs: round(this.lastMs), averageMs: round(this.averageMs), peakMs: round(this.peakMs),
      overBudget: this.budgetStrikes, error: this.lastError?.message ?? null,
    };
  }
}

function round(value) { return Math.round(value * 1000) / 1000; }

/** The graph: registration, ordering, execution and reporting. */
export class JobGraph {
  constructor({ concurrency = 4, stats = null, name = 'JobGraph', trace = null } = {}) {
    this.name = name;
    this.concurrency = Math.max(1, concurrency);
    this.stats = stats;
    /** Optional `Trace`: when attached, every job records a scope, so the profiler shows the frame. */
    this.trace = trace;
    /** @type {Map<string, Job>} */
    this.jobs = new Map();
    /** @type {Map<string, Set<string>>} group → groups it depends on */
    this.groupDependencies = new Map();
    /** @type {Map<string, boolean>} group enable flags */
    this.groupEnabled = new Map();
    this._order = null;              // cached topological order
    this._levels = null;             // cached execution levels (for concurrency)
    this.executions = 0;
    this.lastRunMs = 0;
    this.lastReport = null;
    this.errors = [];
    this.now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  static create(options) { return new JobGraph(options); }

  /**
   * Adds (or replaces) a job. `{ name, run, group, priority, dependsOn, enabled, budgetMs }`.
   * Returns the job so callers can hold a reference (`const step = jobs.add({...})`).
   */
  add(options) {
    const job = options instanceof Job ? options : new Job(options);
    if (this.jobs.has(job.name)) log.warn(`job "${job.name}" replaced`);
    this.jobs.set(job.name, job);
    this._invalidate();
    return job;
  }

  remove(name) {
    const removed = this.jobs.delete(name);
    if (removed) this._invalidate();
    return removed;
  }

  get(name) { return this.jobs.get(name) ?? null; }
  has(name) { return this.jobs.has(name); }

  /** Declares that a group runs after another group (phase ordering without listing every job). */
  setGroupDependency(group, dependsOn) {
    if (!this.groupDependencies.has(group)) this.groupDependencies.set(group, new Set());
    this.groupDependencies.get(group).add(dependsOn);
    this._invalidate();
    return this;
  }

  setGroupEnabled(group, enabled) {
    this.groupEnabled.set(group, !!enabled);
    // Mirror onto the jobs so `describe()` is honest about what will run.
    for (const job of this.jobs.values()) if (job.group === group) job.enabled = !!enabled;
    return this;
  }

  groups() {
    const groups = new Map();
    for (const job of this.jobs.values()) {
      if (!groups.has(job.group)) groups.set(job.group, []);
      groups.get(job.group).push(job.name);
    }
    return groups;
  }

  _invalidate() { this._order = null; this._levels = null; }

  /**
   * Topological order (dependencies first), then by group order, then priority, then registration.
   * Throws on dependency cycles — a cycle in a frame graph is a bug that must be loud.
   */
  resolveOrder() {
    if (this._order) return this._order;
    const jobs = [...this.jobs.values()];
    const byName = this.jobs;
    const order = [];
    const visiting = new Set();
    const visited = new Set();

    const groupDepsOf = (job) => {
      const deps = new Set(job.groupDependsOn);
      for (const groupDep of this.groupDependencies.get(job.group) ?? []) deps.add(`#group:${groupDep}`);
      return deps;
    };

    const jobsOfGroup = (group) => jobs.filter((job) => job.group === group).map((job) => job.name);

    const visit = (job, trail) => {
      if (visited.has(job.name)) return;
      if (visiting.has(job.name)) {
        const cycle = [...trail, job.name].join(' → ');
        throw new Error(`job dependency cycle: ${cycle}`);
      }
      visiting.add(job.name);
      for (const dependency of job.dependsOn) {
        const next = byName.get(dependency);
        if (!next) { this.errors.push(`job "${job.name}" depends on missing job "${dependency}"`); continue; }
        visit(next, [...trail, job.name]);
      }
      for (const groupDep of groupDepsOf(job)) {
        const groupName = groupDep.startsWith('#group:') ? groupDep.slice(7) : null;
        const names = groupName ? jobsOfGroup(groupName) : [groupDep];
        for (const name of names) {
          const next = byName.get(name);
          if (!next) continue;
          visit(next, [...trail, job.name]);
        }
      }
      visiting.delete(job.name);
      visited.add(job.name);
      order.push(job);
    };

    const sorted = jobs.slice().sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    for (const job of sorted) visit(job, []);
    this._order = order;
    return order;
  }

  /**
   * Groups the execution order into levels: every job in a level is independent of the others in it,
   * so a level can run concurrently. This is what turns the graph into useful parallelism.
   */
  resolveLevels() {
    if (this._levels) return this._levels;
    const order = this.resolveOrder();
    const depth = new Map();
    const depthOf = (job) => {
      if (depth.has(job.name)) return depth.get(job.name);
      let value = 0;
      for (const dependency of job.dependsOn) {
        const next = this.jobs.get(dependency);
        if (next) value = Math.max(value, depthOf(next) + 1);
      }
      for (const groupDep of this.groupDependencies.get(job.group) ?? []) {
        for (const other of this.jobs.values()) {
          if (other.group === groupDep) value = Math.max(value, depthOf(other) + 1);
        }
      }
      depth.set(job.name, value);
      return value;
    };
    for (const job of order) depthOf(job);
    const levels = new Map();
    for (const job of order) {
      const level = depth.get(job.name) ?? 0;
      if (!levels.has(level)) levels.set(level, []);
      levels.get(level).push(job);
    }
    this._levels = [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
    return this._levels;
  }

  /** Runs one job with timing, budget accounting, repeat support and error capture. */
  async _run(job, context, deltaSeconds) {
    if (!job.enabled) { job.state = JobState.Skipped; return JobState.Skipped; }
    // One trace scope per job: the profile of a frame is then exactly the frame's job graph.
    const scope = this.trace?.accepts?.('job') ? this.trace.begin(job.name, 'job', { group: job.group }) : null;
    try {
      return await this._runBody(job, context, deltaSeconds);
    } finally {
      scope?.end();
    }
  }

  async _runBody(job, context, deltaSeconds) {
    job.state = JobState.Running;
    jobEvents.onJobStarted.broadcast(job, this);
    const start = this.now();
    try {
      for (let i = 0; i < job.repeat; i++) {
        const result = job.run(context, deltaSeconds, job);
        if (result && typeof result.then === 'function') await result;
      }
      job.state = JobState.Done;
      job.lastError = null;
    } catch (error) {
      job.state = JobState.Failed;
      job.lastError = error;
      this.errors.push(`job "${job.name}": ${error?.message ?? error}`);
      log.error(`job "${job.name}" failed: ${error?.message ?? error}`);
      jobEvents.onJobFailed.broadcast(job, error, this);
    }
    const elapsed = this.now() - start;
    job.lastMs = elapsed;
    job.totalMs += elapsed;
    job.peakMs = Math.max(job.peakMs, elapsed);
    job.runs++;
    if (job.budgetMs && elapsed > job.budgetMs) job.budgetStrikes++;
    this.stats?.timing(`Jobs/${job.name}`, elapsed, { group: job.group });
    jobEvents.onJobFinished.broadcast(job, elapsed, this);
    return job.state;
  }

  /** Ordered, synchronous-ish execution: async jobs are awaited level by level. */
  async executeAsync(context = {}, deltaSeconds = 0) {
    const start = this.now();
    this.executions++;
    this.errors.length = 0;
    const levels = this.resolveLevels();
    const perJob = {};
    for (const level of levels) {
      const runnable = level.filter((job) => job.enabled && this._dependenciesOk(job));
      // Independent jobs in one level overlap up to the concurrency limit.
      for (let i = 0; i < runnable.length; i += this.concurrency) {
        const slice = runnable.slice(i, i + this.concurrency);
        await Promise.all(slice.map((job) => this._run(job, context, deltaSeconds)));
      }
      for (const job of level) perJob[job.name] = job.lastMs;
      // A failed job's dependents are skipped instead of running on broken state.
      for (const job of level) {
        if (job.state === JobState.Failed) this._markDependentsSkipped(job);
      }
    }
    this.lastRunMs = this.now() - start;
    this.lastReport = { executions: this.executions, totalMs: round(this.lastRunMs), jobs: perJob };
    jobEvents.onGraphFinished.broadcast(this, this.lastReport);
    return this.lastReport;
  }

  /** Same graph, one level at a time, without awaiting (jobs that return promises are not awaited). */
  execute(context = {}, deltaSeconds = 0) {
    const start = this.now();
    this.executions++;
    this.errors.length = 0;
    const perJob = {};
    for (const level of this.resolveLevels()) {
      for (const job of level) {
        if (!job.enabled || !this._dependenciesOk(job)) { job.state = JobState.Skipped; continue; }
        const jobStart = this.now();
        // The synchronous frame path traces too — otherwise `engine.frame()` jobs would never appear
        // in a profile, and the frame breakdown would only exist for async graphs.
        const scope = this.trace?.accepts?.('job') ? this.trace.begin(job.name, 'job', { group: job.group }) : null;
        try {
          job.run(context, deltaSeconds, job);
          job.state = JobState.Done;
          job.lastError = null;
        } catch (error) {
          job.state = JobState.Failed;
          job.lastError = error;
          this.errors.push(`job "${job.name}": ${error?.message ?? error}`);
          log.error(`job "${job.name}" failed: ${error?.message ?? error}`);
          jobEvents.onJobFailed.broadcast(job, error, this);
        }
        const elapsed = this.now() - jobStart;
        scope?.end();
        job.lastMs = elapsed;
        job.totalMs += elapsed;
        job.peakMs = Math.max(job.peakMs, elapsed);
        job.runs++;
        if (job.budgetMs && elapsed > job.budgetMs) job.budgetStrikes++;
        this.stats?.timing(`Jobs/${job.name}`, elapsed, { group: job.group });
        perJob[job.name] = elapsed;
      }
    }
    this.lastRunMs = this.now() - start;
    this.lastReport = { executions: this.executions, totalMs: round(this.lastRunMs), jobs: perJob };
    jobEvents.onGraphFinished.broadcast(this, this.lastReport);
    return this.lastReport;
  }

  /** Runs a single job by name (debugger "re-run this phase" button). */
  runJob(name, context = {}, deltaSeconds = 0) {
    const job = this.jobs.get(name);
    if (!job) return null;
    if (!this._dependenciesOk(job)) { job.state = JobState.Skipped; return job.state; }
    const result = job.run(context, deltaSeconds, job);
    job.runs++;
    return result?.then ? result : job.state;
  }

  _dependenciesOk(job) {
    for (const dependency of job.dependsOn) {
      const next = this.jobs.get(dependency);
      if (next && next.state === JobState.Failed) return false;
    }
    return true;
  }

  _markDependentsSkipped(failed) {
    for (const job of this.jobs.values()) {
      if (job.state === JobState.Done || job.state === JobState.Failed) continue;
      if (job.dependsOn.includes(failed.name)) {
        job.state = JobState.Skipped;
        this._markDependentsSkipped(job);
      }
    }
  }

  reset() {
    for (const job of this.jobs.values()) job.state = JobState.Idle;
    this.errors.length = 0;
    return this;
  }

  /** Per-job report sorted by cost — the profiler's frame breakdown. */
  report({ limit = 0 } = {}) {
    const rows = [...this.jobs.values()]
      .map((job) => job.describe())
      .sort((a, b) => b.averageMs - a.averageMs);
    return {
      name: this.name,
      executions: this.executions,
      lastRunMs: round(this.lastRunMs),
      concurrency: this.concurrency,
      jobs: limit > 0 ? rows.slice(0, limit) : rows,
      errors: [...this.errors],
    };
  }

  /** Flame-graph-ish text breakdown, used by the `jobs` console command. */
  format() {
    const rows = this.report().jobs;
    const total = rows.reduce((sum, row) => sum + row.averageMs, 0) || 1;
    const lines = [`  ${'job'.padEnd(24)} ${'avg ms'.padStart(9)} ${'%'.padStart(6)}  group`];
    for (const row of rows) {
      lines.push(`  ${row.name.padEnd(24)} ${String(row.averageMs).padStart(9)} ${String(Math.round((row.averageMs / total) * 100)).padStart(6)}  ${row.group}`);
    }
    lines.push('', `  ${rows.length} jobs · ${this.executions} runs · last ${round(this.lastRunMs)} ms · concurrency ${this.concurrency}`);
    return lines.join('\n');
  }
}

/**
 * A limited-concurrency work queue: fan out N independent tasks (asset decodes, chunk builds) and
 * await all of them without spawning a promise per item.
 */
export class WorkQueue {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    // Higher priority runs first, matching every other priority in the engine (jobs, delegates,
    // subsystems). `PriorityQueue` is min-first by default, so the ordering is stated explicitly here.
    this.pending = new PriorityQueue({ minQueue: false });
    this.running = 0;
    this.completed = 0;
    this.failed = 0;
  }

  /** Queues `task` (a function) with a priority (higher runs first). */
  push(task, priority = 0) {
    this.pending.push(task, priority);
    return this;
  }

  /** Drains the queue, running up to `concurrency` tasks at a time. Resolves when idle. */
  async drain() {
    const lanes = new Array(this.concurrency).fill(null).map(async () => {
      while (this.pending.size) {
        const task = this.pending.pop();
        this.running++;
        try {
          await task();
          this.completed++;
        } catch (error) {
          this.failed++;
          log.error(`queued work failed: ${error?.message ?? error}`);
        } finally {
          this.running--;
        }
      }
    });
    await Promise.all(lanes);
    return this;
  }

  get size() { return this.pending.size; }
  get stats() { return { pending: this.pending.size, running: this.running, completed: this.completed, failed: this.failed, concurrency: this.concurrency }; }
}

export default JobGraph;
