/**
 * OminX Engine — post-processing chain.
 *
 * Order (matching what shipping FPS titles do):
 *   scene(HDR) → SSAO → bloom(mip chain) → DOF(low-res blur) → composite(ACES + grading +
 *   vignette + damage feedback + grain) → FXAA → present.
 *
 * Every stage is optional and quality-scalable, because on the web the difference between
 * a 60 fps frame and a 30 fps frame is often one bloom mip.
 *
 * @module engine/renderer/PostProcessing
 */
import { Vector2 } from '../math/Vector2.js';
import { clamp, clamp01 } from '../math/MathUtils.js';
import { RenderTarget, TextureFormat, TextureFilter, TextureWrap } from './gl/Texture.js';
import { Shader } from './gl/Shader.js';
import { RenderQueue } from './Material.js';
import { ShaderSources } from './shaders/index.js';
import { createFullscreenQuad } from '../geometry/Primitives.js';
import { GeometryBuffer } from './gl/GeometryBuffer.js';
import { createLogger } from '../core/Logger.js';

const log = createLogger('PostFX');

export const PostQuality = {
  Off: { ssao: false, bloom: false, bloomMips: 0, dof: false, fxaa: false },
  Low: { ssao: false, bloom: true, bloomMips: 3, dof: false, fxaa: true },
  Medium: { ssao: false, bloom: true, bloomMips: 4, dof: true, fxaa: true },
  High: { ssao: true, ssaoScale: 0.5, bloom: true, bloomMips: 5, dof: true, fxaa: true },
  Ultra: { ssao: true, ssaoScale: 0.66, bloom: true, bloomMips: 6, dof: true, fxaa: true },
};

export class PostProcessing {
  constructor(device, opts = {}) {
    this.device = device;
    this.enabled = opts.enabled !== false;
    this.quality = opts.quality ?? 'High';
    this.settings = { ...PostQuality[this.quality] };
    this.width = opts.width ?? device.width;
    this.height = opts.height ?? device.height;
    this.hdrFormat = device.caps.supportsHalfFloat || device.caps.supportsFloatTextures ? TextureFormat.RGBA16F : TextureFormat.RGBA8;

    this._buildScreenQuad();
    this._buildShaders();
    this._buildTargets();

    /** Exposed so the game/HUD can tune the look at runtime (settings menu + damage FX). */
    this.params = {
      exposure: 1.0,
      bloomIntensity: 0.85,
      bloomThreshold: 1.05,
      bloomSoftKnee: 0.6,
      toneMapping: 0,
      vignette: 0.34,
      vignetteRadius: 0.86,
      chromaticAberration: 0.0006,
      saturation: 1.04,
      contrast: 1.03,
      grain: 0.018,
      ssaoRadius: 0.55,
      ssaoIntensity: 1.5,
      ssaoBias: 0.02,
      dofFocusDistance: 18,
      dofFocusRange: 26,
      dofMaxBlur: 0.55,
      fxaa: true,
    };
    /** Filled by the renderer each frame from the active camera. */
    this.cameraState = {
      near: 0.1, far: 500, damageVignette: 0, hitDirectionAngle: 0, hitFlash: 0,
      adsBlend: 0, scopeBlend: 0, lowHealthPulse: 0, fade: 0, fadeColor: [0, 0, 0],
      nightVision: 0, underwater: 0,
    };
  }

  static create(device, opts) { return new PostProcessing(device, opts); }

  _buildScreenQuad() {
    this.screenMesh = createFullscreenQuad();
    this.screenGeometry = this.device.createGeometry(this.screenMesh);
  }

  _buildShaders() {
    const device = this.device;
    this.brightShader = device.createShader({
      name: 'brightPass', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_BRIGHT_PASS,
    });
    this.blurShader = device.createShader({
      name: 'blur', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_BLUR_PASS,
    });
    this.compositeShader = device.createShader({
      name: 'composite', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_COMPOSITE,
    });
    this.fxaaShader = device.createShader({
      name: 'fxaa', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_FXAA,
    });
    this.ssaoShader = device.createShader({
      name: 'ssao', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_SSAO,
    });
    this.ssaoApplyShader = device.createShader({
      name: 'ssaoApply', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_APPLY_SSAO,
    });
    this.normalShader = device.createShader({
      name: 'normalFromDepth', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_NORMAL_FROM_DEPTH,
    });
    this.dofShader = device.createShader({
      name: 'dof', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_DOF,
    });
    this.screenVAO = this.screenGeometry.vao;
  }

  _buildTargets() {
    const d = this.device;
    const w = this.width, h = this.height;
    this.bloomMips = [];
    const mipCount = this.settings.bloomMips ?? 5;
    let bw = Math.max(1, Math.floor(w / 2)), bh = Math.max(1, Math.floor(h / 2));
    for (let i = 0; i < mipCount; i++) {
      this.bloomMips.push({
        a: d.createRenderTarget({ width: bw, height: bh, format: this.hdrFormat, depth: false, filter: TextureFilter.Linear, name: `bloom${i}a` }),
        b: d.createRenderTarget({ width: bw, height: bh, format: this.hdrFormat, depth: false, filter: TextureFilter.Linear, name: `bloom${i}b` }),
      });
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
    const ss = this.settings.ssaoScale ?? 0.5;
    this.ssaoTarget = d.createRenderTarget({
      width: Math.max(1, Math.floor(w * ss)), height: Math.max(1, Math.floor(h * ss)),
      format: TextureFormat.RGBA8, depth: false, filter: TextureFilter.Linear, name: 'ssao',
    });
    this.normalTarget = d.createRenderTarget({
      width: Math.max(1, Math.floor(w * ss)), height: Math.max(1, Math.floor(h * ss)),
      format: TextureFormat.RGBA8, depth: false, filter: TextureFilter.Linear, name: 'normals',
    });
    this.dofTarget = d.createRenderTarget({
      width: Math.max(1, Math.floor(w / 2)), height: Math.max(1, Math.floor(h / 2)),
      format: this.hdrFormat, depth: false, filter: TextureFilter.Linear, name: 'dof',
    });
  }

  setSize(width, height) {
    if (width === this.width && height === this.height) return this;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    for (const mip of this.bloomMips) { mip.a.destroy(); mip.b.destroy(); }
    this.ssaoTarget.destroy();
    this.normalTarget.destroy();
    this.dofTarget.destroy();
    this._buildTargets();
    return this;
  }

  setQuality(quality) {
    if (!PostQuality[quality]) { log.warn(`unknown quality "${quality}"`); return this; }
    this.quality = quality;
    this.settings = { ...PostQuality[quality] };
    const oldMips = this.bloomMips.length;
    const newMips = this.settings.bloomMips ?? 0;
    if (oldMips !== newMips) {
      for (const mip of this.bloomMips) { mip.a.destroy(); mip.b.destroy(); }
      this.bloomMips = [];
      const d = this.device;
      let bw = Math.max(1, Math.floor(this.width / 2)), bh = Math.max(1, Math.floor(this.height / 2));
      for (let i = 0; i < newMips; i++) {
        this.bloomMips.push({
          a: d.createRenderTarget({ width: bw, height: bh, format: this.hdrFormat, depth: false, filter: TextureFilter.Linear, name: `bloom${i}a` }),
          b: d.createRenderTarget({ width: bw, height: bh, format: this.hdrFormat, depth: false, filter: TextureFilter.Linear, name: `bloom${i}b` }),
        });
        bw = Math.max(1, bw >> 1);
        bh = Math.max(1, bh >> 1);
      }
    }
    return this;
  }

  // ------------------------------------------------------------------ passes
  drawScreenQuad() {
    const device = this.device;
    device.bindVertexArray(this.screenGeometry.vao);
    device.drawFullscreen();
    device._resources.drawCalls++;
  }

  /** SSAO on a half-res depth copy; writes the AO term into `ssaoTarget`. */
  renderSSAO(sceneDepthTexture, camera) {
    if (!this.settings.ssao || !sceneDepthTexture) return;
    const device = this.device;
    const st = this.ssaoTarget;
    // 1) reconstruct normals from depth (no G-buffer needed)
    this.normalTarget.bind(false);
    device.setBlend('none');
    device.setDepthTest(false);
    device.setDepthWrite(false);
    this.normalShader.use().applyAll({
      uDepthTexture: 0,
      uTexelSize: [1 / st.width, 1 / st.height],
      uInverseProjectionMatrix: camera.inverseProjectionMatrix.elements,
    });
    device.bindTexture(sceneDepthTexture, 0);
    this.drawScreenQuad();

    // 2) hemisphere sampling in view space
    st.bind(false);
    this.ssaoShader.use().applyAll({
      uDepthTexture: 0,
      uNormalTexture: 1,
      uProjectionMatrix: camera.projectionMatrix.elements,
      uInverseProjectionMatrix: camera.inverseProjectionMatrix.elements,
      uViewMatrix: camera.viewMatrix.elements,
      uInverseViewMatrix: camera.inverseViewMatrix.elements,
      uResolution: [st.width, st.height],
      uRadius: this.params.ssaoRadius,
      uBias: this.params.ssaoBias,
      uIntensity: this.params.ssaoIntensity,
      uNearPlane: camera.near,
      uFarPlane: camera.far,
    });
    device.bindTexture(sceneDepthTexture, 0);
    device.bindTexture(this.normalTarget.colorTexture, 1);
    this.drawScreenQuad();
  }

  /** Multi-mip bloom: bright pass, then a 2-pass Gaussian per mip, accumulated additively. */
  renderBloom(sceneTexture) {
    if (!this.settings.bloom || this.bloomMips.length === 0) return null;
    const device = this.device;
    device.setBlend('none');
    device.setDepthTest(false);
    device.setDepthWrite(false);

    // bright pass into mip 0
    const mip0 = this.bloomMips[0];
    mip0.a.bind(false);
    this.brightShader.use().applyAll({
      uSceneTexture: 0,
      uThreshold: this.params.bloomThreshold,
      uSoftKnee: this.params.bloomSoftKnee,
      uIntensity: 1,
    });
    device.bindTexture(sceneTexture, 0);
    this.drawScreenQuad();

    // blur chain, each mip seeded by the previous one
    for (let i = 0; i < this.bloomMips.length; i++) {
      const mip = this.bloomMips[i];
      // horizontal
      mip.b.bind(false);
      this.blurShader.use().applyAll({
        uTexture: 0,
        uTexelSize: [1 / mip.a.width, 1 / mip.a.height],
        uDirection: 0,
        uRadius: 1.0 + i * 0.35,
      });
      device.bindTexture(mip.a.colorTexture, 0);
      this.drawScreenQuad();
      // vertical
      mip.a.bind(false);
      this.blurShader.use().applyAll({
        uTexture: 0,
        uTexelSize: [1 / mip.b.width, 1 / mip.b.height],
        uDirection: 1,
        uRadius: 1.0 + i * 0.35,
      });
      device.bindTexture(mip.b.colorTexture, 0);
      this.drawScreenQuad();
      // seed the next mip
      if (i + 1 < this.bloomMips.length) {
        const next = this.bloomMips[i + 1];
        next.a.bind(false);
        this.blurShader.use().applyAll({
          uTexture: 0,
          uTexelSize: [1 / next.a.width, 1 / next.a.height],
          uDirection: 0,
          uRadius: 1.4,
        });
        device.bindTexture(mip.a.colorTexture, 0);
        this.drawScreenQuad();
      }
    }
    return this.bloomMips[0].a.colorTexture;
  }

  /** Low-res blur used by the depth-of-field composite. */
  renderDOFBlur(sceneTexture) {
    if (!this.settings.dof) return null;
    const device = this.device;
    const t = this.dofTarget;
    t.bind(false);
    this.blurShader.use().applyAll({ uTexture: 0, uTexelSize: [1 / t.width, 1 / t.height], uDirection: 0, uRadius: 2.2 });
    device.bindTexture(sceneTexture, 0);
    this.drawScreenQuad();
    // second (wider) pass for a smoother bokeh
    const second = this.bloomMips.length ? this.bloomMips[Math.min(1, this.bloomMips.length - 1)].b : null;
    if (second) {
      second.bind(false);
      this.blurShader.use().applyAll({ uTexture: 0, uTexelSize: [1 / t.width, 1 / t.height], uDirection: 1, uRadius: 2.2 });
      device.bindTexture(t.colorTexture, 0);
      this.drawScreenQuad();
      t.bind(false);
      this.blurShader.use().applyAll({ uTexture: 0, uTexelSize: [1 / t.width, 1 / t.height], uDirection: 0, uRadius: 3.4 });
      device.bindTexture(second.colorTexture, 0);
      this.drawScreenQuad();
    }
    return t.colorTexture;
  }

  /**
   * Final pass: SSAO apply (cheap, multiplicative) → composite (tonemap, grade, damage) →
   * optional FXAA → writes to `target` (null = default framebuffer).
   */
  composite(sceneTexture, bloomTexture, target, camera, opts = {}) {
    const device = this.device;
    const p = this.params;
    const c = this.cameraState;

    // 1) multiply AO into the scene (in place on a ping-pong target)
    let colorTexture = sceneTexture;
    if (this.settings.ssao && this.ssaoTarget.colorTexture && opts.applyAO !== false) {
      const tmp = this.bloomMips.length ? this.bloomMips[this.bloomMips.length - 1].b : null;
      if (tmp) {
        tmp.bind(false);
        this.ssaoApplyShader.use().applyAll({ uSceneTexture: 0, uAoTexture: 1, uEnabled: 1 });
        device.bindTexture(sceneTexture, 0);
        device.bindTexture(this.ssaoTarget.colorTexture, 1);
        this.drawScreenQuad();
        colorTexture = tmp.colorTexture;
      }
    }

    // 2) composite to a half-res target when FXAA will run afterwards
    const useFxaa = this.settings.fxaa && p.fxaa && opts.fxaa !== false;
    const compositeTarget = useFxaa ? this._fxaaSource ??= this.device.createRenderTarget({
      width: this.width, height: this.height, format: TextureFormat.RGBA8, depth: false,
      filter: TextureFilter.Linear, name: 'compositeSource', srgb: true,
    }) : target;

    compositeTarget.bind(false);
    device.setBlend('none');
    device.setDepthTest(false);
    device.setDepthWrite(false);
    this.compositeShader.use().applyAll({
      uSceneTexture: 0,
      uBloomTexture: 1,
      uDepthTexture: 2,
      uBloomIntensity: this.settings.bloom ? p.bloomIntensity : 0,
      uExposure: p.exposure * (opts.exposure ?? 1),
      uToneMappingMode: p.toneMapping,
      uVignetteStrength: p.vignette,
      uVignetteRadius: p.vignetteRadius,
      uChromaticAberration: p.chromaticAberration * (1 + c.adsBlend * 0.5),
      uSaturation: p.saturation,
      uContrast: p.contrast,
      uResolution: [compositeTarget.width, compositeTarget.height],
      uTime: opts.time ?? 0,
      uGrainAmount: p.grain,
      uDamageVignette: c.damageVignette,
      uHitDirectionAngle: c.hitDirectionAngle,
      uHitFlash: c.hitFlash,
      uAdsBlend: c.adsBlend,
      uScopeBlend: c.scopeBlend,
      uLowHealthPulse: c.lowHealthPulse,
      uFadeAmount: c.fade,
      uFadeColor: c.fadeColor,
      uNightVision: c.nightVision,
      uUnderwater: c.underwater,
    });
    device.bindTexture(colorTexture, 0);
    device.bindTexture(bloomTexture ?? (this.bloomMips[0]?.a.colorTexture ?? colorTexture), 1);
    device.bindTexture(opts.depthTexture ?? colorTexture, 2);
    this.drawScreenQuad();

    // 3) FXAA onto the final target
    if (useFxaa) {
      device.bindFramebuffer(target ?? null);
      const w = target?.width ?? device.width;
      const h = target?.height ?? device.height;
      device.setViewport(0, 0, w, h);
      this.fxaaShader.use().applyAll({
        uSceneTexture: 0,
        uTexelSize: [1 / w, 1 / h],
        uEnabled: 1,
      });
      device.bindTexture(compositeTarget.colorTexture, 0);
      this.drawScreenQuad();
    }
    return this;
  }

  /** Standalone upsample/composite for the editor viewport (no FXAA, direct to a texture). */
  blit(texture, target, { gamma = true } = {}) {
    const device = this.device;
    target?.bind(false);
    device.setBlend('none');
    device.setDepthTest(false);
    device.setDepthWrite(false);
    const shader = this.blitShader ??= device.createShader({
      name: 'blit',
      vertex: ShaderSources.FULLSCREEN_VERTEX,
      fragment: `in vec2 vUV;
        uniform sampler2D uTexture;
        uniform float uGamma;
        out vec4 fragColor;
        void main() {
          vec4 c = texture(uTexture, vUV);
          fragColor = vec4(c.rgb, c.a);
        }`,
    });
    shader.use().applyAll({ uTexture: 0, uGamma: gamma ? 1 : 0 });
    device.bindTexture(texture, 0);
    this.drawScreenQuad();
    return this;
  }

  get memoryBytes() {
    let bytes = 0;
    for (const m of this.bloomMips) bytes += m.a.width * m.a.height * 8 * 2;
    bytes += this.ssaoTarget.width * this.ssaoTarget.height * 8;
    bytes += this.normalTarget.width * this.normalTarget.height * 4;
    bytes += this.dofTarget.width * this.dofTarget.height * 8;
    if (this._fxaaSource) bytes += this._fxaaSource.width * this._fxaaSource.height * 4;
    return bytes;
  }

  destroy() {
    for (const m of this.bloomMips) { m.a.destroy(); m.b.destroy(); }
    this.ssaoTarget.destroy();
    this.normalTarget.destroy();
    this.dofTarget.destroy();
    this._fxaaSource?.destroy();
    this.screenGeometry.destroy();
  }
}

export default PostProcessing;
