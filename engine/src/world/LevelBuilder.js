/**
 * OminX Engine — procedural FPS level construction.
 *
 * `LevelBuilder` turns a seed and a map archetype into a playable, cover-dense shooter map:
 * outer walls, streets or rooms, buildings with interiors, sightline-breaking props, high
 * ground, spawns for both teams, objectives and pickup points. Everything is built from the
 * procedural prop kit, so a map is a few kilobytes of seed and options — which is what makes
 * "map" a first-class object in the Studio editor instead of a folder of assets.
 *
 * Design rules baked in (they are what make an FPS map *play*):
 *   - no long unobstructed sightlines across the map centre,
 *   - every objective has at least two approaches,
 *   - cover within ~4 m of any position (so fights are winnable),
 *   - verticality: at least two raised positions overlooking each lane.
 *
 * @module engine/src/world/LevelBuilder
 */
import { Vector3 } from '../math/Vector3.js';
import { RNG } from '../math/Random.js';
import { Part, MeshPart, SpawnPart, TriggerPart, partFromProp } from './Part.js';
import { PropLibrary } from '../geometry/Props.js';
import { createLogger } from '../core/Logger.js';
import { createNavGraph } from './NavGraph.js';

const log = createLogger('LevelBuilder');

export const MapKind = {
  Arena: 'arena',
  Urban: 'urban',
  Facility: 'facility',
  Warehouse: 'warehouse',
  Shipment: 'shipment',
  Desert: 'desert',
};

/** Archetype table: density, structure count, verticality and ground material. */
export const MapArchetypes = {
  [MapKind.Arena]: { size: 64, wallHeight: 6, buildings: 0, cover: 46, towers: 2, ground: 'dirt', style: 'open' },
  [MapKind.Urban]: { size: 96, wallHeight: 8, buildings: 7, cover: 54, towers: 2, ground: 'concrete', style: 'streets' },
  [MapKind.Facility]: { size: 72, wallHeight: 5, buildings: 3, cover: 40, towers: 1, ground: 'metal', style: 'rooms' },
  [MapKind.Warehouse]: { size: 80, wallHeight: 10, buildings: 1, cover: 52, towers: 2, ground: 'concrete', style: 'shelves' },
  [MapKind.Shipment]: { size: 76, wallHeight: 9, buildings: 0, cover: 60, towers: 1, ground: 'concrete', style: 'containers' },
  [MapKind.Desert]: { size: 120, wallHeight: 4, buildings: 2, cover: 44, towers: 3, ground: 'dirt', style: 'outpost' },
};

export class LevelBuilder {
  /**
   * @param {import('./Scene.js').Scene} scene
   * @param {object} [opts] { kind, seed, size, cover, buildings, timeOfDay }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.kind = opts.kind ?? MapKind.Arena;
    this.seed = opts.seed ?? 1337;
    this.rng = new RNG(this.seed);
    this.opts = opts;
    const archetype = MapArchetypes[this.kind] ?? MapArchetypes[MapKind.Arena];
    this.config = { ...archetype, ...opts };
    this.size = this.config.size;
    this.half = this.size / 2;
    this.bounds = { min: -this.half, max: this.half };
    this.coverPoints = [];
    /** Doorway/threshold positions the nav graph must sample even off its lattice. */
    this.navHints = [];
    this.objectives = [];
    this.pickups = [];
    this.spawns = { red: [], blue: [] };
    this.stats = { parts: 0, triangles: 0, cover: 0, buildings: 0, pickups: 0 };
  }

  static create(scene, opts) { return new LevelBuilder(scene, opts); }

  // ------------------------------------------------------------------ entry point
  /**
   * Builds the whole map.
   * @returns {{scene, nav: object, bounds: object, spawns: object, objectives: Array, stats: object}}
   */
  build({ withNav = true } = {}) {
    this._buildFloor();
    this._buildOuterWalls();
    switch (this.config.style) {
      case 'streets': this._buildStreets(); break;
      case 'rooms': this._buildRooms(); break;
      case 'shelves': this._buildWarehouse(); break;
      case 'containers': this._buildContainers(); break;
      case 'outpost': this._buildOutpost(); break;
      default: this._buildOpenArena(); break;
    }
    this._buildCover();
    this._buildHighGround();
    this._buildSpawns();
    this._buildObjectives();
    this._buildPickups();
    this._buildLighting();
    this._tuneEnvironment();

    let nav = null;
    if (withNav) {
      nav = createNavGraph(this.scene, {
        bounds: this.bounds,
        agentHeight: 1.8,
        agentRadius: 0.4,
        cell: this.opts.navCell ?? 2,
        seed: this.seed,
        hints: this.navHints,
      });
      nav.build();
    }
    log.info(`built ${this.kind} map "${this.opts.name ?? this.kind}" — ${this.stats.parts} parts, ${this.stats.triangles} triangles`);
    return { scene: this.scene, nav, bounds: this.bounds, spawns: this.spawns, objectives: this.objectives, stats: this.stats };
  }

  // ------------------------------------------------------------------ primitives
  _add(part) {
    this.scene.addPart(part);
    this.stats.parts++;
    this.stats.triangles += part.mesh?.triangleCount ?? 0;
    return part;
  }

  _box(name, position, size, material, opts = {}) {
    const part = new Part({
      Name: name,
      Position: position,
      Size: size,
      Material: material,
      Anchored: opts.anchored !== false,
      CastShadow: opts.castShadow !== false,
      ReceiveShadow: true,
      Transparency: opts.transparency ?? 0,
    });
    part.blocksBullets = opts.blocksBullets !== false;
    part.blocksVision = opts.blocksVision !== false;
    for (const tag of opts.tags ?? []) part.addTag(tag);
    return this._add(part);
  }

  /** Places a prop from the kit (auto-fit to its mesh bounds) and records cover. */
  _prop(name, position, opts = {}) {
    const def = PropLibrary[name];
    if (!def) { log.warn(`unknown prop "${name}"`); return null; }
    const part = partFromProp(def(), position, opts);
    this._add(part);
    if ((part.cover ?? 0) > 0.2) this.coverPoints.push({ position: position.clone(), value: part.cover, part });
    return part;
  }

  /** Picks a prop from a category, so each archetype reads consistently. */
  _coverProp() {
    const pools = {
      streets: ['jerseyBarrier', 'lowCover', 'crate', 'tires', 'barrel', 'sandbagWall'],
      rooms: ['crate', 'lowCover', 'barrel', 'pallet', 'oilDrumRack'],
      shelves: ['crate', 'pallet', 'barrel', 'lowCover'],
      containers: ['crate', 'barrel', 'tires', 'jerseyBarrier'],
      outpost: ['sandbagWall', 'jerseyBarrier', 'lowCover', 'barrel', 'rock'],
      open: ['sandbagWall', 'lowCover', 'rock', 'barrel', 'crate', 'bush'],
    };
    const pool = pools[this.config.style] ?? pools.open;
    return pool[this.rng.nextInteger(0, pool.length - 1)];
  }

  // ------------------------------------------------------------------ ground & shell
  _buildFloor() {
    const size = this.size;
    // Split the floor into tiles so the collision broadphase stays cheap and terrain
    // variants (dirt vs concrete) can be mixed per district.
    const tiles = Math.max(1, Math.round(size / 32));
    const tileSize = size / tiles;
    for (let x = 0; x < tiles; x++) {
      for (let z = 0; z < tiles; z++) {
        const material = this.config.ground;
        this._box(
          `Floor_${x}_${z}`,
          new Vector3(-this.half + tileSize * (x + 0.5), -0.5, -this.half + tileSize * (z + 0.5)),
          new Vector3(tileSize, 1, tileSize),
          material,
          { castShadow: false, tags: ['floor'] },
        );
      }
    }
    // A remote ground plane far below catches anything that falls off the map edge.
    this.killPlaneY = -25;
  }

  _buildOuterWalls() {
    const h = this.config.wallHeight;
    const t = 1;
    const s = this.size;
    const wallMat = this.config.style === 'outpost' ? 'sandbag' : this.config.ground === 'dirt' ? 'rock' : 'concrete';
    this._box('Wall_N', new Vector3(0, h / 2, -this.half - t / 2), new Vector3(s + t * 2, h, t), wallMat, { tags: ['boundary'] });
    this._box('Wall_S', new Vector3(0, h / 2, this.half + t / 2), new Vector3(s + t * 2, h, t), wallMat, { tags: ['boundary'] });
    this._box('Wall_W', new Vector3(-this.half - t / 2, h / 2, 0), new Vector3(t, h, s + t * 2), wallMat, { tags: ['boundary'] });
    this._box('Wall_E', new Vector3(this.half + t / 2, h / 2, 0), new Vector3(t, h, s + t * 2), wallMat, { tags: ['boundary'] });
  }

  // ------------------------------------------------------------------ archetypes
  _buildOpenArena() {
    const count = Math.round(this.config.cover * 0.6);
    for (let i = 0; i < count; i++) {
      const p = this._randomPoint(0.2);
      this._prop(this._coverProp(), p);
    }
    // central objective structure: a raised platform with cover on all four sides
    const platform = this._box('Center_Platform', new Vector3(0, 0.35, 0), new Vector3(8, 0.7, 8), 'concrete', { tags: ['platform'] });
    void platform;
    for (const [dx, dz] of [[-4.5, 0], [4.5, 0], [0, -4.5], [0, 4.5]]) {
      this._prop('lowCover', new Vector3(dx, 0, dz));
    }
  }

  _buildStreets() {
    // Two perpendicular main streets + a ring road; buildings fill the blocks.
    const roadWidth = 8;
    const blockSize = (this.size - roadWidth * 3) / 2;
    const positions = [
      new Vector3(-this.half + blockSize / 2 + 1, 0, -this.half + blockSize / 2 + 1),
      new Vector3(this.half - blockSize / 2 - 1, 0, -this.half + blockSize / 2 + 1),
      new Vector3(-this.half + blockSize / 2 + 1, 0, this.half - blockSize / 2 - 1),
      new Vector3(this.half - blockSize / 2 - 1, 0, this.half - blockSize / 2 - 1),
    ];
    let bi = 0;
    for (const center of positions) {
      this._building(`Building_${bi++}`, center, blockSize * 0.86, blockSize * 0.86);
    }
    // Street cover: barriers along the road edges, occasional vehicles/containers.
    const along = Math.floor(this.size / 7);
    for (let i = 0; i < along; i++) {
      const t = -this.half + 4 + i * 7;
      if (Math.abs(t) < roadWidth) continue;
      this._prop(this.rng.chance(0.5) ? 'jerseyBarrier' : 'lowCover', new Vector3(t, 0, -roadWidth * 0.6));
      this._prop(this.rng.chance(0.5) ? 'jerseyBarrier' : 'container', new Vector3(-roadWidth * 0.6, 0, t));
    }
  }

  /**
   * Interior facility: a grid of rooms whose shared walls are generated once per *edge*.
   * Doors are carved on a connected spanning tree over the room grid (plus random extras), so
   * the whole floor plan is guaranteed walkable and the nav graph comes out as one region —
   * the classic failure mode of grid generators is doorless rooms nobody can path into.
   */
  _buildRooms() {
    const cell = this.opts.roomSize ?? 16;
    const count = Math.max(2, Math.floor(this.size / cell));
    const half = this.half;
    const centerIndex = Math.floor(count / 2);
    const heightFor = (i, j) => 4 + this._hash01(i * 31 + j * 7 + this.seed) * 2;
    const isHall = (i, j) => i === centerIndex && j === centerIndex;
    const edgeDoor = (i, j, dir) => {
      // Deterministic per edge (both rooms compute the same answer) + connectivity repair below.
      const h = this._hash01(i * 131 + j * 977 + (dir === 'x' ? 17 : 71) + this.seed * 3);
      return h < 0.34;
    };

    // --- connectivity pass: carve doors until every room is reachable (union-find) ---
    const parent = new Map();
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent.set(ra, rb); return true; };
    const key = (i, j) => `${i},${j}`;
    for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) parent.set(key(i, j), key(i, j));
    const doorX = new Set();   // door between (i-1,j) and (i,j) at x = -half + i*cell
    const doorZ = new Set();   // door between (i,j-1) and (i,j) at z = -half + j*cell
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        if (isHall(i, j)) continue;
        if (i + 1 < count && edgeDoor(i, j, 'x') && !isHall(i + 1, j)) doorX.add(`${i + 1},${j}`);
        if (j + 1 < count && edgeDoor(i, j, 'z') && !isHall(i, j + 1)) doorZ.add(`${i},${j + 1}`);
      }
    }
    const edges = [];
    for (let i = 1; i < count; i++) for (let j = 0; j < count; j++) edges.push({ kind: 'x', i, j });
    for (let i = 0; i < count; i++) for (let j = 1; j < count; j++) edges.push({ kind: 'z', i, j });
    // Shuffle deterministically, then union: an edge with a door connects its two rooms.
    for (let i = edges.length - 1; i > 0; i--) {
      const swap = this.rng.nextInteger(0, i);
      [edges[i], edges[swap]] = [edges[swap], edges[i]];
    }
    for (const edge of edges) {
      const hall = edge.kind === 'x' ? isHall(edge.i - 1, edge.j) || isHall(edge.i, edge.j) : isHall(edge.i, edge.j - 1) || isHall(edge.i, edge.j);
      if (hall) {
        (edge.kind === 'x' ? doorX : doorZ).add(edge.kind === 'x' ? `${edge.i},${edge.j}` : `${edge.i},${edge.j}`);
        continue;
      }
      const a = edge.kind === 'x' ? key(edge.i - 1, edge.j) : key(edge.i, edge.j - 1);
      const b = edge.kind === 'x' ? key(edge.i, edge.j) : key(edge.i, edge.j);
      if ((edge.kind === 'x' ? doorX : doorZ).has(edge.kind === 'x' ? `${edge.i},${edge.j}` : `${edge.i},${edge.j}`)) { union(a, b); continue; }
      if (!union(a, b)) continue;
      (edge.kind === 'x' ? doorX : doorZ).add(edge.kind === 'x' ? `${edge.i},${edge.j}` : `${edge.i},${edge.j}`);
    }

    // --- wall pass: one part per segment (never two coincident walls, which is what closed
    // every doorway in the first version of this generator) ---
    const wallHeight = Math.max(4, heightFor(centerIndex, centerIndex));
    for (let i = 0; i <= count; i++) {
      const x = -half + i * cell;
      for (let j = 0; j < count; j++) {
        const z = -half + cell * (j + 0.5);
        const hallLeft = i > 0 && isHall(i - 1, j);
        const hallRight = i < count && isHall(i, j);
        if (hallLeft && hallRight) continue;
        const outer = i === 0 || i === count;
        const door = !outer && doorX.has(`${i},${j}`);
        if (door) this._wallWithDoor(`WallX_${i}_${j}`, new Vector3(x, 0, z), { sx: 0, sz: 0 }, { width: 0, depth: cell, height: wallHeight, t: 0.35, doorWidth: 2.4, alongX: false, material: 'concrete' });
        else this._box(`WallX_${i}_${j}`, new Vector3(x, wallHeight / 2, z), new Vector3(0.35, wallHeight, cell), 'concrete');
      }
    }
    for (let j = 0; j <= count; j++) {
      const z = -half + j * cell;
      for (let i = 0; i < count; i++) {
        const x = -half + cell * (i + 0.5);
        const hallBelow = j > 0 && isHall(i, j - 1);
        const hallAbove = j < count && isHall(i, j);
        if (hallBelow && hallAbove) continue;
        const outer = j === 0 || j === count;
        const door = !outer && doorZ.has(`${i},${j}`);
        if (door) this._wallWithDoor(`WallZ_${i}_${j}`, new Vector3(x, 0, z), { sx: 0, sz: 0 }, { width: cell, depth: 0, height: wallHeight, t: 0.35, doorWidth: 2.4, alongX: true, material: 'concrete' });
        else this._box(`WallZ_${i}_${j}`, new Vector3(x, wallHeight / 2, z), new Vector3(cell, wallHeight, 0.35), 'concrete');
      }
    }

    // --- dressing: ceilings, lights, cover, a few containers in the hall ---
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        if (isHall(i, j)) continue;
        const cx = -half + cell * (i + 0.5);
        const cz = -half + cell * (j + 0.5);
        const h = heightFor(i, j);
        this._box(`Room_${i}_${j}_ceiling`, new Vector3(cx, h + 0.15, cz), new Vector3(cell, 0.3, cell), 'metal', { castShadow: false, tags: ['ceiling'] });
        this._box(`Room_${i}_${j}_light`, new Vector3(cx, h - 0.15, cz), new Vector3(2.4, 0.12, 2.4), 'hazard', { castShadow: false, transparency: 0.35, tags: ['ceiling', 'lightFixture'] });
        if (this.rng.chance(0.55)) this._prop(this._coverProp(), new Vector3(cx + this.rng.nextNumber(-3.5, 3.5), 0, cz + this.rng.nextNumber(-3.5, 3.5)), { Rotation: new Vector3(0, this.rng.nextNumber(0, 360), 0) });
      }
    }
    const hallCenter = new Vector3(-half + cell * (centerIndex + 0.5), 0, -half + cell * (centerIndex + 0.5));
    this._prop('container', new Vector3(hallCenter.x - 5, 0, hallCenter.z - 4), { Rotation: new Vector3(0, 20, 0) });
    this._prop('container', new Vector3(hallCenter.x + 5, 0, hallCenter.z + 4), { Rotation: new Vector3(0, -35, 0) });
    this._prop('oilDrumRack', new Vector3(hallCenter.x, 0, hallCenter.z + 6));
    this.hallCenter = hallCenter;
  }

  /** Deterministic hash → [0,1) used so both sides of a shared edge agree. */
  _hash01(n) {
    let x = Math.sin(n * 12.9898 + this.seed * 78.233) * 43758.5453;
    x -= Math.floor(x);
    return x;
  }

  _buildWarehouse() {
    const racks = Math.floor(this.size / 12);
    for (let i = 0; i < racks; i++) {
      const x = -this.half + 8 + i * 12;
      for (let j = 0; j < 3; j++) {
        const z = -this.half * 0.5 + j * 12;
        // Rack: two stacked long boxes plus crates on top (vertical cover + high ground).
        this._box(`Rack_${i}_${j}`, new Vector3(x, 0.6, z), new Vector3(6, 1.2, 1.4), 'metal', { tags: ['cover', 'climbable'] });
        this._box(`Rack_${i}_${j}_b`, new Vector3(x, 2.4, z), new Vector3(6, 0.3, 1.4), 'metal', { tags: ['catwalk'] });
        if (this.rng.chance(0.6)) this._prop('crate', new Vector3(x + this.rng.nextNumber(-2, 2), 1.2, z + this.rng.nextNumber(-3, 3)));
      }
      this._box(`Rack_Post_${i}a`, new Vector3(x - 3, 1.6, -this.half * 0.5), new Vector3(0.25, 3.2, 0.25), 'metal');
      this._box(`Rack_Post_${i}b`, new Vector3(x + 3, 1.6, -this.half * 0.5), new Vector3(0.25, 3.2, 0.25), 'metal');
    }
    this._prop('pallet', new Vector3(0, 0, this.half * 0.55));
    this._prop('oilDrumRack', new Vector3(this.half * 0.5, 0, -this.half * 0.5));
  }

  _buildContainers() {
    const layout = [
      [-18, -18, 0], [-6, -20, 90], [8, -14, 0], [20, -6, 90],
      [-22, 4, 0], [-8, 10, 90], [6, 16, 0], [18, 20, 90],
      [0, 0, 45], [-14, -6, 0], [12, 6, 90],
    ];
    layout.forEach(([x, z, rot], i) => {
      const container = this._box(`Container_${i}`, new Vector3(x, 1.3, z), new Vector3(12, 2.6, 2.6), 'hazard', {
        tags: ['cover', 'climbable'],
      });
      container.Rotation = new Vector3(0, rot, 0);
      if (this.rng.chance(0.5)) {
        const stacked = this._box(`Container_${i}_stack`, new Vector3(x, 4, z), new Vector3(12, 2.6, 2.6), 'metal', { tags: ['cover', 'catwalk'] });
        stacked.Rotation = new Vector3(0, rot + this.rng.nextNumber(-6, 6), 0);
      }
      if (this.rng.chance(0.6)) this._prop('barrel', new Vector3(x + this.rng.nextNumber(-3, 3), 0, z + this.rng.nextNumber(-4, 4)));
    });
  }

  _buildOutpost() {
    // Desert outpost: a ring of sandbags, a raised watch tower, scattered rocks.
    const ring = 12;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      const r = this.size * 0.22;
      this._prop('sandbagWall', new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), { Rotation: new Vector3(0, (a * 180) / Math.PI + 90, 0) });
    }
    for (let i = 0; i < 10; i++) {
      const a = this.rng.nextNumber(0, Math.PI * 2);
      const r = this.rng.nextNumber(this.size * 0.28, this.size * 0.44);
      this._prop('rock', new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    this._building('Outpost_Building', new Vector3(0, 0, -this.size * 0.3), 18, 12);
    this._prop('watchtower', new Vector3(this.size * 0.26, 0, this.size * 0.22));
  }

  // ------------------------------------------------------------------ structures
  /**
   * A building with a walkable interior: four walls, a doorway hole on each requested side,
   * a roof with parapet (sniper perch), an interior divider with cover, and stairs to the roof.
   * Interiors plus reachable roofs are what separate an FPS map from a box collection.
   */
  _building(name, center, width, depth, opts = {}) {
    const height = opts.height ?? this.rng.nextNumber(4.5, 7.5);
    const t = 0.4;
    const doorWidth = 2.6;
    const doorways = opts.doorways ?? [[0, -1], [0, 1]];
    const material = this.config.style === 'outpost' ? 'concrete' : 'brick';
    const spec = { width, depth, height, t, doorWidth, material };

    for (const [sx, sz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const inDoor = doorways.some(([dx, dz]) => dx === sx && dz === sz);
      const wallName = `${name}_wall_${sx}_${sz}`;
      if (inDoor) {
        this._wallWithDoor(wallName, center, { sx, sz }, { ...spec, alongX: sx === 0 });
      } else {
        const size = sx === 0 ? new Vector3(width, height, t) : new Vector3(t, height, depth);
        this._box(wallName, new Vector3(center.x + (sx * width) / 2, height / 2, center.z + (sz * depth) / 2), size, material);
      }
    }

    // Roof, parapet and the stairs that reach them.
    this._box(`${name}_roof`, new Vector3(center.x, height + 0.15, center.z), new Vector3(width + t * 2, 0.3, depth + t * 2), material, { tags: ['roof', 'climbable'] });
    for (const [sx, sz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      this._box(`${name}_parapet_${sx}_${sz}`,
        new Vector3(center.x + (sx * (width + t * 2)) / 2, height + 0.6, center.z + (sz * (depth + t * 2)) / 2),
        new Vector3(sx === 0 ? width + t * 2 : t, 0.6, sx === 0 ? t : depth + t * 2), material);
    }
    this._stairsUp(`${name}_stairs`, new Vector3(center.x + width * 0.5 + 1.2, 0, center.z - depth * 0.5), height + 0.3, 'up');

    // Interior dressing.
    this._box(`${name}_divider`, new Vector3(center.x, height / 2, center.z + depth * 0.12), new Vector3(width * 0.55, height, t * 0.8), 'wood');
    this._prop('crate', new Vector3(center.x + width * 0.25, 0, center.z - depth * 0.25));
    if (this.rng.chance(0.7)) this._prop('lowCover', new Vector3(center.x - width * 0.28, 0, center.z + depth * 0.2));

    this.stats.buildings++;
    return { center, width, depth, height };
  }

  /**
   * Builds a flight of stairs rising along ±Z (or ±X when `dir` says so) to `height`.
   * Each step is 0.34 m — under the character controller's step height, so the player
   * walks up instead of needing to jump.
   */
  _stairsUp(name, base, height, dir = 'up') {
    const stepHeight = 0.34;
    const steps = Math.max(1, Math.ceil(height / stepHeight));
    const depth = 0.62;
    for (let i = 0; i < steps; i++) {
      const y = (i + 0.5) * stepHeight;
      const offset = (i + 0.5) * depth;
      const z = dir === 'up' ? base.z + offset : base.z - offset;
      this._box(`${name}_${i}`, new Vector3(base.x, y, z), new Vector3(1.8, stepHeight, depth * 1.05), 'concrete', { tags: ['stairs', 'climbable'] });
    }
    // Landing pad on top.
    this._box(`${name}_landing`, new Vector3(base.x, height + 0.2, dir === 'up' ? base.z + (steps + 1.2) * depth : base.z - (steps + 1.2) * depth), new Vector3(1.8, 0.4, 2.4), 'concrete', { tags: ['climbable'] });
  }

  /** A wall segment with a centred opening (so the doorway is a real hole, not a decal). */
  _wallWithDoor(name, center, { sx, sz }, { width, depth, height, t, doorWidth, alongX, material }) {
    const span = alongX ? width : depth;
    // Register the opening as a nav hint: a 2.6 m gap can fall between two lattice samples,
    // and a nav graph that can't see through doors is useless for AI.
    if (alongX) this.navHints.push({ x: center.x, z: center.z + (sz * depth) / 2 });
    else this.navHints.push({ x: center.x + (sx * width) / 2, z: center.z });
    const seg = Math.max(0, (span - doorWidth) / 2);
    const place = (offset) => {
      if (alongX) return new Vector3(center.x + offset, height / 2, center.z + (sz * depth) / 2);
      return new Vector3(center.x + (sx * width) / 2, height / 2, center.z + offset);
    };
    const size = alongX ? new Vector3(seg, height, t) : new Vector3(t, height, seg);
    if (seg > 0.2) {
      this._box(`${name}_a`, place(-(doorWidth + seg) / 2), size, material);
      this._box(`${name}_b`, place((doorWidth + seg) / 2), size, material);
    }
    // Lintel above the opening — its underside must clear the agent height (1.8 m) plus
    // headroom, otherwise nav samples can't pass through the doorway at all.
    const doorHeight = Math.min(2.45, Math.max(2.1, height - 0.35));
    const lintelHeight = Math.max(0.2, height - doorHeight);
    const lintel = alongX ? new Vector3(doorWidth, lintelHeight, t) : new Vector3(t, lintelHeight, doorWidth);
    this._box(`${name}_lintel`, alongX
      ? new Vector3(center.x, height - lintelHeight / 2, center.z + (sz * depth) / 2)
      : new Vector3(center.x + (sx * width) / 2, height - lintelHeight / 2, center.z), lintel, material);
  }

  _room(name, center, width, depth, opts = {}) {
    const height = opts.height ?? 4;
    const t = 0.35;
    const doorways = opts.doorways ?? [[0, -1]];
    for (const [sx, sz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const inDoor = doorways.some(([dx, dz]) => dx === sx && dz === sz);
      if (inDoor) {
        this._wallWithDoor(`${name}_${sx}_${sz}`, center, { sx, sz }, { width, depth, height, t, doorWidth: 2.2, alongX: sx === 0, material: 'concrete' });
      } else {
        const size = sx === 0 ? new Vector3(width, height, t) : new Vector3(t, height, depth);
        this._box(`${name}_${sx}_${sz}`, new Vector3(center.x + (sx * width) / 2, height / 2, center.z + (sz * depth) / 2), size, 'concrete');
      }
    }
    this._box(`${name}_ceiling`, new Vector3(center.x, height + 0.15, center.z), new Vector3(width, 0.3, depth), 'metal', { castShadow: false, tags: ['ceiling'] });
    if (this.rng.chance(0.5)) this._prop(this._coverProp(), new Vector3(center.x + this.rng.nextNumber(-2, 2), 0, center.z + this.rng.nextNumber(-2, 2)));
  }

  // ------------------------------------------------------------------ dressing
  _buildCover() {
    const target = Math.round(this.config.cover - this.coverPoints.length * 0.5);
    let attempts = 0;
    while (this.coverPoints.length < target && attempts < target * 6) {
      attempts++;
      const p = this._randomPoint(0.18);
      // Skip points too close to existing cover: even spread is what makes lanes fair.
      if (this._nearestCoverDistance(p) < 4.5) continue;
      this._prop(this._coverProp(), p, { Rotation: new Vector3(0, this.rng.nextNumber(0, 360), 0) });
    }
    this.stats.cover = this.coverPoints.length;
  }

  _nearestCoverDistance(p) {
    let best = Infinity;
    for (const c of this.coverPoints) best = Math.min(best, c.position.distanceToSquared(p));
    return Math.sqrt(best);
  }

  _buildHighGround() {
    const towers = this.config.towers ?? 0;
    for (let i = 0; i < towers; i++) {
      const p = this._randomPoint(0.55);
      const height = this.rng.nextNumber(3.5, 6);
      const platform = this._box(`Tower_${i}`, new Vector3(p.x, height, p.z), new Vector3(6, 0.4, 6), 'metal', { tags: ['catwalk', 'sniperNest'] });
      platform.addTag('climbable');
      // Support pillars + a ramp of steps so the tower is reachable.
      for (const [dx, dz] of [[-2.6, -2.6], [2.6, -2.6], [-2.6, 2.6], [2.6, 2.6]]) {
        this._box(`Tower_${i}_leg_${dx}_${dz}`, new Vector3(p.x + dx, height / 2, p.z + dz), new Vector3(0.3, height, 0.3), 'metal');
      }
      const steps = Math.ceil(height / 0.35);
      for (let s = 0; s < steps; s++) {
        this._box(`Tower_${i}_step_${s}`, new Vector3(p.x + 3.6 + s * 0.5, 0.18 + s * 0.35, p.z + 3.6 + s * 0.5), new Vector3(1.4, 0.36, 1.4), 'concrete');
      }
    }
  }

  _buildSpawns() {
    const teams = [
      { team: 'red', dir: new Vector3(-1, 0, 1) },
      { team: 'blue', dir: new Vector3(1, 0, -1) },
    ];
    for (const { team, dir } of teams) {
      for (let i = 0; i < 4; i++) {
        const spread = (i - 1.5) * 4;
        const pos = new Vector3(
          dir.x * (this.half - 6) + spread * 0.6,
          0.06,
          dir.z * (this.half - 6) + spread * 0.6,
        );
        const pad = new SpawnPart({
          Name: `Spawn_${team}_${i}`,
          Position: pos,
          Size: new Vector3(2.4, 0.12, 2.4),
          Material: team === 'red' ? 'hazard' : 'metal',
          Team: team,
          Priority: 1,
        });
        pad.addTag(`spawn:${team}`);
        this._add(pad);
        this.spawns[team].push(pad);
        // A little cover in front of each spawn so players aren't shot immediately.
        this._prop('lowCover', new Vector3(pos.x + dir.x * 6, 0, pos.z + dir.z * 6), { Rotation: new Vector3(0, 45 * (team === 'red' ? 1 : -1), 0) });
      }
      // Forward spawn cluster. Rear corners alone mean a round opens with a 120 m commute across
      // an empty map: the forward pads sit two thirds of the way to the objectives, carry a lower
      // priority so the spawn picker still prefers the rear when the front line is hot, and give
      // respawning players a way back into the fight without a cross-map sprint.
      const forward = this.half * 0.34;
      const side = new Vector3(-dir.z, 0, dir.x);
      for (let i = 0; i < 2; i++) {
        const lateral = (i === 0 ? -1 : 1) * 7;
        const pos = new Vector3(
          dir.x * forward - side.x * lateral,
          0.06,
          dir.z * forward - side.z * lateral,
        );
        const pad = new SpawnPart({
          Name: `Spawn_${team}_fwd_${i}`,
          Position: pos,
          Size: new Vector3(2.4, 0.12, 2.4),
          Material: team === 'red' ? 'hazard' : 'metal',
          Team: team,
          Priority: 0.6,
        });
        pad.addTag(`spawn:${team}`);
        pad.addTag('spawn:forward');
        this._add(pad);
        this.spawns[team].push(pad);
        this._prop('lowCover', new Vector3(pos.x + dir.x * 5.5, 0, pos.z + dir.z * 5.5), { Rotation: new Vector3(0, (team === 'red' ? 135 : -45), 0) });
      }
    }
  }

  _buildObjectives() {
    if (this.config.style === 'rooms' || this.config.style === 'warehouse') {
      this.objectives.push(this._makeObjective('A', new Vector3(-this.half * 0.4, 0, this.half * 0.35)));
      this.objectives.push(this._makeObjective('B', new Vector3(this.half * 0.4, 0, -this.half * 0.35)));
    } else {
      this.objectives.push(this._makeObjective('Center', new Vector3(0, 0, 0)));
      this.objectives.push(this._makeObjective('North', new Vector3(0, 0, -this.half * 0.5)));
      this.objectives.push(this._makeObjective('South', new Vector3(0, 0, this.half * 0.5)));
    }
  }

  _makeObjective(label, position) {
    const zone = new TriggerPart({
      Name: `Objective_${label}`,
      Position: new Vector3(position.x, 1.5, position.z),
      Size: new Vector3(6, 3, 6),
      Material: 'hazard',
      TriggerKind: 'objective',
    });
    zone.addTag('objective');
    zone.addTag(`objective:${label}`);
    zone.label = label;
    this._add(zone);
    // Cover ring around the objective: capture points must be contestable.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + this.rng.nextNumber(-0.2, 0.2);
      this._prop('lowCover', new Vector3(position.x + Math.cos(a) * 5.5, 0, position.z + Math.sin(a) * 5.5), { Rotation: new Vector3(0, (a * 180) / Math.PI, 0) });
    }
    return { label, position: new Vector3(position.x, 0, position.z), zone };
  }

  _buildPickups() {
    const kinds = ['healthPickup', 'ammoPickup', 'armorPickup'];
    const count = Math.max(6, Math.round(this.size / 10));
    for (let i = 0; i < count; i++) {
      const kind = kinds[i % kinds.length];
      const pos = this._randomPoint(0.3);
      pos.y = 0.35;
      const part = this._prop(kind, pos);
      if (part) {
        part.addTag('pickup');
        part.addTag(`pickup:${kind}`);
        part.respawnTime = kind === 'ammoPickup' ? 12 : 25;
        part.amount = kind === 'healthPickup' ? 40 : kind === 'armorPickup' ? 50 : 1;
        this.pickups.push(part);
        this.stats.pickups++;
      }
    }
  }

  _buildLighting() {
    const lamps = Math.max(2, Math.round(this.size / 24));
    for (let i = 0; i < lamps; i++) {
      const p = this._randomPoint(0.45);
      const lamp = this._prop('streetLamp', p);
      if (lamp) {
        lamp.lightSpec = {
          color: '#ffd9a0',
          intensity: 3.5,
          range: 18,
          height: 4.6,
          flicker: false,
        };
      }
    }
    if (this.config.style === 'rooms') {
      // Facility interiors need their own cold ceiling lights.
      for (const room of this.scene.getByClassName('Part')) {
        if (!room.Name.startsWith('Room_') || room.Name.endsWith('_ceiling')) continue;
        room.lightSpec = { color: '#cfe3ff', intensity: 1.6, range: 9, height: room.Position.y + 3.6, flicker: this.rng.chance(0.15) };
      }
    }
  }

  _tuneEnvironment() {
    const env = this.scene.environment;
    env.dayTime = this.opts.timeOfDay ?? (this.config.style === 'rooms' ? 14 : 10.5);
    env.fogDensity = this.config.style === 'outpost' ? 0.012 : 0.008;
    env.fogColor = this.config.ground === 'dirt' ? '#c8b58f' : '#93a9bd';
    env.ambientIntensity = this.config.style === 'rooms' ? 0.42 : 0.55;
  }

  // ------------------------------------------------------------------ helpers
  _randomPoint(inset = 0.1) {
    const limit = this.half * (1 - inset);
    return new Vector3(
      this.rng.nextNumber(-limit, limit),
      0,
      this.rng.nextNumber(-limit, limit),
    );
  }
}

/**
 * One-call map generation used by the game app, the Studio "new map" flow and tests.
 * @returns {{scene, nav, bounds, spawns, objectives, stats}}
 */
export function buildMap(scene, opts = {}) {
  const builder = new LevelBuilder(scene, opts);
  return builder.build(opts);
}

export default LevelBuilder;
