/**
 * OminX Engine — FPS player controller.
 *
 * Translates raw input (keyboard/mouse/gamepad) into the input object `Player.update` expects, and
 * owns the FPS presentation details that live outside the player model: sensitivity and ADS
 * scaling, fire-mode keys, weapon slots, the view model submission, pause/scoreboard/map toggles
 * and the death/spectate hand-off.
 *
 * The simulation itself lives in `gameplay/Player.js` + `physics/KinematicCharacter.js`; this file
 * is deliberately a thin input/action layer so the same behaviour can be reproduced on a server or
 * by a bot simply by feeding a different input object.
 *
 * @module src/game/PlayerController
 */
import { PlayerState } from '../../engine/src/gameplay/Player.js';
import { createLogger } from '../../engine/src/core/Logger.js';
import { clamp } from '../../engine/src/math/MathUtils.js';

const log = createLogger('PlayerController');

export class PlayerController {
  /**
   * @param {import('../app/Engine.js').Engine} engine
   * @param {object} [opts]
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.player = engine.player ?? null;
    this.settings = { ...engine.settings, ...(opts.settings ?? {}) };
    this.enabled = true;
    this.textCapture = false;
    this.pointerLocked = false;

    /** Action edges consumed once per frame (one-shot actions like grenade/melee/fire-mode). */
    this.actions = {};
    this.holdFire = opts.holdFire ?? false;
    this.lastFireTime = 0;
    this.spectateIndex = 0;
    this.pauseHandler = opts.onPause ?? null;
    this.scoreboardVisible = false;
    this.mapVisible = false;
    this.chatHandler = opts.onChat ?? null;
    this.onAction = opts.onAction ?? null;
    this._firstFrameAfterRespawn = 0;
    this._bind();
  }

  _bind() {
    const input = this.engine.input;
    if (!input) return;
    input.onPointerLockChange = (locked) => { this.pointerLocked = locked; };
    if (typeof document !== 'undefined') {
      this._onLockChange = () => {
        this.pointerLocked = typeof document.pointerLockElement !== 'undefined' && !!document.pointerLockElement;
      };
      document.addEventListener('pointerlockchange', this._onLockChange);
    }
  }

  applySettings(settings) {
    Object.assign(this.settings, settings);
    const input = this.engine.input;
    if (!input) return;
    if (settings.sensitivity !== undefined) input.sensitivity = settings.sensitivity;
    if (settings.adsSensitivityScale !== undefined) input.adsSensitivityScale = settings.adsSensitivityScale;
    if (settings.invertY !== undefined) input.invertY = settings.invertY ? -1 : 1;
    return this;
  }

  /** When true the controller stops sending gameplay input (chat box / menus are open). */
  setTextCapture(on) {
    this.textCapture = !!on;
    this.engine.input?.setTextCapture?.(this.textCapture);
    return this;
  }

  /** One simulation step. */
  update(dt) {
    const engine = this.engine;
    const input = engine.input;
    const player = this.player ?? engine.player;
    this.player = player;
    if (!input || !player) return;

    this._readActionEdges();
    const sendInput = this.enabled && !this.textCapture && engine.mode === 'play';

    // ---- look ----
    const look = sendInput
      ? input.getLookDelta({ adsBlend: player.adsBlend, zoomBlend: player.camera?.adsBlend ?? 0 })
      : { yaw: 0, pitch: 0 };

    const state = input.state;
    const buildInput = {
      moveX: sendInput ? state.move.x : 0,
      moveY: sendInput ? state.move.y : 0,
      jump: sendInput && state.isDown('jump'),
      crouch: sendInput && state.isDown('crouch'),
      prone: sendInput && state.isDown('prone'),
      sprint: sendInput && state.isDown('sprint'),
      walk: sendInput && state.isDown('walk'),
      look,
      fire: sendInput && (state.isDown('fire') || (this.holdFire && this._fireHeld)),
      aim: sendInput && state.isDown('aim'),
      reload: sendInput && state.isDown('reload'),
      grenade: sendInput && this._consume('grenade'),
      grenadeType: this._selectedGrenade ?? null,
      melee: sendInput && this._consume('melee'),
      interact: sendInput && this._consume('interact'),
      cycle: sendInput ? this._weaponCycle : 0,
      fireModes: sendInput && this._consume('switchFireMode'),
      switchTo: null,
    };
    this._weaponCycle = 0;

    // Weapon slots: 1..4 are direct, the wheel/Q cycle.
    if (sendInput) {
      for (let slot = 1; slot <= 4; slot++) {
        if (state.wasPressed(`weapon${slot}`)) buildInput.switchTo = slot;
      }
      if (state.wasPressed('switchWeapon')) this._weaponCycle = 1;
      if (state.wasPressed('drop')) player.dropWeapon?.();
      const grenadeSlot = this._consume('grenadeCycle');
      if (grenadeSlot) this._cycleGrenade();
    }

    player.update(dt, buildInput);

    // ---- presentation ----
    player.submitViewModel(engine.renderer, engine.camera);

    // ---- death / respawn / spectate ----
    if (!player.alive) {
      if (state.wasPressed('jump') || state.wasPressed('fire') || state.wasPressed('spawn')) {
        engine.session?.requestRespawn?.(player);
      }
      if (state.wasPressed('cycleSpectate')) this._cycleSpectate();
    }

    // ---- UI toggles ----
    if (state.wasPressed('scoreboard')) this.scoreboardVisible = true;
    if (state.wasReleased?.('scoreboard')) this.scoreboardVisible = false;
    if (!state.isDown('scoreboard')) this.scoreboardVisible = false;
    if (state.wasPressed('map')) { this.mapVisible = !this.mapVisible; this.onAction?.('map', this.mapVisible); }
    if (state.wasPressed('pause') && this.pauseHandler) this.pauseHandler();
    if (state.wasPressed('inspect') && player.weapon) this.onAction?.('inspect', player.weapon.definition);

    this.actions = {};
  }

  _readActionEdges() {
    const input = this.engine.input;
    const state = input.state;
    const mapping = {
      grenade: 'grenade',
      melee: 'melee',
      interact: 'interact',
      switchFireMode: 'fireMode',
      grenadeCycle: 'grenadeType',
      cycleSpectate: 'spectate',
    };
    for (const [action, key] of Object.entries(mapping)) {
      if (state.wasPressed(action)) this.actions[key] = true;
    }
    this._fireHeld = state.isDown('fire');
  }

  _consume(key) {
    if (!this.actions[key]) return false;
    this.actions[key] = false;
    return true;
  }

  _cycleGrenade() {
    const player = this.player;
    if (!player) return;
    const kinds = Object.keys(player.grenades ?? {});
    if (kinds.length < 2) return;
    const index = kinds.indexOf(this._selectedGrenade ?? kinds[0]);
    this._selectedGrenade = kinds[(index + 1) % kinds.length];
    this.engine.hud?.notice?.(`Grenade: ${this._selectedGrenade}`);
  }

  _cycleSpectate() {
    const session = this.engine.session;
    const player = this.player;
    if (!session || !player) return;
    const candidates = session.aliveActors(player.team);
    if (!candidates.length) return;
    this.spectateIndex = (this.spectateIndex + 1) % candidates.length;
    player.spectate?.(candidates[this.spectateIndex]);
  }

  /** Called after a respawn: clears accumulated input so the player does not spawn firing. */
  onRespawn() {
    this.engine.input?.releaseAll?.();
    this._firstFrameAfterRespawn = 2;
    this.actions = {};
  }

  destroy() {
    if (this._onLockChange && typeof document !== 'undefined') {
      document.removeEventListener('pointerlockchange', this._onLockChange);
    }
  }
}

export { PlayerState, clamp };
export default PlayerController;
