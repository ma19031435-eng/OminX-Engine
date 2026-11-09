/**
 * OminX Engine — lights, cascaded shadow maps and light culling.
 *
 * An FPS map is mostly about readable silhouettes, so this module focuses on:
 *  - a sun (directional light) driving 1–4 cascaded shadow maps, snapped to the texel grid
 *    so shadows don't shimmer while the player strafes (the classic web-renderer mistake),
 *  - a small, aggressively culled set of local lights (muzzle flashes, lamps, explosions,
 *    objective beacons) packed into a fixed uniform array,
 *  - hemisphere ambient so interiors don't go pitch black.
 *
 * @module engine/renderer/Lights
 */
import { Vector3 } from '../math/Vector3.js';
import { Color3 } from '../math/Color3.js';
import { Matrix4 } from '../math/Matrix4.js';
import { AABB } from '../math/Geometry.js';
import { clamp, clamp01, lerp, DEG2RAD } from '../math/MathUtils.js';
import { Signal } from '../core/Signal.js';
import { RenderTarget, TextureFormat, TextureFilter, TextureWrap } from './gl/Texture.js';

export const LightType = { Directional: 'directional', Point: 'point', Spot: 'spot', Ambient: 'ambient', Hemisphere: 'hemisphere' };

let _lightId = 0;

export class Light {
  /**
   * @param {object} opts
   * @param {string} [opts.type='point']
   * @param {Color3|string} [opts.color]
   * @param {number} [opts.intensity=1]
   * @param {number} [opts.range=10] attenuation radius (point/spot)
   * @param {Vector3} [opts.position]
   * @param {Vector3} [opts.direction] point this way (directional/spot)
   * @param {number} [opts.spotAngle=45] degrees
   * @param {number} [opts.penumbra=0.3]
   * @param {boolean} [opts.castShadow=false]
   */
  constructor(opts = {}) {
    this.id = `light_${++_lightId}`;
    this.name = opts.name ?? 'Light';
    this.type = opts.type ?? LightType.Point;
    this.color = opts.color instanceof Color3 ? opts.color.clone() : Color3.fromCSS(opts.color ?? '#ffffff');
    this.intensity = opts.intensity ?? 1;
    this.range = opts.range ?? 12;
    this.position = opts.position ? new Vector3().copy(opts.position) : new Vector3(0, 3, 0);
    this.direction = opts.direction ? new Vector3().copy(opts.direction).normalize() : new Vector3(0, -1, 0);
    this.spotAngle = opts.spotAngle ?? 45;
    this.penumbra = opts.penumbra ?? 0.35;
    this.castShadow = opts.castShadow ?? (this.type === LightType.Directional);
    this.shadow = {
      bias: opts.shadowBias ?? 0.0016,
      softness: opts.shadowSoftness ?? 1.6,
      near: opts.shadowNear ?? 1,
      far: opts.shadowFar ?? 220,
      cascades: opts.cascades ?? 3,
      splitLambda: opts.splitLambda ?? 0.86,
      resolution: opts.shadowResolution ?? 2048,
    };
    /** Flicker for fire/explosions: { frequency, amplitude, seed } */
    this.flicker = opts.flicker ?? null;
    this.enabled = opts.enabled !== false;
    this.visible = true;
    this._time = 0;
    this._baseIntensity = this.intensity;
    this.Changed = new Signal('Light.Changed');
  }
  static new(opts) { return new Light(opts); }

  setColor(c) { this.color = c instanceof Color3 ? c.clone() : Color3.fromCSS(c); return this; }
  setPosition(x, y, z) { if (typeof x === 'object') this.position.copy(x); else this.position.set(x, y, z); return this; }
  lookAt(target) { this.direction.copy(target).sub(this.position).normalize(); return this; }
  /** Drives the sun: azimuth/elevation in degrees, 0 = sunrise in the east. */
  setSunAngles(elevationDeg, azimuthDeg = 135) {
    const el = elevationDeg * DEG2RAD;
    const az = azimuthDeg * DEG2RAD;
    this.direction.set(
      -Math.cos(el) * Math.sin(az),
      -Math.sin(el),
      -Math.cos(el) * Math.cos(az),
    ).normalize();
    return this;
  }
  getSunElevation() { return Math.asin(clamp(-this.direction.y, -1, 1)) / DEG2RAD; }
  /** Warms the light as it approaches the horizon (cheap but very effective). */
  applyAtmosphericTint() {
    if (this.type !== LightType.Directional) return this;
    const elevation = clamp01(Math.sin(clamp(-this.direction.y, 0, 1)));
    const warm = Color3.fromCSS('#ffb066');
    const noon = Color3.fromCSS('#fff6e8');
    this.color.copy(warm).lerp(noon, Math.pow(elevation, 0.45));
    this.intensity = this._baseIntensity * lerp(0.25, 1, Math.pow(elevation, 0.6));
    return this;
  }
  update(dt) {
    this._time += dt;
    if (this.flicker) {
      const f = this.flicker;
      const n = Math.sin(this._time * f.frequency) * 0.5 + Math.sin(this._time * f.frequency * 2.71 + 1.3) * 0.3 + Math.sin(this._time * f.frequency * 5.13) * 0.2;
      this.intensity = this._baseIntensity * (1 + n * (f.amplitude ?? 0.3));
    }
    return this;
  }
  /** Full-screen intensity pulse for explosions / muzzle flashes with a smooth falloff. */
  pulse(intensity, duration = 0.12) {
    this._pulse = { remaining: duration, total: duration, intensity };
    return this;
  }
  get boundingSphere() {
    return { center: this.position, radius: this.range };
  }
  toJSON() {
    return {
      type: this.type, color: this.color.toArray(), intensity: this.intensity, range: this.range,
      position: this.position.toJSON(), direction: this.direction.toJSON(), spotAngle: this.spotAngle,
      castShadow: this.castShadow,
    };
  }
  toString() { return `Light(${this.type}, ${this.color.toHex()}, i=${this.intensity})`; }
}

// ---------------------------------------------------------------------------
// Cascaded shadow maps
// ---------------------------------------------------------------------------
/**
 * CSM implementation tuned for web GPUs: 1–4 cascades at 1024–2048², sphere-fit frusta
 * (rotation-stable), texel snapping (translation-stable) and a depth-only pass that skips
 * everything outside each cascade's caster box.
 */
export class ShadowMap {
  /**
   * @param {import('./gl/GLDevice.js').GLDevice} device
   * @param {object} [opts]
   * @param {number} [opts.cascades=3]
   * @param {number} [opts.resolution=2048]
   */
  constructor(device, opts = {}) {
    this.device = device;
    this.cascades = clamp(opts.cascades ?? 3, 1, 4);
    this.resolution = opts.resolution ?? 2048;
    this.maxFar = opts.maxFar ?? 220;
    this.splitLambda = opts.splitLambda ?? 0.86;
    this.bias = opts.bias ?? 0.0016;
    this.softness = opts.softness ?? 1.6;
    this.cascadeFade = opts.cascadeFade ?? 12;

    this.targets = [];
    this.matrices = [];
    this.splitDistances = [];
    this.textures = [];
    this.casterBoxes = [];
    this._buildTargets();
    device.onRestore(() => { this._buildTargets(); });
  }

  _buildTargets() {
    for (const t of this.targets) t.destroy?.();
    this.targets = [];
    for (let i = 0; i < this.cascades; i++) {
      const target = this.device.createRenderTarget({
        width: this.resolution,
        height: this.resolution,
        format: TextureFormat.RGBA8,
        depth: true,
        depthTexture: true,
        filter: TextureFilter.Nearest,
        wrap: TextureWrap.Clamp,
        name: `shadowCascade${i}`,
      });
      this.targets.push(target);
      this.textures.push(target.depthTextureRef);
    }
  }

  setQuality(cascades, resolution) {
    const c = clamp(cascades, 1, 4);
    let rebuild = false;
    if (resolution !== this.resolution) { this.resolution = resolution; rebuild = true; }
    if (c !== this.cascades) { this.cascades = c; rebuild = true; }
    if (rebuild) this._buildTargets();
    return this;
  }

  /**
   * Recomputes cascade splits and light matrices for the current camera.
   * @param {import('./Camera.js').Camera} camera
   * @param {Light} sun
   */
  update(camera, sun) {
    const near = Math.max(camera.near, 0.05);
    const far = Math.min(camera.far, sun.shadow.far ?? this.maxFar);
    const lambda = sun.shadow.splitLambda ?? this.splitLambda;
    this.splitDistances = [];
    for (let i = 0; i < this.cascades; i++) {
      const p = (i + 1) / this.cascades;
      const log = near * Math.pow(far / near, p);
      const uniform = near + (far - near) * p;
      this.splitDistances.push(lerp(uniform, log, lambda));
    }
    this.cascadeFade = Math.max(6, this.splitDistances[this.cascades - 1] * 0.08);

    const invVP = camera.inverseViewProjectionMatrix;
    this.matrices = [];
    this.casterBoxes = [];
    let start = near;
    for (let i = 0; i < this.cascades; i++) {
      const end = this.splitDistances[i];
      const corners = frustumCorners(invVP, start, end, camera.near, camera.far);
      const { matrix, box } = this._fitCascade(corners, sun.direction, i);
      this.matrices.push(matrix);
      this.casterBoxes.push(box);
      start = end * 0.985; // slight overlap so objects don't pop between cascades
    }
    return this;
  }

  _fitCascade(corners, lightDir, index) {
    // 1) bounding sphere of the cascade (stable under rotation)
    const center = new Vector3();
    for (const c of corners) center.add(c);
    center.scale(1 / corners.length);
    let radius = 0;
    for (const c of corners) radius = Math.max(radius, c.distanceTo(center));
    radius = Math.ceil(radius * 16) / 16; // quantize so the radius changes in steps

    // 2) build a light basis and fit a square ortho projection around the sphere
    const up = Math.abs(lightDir.y) > 0.95 ? _upAlt : _up;
    const eye = center.clone().addScaled(lightDir, -radius * 2.0);
    const view = _tmpM4.lookAt(eye, center, up);
    const inverseView = _tmpM4b.copy(view).invert();

    const maxExtents = _tmpV.copy(corners[0]).applyMatrix4(view);
    let minX = maxExtents.x, maxX = maxExtents.x, minY = maxExtents.y, maxY = maxExtents.y;
    let minZ = maxExtents.z, maxZ = maxExtents.z;
    for (const c of corners) {
      const v = _tmpV.copy(c).applyMatrix4(view);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    }
    const halfSize = Math.max(maxX - minX, maxY - minY) * 0.5;
    const texelSize = (halfSize * 2) / this.resolution;
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    // 3) snap the centre to the texel grid — this is what kills shadow shimmer.
    const snappedX = Math.round(cx / texelSize) * texelSize;
    const snappedY = Math.round(cy / texelSize) * texelSize;

    const farExtent = Math.ceil((radius * 2) / texelSize) * texelSize;
    const ortho = _tmpM4c.makeOrthographic(
      snappedX - halfSize, snappedX + halfSize,
      snappedY + halfSize, snappedY - halfSize,
      0.01, Math.max(farExtent, 10),
    );
    const matrix = new Matrix4().multiplyMatrices(ortho, view);
    const box = new AABB();
    for (const c of corners) box.expandByPoint(c);
    box.expandByVector(new Vector3(radius * 0.4, radius * 0.4, radius * 0.4));
    void inverseView; void index;
    return { matrix, box };
  }

  bindCascadeTextures(program, baseUnit = 7) {
    program.apply('uShadowMap0', baseUnit);
    this.device.bindTexture(this.textures[0], baseUnit);
    if (this.cascades > 1) { program.apply('uShadowMap1', baseUnit + 1); this.device.bindTexture(this.textures[1], baseUnit + 1); }
    if (this.cascades > 2) { program.apply('uShadowMap2', baseUnit + 2); this.device.bindTexture(this.textures[2], baseUnit + 2); }
    if (this.cascades > 3) { program.apply('uShadowMap3', baseUnit + 3); this.device.bindTexture(this.textures[3], baseUnit + 3); }
    return this;
  }
  applyUniforms(program) {
    program.apply('uShadowTexelSize', [1 / this.resolution, 1 / this.resolution]);
    program.apply('uShadowBias', this.bias);
    program.apply('uShadowSoftness', this.softness);
    program.apply('uShadowCascadeFade', this.cascadeFade);
    program.apply('uShadowSplitDistances', this.splitDistances);
    for (let i = 0; i < this.cascades; i++) {
      const m = this.matrices[i];
      if (m) program.apply(`uShadowMatrices[${i}]`, m.elements);
    }
    return this;
  }
  get memoryBytes() { return this.cascades * this.resolution * this.resolution * 4 * 2; }
}

const _up = new Vector3(0, 1, 0);
const _upAlt = new Vector3(1, 0, 0);
const _tmpV = new Vector3();
const _tmpM4 = new Matrix4();
const _tmpM4b = new Matrix4();
const _tmpM4c = new Matrix4();

/** Extracts the 8 corners of the sub-frustum between two camera-space depths. */
function frustumCorners(inverseViewProjection, startDepth, endDepth, near, far) {
  const corners = [];
  const depths = [startDepth, endDepth];
  for (const d of depths) {
    // Convert a linear depth to an NDC z value for a standard reversed-free perspective projection.
    const ndcZ = (far + near) / (far - near) - (2 * far * near) / ((far - near) * d);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const p = new Vector3(x * 2 - 1, y * 2 - 1, ndcZ).applyMatrix4(inverseViewProjection);
        corners.push(p);
      }
    }
  }
  return corners;
}

// ---------------------------------------------------------------------------
// Light manager
// ---------------------------------------------------------------------------
export class LightManager {
  /**
   * @param {import('./gl/GLDevice.js').GLDevice} device
   * @param {object} [opts]
   */
  constructor(device, opts = {}) {
    this.device = device;
    this.maxPointLights = opts.maxPointLights ?? 16;
    this.sun = new Light({
      type: LightType.Directional,
      name: 'Sun',
      color: '#fff3e0',
      intensity: 1.15,
      castShadow: true,
      ...opts.sun,
    });
    this.sun.setSunAngles(opts.sunElevation ?? 48, opts.sunAzimuth ?? 130);
    this.ambientSky = Color3.fromCSS(opts.ambientSky ?? '#8fb3d9');
    this.ambientGround = Color3.fromCSS(opts.ambientGround ?? '#4a4335');
    this.ambientIntensity = opts.ambientIntensity ?? 0.55;
    this.fogColor = Color3.fromCSS(opts.fogColor ?? '#9db4c8');
    this.fogDensity = opts.fogDensity ?? 0.008;
    this.fogStart = opts.fogStart ?? 40;
    this.fogEnd = opts.fogEnd ?? 260;
    this.fogMode = opts.fogMode ?? 1;           // 0 off, 1 linear, 2 exp, 3 exp2
    /** Time-of-day driver: set `dayTime` in hours (0-24) and call `updateSunFromTime`. */
    this.dayTime = opts.dayTime ?? 10.5;
    this.timeOfDaySpeed = opts.timeOfDaySpeed ?? 0; // hours per second (0 = static sun)
    this.lights = [];
    this.visibleLights = [];
    this.shadowMap = new ShadowMap(device, {
      cascades: opts.shadowCascades ?? 3,
      resolution: opts.shadowResolution ?? 2048,
      maxFar: opts.shadowDistance ?? 200,
    });
    this.shadowsEnabled = opts.shadowsEnabled !== false;
    this._lightScratch = [];
    /** Per-frame counts for the profiler. */
    this.stats = { total: 0, visible: 0, pointActive: 0, shadowCasters: 0 };
  }

  add(light) { this.lights.push(light); return light; }
  remove(light) {
    const i = this.lights.indexOf(light);
    if (i >= 0) this.lights.splice(i, 1);
    return this;
  }
  clear() { this.lights.length = 0; return this; }
  find(id) { return this.lights.find((l) => l.id === id); }

  /** Advances flicker, time-of-day, then selects lights for the frame. */
  update(dt, camera) {
    for (const l of this.lights) {
      l.update(dt);
      if (l._pulse) {
        l._pulse.remaining -= dt;
        if (l._pulse.remaining <= 0) { l.intensity = l._baseIntensity; l._pulse = null; }
        else {
          const t = 1 - l._pulse.remaining / l._pulse.total;
          l.intensity = l._baseIntensity + l._pulse.intensity * Math.pow(1 - t, 2);
        }
      }
    }
    if (this.timeOfDaySpeed > 0) {
      this.dayTime = (this.dayTime + dt * this.timeOfDaySpeed) % 24;
      this.updateSunFromTime();
    }
    this.updateSunFromTime(this._autoTintApplied);
    this.selectLights(camera);
    if (this.shadowsEnabled && this.sun.castShadow) this.shadowMap.update(camera, this.sun);
    return this;
  }

  /**
   * Maps a clock hour onto sun elevation/azimuth and updates the ambient/fog palette.
   * 6:00 sunrise, 12:00 noon, 18:00 sunset, 0:00 midnight.
   */
  updateSunFromTime(applyTint = true) {
    const elevationRad = Math.sin((this.dayTime - 6) / 12 * Math.PI) * (Math.PI / 2.2);
    const azimuth = 90 + ((this.dayTime - 6) / 12) * 180;
    this.sun.setSunAngles(Math.max(elevationRad, -0.35) / DEG2RAD, azimuth);
    if (applyTint) {
      this.sun.applyAtmosphericTint();
      const dayness = clamp01(Math.sin(clamp(elevationRad, 0, Math.PI / 2)) * 1.4);
      const sunsetness = clamp01(1 - Math.abs(clamp(elevationRad, 0, Math.PI / 2) - 0.35) * 3.4);
      const night = Color3.fromCSS('#2b3d5c');
      const day = Color3.fromCSS('#9dc0e6');
      const dusk = Color3.fromCSS('#d99a6c');
      this.ambientSky.copy(night).lerp(day, dayness).lerp(dusk, sunsetness * 0.5);
      this.ambientGround.copy(Color3.fromCSS('#232018')).lerp(Color3.fromCSS('#4a4335'), dayness).lerp(Color3.fromCSS('#5a4030'), sunsetness * 0.4);
      this.ambientIntensity = lerp(0.16, 0.62, dayness);
      this.fogColor.copy(this.ambientSky).lerp(this.sun.color, 0.25 * (1 - dayness * 0.6)).scale(1.05);
    }
    return this;
  }

  /**
   * Picks the N most relevant local lights for the camera: score by (intensity × color
   * luminance) / distance-to-frustum, then keep the top N. Cheap and it beats naive
   * "nearest lights" for muzzle flashes behind the player.
   */
  selectLights(camera) {
    const scratch = this._lightScratch;
    scratch.length = 0;
    for (const l of this.lights) {
      if (!l.enabled || !l.visible) continue;
      if (l.type === LightType.Directional || l.type === LightType.Ambient || l.type === LightType.Hemisphere) continue;
      const d = distanceToFrustum(camera, l.position, l.range);
      if (d > l.range) continue;
      const luminance = l.color.Luminance * l.intensity;
      const score = (luminance * 12) / (0.35 + d * d);
      scratch.push({ light: l, score, distance: d });
    }
    scratch.sort((a, b) => b.score - a.score);
    if (scratch.length > this.maxPointLights) scratch.length = this.maxPointLights;
    this.visibleLights = scratch.map((s) => s.light);
    this.stats.total = this.lights.length;
    this.stats.pointActive = this.visibleLights.length;
    return this.visibleLights;
  }

  /** Uploads sun, ambient, fog, point-light array and shadow uniforms to a program. */
  applyUniforms(program, camera) {
    const sun = this.sun;
    program.applyAll({
      uSunDirection: sun.direction,
      uSunColor: [sun.color.r * sun.intensity, sun.color.g * sun.intensity, sun.color.b * sun.intensity],
      uSunIntensity: sun.intensity,
      uAmbientSky: this.ambientSky,
      uAmbientGround: this.ambientGround,
      uAmbientIntensity: this.ambientIntensity,
      uFogColor: this.fogColor,
      uFogDensity: this.fogDensity,
      uFogStart: this.fogStart,
      uFogEnd: this.fogEnd,
      uFogMode: this.fogMode,
      uSkyLuminance: this.ambientIntensity,
      uCameraPosition: camera.worldPosition,
      uCameraForward: camera.forward,
      uPointLightCount: this.visibleLights.length,
    });
    const positions = new Float32Array(this.maxPointLights * 3);
    const colors = new Float32Array(this.maxPointLights * 3);
    const ranges = new Float32Array(this.maxPointLights);
    const intensities = new Float32Array(this.maxPointLights);
    for (let i = 0; i < this.visibleLights.length; i++) {
      const l = this.visibleLights[i];
      positions[i * 3] = l.position.x; positions[i * 3 + 1] = l.position.y; positions[i * 3 + 2] = l.position.z;
      colors[i * 3] = l.color.r; colors[i * 3 + 1] = l.color.g; colors[i * 3 + 2] = l.color.b;
      ranges[i] = l.range;
      intensities[i] = l.intensity;
    }
    if (program.has('uPointLightPositions')) program.apply('uPointLightPositions', positions);
    if (program.has('uPointLightColors')) program.apply('uPointLightColors', colors);
    if (program.has('uPointLightRanges')) program.apply('uPointLightRanges', ranges);
    if (program.has('uPointLightIntensities')) program.apply('uPointLightIntensities', intensities);
    if (this.shadowsEnabled && program.has('uShadowMap0')) {
      this.shadowMap.bindCascadeTextures(program, 7);
      this.shadowMap.applyUniforms(program);
    }
    return this;
  }

  /** Sky palette derived from the current sun (used by the sky shader and fog). */
  getSkyPalette() {
    const elevation = clamp01(Math.sin(clamp(-this.sun.direction.y, 0.02, 1)));
    const dusk = clamp01(1 - Math.min(1, Math.abs(-this.sun.direction.y - 0.12) * 6));
    const zenith = Color3.fromCSS('#0b1a33').lerp(Color3.fromCSS('#3f79c4'), Math.pow(elevation, 0.5));
    const horizon = Color3.fromCSS('#12203a').lerp(Color3.fromCSS('#cfe0ef'), Math.pow(elevation, 0.75)).lerp(Color3.fromCSS('#ff9a5a'), dusk * 0.75);
    const ground = this.ambientGround.clone().scale(0.7);
    return { zenith, horizon, ground, sunColor: this.sun.color, dusk };
  }

  setQuality({ cascades, shadowResolution, shadowsEnabled, maxPointLights, fogDensity } = {}) {
    if (cascades !== undefined || shadowResolution !== undefined) {
      this.shadowMap.setQuality(cascades ?? this.shadowMap.cascades, shadowResolution ?? this.shadowMap.resolution);
    }
    if (shadowsEnabled !== undefined) this.shadowsEnabled = shadowsEnabled;
    if (maxPointLights !== undefined) this.maxPointLights = maxPointLights;
    if (fogDensity !== undefined) this.fogDensity = fogDensity;
    return this;
  }
  getStats() {
    return {
      ...this.stats,
      cascades: this.shadowMap.cascades,
      shadowResolution: this.shadowMap.resolution,
      shadowMemoryMB: this.shadowMap.memoryBytes / 1048576,
      sunElevation: this.sun.getSunElevation(),
      dayTime: this.dayTime,
    };
  }
}

/** Approximate distance from a point to the camera frustum (0 when inside). */
function distanceToFrustum(camera, point, radius = 0) {
  const camPos = camera.worldPosition;
  const toPoint = _tmpV.copy(point).sub(camPos);
  const dist = toPoint.magnitude;
  if (dist < radius) return 0;
  const dir = toPoint.scale(1 / Math.max(dist, 1e-6));
  const cosAngle = dir.dot(camera.forward);
  if (cosAngle <= 0) return dist;                  // behind the camera
  const halfFov = camera.fov * DEG2RAD * 0.5;
  const halfDiag = Math.atan(Math.tan(halfFov) * Math.sqrt(1 + camera.aspect * camera.aspect));
  if (cosAngle > Math.cos(halfDiag)) return 0;     // inside the cone
  return dist;
}

export default Light;
