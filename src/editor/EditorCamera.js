/**
 * OminX Engine — editor camera.
 *
 * The Studio's viewport navigation, in the two modes every 3D editor has:
 *
 *  · **Fly** — hold the right mouse button to look, `WASD`/`QE` to move, `Shift` to sprint,
 *    `Alt`+`Ctrl` to creep. Speed is a real number in m/s, changed with the wheel.
 *  · **Orbit** — framed on a target (double-click or `F`); drag with the middle button to pan,
 *    `Alt`+drag (or the wheel) to dolly, and the camera always looks at the pivot.
 *
 * It drives the engine's shared `Camera`, so picking, rays, fog and post-processing all behave
 * exactly like they do in play mode.
 *
 * @module src/editor/EditorCamera
 */
import { Vector3 } from '../../engine/src/math/Vector3.js';
import { Quaternion } from '../../engine/src/math/Quaternion.js';
import { clamp, DEG2RAD, RAD2DEG, clamp01 } from '../../engine/src/math/MathUtils.js';

export const EditorCameraMode = { Fly: 'fly', Orbit: 'orbit' };

export class EditorCamera {
  /**
   * @param {import('../app/Engine.js').Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.camera = engine.camera;
    this.mode = EditorCameraMode.Fly;
    this.yaw = Math.PI * 0.25;
    this.pitch = -0.35;
    this.position = new Vector3(18, 14, 22);
    this.speed = 12;
    this.boost = 3.4;
    this.lookSensitivity = 0.0028;
    this.target = new Vector3();
    this.distance = 26;
    this.velocity = new Vector3();
    this.smoothing = 14;
    this.dragging = false;
    this.lookDragging = false;
    this.panDragging = false;
    this.enabled = true;
    this._dirty = true;
    this._keys = new Set();
    this._handlers = [];
    this._pointer = { x: 0, y: 0 };
    this._homePosition = this.position.clone();
    this._homeYaw = this.yaw;
    this._homePitch = this.pitch;
  }

  /** Wires pointer/keyboard navigation onto the viewport element. */
  attach(element) {
    if (!element || this._element === element) return this;
    this.detach();
    this._element = element;
    const on = (target, type, handler, opts) => {
      target.addEventListener(type, handler, opts);
      this._handlers.push([target, type, handler]);
    };
    on(element, 'pointerdown', (event) => this.onPointerDown(event), true);
    on(window, 'pointermove', (event) => this.onPointerMove(event));
    on(window, 'pointerup', (event) => this.onPointerUp(event));
    on(element, 'wheel', (event) => this.onWheel(event), { passive: false });
    on(element, 'contextmenu', (event) => event.preventDefault());
    on(window, 'keydown', (event) => this.onKey(event, true));
    on(window, 'keyup', (event) => this.onKey(event, false));
    on(window, 'blur', () => this._keys.clear());
    this.apply();
    return this;
  }

  detach() {
    for (const [target, type, handler] of this._handlers) target.removeEventListener(type, handler);
    this._handlers.length = 0;
    this._element = null;
    return this;
  }

  /** Pushes the current fly/orbit state into the engine camera. */
  apply() {
    const camera = this.camera;
    if (!camera) return this;
    if (this.mode === EditorCameraMode.Orbit) {
      const horizontal = Math.cos(this.pitch) * this.distance;
      this.position.set(
        this.target.x + Math.sin(this.yaw) * horizontal,
        this.target.y - Math.sin(this.pitch) * this.distance,
        this.target.z + Math.cos(this.yaw) * horizontal,
      );
      camera.setPosition(this.position.x, this.position.y, this.position.z);
      camera.lookAt(this.target);
    } else {
      camera.setPosition(this.position.x, this.position.y, this.position.z);
      camera.setRotation(Quaternion.fromEuler(this.pitch, this.yaw, 0, 'YXZ'));
    }
    camera.fov = 72;
    camera.update(0);
    this._dirty = false;
    return this;
  }

  // ------------------------------------------------------------------ input
  onKey(event, down) {
    if (!this.enabled) return;
    // Never swallow keys while a text field or the console has focus.
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
    const code = event.code;
    if (FLY_KEYS.has(code)) {
      if (down) this._keys.add(code);
      else this._keys.delete(code);
    }
  }

  onPointerDown(event) {
    if (!this.enabled) return;
    this._pointer.x = event.clientX;
    this._pointer.y = event.clientY;
    if (event.button === 2 || (this.mode === EditorCameraMode.Orbit && event.button === 0 && event.altKey)) {
      this.lookDragging = true;
      this.dragging = true;
      this._element?.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    } else if (event.button === 1) {
      this.panDragging = true;
      this.dragging = true;
      event.preventDefault();
    }
  }

  onPointerMove(event) {
    if (!this.dragging || !this.enabled) return;
    const dx = event.clientX - this._pointer.x;
    const dy = event.clientY - this._pointer.y;
    this._pointer.x = event.clientX;
    this._pointer.y = event.clientY;
    if (this.panDragging) {
      this.pan(dx, dy);
      return;
    }
    if (this.mode === EditorCameraMode.Orbit) {
      this.orbit(dx * this.lookSensitivity, -dy * this.lookSensitivity);
    } else {
      this.look(dx * this.lookSensitivity, -dy * this.lookSensitivity);
    }
  }

  onPointerUp(event) {
    if (!this.dragging) return;
    this.dragging = false;
    this.lookDragging = false;
    this.panDragging = false;
    try { this._element?.releasePointerCapture?.(event.pointerId); } catch { /* capture already released */ }
  }

  onWheel(event) {
    if (!this.enabled) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0012);
    if (this.mode === EditorCameraMode.Orbit) {
      this.distance = clamp(this.distance * factor, 0.6, 400);
    } else {
      this.speed = clamp(this.speed * factor, 0.5, 220);
    }
    this.apply();
  }

  look(deltaYaw, deltaPitch) {
    this.yaw -= deltaYaw;
    this.pitch = clamp(this.pitch - deltaPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.apply();
    return this;
  }

  orbit(deltaYaw, deltaPitch) {
    this.yaw -= deltaYaw;
    this.pitch = clamp(this.pitch + deltaPitch, -1.45, 1.45);
    this.apply();
    return this;
  }

  /** Middle-drag pan: moves the pivot in the camera plane (orbit) or slides the fly position. */
  pan(dx, dy) {
    const camera = this.camera;
    const scale = (this.mode === EditorCameraMode.Orbit ? this.distance : 12) * 0.0016;
    const right = Vector3.new(camera.right?.x ?? 1, camera.right?.y ?? 0, camera.right?.z ?? 0);
    const up = Vector3.new(camera.up?.x ?? 0, camera.up?.y ?? 1, camera.up?.z ?? 0);
    const delta = Vector3.new(-dx * scale, dy * scale, 0);
    if (this.mode === EditorCameraMode.Orbit) this.target.addScaled(right, delta.x).addScaled(up, delta.y);
    else this.position.addScaled(right, delta.x).addScaled(up, delta.y);
    this.apply();
    return this;
  }

  // ------------------------------------------------------------------ framing
  /** Frames a point with a radius (double-click, `F`, "zoom to fit"). */
  focus(point, radius = 6) {
    if (point?.worldPosition) {
      const world = point.worldPosition.clone();
      const bounds = point.getBounds?.() ?? null;
      if (bounds && !bounds.isEmpty?.()) radius = Math.max(bounds.getSize().length() * 0.75, 1.4);
      else radius = Math.max(Number(point.Size?.length?.() ?? 2) * 0.9, 1.4);
      point = world;
    } else if (point?.x !== undefined) {
      point = new Vector3(point.x, point.y, point.z);
    } else {
      return this;
    }
    this.target.copy(point);
    this.distance = clamp(radius / Math.tan(this.camera.fov * 0.5 * DEG2RAD) * 1.25, radius * 1.2, 400);
    this.mode = EditorCameraMode.Orbit;
    this.apply();
    return this;
  }

  /** Frames the whole scene (Home key, "frame all"). */
  frameAll() {
    const bounds = this.engine.scene?.getBounds?.();
    if (!bounds) return this;
    const center = bounds.getCenter();
    const size = bounds.getSize();
    const radius = Math.max(Math.hypot(size.x, size.y, size.z) * 0.5, 4);
    this.target.copy(center);
    this.distance = clamp(radius * 2.4, 8, 600);
    this.yaw = Math.PI * 0.25;
    this.pitch = -0.42;
    this.mode = EditorCameraMode.Orbit;
    return this.apply();
  }

  setMode(mode) {
    if (mode === this.mode) return this;
    if (mode === EditorCameraMode.Orbit) {
      // Entering orbit: keep the current position by deriving pivot + distance from it.
      const forward = this.camera.forward;
      this.distance = Math.max(this.distance, 8);
      this.target.copy(this.camera.worldPosition).addScaled(forward, this.distance);
    } else {
      this.position.copy(this.camera.worldPosition);
      this.yaw = this.camera.yaw;
      this.pitch = this.camera.pitch;
    }
    this.mode = mode;
    return this.apply();
  }

  /** Snaps a guessed viewing angle (used by the number keys 1–6 style presets in other editors). */
  setView(view) {
    const presets = {
      top: { yaw: 0, pitch: -1.5 },
      front: { yaw: 0, pitch: 0 },
      side: { yaw: Math.PI / 2, pitch: 0 },
      iso: { yaw: Math.PI * 0.25, pitch: -0.5 },
    };
    const preset = presets[view];
    if (!preset) return this;
    const focus = this.mode === EditorCameraMode.Orbit ? this.target.clone() : this.camera.worldPosition.clone();
    this.yaw = preset.yaw;
    this.pitch = preset.pitch;
    this.mode = EditorCameraMode.Orbit;
    this.target.copy(focus);
    return this.apply();
  }

  /** Fly-camera integration, called every editor frame. */
  update(dt) {
    if (!this.enabled) return this;
    if (this.mode === EditorCameraMode.Orbit) {
      this.apply();
      return this;
    }
    const keys = this._keys;
    let forwardAxis = 0;
    let rightAxis = 0;
    let upAxis = 0;
    if (keys.has('KeyW')) forwardAxis += 1;
    if (keys.has('KeyS')) forwardAxis -= 1;
    if (keys.has('KeyD')) rightAxis += 1;
    if (keys.has('KeyA')) rightAxis -= 1;
    if (keys.has('KeyE')) upAxis += 1;
    if (keys.has('KeyQ')) upAxis -= 1;
    const camera = this.camera;
    const speed = this.speed * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? this.boost : 1) * (keys.has('ControlLeft') || keys.has('AltLeft') ? 0.25 : 1);
    const desired = Vector3.new(0, 0, 0);
    if (forwardAxis || rightAxis || upAxis) {
      desired.addScaled(Vector3.new(camera.forward.x, camera.forward.y, camera.forward.z), forwardAxis);
      desired.addScaled(Vector3.new(camera.right.x, camera.right.y, camera.right.z), rightAxis);
      desired.addScaled(Vector3.new(0, 1, 0), upAxis);
      if (desired.lengthSq() > 1e-6) desired.normalize().scale(speed);
    }
    const blend = clamp01(1 - Math.exp(-this.smoothing * dt));
    this.velocity.lerp(desired, blend);
    if (this.velocity.lengthSq() > 1e-8) {
      this.position.addScaled(this.velocity, dt);
      this.apply();
    }
    return this;
  }

  serialize() {
    return {
      mode: this.mode, position: this.position.toArray(), yaw: this.yaw, pitch: this.pitch,
      target: this.target.toArray(), distance: this.distance, speed: this.speed,
    };
  }

  restore(data = {}) {
    if (!data) return this;
    if (data.position) this.position.fromArray(data.position);
    if (typeof data.yaw === 'number') this.yaw = data.yaw;
    if (typeof data.pitch === 'number') this.pitch = data.pitch;
    if (data.target) this.target.fromArray(data.target);
    if (typeof data.distance === 'number') this.distance = data.distance;
    if (typeof data.speed === 'number') this.speed = data.speed;
    if (data.mode) this.mode = data.mode;
    return this.apply();
  }

  get speedLabel() { return `${this.speed.toFixed(1)} m/s`; }
  get headingLabel() {
    const yaw = ((this.yaw * RAD2DEG) % 360 + 360) % 360;
    return `${yaw.toFixed(0)}° / ${(this.pitch * RAD2DEG).toFixed(0)}°`;
  }
}

const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'AltLeft']);

export { FLY_KEYS };
export default EditorCamera;
