/**
 * OminX Engine — application runtime.
 *
 * `Engine` is what everything above the renderer talks to: it owns the device and renderer, the
 * scene and its collision world, the gameplay systems (ballistics, audio, HUD, match logic), the
 * camera and input, and the frame loop. Both the Studio editor and the shipped FPS game run on top
 * of it: the editor drives `edit` mode (fly camera, grid, gizmos, no simulation) and the game
 * drives `play` mode (simulation + HUD + bots + netcode).
 *
 * ```js
 * const engine = await Engine.create(canvas);
 * await engine.loadMap(MapKind.Urban, { seed: 21 });
 * engine.start();
 * engine.play();
 * ```
 *
 * @module src/app/Engine
 */
import { Renderer, QualityPreset } from '../../engine/src/renderer/Renderer.js';
import { Camera } from '../../engine/src/renderer/Camera.js';
import { Scene } from '../../engine/src/world/Scene.js';
import { LevelBuilder, MapKind, MapArchetypes } from '../../engine/src/world/LevelBuilder.js';
import { NavGraph } from '../../engine/src/world/NavGraph.js';
import { BallisticsSystem } from '../../engine/src/gameplay/Ballistics.js';
import { Player } from '../../engine/src/gameplay/Player.js';
import { BotDifficulty } from '../../engine/src/gameplay/Bot.js';
import { InputManager } from '../../engine/src/input/InputManager.js';
import { Signal } from '../../engine/src/core/Signal.js';
import { createLogger } from '../../engine/src/core/Logger.js';
import { Vector3 } from '../../engine/src/math/Vector3.js';
import { clamp, clamp01 } from '../../engine/src/math/MathUtils.js';
import { PlayerController } from '../game/PlayerController.js';
import { PlaySession } from '../game/PlaySession.js';
import { HUD } from '../game/HUD.js';

const log = createLogger('Engine');

export const EngineMode = { Edit: 'edit', Play: 'play', Paused: 'paused' };

/** Persisted player-side settings (also editable from the in-game menu). */
export const DefaultSettings = {
  sensitivity: 0.0026,
  adsSensitivityScale: 0.62,
  invertY: false,
  fov: 90,
  adsFov: true,
  quality: 'High',
  renderScale: 1,
  adaptiveQuality: true,
  viewDistance: 500,
  shadows: true,
  shadowCascades: 3,
  bloom: 1,
  grain: 0.018,
  vignette: 0.55,
  saturation: 1.05,
  tonemapping: 'aces',
  masterVolume: 0.8,
  musicVolume: 0.35,
  sfxVolume: 0.9,
  voiceVolume: 0.7,
  hudScale: 1,
  showFps: true,
  showNetGraph: false,
  crosshairStyle: 'dynamic',
  hitmarkers: true,
  damageNumbers: true,
  botCount: 8,
  botDifficulty: 'regular',
  friendlyFire: false,
  respawnTime: 5,
  scoreLimit: 60,
  timeLimitMinutes: 10,
};

export class Engine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {object} [opts.settings] overrides merged over `DefaultSettings`
   * @param {Renderer} [opts.renderer] pre-built renderer (tests / tooling)
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.settings = { ...DefaultSettings, ...(opts.settings ?? {}) };
    this.settingsKey = opts.settingsKey ?? 'ominx.settings.v1';
    this.hudCanvas = opts.hudCanvas ?? null;
    this.renderer = opts.renderer ?? null;
    this.mode = EngineMode.Edit;
    this.time = 0;
    this.frame = 0;
    this.paused = false;
    this.running = false;
    this.accumulator = 0;
    this.fixedStep = opts.fixedStep ?? 1 / 60;
    this.maxSubSteps = opts.maxSubSteps ?? 5;
    this.frameMs = 16.7;
    this.fpsSamples = [];
    this.debug = opts.debug ?? false;

    this.FrameStart = new Signal('Engine.FrameStart');
    this.FrameEnd = new Signal('Engine.FrameEnd');
    this.ModeChanged = new Signal('Engine.ModeChanged');
    this.MapLoaded = new Signal('Engine.MapLoaded');
    this.Resized = new Signal('Engine.Resized');
    this.MeshAdded = new Signal('Engine.MeshAdded');
    this.Notice = new Signal('Engine.Notice');
    this.SettingsChanged = new Signal('Engine.SettingsChanged');

    this.scene = null;
    this.nav = null;
    this.ballistics = null;
    this.camera = null;
    this.input = null;
    this.audio = null;
    this.hud = null;
    this.session = null;
    this.controller = null;
    this.editor = null;
    this.net = null;
    this.scripts = null;
    this.io = null;
    this.exporter = null;
    this.player = null;
    this.actors = new Set();
    this._mapInfo = null;
    this._tmp = new Vector3();
  }

  /**
   * Builds the whole runtime: device → renderer → camera → scene → systems.
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts] forwarded to `Renderer.createAsync`
   */
  static async create(canvas, opts = {}) {
    const engine = new Engine(canvas, opts);
    const settings = engine.settings;
    engine.renderer = await Renderer.createAsync(canvas, {
      quality: settings.quality,
      pixelRatio: opts.pixelRatio,
      backend: opts.backend,
      adaptive: settings.adaptiveQuality,
      fov: settings.fov,
      skyMode: opts.skyMode,
    });
    engine.backend = engine.renderer.backend;
    engine.camera = opts.camera ?? new Camera({
      fov: settings.fov,
      aspect: engine.renderer.device.aspect,
      near: 0.05,
      far: settings.viewDistance,
    });
    engine.renderer.camera ??= engine.camera;
    engine.input = new InputManager({ element: opts.inputElement ?? canvas, gamepad: opts.gamepad !== false });
    engine.audio = await engine._createAudio();
    engine.hud = new HUD({
      canvas: engine.hudCanvas,
      settings: engine.settings,
      audio: engine.audio,
      renderer: engine.renderer,
    });
    await engine._createAuthoringLayers();
    engine.applySettings(engine.settings, { silent: true });
    engine._installResizeHandler();
    engine._loadSettings();
    log.info(`runtime ready — backend ${engine.backend}, quality ${settings.quality}`);
    return engine;
  }

  async _createAudio() {
    try {
      const { AudioEngine } = await import('../audio/AudioEngine.js');
      return new AudioEngine({ settings: this.settings });
    } catch (error) {
      log.warn(`audio engine unavailable: ${error.message}`);
      return null;
    }
  }

  /** Boots the scripting runtime, project I/O and the build exporter (Studio + shipped game both need them). */
  async _createAuthoringLayers() {
    try {
      const { ScriptRuntime } = await import('../scripting/ScriptRuntime.js');
      this.scripts = new ScriptRuntime(this, {
        onOutput: ({ level, message }) => {
          this.editor?.log?.(level, message);
          if (level === 'error' && !this.editor) log.error(message);
        },
      });
    } catch (error) {
      log.warn(`script runtime unavailable: ${error.message}`);
    }
    try {
      const { ProjectIO } = await import('../save/ProjectIO.js');
      this.io = new ProjectIO(this, { scripts: this.scripts });
      const { Exporter } = await import('../export/Exporter.js');
      this.exporter = new Exporter(this, this.io);
    } catch (error) {
      log.warn(`project I/O unavailable: ${error.message}`);
    }
    return this;
  }

  _installResizeHandler() {
    if (typeof window === 'undefined') return;
    this._onResize = () => {
      const width = this.canvas.clientWidth || window.innerWidth;
      const height = this.canvas.clientHeight || window.innerHeight;
      this.renderer.resize(width, height, window.devicePixelRatio);
      this.hud?.resize(this.renderer.device.width, this.renderer.device.height);
      this.Resized?.emit?.(width, height);
    };
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  // ------------------------------------------------------------------ maps & scenes
  /**
   * Clears the world and builds a level from the map library (or an empty arena for the editor).
   * @returns {Promise<{spawns: object, objectives: Array, stats: object}>}
   */
  async loadMap(kind = MapKind.Urban, { seed = 1337, nav = true, sandbox = false, timeOfDay = null } = {}) {
    this.stop();
    this._destroySession();
    const scene = new Scene({ Name: `Map_${kind}` });
    scene.objectives = [];
    this.scene = scene;
    this.renderer.clearScene();
    this.renderer.camera = this.camera;

    if (sandbox) {
      // The editor's default scene: a compact arena (floor, walls, cover, spawns, objectives) that
      // is immediately playable and cheap enough to iterate on.
      const builder = new LevelBuilder(scene, { kind: MapKind.Arena, seed, size: 56, name: 'Sandbox' });
      const result = builder.build({ withNav: nav });
      this.nav = result.nav;
      this._mapInfo = { kind: 'sandbox', spawns: result.spawns, objectives: result.objectives, bounds: result.bounds, stats: result.stats };
    } else {
      const builder = new LevelBuilder(scene, { kind, seed });
      const result = builder.build({ withNav: nav });
      this.nav = result.nav;
      this._mapInfo = { kind, spawns: result.spawns, objectives: result.objectives, bounds: result.bounds, stats: result.stats };
      if (timeOfDay !== null) this.setTimeOfDay(timeOfDay);
    }
    this.applyEnvironment();

    this.ballistics = new BallisticsSystem(scene, {
      renderer: this.renderer,
      audio: this.audio,
      rng: undefined,
      onDamage: (info) => this._onDamage(info),
    });
    this.ballistics.Kill.connect((event) => this._onKill(event));
    this.ballistics.Hit.connect((event) => this.hud?.onHit?.(event));
    this.ballistics.Suppressed.connect((event) => this.audio?.playNearMiss?.(event));
    this._bindScriptEvents();
    this.actors.clear();
    this.player = null;
    this._syncRendererScene();
    this.MapLoaded.emit({ kind, seed, info: this._mapInfo });
    log.info(`map "${kind}" ready (seed ${seed}) — ${this._mapInfo.stats?.parts ?? 0} parts`);
    return this._mapInfo;
  }

  /**
   * Mirrors gameplay signals into the script runtime so author scripts can react to the match:
   * `event('ShotFired'|'Hit'|'Kill'|'ActorHit'|'Explosion'|'Objective'|'Notice', payload)`.
   */
  _bindScriptEvents() {
    if (!this.scripts || !this.ballistics) return this;
    const forward = (signal, name) => signal?.connect?.((payload) => this.scripts.fireEvent(name, payload));
    forward(this.ballistics.ShotFired, 'ShotFired');
    forward(this.ballistics.Hit, 'Hit');
    forward(this.ballistics.ActorHit, 'ActorHit');
    forward(this.ballistics.Kill, 'Kill');
    forward(this.ballistics.ProjectileSpawned, 'ProjectileSpawned');
    forward(this.ballistics.ProjectileImpact, 'ProjectileImpact');
    forward(this.ballistics.Explosion, 'Explosion');
    forward(this.ballistics.Suppressed, 'Suppressed');
    forward(this.Notice, 'Notice');
    return this;
  }

  /** Inserts a prop from the geometry library into the current scene (editor + scripting). */
  spawnProp(name, position, opts = {}) {
    if (!this.scene) return null;
    const part = this.scene.spawnProp(name, position, opts);
    if (part) this.MeshAdded?.emit?.(part);
    return part;
  }

  /** Re-registers every part in the scene with the renderer (after a load or a big edit). */
  _syncRendererScene() {
    this.renderer.clearScene();
    if (!this.scene) return;
    for (const part of this.scene.getParts()) {
      if (typeof part.submit === 'function') {
        part.submit(this.renderer);
      }
    }
  }

  /** Rebuilds the nav graph (editor "rebuild nav" button, or after large edits). */
  rebuildNav({ cell = 2 } = {}) {
    if (!this.scene) return null;
    const bounds = this._mapInfo?.bounds ?? { min: -32, max: 32 };
    this.nav = new NavGraph(this.scene, { bounds, cell, agentHeight: 1.8, agentRadius: 0.4 });
    this.nav.build();
    this.Notice.emit(`nav rebuilt — ${this.nav.nodes.length} nodes`);
    return this.nav;
  }

  applyEnvironment() {
    if (!this.scene) return;
    this.scene.applyEnvironment(this.renderer.lights, this.renderer.sky);
    this.renderer.lights.fogDensity = this.scene.environment.fogDensity;
  }

  setTimeOfDay(hours) {
    this.scene?.setTimeOfDay(hours);
    this.renderer.sky.setTimeOfDay(hours, this.renderer.lights);
    return this;
  }

  /**
   * Advances the day/night cycle. Called every frame in play mode when the map enables it.
   */
  _updateDayCycle(dt) {
    const env = this.scene?.environment;
    if (!env) return;
    const speed = env.timeScale ?? 0;
    if (!speed) return;
    env.dayTime = (env.dayTime + (dt / 60) * speed) % 24;
    this.renderer.sky.setTimeOfDay(env.dayTime, this.renderer.lights);
  }

  // ------------------------------------------------------------------ actors
  /**
   * Spawns the local player at a team spawn point with a loadout.
   * @param {object} [opts] `{ team, loadout, spawnIndex, name }`
   */
  spawnPlayer(opts = {}) {
    const team = opts.team ?? 'blue';
    const spawn = opts.position ?? this.pickSpawnPoint(team, { avoid: opts.avoid ?? [] });
    const player = new Player(this.scene, {
      name: opts.name ?? 'You',
      displayName: opts.displayName ?? 'You',
      team,
      isLocal: true,
      renderer: this.renderer,
      ballistics: this.ballistics,
      input: this.input,
      audio: this.audio,
      hud: this.hud,
      camera: this.camera,
      position: spawn ?? this._safeSpawn(),
      yaw: opts.yaw ?? Math.PI,
      health: opts.health,
    });
    player.controller = this.controller;
    player.registerWith(this.ballistics);
    // Every player ships with a working gun: an empty loadout is not a valid state for an FPS, and
    // the constructor leaves the player in `Spawning` until `spawn()` is called.
    player.setLoadout(opts.loadout ?? this.settings.loadout ?? 'assault');
    if (opts.spawn !== false) player.spawn(spawn ?? opts.position ?? { position: this._safeSpawn() });
    this.player = player;
    this.actors.add(player);
    this.renderer.camera = this.camera;
    return player;
  }

  /**
   * Spawns bots on both teams. Difficulty and count come from settings unless overridden.
   * @param {object} [opts] `{ count, team, difficulty, skill }`
   */
  spawnBots(opts = {}) {
    if (!this.session) return [];
    const total = opts.count ?? this.settings.botCount;
    const difficulty = BotDifficulty[opts.difficulty ?? this.settings.botDifficulty] ?? BotDifficulty.regular;
    const bots = [];
    for (let i = 0; i < total; i++) {
      const team = opts.team ?? (i % 2 === 0 ? 'red' : 'blue');
      bots.push(this.session.spawnBot({ team, difficulty, skill: opts.skill ?? difficulty }));
    }
    return bots;
  }

  /** Fills both teams so a match has a stable size (used when a bot dies and respawns). */
  topUpBots() {
    if (!this.session) return [];
    return this.session.topUp(this.settings.botCount, BotDifficulty[this.settings.botDifficulty] ?? BotDifficulty.regular);
  }

  _safeSpawn() {
    const points = this.scene?.getSpawnPoints?.('blue') ?? [];
    if (points.length) return points[0].clone();
    return new Vector3(0, 2, 0);
  }

  /** Spawn point for a team, avoiding positions where enemies recently spawned. */
  pickSpawnPoint(team = 'blue', { avoid = [], minDistance = 12 } = {}) {
    const points = this._mapInfo?.spawns?.[team] ?? this.scene?.getSpawnPoints?.(team) ?? [];
    if (!points.length) return this._safeSpawn();
    let best = points[0];
    let bestScore = -Infinity;
    for (const point of points) {
      let score = 0;
      for (const other of avoid) {
        const distance = point.distanceTo ? point.distanceTo(other) : 999;
        score += distance < minDistance ? -100 + distance : Math.min(distance, 60) * 0.1;
      }
      if (score > bestScore) { bestScore = score; best = point; }
    }
    return best.clone ? best.clone() : _copyPoint(best);
  }

  // ------------------------------------------------------------------ match
  /** Enters play mode: spawns the player, the bots and the match logic. */
  play(opts = {}) {
    if (!this.scene) throw new Error('load a map before playing');
    if (this.mode === EngineMode.Play) return this.session;
    this.mode = EngineMode.Play;
    this.renderer.editorMode = false;
    this.editor?.onPlayStart?.();

    this.session = new PlaySession(this, opts);
    this.controller = new PlayerController(this, opts);
    this.session.start();
    this.player = this.session.localPlayer;
    this.hud?.setSession(this.session);
    this.input?.requestPointerLock?.();
    this.ModeChanged.emit(this.mode);
    log.info(`play mode — ${this.session.redTeam.length + this.session.blueTeam.length} bots on ${this.settings.botCount} requested`);
    return this.session;
  }

  /** Leaves play mode and returns to the editor (scene is restored from the edit-time snapshot). */
  stopPlay() {
    if (this.mode !== EngineMode.Play) return this;
    this._destroySession();
    this.mode = EngineMode.Edit;
    this.renderer.editorMode = true;
    this.editor?.onPlayStop?.();
    this.input?.exitPointerLock?.();
    this.ModeChanged.emit(this.mode);
    return this;
  }

  togglePlay() { return this.mode === EngineMode.Play ? this.stopPlay() : this.play(); }

  _destroySession() {
    if (this.session) {
      this.session.destroy();
      this.session = null;
    }
    if (this.player) this.actors.delete(this.player);
    this.player = null;
    this.controller = null;
    this.hud?.setSession(null);
    for (const actor of [...this.actors]) {
      this.ballistics?.unregisterActor?.(actor);
      actor.destroy?.();
      this.actors.delete(actor);
    }
    this.renderer?.lines?.clear?.();
    this.renderer?.tracers?.clear?.();
  }

  _onDamage(info) {
    if (!info) return;
    this.hud?.onDamage?.(info, this.player);
  }

  _onKill(event) {
    this.session?.onKill?.(event);
    this.hud?.onKill?.(event, this.player);
  }

  // ------------------------------------------------------------------ editor integration
  /** Lazily boots the Studio editor layer (hierarchy, inspector, gizmos, gizmo picking). */
  async enableEditor(opts = {}) {
    if (this.editor) return this.editor;
    const { Editor } = await import('../editor/Editor.js');
    this.editor = new Editor(this, opts);
    this.renderer.editorMode = true;
    if (opts.ui !== false) await this.editor.mountUI(opts);
    return this.editor;
  }

  // ------------------------------------------------------------------ loop
  start() {
    if (this.running) return this;
    this.running = true;
    this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tick = (now) => {
      if (!this.running) return;
      const time = now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
      let dt = (time - this.lastTime) / 1000;
      this.lastTime = time;
      if (!Number.isFinite(dt) || dt < 0) dt = 0;
      // Long stalls (tab switch, shader compile) must not teleport the simulation.
      dt = Math.min(dt, 0.25);
      this.frameMs = dt * 1000;
      this.fpsSamples.push(this.frameMs);
      if (this.fpsSamples.length > 90) this.fpsSamples.shift();
      this.FrameStart.emit(dt);
      this.update(dt);
      this.render(dt);
      this.FrameEnd.emit(dt, this.frameMs);
      this.frame++;
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
    return this;
  }

  stop() {
    this.running = false;
    if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
    this._raf = null;
    return this;
  }

  /** One simulation step (no rendering). Fixed-step substepping keeps physics independent of fps. */
  update(dt) {
    if (this.paused) return this;
    this.time += dt;
    this.accumulator = Math.min(this.accumulator + dt, this.fixedStep * this.maxSubSteps);
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      this._step(this.fixedStep);
      this.accumulator -= this.fixedStep;
      steps++;
    }
    // Presentation-only systems run once per frame with the real dt.
    this.hud?.update(dt, this);
    this.input?.endFrame?.();
    return this;
  }

  _step(dt) {
    this.scene?.update(dt);
    this._updateDayCycle(dt);
    if (this.mode === EngineMode.Play) {
      this.controller?.update(dt);
      this.session?.update(dt);
    } else {
      this.editor?.update?.(dt);
    }
    this.ballistics?.update(dt);
    this.net?.update?.(dt);
    this.scripts?.update?.(dt);
  }

  /** Renders one frame. */
  render(dt) {
    if (!this.renderer) return;
    const camera = this.mode === EngineMode.Edit && this.editor?.camera ? this.editor.camera : this.camera;
    this.renderer.render(dt, { camera });
    return this;
  }

  get fps() {
    if (!this.fpsSamples.length) return 0;
    let sum = 0;
    for (const ms of this.fpsSamples) sum += ms;
    return 1000 / Math.max(0.001, sum / this.fpsSamples.length);
  }

  get stats() {
    return {
      fps: Math.round(this.fps),
      frameMs: this.frameMs,
      drawCalls: this.renderer?.device?._resources.drawCalls ?? 0,
      triangles: this.renderer?.device?._resources.triangles ?? 0,
      parts: this.scene?.getParts?.().length ?? 0,
      actors: this.actors.size,
      backend: this.backend,
      scripts: this.scripts?.scripts.size ?? 0,
    };
  }

  // ------------------------------------------------------------------ settings
  applySettings(settings = {}, { silent = false } = {}) {
    Object.assign(this.settings, settings);
    const s = this.settings;
    if (this.renderer) {
      this.renderer.applySettings({
        fov: s.fov,
        renderScale: s.renderScale,
        adaptiveQuality: s.adaptiveQuality,
        shadows: s.shadows,
        shadowCascades: s.shadowCascades,
        viewDistance: s.viewDistance,
        bloom: s.bloom,
        grain: s.grain,
        vignette: s.vignette,
        saturation: s.saturation,
        tonemapping: s.tonemapping,
      });
      if (settings.quality && settings.quality !== this.renderer.qualityName) this.renderer.setQuality(settings.quality);
    }
    this.audio?.applySettings?.(s);
    this.hud?.applySettings?.(s);
    this.controller?.applySettings?.(s);
    if (!silent) {
      this.SettingsChanged.emit(this.settings);
      this.saveSettings();
    }
    return this;
  }

  saveSettings() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.settingsKey, JSON.stringify(this.settings));
    } catch { /* private mode / quota — settings just are not persisted */ }
  }

  _loadSettings() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.settingsKey);
      if (!raw) return;
      const stored = JSON.parse(raw);
      if (stored && typeof stored === 'object') this.applySettings({ ...stored, quality: this.settings.quality }, { silent: true });
    } catch { /* ignore corrupt settings */ }
  }

  // ------------------------------------------------------------------ teardown
  destroy() {
    this.stop();
    this._destroySession();
    this.input?.unbind?.();
    this.audio?.destroy?.();
    this.renderer?.destroy?.();
    this.scene = null;
  }
}

function _copyPoint(point) {
  if (point?.clone) return point.clone();
  if (Array.isArray(point)) return new Vector3(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0);
  if (point && typeof point.x === 'number') return new Vector3(point.x, point.y ?? 0, point.z ?? 0);
  return new Vector3(0, 2, 0);
}

export { MapKind, MapArchetypes, QualityPreset, clamp, clamp01, Player };
export default Engine;
