/**
 * OminX Engine — UE-style world, actors and components.
 *
 * Everything above the object model needs a *place to exist*. `UWorld` owns a set of levels;
 * `AActor` is a placeable object with a lifecycle and a set of `UActorComponent`s; `USceneComponent`
 * is a transform in an attachment hierarchy. This module supplies exactly that, without a renderer,
 * a mesh, a physics backend or any gameplay rule. It is the structural half of an FPS: a weapon is
 * a component, a player start is an actor, a level is a named set of actors, and replication is
 * wired in at `spawnActor()` rather than bolted on by each system.
 *
 * Rules:
 *   - **Explicit lifecycle.** `created → begunPlay → playing → endedPlay → destroyed`. A world is
 *     running from construction, so `spawnActor()` brings each new actor and its components through
 *     the lifecycle; `world.beginPlay()` is idempotent and `endPlay()` is reversible.
 *   - **Tick groups.** `PrePhysics → DuringPhysics → PostPhysics → PostUpdateWork`. Within a group
 *     actors tick in spawn order; components tick in registration order. Stable and deterministic.
 *   - **Errors are isolated.** A throwing `onTick()` is recorded, the rest of the world ticks.
 *   - **Transforms compose.** `SceneComponent` uses the engine's `Transform`/`Matrix4` maths;
 *     `attachTo(parent, { keepWorld })` preserves world placement when requested.
 *   - **Net-ready.** An actor with `replicate: true` gets a net id and a replicated object on the
 *     engine's `ReplicationSystem`; `actor.setReplicated()` marks the corresponding property dirty.
 *
 * ```
 * const world = engine.createWorld({ name: 'Arena' });
 * const start = world.spawnActor({ name: 'RedSpawn', className: 'PlayerStart', tags: ['spawn', 'red'] });
 * start.root.setPosition(0, 2, -10);
 * world.beginPlay();
 * world.tick(1 / 60);
 * ```
 *
 * @module engine/src/core/World
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';
import { Transform } from '../math/Transform.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Vector3 } from '../math/Vector3.js';
import { Quaternion } from '../math/Quaternion.js';

const log = createLogger('World');

export const TickGroup = Object.freeze({
  PrePhysics: 'prePhysics', DuringPhysics: 'duringPhysics',
  PostPhysics: 'postPhysics', PostUpdateWork: 'postUpdateWork',
});

export const TICK_GROUP_ORDER = Object.freeze([
  TickGroup.PrePhysics, TickGroup.DuringPhysics, TickGroup.PostPhysics, TickGroup.PostUpdateWork,
]);

export const ActorLifecycle = Object.freeze({
  Created: 'created', BegunPlay: 'begunPlay', Playing: 'playing',
  EndedPlay: 'endedPlay', Destroyed: 'destroyed',
});

export const worldEvents = {
  onActorSpawned: new MulticastDelegate('world.onActorSpawned'),
  onActorDestroyed: new MulticastDelegate('world.onActorDestroyed'),
  onBeginPlay: new MulticastDelegate('world.onBeginPlay'),
  onEndPlay: new MulticastDelegate('world.onEndPlay'),
  onLevelLoaded: new MulticastDelegate('world.onLevelLoaded'),
  onLevelUnloaded: new MulticastDelegate('world.onLevelUnloaded'),
  onTickGroup: new MulticastDelegate('world.onTickGroup'),
  onError: new MulticastDelegate('world.onError'),
};

let COMPONENT_IDS = 0;

/**
 * Base component. Override `onInitialize`, `onBeginPlay`, `onTick`, `onEndPlay` in a subclass, or
 * pass them as constructor callbacks for one-off components.
 */
export class ActorComponent {
  constructor({ name = 'Component', owner = null, tickGroup = TickGroup.DuringPhysics, tickEnabled = false, tickInterval = 0, hooks = null } = {}) {
    this.componentId = ++COMPONENT_IDS;
    this.name = name;
    this.owner = owner;
    this.tickGroup = TICK_GROUP_ORDER.includes(tickGroup) ? tickGroup : TickGroup.DuringPhysics;
    this.tickEnabled = !!tickEnabled;
    this.tickInterval = Math.max(0, Number(tickInterval) || 0);
    this.active = true;
    this.initialized = false;
    this.hasBegunPlay = false;
    this.tickAccumulator = 0;
    this.tickCount = 0;
    this.lastError = null;
    this.hooks = hooks ?? {};
  }

  static create(options) { return new ActorComponent(options); }
  get world() { return this.owner?.world ?? null; }
  get className() { return this.constructor.name; }

  activate() { const changed = !this.active; this.active = true; return changed; }
  deactivate() { const changed = this.active; this.active = false; return changed; }

  initialize() {
    if (this.initialized) return this;
    this.initialized = true;
    this._run('onInitialize', [this], () => this.hooks.onInitialize?.(this));
    return this;
  }

  beginPlay() {
    if (this.hasBegunPlay) return this;
    this.initialize();
    this.hasBegunPlay = true;
    this._run('onBeginPlay', [this], () => this.hooks.onBeginPlay?.(this));
    return this;
  }

  endPlay() {
    if (!this.hasBegunPlay) return this;
    this._run('onEndPlay', [this], () => this.hooks.onEndPlay?.(this));
    this.hasBegunPlay = false;
    return this;
  }

  /** Accumulates the tick interval and dispatches `onTick`. Returns true when it actually ticked. */
  tick(deltaSeconds) {
    if (!this.tickEnabled || !this.active || !this.hasBegunPlay) return false;
    const delta = Math.max(0, Number(deltaSeconds) || 0);
    if (this.tickInterval > 0) {
      this.tickAccumulator += delta;
      if (this.tickAccumulator < this.tickInterval) return false;
      this.tickAccumulator %= this.tickInterval;
    }
    this.tickCount++;
    this._run('onTick', [delta, this], () => this.hooks.onTick?.(delta, this));
    return true;
  }

  _run(hook, args, fallback) {
    try {
      if (typeof this[hook] === 'function') this[hook].apply(this, args);
      else if (typeof this.hooks?.[hook] === 'function') this.hooks[hook].apply(this, args);
      else fallback();
    } catch (error) {
      this.lastError = error?.message ?? String(error);
      log.error(`component \"${this.name}\" ${hook} threw: ${this.lastError}`);
      worldEvents.onError.broadcast(this, error, this.world);
    }
  }

  describe() {
    return {
      componentId: this.componentId, name: this.name, class: this.className,
      owner: this.owner?.name ?? null, tickGroup: this.tickGroup, tickEnabled: this.tickEnabled,
      tickInterval: this.tickInterval, active: this.active, hasBegunPlay: this.hasBegunPlay,
      ticks: this.tickCount, lastError: this.lastError,
    };
  }

  format() {
    return `    ${this.className.padEnd(18)} ${this.name.padEnd(18)} ${this.tickGroup.padEnd(14)} ${this.active ? 'active  ' : 'inactive'} ${this.tickEnabled ? `${this.tickCount} ticks` : 'no tick'}`;
  }
}

/** A component that has a transform and can be attached to another scene component. */
export class SceneComponent extends ActorComponent {
  constructor(options = {}) {
    super({ name: options.name ?? 'Scene', ...options });
    this.transform = new Transform();
    this.parent = null;
    this.children = [];
    this.visible = options.visible !== false;
  }

  static create(options) { return new SceneComponent(options); }

  setPosition(x, y, z) { this.transform.set(x, y, z); return this; }
  setRotationEuler(xDeg, yDeg, zDeg) { this.transform.setRotationEuler(xDeg, yDeg, zDeg); return this; }
  setScale(x, y, z) { this.transform.setScale(x, y, z); return this; }
  translate(x, y, z, local = false) { this.transform.translate(new Vector3(x, y, z), local); return this; }
  rotateY(degrees) { this.transform.rotateY(degrees * Math.PI / 180); return this; }

  /** Composes this component's world matrix from its attachment chain. */
  getWorldMatrix(out = new Matrix4()) {
    const chain = [];
    let node = this;
    const visited = new Set();
    while (node) {
      if (visited.has(node)) break; // defensive: a corrupt chain cannot loop forever
      visited.add(node);
      chain.unshift(node);
      node = node.parent;
    }
    out.identity();
    for (const link of chain) out.multiply(link.transform.updateMatrix());
    return out;
  }

  getWorldPosition(out = new Vector3()) { return out.setFromMatrixPosition(this.getWorldMatrix()); }

  /** Attaches to a parent component. Rejects cycles. `keepWorld` preserves world placement. */
  attachTo(parent, { keepWorld = false } = {}) {
    if (!parent || !(parent instanceof SceneComponent)) throw new TypeError('attachTo() needs a SceneComponent');
    if (parent === this) return false;
    let ancestor = parent;
    while (ancestor) {
      if (ancestor === this) throw new Error('attachTo() would create a cycle');
      ancestor = ancestor.parent;
    }
    const before = keepWorld ? this.getWorldMatrix().clone() : null;
    this.detach();
    this.parent = parent;
    parent.children.push(this);
    if (before) {
      const parentWorld = parent.getWorldMatrix();
      const local = new Matrix4().multiplyMatrices(parentWorld.clone().invert(), before);
      const position = new Vector3();
      const rotation = new Quaternion();
      const scale = new Vector3();
      local.decompose(position, rotation, scale);
      this.transform.position.copy(position);
      this.transform.rotation.copy(rotation);
      this.transform.scale.copy(scale);
      this.transform.markDirty();
    }
    return true;
  }

  detach() {
    if (!this.parent) return false;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
    return true;
  }

  /** Depth-first list of attached descendants. */
  descendants() {
    const out = [];
    const visit = (node) => { for (const child of node.children) { out.push(child); visit(child); } };
    visit(this);
    return out;
  }

  describe() {
    return { ...super.describe(), position: this.transform.position.toJSON(), worldPosition: this.getWorldPosition().toJSON(), attachedChildren: this.children.length };
  }
}

let ACTOR_IDS = 0;

/** A placeable object: root scene component, component list, lifecycle, tags and net state. */
export class Actor {
  constructor({ name = 'Actor', className = null, tags = null, world = null, netId = null, netRole = null, lifespan = 0, hidden = false } = {}) {
    this.actorId = ++ACTOR_IDS;
    this.name = name;
    this.className = className ?? this.constructor.name;
    this.world = world;
    this.netId = netId;
    this.netRole = netRole ?? 'none';
    this.lifespan = Math.max(0, Number(lifespan) || 0);
    this.age = 0;
    this.hidden = !!hidden;
    this.state = ActorLifecycle.Created;
    this.tags = new Set(tags ?? []);
    this.components = [];
    this.replicatedProperties = new Map();
    this.lastError = null;
    this.root = new SceneComponent({ name: `${name}.Root`, owner: this });
    this._addComponentInternal(this.root);
  }

  static create(options) { return new Actor(options); }

  get transform() { return this.root.transform; }
  get isPlaying() { return this.state === ActorLifecycle.Playing || this.state === ActorLifecycle.BegunPlay; }
  get isDestroyed() { return this.state === ActorLifecycle.Destroyed; }

  setRoot(component) {
    if (!(component instanceof SceneComponent)) throw new TypeError('setRoot() needs a SceneComponent');
    const previous = this.root;
    for (const child of [...previous.children]) child.attachTo(component, { keepWorld: true });
    this.removeComponent(previous);
    this.root = component;
    this._addComponentInternal(component);
    return component;
  }

  _addComponentInternal(component) {
    component.owner = this;
    this.components.push(component);
    return component;
  }

  addComponent(componentOrOptions) {
    const component = componentOrOptions instanceof ActorComponent
      ? componentOrOptions
      : new ActorComponent(componentOrOptions);
    if (this.components.includes(component)) return component;
    this._addComponentInternal(component);
    if (this.isPlaying) component.beginPlay();
    return component;
  }

  getComponent(predicate) {
    if (typeof predicate === 'string') return this.components.find((component) => component.name === predicate || component.className === predicate) ?? null;
    if (typeof predicate === 'function') return this.components.find((component) => component instanceof predicate || predicate(component)) ?? null;
    return null;
  }

  removeComponent(component) {
    const index = this.components.indexOf(component);
    if (index < 0) return false;
    component.endPlay();
    this.components.splice(index, 1);
    return true;
  }

  addTag(tag) { this.tags.add(String(tag)); return this; }
  removeTag(tag) { return this.tags.delete(String(tag)); }
  hasTag(tag) { return this.tags.has(String(tag)); }

  setPosition(x, y, z) { this.root.setPosition(x, y, z); return this; }
  getWorldPosition(out = new Vector3()) { return this.root.getWorldPosition(out); }
  setRotationEuler(x, y, z) { this.root.setRotationEuler(x, y, z); return this; }

  beginPlay() {
    if (this.state !== ActorLifecycle.Created) return this;
    this.state = ActorLifecycle.BegunPlay;
    for (const component of this.components) component.beginPlay();
    this.state = ActorLifecycle.Playing;
    worldEvents.onBeginPlay.broadcast(this, this.world);
    return this;
  }

  endPlay() {
    if (!this.isPlaying) return this;
    for (const component of [...this.components].reverse()) component.endPlay();
    this.state = ActorLifecycle.EndedPlay;
    worldEvents.onEndPlay.broadcast(this, this.world);
    return this;
  }

  destroy() {
    if (this.isDestroyed) return false;
    if (this.world) return this.world.destroyActor(this);
    this.endPlay();
    this.state = ActorLifecycle.Destroyed;
    return true;
  }

  /** Ticks only the components in `group`; the world calls this once per group per step. */
  tickGroup(group, deltaSeconds) {
    if (!this.isPlaying) return 0;
    let ticked = 0;
    for (const component of this.components) {
      if (component.tickGroup === group && component.tick(deltaSeconds)) ticked++;
    }
    return ticked;
  }

  tick(deltaSeconds) {
    let ticked = 0;
    for (const group of TICK_GROUP_ORDER) ticked += this.tickGroup(group, deltaSeconds);
    return ticked;
  }

  /**
   * Writes a replicated property. Marks the matching `ReplicationSystem` object dirty, so the next
   * `collectDeltas()` sends exactly this field. Also stored locally for snapshots and tests.
   */
  setReplicated(name, value) {
    this.replicatedProperties.set(name, value);
    const system = this.world?.replication ?? null;
    if (system && this.netId !== null && system.has(this.netId)) system.setProperty(this.netId, name, value);
    return value;
  }

  getReplicated(name, fallback = null) { return this.replicatedProperties.has(name) ? this.replicatedProperties.get(name) : fallback; }

  describe() {
    return {
      actorId: this.actorId, name: this.name, class: this.className, state: this.state,
      netId: this.netId, netRole: this.netRole, level: this.level ?? null,
      tags: [...this.tags], age: Math.round(this.age * 1000) / 1000, lifespan: this.lifespan,
      position: this.root.transform.position.toJSON(), worldPosition: this.getWorldPosition().toJSON(),
      components: this.components.map((component) => component.describe()),
      replicated: Object.fromEntries(this.replicatedProperties),
      lastError: this.lastError,
    };
  }

  format() {
    return `  ${String(this.actorId).padEnd(5)} ${this.name.padEnd(18)} ${this.className.padEnd(16)} ${this.state.padEnd(10)} ${this.tags.size} tags · ${this.components.length} components`;
  }
}

/** One world: named levels, actor registry, tick groups, replication binding and snapshots. */
export class World {
  constructor({ name = 'World', engine = null, replication = null, stats = null, maxErrors = 32 } = {}) {
    this.name = name;
    this.engine = engine;
    this.replication = replication;
    this.stats = stats;
    this.actors = new Map();
    this.levels = new Map();
    this.time = 0;
    this.tickCount = 0;
    this.spawnCount = 0;
    this.destroyCount = 0;
    this.ticksDispatched = 0;
    this.errors = [];
    this.maxErrors = Math.max(1, Math.floor(maxErrors));
    this._netIds = 0;
    this.loadLevel('PersistentLevel');
  }

  static create(options) { return new World(options); }

  get count() { return this.actors.size; }
  get isPlaying() { return true; }
  get actorIds() { return [...this.actors.keys()]; }

  bindReplication(system) { this.replication = system ?? null; return this; }

  _recordError(message, error = null) {
    const text = error ? `${message}: ${error?.message ?? error}` : message;
    this.errors.push(text);
    if (this.errors.length > this.maxErrors) this.errors.shift();
    log.error(text);
    worldEvents.onError.broadcast(message, error, this);
  }

  /**
   * Spawns an actor from a class, an `Actor` instance, or a plain options object.
   * `replicate: true` allocates a net id and registers a replicated object.
   */
  spawnActor(source = {}, { level = 'PersistentLevel', replicate = false, netRole = 'authority', tags = null, properties = null } = {}) {
    let actor;
    if (source instanceof Actor) actor = source;
    else if (typeof source === 'function') actor = new source();
    else actor = new Actor(source);
    if (actor.world && actor.world !== this) throw new Error('actor already belongs to another world');
    actor.world = this;
    actor.level = String(level);
    if (tags) for (const tag of tags) actor.addTag(tag);
    if (replicate || actor.netId !== null) {
      if (actor.netId === null || actor.netId === undefined) actor.netId = ++this._netIds;
      actor.netRole = netRole;
      if (this.replication && !this.replication.has(actor.netId)) {
        this.replication.register(actor.netId, {
          classId: actor.className, role: netRole, properties: properties ?? Object.fromEntries(actor.replicatedProperties),
        });
      }
    }
    this.actors.set(actor.actorId, actor);
    if (!this.levels.has(actor.level)) this.loadLevel(actor.level);
    this.levels.get(actor.level).actors.add(actor.actorId);
    this.spawnCount++;
    if (actor.state === ActorLifecycle.Created) actor.beginPlay();
    if (properties) for (const [key, value] of Object.entries(properties)) actor.setReplicated(key, value);
    worldEvents.onActorSpawned.broadcast(actor, this);
    this.stats?.gauge('World/Actors', this.actors.size);
    return actor;
  }

  destroyActor(actorOrId) {
    const actor = actorOrId instanceof Actor ? actorOrId : this.actors.get(actorOrId);
    if (!actor || !this.actors.has(actor.actorId)) return false;
    actor.endPlay();
    actor.state = ActorLifecycle.Destroyed;
    this.actors.delete(actor.actorId);
    this.levels.get(actor.level)?.actors.delete(actor.actorId);
    if (actor.netId !== null && this.replication?.has(actor.netId)) this.replication.unregister(actor.netId);
    actor.root.detach();
    this.destroyCount++;
    worldEvents.onActorDestroyed.broadcast(actor, this);
    return true;
  }

  getActor(id) { return this.actors.get(id) ?? null; }
  actorsOfClass(className) { return [...this.actors.values()].filter((actor) => actor.className === className); }
  actorsWithTag(tag) { return [...this.actors.values()].filter((actor) => actor.hasTag(tag)); }
  findActor(name) { return [...this.actors.values()].find((actor) => actor.name === name) ?? null; }

  loadLevel(name) {
    const key = String(name);
    if (this.levels.has(key)) return this.levels.get(key);
    const level = { name: key, actors: new Set(), loaded: true, loadedAt: Date.now() };
    this.levels.set(key, level);
    worldEvents.onLevelLoaded.broadcast(key, this);
    return level;
  }

  unloadLevel(name) {
    const key = String(name);
    const level = this.levels.get(key);
    if (!level) return 0;
    const doomed = [...level.actors];
    for (const id of doomed) this.destroyActor(id);
    this.levels.delete(key);
    worldEvents.onLevelUnloaded.broadcast(key, this);
    return doomed.length;
  }

  beginPlay() {
    for (const actor of this.actors.values()) actor.beginPlay();
    return this;
  }

  endPlay() {
    for (const actor of [...this.actors.values()].reverse()) actor.endPlay();
    return this;
  }

  /** Advances every tick group in order. Throwing components are recorded, not fatal. */
  tick(deltaSeconds) {
    const delta = Math.max(0, Number(deltaSeconds) || 0);
    this.time += delta;
    this.tickCount++;
    const expired = [];
    for (const actor of this.actors.values()) {
      if (actor.lifespan > 0) {
        actor.age += delta;
        if (actor.age >= actor.lifespan) expired.push(actor);
      }
    }
    for (const group of TICK_GROUP_ORDER) {
      let dispatched = 0;
      for (const actor of this.actors.values()) {
        if (!actor.isPlaying) continue;
        try {
          dispatched += actor.tickGroup(group, delta);
        } catch (error) {
          actor.lastError = error?.message ?? String(error);
          this._recordError(`actor \"${actor.name}\" tick ${group} threw`, error);
        }
      }
      this.ticksDispatched += dispatched;
      worldEvents.onTickGroup.broadcast(group, dispatched, this);
    }
    for (const actor of expired) this.destroyActor(actor);
    return this.ticksDispatched;
  }

  /** Advances N fixed steps in one call — deterministic headless simulation. */
  runFixedFrames(frames, deltaSeconds = 1 / 60) {
    for (let i = 0; i < Math.max(0, Math.floor(frames)); i++) this.tick(deltaSeconds);
    return this.tickCount;
  }

  /** Collects replication deltas for this world (a host sends them after the simulation step). */
  collectNetDeltas(options = {}) { return this.replication ? this.replication.collectDeltas(options) : []; }

  /** Portable world snapshot (level streaming, save/restore, replay start). */
  snapshot() {
    return {
      format: 'ominx-world', version: 1, name: this.name, time: this.time, tick: this.tickCount,
      levels: [...this.levels.keys()],
      actors: [...this.actors.values()].map((actor) => ({
        name: actor.name, className: actor.className, level: actor.level,
        state: actor.state, tags: [...actor.tags], netId: actor.netId, netRole: actor.netRole,
        transform: actor.root.transform.toJSON(), replicated: Object.fromEntries(actor.replicatedProperties),
        components: actor.components.filter((component) => component !== actor.root).map((component) => ({ name: component.name, class: component.className, tickGroup: component.tickGroup })),
      })),
    };
  }

  loadSnapshot(data, { replace = true } = {}) {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (parsed?.format !== 'ominx-world' || !Array.isArray(parsed.actors)) throw new Error('not an OminX world snapshot');
    if (replace) for (const actor of [...this.actors.values()]) this.destroyActor(actor);
    for (const name of parsed.levels ?? []) this.loadLevel(name);
    this.time = parsed.time ?? 0;
    this.tickCount = parsed.tick ?? 0;
    let restored = 0;
    for (const entry of parsed.actors) {
      const actor = this.spawnActor({
        name: entry.name, className: entry.className, tags: entry.tags,
        netId: entry.netId ?? null, netRole: entry.netRole,
      }, { level: entry.level ?? 'PersistentLevel', replicate: entry.netId !== null && entry.netId !== undefined });
      actor.root.transform.fromJSON(entry.transform);
      for (const [key, value] of Object.entries(entry.replicated ?? {})) actor.setReplicated(key, value);
      restored++;
    }
    return restored;
  }

  describe() {
    return {
      name: this.name, time: Math.round(this.time * 1000) / 1000, tick: this.tickCount,
      actors: this.actors.size, levels: [...this.levels.keys()],
      spawned: this.spawnCount, destroyed: this.destroyCount,
      ticksDispatched: this.ticksDispatched, errors: this.errors.length,
      replication: this.replication ? this.replication.describe().objects : null,
      classes: [...new Set([...this.actors.values()].map((actor) => actor.className))],
      actorsView: [...this.actors.values()].slice(0, 8).map((actor) => actor.describe()),
    };
  }

  format() {
    const lines = [
      `  ${this.name} — ${this.actors.size} actors · ${this.levels.size} levels · tick ${this.tickCount} (${this.time.toFixed(2)}s)`,
      `  spawned ${this.spawnCount} · destroyed ${this.destroyCount} · ${this.ticksDispatched} component ticks · ${this.errors.length} errors`,
      `  levels  ${[...this.levels.keys()].join(', ') || 'none'}`,
    ];
    for (const actor of [...this.actors.values()].slice(0, 8)) {
      lines.push(actor.format());
      for (const component of actor.components.slice(0, 3)) lines.push(component.format());
    }
    if (!this.actors.size) lines.push('  (no actors)');
    return lines.join('\n');
  }

  installConsoleCommands(console_) {
    const world = this;
    console_.registerCommand({
      name: 'world', aliases: ['world.list'], category: 'World', description: 'World state and actors.',
      execute: () => world.format(),
    });
    console_.registerCommand({
      name: 'world.actors', category: 'World', description: 'Actors as JSON.',
      execute: () => JSON.stringify([...world.actors.values()].map((actor) => actor.describe()), null, 2),
    });
    console_.registerCommand({
      name: 'world.spawn', category: 'World', description: 'Spawns a test actor.',
      args: [{ name: 'name', required: false, default: 'ConsoleActor' }, { name: 'class', required: false, default: 'Actor' }],
      execute: (args) => {
        const actor = world.spawnActor({ name: args.name, className: args.class });
        return `spawned #${actor.actorId} ${actor.name} (${actor.className})`;
      },
    });
    console_.registerCommand({
      name: 'world.destroy', category: 'World', description: 'Destroys an actor by id.',
      args: [{ name: 'id', type: 'int' }],
      execute: (args) => world.destroyActor(args.id) ? `destroyed #${args.id}` : `no actor #${args.id}`,
    });
    console_.registerCommand({
      name: 'world.levels', category: 'World', description: 'Loaded levels.',
      execute: () => [...world.levels.values()].map((level) => `${level.name.padEnd(20)} ${level.actors.size} actors  ${level.loaded ? 'loaded' : 'unloaded'}`).join('\n') || 'no levels',
    });
    console_.registerCommand({
      name: 'world.tick', category: 'World', description: 'Advances the world N fixed steps.',
      args: [{ name: 'count', type: 'int', min: 1, max: 10000, required: false, default: 1 }],
      execute: (args) => {
        world.runFixedFrames(args.count);
        return `world tick ${world.tickCount} · ${world.ticksDispatched} component ticks`;
      },
    });
    console_.registerCommand({
      name: 'world.net', category: 'World', description: 'Collects replication deltas.',
      execute: () => JSON.stringify(world.collectNetDeltas(), null, 2),
    });
    return console_;
  }
}

export default World;
