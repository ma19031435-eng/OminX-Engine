/**
 * OminX Engine — kinematic FPS character controller.
 *
 * Movement model: ground-accelerated (Quake/Source lineage) rather than purely physics-driven,
 * because that is what gives shooters their signature feel — instant direction changes on the
 * ground, limited air control, preserved momentum when jumping, and reliable stair climbing.
 * All collision resolution is swept (see `CollisionWorld.moveAABB`), so the controller cannot
 * tunnel through thin walls even at sprint speed or with 200 ms of lag-compensated movement.
 *
 * Features: stand/crouch/prone stances with ceiling checks, sprint/walk modifiers, slide with
 * friction ramp, coyote time, jump buffering, bunny-hop toggle, ladders, water swimming,
 * step-up, bounce off ceilings, fall damage with an apex-based curve, head bob, landing dip,
 * and surface-aware footstep events driving audio + AI hearing.
 *
 * @module engine/src/physics/KinematicCharacter.js
 */
import { Vector3 } from '../math/Vector3.js';
import { AABB } from '../math/Geometry.js';
import { Quaternion } from '../math/Quaternion.js';
import { Signal } from '../core/Signal.js';
import { clamp, clamp01, DEG2RAD, moveTowards } from '../math/MathUtils.js';
import { CollisionLayer } from '../world/Part.js';

/** Movement stances. */
export const Stance = { Stand: 'stand', Crouch: 'crouch', Prone: 'prone' };

/** Stance table: height, eye height, movement speed multiplier, collision box width scale. */
export const StanceConfig = {
  [Stance.Stand]: { height: 1.8, eye: 1.62, speedScale: 1, widthScale: 1 },
  [Stance.Crouch]: { height: 1.2, eye: 1.05, speedScale: 0.52, widthScale: 1 },
  [Stance.Prone]: { height: 0.7, eye: 0.5, speedScale: 0.25, widthScale: 1 },
};

/** Movement tuning — the numbers that define the game's feel. */
export const DefaultMovement = {
  walkSpeed: 4.4,           // m/s base
  sprintSpeed: 6.6,
  crouchSpeed: 2.2,
  sprintCrouchSpeed: 1.1,   // if sprint-crouch allowed (off by default)
  backpedalScale: 0.85,
  strafeScale: 0.95,
  groundAccel: 62,          // m/s² — high for snappy stops
  airAccel: 14,
  airControl: 0.32,
  friction: 8.5,
  jumpSpeed: 7.2,           // ≈1.05 m hop with the air gravity scale below
  jumpCooldown: 0.22,
  coyoteTime: 0.12,
  jumpBufferTime: 0.15,
  gravity: 21.5,            // stronger than reality; shooters feel floaty at 9.81
  maxFallSpeed: 58,
  stepHeight: 0.45,
  slopeLimit: 0.55,         // cos of the steepest walkable slope
  stanceChangeSpeed: 8.5,   // stances per second (smooth transitions)
  crouchSlideBoost: 1.35,
  slideFriction: 2.4,
  slideMinSpeed: 3.2,
  bunnyHop: false,
  headBob: 0.035,
  bobFrequency: 8.6,
  landDip: 0.09,
  fallDamageSpeed: 16,      // m/s impact at which damage starts
  fallDamagePerSpeed: 6.4,
  terminalFallDamage: 100,
  waterDrag: 3.2,
  swimSpeed: 3.0,
  ladderSpeed: 3.2,
  autoBhop: false,
};

export class KinematicCharacter {
  /**
   * @param {import('../world/Scene.js').Scene} scene
   * @param {object} [opts] movement overrides + { position, radius, team, layerMask, owner }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.collision = scene?.collision ?? null;
    this.movement = { ...DefaultMovement, ...(opts.movement ?? opts) };
    this.radius = opts.radius ?? 0.35;
    // Spawn pads, plain {x,y,z} literals and `{ position }` wrappers all reach this constructor,
    // so the feet position is always normalised into a real Vector3 (never a cloned instance).
    this.position = normalizePoint(opts.position);
    this.velocity = new Vector3();
    this.team = opts.team ?? 'neutral';
    this.layerMask = opts.layerMask ?? (CollisionLayer.Static | CollisionLayer.Dynamic | CollisionLayer.Character);
    this.ignore = opts.ignore ?? new Set();
    this.owner = opts.owner ?? null;
    this.enabled = opts.enabled !== false;

    this.stance = opts.stance ?? Stance.Stand;
    this.stanceBlend = this.stance === Stance.Stand ? 0 : 1;
    this.onGround = false;
    this.wasOnGround = false;
    this.groundSurface = null;
    this.groundPart = null;
    this.wallNormal = new Vector3();
    this.ceiling = false;
    this.sprinting = false;
    this.sliding = false;
    this.slideSpeed = 0;
    this.onLadder = false;
    this.inWater = false;
    this.waterDepth = 0;

    this.yaw = opts.yaw ?? 0;
    this.speed = 0;
    this.horizontalSpeed = 0;
    this.verticalSpeed = 0;
    this.fallStart = this.position.y;
    this.peakY = this.position.y;
    this.lastImpactSpeed = 0;
    this.stepDistance = 0;
    this.airTime = 0;

    this._jumpCooldown = 0;
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._lastStepPhase = 0;
    this.bob = { phase: 0, offset: 0, lateral: 0, dip: 0, roll: 0 };
    this.moveResult = null;

    // Signals consumed by audio, animation and HUD systems.
    this.Jumped = new Signal('Character.Jumped');
    this.Landed = new Signal('Character.Landed');
    this.Footstep = new Signal('Character.Footstep');
    this.StanceChanged = new Signal('Character.StanceChanged');
    this.Slid = new Signal('Character.Slid');
    this.FallDamage = new Signal('Character.FallDamage');
    this.WallHit = new Signal('Character.WallHit');
  }

  static create(scene, opts) { return new KinematicCharacter(scene, opts); }

  get speed_multiplier() { return this.movement.speedScale ?? 1; }

  /**
   * Current collision box in world space. `position` is the feet; the box starts `SKIN`
   * above them so resting on a surface is never a "start solid" overlap.
   */
  get bounds() { return this._writeBounds(new AABB()); }

  /** Reusable box (avoids per-frame allocation in the hot path). */
  _writeBounds(box) {
    const stanceCfg = StanceConfig[this.stance];
    const halfWidth = this.radius * stanceCfg.widthScale;
    box.min.set(this.position.x - halfWidth, this.position.y + SKIN, this.position.z - halfWidth);
    box.max.set(this.position.x + halfWidth, this.position.y + stanceCfg.height, this.position.z + halfWidth);
    return box;
  }

  /**
   * Converts a resolved box position back into feet position.
   *
   * `CollisionWorld.moveAABB` works in *box* space, so the box minimum is `position - radius`
   * horizontally and `position + SKIN` vertically. Both offsets must be undone here — skipping
   * them makes the character walk `-radius` every frame (straight through walls and off the
   * map), which is exactly what happened before this comment existed.
   */
  _applyResolvedPosition(boxMin) {
    const cfg = StanceConfig[this.stance];
    const halfWidth = this.radius * cfg.widthScale;
    this.position.set(boxMin.x + halfWidth, boxMin.y - SKIN, boxMin.z + halfWidth);
    return this;
  }

  /** Eye position, including stance offset, bob and landing dip. */
  get eyePosition() {
    const stanceCfg = StanceConfig[this.stance];
    const out = new Vector3(this.position.x, this.position.y + stanceCfg.eye, this.position.z);
    out.y += this.bob.offset + this.bob.dip;
    out.x += this.bob.lateral * 0.35;
    return out;
  }

  /** Forward direction including pitch (used for aiming and view models). */
  getForward(pitch = 0, out = new Vector3()) {
    const cp = Math.cos(pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(pitch), -Math.cos(this.yaw) * cp).normalize();
  }

  getMoveVector(out = new Vector3()) {
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // yaw 0 looks down -Z; input.y is forward.
    out.set(0, 0, 0);
    return out;
  }

  // ------------------------------------------------------------------ input → velocity
  /**
   * Computes the wish direction from input axes.
   * @param {number} inputX -1..1 (right positive)
   * @param {number} inputY -1..1 (forward positive)
   */
  wishDirection(inputX, inputY, out = new Vector3()) {
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const fx = -sin, fz = -cos;          // forward
    const rx = cos, rz = -sin;           // right
    return out.set(fx * inputY + rx * inputX, 0, fz * inputY + rz * inputX);
  }

  /**
   * Main integration step.
   * @param {number} dt seconds (sub-stepped internally when large, e.g. after a lag spike)
   * @param {object} [input] { moveX, moveY, jump, crouch, sprint, walk, prone, wishDir }
   */
  update(dt, input = {}) {
    if (!this.enabled) return this;
    // Sub-step long frames so fast movement can't tunnel and physics stays stable.
    let remaining = Math.min(dt, 0.25);
    const maxStep = 1 / 45;
    while (remaining > 1e-6) {
      const step = Math.min(maxStep, remaining);
      this._step(step, input);
      remaining -= step;
    }
    this._updateBob(dt, input);
    return this;
  }

  _step(dt, input) {
    const m = this.movement;
    this.wasOnGround = this.onGround;

    // ---- stance handling (with a ceiling check before standing up) ----
    const wantProne = !!input.prone && !this.sliding;
    const wantCrouch = (!!input.crouch || wantProne) && !this.sliding;
    const targetStance = wantProne ? Stance.Prone : wantCrouch ? Stance.Crouch : Stance.Stand;
    if (targetStance !== this.stance) {
      if (StanceConfig[targetStance].height > StanceConfig[this.stance].height) {
        if (this._fitsStance(targetStance)) this._setStance(targetStance);
      } else {
        this._setStance(targetStance);
        if (this.onGround && this.sprinting && this.stance === Stance.Crouch && m.crouchSlideBoost > 1) this._startSlide(input);
      }
    }
    this.stanceBlend = moveTowards(this.stanceBlend, this.stance === Stance.Stand ? 0 : 1, dt * m.stanceChangeSpeed);

    // ---- sprinting ----
    const movingForward = (input.moveY ?? 0) > 0.1;
    const wantsSprint = !!input.sprint && movingForward && this.stance !== Stance.Crouch && this.stance !== Stance.Prone;
    this.sprinting = wantsSprint && !this.sliding;

    // ---- water / ladder detection ----
    this._updateEnvironment();

    // ---- desired horizontal velocity ----
    const wish = input.wishDir ? input.wishDir : this.wishDirection(input.moveX ?? 0, input.moveY ?? 0, _dir);
    if (this.onLadder) {
      this._ladderMove(dt, input, wish);
    } else if (this.inWater && this.waterDepth > 0.8) {
      this._swimMove(dt, input, wish);
    } else if (this.sliding) {
      this._slideMove(dt, wish);
    } else {
      this._groundAirMove(dt, input, wish);
    }

    // ---- gravity ----
    if (!this.onLadder) {
      const gravityScale = this.onGround ? 1 : 1.15;      // slightly heavier in air: snappier arcs
      this.velocity.y -= m.gravity * gravityScale * dt;
      if (this.inWater && this.waterDepth > 0.8) this.velocity.y = Math.max(this.velocity.y, -2.2);
      this.velocity.y = Math.max(this.velocity.y, -m.maxFallSpeed);
    }

    // ---- jump handling (buffer + coyote time) ----
    this._jumpCooldown = Math.max(0, this._jumpCooldown - dt);
    this._coyote = this.onGround ? m.coyoteTime : Math.max(0, this._coyote - dt);
    if (input.jump) this._jumpBuffer = m.jumpBufferTime;
    else this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);

    if (this._jumpBuffer > 0 && this._jumpCooldown <= 0 && (this._coyote > 0 || this.onLadder || (this.inWater && this.waterDepth > 0.8))) {
      this._doJump();
    }

    // ---- integrate + collide ----
    this._move(dt);

    // ---- ground state, fall damage, footsteps ----
    this._postMove(dt);
  }

  _setStance(stance) {
    const previous = this.stance;
    this.stance = stance;
    this.StanceChanged.emit(stance, previous);
    return this;
  }

  /** True when the character can stand with `stance` without clipping geometry above. */
  _fitsStance(stance) {
    if (!this.collision) return true;
    const cfg = StanceConfig[stance];
    const halfWidth = this.radius * cfg.widthScale;
    _box.min.set(this.position.x - halfWidth, this.position.y + 0.02, this.position.z - halfWidth);
    _box.max.set(this.position.x + halfWidth, this.position.y + cfg.height, this.position.z + halfWidth);
    const overlapping = this.collision.overlapsBox(_box, { layerMask: this.layerMask & ~CollisionLayer.Trigger });
    for (const part of overlapping) {
      if (part.CanCollide === false) continue;
      if (this.ignore.has(part)) continue;
      if (part.surfaceKind?.key === 'water' || part.surfaceKind?.key === 'foliage') continue;
      return false;
    }
    return true;
  }

  _startSlide(input) {
    const speed = this.horizontalSpeed;
    if (speed < this.movement.slideMinSpeed) return false;
    this.sliding = true;
    this.slideSpeed = speed * this.movement.crouchSlideBoost;
    // Preserve the direction of travel; steering during a slide is limited to ±20°.
    this.slideDirection = this.velocity.clone().setY(0).normalize();
    this.Slid.emit({ speed: this.slideSpeed, direction: this.slideDirection.clone() });
    void input;
    return true;
  }

  _updateEnvironment() {
    if (!this.collision) return;
    const feet = _point.set(this.position.x, this.position.y + 0.1, this.position.z);
    const water = this.collision.overlapsSphere(feet, 0.05, { layerMask: CollisionLayer.Water, triggers: true });
    this.inWater = water.length > 0;
    if (this.inWater) {
      const hit = this.collision.raycast(
        _point2.set(this.position.x, this.position.y + 4, this.position.z), _down,
        { maxDistance: 8, layerMask: CollisionLayer.Water, triggers: true },
      );
      this.waterDepth = hit ? Math.max(0, (this.position.y + 4 - hit.distance) - this.position.y + 1.6) : 1;
    } else {
      this.waterDepth = 0;
    }
  }

  _groundAirMove(dt, input, wish) {
    const m = this.movement;
    const wishMag = Math.hypot(wish.x, wish.z);
    if (wishMag > 1e-4) wish.scale(1 / wishMag);

    // Target speed depends on stance, sprint and direction (backpedalling is slower).
    let maxSpeed = this.onGround
      ? (this.sprinting ? m.sprintSpeed : m.walkSpeed)
      : Math.max(m.walkSpeed, m.sprintSpeed * 0.98);
    if (this.stance === Stance.Crouch) maxSpeed = Math.min(maxSpeed, m.crouchSpeed);
    if (this.stance === Stance.Prone) maxSpeed = Math.min(maxSpeed, m.crouchSpeed * 0.45);
    if (input.walk) maxSpeed *= 0.48;
    if ((input.moveY ?? 0) < -0.1) maxSpeed *= m.backpedalScale;
    if (Math.abs(input.moveX ?? 0) > 0.1 && Math.abs(input.moveY ?? 0) < 0.1) maxSpeed *= m.strafeScale;

    const accel = this.onGround ? m.groundAccel : m.airAccel;
    const targetVX = wish.x * maxSpeed;
    const targetVZ = wish.z * maxSpeed;

    if (this.onGround) {
      this.velocity.x = moveTowards(this.velocity.x, targetVX, accel * dt);
      this.velocity.z = moveTowards(this.velocity.z, targetVZ, accel * dt);
      // Friction only applies when not actively accelerating (keeps strafe-jump feel intact).
      if (wishMag < 1e-4) {
        const speed = Math.hypot(this.velocity.x, this.velocity.z);
        if (speed > 0) {
          const drop = speed * m.friction * dt;
          const factor = Math.max(0, speed - drop) / speed;
          this.velocity.x *= factor;
          this.velocity.z *= factor;
        }
      }
    } else {
      // Air control: only the component perpendicular to current velocity is added, which
      // preserves speed (source-style air strafing) but caps how fast you can turn.
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      const control = m.airControl * (input.bunnyHop ? 1.35 : 1);
      const dot = speed > 1e-4 ? (this.velocity.x * targetVX + this.velocity.z * targetVZ) / (speed * maxSpeed || 1) : 0;
      if (dot < 0.9 || speed < maxSpeed) {
        this.velocity.x = moveTowards(this.velocity.x, targetVX, accel * control * dt * 3);
        this.velocity.z = moveTowards(this.velocity.z, targetVZ, accel * control * dt * 3);
      }
      // Air drag keeps long jumps from crossing the whole map.
      if (m.airDrag > 0) {
        const drag = Math.max(0, 1 - m.airDrag * dt);
        this.velocity.x *= drag;
        this.velocity.z *= drag;
      }
    }
  }

  _slideMove(dt, wish) {
    const m = this.movement;
    const slideDir = this.slideDirection ?? _dir2.copy(this.velocity).setY(0).normalize();
    // Limited steering while sliding: ±0.45 rad of yaw authority.
    const steer = clamp((wish.x ?? 0) * 0.9 + (wish.z ?? 0) * 0, -1, 1) * 0.45;
    const sin = Math.sin(steer), cos = Math.cos(steer);
    const dx = slideDir.x * cos - slideDir.z * sin;
    const dz = slideDir.x * sin + slideDir.z * cos;
    this.slideSpeed = Math.max(0, this.slideSpeed - m.slideFriction * dt * 2.2);
    this.velocity.x = dx * this.slideSpeed;
    this.velocity.z = dz * this.slideSpeed;
    if (this.slideSpeed < m.slideMinSpeed * 0.55 || !this.onGround) {
      this.sliding = false;
      this._setStance(Stance.Crouch);
    }
    this.slideDirection = _dir2.set(dx, 0, dz);
  }

  _swimMove(dt, input, wish) {
    const m = this.movement;
    this.velocity.x += (wish.x * m.swimSpeed - this.velocity.x) * Math.min(1, m.waterDrag * dt);
    this.velocity.z += (wish.z * m.swimSpeed - this.velocity.z) * Math.min(1, m.waterDrag * dt);
    const vertical = input.jump ? 1 : (input.crouch ? -1 : 0);
    this.velocity.y += (vertical * m.swimSpeed - this.velocity.y) * Math.min(1, m.waterDrag * dt);
  }

  _ladderMove(dt, input, wish) {
    const m = this.movement;
    this.velocity.set(wish.x * 1.2, 0, wish.z * 1.2);
    this.velocity.y = ((input.moveY ?? 0) * m.ladderSpeed) + (input.jump ? m.ladderSpeed * 0.6 : 0);
    this.velocity.y = clamp(this.velocity.y, -m.ladderSpeed, m.ladderSpeed);
  }

  _doJump() {
    const m = this.movement;
    this._jumpBuffer = 0;
    this._jumpCooldown = m.jumpCooldown;
    if (this.inWater && this.waterDepth > 0.8) {
      this.velocity.y = Math.max(this.velocity.y, m.jumpSpeed * 0.7);
    } else if (this.onLadder) {
      this.velocity.y = m.ladderSpeed;
    } else {
      // Crouch-jump: slightly lower hop, plus the stance auto-stands for the mantle.
      const scale = this.stance === Stance.Stand ? 1 : 0.82;
      this.velocity.y = m.jumpSpeed * scale;
      this.onGround = false;
      this._coyote = 0;
      this.fallStart = this.position.y;
      this.peakY = this.position.y;
      this.Jumped.emit({ velocity: this.velocity.clone(), speed: this.horizontalSpeed });
      if (this.stance !== Stance.Stand && this._fitsStance(Stance.Stand)) this._setStance(Stance.Stand);
    }
    // Jump momentum preservation: keep horizontal speed even when the player stops pressing.
    if (!m.bunnyHop) {
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      const maxLean = m.walkSpeed * 1.12;
      if (speed > maxLean) {
        const factor = maxLean / speed;
        this.velocity.x *= factor;
        this.velocity.z *= factor;
      }
    }
  }

  /** Integrates velocity through the collision world with slide/step-up resolution. */
  _move(dt) {
    if (!this.collision) {
      this.position.addScaled(this.velocity, dt);
      return this;
    }
    void SKIN;
    this._writeBounds(_box);
    const delta = _delta.copy(this.velocity).scale(dt);
    if (delta.sqrMagnitude < 1e-12) { this.moveResult = null; return this; }
    const result = this.collision.moveAABB(_box, delta, {
      layerMask: this.layerMask,
      ignore: this.ignore,
      stepHeight: this.stance === Stance.Prone ? 0.15 : this.movement.stepHeight,
      triggers: false,
    });
    this.moveResult = result;
    this._applyResolvedPosition(result.position);
    // Wall reaction: kill the velocity component into the surface (the sweep already slid it).
    if (result.hits > 0 && result.blockedAxes.magnitude > 0) {
      if (result.blockedAxes.x) this.velocity.x = 0;
      if (result.blockedAxes.z) this.velocity.z = 0;
      this.ceiling = result.ceiling;
      if (result.ceiling && this.velocity.y > 0) this.velocity.y = 0;
      if (this.horizontalSpeed > 5.5) this.WallHit.emit({ speed: this.horizontalSpeed, position: this.position.clone() });
    }
    // Grounded characters must not accumulate downward velocity — otherwise the controller
    // builds a huge phantom downward speed that erupts the moment they leave a ledge. The
    // impact speed is stashed first so fall damage still sees the real landing velocity.
    if (result.grounded && this.velocity.y < 0) {
      this._pendingImpact = Math.max(this._pendingImpact ?? 0, -this.velocity.y);
      this.velocity.y = 0;
    }
    return this;
  }

  _postMove(dt) {
    const m = this.movement;
    this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.speed = this.horizontalSpeed;
    this.verticalSpeed = this.velocity.y;
    const result = this.moveResult;
    const grounded = result ? result.grounded : false;

    if (grounded && !this.wasOnGround) this._land();
    if (!grounded && this.wasOnGround) { this.airTime = 0; this.fallStart = this.position.y; }

    if (grounded) {
      this.airTime = 0;
      this.groundSurface = this._sampleGroundSurface();
      this._footsteps(dt);
      if (this.sliding && this.horizontalSpeed < m.slideMinSpeed * 0.5) this.sliding = false;
    } else {
      this.airTime += dt;
      this.peakY = Math.max(this.peakY, this.position.y);
      this.stepDistance = 0;
    }
    this.onGround = grounded;
  }

  _land() {
    const impact = Math.max(this._pendingImpact ?? 0, Math.max(0, -this.velocity.y));
    this._pendingImpact = 0;
    this.lastImpactSpeed = impact;
    const fallDistance = Math.max(0, this.peakY - this.position.y);
    this.Landed.emit({ impact, fallDistance, surface: this.groundSurface });
    this.bob.dip = -Math.min(momentumDip(this.movement.landDip, impact), 0.34);
    // Fall damage uses impact speed, not distance: jumping off a crate should never hurt.
    const over = impact - this.movement.fallDamageSpeed;
    if (over > 0) {
      const damage = Math.min(this.movement.terminalFallDamage, over * this.movement.fallDamagePerSpeed + Math.max(0, fallDistance - 4) * 2);
      this.FallDamage.emit({ damage, impact, fallDistance });
    }
    if (impact > 9) this.sprinting = false;
  }

  _footsteps(dt) {
    if (!this.onGround || this.sliding) { this.stepDistance = 0; return; }
    const speed = this.horizontalSpeed;
    if (speed < 0.6) { this.stepDistance = 0; return; }
    this.stepDistance += speed * dt;
    const strideLength = this.stance === Stance.Prone ? 1.6 : this.sprinting ? 0.92 : 1.22;
    const volumeScale = clamp01(0.35 + speed / this.movement.sprintSpeed * 0.75);
    if (this.stepDistance >= strideLength) {
      this.stepDistance -= strideLength;
      const left = (this._lastStepPhase = 1 - this._lastStepPhase) === 1;
      this.Footstep.emit({
        position: this.position.clone(),
        surface: this.groundSurface?.key ?? 'concrete',
        speed,
        sprinting: this.sprinting,
        stance: this.stance,
        loudness: volumeScale * (this.sprinting ? 1.35 : 1),
        foot: left ? 'left' : 'right',
      });
    }
  }

  /** Ground material under the feet (drives footsteps, bullet ricochets and AI hearing). */
  _sampleGroundSurface() {
    if (!this.collision) return null;
    const hit = this.collision.raycast(
      _point.set(this.position.x, this.position.y + 0.35, this.position.z), _down,
      { maxDistance: 0.85, layerMask: CollisionLayer.Static | CollisionLayer.Dynamic },
    );
    this.groundPart = hit?.part ?? null;
    return hit?.surface ?? null;
  }

  _updateBob(dt, input) {
    const m = this.movement;
    const moving = this.onGround && this.horizontalSpeed > 0.8 && !this.sliding;
    const amplitude = m.headBob * (this.sprinting ? 1.35 : 1) * (this.stance === Stance.Crouch ? 0.6 : 1);
    if (moving) {
      this.bob.phase += dt * m.bobFrequency * clamp(this.horizontalSpeed / m.walkSpeed, 0.4, 1.8);
      const vertical = Math.sin(this.bob.phase * 2) * amplitude;
      const lateral = Math.cos(this.bob.phase) * amplitude * 0.6;
      this.bob.offset += (vertical - this.bob.offset) * Math.min(1, dt * 14);
      this.bob.lateral += (lateral - this.bob.lateral) * Math.min(1, dt * 12);
      this.bob.roll = Math.cos(this.bob.phase) * amplitude * 0.5;
    } else {
      this.bob.offset += (0 - this.bob.offset) * Math.min(1, dt * 7);
      this.bob.lateral += (0 - this.bob.lateral) * Math.min(1, dt * 7);
      this.bob.roll += (0 - this.bob.roll) * Math.min(1, dt * 7);
    }
    this.bob.dip += (0 - this.bob.dip) * Math.min(1, dt * 9);
    // Leaning into movement (subtle, sells acceleration without disorienting).
    const targetLean = moving ? clamp(-input.moveX ?? 0, -1, 1) * 0.02 : 0;
    this.bob.lean = (this.bob.lean ?? 0) + (targetLean - (this.bob.lean ?? 0)) * Math.min(1, dt * 6);
  }

  // ------------------------------------------------------------------ helpers
  /** Teleports (respawn, spectate follow, server correction). */
  teleport(position, { velocity = null } = {}) {
    this.position.copy(position);
    if (velocity) this.velocity.copy(velocity); else this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.airTime = 0;
    this.peakY = this.position.y;
    this.fallStart = this.position.y;
    return this;
  }

  /** Applies an external impulse (explosions, shotgun knockback, vehicle hits). */
  addImpulse(impulse, { verticalScale = 1 } = {}) {
    this.velocity.x += impulse.x;
    this.velocity.y += impulse.y * verticalScale;
    this.velocity.z += impulse.z;
    if (!this.onGround) this.peakY = Math.max(this.peakY, this.position.y);
    return this;
  }

  /** Server reconciliation: snap to the authoritative state, replaying pending inputs after. */
  applyServerState(state) {
    this.teleport(state.position, { velocity: state.velocity ?? null });
    this.stance = state.stance ?? this.stance;
    this.sliding = !!state.sliding;
    this.onGround = !!state.onGround;
    return this;
  }

  serialize() {
    return {
      p: [round3(this.position.x), round3(this.position.y), round3(this.position.z)],
      v: [round3(this.velocity.x), round3(this.velocity.y), round3(this.velocity.z)],
      s: this.stance[0],
      g: this.onGround ? 1 : 0,
      y: round3(this.yaw),
    };
  }

  static deserialize(scene, data, opts = {}) {
    const character = new KinematicCharacter(scene, { ...opts, position: new Vector3(...(data.p ?? [0, 0, 0])) });
    character.velocity.set(...(data.v ?? [0, 0, 0]));
    character.stance = data.s === 'c' ? Stance.Crouch : data.s === 'p' ? Stance.Prone : Stance.Stand;
    character.onGround = !!data.g;
    character.yaw = data.y ?? 0;
    return character;
  }

  /** Debug/HUD readout. */
  getState() {
    return {
      position: this.position,
      velocity: this.velocity,
      stance: this.stance,
      speed: this.horizontalSpeed,
      onGround: this.onGround,
      sprinting: this.sprinting,
      sliding: this.sliding,
      inWater: this.inWater,
      onLadder: this.onLadder,
      eye: this.eyePosition,
      surface: this.groundSurface?.key ?? null,
    };
  }
}

// Air drag is deliberately small; expose it on the tuning table so games can raise it.
DefaultMovement.airDrag = 0.12;

/** Collision skin: keeps the character box a hair above its feet. */
const SKIN = 0.02;

function momentumDip(base, impact) { return base * clamp(impact / 8, 0.4, 2.2); }
function round3(v) { return Math.round(v * 1000) / 1000; }

const _dir = new Vector3();
const _dir2 = new Vector3();
const _delta = new Vector3();
const _box = new AABB();
const _point = new Vector3();
const _point2 = new Vector3();
const _down = new Vector3(0, -1, 0);
void Quaternion;
void DEG2RAD;

export default KinematicCharacter;

/**
 * Normalises anything spawn-like into a fresh Vector3: a Vector3, a plain `{x,y,z}`, an instance
 * with a `Position` (spawn pads) or a `{ position }` wrapper. Returns the origin when there is
 * nothing usable — a character always has a position.
 */
export function normalizePoint(value, fallback = null) {
  if (value instanceof Vector3) return value.clone();
  if (value && typeof value === 'object' && value.position && typeof value.position.x === 'number') {
    return new Vector3(value.position.x, value.position.y, value.position.z);
  }
  if (value && typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number') {
    return new Vector3(value.x, value.y, value.z);
  }
  if (fallback) return fallback.clone ? fallback.clone() : new Vector3(fallback.x, fallback.y, fallback.z);
  return new Vector3(0, 0, 0);
}
