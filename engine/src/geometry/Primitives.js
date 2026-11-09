/**
 * OminX Engine — procedural primitives.
 *
 * The engine ships with zero binary assets on purpose: every mesh in the editor's part
 * palette, every map decoration and every weapon model is generated here. That keeps the
 * whole engine a single text repo and makes the web build tiny (no 400 MB asset pack).
 *
 * Conventions: +Y up, -Z forward, CCW winding = front face, UVs in [0,1] tiles.
 * @module engine/geometry/Primitives
 */
import { Mesh } from './Mesh.js';

// ---------------------------------------------------------------------------
// Buffer builder used by all generators
// ---------------------------------------------------------------------------
class PrimBuilder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; }
  vertex(x, y, z, nx, ny, nz, u, v) {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    return i;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  build(name) {
    return new Mesh({
      name,
      positions: this.pos,
      normals: this.nrm,
      uvs: this.uv,
      indices: this.idx,
    });
  }
}

// ---------------------------------------------------------------------------
// Box
// ---------------------------------------------------------------------------
/**
 * Axis-aligned box centred at the origin.
 * @param {number} sx size along X
 * @param {number} sy size along Y
 * @param {number} sz size along Z
 * @param {object} [opts]
 * @param {number} [opts.uvScale=1] texture tiles per world unit
 * @param {number[]} [opts.uvRect] optional [u0,v0,u1,v1] applied to every face (atlas parts)
 * @param {boolean} [opts.invert=false] flip normals/winding (interior volumes e.g. skybox rooms)
 */
export function createBox(sx = 1, sy = 1, sz = 1, opts = {}) {
  const uvScale = opts.uvScale ?? 1;
  const invert = opts.invert ?? false;
  const rotRect = opts.uvRect ?? null;
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const b = new PrimBuilder();
  // face definitions: origin corner, u axis, v axis, normal
  const faces = [
    { n: [0, 0, 1], o: [-hx, -hy, hz], u: [sx, 0, 0], v: [0, sy, 0], name: 'front', size: [sx, sy] },
    { n: [0, 0, -1], o: [hx, -hy, -hz], u: [-sx, 0, 0], v: [0, sy, 0], name: 'back', size: [sx, sy] },
    { n: [1, 0, 0], o: [hx, -hy, hz], u: [0, 0, -sz], v: [0, sy, 0], name: 'right', size: [sz, sy] },
    { n: [-1, 0, 0], o: [-hx, -hy, -hz], u: [0, 0, sz], v: [0, sy, 0], name: 'left', size: [sz, sy] },
    { n: [0, 1, 0], o: [-hx, hy, hz], u: [sx, 0, 0], v: [0, 0, -sz], name: 'top', size: [sx, sz] },
    { n: [0, -1, 0], o: [-hx, -hy, -hz], u: [sx, 0, 0], v: [0, 0, sz], name: 'bottom', size: [sx, sz] },
  ];
  for (const f of faces) {
    const [u0, v0, u1, v1] = rotRect ?? [0, 0, f.size[0] * uvScale, f.size[1] * uvScale];
    const a = b.vertex(f.o[0], f.o[1], f.o[2], f.n[0], f.n[1], f.n[2], u0, v0);
    const bb = b.vertex(f.o[0] + f.u[0], f.o[1] + f.u[1], f.o[2] + f.u[2], f.n[0], f.n[1], f.n[2], u1, v0);
    const c = b.vertex(f.o[0] + f.u[0] + f.v[0], f.o[1] + f.u[1] + f.v[1], f.o[2] + f.u[2] + f.v[2], f.n[0], f.n[1], f.n[2], u1, v1);
    const d = b.vertex(f.o[0] + f.v[0], f.o[1] + f.v[1], f.o[2] + f.v[2], f.n[0], f.n[1], f.n[2], u0, v1);
    if (invert) b.quad(a, d, c, bb); else b.quad(a, bb, c, d);
  }
  return b.build('Box');
}

/** Unit cube centred at origin (size 1) — the base for instanced prop placement. */
export function createUnitCube() { return createBox(1, 1, 1); }

// ---------------------------------------------------------------------------
// Sphere / hemisphere / icosphere
// ---------------------------------------------------------------------------
export function createSphere(radius = 0.5, widthSegments = 24, heightSegments = 16, opts = {}) {
  const phiStart = opts.phiStart ?? 0;
  const phiLength = opts.phiLength ?? Math.PI * 2;
  const thetaStart = opts.thetaStart ?? 0;
  const thetaLength = opts.thetaLength ?? Math.PI;
  const b = new PrimBuilder();
  const grid = [];
  const uSteps = Math.max(3, widthSegments);
  const vSteps = Math.max(2, heightSegments);
  for (let iy = 0; iy <= vSteps; iy++) {
    const row = [];
    const v = iy / vSteps;
    const theta = thetaStart + v * thetaLength;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let ix = 0; ix <= uSteps; ix++) {
      const u = ix / uSteps;
      const phi = phiStart + u * phiLength;
      const x = -radius * Math.cos(phi) * sinT;
      const y = radius * cosT;
      const z = radius * Math.sin(phi) * sinT;
      const nx = x / radius || 0, ny = y / radius, nz = z / radius;
      row.push(b.vertex(x, y, z, nx, ny, nz, u, 1 - v));
    }
    grid.push(row);
  }
  for (let iy = 0; iy < vSteps; iy++) {
    for (let ix = 0; ix < uSteps; ix++) {
      const a = grid[iy][ix + 1];
      const bb = grid[iy][ix];
      const c = grid[iy + 1][ix];
      const d = grid[iy + 1][ix + 1];
      if (iy !== 0 || thetaStart > 0) b.tri(a, bb, d);
      if (iy !== vSteps - 1 || thetaLength < Math.PI) b.tri(bb, c, d);
    }
  }
  return b.build('Sphere');
}

export function createHemisphere(radius = 0.5, segments = 24, rings = 8) {
  return createSphere(radius, segments, rings, { thetaLength: Math.PI / 2 });
}

/** Icosphere — uniform triangles, ideal for grenade collision spheres & low-poly rocks. */
export function createIcosphere(radius = 0.5, subdivisions = 2) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => normalize3(v));
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; s++) {
    const midCache = new Map();
    const newFaces = [];
    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (midCache.has(key)) return midCache.get(key);
      const va = verts[a], vb = verts[b];
      const m = normalize3([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]);
      verts.push(m);
      const idx = verts.length - 1;
      midCache.set(key, idx);
      return idx;
    };
    for (const [a, bb, c] of faces) {
      const ab = midpoint(a, bb), bc = midpoint(bb, c), ca = midpoint(c, a);
      newFaces.push([a, ab, ca], [bb, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = newFaces;
  }
  const b = new PrimBuilder();
  const idxMap = new Map();
  const indices = [];
  for (const f of faces) {
    const tri = f.map((vi) => {
      if (idxMap.has(vi)) return idxMap.get(vi);
      const v = verts[vi];
      const u = 0.5 + Math.atan2(v[2], v[0]) / (2 * Math.PI);
      const vv = 0.5 - Math.asin(clamp1(v[1])) / Math.PI;
      const idx = b.vertex(v[0] * radius, v[1] * radius, v[2] * radius, v[0], v[1], v[2], u, vv);
      idxMap.set(vi, idx);
      return idx;
    });
    indices.push(tri[0], tri[1], tri[2]);
  }
  b.idx = indices;
  return b.build('Icosphere');
}
function normalize3(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
function clamp1(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }

// ---------------------------------------------------------------------------
// Cylinder / cone / capsule / tube
// ---------------------------------------------------------------------------
export function createCylinder(radiusTop = 0.5, radiusBottom = 0.5, height = 1, radialSegments = 24, heightSegments = 1, openEnded = false, thetaLength = Math.PI * 2) {
  const b = new PrimBuilder();
  const half = height / 2;
  const grid = [];
  for (let y = 0; y <= heightSegments; y++) {
    const v = y / heightSegments;
    const radius = radiusBottom + (radiusTop - radiusBottom) * (1 - v);
    const row = [];
    for (let x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments;
      const theta = u * thetaLength;
      const sin = Math.sin(theta), cos = Math.cos(theta);
      // slope-aware normal
      const slope = (radiusBottom - radiusTop) / height;
      const nx = cos, ny = slope, nz = sin;
      const nl = Math.hypot(nx, ny, nz);
      row.push(b.vertex(radius * cos, half - height * v, radius * sin, nx / nl, ny / nl, nz / nl, u, 1 - v));
    }
    grid.push(row);
  }
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < radialSegments; x++) {
      b.quad(grid[y][x], grid[y + 1][x], grid[y + 1][x + 1], grid[y][x + 1]);
    }
  }
  const buildCap = (radius, yPos, up, vOffset) => {
    if (radius <= 1e-6) return;
    const center = b.vertex(0, yPos, 0, 0, up, 0, 0.5, 0.5 + vOffset);
    const ring = [];
    for (let x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments;
      const theta = u * thetaLength;
      ring.push(b.vertex(radius * Math.cos(theta), yPos, radius * Math.sin(theta), 0, up, 0, Math.cos(theta) * 0.5 + 0.5, Math.sin(theta) * 0.5 + 0.5));
    }
    for (let x = 0; x < radialSegments; x++) {
      if (up > 0) b.tri(center, ring[x], ring[x + 1]);
      else b.tri(center, ring[x + 1], ring[x]);
    }
  };
  if (!openEnded) {
    buildCap(radiusTop, half, 1, 0.5);
    buildCap(radiusBottom, -half, -1, 0.5);
  }
  return b.build('Cylinder');
}

export function createCone(radius = 0.5, height = 1, radialSegments = 24) {
  return createCylinder(1e-5, radius, height, radialSegments, 8, false);
}

/** Capsule — player/bot collision volumes and pickup silhouettes. */
export function createCapsule(radius = 0.3, cylinderHeight = 0.8, radialSegments = 20, capSegments = 6) {
  const b = new PrimBuilder();
  const half = cylinderHeight / 2;
  const rings = [];
  // top hemisphere
  for (let i = 0; i <= capSegments; i++) {
    const t = i / capSegments;
    const theta = t * (Math.PI / 2);
    const y = half + radius * Math.sin(theta);
    const r = radius * Math.cos(theta);
    const ny = Math.sin(theta), nr = Math.cos(theta);
    const ring = [];
    for (let s = 0; s <= radialSegments; s++) {
      const u = s / radialSegments;
      const phi = u * Math.PI * 2;
      ring.push(b.vertex(r * Math.cos(phi), y, r * Math.sin(phi), nr * Math.cos(phi), ny, nr * Math.sin(phi), u, 0.5 + t * 0.5));
    }
    rings.push(ring);
  }
  // bottom hemisphere (reversed order for correct winding)
  for (let i = 0; i <= capSegments; i++) {
    const t = i / capSegments;
    const theta = t * (Math.PI / 2);
    const y = -half - radius * Math.sin(theta);
    const r = radius * Math.cos(theta);
    const ny = -Math.sin(theta), nr = Math.cos(theta);
    const ring = [];
    for (let s = 0; s <= radialSegments; s++) {
      const u = s / radialSegments;
      const phi = u * Math.PI * 2;
      ring.push(b.vertex(r * Math.cos(phi), y, r * Math.sin(phi), nr * Math.cos(phi), ny, nr * Math.sin(phi), u, 0.5 - t * 0.5));
    }
    rings.push(ring);
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < radialSegments; s++) {
      b.quad(rings[r][s], rings[r + 1][s], rings[r + 1][s + 1], rings[r][s + 1]);
    }
  }
  return b.build('Capsule');
}

export function createTorus(radius = 0.5, tube = 0.15, radialSegments = 24, tubularSegments = 16) {
  const b = new PrimBuilder();
  const grid = [];
  for (let j = 0; j <= radialSegments; j++) {
    const row = [];
    const v = (j / radialSegments) * Math.PI * 2;
    for (let i = 0; i <= tubularSegments; i++) {
      const u = (i / tubularSegments) * Math.PI * 2;
      const x = (radius + tube * Math.cos(v)) * Math.cos(u);
      const y = tube * Math.sin(v);
      const z = (radius + tube * Math.cos(v)) * Math.sin(u);
      const nx = Math.cos(v) * Math.cos(u), ny = Math.sin(v), nz = Math.cos(v) * Math.sin(u);
      row.push(b.vertex(x, y, z, nx, ny, nz, i / tubularSegments, j / radialSegments));
    }
    grid.push(row);
  }
  for (let j = 0; j < radialSegments; j++) {
    for (let i = 0; i < tubularSegments; i++) {
      b.quad(grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]);
    }
  }
  return b.build('Torus');
}

// ---------------------------------------------------------------------------
// Planes / quads / misc
// ---------------------------------------------------------------------------
export function createPlane(width = 1, depth = 1, widthSegments = 1, depthSegments = 1, opts = {}) {
  const b = new PrimBuilder();
  const uvScale = opts.uvScale ?? 1;
  const grid = [];
  for (let iy = 0; iy <= depthSegments; iy++) {
    const row = [];
    const v = iy / depthSegments;
    for (let ix = 0; ix <= widthSegments; ix++) {
      const u = ix / widthSegments;
      const x = (u - 0.5) * width;
      const z = (v - 0.5) * depth;
      row.push(b.vertex(x, 0, z, 0, 1, 0, u * width * uvScale, v * depth * uvScale));
    }
    grid.push(row);
  }
  for (let iy = 0; iy < depthSegments; iy++) {
    for (let ix = 0; ix < widthSegments; ix++) {
      b.quad(grid[iy][ix], grid[iy + 1][ix], grid[iy + 1][ix + 1], grid[iy][ix + 1]);
    }
  }
  return b.build('Plane');
}

export function createQuad(width = 1, height = 1, opts = {}) {
  const uvScale = opts.uvScale ?? 1;
  const b = new PrimBuilder();
  const hw = width / 2, hh = height / 2;
  const a = b.vertex(-hw, -hh, 0, 0, 0, 1, 0, 0);
  const bb = b.vertex(hw, -hh, 0, 0, 0, 1, width * uvScale, 0);
  const c = b.vertex(hw, hh, 0, 0, 0, 1, width * uvScale, height * uvScale);
  const d = b.vertex(-hw, hh, 0, 0, 0, 1, 0, height * uvScale);
  b.quad(a, bb, c, d);
  return b.build('Quad');
}

/** Screen-space quad in clip space — fullscreen post-process passes. */
export function createFullscreenQuad() {
  const mesh = new Mesh({
    name: 'FullscreenQuad',
    positions: [-1, -1, 0, 3, -1, 0, -1, 3, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 2, 0, 0, 2],
    indices: [0, 1, 2],
  });
  return mesh;
}

/** Roblox-style wedge (ramp). */
export function createWedge(width = 1, height = 1, depth = 1, opts = {}) {
  const uvScale = opts.uvScale ?? 1;
  const b = new PrimBuilder();
  const hw = width / 2, hh = height / 2, hd = depth / 2;
  // Vertices: back face is a rectangle, front face collapses to the bottom edge
  const p = {
    bl: [-hw, -hh, hd], br: [hw, -hh, hd],
    tl: [-hw, hh, hd], tr: [hw, hh, hd],
    fbl: [-hw, -hh, -hd], fbr: [hw, -hh, -hd],
  };
  const add = (v, n, u, vv) => b.vertex(v[0], v[1], v[2], n[0], n[1], n[2], u, vv);
  const slopeLen = Math.hypot(height, depth);
  const slopeNy = depth / slopeLen, slopeNz = -height / slopeLen;
  // bottom
  let a = add(p.bl, [0, -1, 0], 0, 0), bb2 = add(p.br, [0, -1, 0], width * uvScale, 0),
    c = add(p.fbr, [0, -1, 0], width * uvScale, depth * uvScale), d = add(p.fbl, [0, -1, 0], 0, depth * uvScale);
  b.quad(a, d, c, bb2);
  // back (facing +Z)
  a = add(p.bl, [0, 0, 1], 0, 0); bb2 = add(p.br, [0, 0, 1], width * uvScale, 0);
  c = add(p.tr, [0, 0, 1], width * uvScale, height * uvScale); d = add(p.tl, [0, 0, 1], 0, height * uvScale);
  b.quad(a, bb2, c, d);
  // slope (top)
  a = add(p.tl, [0, slopeNy, slopeNz], 0, 0); bb2 = add(p.tr, [0, slopeNy, slopeNz], width * uvScale, 0);
  c = add(p.fbr, [0, slopeNy, slopeNz], width * uvScale, slopeLen * uvScale); d = add(p.fbl, [0, slopeNy, slopeNz], 0, slopeLen * uvScale);
  b.quad(a, bb2, c, d);
  // left triangle
  a = add(p.bl, [-1, 0, 0], 0, 0); bb2 = add(p.tl, [-1, 0, 0], 0, height * uvScale); c = add(p.fbl, [-1, 0, 0], depth * uvScale, 0);
  b.tri(a, bb2, c);
  // right triangle
  a = add(p.br, [1, 0, 0], 0, 0); bb2 = add(p.fbr, [1, 0, 0], depth * uvScale, 0); c = add(p.tr, [1, 0, 0], 0, height * uvScale);
  b.tri(a, bb2, c);
  return b.build('Wedge');
}

/** Cylinder with a hole — barrels, rings, sewer pipes. */
export function createTube(outerRadius = 0.5, innerRadius = 0.35, height = 1, radialSegments = 20) {
  const b = new PrimBuilder();
  const half = height / 2;
  const ring = (r, y, inward, uOffset) => {
    const out = [];
    for (let i = 0; i <= radialSegments; i++) {
      const u = i / radialSegments;
      const t = u * Math.PI * 2;
      const ct = Math.cos(t), st = Math.sin(t);
      out.push(b.vertex(r * ct, y, r * st, inward ? -ct : ct, 0, inward ? -st : st, u, uOffset));
    }
    return out;
  };
  const oTop = ring(outerRadius, half, false, 0);
  const oBot = ring(outerRadius, -half, false, 1);
  const iTop = ring(innerRadius, half, true, 0);
  const iBot = ring(innerRadius, -half, true, 1);
  for (let i = 0; i < radialSegments; i++) {
    b.quad(oBot[i], oBot[i + 1], oTop[i + 1], oTop[i]);
    b.quad(iBot[i + 1], iBot[i], iTop[i], iTop[i + 1]);
    // caps
    const ao = b.vertex(outerRadius * Math.cos((i / radialSegments) * Math.PI * 2), half, outerRadius * Math.sin((i / radialSegments) * Math.PI * 2), 0, 1, 0, 0, 0);
    const bo = b.vertex(outerRadius * Math.cos(((i + 1) / radialSegments) * Math.PI * 2), half, outerRadius * Math.sin(((i + 1) / radialSegments) * Math.PI * 2), 0, 1, 0, 1, 0);
    const ai = b.vertex(innerRadius * Math.cos((i / radialSegments) * Math.PI * 2), half, innerRadius * Math.sin((i / radialSegments) * Math.PI * 2), 0, 1, 0, 0, 1);
    const bi = b.vertex(innerRadius * Math.cos(((i + 1) / radialSegments) * Math.PI * 2), half, innerRadius * Math.sin(((i + 1) / radialSegments) * Math.PI * 2), 0, 1, 0, 1, 1);
    b.quad(ao, ai, bi, bo);
  }
  return b.build('Tube');
}

/** Extrudes a 2D polygon (XZ points) along Y by `height`. */
export function createExtrusion(points, height = 1, opts = {}) {
  // Accept [x, z] tuples, Vector2/Vector3 objects and {x, z} literals.
  points = (points ?? []).map((p) => {
    if (Array.isArray(p)) return [p[0], p[1]];
    if (p && typeof p === 'object') return [p.x ?? p[0] ?? 0, p.z ?? p.y ?? p[1] ?? 0];
    return [0, 0];
  });
  if (points.length < 3) points = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  const b = new PrimBuilder();
  const half = height / 2;
  const n = points.length;
  // side walls
  for (let i = 0; i < n; i++) {
    const p0 = points[i], p1 = points[(i + 1) % n];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = dz / len, nz = -dx / len;
    const a = b.vertex(p0[0], -half, p0[1], nx, 0, nz, 0, 0);
    const bb = b.vertex(p1[0], -half, p1[1], nx, 0, nz, len, 0);
    const c = b.vertex(p1[0], half, p1[1], nx, 0, nz, len, height);
    const d = b.vertex(p0[0], half, p0[1], nx, 0, nz, 0, height);
    b.quad(a, bb, c, d);
  }
  // caps (fan triangulation; shapes here are convex by design)
  const capNormal = opts.invertCaps ? -1 : 1;
  let topCenter = b.vertex(0, half, 0, 0, capNormal, 0, 0.5, 0.5);
  let botCenter = b.vertex(0, -half, 0, 0, -capNormal, 0, 0.5, 0.5);
  const topRing = points.map((p) => b.vertex(p[0], half, p[1], 0, capNormal, 0, p[0] * 0.5 + 0.5, p[1] * 0.5 + 0.5));
  const botRing = points.map((p) => b.vertex(p[0], -half, p[1], 0, -capNormal, 0, p[0] * 0.5 + 0.5, p[1] * 0.5 + 0.5));
  for (let i = 0; i < n; i++) {
    b.tri(topCenter, topRing[i], topRing[(i + 1) % n]);
    b.tri(botCenter, botRing[(i + 1) % n], botRing[i]);
  }
  return b.build('Extrusion');
}

/** A flight of stairs — instantly gives maps verticality (strong FPS level design). */
export function createStairs(steps = 8, width = 2, stepHeight = 0.2, stepDepth = 0.3) {
  // Accept an options object as well as positional arguments.
  if (steps && typeof steps === 'object') {
    const o = steps;
    steps = o.steps ?? 8;
    width = o.width ?? 2;
    stepHeight = o.rise ?? o.stepHeight ?? 0.2;
    stepDepth = o.run ?? o.stepDepth ?? 0.3;
  }
  const b = new PrimBuilder();
  const hw = width / 2;
  const totalH = steps * stepHeight;
  const totalD = steps * stepDepth;
  for (let i = 0; i < steps; i++) {
    const y0 = i * stepHeight;
    const y1 = (i + 1) * stepHeight;
    const z0 = -totalD / 2 + i * stepDepth;
    const z1 = z0 + stepDepth;
    const wf = b.vertex(-hw, y1, z1, 0, 1, 0, 0, z1);
    const wf2 = b.vertex(hw, y1, z1, 0, 1, 0, width, z1);
    const wf3 = b.vertex(hw, y1, z0, 0, 1, 0, width, z0);
    const wf4 = b.vertex(-hw, y1, z0, 0, 1, 0, 0, z0);
    b.quad(wf, wf4, wf3, wf2);
    // riser facing -Z
    const r1 = b.vertex(-hw, y0, z0, 0, 0, -1, -hw, y0);
    const r2 = b.vertex(hw, y0, z0, 0, 0, -1, hw, y0);
    const r3 = b.vertex(hw, y1, z0, 0, 0, -1, hw, y1);
    const r4 = b.vertex(-hw, y1, z0, 0, 0, -1, -hw, y1);
    b.quad(r1, r2, r3, r4);
    // sides
    const s1 = b.vertex(hw, y0, z0, 1, 0, 0, z0, y0);
    const s2 = b.vertex(hw, y0, z1, 1, 0, 0, z1, y0);
    const s3 = b.vertex(hw, y1, z1, 1, 0, 0, z1, y1);
    const s4 = b.vertex(hw, y1, z0, 1, 0, 0, z0, y1);
    b.quad(s1, s2, s3, s4);
    const l1 = b.vertex(-hw, y0, z1, -1, 0, 0, z1, y0);
    const l2 = b.vertex(-hw, y0, z0, -1, 0, 0, z0, y0);
    const l3 = b.vertex(-hw, y1, z0, -1, 0, 0, z0, y1);
    const l4 = b.vertex(-hw, y1, z1, -1, 0, 0, z1, y1);
    b.quad(l1, l2, l3, l4);
  }
  // bottom cap
  const b1 = b.vertex(-hw, 0, totalD / 2, 0, -1, 0, 0, 0);
  const b2 = b.vertex(hw, 0, totalD / 2, 0, -1, 0, 1, 0);
  const b3 = b.vertex(hw, 0, -totalD / 2, 0, -1, 0, 1, 1);
  const b4 = b.vertex(-hw, 0, -totalD / 2, 0, -1, 0, 0, 1);
  b.quad(b1, b4, b3, b2);
  return b.build('Stairs');
}

/** Low wall / cover block with angled top — classic FPS cover geometry. */
export function createCoverBlock(width = 2, height = 1.1, depth = 0.6, chamfer = 0.12) {
  const b = new PrimBuilder();
  const hw = width / 2, hd = depth / 2;
  const top = height - chamfer;
  // side profiles as an extrusion along X
  const profile = [
    [-hd, 0], [hd, 0], [hd, top], [hd - chamfer, height], [-hd + chamfer, height], [-hd, top],
  ];
  for (let i = 0; i < profile.length; i++) {
    const p0 = profile[i], p1 = profile[(i + 1) % profile.length];
    const dz = p1[0] - p0[0], dy = p1[1] - p0[1];
    const l = Math.hypot(dy, dz) || 1;
    const ny = dz / l, nz = -dy / l;
    const a = b.vertex(-hw, p0[1], p0[0], 0, ny, nz, 0, 0);
    const bb = b.vertex(hw, p0[1], p0[0], 0, ny, nz, width, 0);
    const c = b.vertex(hw, p1[1], p1[0], 0, ny, nz, width, l);
    const d = b.vertex(-hw, p1[1], p1[0], 0, ny, nz, 0, l);
    b.quad(a, bb, c, d);
  }
  // caps
  const capA = profile.map((p) => b.vertex(-hw, p[1], p[0], -1, 0, 0, p[0], p[1]));
  const capB = profile.map((p) => b.vertex(hw, p[1], p[0], 1, 0, 0, p[0], p[1]));
  for (let i = 1; i < profile.length - 1; i++) {
    b.tri(capA[0], capA[i], capA[i + 1]);
    b.tri(capB[0], capB[i + 1], capB[i]);
  }
  return b.build('CoverBlock');
}

/**
 * Modular wall with a doorway/window cut-out, built from 4 boxes.
 * @param {object} opts
 * @param {number} opts.width overall wall width
 * @param {number} opts.height
 * @param {number} opts.thickness
 * @param {number} opts.openingWidth
 * @param {number} opts.openingHeight
 * @param {number} [opts.openingY=0] bottom of the opening
 */
export function createWallWithOpening(opts = {}) {
  const width = opts.width ?? 4;
  const height = opts.height ?? 3;
  const thickness = opts.thickness ?? 0.25;
  const ow = opts.openingWidth ?? 1.2;
  const oh = opts.openingHeight ?? 2.2;
  const oy = opts.openingY ?? 0;
  const uvScale = opts.uvScale ?? 1;
  const mesh = new Mesh();
  const left = (width - ow) / 2;
  const addBox = (sx, sy, sz, x, y, z) => {
    const box = createBox(Math.max(sx, 0.001), Math.max(sy, 0.001), Math.max(sz, 0.001), { uvScale });
    box.translate(x, y, z);
    mesh.merge(box);
  };
  // left/right pillars
  addBox(left, height, thickness, -(ow / 2 + left / 2), height / 2, 0);
  addBox(left, height, thickness, ow / 2 + left / 2, height / 2, 0);
  // lintel above the opening
  addBox(ow, Math.max(height - (oy + oh), 0.001), thickness, 0, (oy + oh + height) / 2, 0);
  // sill below the opening (windows)
  if (oy > 0) addBox(ow, oy, thickness, 0, oy / 2, 0);
  mesh.name = 'WallWithOpening';
  return mesh;
}

export const Primitives = {
  createBox, createUnitCube, createSphere, createHemisphere, createIcosphere,
  createCylinder, createCone, createCapsule, createTorus, createTube,
  createPlane, createQuad, createFullscreenQuad, createWedge, createExtrusion,
  createStairs, createCoverBlock, createWallWithOpening,
};
export default Primitives;
