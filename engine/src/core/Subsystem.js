/**
 * OminX Engine — subsystems and their collections.
 *
 * A *subsystem* is a long-lived, engine-owned service with a lifecycle: it is created once, may
 * depend on other subsystems, initializes in dependency order, receives frame callbacks, and is torn
 * down in reverse order. Renderer, physics, audio, assets, net, input, stats and the script host are
 * all subsystems — nothing in the engine reaches for a global singleton, so a headless test can run
 * the whole simulation with only the subsystem collection it actually needs.
 *
 * Lifecycle states are explicit because "is it safe to use yet?" is the question every service
 * consumer asks:
 *
 *   Created → Initializing → Ready → Deinitializing → Dead
 *
 * `initialize()` on a subsystem whose dependencies are missing throws (loudly, at startup — not
 * mysteriously at frame 900), and `SubsystemCollection` guarantees each subsystem initializes
 * exactly once even if it is requested from several places.
 *
 * @module engine/src/core/Subsystem
 */
import { createLogger } from './Logger.js';
import { MulticastDelegate } from './Delegate.js';

const log = createLogger('Subsystem');

export const SubsystemState = {
  Created: 'created',
  Initializing: 'initializing',
  Ready: 'ready',
  Deinitializing: 'deinitializing',
  Dead: 'dead',
};

/** Engine-level lifecycle events (UE's `FSubsystemCollection` delegates). */
export const subsystemEvents = {
  onRegistered: new MulticastDelegate('subsystem.onRegistered'),
  onInitialized: new MulticastDelegate('subsystem.onInitialized'),
  onDeinitialized: new MulticastDelegate('subsystem.onDeinitialized'),
  onEnabled: new MulticastDelegate('subsystem.onEnabled'),
  onDisabled: new MulticastDelegate('subsystem.onDisabled'),
};

export class Subsystem {
  /** Human-readable type name; defaulted from the class name. */
  static TypeName = null;

  /**
   * Names of subsystems that must be Ready before this one initializes. Declaring them is what
   * makes initialization order a declaration instead of a hopeful registration order.
   */
  static Dependencies = [];

  /** True for subsystems that only exist with a renderer/GPU (an editor can skip them). */
  static RequiresRenderer = false;

  constructor(options = {}) {
    this.name = options.name ?? this.constructor.TypeName ?? this.constructor.name;
    this.state = SubsystemState.Created;
    this.enabled = options.enabled !== false;
    this.engine = options.engine ?? null;
    this.world = options.world ?? null;
    /** @type {SubsystemCollection} */
    this.owner = options.owner ?? null;
    this.options = options;
    this.initializeCount = 0;
    this.updateCount = 0;
    this.fixedUpdateCount = 0;
    this.lastError = null;
    this._dependencies = [...(options.dependencies ?? this.constructor.Dependencies ?? [])];
  }

  /** Declared dependencies, plus any the caller added through options. */
  get dependencies() { return this._dependencies; }

  get isReady() { return this.state === SubsystemState.Ready; }
  get isActive() { return this.state === SubsystemState.Ready && this.enabled; }
  get isDead() { return this.state === SubsystemState.Dead; }

  /** Convenience: another subsystem from the owning collection. */
  get(name) { return this.owner?.get(name) ?? null; }
  /** Convenience: a named engine system (renderer, device, assets…). */
  system(name) { return this.engine?.getSystem?.(name) ?? this.owner?.get(name)?.system?.(name) ?? null; }

  /**
   * Called once, after every dependency is Ready. Implementations must call
   * `super.initialize(context)` first (it flips the state and is idempotent).
   */
  initialize(context = {}) {
    if (this.state !== SubsystemState.Created && this.state !== SubsystemState.Dead) return this;
    this.state = SubsystemState.Initializing;
    try {
      this.onInitialize(context);
      this.state = SubsystemState.Ready;
      this.initializeCount++;
      subsystemEvents.onInitialized.broadcast(this);
    } catch (error) {
      this.state = SubsystemState.Created;
      this.lastError = error;
      log.error(`${this.name} failed to initialize: ${error?.message ?? error}`);
      throw error;
    }
    return this;
  }

  /** Override point — acquire resources, bind delegates, build tables. */
  onInitialize(_context) {}

  /** Called once when the collection dies. Idempotent, and must not throw. */
  deinitialize() {
    if (this.state === SubsystemState.Dead || this.state === SubsystemState.Created) return this;
    this.state = SubsystemState.Deinitializing;
    try {
      this.onDeinitialize();
    } catch (error) {
      log.error(`${this.name} failed to deinitialize: ${error?.message ?? error}`);
    } finally {
      this.state = SubsystemState.Dead;
      subsystemEvents.onDeinitialized.broadcast(this);
    }
    return this;
  }

  /** Override point — release everything `onInitialize` acquired. */
  onDeinitialize() {}

  /** Per-frame update. Runs only while Ready and enabled. */
  update(deltaSeconds) {
    if (!this.isActive) return this;
    this.updateCount++;
    try {
      this.onUpdate(deltaSeconds);
    } catch (error) {
      this._handleUpdateError(error);
    }
    return this;
  }

  /** Fixed-rate update (simulation tick). Runs only while Ready and enabled. */
  fixedUpdate(deltaSeconds) {
    if (!this.isActive) return this;
    this.fixedUpdateCount++;
    try {
      this.onFixedUpdate(deltaSeconds);
    } catch (error) {
      this._handleUpdateError(error);
    }
    return this;
  }

  onUpdate(_deltaSeconds) {}
  onFixedUpdate(_deltaSeconds) {}

  _handleUpdateError(error) {
    this.lastError = error;
    log.error(`${this.name}.update threw: ${error?.message ?? error}`);
  }

  /** Enables/disables frame callbacks without tearing the subsystem down (pause, editor mode). */
  setEnabled(enabled) {
    if (this.enabled === !!enabled) return this;
    this.enabled = !!enabled;
    if (this.enabled) { this.onEnabled(); subsystemEvents.onEnabled.broadcast(this); }
    else { this.onDisabled(); subsystemEvents.onDisabled.broadcast(this); }
    return this;
  }

  onEnabled() {}
  onDisabled() {}

  /** Serializes live state (save games, project files, debugger snapshot). */
  serialize() { return { type: this.name, enabled: this.enabled }; }
  deserialize(_data) { return this; }

  describe() {
    return {
      name: this.name,
      type: this.constructor.TypeName ?? this.constructor.name,
      state: this.state,
      enabled: this.enabled,
      dependencies: [...this._dependencies],
      updates: this.updateCount,
      fixedUpdates: this.fixedUpdateCount,
      error: this.lastError?.message ?? null,
    };
  }
}

/**
 * Owns a set of subsystems: registration, dependency-ordered initialization, frame dispatch and
 * reverse-order teardown.
 */
export class SubsystemCollection {
  constructor(name = 'Subsystems', { engine = null, stats = null } = {}) {
    this.name = name;
    this.engine = engine;
    this.stats = stats;
    /** @type {Map<string, Subsystem>} keyed by subsystem name */
    this.subsystems = new Map();
    /** @type {Map<string, Function>} pending factories keyed by name */
    this._factories = new Map();
    this._initialized = false;
    this._deinitialized = false;
    this.initializeOrder = [];
    this.errors = [];
    this.lastUpdateMs = 0;
    this.lastFixedUpdateMs = 0;
  }

  get count() { return this.subsystems.size; }
  /** Live subsystem instances, in registration order. */
  get instances() { return [...this.subsystems.values()]; }
  get names() { return [...this.subsystems.keys()]; }

  static create(name) { return new SubsystemCollection(name); }

  /**
   * Registers a subsystem class (or instance).
   * @param {Function|Subsystem} SubsystemClass
   * @param {object} [options] passed to the constructor; `{ lazy = true }` defers construction.
   */
  register(SubsystemClass, options = {}) {
    const name = options.name ?? SubsystemClass.TypeName ?? SubsystemClass.name;
    const factory = () => (typeof SubsystemClass === 'function'
      ? new SubsystemClass({ ...options, name, owner: this })
      : SubsystemClass);
    // Keep the class on the factory: dependency order must be resolvable *before* the instance
    // exists, which is the whole point of lazy subsystems.
    factory.subsystemClass = SubsystemClass;
    factory.dependencies = options.dependencies ?? SubsystemClass.Dependencies ?? [];
    this._factories.set(name, factory);
    if (!options.lazy) this.getOrCreate(name);
    subsystemEvents.onRegistered.broadcast(name, this);
    if (this._initialized) this.refresh();
    return this;
  }

  /** Registers an already-built instance (tests, host-provided services). */
  registerInstance(instance, { name = null } = {}) {
    if (!(instance instanceof Subsystem)) throw new TypeError('registerInstance() needs a Subsystem');
    const key = name ?? instance.name;
    instance.owner = this;
    this.subsystems.set(key, instance);
    subsystemEvents.onRegistered.broadcast(key, this);
    if (this._initialized) this.refresh();
    return this;
  }

  /** Registers a lazily-constructed factory under a name (used by the host engine). */
  registerFactory(name, factory, options = {}) {
    this._factories.set(name, () => {
      const instance = factory(this);
      if (instance && !(instance instanceof Subsystem) && typeof instance !== 'object') {
        throw new TypeError(`factory for "${name}" must return a Subsystem`);
      }
      instance.name ??= name;
      instance.owner = this;
      return instance;
    });
    if (!options.lazy && !this.subsystems.has(name)) this.getOrCreate(name);
    if (this._initialized) this.refresh();
    return this;
  }

  has(name) { return this._resolveName(name) !== null; }

  /**
   * Subsystem names are registry keys; dependencies are written by hand and are commonly lower-case
   * ("assets" vs "Assets"). Resolving case-insensitively removes a whole class of silent
   * "declares missing dependency" bugs without weakening the registry.
   */
  _resolveName(name) {
    if (name === null || name === undefined) return null;
    if (this.subsystems.has(name) || this._factories.has(name)) return name;
    const lower = String(name).toLowerCase();
    for (const key of this.subsystems.keys()) if (key.toLowerCase() === lower) return key;
    for (const key of this._factories.keys()) if (key.toLowerCase() === lower) return key;
    return null;
  }

  /** Returns a Ready subsystem, constructing and initializing it on demand when possible. */
  get(name) {
    const key = this._resolveName(name);
    if (key === null) return null;
    const existing = this.subsystems.get(key);
    if (existing) return existing;
    if (this._factories.has(key)) return this.getOrCreate(key);
    return null;
  }

  /** Same as `get`, but throws when the subsystem does not exist (use when it is required). */
  require(name) {
    const subsystem = this.get(name);
    if (!subsystem) throw new Error(`required subsystem "${name}" is not registered`);
    return subsystem;
  }

  getOrCreate(name) {
    if (this.subsystems.has(name)) return this.subsystems.get(name);
    const factory = this._factories.get(name);
    if (!factory) return null;
    const instance = factory();
    this.subsystems.set(name, instance);
    // Late construction uses the context the collection was initialized with, so a subsystem that
    // comes up after boot still receives the engine/services it needs. A subsystem whose
    // dependencies are not up yet stays Created (not an error) — `refresh()` brings it up when they
    // register, which is what makes registration order irrelevant.
    if (this._initialized) {
      const dependenciesReady = instance.dependencies.every((dependency) => this.get(dependency)?.isReady);
      if (dependenciesReady) {
        try {
          this._initializeOne(instance, this.initialContext ?? {});
        } catch (error) {
          this.errors.push({ name, error });
        }
      }
    }
    return instance;
  }

  /** Initializes every registered subsystem in dependency order. */
  initializeAll(context = {}) {
    if (this._initialized) return this;
    this.initialContext = context;
    this._initialized = true;
    this._deinitialized = false;
    const order = this._resolveOrder([...this._factories.keys(), ...this.subsystems.keys()]);
    this.initializeOrder = [];
    for (const name of order) {
      const subsystem = this.getOrCreate(name);
      if (!subsystem) continue;
      try {
        this._initializeOne(subsystem, context);
      } catch (error) {
        this.errors.push({ name, error });
      }
    }
    return this.refresh(context);
  }

  /**
   * Initializes every registered subsystem that is not up yet, in dependency order. Runs after
   * `initializeAll()` and whenever something registers late — a plugin loaded mid-session, an editor
   * module, or a test that adds a stand-in between frames. Registration must work at any time; the
   * alternative is a subsystem that exists but silently never receives an update.
   */
  refresh(context = null) {
    const initContext = context ?? this.initialContext ?? {};
    const order = this._resolveOrder([...this._factories.keys(), ...this.subsystems.keys()], { report: false });
    for (const name of order) {
      const key = this._resolveName(name) ?? name;
      const subsystem = this.subsystems.get(key) ?? this.getOrCreate(key);
      if (!subsystem || subsystem.isReady) continue;
      // A dependent registered before its dependency is a normal mid-session order, not an error:
      // skip it now and bring it up on the next refresh (or when its dependency registers).
      const ready = subsystem.dependencies.every((dependency) => this.get(dependency)?.isReady);
      if (!ready) continue;
      try {
        this._initializeOne(subsystem, initContext);
      } catch (error) {
        this.errors.push({ name, error });
      }
    }
    return this;
  }

  _initializeOne(subsystem, context) {
    // A Dead subsystem is revivable: `initialize()` accepts Created and Dead, which is what makes
    // `engine.restart()` (map change, project reload) work without rebuilding the collection.
    if (!subsystem || subsystem.isReady) return subsystem;
    // Dependencies are matched case-insensitively against registry keys: `static Dependencies =
    // ['assets']` must resolve to the subsystem registered as "Assets", or a lazily-constructed
    // subsystem silently never initializes and every update() becomes a no-op.
    const missing = subsystem.dependencies.filter((dependency) => {
      const resolved = this._resolveName(dependency) ?? dependency;
      const candidate = this.subsystems.get(resolved);
      return !candidate || !candidate.isReady;
    });
    if (missing.length) {
      throw new Error(`${subsystem.name} depends on ${missing.join(', ')}, which are not ready`);
    }
    subsystem.engine ??= context.engine ?? null;
    subsystem.world ??= context.world ?? null;
    subsystem.initialize(context);
    this.initializeOrder.push(subsystem.name);
    return subsystem;
  }

  /** Deinitializes everything in reverse initialization order. */
  deinitializeAll() {
    if (this._deinitialized) return this;
    this._deinitialized = true;
    this._initialized = false;
    for (let i = this.initializeOrder.length - 1; i >= 0; i--) {
      this.subsystems.get(this.initializeOrder[i])?.deinitialize();
    }
    // Anything registered after the initialize pass still needs tearing down.
    for (const subsystem of this.subsystems.values()) if (!subsystem.isDead) subsystem.deinitialize();
    this.initializeOrder = [];
    return this;
  }

  /** Once-per-frame update, in initialization order. Timed for the profiler. */
  update(deltaSeconds) {
    const start = collectionNow();
    for (const subsystem of this.subsystems.values()) subsystem.update(deltaSeconds);
    this.lastUpdateMs = collectionNow() - start;
    this.stats?.timing('Subsystems/Update', this.lastUpdateMs);
    return this;
  }

  /** Fixed-step update — runs 0..N times per frame and must be deterministic. */
  fixedUpdate(deltaSeconds) {
    const start = collectionNow();
    for (const subsystem of this.subsystems.values()) subsystem.fixedUpdate(deltaSeconds);
    this.lastFixedUpdateMs = collectionNow() - start;
    this.stats?.timing('Subsystems/FixedUpdate', this.lastFixedUpdateMs);
    return this;
  }

  /** Serializes every subsystem's state (save games, editor session restore). */
  serialize() {
    return this.instances.map((subsystem) => ({
      name: subsystem.name,
      type: subsystem.constructor.TypeName ?? subsystem.constructor.name,
      enabled: subsystem.enabled,
      data: subsystem.serialize(),
    }));
  }

  deserialize(records) {
    for (const record of records ?? []) {
      const subsystem = this.subsystems.get(record.name) ?? this.subsystems.get(record.type);
      if (!subsystem) continue;
      subsystem.setEnabled(record.enabled !== false);
      subsystem.deserialize?.(record.data);
    }
    return this;
  }

  setEnabled(name, enabled) {
    this.get(name)?.setEnabled(enabled);
    return this;
  }

  /** Subsystems in their resolved initialization order (perf HUD, docs). */
  get ordered() { return this.initializeOrder.map((name) => this.subsystems.get(name)).filter(Boolean); }

  /** Dependency order via depth-first topological sort; cycles and missing deps are reported. */
  _resolveOrder(names, { report = true } = {}) {
    const unique = [...new Set(names)];
    const order = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = (name, trail) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        log.error(`subsystem dependency cycle: ${[...trail, name].join(' → ')}`);
        this.errors.push({ name, error: new Error(`dependency cycle: ${[...trail, name].join(' → ')}`) });
        return;
      }
      const key = this._resolveName(name) ?? name;
      const factory = this._factories.get(key);
      const instance = this.subsystems.get(key);
      const deps = instance?.dependencies ?? (factory ? this._peekDependencies(name) : []);
      visiting.add(name);
      for (const dependency of deps) {
        const resolvedDependency = this._resolveName(dependency);
        if (!resolvedDependency) {
          if (!report) continue;
          log.warn(`${name} declares missing dependency "${dependency}"`);
          this.errors.push({ name, error: new Error(`missing dependency "${dependency}"`) });
          continue;
        }
        visit(resolvedDependency, [...trail, name]);
      }
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };
    for (const name of unique) visit(name, []);
    return order;
  }

  /** Declared dependencies for a not-yet-constructed subsystem. */
  _peekDependencies(name) {
    const instance = this.subsystems.get(name);
    if (instance) return instance.dependencies;
    return this._factories.get(name)?.dependencies ?? [];
  }

  describe() {
    return {
      name: this.name,
      count: this.subsystems.size,
      initialized: this._initialized,
      order: [...this.initializeOrder],
      subsystems: [...this.subsystems.values()].map((subsystem) => subsystem.describe()),
      errors: this.errors.map((entry) => `${entry.name}: ${entry.error.message}`),
    };
  }
}

/** Convenience: build, initialize and return a collection in one call (tests, tools). */
export function createSubsystemCollection(subsystems = {}, { context = {} } = {}) {
  const collection = new SubsystemCollection();
  for (const [name, entry] of Object.entries(subsystems)) {
    if (typeof entry === 'function') collection.register(entry, { name });
    else collection.registerInstance(entry, { name });
  }
  collection.initializeAll(context);
  return collection;
}

export default Subsystem;

function collectionNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
