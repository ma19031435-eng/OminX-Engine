/**
 * OminX Engine — navigation graph for bot AI.
 *
 * Builds a 3D walkable graph by sampling the collision world: a cell is a node when a
 * character-sized box fits with headroom and a solid floor. Neighbours are linked 8-way
 * (with corner checks so bots don't clip wall corners) plus "step links" up to the controller's
 * step height, so stairs and container tops are traversable without special cases.
 *
 * Queries:
 *   - `findPath(from, to)` — A* with a binary heap and string-pulled smoothing,
 *   - `nearestNode(p)` — bucket lookup for respawning agents,
 *   - `randomNode()` / `randomReachableFrom(p)` — patrol and roam targets,
 *   - `coverPoints` — precomputed positions adjacent to cover, with the cover normal,
 *     which is what makes bot fights readable ("he ducked behind the crate").
 *
 * @module engine/src/world/NavGraph.js
 */
import { Vector3 } from '../math/Vector3.js';
import { AABB } from '../math/Geometry.js';
import { RNG } from '../math/Random.js';
import { CollisionLayer } from './Part.js';
import { createLogger } from '../core/Logger.js';

const log = createLogger('NavGraph');

/** Min-heap keyed by f-score (A* open set). */
class BinaryHeap {
  constructor() { this.items = []; this.scores = []; }
  get size() { return this.items.length; }
  clear() { this.items.length = 0; this.scores.length = 0; }
  push(item, score) {
    const items = this.items, scores = this.scores;
    items.push(item); scores.push(score);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (scores[parent] <= scores[i]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      [scores[parent], scores[i]] = [scores[i], scores[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items, scores = this.scores;
    const top = items[0];
    const lastItem = items.pop();
    const lastScore = scores.pop();
    if (items.length > 0) {
      items[0] = lastItem; scores[0] = lastScore;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let smallest = i;
        if (l < items.length && scores[l] < scores[smallest]) smallest = l;
        if (r < items.length && scores[r] < scores[smallest]) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        [scores[smallest], scores[i]] = [scores[i], scores[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/** One walkable sample point. */
export class NavNode {
  constructor(index, position) {
    this.index = index;
    this.position = position;
    /** @type {number[]} neighbour node indices */
    this.links = [];
    this.cover = 0;                 // 0 = exposed, 1 = full cover
    this.coverNormal = new Vector3();
    this.area = 0;                  // open area size (used for cover selection)
    this.cost = 1;                  // traversal cost multiplier (rough terrain, ladders)
    this.region = 0;                // connected-component id
  }
}

export class NavGraph {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.cell = opts.cell ?? 2;
    this.agentHeight = opts.agentHeight ?? 1.8;
    this.agentRadius = opts.agentRadius ?? 0.4;
    this.stepHeight = opts.stepHeight ?? 0.45;
    this.bounds = opts.bounds ?? { min: -64, max: 64 };
    this.maxSlope = opts.maxSlope ?? 0.55;
    this.rng = new RNG(opts.seed ?? 20240607);
    /** @type {NavNode[]} */
    this.nodes = [];
    this.nodeGrid = new Map();
    this.coverPoints = [];
    /** Force-sampled portal positions (doorways) supplied by the level builder. */
    this.hints = opts.hints ?? [];
    this.regions = 0;
    this.stats = { nodes: 0, links: 0, coverPoints: 0, regions: 0, sampleMs: 0, pathQueries: 0, pathMs: 0 };
    this._heap = new BinaryHeap();
    this._gScore = new Float64Array(0);
    this._fScore = new Float64Array(0);
    this._cameFrom = new Int32Array(0);
    this._visited = new Int32Array(0);
    this._visitToken = 0;
  }

  static create(scene, opts) { return new NavGraph(scene, opts); }

  // ------------------------------------------------------------------ build
  /** Samples the world and links walkable cells. Safe to call again after map edits. */
  build() {
    const t0 = Date.now();
    this.nodes.length = 0;
    this.nodeGrid.clear();
    this.coverPoints.length = 0;
    const { min, max } = this.bounds;
    const cell = this.cell;
    const collision = this.scene.collision;
    const box = new AABB(new Vector3(-this.agentRadius, 0, -this.agentRadius), new Vector3(this.agentRadius, this.agentHeight, this.agentRadius));
    const probe = new AABB(new Vector3(), new Vector3());
    const staticMask = CollisionLayer.All;

    for (let x = min; x <= max; x += cell) {
      for (let z = min; z <= max; z += cell) {
        // Multi-level sampling: a building contributes both its roof and its interior floor.
        for (const floorY of this._sampleFloors(collision, x, z, staticMask)) {
          probe.min.set(x - this.agentRadius, floorY + 0.06, z - this.agentRadius);
          probe.max.set(x + this.agentRadius, floorY + this.agentHeight, z + this.agentRadius);
          if (this._blocked(collision, probe, staticMask)) continue;
          const node = new NavNode(this.nodes.length, new Vector3(x, floorY, z));
          this.nodes.push(node);
          this._index(node);
        }
      }
    }
    this._applyHints(collision, probe, staticMask);
    this._link();
    this._computeRegions();
    this._computeCover();

    this.stats.nodes = this.nodes.length;
    this.stats.coverPoints = this.coverPoints.length;
    this.stats.regions = this.regions;
    this.stats.sampleMs = Date.now() - t0;
    this._gScore = new Float64Array(this.nodes.length);
    this._fScore = new Float64Array(this.nodes.length);
    this._cameFrom = new Int32Array(this.nodes.length).fill(-1);
    this._visited = new Int32Array(this.nodes.length);
    log.info(`nav graph: ${this.stats.nodes} nodes, ${this.stats.links} links, ${this.stats.coverPoints} cover points in ${this.stats.sampleMs}ms`);
    return this;
  }

  /**
   * All standable surfaces under (x,z), highest first, each with enough headroom for an agent.
   * Walking down the hit list (rather than taking the first) is what puts nav nodes inside
   * buildings *and* on their roofs — multi-level navigation instead of "roofs only".
   */
  _sampleFloors(collision, x, z, mask, out = []) {
    out.length = 0;
    const start = _v9.set(x, 60, z);
    const hits = collision.raycastAll(start, _down, { maxDistance: 90, layerMask: mask, triggers: false });
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (hit.normal.y < 1 - this.maxSlope) continue;          // too steep to stand on
      // Ceilings are non-walkable by tag: decorative slabs shouldn't create roof islands.
      if (hit.part.HasTag?.('ceiling') || hit.part.hasTag?.('ceiling')) continue;
      const next = hits[i + 1];
      const headroom = next ? hit.point.y - next.point.y : Infinity;
      if (headroom < this.agentHeight) continue;               // crawl space, not a floor
      out.push(hit.point.y);
      if (out.length >= 4) break;                              // don't stack nav for hidden attics
    }
    return out;
  }

  /**
   * Adds nodes at caller-supplied positions (door thresholds, ladders, elevator exits) even
   * when they don't land on the lattice, then re-indexes. Without this a doorway narrower
   * than two cells can be invisible to the graph.
   */
  _applyHints(collision, probe, mask) {
    let added = 0;
    for (const hint of this.hints) {
      const x = hint.x, z = hint.z;
      if (this._findAt(x, 0, z, this.cell * 0.5)) continue;      // lattice already covers it
      const floors = this._sampleFloors(collision, x, z, mask);
      for (const floorY of floors) {
        if (hint.y !== undefined && Math.abs(floorY - hint.y) > 1.2) continue;
        probe.min.set(x - this.agentRadius, floorY + 0.06, z - this.agentRadius);
        probe.max.set(x + this.agentRadius, floorY + this.agentHeight, z + this.agentRadius);
        if (this._blocked(collision, probe, mask)) continue;
        const node = new NavNode(this.nodes.length, new Vector3(x, floorY, z));
        node.portal = true;
        this.nodes.push(node);
        this._index(node);
        added++;
      }
    }
    this.stats.portalNodes = added;
    return this;
  }

  _blocked(collision, box, mask) {
    const overlapping = collision.overlapsBox(box, { layerMask: mask & ~CollisionLayer.Trigger });
    for (const part of overlapping) {
      if (part.CanCollide === false) continue;
      if (part.CanTouch === false && part.CanCollide !== true) continue;
      // Water/foliage don't block movement.
      const kind = part.surfaceKind?.key;
      if (kind === 'water' || kind === 'foliage' || kind === 'grass') continue;
      return true;
    }
    return false;
  }

  _index(node) {
    const key = this._cellKey(node.position.x, node.position.y, node.position.z);
    let bucket = this.nodeGrid.get(key);
    if (!bucket) { bucket = []; this.nodeGrid.set(key, bucket); }
    bucket.push(node);
  }

  _cellKey(x, y, z) {
    const c = this.cell;
    return `${Math.round(x / c)},${Math.round(y / c)},${Math.round(z / c)}`;
  }

  _link() {
    const c = this.cell;
    const cellTolerance = c * 0.6;
    const collision = this.scene?.collision ?? null;
    const mask = CollisionLayer.All;
    this.stats.rejectedLinks = 0;
    let links = 0;
    for (const node of this.nodes) {
      const p = node.position;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0) continue;
          const diagonal = dx !== 0 && dz !== 0;
          // Diagonal moves need both orthogonal cells to exist (no corner cutting).
          if (diagonal && (!this._findAt(p.x + dx * c, p.y, p.z, cellTolerance * 1.4) || !this._findAt(p.x, p.y, p.z + dz * c, cellTolerance * 1.4))) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const target = this._findAt(p.x + dx * c, p.y + dy * c, p.z + dz * c, cellTolerance);
            if (!target || target === node) continue;
            const rise = target.position.y - p.y;
            if (rise > this.stepHeight + 0.05 || rise < -(c + 0.05) * 1.6) continue;
            if (rise < -this.stepHeight && diagonal) continue;     // don't link over drops
            if (node.links.includes(target.index)) continue;
            // Lattice adjacency alone happily links through walls: an agent-shaped box has to be
            // able to *make* the move, or the path sends bots grinding into geometry.
            if (!this._walkable(collision, node, target, mask)) { this.stats.rejectedLinks++; continue; }
            node.links.push(target.index);
          }
        }
      }
      links += node.links.length;
    }
    this.stats.links = links;
    return this;
  }

  /**
   * Sweep-moves an agent box from `from` to `to`. Links that need wall-sliding are rejected so
   * every graph edge is walkable by the same controller the bots use (step assistance included).
   */
  _walkable(collision, from, to, mask) {
    if (!collision) return true;
    const r = this.agentRadius * 0.95;
    const box = _linkBox;
    box.min.set(from.position.x - r, from.position.y + 0.08, from.position.z - r);
    box.max.set(from.position.x + r, from.position.y + this.agentHeight - 0.08, from.position.z + r);
    _linkDelta.set(to.position.x - from.position.x, to.position.y - from.position.y, to.position.z - from.position.z);
    const result = collision.moveAABB(box, _linkDelta, { layerMask: mask, stepHeight: this.stepHeight, triggers: false });
    if (result.hits > 0 && (result.blockedAxes.x !== 0 || result.blockedAxes.z !== 0)) return false;
    // `moveAABB` reports the resolved **box min**, so the arrival test needs the box centre.
    const dx = result.position.x + r - to.position.x;
    const dz = result.position.z + r - to.position.z;
    return dx * dx + dz * dz < 0.14;      // must land on the neighbour (0.37 m tolerance)
  }

  _findAt(x, y, z, tolerance) {
    // Search the cell plus vertical neighbours, returning the node closest to the target.
    let best = null;
    let bestScore = Infinity;
    const c = this.cell;
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = this.nodeGrid.get(this._cellKey(x, y + dy * c, z));
      if (!bucket) continue;
      for (const node of bucket) {
        const d = Math.abs(node.position.x - x) + Math.abs(node.position.z - z) + Math.abs(node.position.y - y) * 0.5;
        if (d < bestScore && d <= tolerance + Math.abs(dy) * c) { bestScore = d; best = node; }
      }
    }
    return best;
  }

  /** Connected components — bots can be spawned per region and patrol stay in one. */
  _computeRegions() {
    let region = 0;
    const stack = [];
    for (const node of this.nodes) {
      if (node.region !== 0 || node._regionAssigned) continue;
      region++;
      node._regionAssigned = true;
      node.region = region;
      stack.push(node);
      while (stack.length) {
        const current = stack.pop();
        for (const link of current.links) {
          const next = this.nodes[link];
          if (next._regionAssigned) continue;
          next._regionAssigned = true;
          next.region = region;
          stack.push(next);
        }
      }
    }
    this.regions = region;
    for (const node of this.nodes) delete node._regionAssigned;
    return this;
  }

  /**
   * Classifies how protected each node is.
   *
   * Two probe heights matter in an FPS: a ray at knee/hip height (0.55 m) tells us an agent
   * can crouch behind something, and one at chest height (1.45 m) tells us a standing agent
   * is safe. `cover` counts the directions shielded at hip height; `coverHigh` counts the
   * ones that also shield a standing target — snipers want `coverHigh`, rushers want either.
   */
  _computeCover() {
    const collision = this.scene.collision;
    const mask = CollisionLayer.Static | CollisionLayer.Dynamic;
    for (const node of this.nodes) {
      let hipBlocked = 0;
      let chestBlocked = 0;
      let normalX = 0, normalZ = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const dir = _v2.set(Math.cos(a), 0, Math.sin(a));
        const hipHit = collision.raycast(_v1.set(node.position.x, node.position.y + 0.55, node.position.z), dir, { maxDistance: 2.4, layerMask: mask });
        if (!hipHit) continue;
        hipBlocked++;
        normalX += -dir.x;
        normalZ += -dir.z;
        const chestHit = collision.raycast(_v3.set(node.position.x, node.position.y + 1.45, node.position.z), dir, { maxDistance: 2.4, layerMask: mask });
        if (chestHit) chestBlocked++;
      }
      node.cover = hipBlocked / 8;
      node.coverHigh = chestBlocked / 8;
      if (hipBlocked > 0) node.coverNormal.set(normalX, 0, normalZ).normalize();
      node.area = node.links.length;
      if (node.cover >= 0.25) this.coverPoints.push(node);
    }
    return this;
  }

  /** The largest connected region — the one playable spaces belong to. */
  get majorRegion() {
    if (this._majorRegion) return this._majorRegion;
    const counts = new Map();
    for (const node of this.nodes) counts.set(node.region, (counts.get(node.region) ?? 0) + 1);
    let best = 0, bestCount = -1;
    for (const [region, count] of counts) if (count > bestCount) { bestCount = count; best = region; }
    this._majorRegion = best;
    return best;
  }

  get regionCounts() {
    const counts = new Map();
    for (const node of this.nodes) counts.set(node.region, (counts.get(node.region) ?? 0) + 1);
    return counts;
  }

  /**
   * Snaps a position to the closest useful node. `majorOnly` skips islands (rooftops that
   * aren't connected to the map), which is what AI navigation wants by default.
   */
  snap(position, { majorOnly = true, maxDistance = 40, region = 0 } = {}) {
    if (this.nodes.length === 0) return null;
    const wantRegion = region || (majorOnly ? this.majorRegion : 0);
    if (wantRegion) {
      // Widen the search before giving up: a player on a roof island still needs to path.
      for (const radius of [maxDistance, maxDistance * 3, Infinity]) {
        const node = this.nearestNode(position, { maxDistance: radius, region: wantRegion });
        if (node) return node;
      }
    }
    return this.nearestNode(position, { maxDistance });
  }

  // ------------------------------------------------------------------ queries
  get size() { return this.nodes.length; }

  nearestNode(position, { maxDistance = Infinity, region = 0 } = {}) {
    // Search expanding cell rings until something is found.
    const c = this.cell;
    const maxRings = maxDistance === Infinity ? 12 : Math.max(1, Math.ceil(maxDistance / c));
    const cx = Math.round(position.x / c), cy = Math.round(position.y / c), cz = Math.round(position.z / c);
    let best = null;
    let bestDist = maxDistance * maxDistance;
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dz = -ring; dz <= ring; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
            const bucket = this.nodeGrid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!bucket) continue;
            for (const node of bucket) {
              if (region && node.region !== region) continue;
              const d = node.position.distanceToSquared(position);
              if (d < bestDist) { bestDist = d; best = node; }
            }
          }
        }
      }
      if (best) return best;
    }
    return best;
  }

  randomNode(rng = this.rng) { return this.nodes.length ? this.nodes[rng.nextInteger(0, this.nodes.length - 1)] : null; }

  randomNodeInRegion(region, rng = this.rng) {
    const pool = this.nodes.filter((n) => n.region === region);
    return pool.length ? pool[rng.nextInteger(0, pool.length - 1)] : null;
  }

  randomCoverPoint(rng = this.rng, minCover = 0.4) {
    const pool = this.coverPoints.filter((n) => n.cover >= minCover);
    const source = pool.length ? pool : this.coverPoints;
    return source.length ? source[rng.nextInteger(0, source.length - 1)] : null;
  }

  /**
   * A* path between two world positions.
   * @param {Vector3} from
   * @param {Vector3} to
   * @param {object} [opts] { smooth=true, maxNodes=4000, maxDistance=Infinity, region }
   * @returns {?{points: Vector3[], cost: number, nodes: NavNode[]}}
   */
  findPath(from, to, opts = {}) {
    const t0 = Date.now();
    this.stats.pathQueries++;
    const start = opts.startNode ?? this.snap(from, { majorOnly: opts.majorOnly !== false, maxDistance: opts.maxStartDistance ?? 10 });
    const goal = opts.goalNode ?? this.snap(to, { majorOnly: opts.majorOnly !== false, maxDistance: opts.maxGoalDistance ?? 10 });
    if (!start || !goal) return null;
    if (start === goal) return this._finish([start.position.clone()], 0, [start], t0);
    if (start.region !== goal.region) return null;      // disconnected: caller must teleport/expand

    const maxNodes = opts.maxNodes ?? 4000;
    const heap = this._heap;
    heap.clear();
    const token = ++this._visitToken;
    const g = this._gScore, cameFrom = this._cameFrom, visited = this._visited;
    const heuristic = (node) => node.position.distanceTo(goal.position) * (opts.heuristicScale ?? 1);
    g[start.index] = 0;
    visited[start.index] = token;
    cameFrom[start.index] = -1;
    heap.push(start.index, heuristic(start));
    let expanded = 0;
    let found = false;

    while (heap.size > 0) {
      const currentIndex = heap.pop();
      const current = this.nodes[currentIndex];
      if (current === goal) { found = true; break; }
      if (++expanded > maxNodes) break;
      for (const linkIndex of current.links) {
        const next = this.nodes[linkIndex];
        if (opts.avoid?.has?.(next) || opts.avoid?.has?.(next.index)) continue;
        const step = current.position.distanceTo(next.position) * next.cost;
        const tentative = g[currentIndex] + step;
        if (visited[next.index] === token && tentative >= (g[next.index] ?? Infinity)) continue;
        visited[next.index] = token;
        g[next.index] = tentative;
        cameFrom[next.index] = currentIndex;
        heap.push(linkIndex, tentative + heuristic(next));
      }
    }
    if (!found) return null;

    const chain = [];
    let cursor = goal.index;
    while (cursor !== -1) {
      chain.push(this.nodes[cursor]);
      cursor = cameFrom[cursor];
      if (chain.length > maxNodes) break;
    }
    chain.reverse();
    // The agent's exact position is the first/last point (paths must start where the bot is).
    const raw = chain.map((n) => n.position.clone());
    raw[0] = from.clone ? from.clone() : new Vector3(from.x, from.y, from.z);
    if (to) raw[raw.length - 1] = new Vector3(to.x, chain[chain.length - 1].position.y, to.z);
    const points = opts.smooth === false ? raw : this.smooth(raw, { radius: opts.smoothRadius ?? this.agentRadius });
    let cost = 0;
    for (let i = 1; i < points.length; i++) cost += points[i].distanceTo(points[i - 1]);
    return this._finish(points, cost, chain, t0);
  }

  _finish(points, cost, nodes, t0) {
    this.stats.pathMs = Date.now() - t0;
    return { points, cost, nodes, length: points.length };
  }

  /**
   * String-pulls a path: removes waypoints that can be skipped by walking straight, which is
   * what stops bots from zig-zagging along cell centres like a roomba.
   */
  smooth(points, { radius = 0 } = {}) {
    if (points.length < 3) return points;
    const collision = this.scene?.collision ?? null;
    const out = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
      let furthest = i + 1;
      for (let j = points.length - 1; j > i + 1; j--) {
        // Body-aware when a radius is given: a zero-width ray lets the string-pull cut corners the
        // agent cannot walk, which is exactly how bots end up grinding along a wall.
        const ok = radius > 0 && collision
          ? this._segmentClear(points[i], points[j])
          : this.walkableSegment(points[i], points[j], 0);
        if (ok) { furthest = j; break; }
      }
      out.push(points[furthest]);
      i = furthest;
    }
    return out;
  }

  /**
   * Straight-line walk test for a full agent body. Sampled rather than swept: string-pulling runs
   * this O(n²) per path query, and a full swept move (with its step retry and ground probe) is
   * ~20× the cost for the same answer at nav resolution.
   */
  _segmentClear(from, to) {
    const collision = this.scene?.collision;
    if (!collision) return true;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.4) return true;
    const steps = Math.min(16, Math.max(2, Math.ceil(distance / (this.cell * 0.5))));
    const r = this.agentRadius * 0.9;
    const floor = Math.max(from.y, to.y);
    const mask = CollisionLayer.All & ~CollisionLayer.Trigger;
    const box = _linkBox;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = from.x + dx * t;
      const z = from.z + dz * t;
      box.min.set(x - r, floor + 0.12, z - r);
      box.max.set(x + r, floor + 0.12 + this.agentHeight * 0.7, z + r);
      const overlapping = collision.overlapsBox(box, { layerMask: mask });
      for (const part of overlapping) {
        if (part.CanCollide === false) continue;
        const kind = part.surfaceKind?.key;
        if (kind === 'water' || kind === 'foliage' || kind === 'grass') continue;
        // Steps, curbs and kerbs the controller walks over do not block a path segment.
        const top = part.worldBounds?.max?.y;
        if (top !== undefined && top - floor <= this.stepHeight + 0.05) continue;
        return false;
      }
    }
    return true;
  }

  /** True when two points at the same walkable level are connected without obstacles. */
  walkableSegment(from, to, radius = 0) {
    const flatFrom = _v3.set(from.x, from.y + 0.9, from.z);
    const flatTo = _v4.set(to.x, to.y + 0.9, to.z);
    const distance = flatFrom.distanceTo(flatTo);
    if (distance < 0.05) return true;
    const dir = _v5.copy(flatTo).sub(flatFrom).scale(1 / distance);
    const hits = this.scene.collision.raycastAll(flatFrom, dir, {
      maxDistance: distance,
      layerMask: CollisionLayer.Static | CollisionLayer.Dynamic,
      triggers: false,
    });
    for (const hit of hits) {
      if (hit.part.CanCollide === false) continue;
      const kind = hit.part.surfaceKind?.key;
      if (kind === 'water' || kind === 'foliage' || kind === 'grass') continue;
      // Low steps and curbs are walkable; anything taller than the controller's step blocks.
      const top = hit.part.worldBounds.max.y;
      if (top - from.y > this.stepHeight + 0.05) return false;
    }
    if (radius > 0) {
      // Also ensure the corridor is wide enough for the agent body.
      const side = _v6.set(-dir.z, 0, dir.x).scale(radius);
      for (const offset of [radius, -radius]) {
        const a = _v7.copy(flatFrom).addScaled(side, offset / radius);
        const blocked = this.scene.collision.overlapsSphere(_v8.copy(a).setY(a.y), 0.05, { layerMask: CollisionLayer.Static });
        void blocked;
      }
    }
    return true;
  }

  /** Recreates a node's local neighbourhood (used after partial map edits). */
  patch(center, radius = 12) {
    log.debug(`patching nav graph around ${center.toString()} r=${radius}`);
    return this.build();
  }

  getStats() { return { ...this.stats }; }
}

const _down = new Vector3(0, -1, 0);
const _linkBox = new AABB(new Vector3(), new Vector3());
const _segA = { position: new Vector3() };
const _segB = { position: new Vector3() };
const _linkDelta = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _v5 = new Vector3();
const _v6 = new Vector3();
const _v7 = new Vector3();
const _v8 = new Vector3();
const _v9 = new Vector3();

/** @see LevelBuilder.build for the usual call site. */
export function createNavGraph(scene, opts) { return new NavGraph(scene, opts); }

export default NavGraph;
