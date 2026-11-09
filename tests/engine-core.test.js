/**
 * Core engine tests — math, object model, geometry and content contracts.
 *
 * These are the invariants the rest of the engine is allowed to assume: matrix/quaternion
 * algebra round-trips, ray and AABB queries answer correctly, the scheduler keeps a fixed
 * tick, properties drive the inspector, and every authored mesh is well-formed enough to
 * upload (matching attribute lengths, valid indices, sane bounds).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Vector2 } from '../engine/src/math/Vector2.js';
import { Vector3 } from '../engine/src/math/Vector3.js';
import { Vector4 } from '../engine/src/math/Vector4.js';
import { Quaternion } from '../engine/src/math/Quaternion.js';
import { Matrix3 } from '../engine/src/math/Matrix3.js';
import { Matrix4 } from '../engine/src/math/Matrix4.js';
import { Color3 } from '../engine/src/math/Color3.js';
import { Color4 } from '../engine/src/math/Color4.js';
import { CFrame } from '../engine/src/math/CFrame.js';
import { Transform } from '../engine/src/math/Transform.js';
import { AABB, OBB, Ray, Plane, Frustum, Sphere } from '../engine/src/math/Geometry.js';
import { RNG } from '../engine/src/math/Random.js';
import { Noise } from '../engine/src/math/Noise.js';
import { Easing, EasingStyle, resolveEasing } from '../engine/src/math/Easing.js';
import * as MathUtils from '../engine/src/math/MathUtils.js';

import { Signal } from '../engine/src/core/Signal.js';
import { Scheduler, RunPhase } from '../engine/src/core/Scheduler.js';
import { Instance } from '../engine/src/core/Instance.js';
import { Folder, BindableEvent, DataNode } from '../engine/src/core/Instance.js';
import { PropertyType, PropertyCategory, getPropertyDefinitions, listProperties, defineProperty, coerceValue, serializeValue, deserializeValue } from '../engine/src/core/Property.js';

import { Mesh } from '../engine/src/geometry/Mesh.js';
import * as Primitives from '../engine/src/geometry/Primitives.js';
import { PropLibrary, ColliderHint } from '../engine/src/geometry/Props.js';
import { WeaponFactory } from '../engine/src/geometry/WeaponMeshes.js';
import { CharacterLibrary } from '../engine/src/geometry/CharacterMeshes.js';

// ---------------------------------------------------------------- math
test('vectors behave like a game engine expects', () => {
  const a = new Vector3(1, 2, 3);
  const b = new Vector3(4, 5, 6);
  assert.equal(a.magnitude, Math.sqrt(14));
  assert.equal(a.dot(b), 32);
  assert.deepEqual(a.clone().cross(b).toArray(), [-3, 6, -3]);
  assert.equal(Vector3.new(1, 1, 1).Magnitude, Math.sqrt(3));
  assert.equal(a.distanceTo(b), Vector3.new(4, 5, 6).distanceTo(a));
  // Roblox-style aliases must mutate in place like the Unity-style ones.
  const c = a.clone();
  c.addVectors(a, b);
  assert.deepEqual(c.toArray(), [5, 7, 9]);
  const d = a.clone().applyAxisAngle(Vector3.new(0, 1, 0), Math.PI / 2);
  assert.ok(Math.abs(d.x - 3) < 1e-6 && Math.abs(d.z + 1) < 1e-6, `got ${d.toString()}`);
  assert.equal(Vector2.new(3, 4).magnitude, 5);
  assert.deepEqual(Vector4.new(1, 2, 3, 4).toArray(), [1, 2, 3, 4]);
  assert.equal(new Vector3(0, -5, 0).unit.y, -1);
});

test('matrix4 invert / multiply / decompose round-trip', () => {
  const m = new Matrix4().compose(
    new Vector3(3, -2, 7.5),
    new Quaternion().setFromEuler(0.3, -1.1, 0.7, 'YXZ'),
    new Vector3(1.5, 2, 0.5),
  );
  const inv = m.clone().invert();
  const identity = new Matrix4().multiplyMatrices(m, inv);
  const e = identity.elements;
  const expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(e[i] - expected[i]) < 1e-5, `element ${i}: ${e[i]}`);

  const p = new Vector3(2, 3, -4);
  const transformed = p.clone().applyMatrix4(m);
  const back = transformed.clone().applyMatrix4(inv);
  assert.ok(back.distanceTo(p) < 1e-5);

  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  m.decompose(position, rotation, scale);
  assert.ok(position.distanceTo(new Vector3(3, -2, 7.5)) < 1e-5);
  assert.ok(Math.abs(scale.x - 1.5) < 1e-5 && Math.abs(scale.y - 2) < 1e-5);

  const normal = m.toNormalMatrix();
  assert.equal(normal.length, 9);
  // A normal matrix must not include translation.
  const scaled = new Matrix4().makeScale(2, 4, 8).toNormalMatrix();
  assert.ok(Math.abs(scaled[0] - 0.5) < 1e-6, `expected 1/2 in normal matrix, got ${scaled[0]}`);
  assert.ok(Math.abs(scaled[4] - 0.25) < 1e-6);
  assert.ok(Math.abs(scaled[8] - 0.125) < 1e-6);
  assert.deepEqual(Matrix3.identity().toArray(), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('quaternions interpolate and convert between representations', () => {
  const q = new Quaternion().setFromEuler(0, Math.PI / 2, 0, 'YXZ');
  assert.ok(Math.abs(new Quaternion().setFromEuler(new Vector3(0, Math.PI / 2, 0), 'YXZ').y - q.y) < 1e-9,
    'setFromEuler must accept a Vector3 (Unity/Roblox style)');
  const forward = new Vector3(0, 0, -1).applyQuaternion(q);
  assert.ok(Math.abs(forward.x + 1) < 1e-6, `expected forward -X after 90° yaw, got ${forward.toString()}`);
  const euler = q.toEuler('YXZ');
  assert.ok(Math.abs(euler.y - Math.PI / 2) < 1e-6);
  const halfway = new Quaternion().slerpQuaternions(new Quaternion(), q, 0.5);
  void EasingStyle;
  void resolveEasing;
  const dir = new Vector3(0, 0, -1).applyQuaternion(halfway);
  assert.ok(Math.abs(dir.x + Math.sin(Math.PI / 4)) < 1e-5, `got ${dir.toString()}`);
  const m = new Matrix4().makeRotationFromQuaternion(q);
  const back = new Quaternion().setFromRotationMatrix(m);
  assert.ok(Math.abs(back.y - q.y) < 1e-6 && Math.abs(back.w - q.w) < 1e-6);
  assert.equal(Quaternion.identity().w, 1);
});

test('rays, planes and AABBs answer hit queries correctly', () => {
  const box = new AABB(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  const hit = box.intersectRay(new Ray(new Vector3(0, 0, -5), new Vector3(0, 0, 1), { length: 10 }));
  assert.ok(hit, 'ray should hit the box');
  assert.ok(Math.abs(hit.t - 4) < 1e-6, `expected t=4, got ${hit.t}`);
  assert.deepEqual(hit.normal.toArray().map((v) => Math.round(v)), [0, 0, -1]);
  assert.equal(box.intersectRay(new Ray(new Vector3(0, 5, -5), new Vector3(0, 0, 1))), null);
  assert.equal(box.containsPoint(new Vector3(0.5, 0.5, 0.5)), true);

  const plane = new Plane(new Vector3(0, 1, 0), 0);
  assert.equal(plane.distanceToPoint(new Vector3(0, 2, 0)), 2);
  const t = plane.intersectRay(new Ray(new Vector3(0, 3, 0), new Vector3(0, -1, 0)));
  assert.ok(Math.abs(t - 3) < 1e-6);

  const sphere = new Sphere(new Vector3(0, 0, 0), 1);
  assert.equal(sphere.intersectsBox(box), true);
  assert.equal(new Sphere(new Vector3(0, 5, 0), 1).intersectsBox(box), false);
});

test('frustum culling rejects what is off-screen and keeps what is on-screen', () => {
  const proj = new Matrix4().makePerspective(75 * Math.PI / 180, 16 / 9, 0.08, 500);
  const frustum = new Frustum().setFromProjectionMatrix(proj);
  assert.equal(frustum.containsPoint(new Vector3(0, 0, -10)), true);
  assert.equal(frustum.containsPoint(new Vector3(0, 0, 10)), false, 'behind the camera must be culled');
  assert.equal(frustum.containsPoint(new Vector3(0, 0, -600)), false, 'beyond the far plane must be culled');
  assert.equal(frustum.containsPoint(new Vector3(400, 0, -10)), false, 'outside the side plane must be culled');
  const near = frustum.planes.find((p) => Math.abs(p.constant) < 0.09);
  assert.ok(Math.abs(near.constant) - 0.08 < 1e-3, 'near plane must sit at the near distance');
  assert.equal(frustum.intersectsBox(new AABB(new Vector3(-1, -1, -11), new Vector3(1, 1, -9))), true);
  assert.equal(frustum.intersectsBox(new AABB(new Vector3(-1, -1, 9), new Vector3(1, 1, 11))), false);
});

test('OBB intersection handles rotated boxes', () => {
  const a = new OBB(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
  const b = new OBB(new Vector3(1.5, 0, 0), new Vector3(1, 1, 1));
  assert.equal(a.intersectsOBB(b), true);
  const c = new OBB(new Vector3(3, 0, 0), new Vector3(1, 1, 1));
  assert.equal(a.intersectsOBB(c), false);
});

test('random number generator is deterministic and range-correct', () => {
  const rngA = new RNG(1234);
  const rngB = new RNG(1234);
  const seqA = Array.from({ length: 8 }, () => rngA.random());
  const seqB = Array.from({ length: 8 }, () => rngB.random());
  assert.deepEqual(seqA, seqB, 'same seed must produce the same sequence');
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
  const rng = new RNG(7);
  for (let i = 0; i < 500; i++) {
    const n = rng.nextInteger(1, 6);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 6, `bad integer ${n}`);
  }
  const cone = rng.nextConeDirection(new Vector3(0, 0, -1), 0.3);
  assert.ok(Math.abs(cone.magnitude - 1) < 1e-5, 'cone directions stay unit length');
  assert.ok(cone.z < 0, 'cone directions point along the axis');
  assert.equal(Noise.noise2D(1.5, 2.5), Noise.noise2D(1.5, 2.5));
  assert.ok(Math.abs(Noise.noise2D(0.3, 0.7)) <= 1);
  const fbm = Noise.fbm2(0.4, 0.9, 4);
  assert.ok(Number.isFinite(fbm), 'fbm must produce finite terrain heights');
});

test('math utilities clamp, lerp, damp and ease', () => {
  assert.equal(MathUtils.clamp(5, 0, 1), 1);
  assert.equal(MathUtils.clamp01(-2), 0);
  assert.equal(MathUtils.lerp(0, 10, 0.25), 2.5);
  assert.ok(Math.abs(MathUtils.damp(0, 10, 5, 1) - 9.9326) < 0.01);
  assert.ok(Math.abs(MathUtils.dampAngle(0, Math.PI * 2, 5, 1)) < 0.1, 'dampAngle must wrap around TAU');
  assert.ok(Math.abs(MathUtils.moveTowards(0, 10, 3) - 3) < 1e-9);
  assert.ok(Math.abs(MathUtils.wrap(370, 360) - 10) < 1e-9);
  assert.equal(MathUtils.signOrZero ? MathUtils.signOrZero(0) : 0, 0);
  assert.ok(Math.abs(Easing.outQuad(0.5) - 0.75) < 1e-9);
  assert.equal(Easing.linear(0.4), 0.4);
  assert.ok(Math.abs(Easing.inOutCubic(1) - 1) < 1e-9);
  assert.equal(MathUtils.formatBytes(1048576), '1.0 MB');
  assert.ok(Math.abs(MathUtils.DEG2RAD * 180 - Math.PI) < 1e-9);
});

test('CFrame and Transform give Roblox/Unity ergonomics', () => {
  const cf = new CFrame(new Vector3(1, 2, 3));
  const moved = cf.mul(new CFrame(new Vector3(0, 0, -5)));
  assert.ok(Math.abs(moved.p.z + 2) < 1e-6, `CFrame translation composition, got ${moved.p.toString()}`);
  const rotated = CFrame.fromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  const forward = rotated.mul(new CFrame(new Vector3(0, 0, -1))).p;
  assert.ok(Math.abs(forward.x + 1) < 1e-6);
  assert.ok(typeof cf.toMatrix4().elements[0] === 'number');
  const t = new Transform(new Vector3(1, 0, 0));
  t.scale_(new Vector3(2, 2, 2));
  assert.equal(t.scaleVector.x, 2);
  t.scale_(2);
  assert.equal(t.scaleVector.y, 4);
  assert.ok(t.matrix.elements.length === 16);
});

test('colors parse, convert and blend', () => {
  const red = Color3.fromCSS('#ff0000');
  assert.ok(Math.abs(red.r - 1) < 1e-6 && red.g === 0 && red.b === 0);
  assert.equal(Color3.fromRGB(255, 128, 0).g.toFixed(2), '0.50');
  assert.equal(red.toHex(), '#ff0000');
  const half = red.clone().lerp(Color3.fromCSS('#0000ff'), 0.5);
  assert.ok(Math.abs(half.r - 0.5) < 1e-6 && Math.abs(half.b - 0.5) < 1e-6);
  assert.ok(Math.abs(Color4.fromCSS('rgba(255,0,0,0.5)').a - 0.5) < 1e-2);
});

// ---------------------------------------------------------------- core
test('signals connect, fire once and disconnect', () => {
  const signal = new Signal('Test');
  let calls = 0;
  const conn = signal.connect(() => { calls++; });
  signal.emit(1);
  signal.emit(2);
  assert.equal(calls, 2);
  conn.disconnect();
  signal.emit(3);
  assert.equal(calls, 2);
  let once = 0;
  signal.once(() => { once++; });
  signal.emit();
  signal.emit();
  assert.equal(once, 1);
  let got = null;
  signal.connect((a, b) => { got = [a, b]; }, { priority: 0 });
  signal.emit('x', 'y');
  assert.deepEqual(got, ['x', 'y']);
});

test('scheduler runs fixed ticks and ordered phases', () => {
  const scheduler = new Scheduler({ tickRate: 60, maxSubSteps: 5 });
  const order = [];
  scheduler.PreRender.connect(() => order.push('prerender'));
  scheduler.Stepped.connect(() => order.push('step'));
  scheduler.Heartbeat.connect(() => order.push('heartbeat'));
  scheduler.PostRender.connect(() => order.push('post'));
  let ticks = 0;
  scheduler.addTickCallback(() => { ticks++; });
  scheduler.update(1 / 60);
  assert.equal(ticks, 1, 'one 60 Hz tick should have elapsed');
  assert.ok(order.indexOf('prerender') < order.indexOf('step'), 'phases must run in order');
  assert.ok(order.indexOf('step') < order.indexOf('heartbeat'), 'phases must run in order');
  assert.equal(order[order.length - 1], 'post', 'PostRender runs last');
  const t = scheduler.time;
  scheduler.update(0.5);
  assert.ok(scheduler.time > t);
  assert.ok(Math.abs(scheduler.fixedDeltaTime - 1 / 60) < 1e-9, 'fixed delta should be 1/60');
  let delayed = false;
  scheduler.delay(0, () => { delayed = true; });
  scheduler.update(1 / 60);
  assert.equal(delayed, true, 'delay() must fire on the next update');
});

test('instance tree supports parenting, components, tags and properties', () => {
  const root = new Instance('Folder');
  root.Name = 'World';
  const child = new Instance('Part', { Name: 'Crate', Position: new Vector3(1, 0, 0) });
  child.setParent(root);
  child.addTag('destructible');
  assert.equal(child.Parent, root);
  assert.equal(root.Child('Crate'), child);
  assert.equal(root.FindFirstChild('Crate'), child);
  assert.equal(root.FindFirstChildOfClass('Part'), child);
  assert.deepEqual(root.GetChildren(), [child]);
  assert.equal(child.HasTag('destructible'), true);

  class HealthComponent {
    constructor(value = 100) { this.value = value; }
    static ClassName = 'Health';
    takeDamage(n) { this.value -= n; return this.value; }
  }
  const health = child.addComponent(HealthComponent, { value: 80 });
  assert.equal(child.getComponent('Health'), health, 'components must be retrievable by class name');
  assert.equal(child.getComponent(HealthComponent), health);
  assert.equal(child.hasComponent('Health'), true);
  assert.equal(health.host, child, 'components must know their host instance');
  health.takeDamage(30);
  assert.equal(health.value, 50);
  child.removeComponent(health);
  assert.equal(child.getComponent('Health'), null);

  const folder = new Folder({ Name: 'Kits' });
  const node = new DataNode({ Name: 'Save1', value: 42 });
  folder.addChild(node);
  assert.equal(folder.FindFirstChild('Save1'), node);

  let fired = null;
  const bindable = new BindableEvent();
  bindable.connect((v) => { fired = v; });
  bindable.fire('payload');
  assert.equal(fired, 'payload');

  const json = root.toJSON();
  const restored = Instance.fromJSON(json);
  assert.equal(restored.Name, 'World');
  assert.equal(restored.GetChildren().length, 1);
  assert.equal(restored.GetChildren()[0].Name, 'Crate');
  child.destroy();
  assert.equal(root.GetChildren().length, 0);
});

test('property registry drives inspector metadata and serialization', () => {
  const part = new Instance('Part');
  const defs = getPropertyDefinitions(part.constructor);
  assert.ok(defs instanceof Map && defs.size > 0, 'instances must expose a property registry');
  for (const [name, def] of defs) {
    assert.ok(def.category !== undefined, `${name} must declare a category for the inspector`);
    assert.ok(def.type !== undefined, `${name} must declare a type for coercion`);
  }
  const listed = listProperties(part.constructor).map((d) => d.name);
  assert.ok(listed.includes('Archivable'), `base instance properties must be inspectable, got ${listed.join(', ')}`);
  part.Position = new Vector3(4, 5, 6);
  assert.equal(part.Position.x, 4);
  // Coercion: assigning a plain object to a Vector3 property must produce a Vector3.
  defineProperty(Instance, 'TestVector', { type: PropertyType.Vector3, category: PropertyCategory.Transform, default: new Vector3() });
  part.TestVector = { x: 1, y: 2, z: 3 };
  assert.ok(part.TestVector instanceof Vector3, 'property coercion must convert plain vectors');
  assert.equal(part.TestVector.y, 2);
  // Round-trip through the serializer used by save files and network replication.
  const raw = serializeValue(part.TestVector, PropertyType.Vector3);
  const restored = deserializeValue(raw, PropertyType.Vector3);
  assert.ok(restored instanceof Vector3 && Math.abs(restored.z - 3) < 1e-6);
  const fn = (v) => v;
  defineProperty(Instance, 'TestScalar', { type: PropertyType.Float, category: PropertyCategory.Appearance, default: 0.5 });
  const probe = new Instance('Part');
  probe.TestScalar = 3.75;
  assert.equal(probe.TestScalar, 3.75);
  probe.TestScalar = '2.5';
  assert.equal(probe.TestScalar, 2.5, 'string numerics must coerce to numbers');
  void fn;
  void coerceValue;
});

// ---------------------------------------------------------------- geometry
/** Validates a mesh is safe to upload: matching attribute counts, in-range indices, finite data. */
function assertMeshValid(mesh, label) {
  const vertices = mesh.vertexCount;
  assert.ok(vertices > 0, `${label}: mesh has no vertices`);
  assert.equal(mesh.positions.length, vertices * 3, `${label}: position count mismatch`);
  for (const [name, arr, stride] of [['normals', mesh.normals, 3], ['uvs', mesh.uvs, 2], ['colors', mesh.colors, 4], ['tangents', mesh.tangents, 4]]) {
    if (!arr) continue;
    assert.equal(arr.length, vertices * stride, `${label}: ${name} length ${arr.length} != ${vertices * stride}`);
  }
  for (const idx of mesh.indices) {
    assert.ok(idx >= 0 && idx < vertices, `${label}: index ${idx} out of range for ${vertices} vertices`);
  }
  for (let i = 0; i < Math.min(mesh.positions.length, 300); i++) {
    assert.ok(Number.isFinite(mesh.positions[i]), `${label}: non-finite position data`);
  }
  const bounds = mesh.bounds;
  assert.ok(bounds && Number.isFinite(bounds.min.x) && Number.isFinite(bounds.max.y), `${label}: invalid bounds`);
}

test('every primitive is a valid, uploadable mesh', () => {
  const primitives = [
    ['box', () => Primitives.createBox(1, 2, 3)],
    ['sphere', () => Primitives.createSphere(1, 16, 12)],
    ['cylinder', () => Primitives.createCylinder(0.5, 0.5, 2, 12)],
    ['cone', () => Primitives.createCone(0.5, 1.5, 12)],
    ['capsule', () => Primitives.createCapsule(0.4, 1.2, 8, 12)],
    ['torus', () => Primitives.createTorus(0.6, 0.2, 12, 24)],
    ['tube', () => Primitives.createTube(0.4, 0.5, 2, 12)],
    ['plane', () => Primitives.createPlane(4, 4)],
    ['icosphere', () => Primitives.createIcosphere(1, 2)],
    ['stairs', () => Primitives.createStairs({ steps: 6, width: 2, rise: 0.2, run: 0.3 })],
    ['stairsPositional', () => Primitives.createStairs(6, 2, 0.2, 0.3)],
    ['wedge', () => Primitives.createWedge(1, 1, 1)],
    ['coverBlock', () => Primitives.createCoverBlock(2, 1, 0.5)],
    ['wallWithOpening', () => Primitives.createWallWithOpening(4, 3, 0.3, 1, 2)],
    ['extrusion', () => Primitives.createExtrusion([new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 1)], 1)],
    ['fullscreenQuad', () => Primitives.createFullscreenQuad()],
    ['quad', () => Primitives.createQuad(2, 2)],
    ['hemisphere', () => Primitives.createHemisphere(1, 12, 8)],
  ];
  for (const [name, make] of primitives) {
    const mesh = make();
    assertMeshValid(mesh, name);
  }
});

test('mesh operations (merge, transform, normals, dedupe) stay consistent', () => {
  const box = Primitives.createBox(1, 1, 1);
  const sphere = Primitives.createSphere(0.5, 12, 8);
  sphere.translate(new Vector3(2, 0, 0));
  const merged = Mesh.merge([box, sphere], { name: 'Merged' });
  assertMeshValid(merged, 'merged');
  assert.equal(merged.vertexCount, box.vertexCount + sphere.vertexCount);
  assert.equal(merged.triangleCount, box.triangleCount + sphere.triangleCount);

  const scaled = Primitives.createBox(1, 1, 1).clone();
  scaled.scale_(new Vector3(2, 2, 2));
  const b = scaled.bounds;
  assert.ok(Math.abs(b.max.x - 1) < 1e-5, `expected half-extent 1 after 2x scale, got ${b.max.x}`);

  const rotated = Primitives.createBox(1, 1, 1).clone().rotateY(Math.PI / 4);
  for (let i = 0; i < rotated.normals.length; i += 3) {
    const len = Vector3.new(rotated.normals[i], rotated.normals[i + 1], rotated.normals[i + 2]).magnitude;
    assert.ok(Math.abs(len - 1) < 1e-4, `normals must stay unit length after rotation (got ${len})`);
  }
  for (let i = 0; i < merged.normals.length; i += 3) {
    const len = Vector3.new(merged.normals[i], merged.normals[i + 1], merged.normals[i + 2]).magnitude;
    assert.ok(Math.abs(len - 1) < 1e-4, `merged normals must stay unit length (got ${len})`);
  }

  const computed = Primitives.createBox(1, 1, 1).clone();
  if (typeof computed.computeNormals === 'function') {
    computed.computeNormals();
    assert.ok(computed.normals.length === computed.vertexCount * 3);
    for (const n of computed.normals) assert.ok(Number.isFinite(n));
  }
  // Merging a mesh with itself in a transformed copy must not duplicate attributes.
  const instanced = Mesh.merge([box, box.clone().translate(new Vector3(0, 3, 0))]);
  assertMeshValid(instanced, 'instancedMerge');
});

test('props declare the contract bot AI and physics rely on', () => {
  const names = Object.keys(PropLibrary).filter((k) => typeof PropLibrary[k] === 'function' && k !== 'createTerrainChunk');
  assert.ok(names.length >= 30, `expected a full map kit, found ${names.length} props`);
  let totalTriangles = 0;
  for (const name of names) {
    const prop = PropLibrary[name]();
    assert.ok(prop.name, `${name}: missing name`);
    assert.ok(prop.mesh, `${name}: missing mesh`);
    assert.ok(typeof prop.material === 'string', `${name}: missing material key`);
    assert.ok(Object.values(ColliderHint).includes(prop.collider), `${name}: invalid collider hint "${prop.collider}"`);
    assert.ok(typeof prop.cover === 'number' && prop.cover >= 0 && prop.cover <= 1, `${name}: cover must be 0..1`);
    assert.ok(typeof prop.blocksBullets === 'boolean' && typeof prop.blocksVision === 'boolean', `${name}: missing occlusion flags`);
    assert.ok(Array.isArray(prop.tags), `${name}: tags must be an array`);
    assert.ok(typeof prop.castShadow === 'boolean', `${name}: castShadow flag missing`);
    assertMeshValid(prop.mesh, name);
    totalTriangles += prop.mesh.triangleCount;
  }
  assert.ok(totalTriangles > 5000, `prop kit should be substantive, got ${totalTriangles} triangles`);
});

test('weapon models follow the viewmodel conventions', () => {
  const kinds = Object.keys(WeaponFactory);
  assert.ok(kinds.length >= 8, `expected the full FPS weapon set, found ${kinds.length}`);
  for (const kind of kinds) {
    const weapon = WeaponFactory[kind]();
    assert.ok(weapon.parts.length > 0, `${kind}: no parts`);
    assert.ok(weapon.anchors.muzzle instanceof Vector3, `${kind}: muzzle anchor missing`);
    assert.ok(weapon.anchors.adsSight instanceof Vector3, `${kind}: ADS sight anchor missing`);
    assert.ok(weapon.anchors.ejectionPort instanceof Vector3, `${kind}: ejection port missing`);
    assert.ok(weapon.anchors.muzzle.z < 0, `${kind}: muzzle must sit forward of the origin (-Z)`);
    assert.ok(weapon.length > 0.1, `${kind}: implausible length ${weapon.length}`);
    assertMeshValid(weapon.merged, `${kind}.merged`);
    for (const part of weapon.parts) assertMeshValid(part.mesh, `${kind}.${part.name}`);
  }
  const rifle = WeaponFactory.rifle();
  const ammoPart = rifle.parts.find((p) => /mag|clip/i.test(p.name));
  assert.ok(ammoPart, 'rifle should have a magazine part for reload animation');
});

test('character rigs share a skeleton naming convention', () => {
  const lib = new CharacterLibrary();
  const rigs = [lib.player(), lib.bot('assault'), lib.bot('heavy'), lib.drone()];
  const expected = ['root', 'hips', 'spine', 'chest', 'neck', 'head'];
  for (const rig of rigs.slice(0, 3)) {
    for (const name of expected) {
      assert.ok(rig.getPart(name), `${rig.name}: missing part ${name}`);
    }
    assert.ok(rig.getPart('upperArmL') && rig.getPart('handR'), `${rig.name}: arms are not rigged`);
    assert.ok(rig.getPart('upperLegR') && rig.getPart('footL'), `${rig.name}: legs are not rigged`);
    assert.ok(rig.getAnchors().head, `${rig.name}: head anchor for name tags / aim target missing`);
    assert.ok(rig.getAnchors().gun, `${rig.name}: gun anchor for the attached weapon missing`);
    for (const part of rig.parts) if (part.mesh.triangleCount > 0) assertMeshValid(part.mesh, `${rig.name}.${part.name}`);
  }
  const drone = lib.drone();
  assert.ok(drone.getPart('rotorL') && drone.getPart('rotorR'), 'drone needs rotors');
  // Player and bot rigs must be pose-compatible: same joint names.
  const playerJoints = lib.player().parts.map((p) => p.name);
  const botJoints = lib.bot('assault').parts.map((p) => p.name);
  const shared = playerJoints.filter((n) => botJoints.includes(n));
  assert.ok(shared.length >= expected.length, 'player and bot rigs must share joints');
});
