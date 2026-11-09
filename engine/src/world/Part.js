/**
 * OminX Engine — world parts.
 *
 * `Part` is the engine's `Instance` subclass that owns a transform, a shape, a material and
 * collision flags. Everything a level is made of — walls, crates, ramps, trigger volumes,
 * spawn pads, pickups — is a Part or a subclass, which means the editor, the physics query
 * layer, the save format and the network replicator all see the same object.
 *
 * @module engine/src/world/Part
 */
import { Instance } from '../core/Instance.js';
import { defineProperty, PropertyCategory, PropertyType } from '../core/Property.js';
import { Vector3 } from '../math/Vector3.js';
import { Color3 } from '../math/Color3.js';
import { Quaternion } from '../math/Quaternion.js';
import { Matrix4 } from '../math/Matrix4.js';
import { AABB, OBB } from '../math/Geometry.js';
import { DEG2RAD } from '../math/MathUtils.js';
import { createBox, createSphere, createCylinder, createWedge, createCapsule, createIcosphere } from '../geometry/Primitives.js';
import { PropLibrary, ColliderHint } from '../geometry/Props.js';

export const PartShape = {
  Box: 'Box',
  Sphere: 'Sphere',
  Cylinder: 'Cylinder',
  Wedge: 'Wedge',
  Capsule: 'Capsule',
  Mesh: 'Mesh',
};

/** Collision layers — cheap bitmask filtering for shooting, movement and AI queries. */
export const CollisionLayer = {
  Default: 1 << 0,
  Static: 1 << 1,
  Dynamic: 1 << 2,
  Character: 1 << 3,
  Projectile: 1 << 4,
  Trigger: 1 << 5,
  Glass: 1 << 6,
  Foliage: 1 << 7,
  Water: 1 << 8,
  All: 0xffff,
};

/**
 * Material keys → how bullets, footsteps and decals behave.
 * `penetration` is the fraction of a bullet's energy that carries through the surface
 * (see `CollisionWorld.traceBullet`); `density` (t/m³) drives part mass; `fragile` marks
 * surfaces that shatter instead of denting.
 */
export const SurfaceKind = {
  concrete: { key: 'concrete', penetration: 0.05, decal: 'Concrete', impact: 'impactConcrete', footstep: 'concrete', density: 2.4 },
  brick: { key: 'brick', penetration: 0.06, decal: 'Concrete', impact: 'impactConcrete', footstep: 'concrete', density: 1.9 },
  metal: { key: 'metal', penetration: 0.18, decal: 'Metal', impact: 'impactMetal', footstep: 'metal', density: 7.8 },
  wood: { key: 'wood', penetration: 0.45, decal: 'Wood', impact: 'impactWood', footstep: 'wood', density: 0.6 },
  sandbag: { key: 'sandbag', penetration: 0.02, decal: 'Sand', impact: 'impactSand', footstep: 'sand', density: 1.6 },
  dirt: { key: 'dirt', penetration: 0.08, decal: 'Sand', impact: 'impactDirt', footstep: 'dirt', density: 1.5 },
  sand: { key: 'sand', penetration: 0.08, decal: 'Sand', impact: 'impactDirt', footstep: 'sand', density: 1.6 },
  rock: { key: 'rock', penetration: 0.0, decal: 'Concrete', impact: 'impactConcrete', footstep: 'rock', density: 2.7 },
  grass: { key: 'grass', penetration: 0.1, decal: 'Sand', impact: 'impactDirt', footstep: 'grass', density: 1.2 },
  foliage: { key: 'foliage', penetration: 0.9, decal: 'Sand', impact: 'impactDirt', footstep: 'grass', density: 0.3 },
  glass: { key: 'glass', penetration: 0.95, decal: 'Glass', impact: 'impactGlass', footstep: 'glass', density: 2.5, fragile: true },
  rubber: { key: 'rubber', penetration: 0.0, decal: 'Concrete', impact: 'impactDirt', footstep: 'dirt', density: 1.1 },
  hazard: { key: 'hazard', penetration: 0.05, decal: 'Metal', impact: 'impactMetal', footstep: 'metal', density: 7.8 },
  skin: { key: 'skin', penetration: 0.0, decal: 'Flesh', impact: 'impactBlood', footstep: 'dirt', density: 1.0, character: true },
  water: { key: 'water', penetration: 1.0, decal: 'Blood', impact: 'waterSplash', footstep: 'water', density: 1.0 },
};

/** Material key → surface table entry (accepts aliases like `'Concrete'` or `'PlayerSkin'`). */
export function resolveSurfaceKind(material) {
  const key = String(material ?? 'concrete').toLowerCase();
  return SurfaceKind[key]
    ?? SurfaceKind[key.replace(/^character/, 'skin')]
    ?? SurfaceKind.concrete;
}

let _partId = 0;

export class Part extends Instance {
  static ClassName = 'Part';

  constructor(nameOrOpts, opts = {}) {
    super(nameOrOpts, opts);
    if (typeof nameOrOpts === 'object' && nameOrOpts !== null) opts = { ...nameOrOpts, ...opts };
    else if (this._name === this.constructor.ClassName) this._name = opts.Name ?? opts.name ?? `Part${++_partId}`;

    this._shape = opts.Shape ?? PartShape.Box;
    this._mesh = opts.Mesh ?? null;
    this._meshDirty = true;
    this._worldMatrix = new Matrix4();
    this._worldDirty = true;
    this._boundsDirty = true;
    this._localBounds = null;
    this._worldBounds = new AABB();
    this._collisionLayer = opts.CollisionLayer ?? (opts.Anchored === false ? CollisionLayer.Dynamic : CollisionLayer.Static);
    this._mass = opts.Mass ?? null;
    this.owner = opts.Owner ?? null;
    this._deleted = false;
    /** Extra tags consumed by gameplay: spawn, objective, ladder, ammo, ... */
    this.surface = null;
  }

  // ------------------------------------------------------------------ transform
  /**
   * Marks this part (and every descendant part) as needing a world-transform rebuild.
   * Called by the transform property setters and when the part is re-parented.
   */
  invalidateTransform() {
    this._worldDirty = true;
    this._boundsDirty = true;
    for (const child of this._children) if (child instanceof Part) child.invalidateTransform();
    return this;
  }

  get position() { return this.Position; }
  set position(v) { this.Position = v; }

  /** Local → world matrix, recomputed lazily. */
  get worldMatrix() {
    if (this._worldDirty || this.$parentDirty()) this._updateWorldMatrix(null);
    return this._worldMatrix;
  }
  $parentDirty() {
    const p = this.Parent;
    return p instanceof Part ? p._worldDirty : false;
  }

  _updateWorldMatrix(parentMatrix) {
    const position = this.Position;
    const quat = this.worldRotation;
    const matrix = this._worldMatrix;
    matrix.compose(position, quat, _one);
    if (parentMatrix) matrix.premultiply(parentMatrix);
    else if (this.Parent instanceof Part) matrix.premultiply(this.Parent.worldMatrix);
    this._worldDirty = false;
    return matrix;
  }

  get worldPosition() { return _v.setFromMatrixPosition(this.worldMatrix); }
  get worldRotation() {
    const r = this.Rotation;
    return _q.setFromEuler(r.x * DEG2RAD, r.y * DEG2RAD, r.z * DEG2RAD, this.RotationOrder ?? 'XYZ');
  }
  get forward() { return Vector3.new(0, 0, -1).applyQuaternion(this.worldRotation); }

  /** Axis-aligned bounds in world space (rotation-aware, cached until the transform moves). */
  get worldBounds() {
    if (this._worldDirty || this._boundsDirty) this._recomputeBounds();
    return this._worldBounds;
  }
  get localBounds() {
    if (!this._localBounds) {
      const half = _v.copy(this.Size).scale(0.5);
      this._localBounds = new AABB(_v2.copy(half).scale(-1), _v3.copy(half));
    }
    return this._localBounds;
  }

  /**
   * World-space AABB of a rotated box: transform the 8 corners and take the extents.
   * Uses dedicated scratch vectors — `worldPosition`/`worldRotation` hand out shared temps,
   * so mixing them here corrupts the half-extents mid-loop.
   */
  _recomputeBounds() {
    const half = _bHalf.copy(this.Size).scale(0.5);
    const rot = _bRot.copy(this.worldRotation);
    const e = this.worldMatrix.elements;
    const px = e[12], py = e[13], pz = e[14];
    const min = _bMin.set(Infinity, Infinity, Infinity);
    const max = _bMax.set(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < 8; i++) {
      const corner = _bCorner.set(
        (i & 1 ? half.x : -half.x),
        (i & 2 ? half.y : -half.y),
        (i & 4 ? half.z : -half.z),
      ).applyQuaternion(rot);
      corner.x += px; corner.y += py; corner.z += pz;
      min.min(corner);
      max.max(corner);
    }
    this._worldBounds.set(min, max);
    this._boundsDirty = false;
    return this._worldBounds;
  }

  // ------------------------------------------------------------------ geometry
  get shape() { return this._shape; }
  set shape(value) { this._shape = value; this._meshDirty = true; this._localBounds = null; this.invalidateMesh(); return this; }

  /** The renderable mesh for this part (generated from `Shape` + `Size`, or an explicit mesh). */
  get mesh() {
    if (this._mesh) return this._mesh;
    if (this._meshDirty) {
      this._mesh = this._buildShapeMesh();
      this._meshDirty = false;
    }
    return this._mesh;
  }
  set mesh(m) { this._mesh = m; this._meshDirty = false; return this; }

  invalidateMesh() { this._meshDirty = true; this._mesh = this._meshExplicit ?? null; return this; }

  _buildShapeMesh() {
    const size = this.Size;
    switch (this._shape) {
      case PartShape.Sphere: return createSphere(Math.max(size.x, size.y, size.z) * 0.5, 20, 14);
      case PartShape.Cylinder: return createCylinder(size.x * 0.5, size.z * 0.5, size.y, 18);
      case PartShape.Capsule: return createCapsule(size.x * 0.5, Math.max(0, size.y - size.x), 8, 16);
      case PartShape.Wedge: return createWedge(size.x, size.y, size.z);
      case PartShape.Mesh: return createIcosphere(0.5, 1);
      case PartShape.Box:
      default: return createBox(size.x, size.y, size.z);
    }
  }

  /** Oriented bounding box for precise collision queries (cached, refreshed on demand). */
  get obb() {
    const size = this.Size;
    if (!this._obb) this._obb = new OBB(this.worldPosition.clone(), size.clone().scale(0.5), this.worldRotation.clone());
    else {
      this._obb.center.copy(this.worldPosition);
      this._obb.halfExtents.copy(size).scale(0.5);
      if (!this._obb.rotation) this._obb.rotation = new Quaternion();
      this._obb.rotation.copy(this.worldRotation);
    }
    this._obb.update();
    return this._obb;
  }

  get collisionLayer() { return this._collisionLayer; }
  set collisionLayer(layer) { this._collisionLayer = layer; return this; }
  hasLayer(layer) { return (this._collisionLayer & layer) !== 0; }

  /** Effective surface data (penetration, decal kind, footsteps). */
  get surfaceKind() {
    return resolveSurfaceKind(this.Material);
  }
  get mass() {
    if (this._mass !== null) return this._mass;
    const size = this.Size;
    return Math.max(0.05, size.x * size.y * size.z * (this.surfaceKind.density ?? 1) * 90);
  }
  set mass(v) { this._mass = v; return this; }

  /** Roughly how much cover this part gives a 1.8 m character (feeds bot AI). */
  get coverValue() {
    const h = this.worldBounds.max.y - this.worldBounds.min.y;
    if (h < 0.8 || this.Size.x < 0.6 || this.Transparency > 0.6) return 0;
    return h >= 1.7 ? 1 : 0.55;
  }

  // ------------------------------------------------------------------ integration
  /** Submits this part to the renderer (used by the runtime and the editor viewport). */
  submit(renderer, materialName = null) {
    const material = renderer.materials.resolve(materialName ?? this.Material ?? 'concrete');
    const item = renderer.addMesh(this.mesh, material, this.worldMatrix, {
      castShadow: this.CastShadow,
      receiveShadow: this.ReceiveShadow,
      layer: this.Anchored ? 2 /* RenderLayer.Static */ : 3 /* RenderLayer.Dynamic */,
      owner: this,
      name: this.Name,
      userData: { part: this },
    });
    if (this.Color && (this.Color.r !== 1 || this.Color.g !== 1 || this.Color.b !== 1)) {
      item.overrides.tint = [this.Color.r, this.Color.g, this.Color.b];
    }
    if (this.Transparency > 0) item.overrides.opacity = 1 - this.Transparency;
    return item;
  }

  /** Server-side bookkeeping when the part leaves the world. */
  destroy() {
    this._deleted = true;
    return super.destroy();
  }

  toJSON() {
    const json = super.toJSON();
    json.shape = this._shape;
    json.collisionLayer = this._collisionLayer;
    json.anchored = this.Anchored;
    return json;
  }
}

// ---------------------------------------------------------------- properties
defineProperty(Part, 'Position', { type: PropertyType.Vector3, category: PropertyCategory.Transform, default: new Vector3(), onChanged: (i) => i.invalidateTransform() });
defineProperty(Part, 'Rotation', { type: PropertyType.Vector3, category: PropertyCategory.Transform, default: new Vector3(), unit: 'deg', onChanged: (i) => i.invalidateTransform() });
defineProperty(Part, 'RotationOrder', { type: PropertyType.String, category: PropertyCategory.Transform, default: 'XYZ', enum: ['XYZ', 'YXZ', 'ZXY', 'ZYX'], onChanged: (i) => i.invalidateTransform() });
defineProperty(Part, 'Size', { type: PropertyType.Vector3, category: PropertyCategory.Transform, default: new Vector3(2, 2, 2), min: 0.01, unit: 'm', onChanged: (i) => { i._localBounds = null; i._meshDirty = true; i._meshExplicit = null; i.invalidateTransform(); } });
defineProperty(Part, 'Anchored', { type: PropertyType.Boolean, category: PropertyCategory.Physics, default: true, tooltip: 'Static geometry: never simulated, always collidable.' });
defineProperty(Part, 'CanCollide', { type: PropertyType.Boolean, category: PropertyCategory.Physics, default: true });
defineProperty(Part, 'CanTouch', { type: PropertyType.Boolean, category: PropertyCategory.Physics, default: true });
defineProperty(Part, 'Mass', { type: PropertyType.Float, category: PropertyCategory.Physics, default: null, min: 0 });
defineProperty(Part, 'Material', { type: PropertyType.String, category: PropertyCategory.Appearance, default: 'concrete', assetKind: 'material' });
defineProperty(Part, 'Color', { type: PropertyType.Color3, category: PropertyCategory.Appearance, default: Color3.fromCSS('#ffffff') });
defineProperty(Part, 'Transparency', { type: PropertyType.Float, category: PropertyCategory.Appearance, default: 0, min: 0, max: 1, clampMin: true, clampMax: true });
defineProperty(Part, 'CastShadow', { type: PropertyType.Boolean, category: PropertyCategory.Appearance, default: true });
defineProperty(Part, 'ReceiveShadow', { type: PropertyType.Boolean, category: PropertyCategory.Appearance, default: true });
defineProperty(Part, 'Reflectance', { type: PropertyType.Float, category: PropertyCategory.Appearance, default: 0, min: 0, max: 1 });
defineProperty(Part, 'Shape', { type: PropertyType.String, category: PropertyCategory.Appearance, default: PartShape.Box, enum: Object.values(PartShape), onChanged: (i) => { i._meshDirty = true; i._meshExplicit = null; } });
defineProperty(Part, 'Tags', { type: PropertyType.String, category: PropertyCategory.Data, multiline: true, hidden: true });

/** A part that renders a mesh from the prop/weapon/character libraries (props, foliage, debris). */
export class MeshPart extends Part {
  static ClassName = 'MeshPart';
  constructor(nameOrOpts, opts = {}) {
    super(nameOrOpts, opts);
    if (typeof nameOrOpts === 'object' && nameOrOpts !== null) opts = { ...nameOrOpts };
    this._mesh = opts.Mesh ?? null;
    this._meshDirty = false;
    if (this._mesh) {
      const size = this._mesh.bounds.size();
      if (!opts.Size) this.Size = size.x === 0 ? size.copy(_one) : size;
    }
    this._colliderHint = opts.ColliderHint ?? ColliderHint.Box;
    /** Name in the prop library, so the part can be rebuilt from a save file. */
    this.MeshSource = opts.MeshSource ?? null;
  }
  get mesh() {
    if (!this._mesh && this.MeshSource && PropLibrary[this.MeshSource]) {
      this._mesh = PropLibrary[this.MeshSource]().mesh;
    }
    return this._mesh ?? super.mesh;
  }
  get colliderHint() { return this._colliderHint; }

  toJSON() {
    const json = super.toJSON();
    json.meshSource = this.MeshSource ?? null;
    json.colliderHint = this._colliderHint;
    return json;
  }
}
defineProperty(MeshPart, 'MeshSource', { type: PropertyType.String, category: PropertyCategory.Appearance, default: null, assetKind: 'mesh' });

/**
 * Trigger volumes: pickups, capture points, hurt zones, doors. Never blocks movement or
 * bullets, but reports overlaps.
 */
export class TriggerPart extends Part {
  static ClassName = 'TriggerPart';
  constructor(nameOrOpts, opts = {}) {
    super(nameOrOpts, { ...opts, Anchored: true, CanCollide: false, Transparency: 1, CastShadow: false, ReceiveShadow: false });
    if (typeof nameOrOpts === 'object' && nameOrOpts !== null) opts = { ...nameOrOpts };
    this.CollisionLayer = CollisionLayer.Trigger;
    this.CollisionLayer_ = CollisionLayer.Trigger;
    this._collisionLayer = CollisionLayer.Trigger;
    this.triggerKind = opts.TriggerKind ?? 'generic';
    this.onEnter = null;
    this.onExit = null;
    this.occupants = new Set();
  }
  /** @returns {boolean} true when the set membership changed (enter/exit edge). */
  track(instance) {
    if (this.occupants.has(instance)) return false;
    this.occupants.add(instance);
    this.onEnter?.(instance, this);
    return true;
  }
  release(instance) {
    if (!this.occupants.delete(instance)) return false;
    this.onExit?.(instance, this);
    return true;
  }
}

/** Respawn pad / spawn point marker. */
export class SpawnPart extends TriggerPart {
  static ClassName = 'SpawnPart';
  constructor(nameOrOpts, opts = {}) {
    super(nameOrOpts, { ...opts, TriggerKind: 'spawn' });
    this.team = opts.Team ?? 'neutral';
    this.priority = opts.Priority ?? 1;
    this.addTag('spawn');
    if (this.team && this.team !== 'neutral') this.addTag(`spawn:${this.team}`);
  }
  /** Point a spawning player should stand at (pad centre, eyes above the pad). */
  getSpawnPoint() {
    const p = this.worldPosition;
    return new Vector3(p.x, this.worldBounds.max.y + 0.05, p.z);
  }
  get facing() { return Vector3.new(0, 0, -1).applyQuaternion(this.worldRotation); }
}
defineProperty(SpawnPart, 'Team', { type: PropertyType.String, category: PropertyCategory.Behaviour, default: 'neutral', enum: ['neutral', 'red', 'blue', 'attackers', 'defenders'] });
defineProperty(SpawnPart, 'Priority', { type: PropertyType.Float, category: PropertyCategory.Behaviour, default: 1, min: 0 });

/** Creates a Part from a prop-library definition (used by the level builder and the editor). */
export function partFromProp(propDefinition, position = null, opts = {}) {
  const def = typeof propDefinition === 'string' ? PropLibrary[propDefinition]?.() : propDefinition;
  if (!def) throw new Error(`partFromProp: unknown prop "${propDefinition}"`);
  const part = new MeshPart({
    Name: opts.Name ?? def.name,
    Mesh: def.mesh,
    Material: def.material,
    Position: position ?? new Vector3(),
    Rotation: opts.Rotation ?? new Vector3(),
    Anchored: def.static !== false,
    CastShadow: def.castShadow !== false,
    CanCollide: def.blocksBullets !== false,
    ColliderHint: typeof def.collider === 'string' ? def.collider : ColliderHint.Box,
  });
  part.Size = def.mesh.bounds.size().clone();
  part.MeshSource = def.name;
  part.definition = def;
  part.cover = def.cover ?? 0;
  part.blocksBullets = def.blocksBullets !== false;
  part.blocksVision = def.blocksVision !== false;
  part.destructible = !!def.destructible;
  part.health = def.health ?? null;
  for (const tag of def.tags ?? []) part.addTag(tag);
  if (opts.Team) part.Team = opts.Team;
  part._collisionLayer = def.blocksBullets === false && def.blocksVision === false
    ? (def.tags?.includes('climbable') ? CollisionLayer.Default : CollisionLayer.Trigger)
    : (def.static === false ? CollisionLayer.Dynamic : CollisionLayer.Static);
  return part;
}

const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
// Dedicated temps for bounds computation (never shared with public getters).
const _bHalf = new Vector3();
const _bRot = new Quaternion();
const _bCorner = new Vector3();
const _bMin = new Vector3();
const _bMax = new Vector3();
const _q = new Quaternion();
const _one = new Vector3(1, 1, 1);

// Make the world classes available to `Instance.new('Part')` and scene loading.
Instance.register(Part);
Instance.register(MeshPart);
Instance.register(TriggerPart);
Instance.register(SpawnPart);

export default Part;
