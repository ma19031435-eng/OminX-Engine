/**
 * OminX Engine — audio engine.
 *
 * A WebAudio mixer with the bus layout a shooter needs: `master → {sfx, ui, ambient, voice, music}`
 * plus per-category ducking, distance attenuation, air absorption (low-pass with range), a
 * convolution reverb built from a synthesised impulse and HRTF-ish stereo panning. Sounds come from
 * `SoundKit` (fully procedural) so the engine ships with zero audio assets.
 *
 * Public API used by gameplay: `play(name, position, opts)`, `playWeaponFire(weapon, muzzle, local)`,
 * `playImpact(impact, point)`, `playFootstep(step)`, `playHitmarker(kind)`, `playNearMiss(event)`,
 * `playPickup(kind)`, `playObjective(kind)` and `setListener(camera)`.
 *
 * The browser only allows an AudioContext to start after a user gesture, so the engine is created
 * suspended and `resume()` is wired to the first click/keydown.
 *
 * @module src/audio/AudioEngine
 */
import { SOUND_RECIPES, renderBuffer } from './SoundKit.js';
import { createLogger } from '../../engine/src/core/Logger.js';
import { clamp01, clamp } from '../../engine/src/math/MathUtils.js';

const log = createLogger('AudioEngine');

export const AudioBus = { Sfx: 'sfx', Ui: 'ui', Ambient: 'ambient', Voice: 'voice', Music: 'music' };

export class AudioEngine {
  /**
   * @param {object} [opts] `{ settings }`
   */
  constructor(opts = {}) {
    this.settings = { ...(opts.settings ?? {}) };
    this.available = typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
    this.enabled = this.available;
    this.buffers = new Map();
    this.active = new Set();
    this.listener = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };
    this.time = 0;
    this.stats = { played: 0, dropped: 0, voices: 0 };
    this.maxVoices = opts.maxVoices ?? 48;
    this.lastPlayed = new Map();
    if (!this.available) {
      log.warn('WebAudio unavailable — the engine will run silently');
      return;
    }
    this._initGraph();
    this._bindAutoplayUnlock();
  }

  _initGraph() {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.masterVolume ?? 0.8;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.22;
    this.master.connect(this.compressor).connect(ctx.destination);

    this.buses = {};
    const busGains = {
      [AudioBus.Sfx]: this.settings.sfxVolume ?? 0.9,
      [AudioBus.Ui]: (this.settings.sfxVolume ?? 0.9) * 0.8,
      [AudioBus.Ambient]: 0.55,
      [AudioBus.Voice]: this.settings.voiceVolume ?? 0.7,
      [AudioBus.Music]: this.settings.musicVolume ?? 0.35,
    };
    for (const [name, gain] of Object.entries(busGains)) {
      const node = ctx.createGain();
      node.gain.value = gain;
      node.connect(this.master);
      this.buses[name] = node;
    }

    // Reverb: a synthesised impulse response (decaying noise with a bright early-reflection burst).
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(1.9, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.22;
    this.reverbSend.connect(this.reverb).connect(this.buses[AudioBus.Sfx]);

    // Slight stereo widening for the Sfx bus keeps gunfire from sounding mono.
    this._unlockListeners = [
      ['pointerdown', () => this.resume()],
      ['keydown', () => this.resume()],
      ['touchstart', () => this.resume()],
    ];
  }

  _makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const length = Math.floor(seconds * rate);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const early = i < rate * 0.012 ? (1 - i / (rate * 0.012)) * 0.8 : 0;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (0.6 + early);
      }
    }
    return buffer;
  }

  _bindAutoplayUnlock() {
    if (typeof document === 'undefined') return;
    for (const [type, handler] of this._unlockListeners) document.addEventListener(type, handler, { passive: true });
  }

  /** Resumes a suspended context (must be called from a user gesture at least once). */
  resume() {
    if (!this.available) return this;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this;
  }

  // ------------------------------------------------------------------ mixing
  applySettings(settings) {
    Object.assign(this.settings, settings);
    if (!this.available) return this;
    this.master.gain.value = this.settings.masterVolume ?? 0.8;
    if (settings.sfxVolume !== undefined) {
      this.buses[AudioBus.Sfx].gain.value = settings.sfxVolume;
      this.buses[AudioBus.Ui].gain.value = settings.sfxVolume * 0.8;
    }
    if (settings.musicVolume !== undefined) this.buses[AudioBus.Music].gain.value = settings.musicVolume;
    if (settings.voiceVolume !== undefined) this.buses[AudioBus.Voice].gain.value = settings.voiceVolume;
    return this;
  }

  /** Muffles the world (flashbang, underwater, damage) for a short time. */
  setLowPass(frequency = 20000, duration = 0, { bus = AudioBus.Sfx } = {}) {
    if (!this.available) return this;
    const node = this.buses[bus];
    const filter = this._filter ??= (() => {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 20000;
      f.connect(this.master);
      return f;
    })();
    if (node.outputFilter !== filter) {
      node.disconnect();
      node.connect(filter);
      node.outputFilter = filter;
    }
    filter.frequency.cancelScheduledValues(this.ctx.currentTime);
    filter.frequency.setValueAtTime(frequency, this.ctx.currentTime);
    if (duration > 0) {
      filter.frequency.linearRampToValueAtTime(20000, this.ctx.currentTime + duration);
    }
    return this;
  }

  // ------------------------------------------------------------------ buffers
  /** Renders (and caches) a sound buffer. */
  buffer(name) {
    if (!this.available) return null;
    const cached = this.buffers.get(name);
    if (cached) return cached;
    const recipe = SOUND_RECIPES[name];
    if (!recipe) {
      if (!this._missing?.has(name)) {
        (this._missing ??= new Set()).add(name);
        log.warn(`unknown sound "${name}"`);
      }
      return null;
    }
    const buffer = recipe.render(this.ctx);
    this.buffers.set(name, buffer);
    return buffer;
  }

  /** Pre-renders a list of sounds (the loading screen warms the weapons of the current map). */
  preload(names = []) {
    let count = 0;
    for (const name of names) if (this.buffer(name)) count++;
    return count;
  }

  // ------------------------------------------------------------------ playback
  /**
   * Plays a sound.
   * @param {string} name sound id from `SoundKit`
   * @param {{x:number,y:number,z:number}|null} [position] world position (omit for 2D/UI sounds)
   * @param {object} [opts] `{ volume, pitch, bus, category, maxDistance, loop, refDistance, attach }`
   */
  play(name, position = null, opts = {}) {
    if (!this.available || !this.enabled) return null;
    const recipe = SOUND_RECIPES[name];
    const buffer = this.buffer(name);
    if (!buffer) return null;

    // Voice budget: dropping the quietest far-away shot beats hitching the frame.
    if (this.active.size >= this.maxVoices) {
      this.stats.dropped++;
      if (this.active.size >= this.maxVoices * 1.5) return null;
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const bus = this.buses[opts.bus ?? recipe.category ?? AudioBus.Sfx] ?? this.buses[AudioBus.Sfx];
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = !!opts.loop || !!recipe.loop;
    const pitchRange = recipe.pitch ?? [1, 1];
    const pitch = opts.pitch ?? (pitchRange[0] + Math.random() * (pitchRange[1] - pitchRange[0]));
    source.playbackRate.value = pitch;
    source.detune.value = (Math.random() - 0.5) * 40;

    let gain = ctx.createGain();
    gain.gain.value = clamp01((opts.volume ?? 1) * (recipe.gain ?? 1));

    let node = source.connect(gain);
    if (position) {
      const panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = opts.refDistance ?? 4;
      panner.maxDistance = opts.maxDistance ?? 140;
      panner.rolloffFactor = opts.rolloff ?? 1.1;
      panner.positionX.value = position.x ?? 0;
      panner.positionY.value = position.y ?? 0;
      panner.positionZ.value = position.z ?? 0;
      node = node.connect(panner);
      panner.connect(gain);
      // Air absorption: distant shots lose their high end before they lose their level.
      const distance = this._distanceToListener(position);
      if (distance > 12) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = clamp(16000 - distance * 90, 700, 16000);
        gain.disconnect();
        gain.connect(filter);
        filter.connect(bus);
        if (!opts.dry) this._sendReverb(gain, clamp01(1 - distance / 140));
        source.start(now);
        return this._track(source, gain);
      }
      gain.connect(bus);
      if (!opts.dry) this._sendReverb(gain, clamp01(1 - distance / 140));
    } else {
      gain.connect(bus);
    }
    source.start(now);
    return this._track(source, gain);
  }

  _sendReverb(node, amount) {
    if (!this.reverbSend || amount <= 0) return;
    const send = this.ctx.createGain();
    send.gain.value = amount * 0.5;
    node.connect(send);
    send.connect(this.reverbSend);
  }

  _track(source, gain) {
    const handle = { source, gain, startedAt: this.ctx.currentTime };
    this.active.add(handle);
    this.stats.played++;
    this.stats.voices = this.active.size;
    source.onended = () => {
      this.active.delete(handle);
      this.stats.voices = this.active.size;
      try { source.disconnect(); gain.disconnect(); } catch { /* already torn down */ }
    };
    return handle;
  }

  /** Stops everything (pause menu, round transition). */
  stopAll() {
    for (const handle of [...this.active]) {
      try { handle.source.stop(); } catch { /* already stopped */ }
      this.active.delete(handle);
    }
    this.stats.voices = 0;
    return this;
  }

  // ------------------------------------------------------------------ listener
  /** Updates the listener from the active camera (position + orientation). */
  setListener(camera) {
    if (!this.available || !camera) return this;
    const listener = this.ctx.listener;
    const position = camera.worldPosition ?? camera.position;
    const forward = camera.forward;
    const up = camera.up;
    if (listener.positionX) {
      listener.positionX.value = position.x;
      listener.positionY.value = position.y;
      listener.positionZ.value = position.z;
      listener.forwardX.value = forward.x;
      listener.forwardY.value = forward.y;
      listener.forwardZ.value = forward.z;
      listener.upX.value = up.x;
      listener.upY.value = up.y;
      listener.upZ.value = up.z;
    } else {
      listener.setPosition?.(position.x, position.y, position.z);
      listener.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
    this.listener.position = position;
    this.listener.forward = forward;
    return this;
  }

  _distanceToListener(position) {
    const p = this.listener.position;
    return Math.hypot((position.x ?? 0) - p.x, (position.y ?? 0) - p.y, (position.z ?? 0) - p.z);
  }

  // ------------------------------------------------------------------ gameplay helpers
  /**
   * Weapon fire: layers the weapon's own report with the tail, and ducks far-away shots so a 10v10
   * firefight does not turn into noise.
   */
  playWeaponFire(weapon, muzzle, isLocal = false) {
    const def = weapon?.definition ?? weapon;
    if (!def?.audio?.fire) return null;
    const distance = muzzle ? this._distanceToListener(muzzle) : 0;
    if (distance > 160) return null;
    const handle = this.play(def.audio.fire, muzzle, {
      volume: isLocal ? 1 : clamp01(1 - distance / 150) * 0.85,
      bus: AudioBus.Sfx,
      maxDistance: 200,
      refDistance: isLocal ? 1.5 : 8,
    });
    if (isLocal) {
      // The dry mechanical layer that makes first-person gunfire feel connected to the gun.
      this.play('shell_drop', muzzle, { volume: 0.35, bus: AudioBus.Sfx, dry: true });
    } else if (distance > 30) {
      this.play('suppressed_crack', muzzle, { volume: 0.25 });
    }
    return handle;
  }

  /**
   * Bullet impact on a surface.
   * @param {{sound?: string}} impact entry of `ImpactTable`
   * @param {{x:number,y:number,z:number}} point
   */
  playImpact(impact, point, { source = null, volume = 1 } = {}) {
    if (!impact) return null;
    const distance = point ? this._distanceToListener(point) : 0;
    if (distance > 90) return null;
    return this.play(impact.sound ?? 'impact_concrete', point, {
      volume: volume * clamp01(1 - distance / 90) * 0.9,
      bus: AudioBus.Sfx,
    });
    void source;
  }

  /** Footsteps: surface-tuned, with sprint/pitch variation so a run does not sound like a metronome. */
  playFootstep(step) {
    if (!step) return null;
    const name = `footstep_${step.surface ?? 'concrete'}`;
    const handle = this.play(name, step.position, {
      volume: clamp01((step.loudness ?? 0.6) * (step.sprinting ? 1.15 : 1)),
      pitch: step.sprinting ? 1.08 : 0.98,
      bus: AudioBus.Sfx,
    });
    if (step.stance === 'crouch') return this.play(name, step.position, { volume: 0.22, pitch: 1.02 });
    return handle;
  }

  /** Local hit feedback. */
  playHitmarker(kind = 'hit') {
    const name = kind === 'kill' ? 'hitmarker_kill' : kind === 'headshot' ? 'hitmarker_headshot' : 'hitmarker';
    return this.play(name, null, { volume: 0.55, bus: AudioBus.Ui });
  }

  /** Bullets cracking past the player: `BallisticsSystem.Suppressed`. */
  playNearMiss(event) {
    const point = event?.point ?? event?.position ?? null;
    if (!point) return null;
    const distance = this._distanceToListener(point);
    if (distance > 22) return null;
    return this.play('near_miss', point, { volume: clamp01(1 - distance / 22), bus: AudioBus.Sfx });
  }

  playPickup(kind = 'healthPickup') {
    const name = kind === 'armorPickup' ? 'pickup_armor' : kind === 'ammoPickup' ? 'pickup_ammo' : 'pickup_health';
    return this.play(name, null, { bus: AudioBus.Ui });
  }

  playPickupSpawn(position) {
    return this.play('ui_hover', position ?? null, { volume: 0.25, bus: AudioBus.Ui });
  }

  playObjective(kind = 'captured') {
    return this.play(kind === 'captured' ? 'capture_complete' : 'capture_lost', null, { bus: AudioBus.Ui });
  }

  playUi(kind = 'click') {
    return this.play(kind === 'hover' ? 'ui_hover' : 'ui_click', null, { bus: AudioBus.Ui });
  }

  playExplosion(position, { radius = 6 } = {}) {
    return this.play(radius > 8 ? 'explosion_large' : 'explosion', position, {
      volume: clamp01(radius / 7),
      maxDistance: 220,
    });
  }

  /** Ambient bed: wind/fire loops gated by the map. */
  setAmbience(kind = 'wind', position = null) {
    this.stopAmbience();
    const name = `ambience_${kind}`;
    this._ambience = this.play(name, position, { loop: true, bus: AudioBus.Ambient, volume: 0.4 });
    return this._ambience;
  }

  stopAmbience() {
    if (!this._ambience) return this;
    try { this._ambience.source.stop(); } catch { /* already stopped */ }
    this._ambience = null;
    return this;
  }

  /** Applies high-frequency loss + slight pitch drop when the player is underwater or flashed. */
  setUnderwater(underwater, { flashIntensity = 0 } = {}) {
    if (flashIntensity > 0.5) this.setLowPass(900, 1.2);
    else if (underwater) this.setLowPass(520, 0.3);
    else this.setLowPass(20000, 0.4);
    return this;
  }

  update(dt) {
    this.time += dt;
    return this;
  }

  destroy() {
    this.stopAll();
    if (typeof document !== 'undefined') {
      for (const [type, handler] of this._unlockListeners ?? []) document.removeEventListener(type, handler);
    }
    this.ctx?.close?.();
    this.buffers.clear();
  }
}

export { SOUND_RECIPES, renderBuffer };
export default AudioEngine;
