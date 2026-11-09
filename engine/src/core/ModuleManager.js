/**
 * OminX Engine — modules and startup phases.
 *
 * A *module* is a unit of engine or game code with a declared load order: the core systems, the
 * renderer, the gameplay framework, the editor and the game itself are separate modules. UE solves
 * this with `IMPLEMENT_MODULE` plus startup phases (`PreEarlyLoadingScreen`, `PostConfigInit`,
 * …); this is the same idea with the startup phases that matter for a browser engine, and one
 * addition that a web target needs: modules can declare whether they exist on the client, the
 * server, or both, so a dedicated server never loads the renderer and a client never loads the
 * server's world persistence.
 *
 * The manager is deliberately boring and deterministic:
 *   - registration is a declaration (no side effects),
 *   - `loadAll()` resolves a topological order once and reports cycles instead of hanging,
 *   - `startupAll()` runs phases in order; within a phase, declaration order is preserved,
 *   - failures are contained: a module that throws while starting is marked failed and its
 *     dependents are skipped, rather than taking the whole boot down.
 *
 * @module engine/src/core/ModuleManager
 */
import { createLogger } from './Logger.js';
import { MulticastDelegate } from './Delegate.js';

const log = createLogger('Module');

/** Startup phases, run in this order. Declare the *earliest* phase a module can tolerate. */
export const ModulePhase = {
  /** Before anything else: file system abstraction, config, logging sinks. */
  PreEarly: 'PreEarly',
  /** Engine-wide settings and platform detection. */
  Early: 'Early',
  /** Core services that other modules bind to (scheduler, subsystems, GC). */
  PostConfig: 'PostConfig',
  /** Renderer, audio devices, asset registry — things that touch hardware. */
  EngineInit: 'EngineInit',
  /** Gameplay framework, worlds, scripting hosts. */
  GameInit: 'GameInit',
  /** Editor-only modules (property panels, gizmos, content browsers). */
  EditorInit: 'EditorInit',
  /** Last: game modules, mods, hot-reload watchers. */
  PostEngineInit: 'PostEngineInit',
};

export const MODULE_PHASE_ORDER = [
  ModulePhase.PreEarly, ModulePhase.Early, ModulePhase.PostConfig, ModulePhase.EngineInit,
  ModulePhase.GameInit, ModulePhase.EditorInit, ModulePhase.PostEngineInit,
];

/** Where a module runs. `both` is the default. */
export const ModuleTarget = { Client: 'client', Server: 'server', Both: 'both', Editor: 'editor' };

export const ModuleState = {
  Registered: 'registered',
  Loaded: 'loaded',
  Started: 'started',
  Failed: 'failed',
  Shutdown: 'shutdown',
};

export const moduleEvents = {
  onRegistered: new MulticastDelegate('module.onRegistered'),
  onLoaded: new MulticastDelegate('module.onLoaded'),
  onStarted: new MulticastDelegate('module.onStarted'),
  onFailed: new MulticastDelegate('module.onFailed'),
  onShutdown: new MulticastDelegate('module.onShutdown'),
};

/**
 * A module descriptor. Everything is optional except `name`; the callbacks are the extension points:
 *
 * ```js
 * engine.modules.register({
 *   name: 'OminX.Renderer',
 *   phase: ModulePhase.EngineInit,
 *   target: ModuleTarget.Client,
 *   dependencies: ['OminX.Core'],
 *   load: (ctx) => import('./renderer/index.js'),
 *   startup: (ctx, exported) => { ctx.systems.bind('renderer', exported.createRenderer(ctx)); },
 *   shutdown: (ctx) => { … },
 * });
 * ```
 */
export class ModuleDescriptor {
  constructor(options = {}) {
    this.name = options.name ?? 'UnnamedModule';
    this.displayName = options.displayName ?? this.name;
    this.version = options.version ?? '0.0.0';
    this.phase = options.phase ?? ModulePhase.GameInit;
    this.target = options.target ?? ModuleTarget.Both;
    this.dependencies = [...(options.dependencies ?? [])];
    this.optionalDependencies = [...(options.optionalDependencies ?? [])];
    this.load = options.load ?? null;              // () => module namespace | promise
    this.startup = options.startup ?? null;        // (context, exports) => void
    this.shutdown = options.shutdown ?? null;      // (context) => void
    this.hotReload = options.hotReload === true;
    this.state = ModuleState.Registered;
    this.exports = null;
    this.error = null;
    this.loadMs = 0;
    this.metadata = { ...(options.metadata ?? {}) };
  }

  get isStarted() { return this.state === ModuleState.Started; }
  get isFailed() { return this.state === ModuleState.Failed; }

  describe() {
    return {
      name: this.name, phase: this.phase, target: this.target, version: this.version,
      dependencies: [...this.dependencies], state: this.state, loadMs: Math.round(this.loadMs * 100) / 100,
      error: this.error?.message ?? null,
    };
  }
}

export class ModuleManager {
  constructor(options = {}) {
    // A caller that passes `target: undefined` (a generic engine boot) must not silently
    // disable every module — an unknown target means "this host", the client default.
    this.options = { target: ModuleTarget.Client, ...withoutUndefined(options) };
    /** @type {Map<string, ModuleDescriptor>} */
    this.modules = new Map();
    this.state = 'created';
    this.startupOrder = [];
    this.errors = [];
    this.context = null;
  }

  static create(options) { return new ModuleManager(options); }

  get target() { return this.options.target; }
  /** Registered module count (boot report, editor module list). */
  get count() { return this.modules.size; }

  /** Declares a module. Registration must not do work — `load`/`startup` run later. */
  register(options) {
    const descriptor = options instanceof ModuleDescriptor ? options : new ModuleDescriptor(options);
    if (this.modules.has(descriptor.name)) {
      log.warn(`module "${descriptor.name}" registered twice — replacing the earlier declaration`);
    }
    this.modules.set(descriptor.name, descriptor);
    moduleEvents.onRegistered.broadcast(descriptor, this);
    return descriptor;
  }

  unregister(name) {
    const descriptor = this.modules.get(name);
    if (!descriptor) return false;
    if (descriptor.state === ModuleState.Started) this._shutdown(descriptor);
    this.modules.delete(name);
    return true;
  }

  has(name) { return this.modules.has(name); }
  get(name) { return this.modules.get(name) ?? null; }
  get exports() {
    const out = {};
    for (const module of this.modules.values()) if (module.exports) out[module.name] = module.exports;
    return out;
  }

  /** Modules that should load for this target (editor implies client). */
  *eligible() {
    for (const descriptor of this.modules.values()) {
      const target = descriptor.target;
      if (target === ModuleTarget.Both) yield descriptor;
      else if (this.target === target) yield descriptor;
      else if (this.target === ModuleTarget.Editor && (target === ModuleTarget.Client || target === ModuleTarget.Editor)) yield descriptor;
    }
  }

  /** Topological order over declared dependencies; missing dependencies are reported, cycles break. */
  resolveOrder({ tolerant = true } = {}) {
    const order = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = (descriptor, trail) => {
      if (visited.has(descriptor.name)) return;
      if (visiting.has(descriptor.name)) {
        const message = `module dependency cycle: ${[...trail, descriptor.name].join(' → ')}`;
        this.errors.push({ name: descriptor.name, error: new Error(message) });
        log.error(message);
        if (!tolerant) throw new Error(message);
        return;
      }
      visiting.add(descriptor.name);
      for (const dependency of descriptor.dependencies) {
        const next = this.modules.get(dependency);
        if (!next) {
          const message = `${descriptor.name} depends on missing module "${dependency}"`;
          this.errors.push({ name: descriptor.name, error: new Error(message) });
          log.warn(message);
          continue;
        }
        visit(next, [...trail, descriptor.name]);
      }
      visiting.delete(descriptor.name);
      visited.add(descriptor.name);
      order.push(descriptor);
    };
    for (const descriptor of this.eligible()) visit(descriptor, []);
    return order;
  }

  /** Loads (imports) every eligible module in dependency order. */
  async loadAll(context = {}) {
    this.context = context;
    const order = this.resolveOrder();
    for (const descriptor of order) await this._load(descriptor);
    this.state = 'loaded';
    return this;
  }

  async _load(descriptor) {
    if (descriptor.state !== ModuleState.Registered) return descriptor;
    // A module whose dependency failed must not load: the code it would run assumes an API that is
    // not there, and the resulting error points at the wrong module.
    const brokenDependency = descriptor.dependencies.find((dependency) => this.modules.get(dependency)?.state === ModuleState.Failed);
    if (brokenDependency) {
      descriptor.state = ModuleState.Failed;
      descriptor.error = new Error(`dependency "${brokenDependency}" failed to load`);
      this.errors.push({ name: descriptor.name, error: descriptor.error });
      log.error(`${descriptor.name} skipped: dependency "${brokenDependency}" failed`);
      moduleEvents.onFailed.broadcast(descriptor, descriptor.error, this);
      return descriptor;
    }
    if (!descriptor.load) {
      descriptor.state = ModuleState.Loaded;
      moduleEvents.onLoaded.broadcast(descriptor, this);
      return descriptor;
    }
    const start = Date.now();
    try {
      const loaded = descriptor.load(contextWith(this.context, descriptor)) ?? null;
      descriptor.exports = loaded?.then ? await loaded : loaded;
      descriptor.loadMs = Date.now() - start;
      descriptor.state = ModuleState.Loaded;
      moduleEvents.onLoaded.broadcast(descriptor, this);
    } catch (error) {
      descriptor.state = ModuleState.Failed;
      descriptor.error = error;
      this.errors.push({ name: descriptor.name, error });
      log.error(`${descriptor.name} failed to load: ${error?.message ?? error}`);
      moduleEvents.onFailed.broadcast(descriptor, error, this);
    }
    return descriptor;
  }

  /**
   * Runs startup callbacks phase by phase. A module whose dependency failed is skipped, and the
   * skip is recorded — a half-started engine that keeps going is worse than a loud failure.
   */
  async startupAll(context = {}) {
    this.context = context ?? this.context;
    const order = this.resolveOrder();
    const byPhase = new Map(MODULE_PHASE_ORDER.map((phase) => [phase, []]));
    for (const descriptor of order) {
      if (!byPhase.has(descriptor.phase)) byPhase.set(descriptor.phase, []);
      byPhase.get(descriptor.phase).push(descriptor);
    }
    this.startupOrder = [];
    for (const phase of [...MODULE_PHASE_ORDER, ...[...byPhase.keys()].filter((key) => !MODULE_PHASE_ORDER.includes(key))]) {
      for (const descriptor of byPhase.get(phase) ?? []) {
        if (descriptor.state === ModuleState.Failed) continue;
        const brokenDependency = descriptor.dependencies.find((name) => this.modules.get(name)?.state === ModuleState.Failed);
        if (brokenDependency) {
          descriptor.state = ModuleState.Failed;
          descriptor.error = new Error(`dependency "${brokenDependency}" failed to start`);
          this.errors.push({ name: descriptor.name, error: descriptor.error });
          log.error(`${descriptor.name} skipped: dependency "${brokenDependency}" is broken`);
          moduleEvents.onFailed.broadcast(descriptor, descriptor.error, this);
          continue;
        }
        if (descriptor.state === ModuleState.Registered) await this._load(descriptor);
        if (descriptor.state !== ModuleState.Loaded) continue;
        try {
          await descriptor.startup?.(contextWith(this.context, descriptor), descriptor.exports);
          descriptor.state = ModuleState.Started;
          this.startupOrder.push(descriptor.name);
          moduleEvents.onStarted.broadcast(descriptor, this);
        } catch (error) {
          descriptor.state = ModuleState.Failed;
          descriptor.error = error;
          this.errors.push({ name: descriptor.name, error });
          log.error(`${descriptor.name} failed to start: ${error?.message ?? error}`);
          moduleEvents.onFailed.broadcast(descriptor, error, this);
        }
      }
    }
    this.state = 'started';
    return this;
  }

  /** Shuts started modules down in reverse order. */
  async shutdownAll() {
    const started = this.startupOrder
      .map((name) => this.modules.get(name))
      .filter((descriptor) => descriptor?.state === ModuleState.Started);
    for (let i = started.length - 1; i >= 0; i--) this._shutdown(started[i]);
    this.state = 'shutdown';
    return this;
  }

  _shutdown(descriptor) {
    try {
      descriptor.shutdown?.(this.context, descriptor.exports);
    } catch (error) {
      log.error(`${descriptor.name} failed to shut down: ${error?.message ?? error}`);
    }
    descriptor.state = ModuleState.Shutdown;
    moduleEvents.onShutdown.broadcast(descriptor, this);
  }

  /**
   * Hot reload: replaces a module's implementation and re-runs its startup, keeping the registry
   * entry (and therefore dependents' lookup) intact. Returns the reloaded descriptor.
   */
  async reload(name, loadOverride = null) {
    const descriptor = this.modules.get(name);
    if (!descriptor) return null;
    if (!descriptor.hotReload && !loadOverride) {
      log.warn(`${name} does not support hot reload`);
      return descriptor;
    }
    this._shutdown(descriptor);
    descriptor.state = ModuleState.Registered;
    descriptor.error = null;
    if (loadOverride) descriptor.load = loadOverride;
    await this._load(descriptor);
    if (descriptor.state === ModuleState.Loaded) {
      try {
        await descriptor.startup?.(this.context, descriptor.exports);
        descriptor.state = ModuleState.Started;
        moduleEvents.onStarted.broadcast(descriptor, this);
      } catch (error) {
        descriptor.state = ModuleState.Failed;
        descriptor.error = error;
        log.error(`${name} failed to restart after reload: ${error?.message ?? error}`);
      }
    }
    return descriptor;
  }

  /** Modules grouped by phase, in startup order — the boot report. */
  describe() {
    const groups = new Map();
    for (const descriptor of this.modules.values()) {
      if (!groups.has(descriptor.phase)) groups.set(descriptor.phase, []);
      groups.get(descriptor.phase).push(descriptor.describe());
    }
    return {
      target: this.target,
      state: this.state,
      startupOrder: [...this.startupOrder],
      phases: Object.fromEntries([...groups.entries()].map(([phase, list]) => [phase, list])),
      errors: this.errors.map((entry) => `${entry.name}: ${entry.error.message}`),
    };
  }
}

/** Startup context handed to module callbacks: everything a module may bind to. */
function contextWith(context, descriptor) {
  return {
    ...context,
    module: descriptor,
    modules: context.modules ?? null,
    log: createLogger(descriptor.name),
    registerSubsystem: (name, factory, options = {}) => context.systems?.registerFactory(name, factory, options),
    system: (name) => context.engine?.getSystem?.(name) ?? context.systems?.get(name) ?? null,
  };
}

export default ModuleManager;

function withoutUndefined(object) {
  const out = {};
  for (const [key, value] of Object.entries(object ?? {})) if (value !== undefined) out[key] = value;
  return out;
}
