/**
 * OminX Engine — the scene graph root.
 *
 * A `Scene` owns the workspace, the collision world, the lighting rig and the fast tag
 * lookups that gameplay code uses constantly ("give me every spawn point for red", "which
 * crates are destructible"). It is also the save/load unit: a scene serialises to JSON that
 * the Studio editor can round-trip and the server can ship to clients.
 *
 * @module engine/src/world/Scene
 */
import { Instance, Folder } from '../core/Instance.js';
import { defineProperty, PropertyCategory, PropertyType } from '../core/Property.js';
import { Signal } from '../core/Signal.js';
import { createLogger } from '../core/Logger.js';
import { Vector3 } from '../math/Vector3.js';
import { Color3 } from '../math/Color3.js';
import { AABB } from '../math/Geometry.js';
import { clamp01 } from '../math/MathUtils.js';
import { CollisionWorld } from './CollisionWorld.js';
import { Part, SpawnPart, TriggerPart, partFromProp, CollisionLayer } from './Part.js';
import { PropLibrary } from '../geometry/Props.js';

const log = createLogger('Scene');

/** Scene file format version — bumped when the persisted shape changes. */
export const SCENE_FORMAT_VERSION = 3;

export class Scene extends Instance {
  static ClassName = 'Scene';

  /**
   * @param {object} [opts]
   * @param {string} [opts.Name]
   * @param {number} [opts.cellSize] collision broadphase cell size
   * @param {number} [opts.dayTime] sun position in hours (6 sunrise, 18 sunset)
   */
  constructor(opts = {}) {
    super('Scene', opts);
    this._name = opts.Name ?? 'Scene';

    /** The world: everything renderable and collidable lives here. */
    this.Workspace = new Folder({ Name: 'Workspace' });
    this.Workspace.setParent(this);
    this.Lighting = new Folder({ Name: 'Lighting' });
    this.Lighting.setParent(this);
    this.Teams = new Folder({ Name: 'Teams' });
    this.Teams.setParent(this);
    this.Players = new Folder({ Name: 'Players' });
    this.Players.setParent(this);
    this.Effects = new Folder({ Name: 'Effects' });
    this.Effects.setParent(this);

    this.collision = new CollisionWorld({ cellSize: opts.cellSize ?? 8 });
    // `Changed` is inherited from Instance (property-change signal); these are scene-level events.
    this.SceneChanged = new Signal('Scene.SceneChanged');
    this.PartAdded = new Signal('Scene.PartAdded');
    this.PartRemoved = new Signal('Scene.PartRemoved');

    /** Tag → Set<Instance>, maintained incrementally for O(1) gameplay lookups. */
    this._tagIndex = new Map();
    /** @type {Map<string, Set<Instance>>} */
    this._classNameIndex = new Map();

    this.stats = { parts: 0, colliders: 0, spawns: 0, triangles: 0, triggers: 0 };
    this.time = 0;
    this.tick = 0;
    this.name = opts.Name ?? 'Scene';
    this.environment = {
      dayTime: opts.dayTime ?? 10.5,
      timeScale: opts.timeScale ?? 0,
      fogColor: opts.fogColor ?? '#9db4c8',
      fogDensity: opts.fogDensity ?? 0.008,
      ambientIntensity: opts.ambientIntensity ?? 0.55,
      skyMode: opts.skyMode ?? 'procedural',
    };

    this.Workspace.ChildAdded.connect((child) => this._onWorkspaceChildAdded(child));
    this.Workspace.ChildRemoved.connect((child) => this._onWorkspaceChildRemoved(child));
  }

  static create(opts) { return new Scene(opts); }

  // ------------------------------------------------------------------ parts
  /**
   * Adds a part (or a tree of parts) to the workspace and registers it for collision.
   * @param {Part} part
   * @returns {Part}
   */
  addPart(part) {
    if (!(part instanceof Instance)) throw new TypeError('Scene.addPart expects a Part');
    part.setParent(this.Workspace);
    return part;
  }

  /** Spawns a prop from the library straight into the world. */
  spawnProp(propName, position, opts = {}) {
    const def = typeof propName === 'string' ? PropLibrary[propName]?.() : propName;
    if (!def) { log.warn(`unknown prop "${propName}"`); return null; }
    const part = partFromProp(def, position, opts);
    this.addPart(part);
    return part;
  }

  /** Creates an empty part (box by default) — the editor's "insert part" action. */
  createPart(opts = {}) {
    const part = new Part({ ...opts, Name: opts.Name ?? 'Part' });
    if (opts.Parent !== false) this.addPart(part);
    return part;
  }

  removePart(part) {
    if (!part) return false;
    part.destroy();
    return true;
  }

  _onWorkspaceChildAdded(child) {
    this._registerTree(child, true);
    this.SceneChanged.emit('added', child);
    this.PartAdded.emit(child);
  }
  _onWorkspaceChildRemoved(child) {
    this._registerTree(child, false);
    this.SceneChanged.emit('removed', child);
    this.PartRemoved.emit(child);
  }

  _registerTree(instance, add) {
    const isPart = instance instanceof Part;
    if (isPart) {
      if (add) {
        if (instance.CanCollide !== false || instance instanceof TriggerPart) instance._collider = this.collision.add(instance);
        this.stats.triangles += instance.mesh?.triangleCount ?? 0;
      } else {
        this.collision.remove(instance);
        this.stats.triangles = Math.max(0, this.stats.triangles - (instance.mesh?.triangleCount ?? 0));
      }
    }
    // Index tags + class names for fast gameplay lookups.
    for (const tag of instance.GetTags()) {
      let set = this._tagIndex.get(tag);
      if (!set) { set = new Set(); this._tagIndex.set(tag, set); }
      if (add) set.add(instance); else if (set.size) set.delete(instance);
    }
    const cls = instance.ClassName;
    let classSet = this._classNameIndex.get(cls);
    if (!classSet) { classSet = new Set(); this._classNameIndex.set(cls, classSet); }
    if (add) classSet.add(instance); else classSet.delete(instance);

    instance.AttributeChanged?.connect?.(() => this.SceneChanged.emit('attribute', instance));
    for (const child of instance.GetChildren()) this._registerTree(child, add);
  }

  /** Re-indexes a subtree after the editor changed its tags/class. */
  reindex(instance) {
    this._registerTree(instance, false);
    this._registerTree(instance, true);
    return this;
  }

  // ------------------------------------------------------------------ queries
  /** Every instance carrying a tag (spawn points, objectives, ammo crates). */
  getTagged(tag) { return [...(this._tagIndex.get(tag) ?? [])]; }
  /** Instances of a class name, e.g. `'SpawnPart'`, `'TriggerPart'`, `'MeshPart'`. */
  getByClassName(className) { return [...(this._classNameIndex.get(className) ?? [])]; }
  getParts() {
    const out = [];
    for (const set of this._classNameIndex.values()) for (const inst of set) if (inst instanceof Part) out.push(inst);
    return out;
  }

  getSpawnPoints(team = 'neutral') {
    const all = this.getByClassName('SpawnPart');
    const matching = all.filter((s) => s.team === team || s.team === 'neutral');
    return matching.length ? matching : all;
  }

  /**
   * Picks a spawn point. `avoid` (usually enemy positions) biases selection so players don't
   * spawn in front of a hostile — an FPS staple.
   */
  pickSpawnPoint(team = 'neutral', { avoid = [], minDistance = 12, rng = Math.random } = {}) {
    const points = this.getSpawnPoints(team);
    if (points.length === 0) return null;
    if (avoid.length === 0) return points[Math.floor(rng() * points.length)];
    let best = null;
    let bestScore = -Infinity;
    for (const point of points) {
      const p = point.getSpawnPoint();
      let score = point.priority ?? 1;
      for (const threat of avoid) {
        const d = p.distanceTo(threat.position ?? threat);
        score += Math.min(d, 40) * 0.25;
        if (d < minDistance) score -= 25;
      }
      score += rng() * 0.5;
      if (score > bestScore) { bestScore = score; best = point; }
    }
    return best;
  }

  /** World-space bounds of all static geometry (used for minimaps and bot patrol limits). */
  getBounds(target = new AABB()) {
    target.makeEmpty?.();
    let first = true;
    for (const part of this.getParts()) {
      const b = part.worldBounds;
      if (first) { target.min.copy(b.min); target.max.copy(b.max); first = false; }
      else { target.min.min(b.min); target.max.max(b.max); }
    }
    if (first) { target.min.set(-50, -1, -50); target.max.set(50, 20, 50); }
    return target;
  }

  // ------------------------------------------------------------------ collision passthroughs
  raycast(origin, direction, opts) { return this.collision.raycast(origin, direction, opts); }
  raycastAll(origin, direction, opts) { return this.collision.raycastAll(origin, direction, opts); }
  traceBullet(origin, direction, opts) { return this.collision.traceBullet(origin, direction, opts); }
  lineOfSight(from, to, opts) { return this.collision.lineOfSight(from, to, opts); }
  overlapsSphere(center, radius, opts) { return this.collision.overlapsSphere(center, radius, opts); }
  moveAABB(box, delta, opts) { return this.collision.moveAABB(box, delta, opts); }

  // ------------------------------------------------------------------ frame tick
  update(dt) {
    this.time += dt;
    this.tick++;
    this.collision.update();
    this.stats.parts = this.collision.stats.colliders;
    this.stats.colliders = this.collision.stats.colliders;
    return this;
  }

  // ------------------------------------------------------------------ environment
  /** Applies the scene's environment block to a renderer's lighting rig. */
  applyEnvironment(lights, sky = null) {
    lights.dayTime = this.environment.dayTime;
    lights.timeOfDaySpeed = this.environment.timeScale;
    lights.fogDensity = this.environment.fogDensity;
    lights.fogColor.copy(Color3.fromCSS(this.environment.fogColor));
    lights.ambientIntensity = this.environment.ambientIntensity;
    lights.updateSunFromTime();
    if (sky) { sky.mode = this.environment.skyMode; sky.syncWithLights(lights); }
    return this;
  }

  setTimeOfDay(hours) { this.environment.dayTime = ((hours % 24) + 24) % 24; return this; }

  // ------------------------------------------------------------------ persistence
  /** Serializes the scene (workspace + environment) to a plain object. */
  save({ pretty = false } = {}) {
    const workspace = this.Workspace.toJSON();
    const data = {
      format: 'ominx-scene',
      version: SCENE_FORMAT_VERSION,
      name: this.name,
      savedAt: new Date().toISOString(),
      environment: { ...this.environment },
      workspace,
    };
    return pretty ? JSON.stringify(data, null, 2) : data;
  }

  /** Rebuilds a scene from `save()` output (or a JSON string). */
  load(data) {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (!parsed || parsed.format !== 'ominx-scene') throw new Error('Scene.load: not an OminX scene file');
    for (const child of this.Workspace.GetChildren()) child.destroy();
    this._tagIndex.clear();
    this._classNameIndex.clear();
    this.collision.clear();
    this.name = parsed.name ?? this.name;
    Object.assign(this.environment, parsed.environment ?? {});
    const restored = Instance.fromJSON(parsed.workspace);
    for (const child of restored.GetChildren()) child.setParent(this.Workspace);
    this.stats.triangles = this.getParts().reduce((sum, p) => sum + (p.mesh?.triangleCount ?? 0), 0);
    log.info(`loaded scene "${this.name}" — ${this.stats.parts} parts, ${this.stats.triangles} triangles`);
    return this;
  }

  /** Deep-clones the workspace into another scene (editor: duplicate map). */
  cloneWorkspace(targetScene = this) {
    const json = this.Workspace.toJSON();
    const copy = Instance.fromJSON(json);
    for (const child of copy.GetChildren()) child.setParent(targetScene.Workspace);
    return targetScene;
  }

  getStats() {
    return {
      ...this.stats,
      collision: this.collision.getStats(),
      tags: this._tagIndex.size,
      classes: this._classNameIndex.size,
      spawns: this.getByClassName('SpawnPart').length,
    };
  }
}

defineProperty(Scene, 'Name', { type: PropertyType.String, category: PropertyCategory.Data, default: 'Scene' });
defineProperty(Scene, 'DayTime', { type: PropertyType.Float, category: PropertyCategory.Environment, default: 10.5, min: 0, max: 24, unit: 'h' });
defineProperty(Scene, 'TimeScale', { type: PropertyType.Float, category: PropertyCategory.Environment, default: 0, min: 0, unit: 'h/s' });
defineProperty(Scene, 'FogDensity', { type: PropertyType.Float, category: PropertyCategory.Environment, default: 0.008, min: 0, max: 0.06 });
defineProperty(Scene, 'AmbientIntensity', { type: PropertyType.Float, category: PropertyCategory.Environment, default: 0.55, min: 0, max: 2 });
defineProperty(Scene, 'SkyMode', { type: PropertyType.String, category: PropertyCategory.Environment, default: 'procedural', enum: ['procedural', 'cubemap', 'color', 'none'] });

/** Convenience: builds the standard empty FPS scene shape (floor + 2 spawn teams + lighting). */
export function createEmptyArena(opts = {}) {
  const scene = new Scene({ Name: opts.Name ?? 'Arena', ...opts });
  const size = opts.size ?? 60;
  const floor = new Part({
    Name: 'Floor',
    Position: new Vector3(0, -0.5, 0),
    Size: new Vector3(size, 1, size),
    Material: opts.floorMaterial ?? 'concrete',
    Anchored: true,
    CastShadow: false,
  });
  scene.addPart(floor);
  (scene.floor = floor);
  for (const team of ['red', 'blue']) {
    const pad = new SpawnPart({
      Name: `Spawn_${team}`,
      Position: new Vector3(team === 'red' ? -size * 0.35 : size * 0.35, 0.05, team === 'red' ? size * 0.35 : -size * 0.35),
      Size: new Vector3(2, 0.1, 2),
      Material: team === 'red' ? 'hazard' : 'metal',
      Team: team,
    });
    scene.addPart(pad);
  }
  return scene;
}

export default Scene;
