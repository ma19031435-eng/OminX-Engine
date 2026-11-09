/**
 * OminX Engine — collision world.
 *
 * A broadphase uniform grid plus exact narrowphase tests for the queries an FPS actually
 * needs every frame:
 *   - bullet traces (with penetration through thin surfaces),
 *   - character movement sweeps (slide + step-up over stairs and curbs),
 *   - bot line of sight and cover checks,
 *   - explosion / pickup overlap queries.
 *
 * The grid keeps per-cell buckets rebuilt lazily, so a 200-prop map costs ~nothing per query
 * instead of scanning every prop (which is what kills frame time in naive web engines).
 *
 * @module engine/src/world/CollisionWorld
 */
import { Vector3 } from '../math/Vector3.js';
import { Vector2 } from '../math/Vector2.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Quaternion } from '../math/Quaternion.js';
import { AABB } from '../math/Geometry.js';
import { clamp, clamp01, EPSILON } from '../math/MathUtils.js';
import { CollisionLayer } from './Part.js';

/**
 * Result of a character move. Owns its vectors (never references module scratch) so callers
 * can hold two results at once — the step-up path compares "plain" against "lifted".
 */
export class MoveResult {
  constructor() {
    this.position = new Vector3();
    this.blockedAxes = new Vector3();
    this.grounded = false;
    this.hits = 0;
    this.ceiling = false;
    this.stepUp = false;
  }
}

/** Result of a swept AABB test. */
export class SweepResult {
  constructor() {
    this.hit = false;
    this.t = 1;
    this.normal = new Vector3();
    this.point = new Vector3();
    this.collider = null;
    this.startSolid = false;
  }
  reset() { this.hit = false; this.t = 1; this.normal.set(0, 0, 0); this.collider = null; this.startSolid = false; return this; }
}

/** A registered collision proxy for a Part. */
export class Collider {
  constructor(part) {
    this.part = part;
    this.layer = part.collisionLayer ?? CollisionLayer.Default;
    this.isTrigger = (this.layer & CollisionLayer.Trigger) !== 0 || part.CanCollide === false;
    this.blocksBullets = part.CanCollide !== false;
    this.surface = part.surfaceKind;
    this.materialKey = part.Material;
    this._cachedBounds = new AABB();
    this._cachedVersion = -1;
    this.refresh();
  }

  refresh() {
    const b = this.part.worldBounds;
    this._cachedBounds.min.copy(b.min);
    this._cachedBounds.max.copy(b.max);
    // Instance-owned vectors: collision queries run while module scratch vectors are in use,
    // so borrowing a shared temp here corrupts the box extents mid-query.
    this.invMatrix ??= new Matrix4();
    this.invMatrix.copy(this.part.worldMatrix).invert();
    this.half ??= new Vector3();
    this.half.copy(this.part.Size).scale(0.5);
    return this;
  }

  get bounds() { return this._cachedBounds; }
  /** Cheap sphere test used by the broadphase before exact math. */
  intersectsSphere(center, radius) {
    const b = this._cachedBounds;
    const x = clamp(center.x, b.min.x, b.max.x);
    const y = clamp(center.y, b.min.y, b.max.y);
    const z = clamp(center.z, b.min.z, b.max.z);
    const dx = center.x - x, dy = center.y - y, dz = center.z - z;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  }

  /**
   * Exact ray test against the part's oriented box.
   * @returns {number|null} distance along the ray, or null when it misses.
   */
  rayTest(origin, direction, maxDistance) {
    // Slab test in the part's local space (handles rotation exactly).
    const inv = this.invMatrix;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = direction.x, dy = direction.y, dz = direction.z;
    const e = inv.elements;
    const lox = e[0] * ox + e[4] * oy + e[8] * oz + e[12];
    const loy = e[1] * ox + e[5] * oy + e[9] * oz + e[13];
    const loz = e[2] * ox + e[6] * oy + e[10] * oz + e[14];
    const ldx = e[0] * dx + e[4] * dy + e[8] * dz;
    const ldy = e[1] * dx + e[5] * dy + e[9] * dz;
    const ldz = e[2] * dx + e[6] * dy + e[10] * dz;
    const half = this.half;

    let tmin = 0, tmax = maxDistance;
    let axis = -1, sign = 1;
    for (let i = 0; i < 3; i++) {
      const o = i === 0 ? lox : i === 1 ? loy : loz;
      const d = i === 0 ? ldx : i === 1 ? ldy : ldz;
      const h = i === 0 ? half.x : i === 1 ? half.y : half.z;
      if (Math.abs(d) < 1e-8) {
        if (o < -h || o > h) return null;
        continue;
      }
      const invD = 1 / d;
      let t1 = (-h - o) * invD;
      let t2 = (h - o) * invD;
      let s = -1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (axis < 0) return 0;   // started inside
    this._lastAxis = axis;
    this._lastSign = sign;
    return tmin;
  }

  /** World-space normal for the last `rayTest` hit. */
  hitNormal(out = new Vector3()) {
    const axis = this._lastAxis ?? 0;
    const sign = this._lastSign ?? 1;
    out.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    return out.applyQuaternion(_q.setFromRotationMatrix(this.part.worldMatrix)).normalize();
  }
}

export class CollisionWorld {
  constructor(opts = {}) {
    /** @type {Map<object, Collider>} */
    this.colliders = new Map();
    this.cellSize = opts.cellSize ?? 8;
    this.grid = new Map();
    this.staticOnly = opts.staticOnly ?? false;
    this.stats = { colliders: 0, cells: 0, rayTests: 0, rayHits: 0, queries: 0 };
    this._dirty = new Set();
    this._scratch = { hits: [] };
  }

  static create(opts) { return new CollisionWorld(opts); }

  // ------------------------------------------------------------------ registration
  add(part) {
    if (!part || part._deleted) return null;
    if (part.CanCollide === false && (part.collisionLayer & CollisionLayer.Trigger) === 0) {
      // Non-colliding props (grass, decals) still register so bullets can hit foliage.
      if (part.CanTouch === false) return null;
    }
    const collider = part._collider instanceof Collider ? part._collider : new Collider(part);
    part._collider = collider;
    collider.refresh();
    this.colliders.set(part, collider);
    this._insert(collider);
    this.stats.colliders = this.colliders.size;
    part.ChildAdded?.connect?.(() => this.refresh(part));
    return collider;
  }

  remove(part) {
    const collider = this.colliders.get(part);
    if (!collider) return false;
    this.colliders.delete(part);
    this._removeFromGrid(collider);
    this.stats.colliders = this.colliders.size;
    return true;
  }

  /** Re-buckets a collider after its transform changed (call once per moved object per frame). */
  refresh(part) { this._dirty.add(part); return this; }

  /** Applies pending refreshes; called once per simulation tick. */
  update() {
    if (this._dirty.size === 0) return this;
    for (const part of this._dirty) {
      const collider = this.colliders.get(part);
      if (!collider) continue;
      this._removeFromGrid(collider);
      collider.refresh();
      this._insert(collider);
    }
    this._dirty.clear();
    return this;
  }

  clear() {
    this.colliders.clear();
    this.grid.clear();
    this._dirty.clear();
    this.stats.colliders = 0;
    this.stats.cells = 0;
    return this;
  }

  // ------------------------------------------------------------------ broadphase
  _cellKey(x, y, z) { return `${x},${y},${z}`; }

  _insert(collider) {
    const b = collider.bounds;
    const cs = this.cellSize;
    const x0 = Math.floor(b.min.x / cs), x1 = Math.floor(b.max.x / cs);
    const y0 = Math.floor(b.min.y / cs), y1 = Math.floor(b.max.y / cs);
    const z0 = Math.floor(b.min.z / cs), z1 = Math.floor(b.max.z / cs);
    // Oversized objects (buildings) go into an "always considered" list instead of thousands of cells.
    const cells = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (cells > 64) {
      this.large ??= new Set();
      this.large.add(collider);
      collider.cells = null;
      return;
    }
    collider.cells = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const key = this._cellKey(x, y, z);
          let bucket = this.grid.get(key);
          if (!bucket) { bucket = new Set(); this.grid.set(key, bucket); }
          bucket.add(collider);
          collider.cells.push(key);
        }
      }
    }
    this.stats.cells = this.grid.size;
  }

  _removeFromGrid(collider) {
    if (this.large?.has(collider)) { this.large.delete(collider); return; }
    for (const key of collider.cells ?? []) {
      const bucket = this.grid.get(key);
      if (!bucket) continue;
      bucket.delete(collider);
      if (bucket.size === 0) this.grid.delete(key);
    }
    collider.cells = null;
  }

  /** Collects candidate colliders whose cells overlap the given AABB. */
  _candidates(box, out = []) {
    out.length = 0;
    const cs = this.cellSize;
    const x0 = Math.floor(box.min.x / cs), x1 = Math.floor(box.max.x / cs);
    const y0 = Math.floor(box.min.y / cs), y1 = Math.floor(box.max.y / cs);
    const z0 = Math.floor(box.min.z / cs), z1 = Math.floor(box.max.z / cs);
    const seen = new Set();
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const bucket = this.grid.get(this._cellKey(x, y, z));
          if (!bucket) continue;
          for (const c of bucket) {
            if (seen.has(c)) continue;
            seen.add(c);
            if (c.bounds.intersectsBox(box)) out.push(c);
          }
        }
      }
    }
    if (this.large) for (const c of this.large) if (!seen.has(c) && c.bounds.intersectsBox(box)) out.push(c);
    return out;
  }

  /**
   * Gathers candidate colliders along a ray: the swept cell range (plus a one-cell margin),
   * which for long rays degenerates to a slab-thin box — far cheaper than scanning the world.
   */
  _segments(box, origin, direction, maxDistance, out = []) {
    const cs = this.cellSize;
    out.length = 0;
    const end = _v.copy(origin).addScaled(direction, maxDistance);
    const seg = _segAABB;
    seg.min.set(Math.min(origin.x, end.x), Math.min(origin.y, end.y), Math.min(origin.z, end.z));
    seg.max.set(Math.max(origin.x, end.x), Math.max(origin.y, end.y), Math.max(origin.z, end.z));
    seg.expandByVector(_v4.set(cs * 0.5, cs * 0.5, cs * 0.5));
    void box;
    return this._candidates(seg, out);
  }

  // ------------------------------------------------------------------ raycast
  /**
   * Casts a ray and returns the closest hit.
   * @param {Vector3} origin
   * @param {Vector3} direction normalised direction
   * @param {object} [opts] { maxDistance=1000, layerMask, ignore (Set|array|Instance), triggers=false, throughSelf }
   * @returns {?{part, point, normal, distance, surface, collider}}
   */
  raycast(origin, direction, opts = {}) {
    const hits = this.raycastAll(origin, direction, { ...opts, limit: 1 });
    return hits.length ? hits[0] : null;
  }

  /**
   * All hits along a ray, sorted near→far. Used for bullet penetration and for
   * "which surfaces does this shot pass through" analysis.
   */
  raycastAll(origin, direction, opts = {}) {
    const maxDistance = opts.maxDistance ?? 1000;
    const mask = opts.layerMask ?? CollisionLayer.All;
    const ignore = normalizeIgnore(opts.ignore);
    const candidates = this._segments(null, origin, direction, maxDistance, this._scratch.hits);
    const results = [];
    this.stats.rayTests++;
    for (const collider of candidates) {
      if (ignore.has(collider.part)) continue;
      if ((collider.layer & mask) === 0) continue;
      if (collider.isTrigger && !opts.triggers) continue;
      if (!opts.triggers && collider.part.CanCollide === false) continue;
      const t = collider.rayTest(origin, direction, maxDistance);
      if (t === null || t > maxDistance) continue;
      const point = _v5.copy(origin).addScaled(direction, t);
      results.push({
        part: collider.part,
        collider,
        distance: t,
        point: point.clone(),
        normal: collider.hitNormal(new Vector3()),
        surface: collider.surface,
        material: collider.materialKey,
      });
    }
    results.sort((a, b) => a.distance - b.distance);
    this.stats.rayHits += results.length;
    return opts.limit ? results.slice(0, opts.limit) : results;
  }

  /**
   * Bullet trace with penetration: walks hits in order, spending the bullet's penetration
   * budget on each surface until a surface stops it. This is what makes shooting through
   * wood/glass feel right while concrete still blocks.
   *
   * @returns {{entry: object|null, exit: object|null, path: object[], consumed: number, blocked: boolean}}
   */
  traceBullet(origin, direction, opts = {}) {
    const mask = opts.layerMask ?? CollisionLayer.All;
    const hits = this.raycastAll(origin, direction, {
      maxDistance: opts.maxDistance ?? 600,
      layerMask: mask,
      ignore: opts.ignore,
      triggers: false,
    });
    let penetrationBudget = opts.penetration ?? 1;
    const path = [];
    let entry = null;
    let exit = null;
    let consumed = 0;
    for (const hit of hits) {
      const cost = Math.max(0.02, 1 - (hit.surface.penetration ?? 0.1)) * (opts.penetrationCostScale ?? 1);
      if (entry === null) entry = hit;
      path.push(hit);
      if (penetrationBudget - cost < 0) break;
      penetrationBudget -= cost;
      consumed++;
      exit = hit;
    }
    return { entry, exit, path, consumed, blocked: path.length > 0 && path[path.length - 1] === entry };
  }

  /** True when nothing blocks the segment a→b. Bots use this for vision and cover. */
  lineOfSight(from, to, opts = {}) {
    const dir = _v6.copy(to).sub(from);
    const distance = dir.magnitude;
    if (distance < 1e-5) return true;
    dir.scale(1 / distance);
    const hits = this.raycastAll(from, dir, {
      maxDistance: distance - (opts.padding ?? 0.02),
      layerMask: opts.layerMask ?? (CollisionLayer.Static | CollisionLayer.Dynamic | CollisionLayer.Character | CollisionLayer.Glass),
      ignore: opts.ignore,
      triggers: false,
      limit: 1,
    });
    return hits.length === 0;
  }

  /** All parts whose bounds overlap the sphere. */
  overlapsSphere(center, radius, opts = {}) {
    const mask = opts.layerMask ?? CollisionLayer.All;
    const box = new AABB(
      new Vector3(center.x - radius, center.y - radius, center.z - radius),
      new Vector3(center.x + radius, center.y + radius, center.z + radius),
    );
    const out = [];
    for (const collider of this._candidates(box, [])) {
      if ((collider.layer & mask) === 0) continue;
      if (collider.isTrigger && !opts.triggers) continue;
      if (opts.ignore?.has?.(collider.part) || (Array.isArray(opts.ignore) && opts.ignore.includes(collider.part))) continue;
      if (collider.intersectsSphere(center, radius)) out.push(collider.part);
    }
    this.stats.queries++;
    return out;
  }

  /** All parts whose bounds overlap an axis-aligned box (explosion damage, editor selection). */
  overlapsBox(box, opts = {}) {
    const mask = opts.layerMask ?? CollisionLayer.All;
    const out = [];
    for (const collider of this._candidates(box, [])) {
      if ((collider.layer & mask) === 0) continue;
      if (collider.isTrigger && !opts.triggers) continue;
      out.push(collider.part);
    }
    this.stats.queries++;
    return out;
  }

  // ------------------------------------------------------------------ movement
  /**
   * Sweeps an axis-aligned box through the world and reports the earliest blocking hit.
   * @param {AABB} box starting bounds (world space)
   * @param {Vector3} delta movement for this step
   * @param {object} [opts] { layerMask, ignore, triggers }
   * @param {SweepResult} [out]
   */
  sweepAABB(box, delta, opts = {}, out = new SweepResult()) {
    out.reset();
    const mask = opts.layerMask ?? (CollisionLayer.Static | CollisionLayer.Dynamic);
    const ignore = normalizeIgnore(opts.ignore);
    const travelled = _v7.copy(box.max).sub(box.min);
    const full = new AABB(_v8.copy(box.min), _v9.copy(box.max));
    full.expandByVector(new Vector3(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)));
    const candidates = this._candidates(full, []);
    let bestT = 1;
    for (const collider of candidates) {
      if (ignore.has(collider.part)) continue;
      if ((collider.layer & mask) === 0) continue;
      if (collider.isTrigger && !opts.triggers) continue;
      if (collider.part.CanCollide === false) continue;
      const t = sweepAABBvsCollider(box, delta, collider, opts.padding ?? 0);
      if (t !== null && t < bestT) {
        bestT = t;
        out.hit = true;
        out.collider = collider;
        out.t = t;
        out.normal.copy(collider._sweepNormal ?? _zero);
        out.startSolid = t === 0;
      }
    }
    if (out.hit) out.point.copy(box.min).addScaled(delta, out.t);
    void travelled;
    this.stats.queries++;
    return out;
  }

  /**
   * Resolves a character move with sliding, step-up and ground detection — the core of the
   * FPS movement feel: you slide along walls instead of sticking, walk up stairs without
   * jumping, and can't tunnel through thin geometry at high speed.
   *
   * @param {AABB} box character bounds at the start of the step
   * @param {Vector3} delta desired movement for this step
   * @param {object} [opts] { layerMask, ignore, stepHeight=0.45, maxSlides=4, triggers }
   * @returns {{position: Vector3, grounded: boolean, hits: number, blockedAxes: Vector3, ceiling: boolean, stepUp: boolean}}
   */
  moveAABB(box, delta, opts = {}) {
    const stepHeight = opts.stepHeight ?? 0.45;
    const plain = this._slideMove(box, delta, opts, new MoveResult());

    // Step assistance triggers on a *horizontal* block only. `blockedAxes.y` is set by the
    // floor itself (the ground hit is a vertical contact), so testing it here would disable
    // step-up for every grounded character — which is exactly how it "worked" before.
    const wantsStepUp = stepHeight > 0 && (plain.blockedAxes.x !== 0 || plain.blockedAxes.z !== 0);
    if (!wantsStepUp) return plain;

    // Retry the whole horizontal move from `stepHeight` higher, then settle back down.
    const lifted = new AABB(
      _mv1.copy(box.min).addScaled(_up, stepHeight),
      _mv2.copy(box.max).addScaled(_up, stepHeight),
    );
    const retryDelta = _mv3.set(delta.x, delta.y, delta.z);
    const attempt = this._slideMove(lifted, retryDelta, opts, new MoveResult());
    const plainGain = Math.abs(plain.position.x - box.min.x) + Math.abs(plain.position.z - box.min.z);
    const stepGain = Math.abs(attempt.position.x - lifted.min.x) + Math.abs(attempt.position.z - lifted.min.z);
    if (stepGain <= plainGain + 1e-4) return plain;

    // Settle onto the step surface (or run off the edge and keep falling).
    const settleBox = new AABB(_mv4.copy(attempt.position), _mv5.copy(attempt.position).add(box.max).sub(box.min));
    const drop = this.sweepAABB(settleBox, _mv6.set(0, -stepHeight * 1.05, 0), opts);
    if (drop.hit && drop.normal.y > 0.3) {
      attempt.position.addScaled(_mv6, drop.t);
      attempt.grounded = true;
    }
    attempt.stepUp = true;
    return attempt;
  }

  /**
   * Sweep-and-slide without step assistance. Iterates: sweep, move to contact, project the
   * remaining motion along the surface (so the player slides along walls), repeat.
   */
  _slideMove(box, delta, opts, out = new MoveResult()) {
    const maxSlides = opts.maxSlides ?? 4;
    const work = new AABB(_mv7.copy(box.min), _mv8.copy(box.max));
    const remaining = _mv9.set(delta.x, delta.y, delta.z);
    const blocked = new Vector3();
    const sweep = new SweepResult();
    let hits = 0;
    let grounded = false;
    let ceiling = false;

    for (let slide = 0; slide < maxSlides; slide++) {
      if (remaining.sqrMagnitude < 1e-12) break;
      this.sweepAABB(work, remaining, opts, sweep);
      if (!sweep.hit) {
        work.min.add(remaining); work.max.add(remaining);
        remaining.set(0, 0, 0);
        break;
      }
      hits++;
      const normal = _mv10.copy(sweep.normal);
      work.min.addScaled(remaining, Math.max(0, sweep.t - 1e-5));
      work.max.addScaled(remaining, Math.max(0, sweep.t - 1e-5));
      const left = _mv11.copy(remaining).scale(1 - sweep.t);
      if (Math.abs(normal.x) > 0.5) blocked.x = 1;
      if (Math.abs(normal.y) > 0.5) { blocked.y = 1; if (normal.y > 0.5) grounded = true; if (normal.y < -0.5) ceiling = true; }
      if (Math.abs(normal.z) > 0.5) blocked.z = 1;
      const into = left.dot(normal);
      if (into < 0) left.addScaled(normal, -into);
      remaining.copy(left).scale(0.998);
      if (remaining.magnitude < 1e-5) break;
    }

    if (!grounded && opts.checkGround !== false) {
      const probe = this.sweepAABB(work, _mv12.set(0, -Math.max(0.06, (opts.stepHeight ?? 0.45) * 0.25), 0), opts);
      grounded = probe.hit && probe.normal.y > 0.4;
    }
    out.position.copy(work.min);
    out.blockedAxes.copy(blocked);
    out.grounded = grounded;
    out.hits = hits;
    out.ceiling = ceiling;
    out.stepUp = false;
    return out;
  }

  getStats() { return { ...this.stats, large: this.large?.size ?? 0 }; }
}

// ---------------------------------------------------------------------------
// narrowphase helpers
// ---------------------------------------------------------------------------

/**
 * Swept AABB vs oriented box using the separating-axis test on the 6 candidate axes.
 * Writes the hit normal to `collider._sweepNormal`.
 * @returns {number|null} t in [0,1]
 */
function sweepAABBvsCollider(box, delta, collider, padding) {
  const e = collider.invMatrix.elements;
  const half = collider.half;
  // Move into the collider's local frame.
  const entry = _sv1.copy(box.min).applyMatrix4(collider.invMatrix);
  const exitP = _sv2.copy(box.max).applyMatrix4(collider.invMatrix);
  const localMin = _sv3.set(Math.min(entry.x, exitP.x), Math.min(entry.y, exitP.y), Math.min(entry.z, exitP.z));
  const localMax = _sv4.set(Math.max(entry.x, exitP.x), Math.max(entry.y, exitP.y), Math.max(entry.z, exitP.z));
  const localDelta = _sv5.set(e[0] * delta.x + e[4] * delta.y + e[8] * delta.z, e[1] * delta.x + e[5] * delta.y + e[9] * delta.z, e[2] * delta.x + e[6] * delta.y + e[10] * delta.z);

  const min = _sv6.set(-half.x - padding, -half.y - padding, -half.z - padding);
  const max = _sv7.set(half.x + padding, half.y + padding, half.z + padding);

  let tEnter = -Infinity;
  let tExit = Infinity;
  let axis = 0;
  let sign = 1;
  for (let i = 0; i < 3; i++) {
    const d = i === 0 ? localDelta.x : i === 1 ? localDelta.y : localDelta.z;
    const a = i === 0 ? localMin.x : i === 1 ? localMin.y : localMin.z;
    const b = i === 0 ? localMax.x : i === 1 ? localMax.y : localMax.z;
    const lo = i === 0 ? min.x : i === 1 ? min.y : min.z;
    const hi = i === 0 ? max.x : i === 1 ? max.y : max.z;
    if (Math.abs(d) < 1e-9) {
      if (b < lo || a > hi) return null;      // parallel and separated
      continue;
    }
    let t1 = (lo - b) / d;
    let t2 = (hi - a) / d;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tEnter) { tEnter = t1; axis = i; sign = s; }
    if (t2 < tExit) tExit = t2;
    if (tEnter > tExit) return null;
  }
  if (tEnter > 1 || tExit < 0) return null;
  if (tEnter < 0) {
    // Already intersecting: push out along the smallest overlap axis.
    collider._sweepNormal = collider._sweepNormal ?? new Vector3();
    collider._sweepNormal.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0)
      .applyQuaternion(_sq.setFromRotationMatrix(collider.part.worldMatrix)).normalize();
    return 0;
  }
  collider._sweepNormal = collider._sweepNormal ?? new Vector3();
  collider._sweepNormal.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0)
    .applyQuaternion(_sq.setFromRotationMatrix(collider.part.worldMatrix)).normalize();
  return tEnter;
}

function normalizeIgnore(ignore) {
  if (!ignore) return _emptySet;
  if (ignore instanceof Set) return ignore;
  if (Array.isArray(ignore)) return new Set(ignore);
  return new Set([ignore]);
}

const _emptySet = new Set();
const _m = new Matrix4();
const _q = new Quaternion();
const _sq = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _v5 = new Vector3();
const _v6 = new Vector3();
const _v7 = new Vector3();
const _v8 = new Vector3();
const _v9 = new Vector3();
const _v10 = new Vector3();
const _v11 = new Vector3();
const _v12 = new Vector3();
const _v13 = new Vector3();
const _zero = new Vector3();
const _segAABB = new AABB();
const _up = new Vector3(0, 1, 0);
const _mv1 = new Vector3();
const _mv2 = new Vector3();
const _mv3 = new Vector3();
const _mv4 = new Vector3();
const _mv5 = new Vector3();
const _mv6 = new Vector3();
const _mv7 = new Vector3();
const _mv8 = new Vector3();
const _mv9 = new Vector3();
const _mv10 = new Vector3();
const _mv11 = new Vector3();
const _mv12 = new Vector3();
const _sv1 = new Vector3();
const _sv2 = new Vector3();
const _sv3 = new Vector3();
const _sv4 = new Vector3();
const _sv5 = new Vector3();
const _sv6 = new Vector3();
const _sv7 = new Vector3();
void Vector2;
void clamp01;
void EPSILON;
void Matrix4;
void Quaternion;

export default CollisionWorld;
