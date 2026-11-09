/**
 * OminX Engine — geometry primitives: Ray, Plane, AABB, Sphere, Triangle, Frustum + intersections.
 * @module engine/math/Geometry
 */
import { Vector3 } from './Vector3.js';
import { Matrix4 } from './Matrix4.js';
import { EPSILON, clamp, solveQuadratic, solveCubic } from './MathUtils.js';

// ---------------------------------------------------------------------------
// Ray
// ---------------------------------------------------------------------------
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();

export class Ray {
  constructor(origin = new Vector3(), direction = new Vector3(0, 0, -1)) {
    this.origin = origin;
    this.direction = direction;
  }
  static new(origin, direction) { return new Ray(origin, direction); }
  set(origin, direction) { this.origin.copy(origin); this.direction.copy(direction); return this; }
  copy(r) { this.origin.copy(r.origin); this.direction.copy(r.direction); return this; }
  clone() { return new Ray(this.origin.clone(), this.direction.clone()); }
  at(t, out = new Vector3()) { return out.copy(this.direction).scale(t).add(this.origin); }
  normalize() { this.direction.normalize(); return this; }
  /** Distance from the ray to a point. */
  distanceToPoint(p) {
    const t = clamp(_v1.copy(p).sub(this.origin).dot(this.direction), 0, Infinity);
    return this.at(t, _v2).distanceTo(p);
  }
  /** Closest parametric point on this ray to a segment/line — used for ray-ray distance. */
  closestPointToRay(other) {
    const d1 = this.direction, d2 = other.direction;
    const r = _v1.copy(this.origin).sub(other.origin);
    const a = d1.dot(d1), b = d1.dot(d2), c = d2.dot(d2);
    const d = d1.dot(r), e = d2.dot(r);
    const denom = a * c - b * b;
    let t = denom < EPSILON ? 0 : (b * e - c * d) / denom;
    t = Math.max(0, t);
    return { t, point: this.at(t, new Vector3()), distance: this.at(t, _v2).distanceTo(other.at(clamp((b * t + e) / (c || 1), 0, Infinity), _v3)) };
  }
  /** Möller–Trumbore triangle intersection; returns t or null. */
  intersectTriangle(a, b, c, backfaceCulling = false) {
    const e1 = _v1.copy(b).sub(a);
    const e2 = _v2.copy(c).sub(a);
    const p = _v3.copy(this.direction).cross(e2);
    const det = e1.dot(p);
    if (backfaceCulling ? det < EPSILON : Math.abs(det) < EPSILON) return null;
    const invDet = 1 / det;
    const t = _t1.copy(this.origin).sub(a);
    const u = t.dot(p) * invDet;
    if (u < -EPSILON || u > 1 + EPSILON) return null;
    const q = _t2.copy(t).cross(e1);
    const v = this.direction.dot(q) * invDet;
    if (v < -EPSILON || u + v > 1 + EPSILON) return null;
    const dist = e2.dot(q) * invDet;
    return dist > EPSILON ? dist : null;
  }
  intersectPlane(plane) {
    const denom = plane.normal.dot(this.direction);
    if (Math.abs(denom) < EPSILON) return null;
    const t = -(this.origin.dot(plane.normal) + plane.constant) / denom;
    return t >= 0 ? t : null;
  }
  intersectSphere(center, radius) {
    const oc = _t1.copy(this.origin).sub(center);
    const a = this.direction.dot(this.direction);
    const b = 2 * oc.dot(this.direction);
    const c = oc.dot(oc) - radius * radius;
    const roots = solveQuadratic(a, b, c);
    if (!roots) return null;
    if (roots[0] > EPSILON) return roots[0];
    if (roots[1] > EPSILON) return roots[1];
    return null;
  }
  /** Slab-method AABB intersection. Returns { t, normal } or null. */
  intersectAABB(box, withNormal = false) {
    return box.intersectRay(this, withNormal);
  }
  intersectsAABB(box) { return box.intersectRay(this, false) !== null; }
  intersectOBB(obb) {
    // transform ray into OBB local space
    const inv = _m1.copy(obb.matrixWorld).invert();
    const localOrigin = this.origin.clone().applyMatrix4(inv);
    const localDir = this.direction.clone().transformDirection(inv);
    const localRay = new Ray(localOrigin, localDir);
    const hit = obb.localBox.intersectRay(localRay, true);
    if (!hit) return null;
    const point = localRay.at(hit.t, new Vector3());
    const worldPoint = point.clone().applyMatrix4(obb.matrixWorld);
    const worldNormal = hit.normal.clone().transformDirection(obb.matrixWorld).normalize();
    return { t: this.origin.distanceTo(worldPoint), point: worldPoint, normal: worldNormal };
  }
  toJSON() { return { origin: this.origin.toJSON(), direction: this.direction.toJSON() }; }
  static fromJSON(j) { return new Ray(Vector3.fromJSON(j.origin), Vector3.fromJSON(j.direction)); }
  toString() { return `Ray(${this.origin} -> ${this.direction})`; }
}
const _t1 = new Vector3();
const _t2 = new Vector3();
const _m1 = new Matrix4();

// ---------------------------------------------------------------------------
// Plane
// ---------------------------------------------------------------------------
export class Plane {
  constructor(normal = new Vector3(0, 1, 0), constant = 0) {
    this.normal = normal;
    this.constant = constant;
  }
  static new(n, c) { return new Plane(n, c); }
  static fromNormalAndPoint(normal, point) { return new Plane(normal.clone().normalize(), -point.dot(normal.clone().normalize())); }
  static fromPoints(a, b, c) {
    const n = new Vector3().crossVectors(_v1.copy(b).sub(a), _v2.copy(c).sub(a)).normalize();
    return new Plane(n, -a.dot(n));
  }
  static fromCoplanarPoints(a, b, c) { return Plane.fromPoints(a, b, c); }
  set(normal, constant) { this.normal.copy(normal); this.constant = constant; return this; }
  copy(p) { this.normal.copy(p.normal); this.constant = p.constant; return this; }
  clone() { return new Plane(this.normal.clone(), this.constant); }
  normalize() {
    const len = this.normal.magnitude;
    if (len < EPSILON) return this;
    this.normal.scale(1 / len);
    this.constant /= len;
    return this;
  }
  copy(s) { this.normal.copy(s.normal); this.constant = s.constant; return this; }
  /** Sets all four plane coefficients at once (see `Frustum.setFromProjectionMatrix`). */
  setComponents(a, b, c, d) {
    this.normal.set(a, b, c);
    this.constant = d;
    return this;
  }
  /** Normalises (a,b,c,d) together — the constant must be scaled with the normal. */
  normalizeComponents() {
    const len = Math.hypot(this.normal.x, this.normal.y, this.normal.z);
    if (len < EPSILON) return this;
    const inv = 1 / len;
    this.normal.scale(inv);
    this.constant *= inv;
    return this;
  }
  distanceToPoint(p) { return this.normal.dot(p) + this.constant; }
  projectPoint(p, out = new Vector3()) { return out.copy(p).addScaled(this.normal, -this.distanceToPoint(p)); }
  /** Ray-plane intersection returning t or null (rays only hit the front side when cull=true). */
  intersectRay(ray, cull = false) {
    const denom = this.normal.dot(ray.direction);
    if (cull && denom >= 0) return null;
    if (Math.abs(denom) < EPSILON) return null;
    const t = -(ray.origin.dot(this.normal) + this.constant) / denom;
    return t >= 0 ? t : null;
  }
  intersectPlane(plane) {
    const n1 = this.normal, n2 = plane.normal;
    const cross = new Vector3().crossVectors(n1, n2);
    const denom = cross.sqrMagnitude;
    if (denom < EPSILON) return null;
    const p = new Vector3()
      .addScaled(cross, this.constant)
      .addScaled(new Vector3().crossVectors(n2, cross), -plane.constant * 0)
      .addScaled(new Vector3().crossVectors(cross, n1), 0);
    // standard formula
    const point = new Vector3()
      .addScaled(n1, 0)
      .copy(new Vector3()
        .addScaled(new Vector3().crossVectors(n2, cross).scale(-1), 0));
    // Use the closed form: p = (-c1 * (n2 × n1×n2) - c2 * (n1 × n1×n2)) / |n1×n2|²
    const d1 = this.constant, d2 = plane.constant;
    const n1xn2 = cross;
    const A = new Vector3().crossVectors(n2, n1xn2).scale(-d1);
    const B = new Vector3().crossVectors(n1, n1xn2).scale(-d2);
    point.copy(A).add(B).scale(1 / denom);
    const dir = n1xn2.clone().normalize();
    return new Ray(point, dir);
  }
  toJSON() { return { n: this.normal.toJSON(), c: this.constant }; }
  static fromJSON(j) { return new Plane(Vector3.fromJSON(j.n), j.c); }
  toString() { return `Plane(${this.normal}, ${this.constant})`; }
}

// ---------------------------------------------------------------------------
// Sphere
// ---------------------------------------------------------------------------
export class Sphere {
  constructor(center = new Vector3(), radius = 0.5) { this.center = center; this.radius = radius; }
  static new(c, r) { return new Sphere(c, r); }
  static fromPoints(points) {
    const box = new AABB();
    for (const p of points) box.expandByPoint(p);
    const center = box.center(new Vector3());
    let radius = 0;
    for (const p of points) radius = Math.max(radius, center.distanceTo(p));
    return new Sphere(center, radius);
  }
  set(center, radius) { this.center.copy(center); this.radius = radius; return this; }
  copy(s) { this.center.copy(s.center); this.radius = s.radius; return this; }
  clone() { return new Sphere(this.center.clone(), this.radius); }
  containsPoint(p) { return p.distanceToSquared(this.center) <= this.radius * this.radius; }
  intersectsSphere(s) { return this.center.distanceTo(s.center) <= this.radius + s.radius; }
  intersectsPlane(plane) { return Math.abs(plane.distanceToPoint(this.center)) <= this.radius; }
  intersectsBox(box) {
    const closest = new Vector3(
      clamp(this.center.x, box.min.x, box.max.x),
      clamp(this.center.y, box.min.y, box.max.y),
      clamp(this.center.z, box.min.z, box.max.z),
    );
    return closest.distanceToSquared(this.center) <= this.radius * this.radius;
  }
  getBoundingBox() { const r = new Vector3(this.radius, this.radius, this.radius); return new AABB(new Vector3().copy(this.center).sub(r), new Vector3().copy(this.center).add(r)); }
  toString() { return `Sphere(${this.center}, r=${this.radius})`; }
}

// ---------------------------------------------------------------------------
// AABB
// ---------------------------------------------------------------------------
export class AABB {
  constructor(min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)) {
    this.min = min;
    this.max = max;
  }
  static new(min, max) { return new AABB(min, max); }
  static fromCenterSize(center, size) {
    const half = size.clone().scale(0.5);
    return new AABB(center.clone().sub(half), center.clone().add(half));
  }
  static fromPoints(points) {
    const b = new AABB();
    for (const p of points) b.expandByPoint(p);
    return b;
  }
  set(min, max) { this.min.copy(min); this.max.copy(max); return this; }
  copy(b) { this.min.copy(b.min); this.max.copy(b.max); return this; }
  clone() { return new AABB(this.min.clone(), this.max.clone()); }
  makeEmpty() { this.min.set(Infinity, Infinity, Infinity); this.max.set(-Infinity, -Infinity, -Infinity); return this; }
  isEmpty() { return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z; }
  expandByPoint(p) { this.min.min(p); this.max.max(p); return this; }
  expandByVector(v) { this.min.sub(v); this.max.add(v); return this; }
  expandByScalar(s) { this.min.subScalar(s); this.max.addScalar(s); return this; }
  expandByAABB(b) { this.min.min(b.min); this.max.max(b.max); return this; }
  containsPoint(p) {
    return p.x >= this.min.x && p.x <= this.max.x
      && p.y >= this.min.y && p.y <= this.max.y
      && p.z >= this.min.z && p.z <= this.max.z;
  }
  containsBox(b) {
    return this.min.x <= b.min.x && b.max.x <= this.max.x
      && this.min.y <= b.min.y && b.max.y <= this.max.y
      && this.min.z <= b.min.z && b.max.z <= this.max.z;
  }
  intersectsBox(b) {
    return !(b.max.x < this.min.x || b.min.x > this.max.x
      || b.max.y < this.min.y || b.min.y > this.max.y
      || b.max.z < this.min.z || b.min.z > this.max.z);
  }
  intersectsSphere(s) { return s.intersectsBox(this); }
  intersectsPlane(plane) {
    const center = new Vector3().addVectors(this.min, this.max).scale(0.5);
    const extents = new Vector3().subVectors(this.max, this.min).scale(0.5);
    const r = extents.x * Math.abs(plane.normal.x) + extents.y * Math.abs(plane.normal.y) + extents.z * Math.abs(plane.normal.z);
    return Math.abs(plane.distanceToPoint(center)) <= r;
  }
  getCenter(out = new Vector3()) { return out.addVectors(this.min, this.max).scale(0.5); }
  center(out) { return this.getCenter(out); }
  getSize(out = new Vector3()) { return out.subVectors(this.max, this.min); }
  size(out) { return this.getSize(out); }
  getExtents(out = new Vector3()) { return out.subVectors(this.max, this.min).scale(0.5); }
  getVolume() { const s = this.getSize(_v1); return s.x * s.y * s.z; }
  getSurfaceArea() { const s = this.getSize(_v1); return 2 * (s.x * s.y + s.y * s.z + s.z * s.x); }
  /** Slab-method ray intersection returning { t, tmin, tmax, normal, point } or null. */
  intersectRay(ray, withNormal = true) {
    let tmin = -Infinity, tmax = Infinity;
    let hitAxis = -1, hitSign = 1;
    for (let i = 0; i < 3; i++) {
      const o = i === 0 ? ray.origin.x : i === 1 ? ray.origin.y : ray.origin.z;
      const d = i === 0 ? ray.direction.x : i === 1 ? ray.direction.y : ray.direction.z;
      const mn = i === 0 ? this.min.x : i === 1 ? this.min.y : this.min.z;
      const mx = i === 0 ? this.max.x : i === 1 ? this.max.y : this.max.z;
      if (Math.abs(d) < 1e-9) {
        if (o < mn || o > mx) return null;
        continue;
      }
      const invD = 1 / d;
      let t1 = (mn - o) * invD;
      let t2 = (mx - o) * invD;
      let sign = -1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sign = 1; }
      if (t1 > tmin) { tmin = t1; hitAxis = i; hitSign = sign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (tmax < 0) return null;
    const t = tmin >= 0 ? tmin : tmax;
    if (!withNormal) return { t, tmin, tmax, point: null, normal: null };
    const normal = new Vector3();
    if (hitAxis === 0) normal.set(hitSign, 0, 0);
    else if (hitAxis === 1) normal.set(0, hitSign, 0);
    else normal.set(0, 0, hitSign);
    return { t, tmin, tmax, normal, point: ray.at(t, new Vector3()) };
  }
  /** Sweep a sphere against this box; returns { t, normal } of first contact or null. */
  sweepSphere(sphereCenter, radius, velocity, maxDistance = Infinity) {
    const invEntry = new Vector3(), invExit = new Vector3();
    const expandedMin = new Vector3(this.min.x - radius, this.min.y - radius, this.min.z - radius);
    const expandedMax = new Vector3(this.max.x + radius, this.max.y + radius, this.max.z + radius);
    for (let i = 0; i < 3; i++) {
      const o = i === 0 ? sphereCenter.x : i === 1 ? sphereCenter.y : sphereCenter.z;
      const d = i === 0 ? velocity.x : i === 1 ? velocity.y : velocity.z;
      const mn = i === 0 ? expandedMin.x : i === 1 ? expandedMin.y : expandedMin.z;
      const mx = i === 0 ? expandedMax.x : i === 1 ? expandedMax.y : expandedMax.z;
      if (Math.abs(d) < 1e-9) {
        if (o < mn || o > mx) return null;
        (i === 0 ? invEntry : i === 1 ? invEntry : invEntry).set(0, 0, 0);
        continue;
      }
      let t1 = (mn - o) / d;
      let t2 = (mx - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      invEntry.setComponent(i, t1);
      invExit.setComponent(i, t2);
    }
    const entry = Math.max(invEntry.x, invEntry.y, invEntry.z);
    const exit = Math.min(invExit.x, invExit.y, invExit.z);
    if (entry > exit || entry > maxDistance || exit < 0) return null;
    const normal = new Vector3();
    if (entry === invEntry.x) normal.set(velocity.x > 0 ? -1 : 1, 0, 0);
    else if (entry === invEntry.y) normal.set(0, velocity.y > 0 ? -1 : 1, 0);
    else normal.set(0, 0, velocity.z > 0 ? -1 : 1);
    return { t: Math.max(entry, 0), normal };
  }
  applyMatrix4(m) {
    const points = [
      new Vector3(this.min.x, this.min.y, this.min.z).applyMatrix4(m),
      new Vector3(this.max.x, this.min.y, this.min.z).applyMatrix4(m),
      new Vector3(this.min.x, this.max.y, this.min.z).applyMatrix4(m),
      new Vector3(this.min.x, this.min.y, this.max.z).applyMatrix4(m),
      new Vector3(this.max.x, this.max.y, this.min.z).applyMatrix4(m),
      new Vector3(this.max.x, this.min.y, this.max.z).applyMatrix4(m),
      new Vector3(this.min.x, this.max.y, this.max.z).applyMatrix4(m),
      new Vector3(this.max.x, this.max.y, this.max.z).applyMatrix4(m),
    ];
    this.makeEmpty();
    for (const p of points) this.expandByPoint(p);
    return this;
  }
  distanceToPoint(p) {
    const dx = Math.max(this.min.x - p.x, 0, p.x - this.max.x);
    const dy = Math.max(this.min.y - p.y, 0, p.y - this.max.y);
    const dz = Math.max(this.min.z - p.z, 0, p.z - this.max.z);
    return Math.hypot(dx, dy, dz);
  }
  equals(b, eps = 1e-6) { return this.min.equals(b.min, eps) && this.max.equals(b.max, eps); }
  toJSON() { return { min: this.min.toJSON(), max: this.max.toJSON() }; }
  static fromJSON(j) { return new AABB(Vector3.fromJSON(j.min), Vector3.fromJSON(j.max)); }
  toString() { return `AABB(${this.min} .. ${this.max})`; }
}

// ---------------------------------------------------------------------------
// OBB
// ---------------------------------------------------------------------------
export class OBB {
  constructor(center = new Vector3(), halfExtents = new Vector3(0.5, 0.5, 0.5), rotation = null) {
    this.center = center;
    this.halfExtents = halfExtents;
    this.rotation = rotation; // Quaternion
    this.matrixWorld = new Matrix4();
    this.localBox = new AABB(halfExtents.clone().negate(), halfExtents.clone());
    this.update();
  }
  static fromAABB(box) { return new OBB().fromAABB(box); }
  fromAABB(box) {
    const center = box.center(new Vector3());
    const size = box.size(new Vector3());
    this.center = center;
    this.halfExtents = size.scale(0.5);
    this.rotation = null;
    this.update();
    return this;
  }
  update() {
    if (this.rotation) {
      this.matrixWorld.compose(this.center, this.rotation, _v1.set(1, 1, 1));
    } else {
      this.matrixWorld.makeTranslation(this.center.x, this.center.y, this.center.z);
    }
    this.localBox.min.copy(this.halfExtents).negate();
    this.localBox.max.copy(this.halfExtents);
    return this;
  }
  getBoundingBox() {
    const b = new AABB(this.localBox.min.clone(), this.localBox.max.clone());
    return b.applyMatrix4(this.matrixWorld);
  }
  containsPoint(p) {
    const local = p.clone().applyMatrix4(_m1.copy(this.matrixWorld).invert());
    return this.localBox.containsPoint(local);
  }
  intersectsOBB(other) {
    // Separating Axis Theorem, 15 axes
    const a = this, b = other;
    const axesA = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((v) => v.transformDirection(a.matrixWorld));
    const axesB = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((v) => v.transformDirection(b.matrixWorld));
    const centerDelta = b.center.clone().sub(a.center);
    const test = (axis) => {
      if (axis.sqrMagnitude < 1e-12) return true;
      axis.normalize();
      let ra = 0, rb = 0;
      for (let i = 0; i < 3; i++) {
        ra += Math.abs(axesA[i].dot(axis)) * (i === 0 ? a.halfExtents.x : i === 1 ? a.halfExtents.y : a.halfExtents.z);
        rb += Math.abs(axesB[i].dot(axis)) * (i === 0 ? b.halfExtents.x : i === 1 ? b.halfExtents.y : b.halfExtents.z);
      }
      const d = Math.abs(centerDelta.dot(axis));
      return d <= ra + rb + 1e-6;
    };
    for (const ax of axesA) if (!test(ax)) return false;
    for (const ax of axesB) if (!test(ax)) return false;
    for (const ax of axesA) for (const bx of axesB) if (!test(new Vector3().crossVectors(ax, bx))) return false;
    return true;
  }
  intersectsAABB(box) { return this.intersectsOBB(OBB.fromAABB(box)); }
  toString() { return `OBB(c=${this.center}, h=${this.halfExtents})`; }
}

// ---------------------------------------------------------------------------
// Triangle & helpers
// ---------------------------------------------------------------------------
export class Triangle {
  constructor(a = new Vector3(), b = new Vector3(), c = new Vector3()) { this.a = a; this.b = b; this.c = c; }
  static new(a, b, c) { return new Triangle(a, b, c); }
  static fromPoints(a, b, c) { return new Triangle(a, b, c); }
  set(a, b, c) { this.a.copy(a); this.b.copy(b); this.c.copy(c); return this; }
  getNormal(out = new Vector3()) { return out.crossVectors(_v1.copy(this.b).sub(this.a), _v2.copy(this.c).sub(this.a)).normalize(); }
  getMidpoint(out = new Vector3()) { return out.copy(this.a).add(this.b).add(this.c).scale(1 / 3); }
  getArea() { return _v3.crossVectors(_v1.copy(this.b).sub(this.a), _v2.copy(this.c).sub(this.a)).magnitude * 0.5; }
  getBarycoord(p, out = new Vector3()) {
    const v0 = _v1.copy(this.c).sub(this.a), v1 = _v2.copy(this.b).sub(this.a), v2 = _v3.copy(p).sub(this.a);
    const dot00 = v0.dot(v0), dot01 = v0.dot(v1), dot02 = v0.dot(v2), dot11 = v1.dot(v1), dot12 = v1.dot(v2);
    const denom = dot00 * dot11 - dot01 * dot01;
    if (denom === 0) return out.set(0, 0, 0);
    const u = (dot11 * dot02 - dot01 * dot12) / denom;
    const v = (dot00 * dot12 - dot01 * dot02) / denom;
    return out.set(1 - u - v, v, u);
  }
  containsPoint(p) {
    const bc = this.getBarycoord(p, new Vector3());
    return bc.x >= -1e-6 && bc.y >= -1e-6 && bc.z >= -1e-6;
  }
  closestPointToPoint(p, out = new Vector3()) {
    const ab = _v1.copy(this.b).sub(this.a);
    const ac = _v2.copy(this.c).sub(this.a);
    const ap = _v3.copy(p).sub(this.a);
    const d1 = ab.dot(ap), d2 = ac.dot(ap);
    if (d1 <= 0 && d2 <= 0) return out.copy(this.a);
    const bp = p.clone().sub(this.b);
    const d3 = ab.dot(bp), d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) return out.copy(this.b);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return out.copy(this.a).addScaled(ab, v); }
    const cp = p.clone().sub(this.c);
    const d5 = ab.dot(cp), d6 = ac.dot(cp);
    if (d6 >= 0 && d5 <= d6) return out.copy(this.c);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return out.copy(this.a).addScaled(ac, w); }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      return out.copy(this.b).addScaled(_v1.copy(this.c).sub(this.b), w);
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    return out.copy(this.a).addScaled(ab, v).addScaled(ac, w);
  }
}

// ---------------------------------------------------------------------------
// Frustum (6 planes)
// ---------------------------------------------------------------------------
export class Frustum {
  constructor(planes = [new Plane(), new Plane(), new Plane(), new Plane(), new Plane(), new Plane()]) {
    this.planes = planes;
  }
  /**
   * Extracts six clipping planes from a projection (or view-projection) matrix.
   *
   * The plane must be normalised as a whole 4-vector: normalising only (a,b,c) leaves the
   * constant unscaled, which silently puts the near/far planes in the wrong place and culls
   * visible geometry. (The near/far rows have a tiny normal magnitude, so the scale factor
   * there is enormous.)
   */
  setFromProjectionMatrix(m, normalize = true) {
    const me = m.elements;
    const p = this.planes;
    p[0].setComponents(me[3] - me[0], me[7] - me[4], me[11] - me[8], me[15] - me[12]);
    p[1].setComponents(me[3] + me[0], me[7] + me[4], me[11] + me[8], me[15] + me[12]);
    p[2].setComponents(me[3] + me[1], me[7] + me[5], me[11] + me[9], me[15] + me[13]);
    p[3].setComponents(me[3] - me[1], me[7] - me[5], me[11] - me[9], me[15] - me[13]);
    p[4].setComponents(me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]);
    p[5].setComponents(me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]);
    if (normalize) for (const plane of p) plane.normalizeComponents();
    return this;
  }
  set(m) { return this.setFromProjectionMatrix(m); }
  /** AABB / Sphere visibility test (the standard positive-vertex test). */
  intersectsObject(boxOrSphere) {
    if (boxOrSphere instanceof Sphere || (boxOrSphere.radius !== undefined && !boxOrSphere.min)) {
      for (const plane of this.planes) if (plane.distanceToPoint(boxOrSphere.center) < -boxOrSphere.radius) return false;
      return true;
    }
    const box = boxOrSphere;
    const center = box.center(_v1);
    const extents = box.getExtents ? box.getExtents(_v2) : _v2.copy(box.max).sub(box.min).scale(0.5);
    for (const plane of this.planes) {
      const r = extents.x * Math.abs(plane.normal.x) + extents.y * Math.abs(plane.normal.y) + extents.z * Math.abs(plane.normal.z);
      if (plane.distanceToPoint(center) < -r) return false;
    }
    return true;
  }
  intersectsBox(box) { return this.intersectsObject(box); }
  containsPoint(p) {
    for (const plane of this.planes) if (plane.distanceToPoint(p) < 0) return false;
    return true;
  }
  intersectsSphere(sphere) {
    for (const plane of this.planes) if (plane.distanceToPoint(sphere.center) < -sphere.radius) return false;
    return true;
  }
  /** 8 corner points of the frustum in world space (for shadow-cascade fitting). */
  getCorners(projScreenMatrix, out = null) {
    const inv = _m1.copy(projScreenMatrix).invert();
    const corners = out ?? Array.from({ length: 8 }, () => new Vector3());
    let i = 0;
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          const p = corners[i++];
          p.set(x * 2 - 1, y * 2 - 1, z * 2 - 1).applyMatrix4(inv);
        }
      }
    }
    return corners;
  }
  clone() { return new Frustum(this.planes.map((p) => p.clone())); }
}

export const GeometryUtils = { Ray, Plane, Sphere, AABB, OBB, Triangle, Frustum };
export default GeometryUtils;
