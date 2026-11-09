/**
 * OminX Engine — input manager.
 *
 * Frame-based action/axis input with pointer lock, rebinding, per-device sensitivity, gamepad
 * support and FPS-specific niceties: separate hipfire/ADS sensitivity, press-vs-release edge
 * detection, key chords, hold-to-ADS vs toggle-ADS, mouse smoothing (off by default — raw input
 * is what makes aiming feel precise), and deterministic playback for replays and tests.
 *
 * The manager never touches `window` at import time, so it can be constructed headlessly
 * (tests, dedicated server, replay playback) and fed synthetic events.
 *
 * @module engine/src/input/InputManager.js
 */

/** Named mouse buttons. */
export const MouseButton = { Left: 0, Middle: 1, Right: 2, Back: 3, Forward: 4 };

/**
 * Default bindings. Values are key codes (`event.code`) or `Mouse<n>` names.
 * Every action is rebindable at runtime through `rebind()`.
 */
export const DefaultBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  walk: ['AltLeft'],
  fire: ['Mouse0'],
  aim: ['Mouse2'],
  reload: ['KeyR'],
  melee: ['KeyV'],
  grenade: ['KeyG'],
  interact: ['KeyF'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  weapon4: ['Digit4'],
  switchWeapon: ['KeyQ'],
  drop: ['KeyX'],
  scoreboard: ['Tab'],
  map: ['KeyM'],
  pause: ['Escape'],
  flashlight: ['KeyL'],
  lean_left: ['KeyQ'],
  lean_right: ['KeyE'],
  spawn: ['Enter'],
  chat: ['KeyY'],
  teamChat: ['KeyU'],
  voicePushToTalk: ['KeyT'],
  inspect: ['KeyI'],
  reloadCancel: ['KeyR'],
};

export class InputState {
  constructor() {
    /** Currently held actions. */
    this.actions = new Set();
    /** Actions pressed this frame. */
    this.pressed = new Set();
    /** Actions released this frame. */
    this.released = new Set();
    /** Axes: -1..1 */
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    /** Accumulated mouse delta since the last `endFrame()`, before sensitivity scaling. */
    this.mouseDelta = { x: 0, y: 0 };
    this.scroll = 0;
    this.pointerLocked = false;
    this.gamepadConnected = false;
    /** Text typed this frame (chat, console). */
    this.text = '';
  }

  isDown(action) { return this.actions.has(action); }
  wasPressed(action) { return this.pressed.has(action); }
  wasReleased(action) { return this.released.has(action); }
  /** Analog value 0..1 for actions that support pressure (gamepad triggers, mouse buttons). */
  pressure(action) { return this.actions.has(action) ? (this._pressure?.get(action) ?? 1) : 0; }

  clear() {
    this.pressed.clear();
    this.released.clear();
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    this.scroll = 0;
    this.text = '';
  }
}

export class InputManager {
  /**
   * @param {object} [opts]
   * @param {HTMLElement} [opts.element] element that captures pointer lock (the game canvas)
   * @param {object} [opts.bindings] overrides for `DefaultBindings`
   * @param {number} [opts.sensitivity=0.0022] mouse sensitivity (radians per pixel)
   * @param {number} [opts.adsSensitivityScale=0.65] multiplier while aiming down sights
   * @param {number} [opts.invertY=1] -1 flips vertical look
   * @param {boolean} [opts.toggleAim=false]
   * @param {boolean} [opts.toggleCrouch=false]
   * @param {boolean} [opts.smoothMouse=false]
   */
  constructor(opts = {}) {
    this.element = opts.element ?? null;
    this.bindings = { ...DefaultBindings, ...(opts.bindings ?? {}) };
    this.actionByCode = new Map();
    for (const [action, codes] of Object.entries(this.bindings)) {
      for (const code of codes) {
        if (!this.actionByCode.has(code)) this.actionByCode.set(code, []);
        this.actionByCode.get(code).push(action);
      }
    }
    this.sensitivity = opts.sensitivity ?? 0.0022;
    this.adsSensitivityScale = opts.adsSensitivityScale ?? 0.65;
    this.scopeSensitivityScale = opts.scopeSensitivityScale ?? 0.35;
    this.invertY = opts.invertY ?? 1;
    this.toggleAim = opts.toggleAim ?? false;
    this.toggleCrouch = opts.toggleCrouch ?? false;
    this.toggleSprint = opts.toggleSprint ?? false;
    this.smoothMouse = opts.smoothMouse ?? false;
    this.mouseSmoothing = opts.mouseSmoothing ?? 0.35;
    this.rawInput = opts.rawInput !== false;
    this.gamepadIndex = opts.gamepadIndex ?? null;
    this.deadzone = opts.deadzone ?? 0.16;
    this.aimBlend = 0;                 // set by the player each frame (ADS/scope blend)
    this.zoomBlend = 0;                // scope zoom blend, lowers sensitivity further

    this.state = new InputState();
    this.state._pressure = new Map();

    this._gamepadAxes = [];
    this._gamepadButtons = [];
    this._textBuffer = '';
    this._textCapture = false;
    this._smoothing = { x: 0, y: 0 };
    this._listeners = [];
    this._pending = [];
    this._recordingAction = null;
    this.rebindResult = null;
    this.connected = false;
    this.enabled = true;

    if (opts.autoBind !== false && typeof window !== 'undefined' && this.element) this.bind(this.element);
  }

  static create(opts) { return new InputManager(opts); }

  // ------------------------------------------------------------------ binding
  /** Attaches DOM listeners. Idempotent. */
  bind(element = this.element) {
    if (this.connected || typeof window === 'undefined') return this;
    this.element = element ?? this.element;
    const target = this.element ?? window;
    this.connected = true;
    const add = (node, type, handler, options) => {
      node.addEventListener(type, handler, options);
      this._listeners.push([node, type, handler, options]);
    };
    add(window, 'keydown', (e) => this.handleKeyDown(e));
    add(window, 'keyup', (e) => this.handleKeyUp(e));
    add(window, 'blur', () => this.releaseAll());
    add(target, 'mousedown', (e) => this.handleMouseDown(e));
    add(target, 'mouseup', (e) => this.handleMouseUp(e));
    add(target, 'mousemove', (e) => this.handleMouseMove(e));
    add(target, 'wheel', (e) => this.handleWheel(e), { passive: true });
    add(target, 'contextmenu', (e) => e.preventDefault());
    add(document, 'pointerlockchange', () => { this.state.pointerLocked = document.pointerLockElement === this.element; });
    add(window, 'gamepadconnected', (e) => { this.state.gamepadConnected = true; this.gamepadIndex = e.gamepad.index; });
    add(window, 'gamepaddisconnected', () => { this.state.gamepadConnected = false; });
    return this;
  }

  /** Removes all DOM listeners. */
  unbind() {
    for (const [node, type, handler, options] of this._listeners) node.removeEventListener(type, handler, options);
    this._listeners.length = 0;
    this.connected = false;
    return this;
  }

  requestPointerLock() {
    if (typeof document === 'undefined') return false;
    if (document.pointerLockElement === this.element) return true;
    this.element?.requestPointerLock?.({ unadjustedMovement: this.rawInput });
    return true;
  }

  exitPointerLock() { if (typeof document !== 'undefined') document.exitPointerLock?.(); }

  // ------------------------------------------------------------------ rebinding
  /** Starts recording the next input for `action`. */
  beginRebind(action) { this._recordingAction = action; this.rebindResult = null; return this; }

  /** Programmatically sets the keys for an action (used by the settings menu and configs). */
  rebind(action, codes) {
    const list = Array.isArray(codes) ? codes : [codes];
    for (const code of list) {
      for (const [existing, mapped] of this.actionByCode) {
        if (mapped.includes(action)) mapped.splice(mapped.indexOf(action), 1);
        if (mapped.length === 0) this.actionByCode.delete(existing);
      }
    }
    this.bindings[action] = list;
    for (const code of list) {
      if (!this.actionByCode.has(code)) this.actionByCode.set(code, []);
      const mapped = this.actionByCode.get(code);
      if (!mapped.includes(action)) mapped.push(action);
    }
    return this;
  }

  getBindings() { return JSON.parse(JSON.stringify(this.bindings)); }

  _finishRebind(code) {
    const action = this._recordingAction;
    this._recordingAction = null;
    if (!action) return false;
    this.rebind(action, code);
    this.rebindResult = { action, code };
    return true;
  }

  // ------------------------------------------------------------------ event handlers
  handleKeyDown(e) {
    if (this._recordingAction) { this._finishRebind(e.code); e.preventDefault?.(); return; }
    if (this._textCapture) {
      if (e.key === 'Backspace') this._textBuffer = this._textBuffer.slice(0, -1);
      else if (e.key === 'Enter') { this.state.text = this._textBuffer; this._textBuffer = ''; }
      else if (e.key.length === 1) this._textBuffer += e.key;
      return;
    }
    if (e.repeat) return;
    this.pressCode(e.code, 1);
    if (this.actionByCode.has(e.code) && e.code.startsWith('Tab')) e.preventDefault?.();
  }

  handleKeyUp(e) { this.releaseCode(e.code); }

  handleMouseDown(e) {
    if (this._recordingAction) { this._finishRebind(`Mouse${e.button}`); return; }
    if (this.state.pointerLocked === false && this.element) this.requestPointerLock();
    this.pressCode(`Mouse${e.button}`, 1);
  }

  handleMouseUp(e) { this.releaseCode(`Mouse${e.button}`); }

  handleMouseMove(e) {
    if (!this.enabled) return;
    if (!this.state.pointerLocked && e.buttons === 0) return;
    this.state.mouseDelta.x += e.movementX ?? 0;
    this.state.mouseDelta.y += e.movementY ?? 0;
  }

  handleWheel(e) { this.state.scroll += Math.sign(e.deltaY ?? 0); }

  /** Raw entry point for synthetic events (tests, replays, touch adapters, remote input). */
  pressCode(code, pressure = 1) {
    const actions = this.actionByCode.get(code);
    if (!actions) return this;
    for (const action of actions) {
      if (this.state.actions.has(action)) continue;
      this.state.actions.add(action);
      this.state.pressed.add(action);
      this.state._pressure.set(action, pressure);
    }
    return this;
  }

  releaseCode(code) {
    const actions = this.actionByCode.get(code);
    if (!actions) return this;
    for (const action of actions) {
      if (!this.state.actions.delete(action)) continue;
      this.state.released.add(action);
      this.state._pressure.delete(action);
    }
    return this;
  }

  releaseAll() {
    for (const action of [...this.state.actions]) {
      this.state.actions.delete(action);
      this.state.released.add(action);
    }
    this.state._pressure.clear();
    return this;
  }

  pressAction(action, pressure = 1) {
    if (this.state.actions.has(action)) return this;
    this.state.actions.add(action);
    this.state.pressed.add(action);
    this.state._pressure.set(action, pressure);
    return this;
  }

  releaseAction(action) {
    if (!this.state.actions.delete(action)) return this;
    this.state.released.add(action);
    this.state._pressure.delete(action);
    return this;
  }

  setTextCapture(on) { this._textCapture = !!on; if (!on) this._textBuffer = ''; return this; }
  getTextBuffer() { return this._textBuffer; }

  // ------------------------------------------------------------------ frame update
  /**
   * Call once per frame *before* gameplay reads input.
   * @param {number} [dt]
   */
  update(dt = 1 / 60) {
    if (!this.enabled) { this.state.clear(); return this.state; }
    this._pollGamepads();
    const state = this.state;
    const left = (state.isDown('right') ? 1 : 0) - (state.isDown('left') ? 1 : 0);
    const forward = (state.isDown('forward') ? 1 : 0) - (state.isDown('back') ? 1 : 0);
    const pad = this._gamepadMove;
    state.move.x = clampUnit(left + (pad ? pad.x : 0));
    state.move.y = clampUnit(forward + (pad ? pad.y : 0));
    if (this._gamepadLook) {
      state.mouseDelta.x += this._gamepadLook.x * 900 * dt;
      state.mouseDelta.y += this._gamepadLook.y * 900 * dt;
    }
    return state;
  }

  /**
   * Look delta in radians for this frame, already scaled by sensitivity (hipfire vs ADS).
   * @param {{adsBlend?: number, zoomBlend?: number, scale?: number}} [opts]
   */
  getLookDelta({ adsBlend = this.aimBlend, zoomBlend = this.zoomBlend, scale = 1 } = {}) {
    let dx = this.state.mouseDelta.x;
    let dy = this.state.mouseDelta.y;
    if (this.smoothMouse) {
      this._smoothing.x += (dx - this._smoothing.x) * (1 - this.mouseSmoothing);
      this._smoothing.y += (dy - this._smoothing.y) * (1 - this.mouseSmoothing);
      dx = this._smoothing.x;
      dy = this._smoothing.y;
    }
    const sensitivity = this.sensitivity
      * lerp(1, this.adsSensitivityScale, adsBlend)
      * lerp(1, this.scopeSensitivityScale, zoomBlend)
      * scale;
    return { yaw: -dx * sensitivity, pitch: -dy * sensitivity * this.invertY };
  }

  /** Call once per frame *after* gameplay reads input. */
  endFrame() { this.state.clear(); return this; }

  _pollGamepads() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    if (!pads) return;
    let pad = this.gamepadIndex !== null ? pads[this.gamepadIndex] : null;
    if (!pad) {
      for (const candidate of pads) { if (candidate?.connected) { pad = candidate; this.gamepadIndex = candidate.index; break; } }
    }
    if (!pad) { this._gamepadMove = null; this._gamepadLook = null; return; }
    this.state.gamepadConnected = true;
    this._gamepadMove = { x: deadzone(pad.axes[0] ?? 0, this.deadzone), y: deadzone(-(pad.axes[1] ?? 0), this.deadzone) };
    this._gamepadLook = { x: deadzone(pad.axes[2] ?? 0, this.deadzone), y: deadzone(pad.axes[3] ?? 0, this.deadzone) };
    // Standard mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 9 Start, 10 LS, 11 RS.
    const map = {
      0: 'jump', 1: 'crouch', 2: 'reload', 3: 'melee', 4: 'grenade', 5: 'flashlight',
      9: 'pause', 10: 'sprint', 11: 'aim',
    };
    for (const [index, action] of Object.entries(map)) {
      const button = pad.buttons[index];
      if (!button) continue;
      if (button.pressed) this.pressAction(action, button.value || 1);
      else this.releaseAction(action);
    }
    const rt = pad.buttons[7];
    const lt = pad.buttons[6];
    if (rt?.pressed) this.pressAction('fire', rt.value || 1); else this.releaseAction('fire');
    if (lt?.pressed) this.pressAction('aim', lt.value || 1); else this.releaseAction('aim');
  }

  /** Snapshot for netcode: what the client sends to the server (compact). */
  serialize() {
    const actions = [...this.state.actions];
    return {
      a: actions,
      m: [round2(this.state.move.x), round2(this.state.move.y)],
      l: [round2(this.state.mouseDelta.x), round2(this.state.mouseDelta.y)],
    };
  }

  static deserialize(data) {
    const manager = new InputManager({ autoBind: false });
    for (const action of data.a ?? []) manager.pressAction(action);
    manager.state.move.x = data.m?.[0] ?? 0;
    manager.state.move.y = data.m?.[1] ?? 0;
    manager.state.mouseDelta.x = data.l?.[0] ?? 0;
    manager.state.mouseDelta.y = data.l?.[1] ?? 0;
    return manager;
  }
}

function clampUnit(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
function deadzone(v, dz) { const a = Math.abs(v); if (a < dz) return 0; return Math.sign(v) * ((a - dz) / (1 - dz)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function round2(v) { return Math.round(v * 100) / 100; }

export default InputManager;
