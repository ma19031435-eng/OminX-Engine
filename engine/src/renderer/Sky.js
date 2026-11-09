/**
 * OminX Engine — sky, atmosphere and environment lighting input.
 *
 * Renders a full-screen procedural sky through the main depth buffer (so geometry occludes
 * it correctly) with a sun disc, moon, stars, two-layer clouds and a horizon haze. The same
 * palette feeds the fog colour and the ambient terms, which is what keeps a map's lighting
 * coherent instead of the "three unrelated colors" look most web demos have.
 *
 * @module engine/renderer/Sky
 */
import { Color3 } from '../math/Color3.js';
import { Vector3 } from '../math/Vector3.js';
import { Shader } from './gl/Shader.js';
import { ShaderSources } from './shaders/index.js';
import { GeometryBuffer } from './gl/GeometryBuffer.js';
import { createFullscreenQuad, createBox, createSphere } from '../geometry/Primitives.js';
import { clamp01, lerp, DEG2RAD } from '../math/MathUtils.js';

export const SkyMode = { Procedural: 'procedural', Cubemap: 'cubemap', Color: 'color', None: 'none' };

export class Sky {
  /**
   * @param {import('./gl/GLDevice.js').GLDevice} device
   * @param {object} [opts]
   */
  constructor(device, opts = {}) {
    this.device = device;
    this.mode = opts.mode ?? SkyMode.Procedural;
    this.enabled = opts.enabled !== false;
    this.cubemap = opts.cubemap ?? null;
    this.color = opts.color ? Color3.fromCSS(opts.color) : new Color3(0.42, 0.55, 0.72);
    this.settings = {
      zenith: Color3.fromCSS(opts.zenith ?? '#2f6fb0'),
      horizon: Color3.fromCSS(opts.horizon ?? '#c9d9e6'),
      ground: Color3.fromCSS(opts.ground ?? '#4a4536'),
      sunColor: Color3.fromCSS('#fff1d9'),
      sunIntensity: opts.sunIntensity ?? 1.15,
      cloudCoverage: opts.cloudCoverage ?? 0.52,
      cloudDensity: opts.cloudDensity ?? 0.85,
      cloudSpeed: opts.cloudSpeed ?? 0.35,
      stars: opts.stars ?? 1,
      exposure: opts.exposure ?? 1,
      moonPhase: opts.moonPhase ?? 1,
    };
    this.sunDirection = new Vector3(0, -1, 0);
    this.moonDirection = new Vector3(0, 1, 0);
    this.time = 0;

    this.shader = device.createShader({
      name: 'sky',
      vertex: ShaderSources.SKY_VERTEX,
      fragment: ShaderSources.SKY_FRAGMENT,
    });
    this.quad = createFullscreenQuad();
    this.geometry = device.createGeometry(this.quad);
    // Distance skybox used in cubemap mode: a large inverted box drawn at the far plane.
    this.boxMesh = createBox(1, 1, 1, { invert: true });
    this.boxGeometry = device.createGeometry(this.boxMesh);
    this.sphereMesh = createSphere(1, 32, 16);

    /** Simple animated cloud-shadow map for the ground (adds huge perceived quality). */
    this.cloudShadowStrength = opts.cloudShadowStrength ?? 0.25;
  }

  static create(device, opts) { return new Sky(device, opts); }

  /** Pulls the palette from the light manager so sky, fog and ambient always agree. */
  syncWithLights(lightManager) {
    const palette = lightManager.getSkyPalette();
    this.settings.zenith.copy(palette.zenith);
    this.settings.horizon.copy(palette.horizon);
    this.settings.ground.copy(palette.ground);
    this.settings.sunColor.copy(palette.sunColor);
    this.settings.sunIntensity = clamp01(lightManager.sun.intensity * 0.9);
    this.settings.stars = 1 - clamp01(palette.dusk);
    this.sunDirection.copy(lightManager.sun.direction);
    // Moon sits opposite the sun, offset slightly so it isn't a perfect mirror.
    this.moonDirection.set(-this.sunDirection.x, -this.sunDirection.y, -this.sunDirection.z).normalize();
    return this;
  }

  update(dt, lightManager) {
    this.time += dt;
    if (lightManager && this.mode === SkyMode.Procedural) this.syncWithLights(lightManager);
    return this;
  }

  /**
   * Draws the sky. Must be called after opaque geometry when the depth buffer is already
   * populated, so geometry occludes it (with depth test enabled and no depth write).
   */
  render(camera, postFx = null) {
    if (!this.enabled || this.mode === SkyMode.None) return;
    const device = this.device;
    device.setDepthTest(true, device.LEQUAL);
    device.setDepthWrite(false);
    device.setCullFace(false);
    device.setBlend('none');

    if (this.mode === SkyMode.Cubemap && this.cubemap) {
      // Draw an inverted box around the camera, uploaded as a cubemap.
      const shader = this._getCubemapShader();
      shader.use().applyAll({
        uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
        uModelMatrix: _m4.fromTranslation(camera.worldPosition.x, camera.worldPosition.y, camera.worldPosition.z).scale_(new Vector3(camera.far * 0.9, camera.far * 0.9, camera.far * 0.9)).elements,
        uCubemap: 0,
        uExposure: this.settings.exposure,
      });
      device.bindTextureCube(this.cubemap, 0);
      this.boxGeometry.bind();
      device.drawIndexed(this.boxGeometry.indexCount);
    } else if (this.mode === SkyMode.Color) {
      const shader = this._getColorShader();
      shader.use().applyAll({ uColor: this.color, uExposure: this.settings.exposure });
      this.geometry.bind();
      device.draw(3);
    } else {
      const s = this.settings;
      this.shader.use().applyAll({
        uInverseViewProjection: camera.inverseViewProjectionMatrix.elements,
        uCameraPosition: camera.worldPosition,
        uSkyZenithColor: s.zenith,
        uSkyHorizonColor: s.horizon,
        uGroundColor: s.ground,
        uSunDirection: this.sunDirection,
        uSunColor: s.sunColor,
        uSunIntensity: s.sunIntensity,
        uMoonDirection: this.moonDirection,
        uMoonPhase: s.moonPhase,
        uTime: this.time,
        uCloudCoverage: s.cloudCoverage,
        uCloudDensity: s.cloudDensity,
        uCloudSpeed: s.cloudSpeed,
        uStarIntensity: s.stars,
        uSkyExposure: s.exposure,
      });
      this.geometry.bind();
      device.draw(3);
      device._resources.triangles += 1;
    }
    void postFx;
  }

  _getCubemapShader() {
    this._cubemapShader ??= this.device.createShader({
      name: 'skyboxCubemap',
      vertex: `layout(location = 0) in vec3 position;
        uniform mat4 uModelMatrix;
        uniform mat4 uViewProjectionMatrix;
        out vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = uViewProjectionMatrix * uModelMatrix * vec4(position, 1.0);
        }`,
      fragment: `in vec3 vDir;
        uniform samplerCube uCubemap;
        uniform float uExposure;
        out vec4 fragColor;
        void main() { fragColor = vec4(texture(uCubemap, normalize(vDir)).rgb * uExposure, 1.0); }`,
    });
    return this._cubemapShader;
  }
  _getColorShader() {
    this._colorShader ??= this.device.createShader({
      name: 'skyColor',
      vertex: ShaderSources.FULLSCREEN_VERTEX,
      fragment: `in vec2 vUV;
        uniform vec3 uColor;
        uniform float uExposure;
        out vec4 fragColor;
        void main() { fragColor = vec4(uColor * uExposure, 1.0); }`,
    });
    return this._colorShader;
  }

  /** Time-of-day helpers for the editor's environment panel. */
  setTimeOfDay(hours, lightManager) {
    if (lightManager) { lightManager.dayTime = hours; lightManager.updateSunFromTime(); this.syncWithLights(lightManager); }
    return this;
  }
  setCloudCoverage(v) { this.settings.cloudCoverage = clamp01(v); return this; }
  /** Fog color that matches the horizon under the current lighting. */
  getFogColor() { return this.settings.horizon.clone().lerp(this.settings.zenith, 0.35); }
  /** Ambient sky term for the IBL approximation. */
  getAmbientSky() { return this.settings.zenith.clone().lerp(this.settings.horizon, 0.5).scale(lerp(0.35, 1, this.settings.sunIntensity)); }
}

const _m4 = {
  _e: new Float32Array(16),
  fromTranslation(x, y, z) {
    const e = this._e;
    e[0] = 1; e[1] = 0; e[2] = 0; e[3] = 0;
    e[4] = 0; e[5] = 1; e[6] = 0; e[7] = 0;
    e[8] = 0; e[9] = 0; e[10] = 1; e[11] = 0;
    e[12] = x; e[13] = y; e[14] = z; e[15] = 1;
    return this;
  },
  scale_(v) {
    const e = this._e;
    e[0] *= v.x; e[4] *= v.y; e[8] *= v.z;
    e[1] *= v.x; e[5] *= v.y; e[9] *= v.z;
    e[2] *= v.x; e[6] *= v.y; e[10] *= v.z;
    return this;
  },
  get elements() { return this._e; },
};

export default Sky;
