/**
 * OminX Engine — the engine object.
 *
 * Everything in the core (objects, GC, subsystems, modules, jobs, stats, config, console, assets)
 * is useful on its own, but a running engine is those things wired to one clock with one lifecycle.
 * This is that wiring — the `GEngine` of the core, and the single object a host talks to.
 *
 * Lifecycle, UE-style and explicit:
 *
 * ```
 * PreInit → Init → PostInit → [ Running: frame() … ] → Shutdown
 * ```
 *
 *   - **PreInit** — config keys, console, content manifest, module descriptors. Nothing has touched
 *     the GPU or the network yet.
 *   - **Init** — subsystems initialize in dependency order (assets → renderer → physics → audio),
 *     modules load, engine jobs register. A project's own systems come up here.
 *   - **PostInit** — the first frame's work is legal: load the entry map, spawn the player.
 *   - **Running** — `frame(delta)` advances the engine once. The host owns the loop (RAF in a
 *     browser, a timer headless, a for-loop in a test); the engine owns the order of work.
 *   - **Shutdown** — modules and subsystems deinitialize in reverse, handles release, assets free.
 *
 * There is exactly one clock. The `Scheduler` owns the fixed-step accumulator, phase signals
 * (`PreRender → PreSimulation/Stepped → Heartbeat → RenderStepped → PostRender`) and task API
 * (`spawn/defer/delay/wait`); the engine binds itself to those phases instead of running a second
 * loop beside them. That means a frame is: pre-render → N fixed steps (subsystems + sim jobs) →
 * per-frame work (subsystems + frame jobs) → render phase → post-render (stats, collection).
 *
 * @module engine/src/core/EngineCore
 */
import { Object as EngineObject, reflectClass, ClassCategory, engineEvents, getClassCount, liveObjectCount } from './Object.js';
import { MulticastDelegate } from './Delegate.js';
import { createLogger, setLogLevel, getLogLevel } from './Logger.js';
import { Collector } from './GarbageCollector.js';
import { SubsystemCollection, subsystemEvents } from './Subsystem.js';
import { ModuleManager, ModulePhase, moduleEvents } from './ModuleManager.js';
import { JobGraph } from './JobGraph.js';
import { Stats } from './Stats.js';
import { Trace } from './Trace.js';
import { Config, ConfigLayer, ConfigType, parseCommandLine } from './Config.js';
import { Console } from './Console.js';
import { AssetRegistry } from './AssetRegistry.js';
import { TimerManager } from './TimerManager.js';
import { Memory } from './Memory.js';
import { ReplaySystem } from './Replay.js';
import { SaveSystem } from './SaveGame.js';
import { MessageBus } from './EventBus.js';
import { TaskScheduler } from './Async.js';
import { DiagnosticHub } from './Diagnostics.js';
import { DataRegistry } from './DataRegistry.js';
import { ReplicationSystem } from './Replication.js';
import { World } from './World.js';
import { createLocalization } from './Localization.js';
import { PluginManager, PluginTarget } from './Plugin.js';
import { InputMappingSystem } from './InputMapping.js';
import { Scheduler } from './Scheduler.js';

const log = createLogger('Engine');

export const EnginePhase = {
  Uninitialized: 'uninitialized',
  PreInit: 'preinit',
  Init: 'init',
  PostInit: 'postinit',
  Running: 'running',
  Paused: 'paused',
  Shutdown: 'shutdown',
};

/** Job groups the engine drives every frame — a project adds its own groups alongside these. */
export const CoreJobGroup = {
  Engine: 'engine',
  Simulation: 'simulation',
  Frame: 'frame',
  Streaming: 'streaming',
  Render: 'render',
};

export const engineCoreEvents = {
  onPreInit: new MulticastDelegate('engine.onPreInit'),
  onInitialized: new MulticastDelegate('engine.onInitialized'),
  onPostInitialize: new MulticastDelegate('engine.onPostInitialize'),
  onFrameBegin: new MulticastDelegate('engine.onFrameBegin'),
  onFixedStep: new MulticastDelegate('engine.onFixedStep'),
  onFrameEnd: new MulticastDelegate('engine.onFrameEnd'),
  onPaused: new MulticastDelegate('engine.onPaused'),
  onResumed: new MulticastDelegate('engine.onResumed'),
  onBeforeShutdown: new MulticastDelegate('engine.onBeforeShutdown'),
  onShutdown: new MulticastDelegate('engine.onShutdown'),
};

/**
 * The engine. One instance per host; `EngineCore.current` is the most recently created one — the
 * engine equivalent of `GEngine`, which debug tooling and the console reach for.
 */
export class EngineCore extends EngineObject {
  static ClassName = 'EngineCore';

  constructor(name = 'OminXEngine', options = {}) {
    super(name, options);
    this.phase = EnginePhase.Uninitialized;
    this.version = options.version ?? '0.1.0';

    // Core services. Each is usable standalone; the engine only owns and wires them.
    this.config = options.config ?? new Config({ name: 'OminX' });
    this.stats = options.stats ?? new Stats({ enabled: options.statsEnabled !== false });
    /** Profiler: off by default, and free when off. `tracing: true` starts it at boot. */
    this.trace = options.trace ?? new Trace({
      stats: this.stats,
      enabled: options.tracing === true,
      capacity: options.traceCapacity ?? 200000,
      categories: options.traceCategories ?? null,
    });
    this.jobs = options.jobs ?? new JobGraph({ stats: this.stats, concurrency: options.concurrency ?? 4, name: 'engine', trace: this.trace });
    this.collector = options.collector ?? new Collector({ stats: this.stats });
    this.scheduler = options.scheduler ?? new Scheduler({ tickRate: options.tickRate ?? 60, maxSubSteps: options.maxSubSteps ?? 5, maxDeltaTime: options.maxDeltaTime ?? 0.25 });
    // `options.modules`/`options.subsystems` are overloaded: the *manager* for a host that built one
    // itself, or the *list of descriptors* to register at boot. A manager is recognised by its API,
    // so `createEngine({ modules: [ … ] })` cannot silently become an object that is not a manager.
    const moduleManager = options.moduleManager ?? (isModuleManager(options.modules) ? options.modules : null);
    const subsystemCollection = options.subsystemCollection ?? (isSubsystemCollection(options.subsystems) ? options.subsystems : null);
    this.subsystems = subsystemCollection ?? new SubsystemCollection('Subsystems', { engine: this, stats: this.stats });
    this.modules = moduleManager ?? new ModuleManager({ engine: this, target: options.target });
    this.assets = options.assets ?? new AssetRegistry({ stats: this.stats, concurrency: options.contentConcurrency ?? 4 });
    /** Gameplay timers: advanced on the fixed step, so they are as deterministic as physics. */
    this.timers = options.timers ?? new TimerManager({ stats: this.stats, timeScale: options.timerScale ?? 1 });
    /**
     * Memory services: the frame arena (reset every frame) plus typed-buffer pools and accounting.
     * Systems that would otherwise allocate per frame take their scratch space from here.
     */
    this.memory = options.memory ?? new Memory({
      name: 'OminX',
      arenaBytes: options.frameArenaBytes ?? 4 * 1024 * 1024,
      budgetBytes: options.memoryBudgetBytes ?? 0,
      sampleHeap: options.sampleHeap !== false,
    });
    this.console = options.console ?? new Console({ config: this.config, name: 'OminX' });
    // Same overload rule as modules/subsystems: an instance if it behaves like one, otherwise a
    // fresh service. `plugins: [ … ]` is a descriptor list to register at boot, not a manager.
    this.localization = isLocalization(options.localization) ? options.localization : createLocalization({
      culture: options.culture ?? 'en',
      fallbackCulture: options.fallbackCulture ?? 'en',
      assetRegistry: this.assets,
      assetPath: options.localizationRoot ?? '/Game/Localization',
    });
    this.plugins = isPluginManager(options.plugins) ? options.plugins : new PluginManager({ engine: this, target: options.target ?? PluginTarget.Client });
    /** @type {Map<string, InputMappingSystem>} one mapping system per local player (index 0 is local). */
    this.inputMappings = new Map();
    /**
     * Saved games. Always present (a headless client gets in-memory storage), but no autosave timer
     * is created unless a project asks for one — a shipped game pays for a slot manager, not a cron.
     */
    this.saves = isSaveSystem(options.saves) ? options.saves : new SaveSystem({
      timerManager: this.timers,
      prefix: options.savePrefix ?? 'ominx',
      format: options.saveFormat ?? 'json',
      version: options.saveVersion ?? 1,
      backupSlots: options.saveBackupSlots ?? 1,
      storage: options.saveStorage ?? undefined,
      strict: options.saveStrict === true,
      ...(options.saveOptions ?? {}),
    });
    /**
     * Deterministic messaging. Systems publish onto this bus; the engine drains it once per frame
     * on Heartbeat, so a message raised by a handler lands in the next frame's batch — never in
     * the middle of the batch that raised it.
     */
    this.messages = isMessageBus(options.messages) ? options.messages : new MessageBus({
      name: 'OminX', stats: this.stats,
      capacity: options.messageCapacity ?? 4096,
      timeoutDrains: options.messageTimeoutDrains ?? 60,
      defaultTtl: options.messageTtl ?? 0,
    });
    /** Off-frame work: priority-queued, concurrency-bounded, cancellable, pumped with the frame. */
    this.tasks = isTaskScheduler(options.tasks) ? options.tasks : new TaskScheduler({
      name: 'OminX', stats: this.stats,
      concurrency: options.taskConcurrency ?? 4,
      maxQueue: options.taskQueueSize ?? 1024,
    });
    /**
     * Bounded, deduplicated assertion/error hub. A host may inject its own hub (multiple worlds,
     * isolated tests); the module-level `check`/`ensure` helpers use the shared hub instead.
     */
    this.diagnostics = isDiagnosticHub(options.diagnostics) ? options.diagnostics : new DiagnosticHub({
      name: 'OminX', capacity: options.diagnosticCapacity ?? 256,
      minLevel: options.diagnosticMinLevel ?? 'info',
    });
    /** Typed, asset-backed gameplay data tables (weapon stats, damage falloff, loadouts). */
    this.data = isDataRegistry(options.data) ? options.data : new DataRegistry({
      name: 'GameData', assetRegistry: this.assets, ...(options.dataOptions ?? {}),
    });
    /**
     * UE-style replication graph. Always present, but costs nothing until objects are registered:
     * dirty properties are the only thing that produces a delta, and the simulation clock ticks it.
     */
    this.replication = isReplicationSystem(options.replication) ? options.replication : new ReplicationSystem({
      name: 'OminX', stats: this.stats, mode: options.netMode ?? 'standalone',
      localRole: options.netRole ?? 'none', ...(options.replicationOptions ?? {}),
    });
    /** UE-style world: actors, components, tick groups, levels and the replication binding. */
    // `Object.world` is a getter backed by `setWorld()`; binding through it keeps actors and
    // reflected objects looking up the same world instance as the engine itself.
    this.setWorld(isWorld(options.world) ? options.world : new World({
      name: options.worldName ?? 'OminXWorld', engine: this,
      replication: this.replication, stats: this.stats,
    }));

    this.realTime = 0;               // wall seconds since the first frame (unscaled)
    this.frameNumber = 0;
    this.tickCount = 0;
    this.lastFrameMs = 0;
    this.subStepsLastFrame = 0;
    this.gcIntervalFrames = options.gcIntervalFrames ?? 300;
    this._nextGcFrame = this.gcIntervalFrames;
    this.startupMs = 0;
    this.frameHistory = [];
    this.autoTick = options.autoTick !== false;
    this._wallNow = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._lastWallMs = 0;
    this._connections = [];
    this._loopHandle = null;
    this._driving = false;
    EngineCore.current = this;
  }

  static get current() { return EngineCore._current ?? null; }
  static set current(engine) { EngineCore._current = engine; }

  // ------------------------------------------------------------------ time
  /** The gameplay clock — fixed-step accumulated, scaled, pausable. */
  get gameTime() { return this.scheduler.time; }
  /** Wall clock since the first frame (not scaled, not paused) — timing and netcode use this. */
  get wallTime() { return this.realTime; }
  get deltaTime() { return this.scheduler.deltaTime; }
  get unscaledDeltaTime() { return this.scheduler.deltaTime; }
  get smoothedDeltaTime() { return this.scheduler.smoothedDelta; }
  /** Interpolation factor between fixed steps — render interpolation reads this. */
  get interpolationAlpha() { return this.scheduler.alpha; }
  get timeScale() { return this.scheduler.timeScale; }
  get maxDeltaTime() { return this.scheduler.maxDeltaTime; }
  get tickRate() { return this.scheduler.tickRate; }
  get fixedDeltaTime() { return this.scheduler.fixedDeltaTime; }
  get paused() { return this.scheduler.paused; }
  get fps() { return this.scheduler.metrics.fps; }
  get isInitialized() { return this.phase !== EnginePhase.Uninitialized; }
  get isRunning() { return this.phase === EnginePhase.Running; }
  get isPaused() { return this.phase === EnginePhase.Paused; }

  // ------------------------------------------------------------------ lifecycle
  /**
   * Brings the engine up: config → console → content scan → subsystems → modules → jobs.
   * `options` may carry `{ config, argv, manifest, modules, [ModulePhase.*]: fn }`; the phase
   * callbacks are how a project hooks boot without subclassing the engine.
   */
  async initialize(options = {}) {
    if (this.phase !== EnginePhase.Uninitialized && this.phase !== EnginePhase.Shutdown) {
      log.warn(`initialize() ignored — engine is ${this.phase}`);
      return this;
    }
    const startedAt = this._wallNow();
    this.phase = EnginePhase.PreInit;
    engineCoreEvents.onPreInit.broadcast(this);

    this.configureCoreConfig(options);
    this.installCoreConsoleCommands();
    // An autosave is a simulation event, so it is armed as a timer on the engine's own clock.
    if (options.autosave && !this.saves.autosaveActive) this.saves.enableAutosave(options.autosave);
    if (options.argv) this.config.apply(parseCommandLine(options.argv, this.config.schema), { layer: ConfigLayer.CommandLine });
    this.installCoreJobs();
    if (options.manifest) { this.assets.scan(options.manifest); this.assetsLoadedFromManifest = true; }
    if (options.registerTypes) for (const type of options.registerTypes) this.assets.registerType(type);
    if (options.commands) for (const command of options.commands) this.console.registerCommand(command);
    // Plugins first: they contribute modules, subsystems, commands, settings and content, and all of
    // those must exist before the boot pass that consumes them.
    if (Array.isArray(options.plugins)) for (const descriptor of options.plugins) this.plugins.register(descriptor);
    if (options.plugins !== false && this.plugins.count && options.loadPlugins !== false) {
      await this.plugins.loadAll({ engine: this, target: this.plugins.target });
    }
    options[ModulePhase.PreInit]?.(this);

    this._installSchedulerHooks();
    // The scheduler owns the clock; seed it from the resolved config (CLI/project layers included).
    this.scheduler.maxSubSteps = this.config.getNumber('engine.maxSubSteps', options.maxSubSteps ?? 5);
    this.scheduler.setTimeScale(this.config.getNumber('engine.timeScale', 1));
    this.scheduler.frameBudgetMs = 1000 / Math.max(1, options.targetFps ?? 60);
    this.scheduler.setPaused(false);

    this.phase = EnginePhase.Init;
    if (Array.isArray(options.modules)) for (const descriptor of options.modules) this.modules.register(descriptor);
    if (options.subsystemsList) for (const subsystem of options.subsystemsList) this.subsystems.register(subsystem);
    await this.modules.loadAll(ModulePhase.PreInit);
    await this.subsystems.initializeAll({ engine: this, config: this, assets: this.assets, stats: this.stats, jobs: this.jobs, console: this.console });
    await this.modules.loadAll(ModulePhase.PreEngineInit);
    engineEvents.onConfigChanged.broadcast(this.config, this);

    this.phase = EnginePhase.PostInit;
    engineCoreEvents.onInitialized.broadcast(this);
    await this.modules.startupAll();
    options[ModulePhase.PostInit]?.(this);

    this.phase = EnginePhase.Running;
    this._lastWallMs = this._wallNow();
    this.startupMs = this._wallNow() - startedAt;
    engineCoreEvents.onPostInitialize.broadcast(this);
    log.info(`engine ready in ${this.startupMs.toFixed(1)} ms — ${this.subsystems.count} subsystems, ${this.modules.count} modules, ${getClassCount()} classes`);
    if (options.autoLoop && this.autoTick) this.startLoop();
    return this;
  }

  /** Declares the engine's own configuration keys (renderer/gameplay keys belong to their modules). */
  configureCoreConfig(options = {}) {
    this.config.defineMany({
      'engine.tickRate': { type: ConfigType.Integer, default: options.tickRate ?? 60, min: 10, max: 240, group: 'Engine', requiresRestart: true, description: 'Fixed simulation steps per second.' },
      'engine.maxSubSteps': { type: ConfigType.Integer, default: options.maxSubSteps ?? 5, min: 1, max: 16, group: 'Engine', description: 'Catch-up steps allowed in one frame before time is dropped.' },
      'engine.timeScale': { type: ConfigType.Number, default: 1, min: 0, max: 8, group: 'Engine', replicated: true, description: 'Gameplay clock multiplier (0 pauses).' },
      'engine.maxDeltaTime': { type: ConfigType.Number, default: options.maxDeltaTime ?? 0.25, min: 0.001, max: 1, group: 'Engine', advanced: true, description: 'Largest frame delta accepted, seconds — protects against tab throttling.' },
      'engine.gcIntervalFrames': { type: ConfigType.Integer, default: options.gcIntervalFrames ?? 300, min: 0, max: 100000, group: 'Engine', advanced: true, description: 'Frames between automatic collection passes (0 disables).' },
      'engine.streamBudgetMb': { type: ConfigType.Number, default: 16, min: 1, max: 512, group: 'Engine', advanced: true, description: 'Content streamed per frame (MB).' },
      'engine.lastFrameMs': { type: ConfigType.Number, default: 0, group: 'Engine', readonly: true, description: 'Duration of the last frame (ms).' },
      'log.level': { type: ConfigType.Enum, enum: ['trace', 'debug', 'info', 'warn', 'error', 'silent'], default: getLogLevel(), group: 'Engine', description: 'Log verbosity.' },
    });
    // Changing these at runtime must reach the live scheduler, not just the config store.
    this.config.on('engine.tickRate', (value) => { this.scheduler.tickRate = value; this.scheduler.fixedDeltaTime = 1 / value; });
    this.config.on('engine.maxSubSteps', (value) => { this.scheduler.maxSubSteps = value; });
    this.config.on('engine.timeScale', (value) => this.scheduler.setTimeScale(value));
    this.config.on('engine.maxDeltaTime', (value) => { this.scheduler.maxDeltaTime = value; });
    this.config.on('log.level', (value) => setLogLevel(value));
    return this;
  }

  /**
   * Binds engine work to the scheduler's phases — the single clock. Order inside a frame:
   * PreRender (network/input) → per fixed step: PreSimulation then Stepped → Heartbeat (frame work)
   * → RenderStepped → PostRender (stats, collection cadence).
   */
  _installSchedulerHooks() {
    if (this._hooksInstalled) return this;
    this._hooksInstalled = true;
    const scheduler = this.scheduler;

    this._connections.push(scheduler.PreRender.connect((delta) => {
      this.subStepsLastFrame = 0;
      this.trace.beginFrame(scheduler.frameCount);
      // Frame boundary: the arena is reused (not grown) and per-frame byte growth is measured.
      this.memory.beginFrame(scheduler.frameCount);
      this.stats.beginFrame();
      // Input is sampled before any simulation step: mapping contexts resolve raw key state into
      // action values, so movement/AI/physics all read the same frame's intent.
      for (const input of this.inputMappings.values()) input.evaluate(delta);
      // A playing replay overwrites those values with the recorded ones — same code path, same tick.
      if (this.replay?.player.playing) this.replay.update(delta);
      engineCoreEvents.onFrameBegin.broadcast(this, { frame: scheduler.frameCount, deltaTime: delta });
    }));

    // One callback per fixed simulation step: subsystems, then simulation jobs. Both are ordered,
    // so movement → physics → AI holds every tick regardless of how many steps this frame ran.
    this._connections.push(scheduler.PreSimulation.connect((fixedDelta) => {
      this.tickCount++;
      // Replication advances on the simulation clock so delta `tick` values match the server's tick.
      this.replication.tick();
      // Actor/component ticks run after subsystem fixed updates, in UE-style tick-group order.
      this.trace.scope('Engine/World', 'engine', () => this.world.tick(fixedDelta));
      const stepStart = this._wallNow();
      this.subStepsLastFrame++;
      this.trace.scope('Subsystems/FixedUpdate', 'engine', () => this.subsystems.fixedUpdate(fixedDelta));
      // Timers run on the simulation clock: pausing the engine pauses reloads and cooldowns too.
      this.timers.advance(fixedDelta);
      this.stats.timing('Engine/SubsystemsFixed', this._wallNow() - stepStart);
      this.jobs.execute(this.jobContext, fixedDelta);
      engineCoreEvents.onFixedStep.broadcast(this, { fixedDelta, tick: this.tickCount });
    }));

    // Once per frame, after the last step: animation, camera, HUD, render submission.
    this._connections.push(scheduler.Heartbeat.connect((delta) => {
      const frameStart = this._wallNow();
      this.trace.scope('Subsystems/Update', 'engine', () => this.subsystems.update(delta));
      this.jobs.execute(this.jobContext, delta);
      // One pump per frame, after every publisher has run. Priority order is stable and a message
      // published by a handler waits for the next frame instead of extending this batch.
      this.trace.scope('Engine/Messages', 'engine', () => this.messages.drain());
      this.trace.scope('Engine/Tasks', 'engine', () => this.tasks.drain());
      this.lastFrameMs = this._wallNow() - frameStart;
      this.realTime = scheduler.elapsed;
      this.frameNumber = scheduler.frameCount;
      this._pushFrameSample(this.lastFrameMs);
      this.config.set('engine.lastFrameMs', round3(this.lastFrameMs), { silent: true });
    }));

    this._connections.push(scheduler.PostRender.connect(() => {
      this.trace.counter('Frame/SubSteps', this.subStepsLastFrame, { category: 'engine' });
      this.trace.endFrame();
      const growth = this.memory.endFrame();
      if (growth !== 0) this.stats.gauge('Memory/FrameGrowth', growth);
      this.stats.timing('Engine/Frame', this.lastFrameMs);
      this.stats.record('Engine/FrameMs', this.lastFrameMs);
      this.stats.endFrame({ frame: this.frameNumber, subSteps: this.subStepsLastFrame });
      engineCoreEvents.onFrameEnd.broadcast(this, this.lastFrameRecord());
    }));
    return this;
  }

  _pushFrameSample(frameMs) {
    if (this.frameHistory.length > 240) this.frameHistory.shift();
    this.frameHistory.push(frameMs);
  }

  /** Registers the engine's own jobs so the profiler shows the standard phases. */
  installCoreJobs() {
    if (this.jobs.has('engine.collect')) return this;
    this.jobs.add({
      name: 'engine.collect', group: CoreJobGroup.Engine, priority: -1000, budgetMs: 2,
      run: () => {
        if (this.gcIntervalFrames > 0 && this.frameNumber >= this._nextGcFrame) {
          this._nextGcFrame = this.frameNumber + this.gcIntervalFrames;
          const collected = this.collector.sweep();
          const assets = this.assets.collectGarbage();
          this.lastCollection = { objects: collected, assets };
        }
      },
    });
    this.jobs.add({
      name: 'engine.stream', group: CoreJobGroup.Streaming, priority: -900, budgetMs: 2,
      run: () => {
        if (!this._pendingBundles?.size) return;
        const budgetBytes = this.config.getNumber('engine.streamBudgetMb', 16) * 1024 * 1024;
        for (const name of [...this._pendingBundles]) {
          this._pendingBundles.delete(name);
          void this.assets.loadBundle(name, { concurrency: 2, progress: (progress) => this.stats.gauge('Assets/BundleProgress', progress) });
        }
        void budgetBytes;
      },
    });
    this.jobs.add({
      name: 'engine.serviceConfig', group: CoreJobGroup.Engine, priority: -1100,
      run: () => this._applyQueuedConfig(),
    });
    return this;
  }

  /** Config changes requested from a worker/console command are applied on the main line. */
  queueConfigChange(key, value) {
    this._queuedConfig ??= new Map();
    this._queuedConfig.set(key, value);
    return this;
  }

  _applyQueuedConfig() {
    if (!this._queuedConfig?.size) return;
    for (const [key, value] of this._queuedConfig) this.config.set(key, value);
    this._queuedConfig.clear();
  }

  // ------------------------------------------------------------------ frame
  /**
   * Advances the engine exactly one frame. The only entry point a host needs: the browser calls it
   * from `requestAnimationFrame`, a server from a timer, a test in a loop.
   * Returns the frame record (timings, substeps, collection, asset totals).
   */
  frame(deltaSeconds = null) {
    if (this.phase !== EnginePhase.Running && this.phase !== EnginePhase.Paused) {
      log.warn(`frame() ignored — engine is ${this.phase}`);
      return null;
    }
    this._driving = true;
    try {
      if (deltaSeconds === null || deltaSeconds === undefined) this.scheduler.update();
      else this.scheduler.update(Math.min(Math.max(deltaSeconds, 0), this.maxDeltaTime));
    } finally {
      this._driving = false;
    }
    return this.lastFrameRecord();
  }

  /** Everything worth knowing about the frame that just ran (debug HUD, tests, telemetry). */
  lastFrameRecord() {
    return {
      frame: this.frameNumber,
      tick: this.tickCount,
      time: round3(this.scheduler.time),
      wallTime: round3(this.realTime),
      delta: round3(this.scheduler.deltaTime),
      subSteps: this.subStepsLastFrame,
      alpha: round3(this.scheduler.alpha),
      frameMs: round3(this.lastFrameMs),
      simMs: round3(this.scheduler.metrics.simMs),
      fps: Math.round(this.scheduler.metrics.fps),
      jobs: this.jobs.lastReport,
      subsystems: { count: this.subsystems.count, ms: round3(this.subsystems.lastUpdateMs) },
      objects: { live: liveObjectCount(), classes: getClassCount(), pendingKill: this.collector.pendingCount },
      assets: { loaded: this.assets.loadedCount(), bytes: this.assets.loadedBytes },
      collection: this.lastCollection ?? null,
      stats: this.stats.enabled ? this.stats.getFrameStats() : null,
    };
  }

  /** Runs `count` frames at a fixed delta — headless soak tests, deterministic replays. */
  runFixedFrames(count, deltaSeconds = this.scheduler.fixedDeltaTime) {
    const records = [];
    for (let i = 0; i < count; i++) records.push(this.frame(deltaSeconds));
    return records;
  }

  /** Starts a requestAnimationFrame loop (browser hosts). The engine is already host-drivable. */
  startLoop() {
    if (this._loopHandle || typeof requestAnimationFrame !== 'function') return this;
    const step = () => {
      if (this.phase === EnginePhase.Shutdown) { this._loopHandle = null; return; }
      this._loopHandle = requestAnimationFrame(step);
      this.frame();
    };
    this._loopHandle = requestAnimationFrame(step);
    return this;
  }

  stopLoop() {
    if (this._loopHandle && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._loopHandle);
    this._loopHandle = null;
    return this;
  }

  pause() {
    if (this.phase !== EnginePhase.Running) return this;
    this.phase = EnginePhase.Paused;
    this.scheduler.setPaused(true);
    engineCoreEvents.onPaused.broadcast(this);
    return this;
  }

  resume() {
    if (this.phase !== EnginePhase.Paused) return this;
    this.phase = EnginePhase.Running;
    this.scheduler.setPaused(false);
    engineCoreEvents.onResumed.broadcast(this);
    return this;
  }

  /** Advances exactly one fixed step while paused — the debugger's step button. */
  step(count = 1) {
    this.scheduler.stepOnce(count);
    return this;
  }

  setTimeScale(scale) {
    this.scheduler.setTimeScale(scale);
    this.config.set('engine.timeScale', this.scheduler.timeScale, { silent: true });
    return this;
  }

  setTickRate(hz) {
    const rate = Math.max(1, Math.round(hz));
    this.scheduler.tickRate = rate;
    this.scheduler.fixedDeltaTime = 1 / rate;
    this.config.set('engine.tickRate', rate, { silent: true });
    return this;
  }

  // ------------------------------------------------------------------ context & helpers
  /** The stable object handed to every job — one allocation, live getters, no per-frame garbage. */
  get jobContext() {
    if (!this._jobContext) {
      const context = {
        engine: this, config: this.config, console: this.console, assets: this.assets,
        jobs: this.jobs, stats: this.stats, collector: this.collector, subsystems: this.subsystems,
      };
      // `Object` here is the engine's engine-object base class, so reach for the global explicitly.
      globalThis.Object.defineProperties(context, {
        time: { get: () => this.scheduler.time, enumerable: true },
        deltaTime: { get: () => this.scheduler.deltaTime, enumerable: true },
        alpha: { get: () => this.scheduler.alpha, enumerable: true },
        frame: { get: () => this.scheduler.frameCount, enumerable: true },
        tick: { get: () => this.tickCount, enumerable: true },
      });
      this._jobContext = context;
    }
    return this._jobContext;
  }

  delay(seconds, fn, ...args) { return this.scheduler.delay(seconds, fn, ...args); }
  defer(fn, ...args) { return this.scheduler.defer(fn, ...args); }
  spawn(fnOrGenerator, ...args) { return this.scheduler.spawn(fnOrGenerator, ...args); }
  wait(seconds) { return this.scheduler.wait(seconds); }
  addTickCallback(fn, priority = 0) { return this.scheduler.addTickCallback(fn, priority); }
  get isOverBudget() { return this.scheduler.isOverBudget(); }

  /**
   * Creates a per-player input mapping system wired to the engine: evaluated every frame before
   * simulation, reported into stats, and inspectable/rebindable from the console.
   */
  createInputMapping(options = {}) {
    const input = new InputMappingSystem({ stats: this.stats, ...options });
    input.installConsoleCommands(this.console);
    this.inputMappings.set(input.name, input);
    return input;
  }

  /** The local player's input mapping (index 0), which most single-player clients use. */
  get input() { return this.inputMappings.values().next().value ?? null; }

  /** Frame scratch space: valid until the end of the frame, allocated without garbage. */
  get frameArena() { return this.memory.frameArena; }

  /**
   * Creates the replay system (input recording + tick-accurate playback) and wires it to the console.
   * Opt-in: a shipped client that does not record pays nothing.
   */
  createReplaySystem(options = {}) {
    if (!this.replay) this.replay = new ReplaySystem({ engine: this, ...options });
    this.replay.installConsoleCommands(this.console);
    return this.replay;
  }

  /**
   * Replaces (or configures) the save system. The engine already owns `engine.saves`; this is for a
   * host that needs a different storage adapter, schema or autosave policy after construction.
   * Commands are (re)installed at boot as well, so calling this twice is harmless.
   */
  createSaveSystem(options = {}) {
    this.saves = isSaveSystem(options.saves) ? options.saves : new SaveSystem({
      timerManager: this.timers, prefix: 'ominx', ...options,
    });
    this.saves.installConsoleCommands(this.console);
    return this.saves;
  }

  /** Replaces the engine's task scheduler (a host with its own worker pool or concurrency policy). */
  createTaskScheduler(options = {}) {
    this.tasks = isTaskScheduler(options.scheduler) ? options.scheduler : new TaskScheduler({ name: 'OminX', stats: this.stats, ...options });
    this.tasks.installConsoleCommands(this.console);
    return this.tasks;
  }

  /** Creates/replaces the world (a host with its own level layout or actor allocation policy). */
  createWorld(options = {}) {
    this.setWorld(isWorld(options.world) ? options.world : new World({
      name: 'OminXWorld', engine: this, replication: this.replication, stats: this.stats, ...options,
    }));
    this.world.installConsoleCommands(this.console);
    return this.world;
  }

  /** Creates/replaces the replication graph (server/listen-server hosts pass `mode` and role). */
  createReplicationSystem(options = {}) {
    this.replication = isReplicationSystem(options.system) ? options.system : new ReplicationSystem({
      name: 'OminX', stats: this.stats, ...options,
    });
    this.replication.installConsoleCommands(this.console);
    return this.replication;
  }

  /** Creates/replaces the typed data registry (hosts pass `assetRegistry` for table streaming). */
  createDataRegistry(options = {}) {
    this.data = isDataRegistry(options.registry) ? options.registry : new DataRegistry({
      name: 'GameData', assetRegistry: this.assets, ...options,
    });
    this.data.installConsoleCommands(this.console);
    return this.data;
  }

  /** Replaces the engine's message bus (a host with its own queue, capacity or timeout policy). */
  createMessageBus(options = {}) {
    this.messages = isMessageBus(options.bus) ? options.bus : new MessageBus({ name: 'OminX', stats: this.stats, ...options });
    this.messages.installConsoleCommands(this.console);
    return this.messages;
  }

  /** Sets a timer on the engine's clock. `engine.after(2, respawn)` / `engine.every(0.5, tick)`. */
  setTimer(name, callback, options = {}) { return this.timers.setTimer(name, callback, options); }
  after(seconds, callback, options = {}) { return this.timers.after(seconds, callback, options); }
  every(seconds, callback, options = {}) { return this.timers.every(seconds, callback, options); }
  nextTick(callback, options = {}) { return this.timers.nextTick(callback, options); }

  /** Loads a bundle by name on the next frame — streaming never blocks the frame that requested it. */
  requestBundle(name) {
    this._pendingBundles ??= new Set();
    this._pendingBundles.add(name);
    return this;
  }

  get pendingBundles() { this._pendingBundles ??= new Set(); return this._pendingBundles; }

  // ------------------------------------------------------------------ shutdown
  async shutdown(options = {}) {
    if (this.phase === EnginePhase.Shutdown || this.phase === EnginePhase.Uninitialized) return this;
    engineCoreEvents.onBeforeShutdown.broadcast(this);
    this.stopLoop();
    this.phase = EnginePhase.Shutdown;
    for (const connection of this._connections) connection.disconnect();
    this._connections.length = 0;
    this._hooksInstalled = false;
    this.saves?.stopAutosave();
    this.messages?.clear();
    this.tasks?.cancelAll('engine shutdown');
    this.replication?.drainRpcs();
    this.world?.endPlay();
    this.timers.clearAll();
    await this.plugins.shutdownAll();
    await this.modules.shutdownAll();
    await this.subsystems.deinitializeAll();
    if (options.releaseAssets !== false) {
      for (const entry of this.assets.entries.values()) entry.hardRefs = 0;
      this.assets.collectGarbage();
    }
    this.collector.flushPendingKill();
    if (options.destroyObjects !== false) {
      for (const object of this.subsystems.instances) object.destroy?.();
    }
    engineCoreEvents.onShutdown.broadcast(this);
    if (EngineCore.current === this) EngineCore.current = null;
    log.info(`engine shut down — ${this.frameNumber} frames, ${this.realTime.toFixed(1)} s wall, ${this.tickCount} ticks`);
    return this;
  }

  /** Tears down and reboots with new options (map change, project reload in the editor). */
  async restart(options = {}) {
    const merged = { ...this.bootOptions, ...options };
    await this.shutdown();
    this.phase = EnginePhase.Uninitialized;
    this.assets.clear();
    return this.initialize(merged);
  }

  // ------------------------------------------------------------------ reporting
  /** One object with everything a debug HUD, the editor or a test wants to know. */
  describe() {
    return {
      name: this.name,
      version: this.version,
      phase: this.phase,
      frame: this.frameNumber,
      ticks: this.tickCount,
      time: round3(this.scheduler.time),
      wallTime: round3(this.realTime),
      delta: round3(this.scheduler.deltaTime),
      timeScale: this.scheduler.timeScale,
      fps: Math.round(this.scheduler.metrics.fps),
      frameMs: round3(this.lastFrameMs),
      startupMs: round3(this.startupMs),
      subsystems: this.subsystems.describe(),
      modules: this.modules.describe(),
      assets: this.assets.report(),
      collector: this.collector.stats(),
      objects: { live: liveObjectCount(), classes: getClassCount() },
      jobs: this.jobs.report({ limit: 10 }),
      config: this.config.report(),
      console: { commands: this.console.commandsList().length, variables: this.console.variableNames().length },
      localization: { culture: this.localization.culture, missing: this.localization.missing.size },
      trace: this.trace.enabled ? { events: this.trace.eventCount, dropped: this.trace.dropped, top: this.trace.top(5) } : { enabled: false },
      plugins: { count: this.plugins.count, loaded: this.plugins.loadedCount, order: this.plugins.loadOrder },
      input: [...this.inputMappings.keys()],
      timers: { active: this.timers.count, fired: this.timers.totalFired },
      memory: { tracked: this.memory.totalBytes, arena: this.memory.frameArena.describe() },
      saves: {
        storage: this.saves.storage.name ?? 'custom', format: this.saves.storageFormat,
        slots: this.saves.slotKeys().length, writes: this.saves.writeCount,
        autosave: this.saves.autosaveActive, corrupt: this.saves.corruptCount,
      },
      messages: {
        queued: this.messages.count, published: this.messages.published,
        replies: this.messages.replies, pending: this.messages.pendingRequests,
        topics: [...this.messages.subscriptions.keys()], errors: this.messages.errors.length,
      },
      tasks: {
        queued: this.tasks.count, running: this.tasks.runningCount,
        completed: this.tasks.completed, failed: this.tasks.failed,
        cancelled: this.tasks.cancelled, concurrency: this.tasks.concurrency,
      },
      diagnostics: {
        reports: this.diagnostics.total, byLevel: { ...this.diagnostics.counts },
        suppressed: this.diagnostics.suppressed, minLevel: this.diagnostics.minLevel,
      },
      data: { tables: this.data.count, rows: this.data.names().reduce((n, k) => n + (this.data.get(k)?.count ?? 0), 0) },
      replication: {
        objects: this.replication.count, tick: this.replication.tickCount,
        deltasOut: this.replication.deltasSent, deltasIn: this.replication.deltasApplied,
        stale: this.replication.staleCount, conflicts: this.replication.conflictCount,
        queuedRpcs: this.replication.rpcQueue.length, errors: this.replication.errors.length,
      },
      world: {
        name: this.world.name, actors: this.world.count, levels: this.world.levels.size,
        tick: this.world.tickCount, ticksDispatched: this.world.ticksDispatched,
        errors: this.world.errors.length,
      },
    };
  }

  /** Human-readable engine state — the `engine` console command and the debug overlay. */
  format() {
    const scheduler = this.scheduler;
    const modules = this.modules.describe();
    const moduleNames = Object.values(modules.phases).flat().map((module) => module.name);
    const subsystemNames = this.subsystems.describe().subsystems.map((subsystem) => `${subsystem.type}${subsystem.enabled ? '' : ' (off)'}`);
    return [
      `  OminX ${this.version} — ${this.phase} · frame ${this.frameNumber} · tick ${this.tickCount}`,
      `  time ${scheduler.time.toFixed(2)}s (×${scheduler.timeScale}) · ${Math.round(scheduler.metrics.fps)} fps · ${this.lastFrameMs.toFixed(2)} ms/frame · ${this.subStepsLastFrame} substeps`,
      `  objects ${liveObjectCount()} live / ${getClassCount()} classes · ${this.collector.pendingCount} pending kill`,
      `  culture ${this.localization.culture}${this.localization.isRightToLeft ? ' (RTL)' : ''} · plugins ${this.plugins.loadedCount}/${this.plugins.count} loaded · ${this.timers.count} timers · ${this.saves.slotKeys().length} saves · ${this.messages.count} messages · ${this.tasks.activeCount} tasks`,
      `  diagnostics ${this.diagnostics.total} reports (${this.diagnostics.counts.error} error / ${this.diagnostics.counts.fatal} fatal) · data ${this.data.count} tables · net ${this.replication.count} objects / ${this.replication.deltasSent} deltas`,
      `  world ${this.world.name}: ${this.world.count} actors / ${this.world.levels.size} levels · ${this.world.ticksDispatched} component ticks`,
      `  subsystems (${this.subsystems.count}): ${subsystemNames.join(', ') || 'none'}`,
      `  modules (${this.modules.count}): ${moduleNames.join(', ') || 'none'}`,
      '',
      this.jobs.format(),
      '',
      this.assets.format(),
    ].join('\n');
  }

  /** Console commands the engine itself provides (projects add theirs on top). */
  installCoreConsoleCommands() {
    const engine = this;
    this.console.registerCommand({ name: 'engine', aliases: ['stat engine'], category: 'Engine', description: 'Engine state: clock, subsystems, modules, job timings, assets.', execute: () => engine.format() });
    this.console.registerCommand({
      name: 'engine.tickrate', category: 'Engine', description: 'Sets the fixed simulation rate.',
      args: [{ name: 'hz', type: 'int', min: 10, max: 240 }],
      execute: (args) => { engine.setTickRate(args.hz); return `tickRate = ${engine.tickRate}`; },
    });
    this.console.registerCommand({
      name: 'engine.pause', category: 'Engine', description: 'Pauses or resumes the gameplay clock.',
      args: [{ name: 'state', type: 'boolean', required: false, default: true }],
      execute: (args) => { if (args.state) engine.pause(); else engine.resume(); return engine.paused ? 'paused' : 'running'; },
    });
    this.console.registerCommand({
      name: 'engine.step', category: 'Engine', description: 'Advances N fixed steps while paused.',
      args: [{ name: 'count', type: 'int', min: 1, max: 1000, required: false, default: 1 }],
      execute: (args) => { engine.step(args.count); return `stepping ${args.count}`; },
    });
    this.console.registerCommand({
      name: 'engine.timescale', category: 'Engine', description: 'Sets the gameplay clock multiplier.',
      args: [{ name: 'scale', type: 'number', min: 0, max: 8 }],
      execute: (args) => { engine.setTimeScale(args.scale); return `timeScale = ${engine.timeScale}`; },
    });
    this.console.registerCommand({ name: 'engine.gc', aliases: ['gc'], category: 'Engine', description: 'Forces a collection pass.', execute: () => JSON.stringify(engine.collector.sweep()) });
    this.console.registerCommand({ name: 'engine.assets', category: 'Engine', description: 'Asset registry report.', execute: () => engine.assets.format() });
    this.console.registerCommand({
      name: 'engine.stream', category: 'Engine', description: 'Streams an asset bundle at the next frame.',
      args: [{ name: 'bundle' }],
      execute: (args) => { engine.requestBundle(args.bundle); return `queued bundle "${args.bundle}"`; },
    });
    this.console.registerCommand({
      name: 'engine.log', category: 'Engine', description: 'Sets the log level.',
      args: [{ name: 'level', type: 'enum', values: ['trace', 'debug', 'info', 'warn', 'error', 'silent'] }],
      execute: (args) => { setLogLevel(args.level); return `log level = ${args.level}`; },
    });
    this.localization?.installConsoleCommands(this.console);
    this.trace?.installConsoleCommands(this.console);
    this.timers?.installConsoleCommands(this.console);
    this.memory?.installConsoleCommands(this.console);
    this.plugins?.installConsoleCommands(this.console);
    this.saves?.installConsoleCommands(this.console);
    this.messages?.installConsoleCommands(this.console);
    this.tasks?.installConsoleCommands(this.console);
    this.diagnostics?.installConsoleCommands(this.console);
    this.data?.installConsoleCommands(this.console);
    this.replication?.installConsoleCommands(this.console);
    this.world?.installConsoleCommands(this.console);
    this.console.registerCommand({
      name: 'engine.subsystems', category: 'Engine', description: 'Lists subsystems and their state.',
      execute: () => engine.subsystems.describe().subsystems
        .map((subsystem) => `${String(subsystem.type).padEnd(16)} ${subsystem.state.padEnd(14)} ${subsystem.enabled ? 'enabled ' : 'disabled'}  ${subsystem.updates}u/${subsystem.fixedUpdates}f`)
        .join('\n') || 'no subsystems',
    });
    this.console.registerCommand({
      name: 'engine.modules', category: 'Engine', description: 'Lists modules and their state.',
      execute: () => engine.modules.describe().phases && Object.entries(engine.modules.describe().phases)
        .map(([phase, list]) => `${phase}: ${list.map((module) => `${module.name}(${module.state})`).join(', ')}`).join('\n'),
    });
    return this;
  }

  // ------------------------------------------------------------------ persistence
  /** Serializes the engine's own state (settings, clock, subsystem state) — not world content. */
  serialize() {
    return {
      version: this.version,
      phase: this.phase,
      time: round3(this.scheduler.time),
      frame: this.frameNumber,
      config: this.config.snapshot({ layer: ConfigLayer.User }),
      subsystems: this.subsystems.serialize(),
    };
  }

  deserialize(data) {
    if (!data) return this;
    if (data.config) this.config.apply(data.config, { layer: ConfigLayer.User });
    if (typeof data.time === 'number') this.scheduler.time = data.time;
    return this;
  }
}

reflectClass(EngineCore, {
  parent: EngineObject,
  name: 'EngineCore',
  category: ClassCategory.Core,
  displayName: 'Engine Core',
  description: 'The running engine: one clock, all core services, and an explicit lifecycle.',
  properties: [
    { name: 'tickRate', type: 'number', default: 60, min: 10, max: 240, category: 'Engine', description: 'Fixed simulation rate (Hz)' },
    { name: 'timeScale', type: 'number', default: 1, min: 0, max: 8, category: 'Engine', description: 'Gameplay clock multiplier' },
    { name: 'maxDeltaTime', type: 'number', default: 0.25, min: 0.001, max: 1, category: 'Engine', description: 'Largest accepted frame delta' },
    { name: 'gcIntervalFrames', type: 'number', default: 300, min: 0, category: 'Engine', description: 'Frames between collection passes' },
    { name: 'autoTick', type: 'boolean', default: true, category: 'Engine', description: 'Allow the host to drive frames automatically' },
  ],
  methods: [
    { name: 'initialize', description: 'Brings subsystems and modules up' },
    { name: 'frame', description: 'Advances the engine one frame' },
    { name: 'runFixedFrames', description: 'Runs N frames at a fixed delta (headless)' },
    { name: 'pause', description: 'Pauses the gameplay clock' },
    { name: 'resume', description: 'Resumes the gameplay clock' },
    { name: 'shutdown', description: 'Tears the engine down' },
  ],
  events: [
    { name: 'onFrameBegin', description: 'A frame is about to advance' },
    { name: 'onFixedStep', description: 'One fixed simulation step completed' },
    { name: 'onFrameEnd', description: 'A frame completed' },
    { name: 'onShutdown', description: 'The engine has stopped' },
  ],
});

/** Creates and initializes an engine in one call — the common host path. */
export async function createEngine(options = {}) {
  const engine = options.engine ?? new EngineCore(options.name ?? 'OminXEngine', options);
  engine.bootOptions = { ...options };
  engine.installCoreConsoleCommands();
  await engine.initialize(options);
  return engine;
}

/** The engine most recently created — what the console and debug tools talk to. */
export function currentEngine() { return EngineCore.current; }

/** The live engine, or a clear error (tools that require a running engine use this). */
export function requireEngine() {
  const engine = currentEngine();
  if (!engine) throw new Error('no engine instance exists — call createEngine() first');
  return engine;
}

function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }

function isModuleManager(candidate) {
  return !!candidate && typeof candidate.register === 'function' && typeof candidate.loadAll === 'function';
}

function isPluginManager(candidate) {
  return !!candidate && typeof candidate.register === 'function' && typeof candidate.loadAll === 'function' && typeof candidate.resolveOrder === 'function';
}

function isLocalization(candidate) {
  return !!candidate && typeof candidate.resolve === 'function' && typeof candidate.installConsoleCommands === 'function';
}

function isSubsystemCollection(candidate) {
  return !!candidate && typeof candidate.register === 'function' && typeof candidate.initializeAll === 'function';
}

function isSaveSystem(candidate) {
  return !!candidate && typeof candidate.write === 'function' && typeof candidate.read === 'function'
    && typeof candidate.keyFor === 'function' && typeof candidate.installConsoleCommands === 'function';
}

function isMessageBus(candidate) {
  return !!candidate && typeof candidate.publish === 'function' && typeof candidate.subscribe === 'function'
    && typeof candidate.drain === 'function' && typeof candidate.installConsoleCommands === 'function';
}

function isTaskScheduler(candidate) {
  return !!candidate && typeof candidate.submit === 'function' && typeof candidate.drain === 'function'
    && typeof candidate.describe === 'function' && typeof candidate.installConsoleCommands === 'function';
}

function isDiagnosticHub(candidate) {
  return !!candidate && typeof candidate.report === 'function' && typeof candidate.clear === 'function'
    && typeof candidate.installConsoleCommands === 'function';
}

function isDataRegistry(candidate) {
  return !!candidate && typeof candidate.define === 'function' && typeof candidate.lookup === 'function'
    && typeof candidate.installConsoleCommands === 'function';
}

function isReplicationSystem(candidate) {
  return !!candidate && typeof candidate.register === 'function' && typeof candidate.collectDeltas === 'function'
    && typeof candidate.installConsoleCommands === 'function';
}

function isWorld(candidate) {
  return !!candidate && typeof candidate.spawnActor === 'function' && typeof candidate.tick === 'function'
    && typeof candidate.installConsoleCommands === 'function';
}

export { ModulePhase, moduleEvents, subsystemEvents };
export default EngineCore;
