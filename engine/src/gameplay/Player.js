/**
 * OminX Engine — the player: movement, camera, weapons, feedback and HUD state.
 *
 * `Player` glues the engine's systems into the thing a person actually controls:
 *
 *   movement (KinematicCharacter) → camera (FPS camera with recoil/ADS/bob)
 *   → weapons (fire modes, reload, attachment-modified stats, recoil patterns)
 *   → ballistics (hitscan/projectiles through `BallisticsSystem`)
 *   → feedback (trails, decals, screen shake, hitmarkers, damage numbers, footsteps)
 *   → HUD state (ammo, health, spread-driven crosshair, kill feed, objective markers).
 *
 * Everything is driven from `update(dt, input)`, where `input` is the same shape the network
 * layer serialises, so client prediction, server simulation and replay playback all run this
 * exact code path.
 *
 * @module engine/src/gameplay/Player.js
 */
import { Vector3 } from '../math/Vector3.js';
import { Vector2 } from '../math/Vector2.js';
import { Quaternion } from '../math/Quaternion.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Signal } from '../core/Signal.js';
import { clamp, clamp01, lerp, damp, DEG2RAD, RAD2DEG } from '../math/MathUtils.js';
import { KinematicCharacter, Stance, normalizePoint } from '../physics/KinematicCharacter.js';
import { Health, StatusEffect } from './Health.js';
import { Weapon, WeaponLibrary, WeaponClass, FireMode, GrenadeLibrary, applyAttachments } from './Weapons.js';
import { humanoidHitboxes, DamageType, HitZone } from './Ballistics.js';
import { CollisionLayer } from '../world/Part.js';
import { MeshRenderer } from '../renderer/MeshRenderer.js';
import { RenderLayer } from '../renderer/RenderList.js';
import { WeaponFactory } from '../geometry/WeaponMeshes.js';

/** Where the player is in their life cycle. */
export const PlayerState = {
  Spawning: 'spawning',
  Alive: 'alive',
  Dead: 'dead',
  Spectating: 'spectating',
  Disconnected: 'disconnected',
};

/** Loadout presets used by menus, bots and tests. */
export const LoadoutPresets = {
  assault: { primary: 'rifle', secondary: 'pistol', grenades: { frag: 1, smoke: 1 }, attachments: { rifle: ['reflexSight', 'compensator', 'verticalGrip'], pistol: [] } },
  closeQuarters: { primary: 'smg', secondary: 'machinePistol', grenades: { frag: 2, flash: 1 }, attachments: { smg: ['laserTactical', 'fastMag'], machinePistol: [] } },
  breacher: { primary: 'shotgun', secondary: 'pistol', grenades: { frag: 2, flash: 2 }, attachments: { shotgun: ['breacher', 'fastMag'], pistol: [] } },
  marksman: { primary: 'dmr', secondary: 'pistol', grenades: { frag: 1, smoke: 2 }, attachments: { dmr: ['acog4x', 'muzzleBrake', 'bipod'], pistol: [] } },
  sniper: { primary: 'sniper', secondary: 'pistol', grenades: { frag: 1, smoke: 1 }, attachments: { sniper: ['scope8x', 'heavyStock', 'monolithic'], pistol: [] } },
  support: { primary: 'lmg', secondary: 'pistol', grenades: { frag: 1, smoke: 1 }, attachments: { lmg: ['bipod', 'muzzleBrake', 'heavyStock'], pistol: [] } },
  antiVehicle: { primary: 'launcher', secondary: 'carbine', grenades: { smoke: 2 }, attachments: { carbine: ['reflexSight'] } },
};

/**
 * First-person weapon presentation: positions the weapon mesh in view space, animates it for
 * every action, and reports the muzzle/tracer origins in world space.
 *
 * The engine's view-model shader adds bob/sway/ADS offsets in camera space, so this class owns
 * the model matrix (hip pose) and the ADS correction vector.
 */
export class WeaponViewModel {
  /**
   * @param {object} [opts] { renderer, model (WeaponFactory mesh model), scale }
   */
  constructor(opts = {}) {
    this.renderer = opts.renderer ?? null;
    this.model = null;
    this.mesh = null;
    this.material = null;
    this.scale = opts.scale ?? 1;
    this.visible = true;
    this.hipPosition = new Vector3(0.17, -0.16, -0.34);
    this.hipRotation = new Vector3(-2, -4, 1.5).scale(DEG2RAD);
    this.adsPosition = new Vector3(0, 0, -0.18);
    this.adsRotation = new Vector3(0, 0, 0);
    this.sprintPosition = new Vector3(0.26, -0.24, -0.3);
    this.sprintRotation = new Vector3(-6, -28, 8).scale(DEG2RAD);
    this.sway = new Vector3();
    this.swayVelocity = new Vector3();
    this.swayScale = opts.swayScale ?? 0.016;
    this.swayMax = 0.05;
    this.bobScale = 1;
    this.recoilOffset = new Vector3();
    this.recoilVelocity = new Vector3();
    this.recoilRotation = new Vector3();
    this.recoilRotationVelocity = new Vector3();
    this.animBlend = 0;              // 0 = hip, 1 = ADS
    this.actionState = 'idle';
    this.actionTime = 0;
    this.actionDuration = 0;
    this.actionTarget = null;
    this.matrix = new Matrix4();
    this.worldMatrix = new Matrix4();
    this.lastMouseDelta = new Vector2();
    this.adsCorrection = new Vector2();
    this.sightOffset = new Vector3();
    this._item = null;
    this._inverseView = new Matrix4();
    this._local = new Matrix4();
    this._position = new Vector3();
    this._rotation = new Quaternion();
  }

  /** Binds a weapon definition to a view-model mesh (called on every weapon swap). */
  setWeapon(definition, materials = null) {
    this.definition = definition;
    const kind = definition?.viewModel ?? definition?.worldModel ?? 'rifle';
    const factory = WeaponFactory[kind] ?? WeaponFactory.rifle;
    this.model = factory();
    this.mesh = this.model.merged ?? null;
    this.material = materials ?? null;
    const sight = this.model.anchors?.adsSight ?? this.model.anchors?.sight ?? null;
    this.sightOffset.set(sight?.position?.x ?? 0, sight?.position?.y ?? 0.06, 0);
    // ADS pose: move the mesh so its sight lands on the camera axis.
    this.adsPosition.set(-this.sightOffset.x, -this.sightOffset.y, -0.2);
    this.adsCorrection.set(this.adsPosition.x - this.hipPosition.x, this.adsPosition.y - this.hipPosition.y);
    this.animBlend = 0;
    this.actionState = 'idle';
    return this;
  }

  /** Starts a one-shot animation (reload, inspect, equip, melee, throw). */
  playAction(state, duration, target = null) {
    this.actionState = state;
    this.actionTime = 0;
    this.actionDuration = duration;
    this.actionTarget = target;
    return this;
  }

  /**
   * Advances the view-model pose.
   * @param {number} dt
   * @param {object} ctx { adsBlend, sprinting, grounded, speed, mouseDelta, recoilKick, bob, shake }
   */
  update(dt, ctx = {}) {
    const target = ctx.adsBlend ?? 0;
    this.animBlend = damp(this.animBlend, target, 14, dt);

    // Sway follows the mouse with a spring, so the gun lags behind fast turns.
    const md = ctx.mouseDelta;
    if (md) {
      this.swayVelocity.x += -md.x * this.swayScale * 60 * dt;
      this.swayVelocity.y += md.y * this.swayScale * 60 * dt;
      this.swayVelocity.z += (md.x * 0.35) * this.swayScale * 60 * dt;
    }
    // Spring toward zero.
    const stiffness = 120, damping = 16;
    this.swayVelocity.addScaled(this.sway, -stiffness * dt);
    this.swayVelocity.scale(Math.max(0, 1 - damping * dt));
    this.sway.addScaled(this.swayVelocity, dt);
    this.sway.set(
      clamp(this.sway.x, -this.swayMax, this.swayMax),
      clamp(this.sway.y, -this.swayMax, this.swayMax),
      clamp(this.sway.z, -this.swayMax, this.swayMax),
    );
    this.sway.scale(1 - this.animBlend * 0.75);

    // Recoil kick: impulse from the weapon, decays back to zero.
    if (ctx.recoilKick) {
      this.recoilVelocity.z += ctx.recoilKick.visKick ?? 0.35;
      this.recoilVelocity.y += (ctx.recoilKick.visKick ?? 0.35) * 0.25;
      this.recoilRotationVelocity.x += (ctx.recoilKick.visKick ?? 0.35) * 0.5;
      this.recoilRotationVelocity.z += (ctx.recoilKick.side ?? 0) * 0.35;
    }
    this.recoilVelocity.addScaled(this.recoilOffset, -260 * dt);
    this.recoilVelocity.scale(Math.max(0, 1 - 18 * dt));
    this.recoilOffset.addScaled(this.recoilVelocity, dt);
    this.recoilRotationVelocity.addScaled(this.recoilRotation, -220 * dt);
    this.recoilRotationVelocity.scale(Math.max(0, 1 - 16 * dt));
    this.recoilRotation.addScaled(this.recoilRotationVelocity, dt);

    if (this.actionState !== 'idle') {
      this.actionTime += dt;
      if (this.actionTime >= this.actionDuration) { this.actionState = 'idle'; this.actionTarget = null; }
    }
    return this;
  }

  /** Action-specific pose offsets (position, rotation). */
  _actionPose() {
    if (this.actionState === 'idle') return null;
    const t = this.actionDuration > 0 ? clamp01(this.actionTime / this.actionDuration) : 1;
    const pose = { position: new Vector3(), rotation: new Vector3() };
    switch (this.actionState) {
      case 'reload': {
        // Gun dips, tilts out and the magazine hand comes up.
        const dip = Math.sin(Math.PI * t);
        pose.position.set(0.03 * dip, -0.16 * dip, 0.05 * dip);
        pose.rotation.set(-18 * DEG2RAD * dip, 10 * DEG2RAD * dip, -22 * DEG2RAD * dip);
        const pop = Math.sin(Math.PI * clamp01(t * 3));
        pose.position.y -= 0.02 * pop;
        break;
      }
      case 'equip': {
        const s = 1 - t;
        pose.position.set(0.1 * s, -0.3 * s, 0);
        pose.rotation.set(-30 * DEG2RAD * s, 20 * DEG2RAD * s, 0);
        break;
      }
      case 'holster': {
        pose.position.set(0.06 * t, -0.34 * t, 0);
        pose.rotation.set(-34 * DEG2RAD * t, 24 * DEG2RAD * t, 0);
        break;
      }
      case 'inspect': {
        const spin = Math.sin(Math.PI * t) * 0.6;
        pose.position.set(-0.05 * Math.sin(Math.PI * t), -0.06 * Math.sin(Math.PI * t), 0);
        pose.rotation.set(-12 * DEG2RAD * Math.sin(Math.PI * t), -70 * DEG2RAD * spin, 40 * DEG2RAD * Math.sin(Math.PI * t));
        break;
      }
      case 'melee': {
        const swing = Math.sin(Math.PI * Math.min(1, t * 1.4));
        pose.position.set(-0.08 * swing, -0.1 * swing, -0.05 * swing);
        pose.rotation.set(18 * DEG2RAD * swing, -35 * DEG2RAD * swing, -25 * DEG2RAD * swing);
        break;
      }
      case 'throw': {
        const swing = Math.sin(Math.PI * t);
        pose.position.set(-0.1 * swing, -0.14 * swing, 0);
        pose.rotation.set(-40 * DEG2RAD * swing, 10 * DEG2RAD * swing, 0);
        break;
      }
      default: break;
    }
    return pose;
  }

  /**
   * Builds the view-model matrices for this frame.
   * @param {import('../renderer/Camera.js').Camera} camera
   * @param {object} [ctx] { sprinting, adsBlend }
   */
  updateMatrices(camera, ctx = {}) {
    const vm = camera.viewModel;
    const sprint = ctx.sprinting ? 1 : 0;
    const basePos = _vmPos.copy(this.hipPosition).lerp(this.sprintPosition, sprint * (1 - this.animBlend));
    const baseRot = _vmRot.set(
      lerp(this.hipRotation.x, this.sprintRotation.x, sprint * (1 - this.animBlend)),
      lerp(this.hipRotation.y, this.sprintRotation.y, sprint * (1 - this.animBlend)),
      lerp(this.hipRotation.z, this.sprintRotation.z, sprint * (1 - this.animBlend)),
    );
    const pose = this._actionPose();
    if (pose) { basePos.add(pose.position); baseRot.add(pose.rotation); }
    basePos.add(this.recoilOffset).add(this.sway);

    // Camera-space hip pose. The view-model shader applies bob/sway and blends the ADS
    // correction *inside* the model matrix, so the matrix is: inverse(view) * hipPose.
    this._position.copy(basePos);
    this._local.compose(
      this._position,
      _vmQuat.setFromEuler(baseRot.x + this.recoilRotation.x, baseRot.y + this.recoilRotation.y, baseRot.z + this.recoilRotation.z, 'YXZ'),
      _vmScale.set(this.scale, this.scale, this.scale),
    );
    this.matrix.multiplyMatrices(camera.inverseViewMatrix, this._local);
    camera.viewModel.adsPosition.set(this.adsCorrection.x, this.adsCorrection.y, this.adsPosition.z);
    camera.viewModel.recoilRotation.copy(this.recoilRotation);
    camera.viewModel.bob.set(camera.viewModel.bob.x * this.bobScale, camera.viewModel.bob.y * this.bobScale);
    this._matrixFresh = true;
    return this.matrix;
  }

  /** World-space muzzle position/direction for tracers, flashes and hit registration. */
  getMuzzleWorld(camera, out = new Vector3()) {
    const anchor = this.model?.anchors?.muzzle ?? null;
    const local = anchor?.position ?? _vmAnchor.set(0, 0.02, -0.55);
    _vmAnchor2.copy(local).applyMatrix4(this.matrix);
    return out.copy(_vmAnchor2);
  }

  getShellEjectWorld(camera, out = new Vector3()) {
    const anchor = this.model?.anchors?.ejectionPort ?? null;
    const local = anchor?.position ?? _vmAnchor.set(0.06, 0.02, -0.2);
    return out.copy(local).applyMatrix4(this.matrix);
  }

  /** Adds the weapon to a render list on the view-model layer. */
  submit(renderer, camera, ctx = {}) {
    if (!this.mesh || !this.visible) return null;
    // Matrices are computed once per frame in `Player._updateWeapon` (so traces use the same
    // pose the player sees); only recompute when the caller asks explicitly.
    if (!this._matrixFresh) this.updateMatrices(camera, ctx);
    this._matrixFresh = false;
    if (renderer.renderList) {
      this._item = renderer.addMesh(this.mesh, this.material ?? renderer.materials.resolve('WeaponGunmetal'), this.matrix, {
        layer: RenderLayer.ViewModel,
        castShadow: false,
        name: `viewmodel:${this.definition?.id ?? 'weapon'}`,
      });
      if (this.material) this._item.material = this.material;
    }
    return this._item;
  }
}

/**
 * A player-controlled character.
 *
 * Composition, not inheritance: the player owns a `KinematicCharacter` (movement), a `Health`
 * (survivability), an inventory of `Weapon` instances, and a `WeaponViewModel` (presentation).
 */
export class Player {
  /**
   * @param {import('../world/Scene.js').Scene} scene
   * @param {object} [opts] { id, name, team, renderer, ballistics, input, loadout, camera, isBot }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.id = opts.id ?? `player_${++_playerId}`;
    this.name = opts.name ?? this.id;
    this.displayName = opts.displayName ?? opts.name ?? 'Player';
    this.team = opts.team ?? 'blue';
    this.isBot = opts.isBot ?? false;
    this.isLocal = opts.isLocal ?? true;
    this.renderer = opts.renderer ?? null;
    this.ballistics = opts.ballistics ?? null;
    this.input = opts.input ?? null;
    this.audio = opts.audio ?? null;
    this.hud = opts.hud ?? null;

    // --- movement -----------------------------------------------------------
    this.character = opts.character ?? new KinematicCharacter(scene, {
      position: opts.position ?? new Vector3(0, 0, 0),
      radius: opts.radius ?? 0.35,
      team: this.team,
      ignore: opts.ignore ?? null,
      movement: opts.movement,
    });
    this.character.owner = this;

    // --- camera -------------------------------------------------------------
    this.camera = opts.camera ?? null;
    this.yaw = opts.yaw ?? 0;
    this.pitch = opts.pitch ?? 0;
    this.pitchMin = -Math.PI / 2 + 0.02;
    this.pitchMax = Math.PI / 2 - 0.02;

    // --- survivability ------------------------------------------------------
    this.loadoutGrenades = { frag: 1, smoke: 1 };
    this.health = opts.health ?? new Health({
      maxHealth: opts.maxHealth ?? 100,
      maxArmor: opts.maxArmor ?? 0,
      owner: this,
      team: this.team,
      respawnDelay: opts.respawnDelay ?? 5,
      regenDelay: opts.regenDelay ?? 5.5,
      regenRate: opts.regenRate ?? 14,
    });
    this.state = PlayerState.Spawning;
    this.spawnProtectionTime = opts.spawnProtectionTime ?? 2;

    // --- weapons ------------------------------------------------------------
    /** @type {Weapon[]} */
    this.weapons = [];
    this.weaponSlots = { primary: null, secondary: null, melee: null, launcher: null };
    this.currentSlot = 'primary';
    this.inventory = {};
    this.adsBlend = 0;
    this.adsHeld = false;
    this.adsToggle = false;
    this.switchTimer = 0;
    this.switchDuration = 0;
    this.pendingSlot = null;
    this.lastFireTime = -Infinity;
    this.automaticReload = true;
    this.viewModel = new WeaponViewModel({ renderer: this.renderer, ...(opts.viewModel ?? {}) });

    // --- feedback / stats ---------------------------------------------------
    this.kills = 0;
    this.teamKills = 0;
    /** @type {Map<object, number>} victim → last damage time, used for assist credit. */
    this._damagedRecently = new Map();
    this.deaths = 0;
    this.assists = 0;
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.headshots = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.suppression = 0;
    this.flashIntensity = 0;
    this.flashTimer = 0;
    this.hitmarker = 0;
    this.hitmarkerType = 'normal';
    this.spotting = 0;
    this.lastKillTime = -Infinity;
    this.timeSinceDamage = 99;
    this.deathCamTime = 0;
    this.spectating = null;

    // --- signals ------------------------------------------------------------
    this.Spawned = new Signal('Player.Spawned');
    this.Died = new Signal('Player.Died');
    this.Respawned = new Signal('Player.Respawned');
    this.Fired = new Signal('Player.Fired');
    this.HitConfirmed = new Signal('Player.HitConfirmed');
    this.Damaged = new Signal('Player.Damaged');
    this.Killed = new Signal('Player.Killed');
    /** Fired when this player is awarded a kill on the scoreboard. */
    this.KillCredited = new Signal('Player.KillCredited');
    /** Fired when this player earns an assist. */
    this.Assisted = new Signal('Player.Assisted');
    /** Fired on a team kill (friendly fire). */
    this.TeamKilled = new Signal('Player.TeamKilled');
    /** Fired on multi-kill streaks (every 5 in a row). */
    this.Streak = new Signal('Player.Streak');
    this.WeaponChanged = new Signal('Player.WeaponChanged');
    this.Footstep = new Signal('Player.Footstep');
    this.PickupRequested = new Signal('Player.PickupRequested');

    // --- lifecycle wiring ---------------------------------------------------
    this.health.Damaged.connect((event) => {
      this.damageTaken += event.applied + event.absorbed;
      this.timeSinceDamage = 0;
      this.character.bob.dip -= event.applied * 0.0015;
      this.Damaged.emit({ player: this, ...event });
      if (this.camera) {
        this.camera.addShake(clamp01(event.applied / 40) * 0.5, { frequency: 26 });
        this.camera.damage.vignette = Math.min(1, this.camera.damage.vignette + event.applied / 55);
        this.camera.damage.flash = Math.min(1, (this.camera.damage.flash ?? 0) + event.applied / 40);
        if (event.info?.point) this.camera.addDamageIndicator(this._directionTo(event.info.point), clamp01(event.applied / 30));
      }
      this.audio?.play?.('player_hurt', this.character.position, { volume: clamp01(0.35 + event.applied / 60) });
    });
    this.health.Died.connect((event) => this._die(event));

    this.character.Footstep.connect((step) => {
      this.audio?.playFootstep?.(step);
      this.Footstep.emit(step);
    });
    this.character.Landed.connect((land) => {
      this.audio?.play?.('player_land', this.character.position, { volume: clamp01(land.impact / 14) });
      if (land.impact > 12) this.camera?.addShake(clamp01(land.impact / 26), { frequency: 14 });
    });
    this.character.FallDamage.connect(({ damage }) => {
      this.health.damage({
        amount: damage,
        type: DamageType.Fall,
        hitZone: HitZone.LegLower,
        direction: _spawnJitter.set(0, -1, 0),
        point: this.character.position.clone(),
      });
    });
    this.character.Jumped.connect(() => this.audio?.play?.('player_jump', this.character.position, { volume: 0.35 }));

    if (opts.loadout) this.setLoadout(opts.loadout);
  }

  static create(scene, opts) { return new Player(scene, opts); }

  // ------------------------------------------------------------------ loadout
  /**
   * Gives the player a full loadout.
   * @param {string|object} loadout preset name or `{ primary, secondary, grenades, attachments }`
   */
  setLoadout(loadout) {
    const preset = typeof loadout === 'string' ? LoadoutPresets[loadout] ?? LoadoutPresets.assault : loadout;
    for (const weapon of this.weapons) this.ballistics?.unregisterActor?.(weapon);
    this.weapons.length = 0;
    this.weaponSlots = { primary: null, secondary: null, melee: null, launcher: null };
    if (preset.primary) this.addWeapon(preset.primary, { slot: 'primary', attachments: preset.attachments?.[preset.primary] });
    if (preset.secondary) this.addWeapon(preset.secondary, { slot: 'secondary', attachments: preset.attachments?.[preset.secondary] });
    if (preset.melee !== null) this.addWeapon(preset.melee ?? 'knife', { slot: 'melee' });
    this.grenades = { ...(preset.grenades ?? { frag: 1, smoke: 1 }) };
    this.loadoutGrenades = { ...this.grenades };
    this.currentSlot = this.weaponSlots.primary ? 'primary' : this.weaponSlots.secondary ? 'secondary' : 'melee';
    if (this.weaponSlots[this.currentSlot]) this._equipSlot(this.currentSlot, { instant: true });
    return this;
  }

  /** Adds a weapon to a slot (creating the run-time state or the definition by id). */
  addWeapon(weaponOrId, { slot = null, attachments = [], ammoInMagazine = null, reserve = null } = {}) {
    let weapon = weaponOrId;
    if (typeof weaponOrId === 'string') {
      const def = WeaponLibrary[weaponOrId]?.();
      if (!def) throw new Error(`Player.addWeapon: unknown weapon "${weaponOrId}"`);
      weapon = new Weapon(attachments.length ? applyAttachments(def, attachments) : def, { owner: this });
    }
    if (ammoInMagazine !== null) weapon.ammo = ammoInMagazine;
    if (reserve !== null) weapon.reserve = reserve;
    weapon.owner = this;
    const targetSlot = slot ?? (weapon.class === WeaponClass.Melee ? 'melee' : weapon.class === WeaponClass.Launcher && weapon.definition.magazineSize <= 1 ? 'launcher' : null);
    if (targetSlot && this.weaponSlots[targetSlot]) this.weapons.splice(this.weapons.indexOf(this.weaponSlots[targetSlot]), 1);
    this.weapons.push(weapon);
    if (targetSlot) this.weaponSlots[targetSlot] = weapon;
    // Ammo pools are shared per ammo type (light/medium/heavy/shell/sniper/rocket).
    this.inventory[weapon.definition.ammoType] = Math.max(this.inventory[weapon.definition.ammoType] ?? 0, weapon.reserve);
    return weapon;
  }

  /** The weapon currently held. */
  get weapon() { return this.weaponSlots[this.currentSlot] ?? this.weapons[0] ?? null; }
  get isAiming() { return this.adsBlend > 0.5; }
  get isReloading() { return !!this.weapon?.reloading; }
  get alive() { return this.state === PlayerState.Alive; }

  // --- actor contract -------------------------------------------------------
  // `BallisticsSystem` registers any object exposing a world position, orientation and team, so
  // players, bots and non-player actors (turrets, vehicles) all resolve hits the same way. These
  // accessors make `Player` obey that contract without needing a scene node.
  get dead() { return this.health?.dead ?? this.state === PlayerState.Dead; }
  get position() { return this.character?.position ?? _actorPos; }
  get velocity() { return this.character?.velocity ?? _actorVel; }
  get eyeHeight() { return this.character?.eyeHeight ?? 1.62; }
  get rotationQuaternion() {
    _actorQuat.setFromEuler(0, this.yaw + (this.character?.visualYawOffset ?? 0), 0, 'YXZ');
    return _actorQuat;
  }
  /** Collision layer used by bullet traces (players are dynamic by default). */
  get layer() { return CollisionLayer.Dynamic; }

  _equipSlot(slot, { instant = false } = {}) {
    const weapon = this.weaponSlots[slot];
    if (!weapon) return false;
    const previous = this.weapon;
    if (previous && previous !== weapon) {
      this._holster(previous, instant);
    }
    this.currentSlot = slot;
    this.switchDuration = instant ? 0 : (weapon.definition.equipTime ?? 0.5);
    this.switchTimer = this.switchDuration;
    this.adsBlend = 0;
    this.viewModel.setWeapon(weapon.definition, this.viewModel.material);
    if (!instant) this.viewModel.playAction('equip', weapon.definition.equipTime ?? 0.5);
    this.audio?.play?.(weapon.definition.audio.equip, this.character.position, { volume: 0.6 });
    this.WeaponChanged.emit({ player: this, weapon, previous, slot });
    return true;
  }

  _holster(weapon, instant = false) {
    if (instant) return;
    weapon.cancelReload();
    weapon.burstRemaining = 0;
  }

  /** Switches to the next/previous weapon (Q / mouse wheel). */
  cycleWeapon(direction = 1) {
    const slots = Object.keys(this.weaponSlots).filter((s) => this.weaponSlots[s]);
    if (slots.length < 2) return false;
    const index = slots.indexOf(this.currentSlot);
    const next = slots[(index + direction + slots.length) % slots.length];
    return this._equipSlot(next);
  }

  // ------------------------------------------------------------------ input → action
  /**
   * The single entry point: takes input for this frame and advances everything.
   * @param {number} dt
   * @param {object} [input] { moveX, moveY, jump, crouch, sprint, walk, prone, fire, aim, reload,
   *                           melee, grenade, interact, switchTo, cycle, lookYaw, lookPitch, look }
   */
  update(dt, input = {}) {
    this.timeSinceDamage += dt;
    this.hitmarker = Math.max(0, this.hitmarker - dt * 2.6);
    this.suppression = Math.max(0, this.suppression - dt * 0.8);
    this.health.update(dt);

    // Flash blindness decays and blocks vision while active.
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      this.flashIntensity = clamp01(this.flashTimer > 0 ? this.flashIntensity : 0);
      if (this.flashTimer <= 0) this.flashIntensity = 0;
    }
    if (this.camera && this.state === PlayerState.Alive) {
      this.camera.damage.flash = Math.max(this.camera.damage.flash, this.flashIntensity * 0.9);
      this.camera.damage.vignette = Math.max(this.camera.damage.vignette, this.flashIntensity * 0.4);
    }

    if (this.state === PlayerState.Dead) {
      this.deathCamTime += dt;
      this.camera?.updateDeathCam?.(dt);
      this.health.update(0);
      return this;
    }
    if (this.state === PlayerState.Spectating) {
      this._updateSpectating(dt);
      return this;
    }

    this._updateLook(dt, input);
    this._updateMovement(dt, input);
    this._updateWeapon(dt, input);
    this._updateCamera(dt, input);
    this._updatePickups(dt, input);
    return this;
  }

  _updateLook(dt, input) {
    let yawDelta = 0;
    let pitchDelta = 0;
    if (input.look) { yawDelta += input.look.yaw ?? 0; pitchDelta += input.look.pitch ?? 0; }
    if (input.lookYaw !== undefined) yawDelta += input.lookYaw;
    if (input.lookPitch !== undefined) pitchDelta += input.lookPitch;
    this.lastLookDelta = { yaw: yawDelta, pitch: pitchDelta };
    this.yaw += yawDelta;
    this.pitch = clamp(this.pitch + pitchDelta, this.pitchMin, this.pitchMax);
    // Yaw wraps so it never grows unbounded (matters for network quantisation).
    this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.character.yaw = this.yaw;
  }

  _updateMovement(dt, input) {
    const aiming = this.adsBlend > 0.5;
    const movementInput = {
      moveX: input.moveX ?? 0,
      moveY: input.moveY ?? 0,
      jump: !!input.jump,
      crouch: !!input.crouch,
      prone: !!input.prone,
      sprint: !!input.sprint && !aiming && !this.isReloading,
      walk: !!input.walk,
    };
    // Weapon weight slows you down; ADS slows you further; a broken leg slows you most.
    const weapon = this.weapon;
    const scale = (weapon?.definition.moveSpeedScale ?? 1) * (aiming ? 0.55 : 1) * (this.health.hasEffect(StatusEffect.Slowed) ? 0.6 : 1);
    this.baseSpeeds ??= { walk: this.character.movement.walkSpeed, sprint: this.character.movement.sprintSpeed, crouch: this.character.movement.crouchSpeed };
    this.character.movement.walkSpeed = this.baseSpeeds.walk * scale;
    this.character.movement.sprintSpeed = this.baseSpeeds.sprint * scale;
    this.character.movement.crouchSpeed = this.baseSpeeds.crouch * scale;
    this.character.update(dt, movementInput);
  }

  _updateWeapon(dt, input) {
    const weapon = this.weapon;
    if (!weapon) return;
    const character = this.character;

    // Weapon switch timer blocks firing/ADS/melee.
    if (this.switchTimer > 0) {
      this.switchTimer = Math.max(0, this.switchTimer - dt);
      if (this.switchTimer === 0 && this.pendingSlot) {
        const slot = this.pendingSlot;
        this.pendingSlot = null;
        this._equipSlot(slot);
      }
    }
    const switching = this.switchTimer > 0;

    // ---- ADS ----
    const wantsAds = (input.aim ?? this.adsHeld) && !switching && weapon.definition.adsAllowed && !weapon.reloading && !character.sprinting;
    const adsSpeed = 1 / Math.max(0.05, weapon.definition.adsTime);
    this.adsBlend = damp(this.adsBlend, wantsAds ? 1 : 0, adsSpeed * 2.4, dt);
    weapon.adsBlend = this.adsBlend;
    this.camera?.setAds(this.adsBlend);
    if (this.camera) {
      this.camera.adsFovScale = 1 / Math.max(1, weapon.definition.adsZoom * this.adsBlend + (1 - this.adsBlend));
      this.camera.viewModel.fov = this.camera.viewModel.fov ?? 60;
    }
    // Sprinting or firing cancels a reload early (inside the cancel window).
    if ((character.sprinting || (input.reload && weapon.ammo > 0)) && weapon.reloading) weapon.cancelReload();

    // ---- fire ----
    weapon.triggerHeld = !!input.fire;
    const canFire = !switching && this.alive;
    const ctx = {
      ads: this.adsBlend > 0.5,
      onGround: character.onGround,
      speed: character.horizontalSpeed,
      stance: character.stance,
      sprinting: character.sprinting,
      now: this.scene.time,
    };
    weapon.update(dt, ctx);

    if (canFire && input.fire && !character.sprinting) {
      this.fireWeapon(ctx);
    }
    if (!input.fire) {
      weapon.triggerReady = true;
      weapon.burstRemaining = 0;
    }

    // ---- reload ----
    if (input.reload && !weapon.reloading && weapon.ammo < weapon.definition.magazineSize) {
      if (weapon.startReload() && this.viewModel.actionState !== 'reload') {
        this.viewModel.playAction('reload', weapon.reloadDuration);
      }
    }
    // Auto-reload when the magazine runs dry.
    if (this.automaticReload && weapon.magazineEmpty && !weapon.reloading && !switching) {
      if (weapon.startReload()) this.viewModel.playAction('reload', weapon.reloadDuration, 'auto');
    }
    if (weapon.reloading && this.viewModel.actionState !== 'reload') {
      this.viewModel.playAction('reload', Math.max(0.1, weapon.reloadDuration - weapon.reloadTimer));
    }

    // ---- grenades ----
    if (input.grenade) {
      this.throwGrenade(input.grenadeType ?? this.selectedGrenade);
    }
    // ---- melee ----
    if (input.melee) this.melee();

    // ---- weapon switching ----
    if (input.switchTo && this.weaponSlots[input.switchTo]) this._equipSlot(input.switchTo);
    if (input.cycle) this.cycleWeapon(input.cycle);
    if (input.fireModes) weapon.toggleFireMode();

    // ---- view model ----
    const vmCtx = {
      adsBlend: this.adsBlend,
      sprinting: character.sprinting,
      grounded: character.onGround,
      speed: character.horizontalSpeed,
      mouseDelta: this.lastLookDelta,
    };
    this.viewModel.update(dt, vmCtx);
    if (this.camera) {
      // Sway/bob are applied by the shader in camera space.
      this.camera.viewModel.sway.copy(this.viewModel.sway);
      this.camera.viewModel.recoilOffset.copy(this.viewModel.recoilOffset);
      // Build the world-space view-model matrix now so traces/effects use this frame's pose.
      this.viewModel.updateMatrices(this.camera, vmCtx);
    }
  }

  // ------------------------------------------------------------------ combat
  /** Aim direction including spread applied by ballistics. */
  getAimDirection(out = new Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp).normalize();
  }

  getEyePosition(out = new Vector3()) {
    return out.copy(this.character.eyePosition);
  }

  _getMuzzlePosition(out = null) {
    const target = out ?? _muzzlePos;
    // The muzzle is where the *view model* is, so traces start at the gun, not the eye.
    if (this.viewModel.model && this.camera) this.viewModel.getMuzzleWorld(this.camera, target);
    else target.copy(this.character.eyePosition);
    return target;
  }

  /**
   * Fires the current weapon: builds shots from the muzzle with the crosshair as the aim target
   * (so the gun barrel converging on the crosshair reads correctly), then resolves ballistics.
   * @param {object} [ctx] { targetPoint }
   */
  fireWeapon(ctx = {}) {
    const weapon = this.weapon;
    if (!weapon) return null;
    const muzzle = this._getMuzzlePosition();
    const eye = this.character.eyePosition;
    // Crosshair convergence: the barrel points at whatever the crosshair covers, not at
    // infinity — this is what makes the view model's muzzle line up with your aim.
    const convergence = ctx.targetPoint ?? this.getCrosshairWorldPoint(Math.max(30, weapon.definition.range * 0.5));
    const muzzleToTarget = _conv.copy(convergence).sub(muzzle);
    if (muzzleToTarget.sqrMagnitude < 1e-8) muzzleToTarget.copy(this.getAimDirection());
    muzzleToTarget.normalize();

    const fired = weapon.tryFire({
      ...ctx,
      origin: muzzle,
      direction: muzzleToTarget,
      // ADS tightens spread on top of the weapon's own profile.
      spreadOverride: weapon.spread * (this.adsBlend > 0.5 ? 0.35 : 1),
      pelletOffset: this._pelletSeed = ((this._pelletSeed ?? 0.37) + 2.399) % (Math.PI * 2),
    });
    if (!fired) return null;

    const results = [];
    if (this.ballistics) {
      for (const shot of fired.shots) {
        results.push(this.ballistics.fireShot(shot, {
          attacker: this,
          team: this.team,
          weapon,
          ads: this.adsBlend > 0.5,
          ignore: [this],
        }));
      }
    }
    this.shotsFired += fired.shots.length;
    this.applyRecoil(fired.recoil);
    this._weaponFeedback(weapon, results, { muzzle, direction: muzzleToTarget, eye });
    this.Fired.emit({ player: this, weapon, fired, results, muzzle });
    return results;
  }

  /** Applies recoil to the camera (view kick) and the weapon pattern (aim punch). */
  applyRecoil(recoilEntry) {
    if (!this.camera) return;
    const weapon = this.weapon;
    const adsScale = weapon?.definition.recoil.adsScale ?? 0.6;
    const scale = lerp(1, adsScale, this.adsBlend);
    const up = (recoilEntry?.up ?? 0.5) * scale;
    const side = (recoilEntry?.side ?? 0) * scale;
    // Recoil pushes the *view* up; the player must compensate, exactly like a real spray pattern.
    this.pitch = clamp(this.pitch + up * 0.012, this.pitchMin, this.pitchMax);
    this.yaw += side * 0.012;
    this.camera.addRecoil(up * 0.03, side * 0.03);
    this.camera.addShake((recoilEntry?.up ?? 0.5) * 0.05, { frequency: 30 });
    this.viewModel.recoilVelocity.z += (recoilEntry?.up ?? 0.5) * 0.5;
    this.camera.addFovPunch(-(recoilEntry?.up ?? 0.5) * 0.35);
  }

  /** Spawns tracers, flash, shells, decals and sounds for a fired shot. */
  _weaponFeedback(weapon, results, { muzzle, direction, eye }) {
    const def = weapon.definition;
    this.audio?.playWeaponFire?.(weapon, muzzle, this.isLocal);
    if (this.renderer) {
      const intensity = (def.muzzleFlashScale ?? 1) * (this.adsBlend > 0.6 ? 0.6 : 1);
      this.renderer.flashMuzzle(muzzle, intensity, def.muzzleFlashColor ?? null);
      if (def.shellEject && this.camera) {
        const port = this.viewModel.getShellEjectWorld(this.camera, _shellPos);
        _shellDir.set(1, 0.65, 0).applyQuaternion(_yawQuat.setFromEuler(0, this.yaw, 0, 'YXZ'));
        this.renderer.particles?.emit?.('shellEject', port, { direction: _shellDir, scale: 0.7 });
      }
    }
    this.lastFireTime = this.scene.time;
    // Hit feedback: hitmarker + damage numbers for the local player.
    for (const result of results) {
      if (!result?.actorHit) continue;
      this.shotsHit++;
      const zone = result.actorHit.box?.zone;
      const headshot = zone === HitZone.Head;
      if (headshot) this.headshots++;
      this.damageDealt += result.damage;
      this.hitmarker = 1;
      this.hitmarkerType = result.actorHit.killed ? 'kill' : headshot ? 'headshot' : 'normal';
      this.audio?.play?.(headshot ? 'hitmarker_headshot' : 'hitmarker', eye, { volume: 0.5 });
      this.HitConfirmed.emit({ player: this, target: result.actorHit.actor, zone, damage: result.damage, killed: result.actorHit.killed, headshot });
      if (result.actorHit.actor === this) continue;
      // Blood/metal impact feedback happens in ballistics; here we add the floating number.
      if (this.hud && this.camera && result.actorHit.point) {
        this.hud.addDamageNumber?.(result.actorHit.point, Math.round(result.damage), { crit: headshot, killed: !!result.actorHit.killed });
      }
    }
    void direction;
  }

  /** Point in the world under the crosshair (used for weapon convergence and interaction). */
  getCrosshairWorldPoint(distance = 60, out = new Vector3()) {
    const origin = this.character.eyePosition;
    const direction = this.getAimDirection();
    if (this.scene?.collision) {
      const hit = this.scene.collision.raycast(origin, direction, {
        maxDistance: distance,
        layerMask: CollisionLayer.All & ~CollisionLayer.Trigger,
        ignore: [this],
        triggers: false,
      });
      if (hit) return out.copy(hit.point);
    }
    return out.copy(origin).addScaled(direction, distance);
  }

  /** Melee attack: arc test in front of the player, with backstab bonus. */
  melee() {
    const weapon = this.weaponSlots.melee ?? this.weapon;
    if (!weapon || !this.ballistics) return null;
    const def = weapon.definition;
    if (weapon.fireTimer > 0 || this.switchTimer > 0) return null;
    weapon.fireTimer = def.cycleTime;
    this.viewModel.playAction('melee', Math.min(0.42, def.cycleTime));
    this.audio?.play?.(def.audio.fire, this.character.position, { volume: 0.5 });
    const origin = this.character.eyePosition;
    const direction = this.getAimDirection();
    const range = def.meleeRange ?? 2.1;
    const cosArc = Math.cos(def.meleeArc ?? 0.7);
    let hitAny = null;
    for (const [actor] of this.ballistics.actors) {
      if (actor === this || actor.dead) continue;
      const toActor = _conv.copy(actor.position).setY(actor.position.y + 0.9).sub(origin);
      const distance = toActor.magnitude;
      if (distance > range + 0.5) continue;
      toActor.scale(1 / Math.max(1e-5, distance));
      if (toActor.dot(direction) < cosArc) continue;
      const backstab = actor.getForward ? actor.getForward().dot(direction) > 0.5 : false;
      const damage = backstab ? (def.backstabDamage ?? def.damage * 3) : def.damage;
      const info = {
        amount: damage,
        type: DamageType.Melee,
        attacker: this,
        weapon,
        hitZone: HitZone.Torso,
        point: actor.position.clone(),
        direction: direction.clone(),
        distance,
        headshot: false,
        crit: backstab,
      };
      this.ballistics.applyDamage(actor, info);
      hitAny = { actor, damage, backstab };
      this.hitmarker = 1;
      this.hitmarkerType = backstab ? 'kill' : 'normal';
      this.HitConfirmed.emit({ player: this, target: actor, zone: 'torso', damage, killed: false, backstab });
    }
    return hitAny;
  }

  /** Throws a grenade from the current stock. */
  throwGrenade(kind = null) {
    const type = kind ?? this.selectedGrenade ?? Object.keys(this.grenades ?? {})[0];
    if (!type || !(this.grenades?.[type] > 0)) return null;
    const def = GrenadeLibrary[type];
    if (!def) return null;
    this.grenades[type]--;
    const origin = this.character.eyePosition.clone();
    origin.addScaled(this.getAimDirection(), 0.35);
    const direction = this.getAimDirection().clone();
    // Over-hand throw arc: a fixed up-lift that the player aims with pitch.
    direction.y += 0.28;
    direction.normalize();
    this.viewModel.playAction('throw', 0.45);
    this.audio?.play?.('grenade_throw', this.character.position, { volume: 0.5 });
    const projectile = this.ballistics?.throwGrenade(def, origin, direction, {
      owner: this,
      team: this.team,
      speed: 17,
      ignore: [this],
    }) ?? null;
    return projectile;
  }

  // ------------------------------------------------------------------ damage
  /** Ballistics calls this: routes damage into the health model and handles feedback. */
  applyDamage(info) {
    if (info?.attacker && info.attacker !== this && info.attacker._damagedRecently) {
      info.attacker._damagedRecently.set(this, this.scene.time);
    }
    const result = this.health.damage(info);
    if (result.killed) {
      this.Killed.emit({ player: this, info });
      this.ballistics?.registerKill?.({
        killer: info.attacker,
        victim: this,
        weapon: info.weapon,
        info,
        headshot: !!info.headshot,
        distance: info.distance ?? 0,
        wallbang: (info.penetrated ?? 0) > 0,
        melee: info.type === DamageType.Melee,
        explosion: info.type === DamageType.Explosion,
      });
    }
    return result;
  }

  applyKnockback(direction, amount) {
    this.character.addImpulse(_conv.copy(direction).scale(amount), { verticalScale: 0.5 });
    this.camera?.addShake(clamp01(amount / 6), { frequency: 18 });
    return this;
  }

  shakeCamera(amount, preset = 'explosion') {
    this.camera?.addShake(amount, preset);
    return this;
  }

  /** Flashbang effect: blinds the screen and disables ADS briefly. */
  applyFlash(intensity, duration) {
    this.flashIntensity = Math.max(this.flashIntensity, clamp01(intensity));
    this.flashTimer = Math.max(this.flashTimer, duration * clamp01(intensity));
    this.viewModel.playAction('inspect', duration * 0.5);
    return this;
  }

  getForward(out = new Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /** Direction from the player to a world point (used by damage indicators). */
  _directionTo(point, out = new Vector3()) {
    return out.copy(point).sub(this.character.eyePosition).normalize();
  }

  /** Applies damage from a source direction without a weapon (falling debris, script). */
  applyRawDamage(amount, { type = DamageType.Environment, attacker = null, point = null, direction = null } = {}) {
    return this.applyDamage({
      amount,
      type,
      attacker,
      weapon: null,
      hitZone: HitZone.Torso,
      point: point ?? this.character.position.clone(),
      direction: direction ?? _conv.set(0, -1, 0),
      distance: 0,
      knockback: 0,
    });
  }

  _die(event) {
    this.state = PlayerState.Dead;
    this.deaths++;
    this.streak = 0;
    this.deathCamTime = 0;
    this.viewModel.visible = false;
    this.character.enabled = false;
    this.adsBlend = 0;
    this.audio?.play?.('player_death', this.character.position, { volume: 0.8 });
    // Drop the primary so the world reacts to the death.
    const killer = this.health.deadInfo?.killer ?? null;
    if (this.camera && killer?.character) this.camera.startDeathCam(killer.character.position, this.character.position);
    this.Died.emit({ player: this, info: event.info, killer, deadInfo: this.health.deadInfo });
  }

  // ------------------------------------------------------------------ lifecycle
  /**
   * Spawns (or respawns) the player at a spawn point.
   * @param {object|Vector3} spawn point object (`SpawnPart`) or a position
   */
  spawn(spawn) {
    // Accepts a SpawnPart, a bare point, or `{ position, yaw }` (how the match session calls it).
    const wrapper = spawn && spawn.position && typeof spawn.position.x === 'number' ? spawn : null;
    const source = wrapper ? wrapper.position : spawn;
    const position = source?.getSpawnPoint ? source.getSpawnPoint() : normalizePoint(source ?? new Vector3(0, 0.2, 0), new Vector3(0, 0.2, 0));
    this.character.enabled = true;
    this.character.teleport(position.clone().add(_spawnJitter.set(0, 0.05, 0)));
    if (source?.facing) this.yaw = Math.atan2(-source.facing.x, -source.facing.z);
    else if (wrapper && typeof wrapper.yaw === 'number') this.yaw = wrapper.yaw;
    this.pitch = 0;
    this.health.revive({ health: this.health.maxHealth, armor: this.health.maxArmor, spawnProtection: this.spawnProtectionTime });
    this.state = PlayerState.Alive;
    this.viewModel.visible = true;
    this.adsBlend = 0;
    this.switchTimer = 0;
    this.camera?.stopDeathCam?.();
    // Refill magazines and grenades on respawn.
    for (const weapon of this.weapons) {
      weapon.ammo = weapon.definition.magazineSize;
      weapon.reserve = Math.max(weapon.reserve, Math.ceil(weapon.definition.reserveAmmo * 0.5));
      weapon.reloading = false;
    }
    this.grenades = { ...(this.loadoutGrenades ?? { frag: 1, smoke: 1 }) };
    if (this.weaponSlots[this.currentSlot]) this._equipSlot(this.currentSlot, { instant: true });
    this.Spawned.emit({ player: this, position: this.character.position });
    this.Respawned.emit({ player: this, position: this.character.position });
    return this;
  }

  /** Starts spectating another player (kill cam / death spectate). */
  spectate(target) {
    this.spectating = target;
    this.state = PlayerState.Spectating;
    this.character.enabled = false;
    return this;
  }

  _updateSpectating(dt) {
    const target = this.spectating;
    if (!target?.character) return;
    this.character.position.copy(target.character.eyePosition);
    if (this.camera) {
      this.camera.position.copy(target.character.eyePosition);
      this.camera.rotation.copy(target.camera?.rotation ?? _yawQuat.setFromEuler(0, target.yaw, 0, 'YXZ'));
    }
    void dt;
  }

  _updateCamera(dt, input) {
    if (!this.camera) return;
    const character = this.character;
    this.camera.position.copy(character.eyePosition);
    this.camera.rotation.setFromEuler(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.update(dt, {
      strafeInput: input.moveX ?? 0,
      moveSpeed: character.horizontalSpeed,
      sprinting: character.sprinting,
      grounded: character.onGround,
      health01: this.health.healthFraction,
    });
  }

  _updatePickups(dt, input) {
    if (!input.interact) return;
    const origin = this.character.eyePosition;
    const hit = this.scene?.collision?.raycast(origin, this.getAimDirection(), {
      maxDistance: 3.2,
      layerMask: CollisionLayer.All & ~CollisionLayer.Trigger,
      ignore: [this],
      triggers: false,
    });
    if (!hit?.part) return;
    const part = hit.part;
    if (part.hasTag?.('pickup') || part.HasTag?.('pickup')) this.PickupRequested.emit({ player: this, part });
  }

  // ------------------------------------------------------------------ HUD
  /** Everything the HUD needs, in one plain object (netcode-friendly, no engine types). */
  getHudState() {
    const weapon = this.weapon;
    const ammo = weapon ? weapon.getAmmoState() : null;
    const def = weapon?.definition;
    // Crosshair radius in pixels from the current spread + FOV (the classic conversion).
    const fovRad = ((this.camera?.fov ?? 75) * DEG2RAD);
    const screenHeight = this.camera?.viewport?.height ?? 1080;
    const spreadRadians = weapon ? Math.max(weapon.spread, def?.baseSpread ?? 0.01) : 0;
    const crosshairRadius = Math.tan(spreadRadians) / Math.tan(fovRad / 2) * screenHeight * 0.5;
    return {
      health: this.health.health,
      maxHealth: this.health.maxHealth,
      healthFraction: this.health.healthFraction,
      armor: this.health.armor,
      maxArmor: this.health.maxArmor,
      alive: this.alive,
      state: this.state,
      respawnTimer: this.health.respawnTimer,
      weapon: def ? { id: def.id, name: def.name, class: def.class, fireMode: weapon.selectedFireMode, attachments: weapon.attachments } : null,
      ammo,
      grenades: { ...(this.grenades ?? {}) },
      adsBlend: this.adsBlend,
      adsZoom: def?.adsZoom ?? 1,
      scoped: this.adsBlend > 0.8 && !!def?.scopeOverlay,
      spread: weapon?.spread ?? 0,
      crosshairRadius: Math.max(2, crosshairRadius * (1 - this.adsBlend * 0.8)),
      hitmarker: this.hitmarker,
      hitmarkerType: this.hitmarkerType,
      suppression: this.suppression,
      flashIntensity: this.flashIntensity,
      healthFlash: this.health.hitFlash,
      damageDirection: this.health.lastDamageDirection,
      lastAttacker: this.health.lastAttacker?.displayName ?? null,
      streak: this.streak,
      kills: this.kills,
      deaths: this.deaths,
      score: this.score,
      reloading: !!weapon?.reloading,
      reloadProgress: weapon?.reloadProgress ?? 0,
      speed: this.character.horizontalSpeed,
      stance: this.character.stance,
      position: this.character.position,
      team: this.team,
      name: this.displayName,
      objectives: this.scene?.objectives ?? null,
    };
  }

  serialize() {
    return {
      id: this.id,
      name: this.displayName,
      team: this.team,
      state: this.state,
      p: [round3(this.character.position.x), round3(this.character.position.y), round3(this.character.position.z)],
      v: [round3(this.character.velocity.x), round3(this.character.velocity.y), round3(this.character.velocity.z)],
      yaw: round4(this.yaw),
      pitch: round4(this.pitch),
      health: this.health.serialize(),
      weapon: this.weapon?.serialize() ?? null,
      slot: this.currentSlot,
      ads: round3(this.adsBlend),
      stance: this.character.stance[0],
      grounded: this.character.onGround ? 1 : 0,
      stats: { k: this.kills, d: this.deaths, a: this.assists, s: this.score, streak: this.streak },
      bot: this.isBot ? 1 : 0,
    };
  }

  applyServerState(snapshot, { smooth = true } = {}) {
    const position = _serverPos.set(...(snapshot.p ?? [0, 0, 0]));
    const velocity = _serverVel.set(...(snapshot.v ?? [0, 0, 0]));
    const delta = position.distanceTo(this.character.position);
    // Small corrections are smoothed (no rubber-banding for a few centimetres of drift).
    if (smooth && delta < 1.2) {
      this.character.position.lerp(position, 0.35);
      this.character.velocity.lerp(velocity, 0.5);
    } else {
      this.character.teleport(position, { velocity });
    }
    this.yaw = snapshot.yaw ?? this.yaw;
    this.pitch = snapshot.pitch ?? this.pitch;
    this.health.health = snapshot.health?.h ?? this.health.health;
    this.health.armor = snapshot.health?.a ?? this.health.armor;
    if (snapshot.health?.d && this.state !== PlayerState.Dead) this.health.die({ type: 'replicated' });
    return this;
  }

  /** Adds the weapon mesh to the renderer's view-model layer. */
  submitViewModel(renderer, camera) {
    if (!this.alive || this.flashIntensity > 0.85) return null;
    return this.viewModel.submit(renderer, camera, {
      sprinting: this.character.sprinting,
      adsBlend: this.adsBlend,
    });
  }

  /** Health/armour/hitbox registration helper for the ballistics system. */
  registerWith(ballistics) {
    this.ballistics = ballistics;
    ballistics.registerActor(this, humanoidHitboxes(this, { scale: this.hitboxScale ?? 1, armour: this.armourValue ?? 0 }));
    // Scoreboard wiring: the ballistics system owns the kill feed, the player owns the stats.
    this._killConnection ??= ballistics.Kill.connect((entry) => {
      if (entry.killer === this && entry.victim !== this) this.registerKill(entry);
      else if (entry.victim === this) this._creditAssists(entry);
      else if (this._damagedRecently.has(entry.victim) && this.scene.time - (this._damagedRecently.get(entry.victim) ?? 0) < 8) {
        this.assists++;
        this.score += 25;
        this.Assisted.emit({ player: this, entry });
      }
    });
    return this;
  }

  /** Credits a kill to this player (called from the ballistics kill feed). */
  registerKill(entry = {}) {
    if (entry.teamKill) {
      this.teamKills = (this.teamKills ?? 0) + 1;
      this.score -= 50;
      this.streak = 0;
      this.TeamKilled.emit({ player: this, entry });
      return entry;
    }
    this.kills++;
    this.streak++;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.score += entry.headshot ? 150 : 100;
    if (entry.killer === this && entry.victim?.displayName) this.lastVictim = entry.victim.displayName;
    this.KillCredited.emit({ player: this, entry });
    if (this.streak > 0 && this.streak % 5 === 0) this.Streak.emit({ player: this, streak: this.streak });
    return entry;
  }

  _creditAssists(entry) {
    void entry;
    for (const [victim, time] of this._damagedRecently) {
      if (this.scene.time - time > 8) this._damagedRecently.delete(victim);
    }
  }

  getStats() {
    return {
      kills: this.kills,
      deaths: this.deaths,
      assists: this.assists,
      score: this.score,
      streak: this.streak,
      bestStreak: this.bestStreak,
      accuracy: this.shotsFired ? this.shotsHit / this.shotsFired : 0,
      headshots: this.headshots,
      damageDealt: Math.round(this.damageDealt),
      damageTaken: Math.round(this.damageTaken),
    };
  }
}

let _playerId = 0;
const _actorPos = new Vector3();
const _actorVel = new Vector3();
const _actorQuat = new Quaternion();
const _vmPos = new Vector3();
const _vmRot = new Vector3();
const _vmQuat = new Quaternion();
const _vmScale = new Vector3(1, 1, 1);
const _vmAnchor = new Vector3();
const _vmAnchor2 = new Vector3();
const _muzzlePos = new Vector3();
const _shellPos = new Vector3();
const _shellDir = new Vector3();
const _conv = new Vector3();
const _spawnJitter = new Vector3();
const _serverPos = new Vector3();
const _serverVel = new Vector3();
const _yawQuat = new Quaternion();
function round3(v) { return Math.round(v * 1000) / 1000; }
function round4(v) { return Math.round(v * 10000) / 10000; }
void Vector2;
void MeshRenderer;
void StatusEffect;
void FireMode;
void RAD2DEG;

export default Player;
