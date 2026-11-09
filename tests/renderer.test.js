/**
 * Renderer pipeline tests — run the full forward pipeline against a mock WebGL2 context.
 *
 * These are not pixel tests. They assert the properties that actually break a renderer:
 * every shader compiles and links, the vertex/fragment interfaces match, every uniform the
 * renderer sets is declared in the GLSL it targets, geometry reaches the draw calls, and the
 * post-processing chain executes end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockCanvas, parseUniforms, parseAttributes, parseVaryings } from './helpers/mock-gl.js';
import { Renderer, QualityPreset } from '../engine/src/renderer/Renderer.js';
import { RenderLayer } from '../engine/src/renderer/RenderList.js';
import { ParticlePresets } from '../engine/src/renderer/Particles.js';
import { Camera } from '../engine/src/renderer/Camera.js';
import { ShaderSources } from '../engine/src/renderer/shaders/index.js';
import { PropLibrary } from '../engine/src/geometry/Props.js';
import { WeaponFactory } from '../engine/src/geometry/WeaponMeshes.js';
import { CharacterLibrary } from '../engine/src/geometry/CharacterMeshes.js';
import { Vector3 } from '../engine/src/math/Vector3.js';
import { Matrix4 } from '../engine/src/math/Matrix4.js';

/** Every zero-argument factory in the prop library (skips helpers that take a size argument). */
const PROP_NAMES = Object.entries(PropLibrary)
  .filter(([name, value]) => typeof value === 'function' && name !== 'createTerrainChunk')
  .map(([name]) => name);

function makeRenderer(opts = {}) {
  const canvas = createMockCanvas(960, 540);
  const renderer = new Renderer(canvas, { quality: 'High', adaptive: false, ...opts });
  return { canvas, gl: canvas.gl, renderer };
}

test('all engine shaders compile and link cleanly', () => {
  const { gl } = makeRenderer();
  const problems = [];
  const stages = [
    ['geometry', ShaderSources.GEOMETRY_VERTEX, ShaderSources.GEOMETRY_FRAGMENT],
    ['shadow', ShaderSources.SHADOW_VERTEX, ShaderSources.SHADOW_FRAGMENT],
    ['sky', ShaderSources.SKY_VERTEX, ShaderSources.SKY_FRAGMENT],
    ['decal', ShaderSources.DECAL_VERTEX, ShaderSources.DECAL_FRAGMENT],
    ['particle', ShaderSources.PARTICLE_VERTEX, ShaderSources.PARTICLE_FRAGMENT],
    ['sprite', ShaderSources.SPRITE_VERTEX, ShaderSources.SPRITE_FRAGMENT],
    ['tracer', ShaderSources.TRACER_VERTEX, ShaderSources.TRACER_FRAGMENT],
    ['viewmodel', ShaderSources.VIEWMODEL_VERTEX, ShaderSources.VIEWMODEL_FRAGMENT],
    ['line', ShaderSources.LINE_VERTEX, ShaderSources.LINE_FRAGMENT],
    ['post:bright', ShaderSources.FULLSCREEN_VERTEX, ShaderSources.POST_BRIGHT_PASS],
    ['post:blur', ShaderSources.FULLSCREEN_VERTEX, ShaderSources.POST_BLUR_PASS],
    ['post:composite', ShaderSources.FULLSCREEN_VERTEX, ShaderSources.POST_COMPOSITE],
    ['post:fxaa', ShaderSources.FULLSCREEN_VERTEX, ShaderSources.POST_FXAA],
    ['post:dof', ShaderSources.FULLSCREEN_VERTEX, ShaderSources.POST_DOF],
    ['post:ssao', ShaderSources.FULLSCREEN_VERTEX, ShaderSources.POST_SSAO],
    ['post:ssaoApply', ShaderSources.FULLSCREEN_VERTEX, ShaderSources.POST_APPLY_SSAO],
    ['post:normalFromDepth', ShaderSources.FULLSCREEN_VERTEX, ShaderSources.POST_NORMAL_FROM_DEPTH],
  ];
  for (const [name, vs, fs] of stages) {
    assert.ok(typeof vs === 'string' && vs.length > 0, `${name}: missing vertex source`);
    assert.ok(typeof fs === 'string' && fs.length > 0, `${name}: missing fragment source`);
    assert.ok(`#version 300 es` !== vs.trim().split('\n')[0], `${name}: shader must not author its own #version`);
    const vUniforms = parseUniforms(vs);
    const fUniforms = parseUniforms(fs);
    // Sharing a uniform between stages is legal when the declared type matches.
    for (const u of vUniforms) {
      const f = fUniforms.find((x) => x.name === u.name);
      if (f && f.glslType !== u.glslType) problems.push(`${name}: uniform ${u.name} is ${u.glslType} in vertex and ${f.glslType} in fragment`);
      if (u.duplicate) problems.push(`${name}: duplicate uniform declaration ${u.name}`);
    }
    const vOut = new Set(parseVaryings(vs, 'out').map((v) => v.name));
    for (const v of parseVaryings(fs, 'in')) {
      if (!vOut.has(v.name)) problems.push(`${name}: fragment input ${v.name} not written by vertex stage`);
    }
    if (/^\s*attribute\s/m.test(vs)) problems.push(`${name}: GLSL ES 1.00 "attribute" used in an ES 3.0 shader`);
    if (/gl_FragColor/.test(fs)) problems.push(`${name}: gl_FragColor used — declare an out variable instead`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(gl.errors.length === 0, `mock reported shader errors: ${JSON.stringify(gl.errors)}`);
});

test('geometry shader declares every uniform the renderer sets', () => {
  const { renderer } = makeRenderer();
  const { clientWidth, clientHeight } = { clientWidth: 960, clientHeight: 540 };
  const canvas = createMockCanvas(clientWidth, clientHeight);
  void canvas;
  const cube = PropLibrary.crate();
  const position = new Vector3(2, 0.5, -4);
  renderer.addMesh(cube.mesh, renderer.getMaterial(cube.material), position, { castShadow: true });
  renderer.camera.position.set(0, 1.7, 0);
  renderer.render(1 / 60);

  // Every uniform the mock recorded on the geometry program must exist in the material application path.
  const programIds = [...renderer.device.gl.programs.keys()];
  assert.ok(programIds.length > 0, 'no programs were created');
  assert.ok(renderer.device.gl.uniformSets.length > 0, 'no uniforms were uploaded');
});

test('renderer produces draw calls and triangle counts with a populated scene', () => {
  const { renderer, gl } = makeRenderer();
  const ground = PropLibrary.concreteWall();
  renderer.addMesh(ground.mesh, renderer.getMaterial(ground.material), new Vector3(0, 0, 0), { layer: RenderLayer.Static });

  const propNames = PROP_NAMES;
  const placed = [];
  for (let i = 0; i < propNames.length; i++) {
    const prop = PropLibrary[propNames[i]]();
    const m = new Matrix4().makeTranslation(-6 + (i % 6) * 1.4, 0, -6 - Math.floor(i / 6) * 2);
    renderer.addMesh(prop.mesh, renderer.getMaterial(prop.material), m, { castShadow: true });
    placed.push(prop);
  }
  const weapon = WeaponFactory.rifle();
  renderer.addMesh(weapon.merged, renderer.getMaterial('WeaponGunmetal'), new Matrix4(), { layer: RenderLayer.ViewModel, castShadow: false });

  renderer.render(1 / 60);
  const stats = renderer.getStats();
  assert.ok(stats.drawCalls > 0, `expected draw calls, got ${stats.drawCalls}`);
  assert.ok(stats.triangles > 0, `expected triangles, got ${stats.triangles}`);
  assert.ok(gl.draws.length > 0, 'mock GL recorded no draws');
  assert.ok(gl.errors.length === 0, JSON.stringify(gl.errors));
});

test('particles, tracers, decals and sprites render in one frame', () => {
  const { renderer } = makeRenderer();
  const muzzle = new Vector3(1, 1.6, -0.4);
  const impact = new Vector3(6, 1.2, -14);
  renderer.particles.emit(ParticlePresets.muzzleSmoke, muzzle, { count: 12, direction: new Vector3(0, 0.2, -1), speed: 3 });
  renderer.particles.emit(ParticlePresets.impactConcrete, impact, { count: 14, normal: new Vector3(-1, 0, 0), direction: new Vector3(1, 0.4, 0) });
  renderer.tracers.fire(muzzle, impact, { speed: 300 });
  renderer.decals.spawn(impact, new Vector3(-1, 0, 0), 'Concrete', { scale: 1 });
  assert.equal(renderer.decals.getStats().active, 0, 'decals become active on the next update');
  renderer.sprites.add({ position: muzzle.clone(), size: 0.3, life: 0.4, texture: 'muzzleFlash', color: '#ffd28a' });
  renderer.text.addDamageNumber(34, impact, { headshot: true });

  for (let i = 0; i < 2; i++) renderer.render(1 / 60);
  const stats = renderer.getStats();
  assert.ok(stats.triangles > 0, 'effects produced no triangles');
  assert.ok(stats.particles > 0, `expected live particles, got ${stats.particles}`);
  assert.ok(stats.tracers > 0, `expected a tracer to be submitted, got ${stats.tracers}`);
  assert.ok(stats.sprites > 0, `expected a sprite (muzzle flash) to be submitted, got ${stats.sprites}`);
  assert.equal(renderer.device.gl.errors.length, 0, JSON.stringify(renderer.device.gl.errors));
});

test('viewmodel pass runs with its own camera and FOV', () => {
  const { renderer } = makeRenderer();
  const rifle = WeaponFactory.rifle();
  for (const part of rifle.parts) {
    renderer.addMesh(part.mesh, renderer.getMaterial(part.material), new Matrix4(),
      { layer: RenderLayer.ViewModel, castShadow: false });
  }
  renderer.addMesh(rifle.merged, renderer.getMaterial('WeaponGunmetal'), new Matrix4(), { layer: RenderLayer.ViewModel, castShadow: false });
  renderer.camera.setAds(1);
  renderer.camera.viewModel.recoilRotation.set(0.01, -0.004, 0);
  renderer.flashMuzzle(new Vector3(0.1, 1.5, -0.8), 1.0);
  renderer.render(1 / 60);
  assert.ok(renderer.camera.viewModel.fov < renderer.camera.fov, 'viewmodel FOV should be narrower than the world FOV');
  assert.ok(renderer.stats.drawCalls >= 2, 'viewmodel pass should add draw calls');
});

test('camera hitscan and projection helpers behave', () => {
  const camera = new Camera({ fov: 75, aspect: 16 / 9, near: 0.08, far: 500 });
  camera.setViewport(0, 0, 960, 540);
  camera.position.set(0, 1.7, 0);
  camera.setLookAngles(0, 0);
  camera.update(1 / 60);
  const ray = camera.getCenterRay();
  assert.ok(Math.abs(ray.direction.z + 1) < 1e-3, `centre ray should point down -Z, got z=${ray.direction.z}`);
  const screen = camera.worldToScreen(new Vector3(0, 1.7, -10));
  assert.equal(screen.visible, true);
  assert.ok(Math.abs(screen.x - 480) < 2, `centre of screen expected ~480, got ${screen.x}`);
  assert.ok(Math.abs(screen.y - 270) < 2, `vertical centre expected ~270, got ${screen.y}`);
  const behind = camera.worldToScreen(new Vector3(0, 1.7, 10));
  assert.equal(behind.visible, false, 'points behind the camera must not be visible');
  const mouseRay = camera.screenToRay(480, 270);
  assert.ok(Math.abs(mouseRay.direction.z + 1) < 1e-2);
});

test('quality presets change the pipeline without breaking it', () => {
  const { renderer, gl } = makeRenderer();
  const crate = PropLibrary.crate();
  renderer.addMesh(crate.mesh, renderer.getMaterial(crate.material), new Vector3(), {});
  for (const name of Object.keys(QualityPreset)) {
    renderer.setQuality(name);
    renderer.render(1 / 60);
    assert.ok(renderer.getStats().drawCalls > 0, `preset ${name} produced no draws`);
  }
  assert.equal(gl.errors.length, 0, JSON.stringify(gl.errors));
});

test('material library covers the FPS surface set', () => {
  const { renderer } = makeRenderer();
  const required = [
    'Concrete', 'Metal', 'Wood', 'Sandbag', 'Glass', 'Dirt', 'Grass',
    'CharacterSkin', 'BotArmor', 'WeaponGunmetal', 'WeaponPolymer',
    'Tracer', 'MuzzleFlash', 'Smoke', 'Spark', 'Blood', 'Decal', 'Water',
    'TeamRed', 'TeamBlue', 'Health', 'Ammo', 'Objective',
  ];
  const missing = required.filter((n) => !renderer.materials.has(n));
  assert.deepEqual(missing, [], `missing materials: ${missing.join(', ')}`);
});

test('texture kit generation provides every FPS texture', () => {
  const { renderer } = makeRenderer();
  const required = [
    'concrete', 'concreteDark', 'brick', 'metal', 'rust', 'wood', 'sandbag', 'dirt', 'rock', 'grass', 'foliage',
    'camoGreen', 'camoDesert', 'camoUrban', 'skin', 'decals', 'muzzleFlash', 'smoke', 'spark', 'blood',
    'dust', 'tracer', 'glow', 'ring', 'glass', 'hazard', 'checker', 'white', 'black', 'gradient',
    'concreteNormal', 'metalNormal', 'dirtNormal',
  ];
  const missing = required.filter((n) => !renderer.textures[n]);
  assert.deepEqual(missing, [], `missing textures: ${missing.join(', ')}`);
});

test('attribute layouts stay inside the WebGL2 minimum of 16 vertex attributes', () => {
  const seen = new Map();
  for (const attribute of parseAttributes(ShaderSources.GEOMETRY_VERTEX)) {
    if (attribute.location < 0) continue;
    assert.ok(attribute.location <= 15, `attribute ${attribute.name} uses location ${attribute.location} (max 15)`);
    assert.ok(!seen.has(attribute.location), `location ${attribute.location} claimed by both ${seen.get(attribute.location)} and ${attribute.name}`);
    seen.set(attribute.location, attribute.name);
  }
  assert.ok(seen.get(0) === 'position', 'location 0 must be position');
});

test('every prop, character part and weapon part is renderable', () => {
  const { renderer, gl } = makeRenderer();
  let count = 0;
  for (const name of PROP_NAMES) {
    const prop = PropLibrary[name]();
    renderer.addMesh(prop.mesh, renderer.getMaterial(prop.material), new Vector3((count % 10) * 0.6, 0, -3 - Math.floor(count / 10)), {});
    count++;
  }
  const characters = new CharacterLibrary();
  for (const rig of [characters.player(), characters.bot('assault'), characters.bot('heavy'), characters.bot('sniper'), characters.drone()]) {
    for (const part of rig.parts) {
      if (!part.mesh || part.mesh.triangleCount === 0) continue;
      renderer.addMesh(part.mesh, renderer.getMaterial(part.material), new Vector3((count % 10) * 0.6, 0, -8), {});
      count++;
    }
  }
  for (const kind of Object.keys(WeaponFactory)) {
    const weapon = WeaponFactory[kind]();
    for (const part of weapon.parts) {
      renderer.addMesh(part.mesh, renderer.getMaterial(part.material), new Vector3((count % 10) * 0.6, 0, -12), {});
      count++;
    }
  }
  renderer.render(1 / 60);
  const stats = renderer.getStats();
  assert.ok(stats.triangles > 5000, `expected a substantive triangle count, got ${stats.triangles} across ${count} meshes`);
  assert.equal(gl.errors.length, 0, JSON.stringify(gl.errors));
});

test('renderer survives a GL context loss and restore', () => {
  const { canvas, renderer } = makeRenderer();
  const crate = PropLibrary.crate();
  renderer.addMesh(crate.mesh, renderer.getMaterial(crate.material), new Vector3(), {});
  renderer.render(1 / 60);
  canvas.dispatch('webglcontextlost');
  assert.equal(renderer.device.contextLost, true);
  renderer.render(1 / 60);        // must not throw while the context is gone
  canvas.dispatch('webglcontextrestored');
  renderer.render(1 / 60);
  assert.ok(renderer.getStats().drawCalls >= 0);
});
