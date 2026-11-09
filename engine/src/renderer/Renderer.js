/**
 * OminX Engine — the renderer.
 *
 * Frame structure (forward, HDR, MSAA-optional):
 *   1. cascaded shadow maps (depth-only, 1–4 cascades)
 *   2. opaque + alpha-cutout geometry with sun/CSM/point lights, fog, IBL approximation
 *   3. procedural sky
 *   4. decals and transparent geometry (back to front)
 *   5. particles, sprites, tracers
 *   6. view-model pass (weapon, own FOV/near plane, depth cleared)
 *   7. post: SSAO → bloom mips → DOF → composite (ACES + grade + damage FX) → FXAA
 *
 * Everything is quality-scalable and can drop features at runtime (`setQuality`), which is
 * how the engine keeps a 60 fps target on integrated GPUs without the game code caring.
 *
 * @module engine/renderer/Renderer
 */
import { Vector3 } from '../math/Vector3.js';
import { Vector2 } from '../math/Vector2.js';
import { Color3 } from '../math/Color3.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Signal } from '../core/Signal.js';
import { createLogger } from '../core/Logger.js';
import { clamp, clamp01, lerp, formatBytes } from '../math/MathUtils.js';

import { GLDevice, BlendMode } from './gl/GLDevice.js';
import { createDevice } from './gpu/index.js';
import { Shader, ShaderPermutation } from './gl/Shader.js';
import { Mesh } from '../geometry/Mesh.js';
import { GeometryBuffer, InstanceBuffer, ATTRIBUTE_LOCATIONS, BASE_ATTRIBUTES } from './gl/GeometryBuffer.js';
import { generateTextureKit, makeFontAtlas, RenderTarget, TextureFormat, TextureFilter, TextureWrap } from './gl/Texture.js';
import { Material, MaterialLibrary, AlphaMode, RenderQueue, ShaderFeature } from './Material.js';
import { Camera, ShakePreset } from './Camera.js';
import { LightManager, Light, LightType } from './Lights.js';
import { RenderList, RenderItem, InstancedBatch, RenderLayer } from './RenderList.js';
import { PostProcessing, PostQuality } from './PostProcessing.js';
import { ParticleSystem, ParticlePresets } from './Particles.js';
import { DecalSystem, DecalKind, MaterialToDecal } from './Decals.js';
import { Sky, SkyMode } from './Sky.js';
import { SpriteSystem, TracerSystem, LineSystem, TextSystem } from './Sprites.js';
import { ShaderSources } from './shaders/index.js';

const log = createLogger('Renderer');

/** Bundle of quality knobs exposed to the settings menu and the adaptive scaler. */
export const QualityPreset = {
  Low: {
    renderScale: 0.75, msaa: 0, shadows: false, shadowCascades: 0, shadowResolution: 1024,
    post: 'Low', particles: 0.45, maxParticles: 800, decals: 0.5, anisotropy: 1, maxPointLights: 6,
    drawDistance: 220, grassDensity: 0.35, fogDensity: 0.014,
  },
  Medium: {
    renderScale: 0.9, msaa: 0, shadows: true, shadowCascades: 2, shadowResolution: 1024,
    post: 'Medium', particles: 0.7, maxParticles: 1500, decals: 0.8, anisotropy: 2, maxPointLights: 10,
    drawDistance: 320, grassDensity: 0.6, fogDensity: 0.011,
  },
  High: {
    renderScale: 1.0, msaa: 4, shadows: true, shadowCascades: 3, shadowResolution: 2048,
    post: 'High', particles: 1.0, maxParticles: 3000, decals: 1.0, anisotropy: 4, maxPointLights: 16,
    drawDistance: 500, grassDensity: 1.0, fogDensity: 0.008,
  },
  Ultra: {
    renderScale: 1.0, msaa: 4, shadows: true, shadowCascades: 4, shadowResolution: 2048,
    post: 'Ultra', particles: 1.4, maxParticles: 4500, decals: 1.2, anisotropy: 8, maxPointLights: 24,
    drawDistance: 800, grassDensity: 1.3, fogDensity: 0.006,
  },
};

/**
 * Adaptive quality controller: watches frame time and nudges resolution / particle budget /
 * shadow resolution to hold the target framerate. Keeps the player from feeling a stutter
 * spiral when a fight breaks out.
 */
export class AdaptiveQuality {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.targetFrameMs = opts.targetFrameMs ?? 16.7;
    this.enabled = opts.enabled ?? true;
    this.minScale = opts.minScale ?? 0.62;
    this.maxScale = opts.maxScale ?? 1.0;
    this.stepDown = opts.stepDown ?? 0.06;
    this.stepUp = opts.stepUp ?? 0.02;
    this.cooldown = 0;
    this.samples = new Float32Array(45);
    this.index = 0;
    this.stable = 0;
    this.lastChange = 0;
  }
  update(frameMs) {
    if (!this.enabled) return;
    this.samples[this.index] = frameMs;
    this.index = (this.index + 1) % this.samples.length;
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i];
    const avg = sum / this.samples.length;
    if (this.cooldown > 0) { this.cooldown--; return; }
    const scale = this.renderer.renderScale;
    if (avg > this.targetFrameMs * 1.18 && scale > this.minScale) {
      this.renderer.setRenderScale(Math.max(this.minScale, scale - this.stepDown));
      this.cooldown = 30;
      this.lastChange = performance.now();
    } else if (avg < this.targetFrameMs * 0.82 && scale < this.maxScale) {
      this.stable++;
      if (this.stable > 90) {
        this.renderer.setRenderScale(Math.min(this.maxScale, scale + this.stepUp));
        this.stable = 0;
        this.cooldown = 45;
      }
    } else {
      this.stable = 0;
    }
  }
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement|OffscreenCanvas} canvas
   * @param {object} [opts]
   * @param {string} [opts.quality='High']
   * @param {boolean} [opts.adaptive=true]
   * @param {string} [opts.skyMode]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.qualityName = opts.quality ?? 'High';
    this.quality = { ...QualityPreset[this.qualityName] };
    /**
     * The device is either injected (`opts.deviceInstance` — used by `Renderer.createAsync`, which
     * resolves WebGPU asynchronously, and by headless tooling) or created synchronously on WebGL2.
     * `Renderer.create(canvas)` therefore always gives a working GL renderer, while
     * `await Renderer.createAsync(canvas)` gives the best backend the browser supports.
     */
    this.device = opts.deviceInstance ?? new GLDevice(canvas, {
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: opts.powerPreference ?? 'high-performance',
      pixelRatio: opts.pixelRatio,
      ...opts.device,
    });
    this.backend = this.device.backend;
    this.width = this.device.width;
    this.height = this.device.height;

    this.FrameStart = new Signal('Renderer.FrameStart');
    this.FrameEnd = new Signal('Renderer.FrameEnd');
    this.Resized = new Signal('Renderer.Resized');
    this.QualityChanged = new Signal('Renderer.QualityChanged');
    this.warnings = [];
    if (this.device.caps.isSoftware) {
      const api = this.backend === 'webgpu' ? 'Software WebGPU adapter' : 'Software WebGL renderer';
      this.warnings.push(`${api} detected — the engine will run with reduced quality.`);
      this.qualityName = 'Low';
      this.quality = { ...QualityPreset.Low };
    }

    // --- content
    this.textures = generateTextureKit(this.device, { size: 256, hq: this.qualityName === 'Ultra' || this.qualityName === 'High' });
    this.fontAtlas = makeFontAtlas(this.device, 32);
    this.materials = new MaterialLibrary(this.device, this.textures);

    // --- systems
    this.lights = new LightManager(this.device, {
      shadowCascades: this.quality.shadowCascades || 1,
      shadowResolution: this.quality.shadowResolution,
      maxPointLights: this.quality.maxPointLights,
      fogDensity: this.quality.fogDensity,
      ...opts.lighting,
    });
    this.camera = opts.camera ?? new Camera({
      fov: opts.fov ?? 75,
      aspect: this.device.aspect,
      near: opts.near ?? 0.08,
      far: opts.far ?? this.quality.drawDistance,
    });
    this.post = new PostProcessing(this.device, {
      quality: this.quality.post,
      width: this.device.width,
      height: this.device.height,
    });
    this.sky = new Sky(this.device, { mode: opts.skyMode ?? SkyMode.Procedural, ...opts.sky });
    this.renderList = new RenderList();
    this.particles = new ParticleSystem(this.device, this.textures, {
      maxParticles: this.quality.maxParticles,
      qualityScale: this.quality.particles,
    });
    this.decals = new DecalSystem(this.device, this.textures, {
      capacity: Math.round(640 * this.quality.decals),
      material: this.materials.get('Decal'),
    });
    this.sprites = new SpriteSystem(this.device, this.textures, { materials: this.materials });
    this.tracers = new TracerSystem(this.device);
    this.lines = new LineSystem(this.device);
    this.text = new TextSystem(this.device, this.fontAtlas);
    this.adaptive = new AdaptiveQuality(this, { enabled: opts.adaptive !== false });

    // --- shaders
    this._buildShaders();

    // --- targets
    this._buildTargets();

    this.renderScale = this.quality.renderScale;
    this.viewport = { x: 0, y: 0, width: this.device.width, height: this.device.height };
    this.stats = this._newStats();
    this.frameIndex = 0;
    this.time = 0;
    this.editorMode = false;
    this.drawDistance = this.quality.drawDistance;
    /** Set to false by headless tools that only need culling/AI, not pixels. */
    this.renderingEnabled = true;
    this._instanceCache = new Map();
    this._geometryCache = new Map();
    this._visibleMaterials = new Map();
    this._debugMode = opts.debugMode ?? 'none';
    this.device.onRestore(() => {
      this.textures = generateTextureKit(this.device, { size: 256 });
      this.fontAtlas = makeFontAtlas(this.device, 32);
      this.materials = new MaterialLibrary(this.device, this.textures);
      this._buildShaders();
      this._buildTargets();
      this._geometryCache.clear();
      this._instanceCache.clear();
      log.info('renderer resources rebuilt after context restore');
    });
  }

  static create(canvas, opts) { return new Renderer(canvas, opts); }

  /**
   * Creates a renderer on the best available backend (WebGPU when the browser has it, WebGL2
   * otherwise). Preferred entry point for games; `create` stays synchronous for tests/tooling.
   */
  static async createAsync(canvas, opts = {}) {
    const device = await createDevice(canvas, opts);
    return new Renderer(canvas, { ...opts, deviceInstance: device });
  }

  _newStats() {
    return {
      drawCalls: 0, triangles: 0, vertices: 0, items: 0, culled: 0, batches: 0,
      particles: 0, decals: 0, tracers: 0, sprites: 0, shadowCasters: 0,
      gpuMs: null, cpuMs: 0, materials: 0, textures: 0, gpuBytes: 0, frame: 0,
    };
  }

  _buildShaders() {
    const device = this.device;
    const geometryDesc = {
      name: 'geometry',
      vertex: ShaderSources.GEOMETRY_VERTEX,
      fragment: ShaderSources.GEOMETRY_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
      defines: { MAX_SHADOW_CASCADES: this.lights.shadowMap.cascades, MAX_BONES: 96 },
    };
    this.geometryShader = device.createShaderPermutation(geometryDesc);
    this.shadowShader = device.createShaderPermutation({
      name: 'shadow',
      vertex: ShaderSources.SHADOW_VERTEX,
      fragment: ShaderSources.SHADOW_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
      defines: { MAX_BONES: 96 },
    });
    this.viewModelShader = device.createShader({
      name: 'viewmodel',
      vertex: ShaderSources.VIEWMODEL_VERTEX,
      fragment: ShaderSources.VIEWMODEL_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
    });
    this.decalShader = device.createShader({
      name: 'decal',
      vertex: ShaderSources.DECAL_VERTEX,
      fragment: ShaderSources.DECAL_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
    });
    this.particleShader = device.createShader({
      name: 'particle',
      vertex: ShaderSources.PARTICLE_VERTEX,
      fragment: ShaderSources.PARTICLE_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
    });
    this.spriteShader = device.createShader({
      name: 'sprite',
      vertex: ShaderSources.SPRITE_VERTEX,
      fragment: ShaderSources.SPRITE_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
    });
    this.tracerShader = device.createShader({
      name: 'tracer',
      vertex: ShaderSources.TRACER_VERTEX,
      fragment: ShaderSources.TRACER_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
    });
    this.gridShader = device.createShader({
      name: 'editorGrid',
      vertex: ShaderSources.EDITOR_GRID_VERTEX,
      fragment: ShaderSources.EDITOR_GRID_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
    });
    this.pickingShader = device.createShader({
      name: 'picking',
      vertex: ShaderSources.PICKING_VERTEX,
      fragment: ShaderSources.PICKING_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
    });
    this.outlineShader = device.createShader({
      name: 'outline',
      vertex: ShaderSources.OUTLINE_VERTEX,
      fragment: ShaderSources.OUTLINE_FRAGMENT,
      attributes: BASE_ATTRIBUTES,
    });
  }

  _buildTargets() {
    const msaa = this.device.caps.isMobile ? 0 : this.quality.msaa;
    this.sceneTarget?.destroy();
    this.sceneTarget = this.device.createRenderTarget({
      width: this.device.width,
      height: this.device.height,
      format: this.device.caps.supportsHalfFloat ? TextureFormat.RGBA16F : TextureFormat.RGBA8,
      depth: true,
      depthTexture: true,
      samples: msaa,
      filter: TextureFilter.Linear,
      wrap: TextureWrap.Clamp,
      name: 'sceneHDR',
    });
    this.pickingTarget?.destroy();
    this.pickingTarget = null;
    this.post.setSize(this.device.width, this.device.height);
  }

  // ------------------------------------------------------------------ sizing
  resize(width, height, pixelRatio = this.device.pixelRatio) {
    const changed = this.device.resize(width, height, pixelRatio);
    if (!changed) return false;
    this.width = this.device.width;
    this.height = this.device.height;
    this.sceneTarget.resize(this.device.width, this.device.height);
    this.post.setSize(this.device.width, this.device.height);
    this.camera.setViewport(0, 0, this.device.width, this.device.height);
    this.viewport.width = this.device.width;
    this.viewport.height = this.device.height;
    this.Resized.emit(this.device.width, this.device.height);
    return true;
  }
  /** Dynamic resolution scaling (adaptive quality + the settings menu). */
  setRenderScale(scale) {
    this.renderScale = clamp(scale, 0.4, 1.5);
    const cssW = this.canvas.clientWidth || this.canvas.width;
    const cssH = this.canvas.clientHeight || this.canvas.height;
    this.device.renderScale = this.renderScale;
    this.device.resize(cssW, cssH, this.device.pixelRatio);
    this.width = this.device.width;
    this.height = this.device.height;
    this.sceneTarget.resize(this.device.width, this.device.height);
    this.post.setSize(this.device.width, this.device.height);
    this.camera.setViewport(0, 0, this.device.width, this.device.height);
    return this;
  }

  // ------------------------------------------------------------------ quality
  setQuality(name, { rebuildShaders = true } = {}) {
    const preset = QualityPreset[name];
    if (!preset) { log.warn(`unknown quality preset "${name}"`); return this; }
    this.qualityName = name;
    this.quality = { ...preset };
    this.post.setQuality(preset.post);
    this.lights.setQuality({
      cascades: Math.max(1, preset.shadowCascades),
      shadowResolution: preset.shadowResolution,
      shadowsEnabled: preset.shadows,
      maxPointLights: preset.maxPointLights,
      fogDensity: preset.fogDensity,
    });
    this.particles.setMaxParticles(preset.maxParticles);
    this.particles.setQualityScale(preset.particles);
    this.decals.capacity = Math.round(640 * preset.decals);
    this.drawDistance = preset.drawDistance;
    this.camera.far = preset.drawDistance;
    this.camera.dirtyProjection = true;
    if (rebuildShaders) {
      this.geometryShader.destroy();
      this.geometryShader = this.device.createShaderPermutation({
        name: 'geometry',
        vertex: ShaderSources.GEOMETRY_VERTEX,
        fragment: ShaderSources.GEOMETRY_FRAGMENT,
        attributes: BASE_ATTRIBUTES,
        defines: { MAX_SHADOW_CASCADES: Math.max(1, preset.shadowCascades), MAX_BONES: 96 },
      });
    }
    this.setRenderScale(preset.renderScale);
    this._buildTargets();
    this.QualityChanged.emit(name, preset);
    return this;
  }

  /** Applies a partial set of tweaks (settings menu sliders). */
  applySettings(settings = {}) {
    if (settings.fov !== undefined) this.camera.setFov(settings.fov);
    if (settings.renderScale !== undefined) this.setRenderScale(settings.renderScale);
    if (settings.adaptiveQuality !== undefined) this.adaptive.enabled = settings.adaptiveQuality;
    if (settings.postQuality) this.post.setQuality(settings.postQuality);
    if (settings.shadows !== undefined) this.lights.shadowsEnabled = settings.shadows;
    if (settings.shadowCascades !== undefined) this.lights.shadowMap.setQuality(settings.shadowCascades, this.lights.shadowMap.resolution);
    if (settings.viewDistance !== undefined) { this.camera.far = settings.viewDistance; this.camera.dirtyProjection = true; }
    if (settings.fogDensity !== undefined) this.lights.fogDensity = settings.fogDensity;
    if (settings.bloom !== undefined) this.post.params.bloomIntensity = settings.bloom;
    if (settings.motionBlur !== undefined) this.post.params.grain = settings.motionBlur ? 0.03 : 0.018;
    if (settings.vignette !== undefined) this.post.params.vignette = settings.vignette;
    if (settings.grain !== undefined) this.post.params.grain = settings.grain;
    if (settings.tonemapping !== undefined) this.post.params.toneMapping = settings.tonemapping;
    if (settings.saturation !== undefined) this.post.params.saturation = settings.saturation;
    return this;
  }

  // ------------------------------------------------------------------ scene API
  getMaterial(name, fallback) { return this.materials.get(name, fallback); }
  getTexture(name) { return this.textures[name] ?? this.textures.white; }
  getSceneTexture() { return this.sceneTarget.colorTexture; }
  getDepthTexture() { return this.sceneTarget.depthTextureRef; }

  /** Adds a single mesh instance to the render list. */
  addMesh(mesh, material, matrixOrPosition = null, opts = {}) {
    const item = new RenderItem({
      mesh,
      material: material ?? this.materials.get('default'),
      matrix: matrixOrPosition instanceof Matrix4 ? matrixOrPosition.clone() : new Matrix4(),
      layer: opts.layer ?? RenderLayer.Dynamic,
      castShadow: opts.castShadow ?? (material?.castShadow !== false),
      receiveShadow: opts.receiveShadow ?? true,
      owner: opts.owner,
      name: opts.name,
      skinned: opts.skinned,
      boneMatrices: opts.boneMatrices,
      vertexColors: opts.vertexColors,
      userData: opts.userData,
    });
    if (!(matrixOrPosition instanceof Matrix4) && matrixOrPosition) item.setPosition(matrixOrPosition);
    if (opts.scale || opts.rotation) item.matrix.compose(
      item.matrix.position,
      opts.rotation ?? _identityQuat,
      opts.scale ?? _oneVec,
    );
    item.updateBounds();
    this.renderList.add(item);
    return item;
  }

  /** Adds an instanced batch (trees, decals, tracers, custom FX). */
  addInstanced(mesh, material, capacity = 128, opts = {}) {
    const batch = new InstancedBatch({
      mesh, material, capacity,
      layer: opts.layer ?? RenderLayer.Dynamic,
      castShadow: opts.castShadow ?? false,
      receiveShadow: opts.receiveShadow ?? false,
      owner: opts.owner,
      name: opts.name,
      vertexColors: opts.vertexColors,
      dynamic: opts.dynamic,
      frustumCulled: opts.frustumCulled,
    });
    this.renderList.add(batch);
    return batch;
  }

  remove(item) { return this.renderList.remove(item); }
  removeByOwner(owner) { return this.renderList.removeByOwner(owner); }
  clearScene() {
    this.renderList.clear();
    this._instanceCache.clear();
    for (const entry of this._geometryCache.values()) entry.destroy?.();
    this._geometryCache.clear();
    return this;
  }

  /** Fetches (and lazily uploads) the GPU geometry for a mesh. */
  getGeometry(mesh) {
    let geo = this._geometryCache.get(mesh);
    if (!geo) {
      geo = this.device.createGeometry(mesh);
      this._geometryCache.set(mesh, geo);
    } else {
      geo.update();
    }
    return geo;
  }

  /** Builds / updates the VAO + instance buffer for an instanced batch. */
  _getInstanceResources(batch) {
    let entry = this._instanceCache.get(batch.id);
    if (!entry || entry.capacity < batch.capacity) {
      entry?.instanceBuffer?.destroy();
      const instanceBuffer = this.device.createInstanceBuffer(batch.capacity);
      const geometry = this.getGeometry(batch.mesh);
      const vao = geometry.createInstanceVAO(instanceBuffer);
      entry = { instanceBuffer, geometry, vao, capacity: batch.capacity };
      if (this._instanceCache.has(batch.id)) {
        const old = this._instanceCache.get(batch.id);
        this.device.deleteVertexArray?.(old.vao);
      }
      this._instanceCache.set(batch.id, entry);
    }
    return entry;
  }

  // ------------------------------------------------------------------ rendering
  /**
   * Renders one frame.
   * @param {number} dt seconds since the last frame
   * @param {object} [ctx] { camera, timeScale, paused }
   */
  render(dt, ctx = {}) {
    const startCpu = performance.now();
    this.frameIndex++;
    this.time += dt;
    const camera = ctx.camera ?? this.camera;
    camera.setViewport(0, 0, this.device.width, this.device.height);
    if (camera.updated !== false) camera.update(dt, ctx.cameraContext ?? {});

    this.device.beginFrame();
    this.stats = this._newStats();
    this.FrameStart.emit(dt);

    if (!this.renderingEnabled || this.device.contextLost) {
      this.stats.cpuMs = performance.now() - startCpu;
      return this;
    }

    // ---- systems update
    this.lights.update(dt, camera);
    this.sky.update(dt, this.lights);
    this.particles.update(dt, { camera, wind: this.particles.wind });
    this.decals.update(dt);
    this.sprites.update(dt);
    this.tracers.update(dt);
    this.text.update(dt);

    // ---- cull + sort
    const lists = this.renderList.prepare(camera, { shadowPass: false });
    this.stats.items = this.renderList.stats.submitted;
    this.stats.culled = this.renderList.stats.culled;
    this.stats.batches = this.renderList.stats.batches;

    // ---- 1) shadow maps
    if (this.lights.shadowsEnabled && this.lights.sun.castShadow) {
      this._renderShadowPass(camera);
    }

    // ---- 2) main pass
    this.sceneTarget.bind(true, [0.02, 0.03, 0.05, 1]);
    camera.setViewport(0, 0, this.sceneTarget.width, this.sceneTarget.height);
    this._renderGeometryPass(camera, lists);

    // ---- 3) sky (after opaque, before transparent)
    this.device.bindFramebuffer(this.sceneTarget);
    this.sky.render(camera, this.post);

    // ---- 4) decals + transparent geometry
    this.device.bindFramebuffer(this.sceneTarget);
    camera.setViewport(0, 0, this.sceneTarget.width, this.sceneTarget.height);
    this._renderTransparentPass(camera, lists);

    // ---- 5) effects
    this._renderEffects(camera);

    // ---- 6) view model
    if (ctx.drawViewmodel !== false) this._renderViewmodelPass(camera);

    // ---- 7) editor overlay (grid, gizmos) — drawn into the scene so it gets depth-tested
    if (this.editorMode) this._renderEditorPass(camera);

    // ---- 8) post processing → default framebuffer
    this.sceneTarget.resolve();
    this.post.renderSSAO(this.sceneTarget.depthTextureRef, camera);
    const bloomTex = this.post.renderBloom(this.sceneTarget.colorTexture);
    this._syncPostCameraState(camera);
    this.device.bindFramebuffer(null);
    this.device.setViewport(0, 0, this.device.width, this.device.height);
    this.post.composite(this.sceneTarget.colorTexture, bloomTex, null, camera, {
      time: this.time,
      depthTexture: this.sceneTarget.depthTextureRef,
    });

    // ---- stats
    this.stats.drawCalls = this.device._resources.drawCalls;
    this.stats.triangles = this.device._resources.triangles ?? 0;
    this.stats.materials = this.materials.materials.size;
    this.stats.textures = this.device._resources.textures;
    this.stats.gpuBytes = this.device._resources.bytes;
    this.stats.frame = this.frameIndex;
    this.stats.cpuMs = performance.now() - startCpu;
    this.adaptive.update(this.stats.cpuMs);
    this.FrameEnd.emit(this.stats);
    return this;
  }

  _syncPostCameraState(camera) {
    const c = this.post.cameraState;
    c.near = camera.near;
    c.far = camera.far;
    c.damageVignette = camera.damage.vignette;
    c.hitDirectionAngle = camera.damage.directionAngle;
    c.hitFlash = camera.damage.flash;
    c.lowHealthPulse = camera.damage.lowHealth;
    c.fade = camera.damage.fade;
    c.fadeColor = [camera.damage.fadeColor.x, camera.damage.fadeColor.y, camera.damage.fadeColor.z];
    c.adsBlend = camera.adsBlend;
    c.nightVision = camera.nightVision;
    c.underwater = camera.underwater;
  }

  // ---- passes -------------------------------------------------------------
  _renderShadowPass(camera) {
    const sm = this.lights.shadowMap;
    const casters = this.renderList.shadowCasters;
    // Camera visibility is already handled; for cascades we re-test against the caster boxes.
    const gl = this.device.gl;
    this.device.setBlend('none');
    this.device.setDepthTest(true, this.device.LEQUAL);
    this.device.setDepthWrite(true);
    this.device.setColorMask(true, true, true, true);
    for (let cascade = 0; cascade < sm.cascades; cascade++) {
      const target = sm.targets[cascade];
      target.bind(true, [1, 1, 1, 1]);
      this.device.setViewport(0, 0, target.width, target.height);
      // Reduce shadow acne: cull front faces so back-facing geometry writes depth.
      this.device.setCullFace(this.quality.shadowCascades > 0 ? 'front' : false);
      const lightVP = sm.matrices[cascade];
      const lightVPArray = lightVP.elements;
      let drawn = 0;
      for (const item of casters) {
        if (!item.castShadow) continue;
        if (item.material?.alphaMode === AlphaMode.Blend) continue;   // faded surfaces don't cast
        if (item.layer === RenderLayer.ViewModel) continue;
        const box = item.worldBounds;
        if (!box.intersectsBox(sm.casterBoxes[cascade])) continue;
        const instanced = item instanceof InstancedBatch;
        const skinned = !!item.skinned;
        const alphaTest = item.material?.hasAlphaTest;
        let key = 0;
        if (instanced) key |= ShaderFeature.Instanced;
        if (skinned) key |= ShaderFeature.Skinned;
        if (alphaTest) key |= ShaderFeature.AlphaTest;
        const shader = this.shadowShader.get(key, (bits) => ({
          INSTANCED: !!(bits & ShaderFeature.Instanced),
          SKINNED: !!(bits & ShaderFeature.Skinned),
          ALPHA_TEST: !!(bits & ShaderFeature.AlphaTest),
        }));
        shader.use().applyAll({
          uLightViewProjection: lightVPArray,
          uModelMatrix: item.matrixWorld.elements,
          uTint: [1, 1, 1, item.overrides.opacity ?? item.material?.opacity ?? 1],
          uAlphaCutoff: item.material?.alphaCutoff ?? 0.5,
          uHasAlbedoMap: item.material?.textures.albedo ? 1 : 0,
          uAlbedoMap: 1,
        });
        if (item.material?.textures.albedo) this.device.bindTexture(item.material.textures.albedo, 1);
        if (instanced) {
          const res = this._getInstanceResources(item);
          res.instanceBuffer.upload(item.count);
          this.device.bindVertexArray(res.vao);
          const geo = res.geometry;
          this.device.drawIndexedInstanced(geo.indexCount, item.count, 0);
          this.device.addTriangles((geo.indexCount / 3) * item.count);
        } else {
          const geo = this.getGeometry(item.mesh);
          geo.bind();
          this.device.drawIndexed(geo.indexCount, 0);
          this.device.addTriangles(geo.indexCount / 3);
        }
        drawn++;
      }
      this.stats.shadowCasters = Math.max(this.stats.shadowCasters, drawn);
    }
    this.device.setCullFace('back');
  }

  _geometryVariant(material, item) {
    const instanced = item instanceof InstancedBatch;
    const skinned = !!item.skinned;
    const vertexColors = !!item.vertexColors || !!material?.vertexColors;
    const cascades = this.lights.shadowsEnabled ? this.lights.shadowMap.cascades : 0;
    const mask = material.featureMask({ instanced, skinned, shadowCascades: cascades, vertexColors });
    const shader = this.geometryShader.get(mask, (bits) => {
      const defs = {};
      defs.INSTANCED = !!(bits & ShaderFeature.Instanced);
      defs.SKINNED = !!(bits & ShaderFeature.Skinned);
      if (bits & ShaderFeature.ShadowCascades) defs.SHADOW_CASCADES = true;
      defs.ALPHA_TEST = !!(bits & ShaderFeature.AlphaTest);
      defs.WIND = !!(bits & ShaderFeature.Wind);
      defs.VERTEX_COLOR = !!(bits & ShaderFeature.VertexColor);
      defs.EMISSIVE_MAP = !!(bits & ShaderFeature.EmissiveMap);
      defs.MAX_SHADOW_CASCADES = Math.max(1, cascades);
      return defs;
    });
    return shader;
  }

  _renderGeometryPass(camera, lists) {
    const gl = this.device.gl;
    this.device.setBlend('none');
    this.device.setDepthTest(true, this.device.LEQUAL);
    this.device.setDepthWrite(true);
    this.device.setCullFace('back');
    this.device.setColorMask(true, true, true, true);

    const buckets = [lists.opaque, lists.cutout];
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      for (const item of bucket) {
        if (item.layer === RenderLayer.ViewModel || item.layer === RenderLayer.Overlay) continue;
        if (item.material === null || item.material === undefined) continue;
        const shader = this._geometryVariant(item.material, item);
        this._bindMaterialGeometry(item, shader, camera);
        const instanced = item instanceof InstancedBatch;
        if (instanced) {
          const res = this._getInstanceResources(item);
          res.instanceBuffer.upload(item.count);
          this.device.bindVertexArray(res.vao);
          this.device.drawIndexedInstanced(res.geometry.indexCount, item.count, 0);
          this.device.addTriangles((res.geometry.indexCount / 3) * item.count);
        } else {
          const geo = this.getGeometry(item.mesh);
          geo.bind();
          if (geo.isIndexed) { this.device.drawIndexed(geo.indexCount, 0); this.device.addTriangles(geo.indexCount / 3); }
          else { this.device.draw(geo.vertexCount); this.device.addTriangles(geo.vertexCount / 3); }
        }
      }
    }
    this.device.setCullFace('back');
  }

  _renderTransparentPass(camera, lists) {
    const gl = this.device.gl;
    this.device.setBlend('alpha');
    this.device.setDepthTest(true, this.device.LEQUAL);
    this.device.setDepthWrite(false);
    this._renderDecals(camera);
    // Re-sort transparent items back-to-front is already handled by RenderList.
    for (const item of lists.transparent) {
      if (item.layer === RenderLayer.ViewModel || item.layer === RenderLayer.Overlay) continue;
      const material = item.material;
      this.device.setBlend(blendModeFor(material));
      this.device.setDepthWrite(material.depthWrite && material.alphaMode === AlphaMode.Opaque);
      this.device.setCullFace(material.doubleSided ? false : 'back');
      const shader = this._geometryVariant(material, item);
      this._bindMaterialGeometry(item, shader, camera);
      const instanced = item instanceof InstancedBatch;
      if (instanced) {
        const res = this._getInstanceResources(item);
        res.instanceBuffer.upload(item.count);
        this.device.bindVertexArray(res.vao);
        this.device.drawIndexedInstanced(res.geometry.indexCount, item.count, 0);
        this.device.addTriangles((res.geometry.indexCount / 3) * item.count);
      } else {
        const geo = this.getGeometry(item.mesh);
        geo.bind();
        if (geo.isIndexed) { this.device.drawIndexed(geo.indexCount, 0); this.device.addTriangles(geo.indexCount / 3); }
        else { this.device.draw(geo.vertexCount); this.device.addTriangles(geo.vertexCount / 3); }
      }
    }
    this.device.setCullFace('back');
    this.device.setDepthWrite(true);
    void gl;
  }

  _bindMaterialGeometry(item, shader, camera) {
    const material = item.material;
    const uniforms = {
      uModelMatrix: item.matrixWorld.elements,
      uNormalMatrix: item.matrixWorld.toNormalMatrix(),
      uViewMatrix: camera.viewMatrix.elements,
      uProjectionMatrix: camera.projectionMatrix.elements,
      uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
      uCameraPosition: camera.worldPosition,
      uTime: this.time,
      uWindStrength: this.lights.fogMode > 0 ? 0.12 : 0.12,
      uWindSpeed: 1.1,
      uWindDirection: [1, 0, 0.35],
    };
    shader.use().applyAll(uniforms);
    material.apply(shader);
    if (item.overrides?.tint) shader.apply('uTint', item.overrides.tint);
    if (item.overrides?.damageFlash) shader.apply('uDamageFlash', item.overrides.damageFlash);
    if (item.overrides?.emissiveScale !== undefined && item.overrides.emissiveScale !== 1) {
      shader.apply('uEmissive', [
        material.emissive.r * item.overrides.emissiveScale,
        material.emissive.g * item.overrides.emissiveScale,
        material.emissive.b * item.overrides.emissiveScale,
      ]);
    }
    if (item.skinned && item.boneMatrices) {
      shader.apply('uBoneMatrices', item.boneMatrices);
    }
    if (item.customUniforms) {
      for (const [k, v] of Object.entries(item.customUniforms)) shader.apply(k, v);
    }
    // textures (bound to fixed units so the cache stays valid)
    let unit = 1;
    const bind = (tex, name, hasName) => {
      if (tex) { this.device.bindTexture(tex, unit); shader.apply(name, unit); shader.apply(hasName, 1); unit++; }
      else { shader.apply(hasName, 0); }
    };
    bind(material.textures.albedo, 'uAlbedoMap', 'uHasAlbedoMap');
    bind(material.textures.normal, 'uNormalMap', 'uHasNormalMap');
    bind(material.textures.roughness, 'uRoughnessMap', 'uHasRoughnessMap');
    bind(material.textures.metalness, 'uMetalnessMap', 'uHasMetalnessMap');
    bind(material.textures.ao, 'uAoMap', 'uHasAoMap');
    bind(material.textures.emissive, 'uEmissiveMap', 'uHasEmissiveMap');
    this.lights.applyUniforms(shader, camera);
    return shader;
  }

  _renderDecals(camera) {
    const batch = this.decals.buildBatch(camera);
    if (batch.count === 0) return;
    const shader = this.decalShader;
    shader.use().applyAll({
      uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
      uDecalAtlas: 0,
      uCameraPosition: camera.worldPosition,
      uFogColor: this.lights.fogColor,
      uFogDensity: this.lights.fogDensity,
      uFogStart: this.lights.fogStart,
      uFogEnd: this.lights.fogEnd,
      uFogMode: this.lights.fogMode,
      uOpacity: 1,
    });
    this.device.bindTexture(this.textures.decals, 0);
    const res = this._getInstanceResources(batch);
    res.instanceBuffer.upload(batch.count);
    this.device.bindVertexArray(res.vao);
    this.device.setBlend('alpha');
    this.device.setDepthWrite(false);
    this.device.drawIndexedInstanced(res.geometry.indexCount, batch.count, 0);
    this.device.addTriangles((res.geometry.indexCount / 3) * batch.count);
    this.stats.decals = batch.count;
  }

  _renderEffects(camera) {
    const gl = this.device.gl;
    this.device.setDepthTest(true, this.device.LEQUAL);
    this.device.setDepthWrite(false);
    this.device.setCullFace(false);

    // --- particles (one instanced draw per texture, back-to-front within each group)
    const particleBatches = this.particles.buildBatches(camera, this.materials);
    const ps = this.particleShader;
    if (particleBatches.length) {
      ps.use().applyAll({
        uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
        uViewMatrix: camera.viewMatrix.elements,
        uCameraPosition: camera.worldPosition,
        uCameraRight: camera.right,
        uCameraUp: camera.upVector,
        uParticleTexture: 0,
        uFogMode: this.lights.fogMode,
        uFogColor: this.lights.fogColor,
        uFogStart: this.lights.fogStart,
        uFogEnd: this.lights.fogEnd,
      });
      for (const batch of particleBatches) {
        const tex = this.textures[batch.texKey] ?? this.textures.glow;
        this.device.bindTexture(tex, 0);
        this.device.setBlend(batch.material?.alphaMode === AlphaMode.Additive ? 'additive' : 'premultiplied');
        const res = this._getInstanceResources(batch);
        res.instanceBuffer.upload(batch.count);
        this.device.bindVertexArray(res.vao);
        this.device.drawIndexedInstanced(res.geometry.indexCount, batch.count, 0);
        this.device.addTriangles((res.geometry.indexCount / 3) * batch.count);
      }
      this.stats.particles = this.particles.activeCount;
    }

    // --- tracers
    const tracerBatch = this.tracers.buildBatch(this.materials.get('Tracer'));
    if (tracerBatch.count > 0) {
      const shader = this.tracerShader;
      shader.use().applyAll({
        uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
        uCameraPosition: camera.worldPosition,
        uTexture: 0,
        uTime: this.time,
      });
      this.device.bindTexture(this.textures.tracer, 0);
      this.device.setBlend('additive');
      const res = this._getInstanceResources(tracerBatch);
      res.instanceBuffer.upload(tracerBatch.count);
      this.device.bindVertexArray(res.vao);
      this.device.drawIndexedInstanced(res.geometry.indexCount, tracerBatch.count, 0);
      this.device.addTriangles((res.geometry.indexCount / 3) * tracerBatch.count);
      this.stats.tracers = tracerBatch.count;
    }

    // --- sprites (muzzle flash, glows, ground markers)
    const spriteBatches = this.sprites.buildBatches(this.materials);
    if (spriteBatches.length) {
      const shader = this.spriteShader;
      shader.use().applyAll({
        uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
        uCameraPosition: camera.worldPosition,
        uTexture: 0,
        uBillboard: 1,
        uFogMode: this.lights.fogMode,
        uFogColor: this.lights.fogColor,
        uFogStart: this.lights.fogStart,
        uFogEnd: this.lights.fogEnd,
      });
      for (const batch of spriteBatches) {
        // Sprite shader uses uniforms for size/uv; batch-level values come from the first sprite
        // and per-instance color/params carry the variation.
        const tex = this.textures[batch.texKey] ?? this.textures.glow;
        this.device.bindTexture(tex, 0);
        this.device.setBlend(batch.additive ? 'additive' : 'alpha');
        const res = this._getInstanceResources(batch);
        res.instanceBuffer.upload(batch.count);
        this.device.bindVertexArray(res.vao);
        this.device.drawIndexedInstanced(res.geometry.indexCount, batch.count, 0);
        this.device.addTriangles((res.geometry.indexCount / 3) * batch.count);
      }
      this.stats.sprites = spriteBatches.reduce((s, b) => s + b.count, 0);
    }

    // --- 3D text
    const textBatch = this.text.buildBatch(camera, this.materials.get('MuzzleFlash'));
    if (textBatch.count > 0) {
      const shader = this.text.shader;
      shader.use().applyAll({
        uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
        uCameraRight: camera.right,
        uCameraUp: camera.upVector,
        uFontAtlas: 0,
      });
      this.device.bindTexture(this.fontAtlas.texture, 0);
      this.device.setBlend('alpha');
      const res = this._getInstanceResources(textBatch);
      res.instanceBuffer.upload(textBatch.count);
      this.device.bindVertexArray(res.vao);
      this.device.drawIndexedInstanced(res.geometry.indexCount, textBatch.count, 0);
      this.device.addTriangles((res.geometry.indexCount / 3) * textBatch.count);
    }
    this.device.setCullFace('back');
    this.device.setDepthWrite(true);
  }

  /**
   * View-model pass: the weapon (and hands) rendered with its own narrow FOV, its own bob,
   * sway, ADS blend and recoil, on top of a cleared depth buffer so it never intersects the
   * world. This is what makes a web FPS feel like a real one.
   */
  _renderViewmodelPass(camera) {
    const gl = this.device.gl;
    const items = this.renderList.visibleItems.filter((it) => it.layer === RenderLayer.ViewModel);
    const batches = this.renderList.visibleBatches.filter((b) => b.layer === RenderLayer.ViewModel);
    if (items.length === 0 && batches.length === 0) return;
    this.device.bindFramebuffer(this.sceneTarget);
    camera.setViewport(0, 0, this.sceneTarget.width, this.sceneTarget.height);
    this.device.clearDepth(1);
    this.device.setDepthTest(true, this.device.LEQUAL);
    this.device.setDepthWrite(true);
    this.device.setBlend('none');
    this.device.setCullFace('back');
    this.device.setScissor(null);

    const vm = camera.viewModel;
    const recoil = camera.viewModel.recoilRotation;
    for (const item of [...items, ...batches]) {
      const material = item.material;
      if (!material) continue;
      const shader = this.viewModelShader;
      shader.use().applyAll({
        uModelMatrix: item.matrixWorld.elements,
        uNormalMatrix: item.matrixWorld.toNormalMatrix(),
        uViewProjectionMatrix: vm.viewProjectionMatrix.elements,
        uTime: this.time,
        uWeaponBob: [vm.bob.x, vm.bob.y],
        uSwayOffset: [vm.sway.x, vm.sway.y, vm.sway.z],
        uWeaponRotation: [recoil.x, recoil.y, recoil.z],
        uAdsBlend: camera.adsBlend,
        uAdsPosition: [vm.adsPosition.x, vm.adsPosition.y],
        uFovScale: vm.fov / camera.fov,
        uCameraPosition: camera.worldPosition,
        uSunDirection: this.lights.sun.direction,
        uSunColor: [this.lights.sun.color.r * this.lights.sun.intensity, this.lights.sun.color.g * this.lights.sun.intensity, this.lights.sun.color.b * this.lights.sun.intensity],
        uSunIntensity: this.lights.sun.intensity,
        uAmbientSky: this.lights.ambientSky,
        uAmbientGround: this.lights.ambientGround,
        uAmbientIntensity: this.lights.ambientIntensity,
        uMuzzleFlashColor: [1, 0.82, 0.45],
        uMuzzleFlashIntensity: this.viewmodelFlash ?? 0,
        uMuzzleFlashPosition: this.viewmodelFlashPosition ?? [0, 0, 0],
      });
      material.apply(shader);
      if (material.textures.albedo) { shader.apply('uAlbedoMap', 1); shader.apply('uHasAlbedoMap', 1); this.device.bindTexture(material.textures.albedo, 1); }
      else shader.apply('uHasAlbedoMap', 0);
      const geo = this.getGeometry(item.mesh);
      geo.bind();
      if (geo.isIndexed) { this.device.drawIndexed(geo.indexCount, 0); this.device.addTriangles(geo.indexCount / 3); }
      else { this.device.draw(geo.vertexCount); this.device.addTriangles(geo.vertexCount / 3); }
    }
    this.viewmodelFlash = 0;
  }

  /** Editor-only pass: infinite grid + selection outline + debug primitives. */
  _renderEditorPass(camera) {
    this._debugGrid ??= buildGridMesh(80, 80, 1);
    const geo = this.getGeometry(this._debugGrid);
    const shader = this.gridShader;
    shader.use().applyAll({
      uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
      uCameraPosition: camera.worldPosition,
      uFadeDistance: 120,
    });
    geo.bind();
    this.device.setDepthTest(false);
    this.device.setBlend('alpha');
    this.device.setDepthWrite(false);
    this.device.drawLines(geo.vertexCount);
    this.device.setDepthTest(true);
    this.device.setDepthWrite(true);
    this.lines.render(camera);
  }

  // ------------------------------------------------------------------ utilities
  /** Screen-space pick: renders IDs into an offscreen target and reads one pixel. */
  pick(screenX, screenY, camera = this.camera) {
    const w = Math.min(this.device.width, 1920);
    const h = Math.min(this.device.height, 1080);
    if (!this.pickingTarget || this.pickingTarget.width !== w || this.pickingTarget.height !== h) {
      this.pickingTarget?.destroy();
      this.pickingTarget = this.device.createRenderTarget({
        width: w, height: h, format: TextureFormat.RGBA8, depth: true, filter: TextureFilter.Nearest, name: 'picking',
      });
    }
    const target = this.pickingTarget;
    target.bind(true, [0, 0, 0, 0]);
    this.device.setBlend('none');
    this.device.setDepthTest(true);
    this.device.setDepthWrite(true);
    const shader = this.pickingShader;
    const scaleX = w / this.device.width;
    const scaleY = h / this.device.height;
    camera.setViewport(0, 0, w, h);
    let index = 1;
    const mapping = new Map();
    for (const item of this.renderList.visibleItems) {
      if (!item.owner) continue;
      const color = idToColor(index);
      mapping.set(index, item.owner);
      shader.use().applyAll({
        uModelMatrix: item.matrixWorld.elements,
        uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
        uPickColor: color,
      });
      const geo = this.getGeometry(item.mesh);
      geo.bind();
      if (geo.isIndexed) this.device.drawIndexed(geo.indexCount, 0);
      else this.device.draw(geo.vertexCount);
      index++;
    }
    const px = Math.floor(clamp(screenX * scaleX, 0, w - 1));
    const py = Math.floor(clamp((1 - screenY / this.device.height) * h, 0, h - 1));
    const raw = this.device.readPixel(px, py);
    const id = (raw[0] << 16) | (raw[1] << 8) | raw[2];
    camera.setViewport(0, 0, this.device.width, this.device.height);
    return mapping.get(id) ?? null;
  }

  /** Renders a depth+outline pass for the currently selected object (editor). */
  renderOutline(item, camera = this.camera, color = [1, 0.62, 0.1, 1]) {
    if (!item) return this;
    this.device.bindFramebuffer(this.sceneTarget);
    const shader = this.outlineShader;
    shader.use().applyAll({
      uModelMatrix: item.matrixWorld.elements,
      uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
      uThickness: 0.02,
      uColor: color,
    });
    const geo = this.getGeometry(item.mesh);
    geo.bind();
    this.device.setCullFace('front');
    this.device.setDepthTest(true);
    this.device.setBlend('alpha');
    if (geo.isIndexed) this.device.drawIndexed(geo.indexCount, 0);
    else this.device.draw(geo.vertexCount);
    this.device.setCullFace('back');
    return this;
  }

  /** Muzzle flash: lights the weapon and pushes a short-lived point light. */
  flashMuzzle(position, intensity = 1, color = null) {
    this.viewmodelFlash = intensity;
    this.viewmodelFlashPosition = [position.x, position.y, position.z];
    const light = this._flastLight ??= this.lights.add(new Light({
      type: LightType.Point,
      name: 'MuzzleFlashLight',
      color: color ?? '#ffcf8a',
      intensity: 0,
      range: 9,
      position,
    }));
    light.position.copy(position);
    light.color.copy(color ? Color3.fromCSS(color) : _flashColor);
    light._baseIntensity = 0;
    light.intensity = intensity * 6;
    light.range = 9 + intensity * 4;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { light.intensity = 0; }, 55);
    return light;
  }

  screenshot(type = 'image/png', quality = 0.92) { return this.device.toDataURL(type, quality); }

  setDebugMode(mode) { this._debugMode = mode; return this; }

  getStats() {
    const gpu = this.device.getStats();
    return {
      ...this.stats,
      fps: this.adaptive ? 1 / Math.max(this.stats.cpuMs / 1000, 1e-6) : 0,
      renderScale: this.renderScale,
      resolution: `${this.width}×${this.height}`,
      quality: this.qualityName,
      cpuMs: this.stats.cpuMs,
      gpuBytesText: formatBytes(gpu.gpuBytes),
      shadow: this.lights.getStats(),
      particleStats: this.particles.getStats(),
      decalStats: this.decals.getStats(),
      post: { quality: this.post.quality, memoryMB: this.post.memoryBytes / 1048576 },
      caps: this.device.caps,
      warnings: this.warnings,
      renderer: gpu.renderer,
    };
  }

  /** Compact one-line summary for the in-game perf overlay (F3 style). */
  getPerfLine() {
    return `${this.stats.cpuMs.toFixed(2)}ms | ${this.device._resources.drawCalls} calls | ${(this.device._resources.triangles ?? 0).toLocaleString()} tris | ${this.stats.items} items (${this.stats.culled} culled) | ${this.stats.particles}p | ${this.renderScale.toFixed(2)}x`;
  }

  destroy() {
    this.renderList.clear();
    for (const entry of this._geometryCache.values()) entry.destroy?.();
    this._geometryCache.clear();
    this._instanceCache.clear();
    this.post.destroy();
    this.sceneTarget?.destroy();
    this.pickingTarget?.destroy();
    this.lines.destroy();
    this.device.destroy();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function blendModeFor(material) {
  if (!material) return BlendMode.None;
  switch (material.alphaMode) {
    case AlphaMode.Additive: return BlendMode.Additive;
    case AlphaMode.Premultiplied: return BlendMode.Premultiplied;
    case AlphaMode.Blend: return BlendMode.Alpha;
    default: return BlendMode.None;
  }
}

function idToColor(index) {
  const r = (index >> 16) & 0xff;
  const g = (index >> 8) & 0xff;
  const b = index & 0xff;
  return [r / 255, g / 255, b / 255, 1];
}

/** Builds a two-tier editor grid (1 m minor, 10 m major) as a line mesh. */
function buildGridMesh(halfSize = 50, divisions = 50, step = 1) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const addLine = (x0, z0, x1, z1, r, g, b, a) => {
    const base = positions.length / 3;
    positions.push(x0, 0, z0, x1, 0, z1);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(0, 0, 1, 1);
    colors.push(r, g, b, a, r, g, b, a);
    indices.push(base, base + 1);
  };
  const extent = halfSize * step;
  for (let i = -divisions; i <= divisions; i++) {
    const p = i * step;
    const major = i % 10 === 0;
    const axis = i === 0;
    const r = axis ? 0.9 : major ? 0.55 : 0.32;
    const g = axis ? 0.35 : major ? 0.55 : 0.32;
    const b = axis ? 0.35 : major ? 0.6 : 0.34;
    const a = axis ? 0.85 : major ? 0.5 : 0.24;
    addLine(p, -extent, p, extent, r, g, b, a);
    addLine(-extent, p, extent, p, r, g, b, a);
  }
  return new Mesh({
    name: 'EditorGrid',
    positions, normals, uvs, colors, indices,
  });
}

const _identityQuat = { x: 0, y: 0, z: 0, w: 1 };
const _oneVec = new Vector3(1, 1, 1);
const _flashColor = Color3.fromCSS('#ffcf8a');
void Vector2;
void lerp;
void clamp01;
void Material;
void RenderQueue;

export { RenderLayer, DecalKind, MaterialToDecal, ParticlePresets, ShakePreset, PostQuality };
export default Renderer;
