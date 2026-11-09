/**
 * OminX Engine — object base and reflection (the UE `UObject` + `UClass` layer).
 *
 * Everything long-lived in the engine derives from `Object`. Two things make that worth the
 * inheritance instead of plain classes:
 *
 *   1. **Reflection.** `reflectClass(MyClass, { ... })` describes a class once — category, display
 *      name, properties (typed, with ranges and editors), methods and signals — and that single
 *      declaration is then used by the property inspector, the serializer, the script sandbox, the
 *      network replicator, the profiler and the docs generator. It is the schema for the whole
 *      engine, which is why it lives in the core rather than the editor.
 *   2. **Lifecycle.** `initialize()` runs once after construction and *after* every subsystem a
 *      constructor might need exists, matching UE's `PostInitializeComponents`: constructors stay
 *      cheap and allocation-free of engine singletons, and the engine can build objects in a safe
 *      order. Destruction is explicit (`destroy()`), idempotent, and emits a delegate so systems
 *      can react without patching every class.
 *
 * Object identity is a monotonically increasing 32-bit id plus a stable 16-bit `netId` space, so
 * the replication layer, the archive and the profiler can all refer to an object with one integer.
 *
 * @module engine/src/core/Object
 */
import { MulticastDelegate, Delegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Object');

/** Icons editors use when a class does not specify one, keyed by class category. */
export const ClassCategory = {
  Core: 'Core',
  Engine: 'Engine',
  World: 'World',
  Gameplay: 'Gameplay',
  Render: 'Render',
  Audio: 'Audio',
  Physics: 'Physics',
  AI: 'AI',
  Net: 'Net',
  UI: 'UI',
  Editor: 'Editor',
  Script: 'Script',
};

// `Object` is this module's own base class, which shadows the JS built-in inside this file: reach
// the real built-in through `globalThis` wherever it is needed.
let _nextObjectId = 1;
const _liveObjects = new Map();      // id → WeakRef<Object>
let _liveStrong = new Set();         // only when tracking is on
let _tracking = true;
const _classDirectory = new Map();   // class name → ClassInfo

/** Global engine-level delegates (UE's `FCoreDelegates`). */
export const engineEvents = {
  /** Broadcast once after the very first object of the process is created (bootstrap ordering). */
  onFirstObject: new MulticastDelegate('engine.onFirstObject'),
  /** Any object initialized — debugging/profiling hook, not for gameplay logic. */
  onObjectInitialized: new MulticastDelegate('engine.onObjectInitialized'),
  onObjectDestroyed: new MulticastDelegate('engine.onObjectDestroyed'),
  /** Fired when a class is registered, so tools can rebuild their class pickers. */
  onClassRegistered: new MulticastDelegate('engine.onClassRegistered'),
  onConfigChanged: new MulticastDelegate('engine.onConfigChanged'),
};

/**
 * Reflection record for a class: identity, hierarchy, categories and members. Built by
 * `reflectClass` and looked up by `getClassInfo`.
 */
export class ClassInfo {
  constructor(name, ctor, options = {}) {
    this.name = name;
    this.ctor = ctor;
    // The root class has no parent. Defaulting every class to `Object` (including `Object`) made
    // the hierarchy walk in `allProperties()` a cycle with no exit.
    this.parent = options.parent ?? (name === 'Object' ? null : Object);
    this.category = options.category ?? ClassCategory.Core;
    this.displayName = options.displayName ?? name;
    this.tooltip = options.tooltip ?? '';
    this.abstract = options.abstract === true;
    this.abstractMessage = options.abstractMessage ?? 'This class is abstract and cannot be spawned.';
    this.icon = options.icon ?? null;
    this.color = options.color ?? null;
    this.placeable = options.placeable === true;
    /** @type {Map<string, object>} */
    this.properties = new Map();
    /** @type {Map<string, object>} */
    this.methods = new Map();
    /** @type {Map<string, object>} */
    this.events = new Map();
    /** Engine systems this class asks for by name (`['renderer', 'physics']`). */
    this.dependencies = options.dependencies ?? [];
    this.enginePhase = options.enginePhase ?? null;
    this.tickGroup = options.tickGroup ?? null;
    this.metadata = { ...(options.metadata ?? {}) };
    /** Custom factory for classes that need non-standard construction (actors, assets). */
    this.factory = options.factory ?? null;
    this.validators = options.validators ?? [];
  }

  get isAbstract() { return this.abstract; }

  /** All properties including inherited ones, parent-first so overrides win. */
  /** Ancestor chain, root first, this class last. Cycle-safe. */
  hierarchy() {
    const chain = [];
    const visited = new Set();
    let current = this;
    while (current && !visited.has(current.name)) {
      visited.add(current.name);
      chain.unshift(current);
      current = current.parent ? getClassInfo(current.parent) : null;
    }
    return chain;
  }

  /** All properties including inherited ones; a subclass override wins. */
  allProperties() {
    const merged = new Map();
    for (const info of this.hierarchy()) for (const [key, def] of info.properties) merged.set(key, def);
    return merged;
  }

  /** All events including inherited ones. */
  allEvents() {
    const merged = new Map();
    for (const info of this.hierarchy()) for (const [key, def] of info.events) merged.set(key, def);
    return merged;
  }

  /** All methods including inherited ones. */
  allMethods() {
    const merged = new Map();
    for (const info of this.hierarchy()) for (const [key, def] of info.methods) merged.set(key, def);
    return merged;
  }

  isChildOf(other) {
    const target = typeof other === 'string' ? other : other?.name;
    if (!target) return false;
    const visited = new Set();
    let current = this;
    while (current && !visited.has(current.name)) {
      if (current.name === target) return true;
      visited.add(current.name);
      current = current.parent ? getClassInfo(current.parent) : null;
    }
    return false;
  }

  /** Spawns an instance (honours the class factory). Abstract classes refuse. */
  spawn(options = {}) {
    if (this.abstract) throw new Error(`${this.name}: ${this.abstractMessage}`);
    if (this.factory) return this.factory(options);
    const instance = new this.ctor(options);
    instance.initialize?.();
    return instance;
  }

  describe() {
    return {
      name: this.name,
      parent: this.parent?.name ?? null,
      category: this.category,
      displayName: this.displayName,
      abstract: this.abstract,
      placeable: this.placeable,
      dependencies: [...this.dependencies],
      properties: [...this.allProperties().keys()],
      methods: [...this.methods.keys()],
      events: [...this.allEvents().keys()],
    };
  }
}

/**
 * Declares a class to the reflection system. Call once per class, right after the class body:
 *
 * ```js
 * export class MeshComponent extends SceneComponent {
 *   static ClassName = 'MeshComponent';
 *   constructor(opts) { super(opts); this.mesh = opts.mesh ?? null; }
 * }
 * reflectClass(MeshComponent, {
 *   parent: SceneComponent,
 *   category: ClassCategory.Render,
 *   placeable: true,
 *   properties: { mesh: { type: 'Asset', category: 'Rendering' }, castShadow: { type: 'Boolean', default: true } },
 *   events: { onMeshChanged: {} },
 *   dependencies: ['renderer'],
 * });
 * ```
 */
export function reflectClass(ctor, options = {}) {
  // `ClassName` is a *static* field, and statics are inherited: `class Bot extends Actor {}` would
  // otherwise register itself as "Actor" (or "Object") and quietly replace its parent in the
  // directory. Only an own property counts; anything else falls back to the class name.
  const name = (globalThis.Object.hasOwn ? globalThis.Object.hasOwn(ctor, 'ClassName') : Object.prototype.hasOwnProperty.call(ctor, 'ClassName')) && ctor.ClassName
    ? ctor.ClassName
    : ctor.name;
  const existing = _classDirectory.get(name);
  if (existing && existing.ctor !== ctor) {
    log.warn(`reflectClass: "${name}" is already registered by ${existing.ctor.name}, overwriting`);
  }
  const info = new ClassInfo(name, ctor, options);
  // Members may be declared as an array of `{ name, … }` descriptors (the form gameplay and tools
  // actually write) or as a `{ name: descriptor }` map. Iterating an array with `Object.entries`
  // keys every member by its index, which silently produces a class whose properties are named
  // "0" and "1" — normalising here is what keeps reflection usable from both call styles.
  for (const [key, def] of memberEntries(options.properties, 'property')) {
    info.properties.set(key, normalizeMember(key, def, 'property'));
  }
  for (const [key, def] of memberEntries(options.methods, 'method')) {
    info.methods.set(key, normalizeMember(key, def, 'method'));
  }
  for (const [key, def] of memberEntries(options.events, 'event')) {
    info.events.set(key, normalizeMember(key, def, 'event'));
  }
  _classDirectory.set(name, info);
  ctor.ClassName = name;
  ctor.__classInfo = info;
  engineEvents.onClassRegistered.broadcast(info);
  return info;
}

function normalizeMember(key, def, kind) {
  if (def === null || def === undefined) return { name: key, kind, category: 'Default', editor: true };
  if (typeof def !== 'object') return { name: key, kind, description: String(def), category: 'Default', editor: true };
  return {
    name: key,
    kind,
    category: def.category ?? 'Default',
    description: def.description ?? def.tooltip ?? '',
    type: def.type ?? 'Any',
    default: def.default,
    min: def.min,
    max: def.max,
    step: def.step,
    unit: def.unit,
    enum: def.enum,
    readOnly: def.readOnly === true,
    editable: def.editor !== false,
    replicated: def.replicated ?? null,
    advanced: def.advanced === true,
    metadata: { ...(def.metadata ?? {}) },
  };
}

/** Reflection record for a class name, constructor or instance. */
/**
 * Normalises a member declaration list into `[name, descriptor]` pairs.
 * Accepts `[{ name, … }]`, `['name', …]` and `{ name: descriptor }`.
 */
function memberEntries(source, kind) {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source.map((definition) => {
      if (typeof definition === 'string') return [definition, { name: definition }];
      const key = definition?.name;
      if (!key) throw new Error(`reflectClass: every ${kind} needs a name`);
      return [key, definition];
    });
  }
  return globalThis.Object.entries(source).map(([key, definition]) => [
    key,
    typeof definition === 'string' ? { name: key, type: definition } : { name: key, ...(definition ?? {}) },
  ]);
}

export function getClassInfo(target) {
  if (!target) return null;
  if (target instanceof ClassInfo) return target;
  if (typeof target === 'string') return _classDirectory.get(target) ?? null;
  if (typeof target === 'function') return target.__classInfo ?? _classDirectory.get(target.ClassName) ?? null;
  return target.constructor?.__classInfo ?? _classDirectory.get(target.constructor?.ClassName) ?? null;
}

export function isClass(target, className) {
  const info = getClassInfo(target);
  return !!info && info.isChildOf(className);
}

/** Every registered class, optionally filtered. Used by the class picker and docs. */
export function listClasses({ category = null, placeableOnly = false, includeAbstract = true, wildcard = null } = {}) {
  const out = [];
  // Category matching is case-insensitive ("gameplay" vs ClassCategory.Gameplay): a filter that
  // silently returns nothing is worse than no filter at all.
  const wanted = category === null ? null : String(category).toLowerCase();
  const pattern = wildcard ? new RegExp(`^${String(wildcard).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i') : null;
  for (const info of _classDirectory.values()) {
    if (wanted && String(info.category).toLowerCase() !== wanted) continue;
    if (pattern && !pattern.test(info.name)) continue;
    if (placeableOnly && !info.placeable) continue;
    if (!includeAbstract && info.abstract) continue;
    out.push(info);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getClassCount() { return _classDirectory.size; }

/** Hierarchy as a nested structure (docs + outliner grouping). */
export function buildClassTree(rootName = 'Object') {
  const root = getClassInfo(rootName);
  if (!root) return null;
  const children = new Map();
  for (const info of _classDirectory.values()) {
    if (info.name === rootName) continue;
    const parentName = info.parent?.ClassName ?? rootName;
    if (!children.has(parentName)) children.set(parentName, []);
    children.get(parentName).push(info);
  }
  const build = (info) => ({
    name: info.name,
    category: info.category,
    abstract: info.abstract,
    children: (children.get(info.name) ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(build),
  });
  return build(root);
}

/**
 * Base class for every engine object.
 *
 * Construction order is deliberate: the constructor may only set fields, and `initialize()` is
 * called by whoever created the object once the world around it exists. Overrides must call
 * `super.initialize()` (the base implementation resolves named systems and marks the object
 * initialized).
 */
export class Object {
  static ClassName = 'Object';

  /** Class-level events (UE's `UClass`-scoped delegates). */
  static Events = {
    onClassRegistered: engineEvents.onClassRegistered,
  };

  constructor(name = null, options = {}) {
    this.id = _nextObjectId++;
    this.netId = (((this.id * 2654435761) >>> 0) >>> 16) & 0xffff;
    this.name = name ?? this.constructor.ClassName ?? 'Object';
    this.className = this.constructor.ClassName ?? this.constructor.name;
    /** @type {Map<string, any>} */
    this._systems = new Map();
    this._initialized = false;
    this._destroyed = false;
    this._tags = new Set();
    this.flags = { temporary: false, replicated: false, editorOnly: false, dirty: false, ...(options.flags ?? {}) };
    if (options.tags) for (const tag of options.tags) this._tags.add(tag);
    if (options.name) this.name = options.name;
    if (_nextObjectId === 2) engineEvents.onFirstObject.broadcast(this);
    if (_tracking) _liveStrong.add(this);
  }

  get classInfo() { return getClassInfo(this.constructor); }
  get isInitialized() { return this._initialized; }
  get isDestroyed() { return this._destroyed; }
  get world() { return this._world ?? this._systems.get('world') ?? null; }
  setWorld(world) { this._world = world; return this; }

  /**
   * Binds a named engine system (`renderer`, `physics`, `audio`, `net`, `assets`, …). Objects ask
   * for what they need by name, so a headless run simply never binds a renderer.
   */
  bindSystem(name, system) {
    this._systems.set(name, system);
    return this;
  }

  getSystem(name) { return this._systems.get(name) ?? null; }
  hasSystem(name) { return this._systems.has(name); }

  /** Candidate names a system may be bound under (`renderer` → `gpu`, `device`, …). */
  resolveSystem(...names) {
    for (const name of names) {
      const system = this._systems.get(name);
      if (system) return system;
    }
    return null;
  }

  /**
   * One-time initialization. Idempotent, and safe to call on a destroyed object (no-op). Subclasses
   * override and call `super.initialize()`.
   */
  initialize(context = {}) {
    if (this._initialized || this._destroyed) return this;
    this._initialized = true;
    this.onInitialize(context);
    engineEvents.onObjectInitialized.broadcast(this);
    return this;
  }

  /** Override point — called exactly once, from `initialize()`. */
  onInitialize(_context) {}

  /** Per-frame tick. `deltaSeconds` is the real frame delta; fixed-rate logic belongs in `tick`. */
  update(_deltaSeconds) {}

  /** Fixed-rate update, driven by the scheduler/physics tick. */
  fixedUpdate(_deltaSeconds) {}

  /** Marks this object as needing serialization/registration (dirty flag for editors). */
  markDirty() { this.flags.dirty = true; return this; }
  clearDirty() { this.flags.dirty = false; return this; }

  // ------------------------------------------------------------------ tags
  addTag(tag) { this._tags.add(String(tag)); return this; }
  removeTag(tag) { this._tags.delete(String(tag)); return this; }
  hasTag(tag) { return this._tags.has(String(tag)); }
  get tags() { return this._tags; }

  /**
   * Destroys the object. Idempotent; destroys children first when the class owns them
   * (`SceneComponent` overrides `onDestroyed` to walk its attachment tree).
   */
  destroy() {
    if (this._destroyed) return false;
    this._destroyed = true;
    try {
      this.onDestroyed();
    } catch (error) {
      log.error(`${this.className}.onDestroyed threw: ${error?.message ?? error}`);
    }
    this._systems.clear();
    _liveStrong.delete(this);
    _liveObjects.delete(this.id);
    engineEvents.onObjectDestroyed.broadcast(this);
    return true;
  }

  /** Override point — release GPU resources, unbind delegates, detach children. */
  onDestroyed() {}

  /** Human-readable identity for logs, the profiler and the docs. */
  toString() { return `${this.className}(${this.name})#${this.id}`; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toString(); }

  /** Reflection-driven snapshot of this object's declared properties. */
  describeProperties() {
    const info = this.classInfo;
    if (!info) return {};
    const out = {};
    for (const [key, def] of info.allProperties()) out[key] = { value: this[key], ...def };
    return out;
  }
}

// ---------------------------------------------------------------------- live object registry
/**
 * Strong registry used by the profiler, the editor and leak tests. Strong by default so a normal
 * engine run is observable; `setObjectTracking(false)` removes the overhead entirely for shipped
 * builds, and `engineEvents.onObjectDestroyed` keeps weak registries in sync.
 */
export function setObjectTracking(enabled) {
  _tracking = !!enabled;
  if (!_tracking) _liveStrong = new Set();
  return _tracking;
}

export function isTrackingObjects() { return _tracking; }

export function liveObjectCount() { return _liveStrong.size; }

export function getLiveObjects({ className = null } = {}) {
  const out = [];
  for (const object of _liveStrong) {
    if (object._destroyed) { _liveStrong.delete(object); continue; }
    if (className && object.className !== className) continue;
    out.push(object);
  }
  return out;
}

/** Finds a live object by id (profiler, replication, undo records). */
export function findObjectById(id) {
  for (const object of _liveStrong) if (object.id === id) return object;
  return null;
}

/** Objects that have not been destroyed — leak check for tests and the editor. */
export function findLeakedObjects({ exclude = [] } = {}) {
  const excluded = new Set(exclude);
  return getLiveObjects().filter((object) => !excluded.has(object));
}

engineEvents.onObjectDestroyed.add((object) => { _liveObjects.delete(object.id); }, { weak: false });

reflectClass(Object, {
  category: ClassCategory.Core,
  displayName: 'Object',
  tooltip: 'Base class of everything in the engine.',
  properties: { name: { type: 'String', category: 'Identity', editor: true } },
  events: {},
});

export default Object;
