/**
 * OminX Engine — render list, culling, sorting and instanced batches.
 *
 * The renderer never walks the scene graph directly. Gameplay/editor code submits
 * `RenderItem`s (or `InstancedBatch`es) and the list handles frustum culling, distance
 * sorting, state sorting and static batching. For an FPS this is the difference between
 * 60 fps and 20 fps: a whole map's static geometry should collapse into a handful of
 * draws, while dynamic objects (players, bots, props, particles) stay separate.
 *
 * @module engine/renderer/RenderList
 */
import { Vector3 } from '../math/Vector3.js';
import { Matrix4 } from '../math/Matrix4.js';
import { AABB, Sphere } from '../math/Geometry.js';
import { RenderQueue } from './Material.js';

export const RenderLayer = {
  Default: 0,
  Skybox: 1,
  Terrain: 2,
  Static: 3,
  Dynamic: 4,
  ViewModel: 5,
  EditorGrid: 6,
  Gizmo: 7,
  Overlay: 8,
  /// Layers excluded from the main camera (rendered by the weapon/viewmodel camera).
  None: 9,
};

let _itemId = 0;

export class RenderItem {
  /**
   * @param {object} opts
   * @param {import('../geometry/Mesh.js').Mesh} opts.mesh
   * @param {import('./Material.js').Material} opts.material
   * @param {import('../math/Matrix4.js').Matrix4} [opts.matrix]
   * @param {number} [opts.layer]
   * @param {boolean} [opts.castShadow]
   * @param {boolean} [opts.receiveShadow]
   * @param {object} [opts.owner] instance that owns this item (editor picking)
   * @param {string} [opts.name]
   */
  constructor(opts = {}) {
    this.id = ++_itemId;
    this.mesh = opts.mesh;
    this.material = opts.material;
    this.matrix = opts.matrix ?? new Matrix4();
    this.matrixWorld = this.matrix;
    this.layer = opts.layer ?? RenderLayer.Dynamic;
    this.castShadow = opts.castShadow ?? true;
    this.receiveShadow = opts.receiveShadow ?? true;
    this.visible = opts.visible !== false;
    this.frustumCulled = opts.frustumCulled !== false;
    this.owner = opts.owner ?? null;
    this.name = opts.name ?? opts.mesh?.name ?? 'item';
    this.skinned = opts.skinned ?? false;
    this.boneMatrices = opts.boneMatrices ?? null;
    this.vertexColors = opts.vertexColors ?? false;
    this.distance = 0;
    this.screenSize = 0;
    this.bounds = opts.bounds ?? null;   // local-space AABB (from mesh if not given)
    this.worldBounds = opts.worldBounds ?? new AABB();
    this.sphere = new Sphere();
    this.userData = opts.userData ?? {};
    this.customUniforms = opts.customUniforms ?? null;
    /** Per-object overrides used by gameplay FX (damage flash, ghosting, team tint). */
    this.overrides = { tint: null, damageFlash: 0, opacity: null, emissiveScale: 1 };
    this.dirty = true;
  }

  static create(opts) { return new RenderItem(opts); }

  setMatrix(m) { this.matrix.copy(m); this.dirty = true; return this; }
  setPosition(x, y, z) {
    if (typeof x === 'object') this.matrix.setPosition(x);
    else this.matrix.setPosition(x, y, z);
    this.dirty = true;
    return this;
  }
  /** Recomputes world-space bounds for culling and sorting. */
  updateBounds(parentMatrix = null) {
    const src = parentMatrix ? _m4.multiplyMatrices(parentMatrix, this.matrix) : this.matrix;
    this.matrixWorld = src;
    const local = this.bounds ?? this.mesh?.bounds;
    if (local) {
      this.worldBounds.copy(local).applyMatrix4(src);
      const center = this.worldBounds.center(_v1);
      const extents = this.worldBounds.getExtents(_v2);
      this.sphere.center.copy(center);
      this.sphere.radius = extents.magnitude;
    }
    this.dirty = false;
    return this;
  }

  get stateKey() { return this.material?.stateKey ?? 0; }
  get queue() { return this.material?.queue ?? RenderQueue.Opaque; }
  get isTransparent() { return this.material?.isTransparent ?? false; }

  dispose() { this.visible = false; }
}

/**
 * InstancedBatch — one mesh + one material drawn N times with per-instance transforms.
 * This is how the engine renders forests, decal rings, tracer streaks, blood spatter and
 * particle quads in a single call.
 */
export class InstancedBatch {
  /**
   * @param {object} opts
   * @param {import('../geometry/Mesh.js').Mesh} opts.mesh
   * @param {import('./Material.js').Material} opts.material
   * @param {number} [opts.capacity=256]
   * @param {number} [opts.layer]
   */
  constructor(opts = {}) {
    this.id = ++_itemId;
    this.mesh = opts.mesh;
    this.material = opts.material;
    this.capacity = opts.capacity ?? 256;
    this.count = 0;
    this.layer = opts.layer ?? RenderLayer.Dynamic;
    this.matrix = new Matrix4();
    this.matrixWorld = this.matrix;
    this.visible = opts.visible !== false;
    this.frustumCulled = opts.frustumCulled !== false;
    this.castShadow = opts.castShadow ?? false;
    this.receiveShadow = opts.receiveShadow ?? false;
    this.owner = opts.owner ?? null;
    this.name = opts.name ?? `${this.mesh?.name ?? 'mesh'}#instanced`;
    this.dynamic = opts.dynamic !== false;
    this.vertexColors = opts.vertexColors ?? false;
    this.matrices = new Float32Array(this.capacity * 16);
    this.colors = new Float32Array(this.capacity * 4);
    this.params = new Float32Array(this.capacity * 4);
    this.worldBounds = new AABB();
    this.sphere = new Sphere();
    this.boundsDirty = true;
    this.distance = 0;
    this._scratch = new Matrix4();
  }

  static create(opts) { return new InstancedBatch(opts); }

  ensureCapacity(n) {
    if (n <= this.capacity) return this;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    const matrices = new Float32Array(cap * 16);
    matrices.set(this.matrices);
    const colors = new Float32Array(cap * 4);
    colors.set(this.colors);
    const params = new Float32Array(cap * 4);
    params.set(this.params);
    this.capacity = cap;
    this.matrices = matrices;
    this.colors = colors;
    this.params = params;
    return this;
  }

  clear() { this.count = 0; this.boundsDirty = true; return this; }

  /** @param {Matrix4} matrix @param {import('../math/Color3.js').Color3} [color] @param {number[]} [params] */
  add(matrix, color = null, params = null) {
    this.ensureCapacity(this.count + 1);
    const o = this.count * 16;
    const e = matrix.elements ?? matrix;
    for (let i = 0; i < 16; i++) this.matrices[o + i] = e[i];
    const c = this.count * 4;
    if (color) {
      this.colors[c] = color.r ?? color[0] ?? 1;
      this.colors[c + 1] = color.g ?? color[1] ?? 1;
      this.colors[c + 2] = color.b ?? color[2] ?? 1;
      this.colors[c + 3] = color.a ?? 1;
    } else {
      this.colors[c] = this.colors[c + 1] = this.colors[c + 2] = this.colors[c + 3] = 1;
    }
    if (params) {
      this.params[c] = params[0] ?? 0;
      this.params[c + 1] = params[1] ?? 0;
      this.params[c + 2] = params[2] ?? 0;
      this.params[c + 3] = params[3] ?? 0;
    }
    this.count++;
    this.boundsDirty = true;
    return this;
  }

  /**
   * Raw write with custom per-instance semantics. Effects (particles, tracers) interpret the
   * four instance vec4s directly rather than as a matrix, which avoids a CPU-side matrix
   * decompose per particle.
   */
  addRaw(m0, m1, m2, m3, color = null, params = null) {
    const index = this.count;
    this.ensureCapacity(index + 1);
    const o = index * 16;
    const write = (slot, v) => {
      const b = o + slot * 4;
      this.matrices[b] = v[0] ?? 0; this.matrices[b + 1] = v[1] ?? 0;
      this.matrices[b + 2] = v[2] ?? 0; this.matrices[b + 3] = v[3] ?? 0;
    };
    write(0, m0); write(1, m1); write(2, m2); write(3, m3);
    const c = index * 4;
    if (color) {
      this.colors[c] = color[0] ?? 1; this.colors[c + 1] = color[1] ?? 1;
      this.colors[c + 2] = color[2] ?? 1; this.colors[c + 3] = color[3] ?? 1;
    } else {
      this.colors[c] = this.colors[c + 1] = this.colors[c + 2] = this.colors[c + 3] = 1;
    }
    if (params) {
      this.params[c] = params[0] ?? 0; this.params[c + 1] = params[1] ?? 0;
      this.params[c + 2] = params[2] ?? 0; this.params[c + 3] = params[3] ?? 0;
    }
    this.count = index + 1;
    this.boundsDirty = true;
    return this;
  }

  setInstant(index, matrix, color = null, params = null) {
    if (index >= this.capacity) this.ensureCapacity(index + 1);
    const o = index * 16;
    const e = matrix.elements ?? matrix;
    for (let i = 0; i < 16; i++) this.matrices[o + i] = e[i];
    if (color) {
      const c = index * 4;
      this.colors[c] = color.r ?? 1; this.colors[c + 1] = color.g ?? 1;
      this.colors[c + 2] = color.b ?? 1; this.colors[c + 3] = color.a ?? 1;
    }
    if (params) {
      const c = index * 4;
      this.params[c] = params[0] ?? 0; this.params[c + 1] = params[1] ?? 0;
      this.params[c + 2] = params[2] ?? 0; this.params[c + 3] = params[3] ?? 0;
    }
    this.count = Math.max(this.count, index + 1);
    this.boundsDirty = true;
    return this;
  }

  updateBounds() {
    if (!this.boundsDirty) return this;
    const local = this.mesh?.bounds;
    this.worldBounds.makeEmpty();
    if (local) {
      const min = local.min, max = local.max;
      for (let i = 0; i < this.count; i++) {
        // Cheap: expand by the instance translation plus the local box extents.
        const o = i * 16;
        const tx = this.matrices[o + 12], ty = this.matrices[o + 13], tz = this.matrices[o + 14];
        this.worldBounds.expandByPoint(_v1.set(tx + min.x, ty + min.y, tz + min.z));
        this.worldBounds.expandByPoint(_v2.set(tx + max.x, ty + max.y, tz + max.z));
      }
    }
    if (this.worldBounds.isEmpty()) this.worldBounds.expandByPoint(_v1.set(0, 0, 0));
    const center = this.worldBounds.center(_v1);
    this.sphere.center.copy(center);
    this.sphere.radius = this.worldBounds.getExtents(_v2).magnitude;
    this.boundsDirty = false;
    return this;
  }

  get queue() { return this.material?.queue ?? RenderQueue.Opaque; }
  get isTransparent() { return this.material?.isTransparent ?? false; }
  get stateKey() { return this.material?.stateKey ?? 0; }
}

/**
 * RenderList — collects items, culls, sorts and produces the draw order for a frame.
 */
export class RenderList {
  constructor() {
    /** @type {RenderItem[]} */
    this.items = [];
    /** @type {InstancedBatch[]} */
    this.batches = [];
    this.visibleItems = [];
    this.visibleBatches = [];
    this.shadowCasters = [];
    this.stats = { submitted: 0, visible: 0, culled: 0, batches: 0, instancedTriangles: 0, drawCalls: 0 };
    this._opaque = [];
    this._cutout = [];
    this._transparent = [];
    this.sortMode = 'state';   // 'state' | 'distance' | 'none'
    this.autoBatching = true;
  }

  add(itemOrBatch) {
    if (itemOrBatch instanceof InstancedBatch) this.batches.push(itemOrBatch);
    else this.items.push(itemOrBatch);
    return itemOrBatch;
  }
  remove(item) {
    let i = this.items.indexOf(item);
    if (i >= 0) { this.items.splice(i, 1); return true; }
    i = this.batches.indexOf(item);
    if (i >= 0) { this.batches.splice(i, 1); return true; }
    return false;
  }
  removeByOwner(owner) {
    this.items = this.items.filter((it) => it.owner !== owner);
    this.batches = this.batches.filter((b) => b.owner !== owner);
    return this;
  }
  clear(disposeMaterials = false) {
    if (disposeMaterials) for (const it of this.items) it.dispose();
    this.items.length = 0;
    this.batches.length = 0;
    return this;
  }

  /**
   * Culls against the camera and sorts into opaque/cutout/transparent buckets.
   * @param {import('./Camera.js').Camera} camera
   * @param {object} [opts]
   * @param {number[]} [opts.layerMask] layers to include
   * @param {boolean} [opts.shadowPass=false]
   */
  prepare(camera, opts = {}) {
    const frustum = camera.frustum;
    const camPos = camera.worldPosition;
    const layerMask = opts.layerMask ?? null;
    this.visibleItems.length = 0;
    this.visibleBatches.length = 0;
    this._opaque.length = 0;
    this._cutout.length = 0;
    this._transparent.length = 0;
    this.shadowCasters.length = 0;
    let culled = 0;

    for (const item of this.items) {
      if (!item.visible || !item.mesh) { culled++; continue; }
      if (layerMask && !layerMask.includes(item.layer)) { culled++; continue; }
      if (item.material && item.material.opacity <= 0.001 && item.material.alphaMode !== 'additive') { culled++; continue; }
      if (item.dirty) item.updateBounds();
      if (item.frustumCulled) {
        const test = item.sphere.radius > 0 ? item.sphere : item.worldBounds;
        if (!frustum.intersectsObject(test)) { culled++; continue; }
      }
      const center = item.sphere.center;
      item.distance = center.distanceTo(camPos);
      this.visibleItems.push(item);
      if (item.castShadow && item.material?.castShadow !== false) this.shadowCasters.push(item);
      if (item.isTransparent) this._transparent.push(item);
      else if (item.material?.hasAlphaTest) this._cutout.push(item);
      else this._opaque.push(item);
    }

    for (const batch of this.batches) {
      if (!batch.visible || batch.count === 0) continue;
      if (layerMask && !layerMask.includes(batch.layer)) continue;
      if (batch.frustumCulled) {
        batch.updateBounds();
        if (!frustum.intersectsObject(batch.sphere)) { culled++; continue; }
      }
      batch.distance = batch.sphere.center.distanceTo(camPos);
      this.visibleBatches.push(batch);
      if (batch.castShadow && batch.material?.castShadow !== false) this.shadowCasters.push(batch);
      if (batch.isTransparent) this._transparent.push(batch);
      else if (batch.material?.hasAlphaTest) this._cutout.push(batch);
      else this._opaque.push(batch);
    }

    const sortByState = (a, b) => (a.queue - b.queue) || (a.stateKey - b.stateKey) || (a.mesh?.id - b.mesh?.id);
    const sortByDistance = (a, b) => a.distance - b.distance;

    this._opaque.sort(sortByState);
    this._cutout.sort(sortByState);
    // Transparent: state first (fewer state changes) then back-to-front within a state.
    this._transparent.sort((a, b) => (a.queue - b.queue) || (b.distance - a.distance) || (a.stateKey - b.stateKey));

    this.stats.submitted = this.items.length + this.batches.length;
    this.stats.visible = this.visibleItems.length + this.visibleBatches.length;
    this.stats.culled = culled;
    this.stats.batches = this.visibleBatches.length;
    if (opts.shadowPass) return { shadows: this.shadowCasters };
    return { opaque: this._opaque, cutout: this._cutout, transparent: this._transparent };
  }

  /**
   * Merges compatible static items into instanced batches. Call after the level has loaded
   * and whenever static geometry changes. Items are marked `baked` and skipped afterwards.
   * @param {number} [minCount=4] only batch groups with at least this many members
   */
  bakeStaticBatches(minCount = 4) {
    const groups = new Map();
    for (const item of this.items) {
      if (item.baked) continue;
      if (item.layer !== RenderLayer.Static && !item.userData.batchable) continue;
      if (item.material?.isTransparent) continue;
      const key = `${item.mesh.id}_${item.material?.stateKey}_${item.castShadow}`;
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(item);
    }
    const created = [];
    for (const [, group] of groups) {
      if (group.length < minCount) continue;
      const first = group[0];
      const batch = new InstancedBatch({
        mesh: first.mesh, material: first.material, capacity: group.length,
        layer: first.layer, castShadow: first.castShadow, receiveShadow: first.receiveShadow,
        name: `static_${first.mesh.name}`, vertexColors: first.vertexColors, dynamic: false,
      });
      for (const item of group) {
        batch.add(item.matrix);
        item.baked = true;
        item.visible = false;
      }
      this.batches.push(batch);
      created.push(batch);
    }
    return created;
  }

  /** Un-bakes static batches (editor edits invalidate them). */
  invalidateBatches() {
    for (const b of this.batches) {
      if (b.name?.startsWith('static_')) b.count = 0;
    }
    for (const it of this.items) if (it.baked) { it.baked = false; it.visible = true; }
    return this;
  }
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _m4 = new Matrix4();

export default RenderList;
