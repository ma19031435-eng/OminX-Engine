/**
 * OminX Engine — camera system built around FPS needs.
 *
 * Beyond matrices it implements the layer that makes an FPS *feel* right:
 *  - recoil offsets that kick the view and settle back on a curve,
 *  - trauma-based screen shake (explosions, landings, suppression),
 *  - FOV punching for sprint / ADS / hit reactions,
 *  - a dedicated view-model camera (its own near plane + FOV) so the gun never clips walls,
 *  - screen↔world rays for hitscan, and world→screen projection for HUD markers.
 *
 * @module engine/renderer/Camera
 */
import { Vector3 } from '../math/Vector3.js';
import { Vector2 } from '../math/Vector2.js';
import { Quaternion } from '../math/Quaternion.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Frustum, Ray } from '../math/Geometry.js';
import { clamp, clamp01, lerp, damp, DEG2RAD, RAD2DEG, TAU } from '../math/MathUtils.js';
import { RNG } from '../math/Random.js';

export const CameraMode = {
  FirstPerson: 'firstPerson',
  ThirdPerson: 'thirdPerson',
  Free: 'free',
  Orbiting: 'orbiting',
  Static: 'static',
  DeathCam: 'deathCam',
};

let _camId = 0;

export class Camera {
  constructor(opts = {}) {
    this.id = `camera_${++_camId}`;
    this.name = opts.name ?? 'Camera';
    this.mode = opts.mode ?? CameraMode.FirstPerson;

    // --- transform
    this.position = new Vector3(opts.position?.x ?? 0, opts.position?.y ?? 1.7, opts.position?.z ?? 0);
    this.rotation = new Quaternion();
    this.up = new Vector3(0, 1, 0);

    // --- projection
    this.fov = opts.fov ?? 75;                 // vertical FOV in degrees (FPS games: 90-110 horizontal)
    this.baseFov = this.fov;
    this.near = opts.near ?? 0.08;
    this.far = opts.far ?? 500;
    this.aspect = opts.aspect ?? 16 / 9;
    this.orthographic = opts.orthographic ?? false;
    this.orthoSize = opts.orthoSize ?? 10;

    // --- view target (used when the camera is attached to a player/bot)
    this.target = opts.target ?? null;         // { position: Vector3, eyeOffset: Vector3|number, rotation: Quaternion }
    this.targetOffset = opts.targetOffset ? new Vector3().copy(opts.targetOffset) : new Vector3(0, 0, 0);
    this.followStiffness = opts.followStiffness ?? 0;   // 0 = rigid
    this.orbitDistance = opts.orbitDistance ?? 4;
    this.orbitAngle = 0;

    // --- FPS feel
    this.recoil = new Vector2(0, 0);           // pitch (x) / yaw (y) in radians, added to view
    this.recoilVelocity = new Vector2(0, 0);
    this.recoilRecovery = opts.recoilRecovery ?? 9;
    this.viewPunch = new Vector3(0, 0, 0);     // positional kick, decays to zero
    this.viewPunchVelocity = new Vector3(0, 0, 0);
    this.roll = 0;                              // camera roll (lean, strafe tilt)
    this.rollTarget = 0;
    this.trauma = 0;                            // 0..1, shake = trauma^2
    this.shakeFrequency = 22;
    this.shakeAmplitude = 0.35;
    this.shakeTime = 0;
    this._shakeRng = new RNG(1337);
    this.shakeRotation = 0.06;
    this.fovPunch = 0;                          // instantaneous FOV kick
    this.fovPunchDecay = 2.4;
    this.targetFov = this.fov;
    this.fovLerpSpeed = 9;
    /** Sprint FOV, ADS FOV, and any scripted zoom are expressed as multipliers of baseFov. */
    this.fovScale = 1;
    this.adsBlend = 0;
    this.adsFovScale = opts.adsFovScale ?? 1;
    this.sprintFovScale = opts.sprintFovScale ?? 1.06;
    this.bobAmount = 0;
    this.bobTime = 0;

    // --- derived matrices (recomputed in update())
    this.viewMatrix = new Matrix4();
    this.projectionMatrix = new Matrix4();
    this.viewProjectionMatrix = new Matrix4();
    this.inverseViewMatrix = new Matrix4();
    this.inverseProjectionMatrix = new Matrix4();
    this.inverseViewProjectionMatrix = new Matrix4();
    this.frustum = new Frustum();
    this.worldPosition = new Vector3();
    this.forward = new Vector3(0, 0, -1);
    this.right = new Vector3(1, 0, 0);
    this.upVector = new Vector3(0, 1, 0);
    this.dirtyProjection = true;
    this.dirtyView = true;

    // --- view-model camera (the gun) — its own FOV/near plane, rendered on top
    this.viewModel = {
      fov: opts.viewModelFov ?? 60,
      near: 0.01,
      far: 12,
      position: new Vector3(0.16, -0.14, -0.32),
      rotation: new Quaternion(),
      bob: new Vector2(0, 0),
      sway: new Vector3(0, 0, 0),
      recoilOffset: new Vector3(0, 0, 0),
      recoilRotation: new Vector3(0, 0, 0),
      adsPosition: new Vector3(0, -0.055, -0.22),
      viewMatrix: new Matrix4(),
      projectionMatrix: new Matrix4(),
      viewProjectionMatrix: new Matrix4(),
    };

    // --- post-processing hooks the camera owns (per-camera effects)
    this.postFx = {
      exposure: 1,
      vignette: 0.35,
      bloomIntensity: 1,
      chromaticAberration: 0.0006,
      saturation: 1.05,
      contrast: 1.02,
      grain: 0.02,
      toneMapping: 0, // 0 = ACES, 1 = filmic, 2 = reinhard, 3 = none
      ssao: true,
      fxaa: true,
      dofEnabled: true,
    };

    // --- damage feedback state (consumed by the composite pass)
    this.damage = {
      vignette: 0,      // 0..1 red screen pulse
      directionAngle: 0, // radians from screen centre toward the damage source
      flash: 0,
      lowHealth: 0,
      fade: 0,
      fadeColor: new Vector3(0, 0, 0),
    };
    this.nightVision = 0;
    this.underwater = 0;

    this.viewport = { x: 0, y: 0, width: 1920, height: 1080 };
  }

  static new(opts) { return new Camera(opts); }

  get projectionType() { return this.orthographic ? 'orthographic' : 'perspective'; }

  setAspect(aspect) {
    if (Math.abs(this.aspect - aspect) < 1e-6) return this;
    this.aspect = aspect;
    this.dirtyProjection = true;
    return this;
  }
  setViewport(x, y, width, height) {
    this.viewport.x = x; this.viewport.y = y;
    this.viewport.width = width; this.viewport.height = height;
    this.setAspect(width / Math.max(1, height));
    return this;
  }
  setFov(fov, { instant = false } = {}) {
    this.baseFov = clamp(fov, 5, 170);
    if (instant) { this.fov = this.baseFov * this.fovScale; this.dirtyProjection = true; }
    return this;
  }
  setFovScale(scale) { this.fovScale = scale; return this; }
  setNearFar(near, far) {
    this.near = near; this.far = far; this.dirtyProjection = true;
    this.viewModel.near = Math.max(0.005, near * 0.125);
    return this;
  }
  /** Horizontal FOV in degrees, in case the game/settings menu speaks in hFOV. */
  getHorizontalFov() {
    return 2 * Math.atan(Math.tan((this.fov * DEG2RAD) / 2) * this.aspect) * RAD2DEG;
  }
  setHorizontalFov(hfov) {
    const vfov = 2 * Math.atan(Math.tan((hfov * DEG2RAD) / 2) / this.aspect) * RAD2DEG;
    return this.setFov(vfov);
  }

  // ------------------------------------------------------------------ transforms
  setPosition(x, y, z) {
    if (typeof x === 'object') this.position.setFrom(x);
    else this.position.set(x, y, z);
    this.dirtyView = true;
    return this;
  }
  setRotation(quaternion) { this.rotation.copy(quaternion); this.dirtyView = true; return this; }
  /** Sets yaw/pitch in degrees (FPS convention: YXZ euler). */
  setLookAngles(yawDeg, pitchDeg, rollDeg = 0) {
    this.rotation.setFromEuler(pitchDeg * DEG2RAD, yawDeg * DEG2RAD, rollDeg * DEG2RAD, 'YXZ');
    this.dirtyView = true;
    return this;
  }
  get yaw() { return this.rotation.toEuler({}, 'YXZ').y; }
  get pitch() { return this.rotation.toEuler({}, 'YXZ').x; }
  set yaw(v) { const e = this.rotation.toEuler({}, 'YXZ'); this.rotation.setFromEuler(e.x, v, 0, 'YXZ'); this.dirtyView = true; }
  set pitch(v) { const e = this.rotation.toEuler({}, 'YXZ'); this.rotation.setFromEuler(clamp(v, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001), e.y, 0, 'YXZ'); this.dirtyView = true; }
  lookAt(target, up = null) {
    this.rotation.setFromLookAt(this.position, target, up ?? this.up);
    this.dirtyView = true;
    return this;
  }

  // ------------------------------------------------------------------ FPS feel
  /**
   * Applies weapon recoil. Pitch is the vertical kick; yaw drifts so a sustained spray
   * walks off the target the way real FPS recoil patterns do.
   * @param {number} pitchKick radians
   * @param {number} yawKick radians
   */
  addRecoil(pitchKick, yawKick = 0) {
    this.recoil.x += pitchKick;
    this.recoil.y += yawKick;
    this.recoilVelocity.y += yawKick * 6;
    return this;
  }
  /** Instantaneous positional kick (firing a shotgun, taking a hit, landing). */
  addViewPunch(v) {
    this.viewPunch.add(v);
    this.viewPunchVelocity.addScaled(v, 12);
    return this;
  }
  /** @param {number} amount 0..1 trauma. Shake intensity is quadratic. */
  addShake(amount, { frequency = null, amplitude = null } = {}) {
    this.trauma = clamp01(this.trauma + amount);
    if (frequency) this.shakeFrequency = frequency;
    if (amplitude) this.shakeAmplitude = amplitude;
    return this;
  }
  addFovPunch(degrees) { this.fovPunch += degrees; return this; }
  setAds(blend) { this.adsBlend = clamp01(blend); return this; }
  /** Damage indicator: angle is the world-space direction to the attacker. */
  addDamageIndicator(directionWorld, intensity = 1) {
    const local = directionWorld.clone();
    // project into camera space to get the on-screen direction
    const inv = this.inverseViewMatrix;
    local.transformDirection(inv);
    this.damage.directionAngle = Math.atan2(-local.x, -local.z);
    this.damage.vignette = clamp01(this.damage.vignette + intensity * 0.7);
    this.damage.flash = clamp01(this.damage.flash + intensity * 0.8);
    return this;
  }

  // ------------------------------------------------------------------ update
  /**
   * @param {number} dt seconds
   * @param {object} [ctx] gameplay context: { moveSpeed, grounded, sprinting, health01, aimPunch }
   */
  update(dt, ctx = {}) {
    // 1) follow target
    if (this.target) {
      const tp = this.target.position;
      const offset = typeof this.target.eyeOffset === 'number'
        ? new Vector3(0, this.target.eyeOffset, 0)
        : (this.target.eyeOffset ?? new Vector3(0, 1.62, 0));
      const desired = tp.clone().add(offset).add(this.targetOffset);
      if (this.followStiffness > 0) this.position.lerp(desired, 1 - Math.exp(-this.followStiffness * dt));
      else this.position.copy(desired);
      if (this.target.rotation) this.rotation.copy(this.target.rotation);
    }

    // 2) recoil recovery toward zero
    const recovery = Math.exp(-this.recoilRecovery * dt);
    this.recoil.x *= recovery;
    this.recoil.y *= recovery;
    this.recoilVelocity.scale(Math.exp(-this.recoilRecovery * 0.6 * dt));
    this.recoil.addScaled(this.recoilVelocity, dt);

    // 3) positional punch decay (spring)
    const k = 90, damping = 14;
    this.viewPunchVelocity.addScaled(this.viewPunch, -k * dt);
    this.viewPunchVelocity.scale(Math.max(0, 1 - damping * dt));
    this.viewPunch.addScaled(this.viewPunchVelocity, dt);
    if (this.viewPunch.sqrMagnitude < 1e-8) this.viewPunch.set(0, 0, 0);

    // 4) shake (trauma → curved amplitude, perlin-ish via layered sines so it's frame-rate independent)
    this.shakeTime += dt * this.shakeFrequency;
    const shake = this.trauma * this.trauma;
    const shakeVec = new Vector3(
      (Math.sin(this.shakeTime * 1.0) + Math.sin(this.shakeTime * 2.31) * 0.5) * 0.5,
      (Math.sin(this.shakeTime * 1.37 + 2.1) + Math.sin(this.shakeTime * 3.11) * 0.5) * 0.5,
      (Math.sin(this.shakeTime * 0.87 + 4.2) + Math.sin(this.shakeTime * 2.71) * 0.5) * 0.5,
    );
    this.shakeOffset = shakeVec.clone().scale(shake * this.shakeAmplitude * 0.25);
    this.shakeRotationOffset = shake * this.shakeRotation * (Math.sin(this.shakeTime * 1.7) * 0.5 + Math.sin(this.shakeTime * 4.1) * 0.5);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);

    // 5) roll: strafe lean + damage tilt
    const strafe = ctx.strafeInput ?? 0;
    const speed01 = clamp01((ctx.moveSpeed ?? 0) / 8);
    this.rollTarget = -strafe * 0.035 * (1 - this.adsBlend * 0.6) + (ctx.rollOffset ?? 0);
    this.roll = damp(this.roll, this.rollTarget, 8, dt);

    // 6) FOV: base × scale (sprint/ADS) + punch, smoothed
    const sprintScale = ctx.sprinting ? this.sprintFovScale : 1;
    const adsScale = lerp(1, this.adsFovScale, this.adsBlend);
    this.fovScale = damp(this.fovScale, sprintScale * adsScale, this.fovLerpSpeed, dt);
    this.fovPunch = damp(this.fovPunch, 0, this.fovPunchDecay, dt);
    const newFov = clamp(this.baseFov * this.fovScale + this.fovPunch, 5, 170);
    if (Math.abs(newFov - this.fov) > 0.005) { this.fov = newFov; this.dirtyProjection = true; }

    // 7) weapon bob (only while moving on the ground)
    if (ctx.moveSpeed > 0.5 && (ctx.grounded ?? true)) {
      this.bobTime += dt * (6 + speed01 * 7);
      this.bobAmount = damp(this.bobAmount, speed01 * (ctx.sprinting ? 1.3 : 1), 6, dt);
    } else {
      this.bobAmount = damp(this.bobAmount, 0, 7, dt);
    }
    const bobX = Math.sin(this.bobTime) * 0.028 * this.bobAmount;
    const bobY = Math.abs(Math.cos(this.bobTime)) * -0.022 * this.bobAmount;
    this.viewModel.bob.set(bobX, bobY);
    this.viewModel.sway.set(
      bobX * 0.7, bobY * 0.7,
      0,
    );
    void ctx.aimPunch;

    // 8) damage timers
    this.damage.vignette = Math.max(0, this.damage.vignette - dt * 1.3);
    this.damage.flash = Math.max(0, this.damage.flash - dt * 3.2);
    this.damage.lowHealth = clamp01(ctx.health01 !== undefined ? (1 - ctx.health01) * (ctx.health01 < 0.35 ? 1 : 0) : 0);

    // 9) build matrices
    this._updateMatrices();
    return this;
  }

  _updateMatrices() {
    const shakePos = this.shakeOffset ?? _zero;
    // Effective camera rotation = base rotation * recoil * shake
    const e = this.rotation.toEuler({}, 'YXZ');
    const effective = _q.setFromEuler(
      clamp(e.x + this.recoil.x + this.shakeRotationOffset * 0.5, -1.55, 1.55),
      e.y + this.recoil.y + this.shakeRotationOffset,
      this.roll + this.shakeRotationOffset * 0.7,
      'YXZ',
    );

    this.forward.set(0, 0, -1).applyQuaternion(effective);
    this.right.set(1, 0, 0).applyQuaternion(effective);
    this.upVector.set(0, 1, 0).applyQuaternion(effective);

    if (this.mode === CameraMode.Orbiting && this.target) {
      const t = this.target.position.clone();
      this.position.set(
        t.x + Math.cos(this.orbitAngle) * this.orbitDistance,
        t.y + 1.6,
        t.z + Math.sin(this.orbitAngle) * this.orbitDistance,
      );
      this.lookAt(t);
      this.rotation.toEuler({}, 'YXZ');
      this.forward.set(0, 0, -1).applyQuaternion(this.rotation);
    }

    this.worldPosition.copy(this.position).add(this.viewPunch).add(shakePos);
    this.viewMatrix.lookAt(this.worldPosition, _v.copy(this.worldPosition).add(this.forward), this.upVector);
    this.inverseViewMatrix.copy(this.viewMatrix).invert();

    if (this.dirtyProjection) {
      if (this.orthographic) {
        const h = this.orthoSize, w = h * this.aspect;
        this.projectionMatrix.makeOrthographic(-w, w, h, -h, this.near, this.far);
      } else {
        this.projectionMatrix.makePerspective(this.fov * DEG2RAD, this.aspect, this.near, this.far);
      }
      this.inverseProjectionMatrix.copy(this.projectionMatrix).invert();
      this.dirtyProjection = false;
    }
    this.viewProjectionMatrix.multiplyMatrices(this.projectionMatrix, this.viewMatrix);
    this.inverseViewProjectionMatrix.copy(this.viewProjectionMatrix).invert();
    this.frustum.setFromProjectionMatrix(this.viewProjectionMatrix);
    this.dirtyView = false;

    // view-model camera: same rotation, its own offset transform and narrower FOV
    const vm = this.viewModel;
    vm.viewMatrix.copy(this.viewMatrix);
    if (Math.abs(vm._fov ?? -1) !== vm.fov) {
      vm.projectionMatrix.makePerspective(vm.fov * DEG2RAD, this.aspect, vm.near, vm.far);
      vm._fov = vm.fov;
    }
    vm.viewProjectionMatrix.multiplyMatrices(vm.projectionMatrix, vm.viewMatrix);
    return this;
  }

  // ------------------------------------------------------------------ queries
  /** Screen point (pixels, top-left origin, canvas-relative) → world ray. */
  screenToRay(screenX, screenY) {
    const ndcX = (screenX / this.viewport.width) * 2 - 1;
    const ndcY = 1 - (screenY / this.viewport.height) * 2;
    const nearPoint = new Vector3(ndcX, ndcY, -1).applyMatrix4(this.inverseViewProjectionMatrix);
    const farPoint = new Vector3(ndcX, ndcY, 1).applyMatrix4(this.inverseViewProjectionMatrix);
    const dir = farPoint.sub(nearPoint).normalize();
    return new Ray(nearPoint, dir);
  }
  /** The hitscan ray for the crosshair — always the exact centre pixel. */
  getCenterRay() { return new Ray(this.worldPosition.clone(), this.forward.clone()); }
  /** Ray through the ADS/weapon muzzle: useful for "gun barrel" style aiming. */
  getMuzzleRay(muzzleWorldPos, convergenceDistance = 60) {
    const target = this.worldPosition.clone().addScaled(this.forward, convergenceDistance);
    const dir = target.sub(muzzleWorldPos).normalize();
    return new Ray(muzzleWorldPos.clone(), dir);
  }
  /** World point → screen pixels. Returns null when behind the camera. */
  worldToScreen(worldPoint, out = { x: 0, y: 0, visible: false }) {
    // Two separate temps: the clip-space point and the view-space depth must not alias.
    const clip = _vsClip.copy(worldPoint).applyMatrix4(this.viewProjectionMatrix);
    const viewZ = _vsView.copy(worldPoint).applyMatrix4(this.viewMatrix).z;
    if (viewZ > -this.near) { out.visible = false; return out; }
    out.x = (clip.x * 0.5 + 0.5) * this.viewport.width;
    out.y = (1 - (clip.y * 0.5 + 0.5)) * this.viewport.height;
    out.visible = clip.z >= -1.0001 && clip.z <= 1.0001;
    return out;
  }
  projectDirectionToScreen(worldDir, out = { x: 0, y: 0, behind: false }) {
    const local = worldDir.clone().transformDirection(this.inverseViewMatrix);
    out.behind = local.z > 0;
    const fovScale = Math.tan((this.fov * DEG2RAD) / 2);
    const ndcX = (local.x / -local.z) / (fovScale * this.aspect);
    const ndcY = (local.y / -local.z) / fovScale;
    out.x = (clamp(ndcX, -4, 4) * 0.5 + 0.5) * this.viewport.width;
    out.y = (1 - (clamp(ndcY, -4, 4) * 0.5 + 0.5)) * this.viewport.height;
    return out;
  }
  /** Angle (radians) of a world direction relative to the screen centre — HUD arrows. */
  directionToScreenAngle(worldDir) {
    const local = worldDir.clone().transformDirection(this.inverseViewMatrix);
    return Math.atan2(-local.x, -local.z);
  }
  isPointVisible(point, radius = 0) {
    const s = { x: 0, y: 0, visible: false };
    this.worldToScreen(point, s);
    return s.visible
      && s.x >= -radius && s.x <= this.viewport.width + radius
      && s.y >= -radius && s.y <= this.viewport.height + radius;
  }

  /** Third-person / killcam helper: pull the camera back with a wall check callback. */
  applyThirdPerson(distance, obstacleCheck = null) {
    const eye = this.worldPosition.clone();
    const back = this.forward.clone().scale(-distance).add(eye);
    if (obstacleCheck) {
      const hit = obstacleCheck(eye, back);
      if (hit) back.copy(hit);
    }
    this.position.copy(back);
    this._updateMatrices();
    return this;
  }
  /** Death cam: freezes aim, then orbits the killer slowly. */
  startDeathCam(killerPosition, victimPosition) {
    this.mode = CameraMode.DeathCam;
    this.deathCam = {
      position: victimPosition.clone(),
      killerPosition: killerPosition.clone(),
      time: 0,
      duration: 3.4,
    };
    return this;
  }
  updateDeathCam(dt) {
    if (this.mode !== CameraMode.DeathCam || !this.deathCam) return;
    const dc = this.deathCam;
    dc.time += dt;
    const t = clamp01(dc.time / dc.duration);
    // Fly from the victim's eye toward the killer, rising slightly, then orbit.
    const victimEye = dc.position.clone().add(new Vector3(0, 1.35, 0));
    const killerEye = dc.killerPosition.clone().add(new Vector3(0, 1.5, 0));
    const dir = killerEye.clone().sub(victimEye).normalize();
    const backOff = killerEye.clone().addScaled(dir, -2.4).add(new Vector3(0, 0.6, 0));
    const eased = t < 0.45 ? t / 0.45 : 1;
    this.position.copy(victimEye).lerp(backOff, eased * eased * (3 - 2 * eased));
    if (t > 0.45) {
      const orbit = (t - 0.45) / 0.55;
      const angle = orbit * Math.PI * 0.7;
      const offset = killerEye.clone().sub(this.position);
      const radius = offset.magnitude;
      const baseAngle = Math.atan2(offset.z, offset.x);
      this.position.set(
        killerEye.x + Math.cos(baseAngle + angle) * radius,
        lerp(this.position.y, killerEye.y + 0.4, orbit * 0.4),
        killerEye.z + Math.sin(baseAngle + angle) * radius,
      );
    }
    const look = dc.time < 0.35 ? victimEye.clone().addScaled(dir, 6) : killerEye;
    this.lookAt(look);
    this.roll = Math.sin(dc.time * 0.9) * 0.05 * (1 - t);
    this._updateMatrices();
    if (t >= 1) this.mode = CameraMode.Static;
  }
  stopDeathCam() { this.mode = CameraMode.FirstPerson; this.deathCam = null; return this; }

  /** Serializes the camera state so it can be saved into a map's `Spectate` node. */
  toJSON() {
    return {
      position: this.position.toJSON(),
      rotation: this.rotation.toJSON(),
      fov: this.baseFov,
      near: this.near,
      far: this.far,
      mode: this.mode,
    };
  }
  fromJSON(j) {
    if (!j) return this;
    if (j.position) this.position.fromArray(j.position);
    if (j.rotation) this.rotation.fromArray(j.rotation);
    if (j.fov) this.setFov(j.fov, { instant: true });
    if (j.near) this.near = j.near;
    if (j.far) this.far = j.far;
    if (j.mode) this.mode = j.mode;
    this._updateMatrices();
    return this;
  }
  toString() { return `Camera(${this.mode}, fov=${this.fov.toFixed(0)}°, ${this.position.toString()})`; }
}

const _v = new Vector3();
const _vsClip = new Vector3();
const _vsView = new Vector3();
const _q = new Quaternion();
const _zero = new Vector3();

/** Camera shake presets used across the game (gameplay code just calls these names). */
export const ShakePreset = {
  hit: { trauma: 0.35, frequency: 26, amplitude: 0.4 },
  land: { trauma: 0.22, frequency: 18, amplitude: 0.3 },
  explosionNear: { trauma: 0.95, frequency: 14, amplitude: 1.1 },
  explosionFar: { trauma: 0.4, frequency: 12, amplitude: 0.55 },
  gunshotLight: { trauma: 0.06, frequency: 40, amplitude: 0.12 },
  gunshotHeavy: { trauma: 0.16, frequency: 34, amplitude: 0.22 },
  suppressed: { trauma: 0.05, frequency: 30, amplitude: 0.1 },
  kill: { trauma: 0.1, frequency: 20, amplitude: 0.15 },
  death: { trauma: 0.8, frequency: 10, amplitude: 0.9 },
  fall: { trauma: 0.5, frequency: 16, amplitude: 0.6 },
};

export default Camera;
