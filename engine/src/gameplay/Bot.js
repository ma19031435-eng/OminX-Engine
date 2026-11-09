/**
 * OminX Engine — combat AI.
 *
 * A bot is a `Player` (same movement, weapons, ballistics and hit registration) driven by a
 * behaviour stack instead of a keyboard. That symmetry matters: bots obey the same locomotion,
 * recoil, reload and penetration rules as humans, so they feel like opponents rather than
 * turrets.
 *
 * Brain layers, top to bottom:
 *   1. **Perception** — a vision cone with occlusion, peripheral awareness, hearing (gunshots,
 *      footsteps, explosions), target memory and last-known-position tracking.
 *   2. **Squad/tactics** — role assignment (rusher/anchor/overwatch), cover selection,
 *      suppression reactions, retreat when hurt, grenade usage, objective play.
 *   3. **State machine** — Idle → Patrol → Investigate → Engage → ReloadOnCover → Reposition →
 *      Retreat → Dead, with smooth transitions and per-state timers.
 *   4. **Motor control** — path following with steering, strafing while shooting, reaction
 *      delays, aim smoothing with per-difficulty error, burst discipline and trigger discipline.
 *
 * Difficulty is a single scalar with overrides: reaction time, aim error, tracking speed, burst
 * length, grenade frequency, cover patience and target-switch speed.
 *
 * @module engine/src/gameplay/Bot.js
 */
import { Vector3 } from '../math/Vector3.js';
import { RNG } from '../math/Random.js';
import { clamp, clamp01, damp, lerp, DEG2RAD } from '../math/MathUtils.js';
import { Signal } from '../core/Signal.js';
import { Player, PlayerState } from './Player.js';
import { DamageType, HitZone } from './Ballistics.js';
import { StatusEffect } from './Health.js';
import { GrenadeLibrary } from './Weapons.js';
import { CollisionLayer } from '../world/Part.js';

/** Behaviour states. */
export const BotState = {
  Idle: 'idle',
  Patrol: 'patrol',
  Investigate: 'investigate',
  Engage: 'engage',
  Reload: 'reload',
  Reposition: 'reposition',
  Retreat: 'retreat',
  Revive: 'revive',
  Hold: 'hold',
  Dead: 'dead',
};

/** Squad roles. */
export const BotRole = { Rusher: 'rusher', Anchor: 'anchor', Overwatch: 'overwatch', Support: 'support', Breacher: 'breacher' };

/** Difficulty table — one row per tier, every knob is per-bot overridable. */
export const BotDifficulty = {
  recruit: { reactionTime: 0.55, aimError: 0.055, aimSpeed: 5.0, burstLength: [2, 4], fireWhileMoving: 0.25, grenadeChance: 0.05, coverUse: 0.25, accuracy: 0.5, fov: 100, hearing: 0.6, strafeSkill: 0.2, healAwareness: 0.3, leadAim: 0.2 },
  regular: { reactionTime: 0.32, aimError: 0.032, aimSpeed: 7.5, burstLength: [3, 6], fireWhileMoving: 0.45, grenadeChance: 0.12, coverUse: 0.5, accuracy: 0.7, fov: 110, hearing: 0.85, strafeSkill: 0.45, healAwareness: 0.6, leadAim: 0.45 },
  hardened: { reactionTime: 0.2, aimError: 0.018, aimSpeed: 10, burstLength: [4, 9], fireWhileMoving: 0.7, grenadeChance: 0.22, coverUse: 0.75, accuracy: 0.85, fov: 120, hearing: 1, strafeSkill: 0.7, healAwareness: 0.8, leadAim: 0.7 },
  elite: { reactionTime: 0.12, aimError: 0.009, aimSpeed: 14, burstLength: [5, 12], fireWhileMoving: 0.9, grenadeChance: 0.35, coverUse: 0.9, accuracy: 1, fov: 130, hearing: 1.2, strafeSkill: 0.9, healAwareness: 0.95, leadAim: 0.9 },
};

export class Bot extends Player {
  /**
   * @param {import('../world/Scene.js').Scene} scene
   * @param {object} [opts] Player options plus { nav, difficulty, role, ballistics, skill, seed, squad }
   */
  constructor(scene, opts = {}) {
    super(scene, { ...opts, isBot: true, isLocal: false, displayName: opts.displayName ?? opts.name ?? `Bot_${opts.team ?? 'red'}` });
    this.nav = opts.nav ?? null;
    this.difficultyName = opts.difficulty ?? 'regular';
    this.skill = opts.skill ?? null;
    this.settings = { ...(BotDifficulty[this.difficultyName] ?? BotDifficulty.regular), ...(opts.settings ?? {}) };
    // A caller that wants reproducible AI passes `seed`; otherwise fall back to the instance id.
    // (`Instance` ids are random, so id-derived seeds are only stable within one process.)
    this.rng = opts.rng ?? new RNG(((opts.seed ?? hashCode(this.id)) >>> 0));
    // The RNG must exist before the role is rolled: passing `opts.rng` (usually undefined) fell
    // through to `Math.random`, so a seeded match still produced different teams every run.
    this.role = opts.role ?? this._pickRole(this.rng);
    this.squad = opts.squad ?? null;
    this.aimTarget = opts.aimTarget ?? 'torso';
    this.homePosition = (opts.position ?? new Vector3()).clone();
    this.objective = opts.objective ?? null;

    // --- perception ---------------------------------------------------------
    /** @type {Map<Player, {known: boolean, lastSeen: Vector3, lastSeenTime: number, visible: boolean, threat: number}>} */
    this.memory = new Map();
    this.target = null;
    this.targetLostTime = 0;
    this.visibleTargets = [];
    this.threatLevel = 0;
    this.alertness = 0;
    this.lastNoisePosition = null;
    this.lastNoiseTime = -Infinity;
    this.timeSinceSeenEnemy = Infinity;

    // --- behaviour ----------------------------------------------------------
    this.state = BotState.Idle;
    this.previousState = null;
    this.stateTime = 0;
    this.path = null;
    this.pathIndex = 0;
    this.pathTimer = 0;
    this.pathRefreshRate = opts.pathRefreshRate ?? 0.45;
    this.steerTarget = new Vector3();
    this.coverNode = null;
    this.coveringSince = 0;
    this.strafeDirection = this.rng.chance(0.5) ? 1 : -1;
    this.strafeTimer = 0;
    this.nextStrafeFlip = this.rng.nextNumber(0.6, 1.6);
    this.grenadeCooldown = this.rng.nextNumber(4, 12);
    this.idleTime = this.rng.nextNumber(0, 2);
    this.patrolPoint = null;
    /** Unstick state: after being blocked the bot sidesteps for `stuckTimer` seconds. */
    this.stuckTimer = 0;
    this.avoidPoint = null;
    this.avoidUntil = 0;
    this.reactionTimer = 0;
    this.aimSmoothing = new Vector3();
    this.fireDiscipline = 0;
    this.burstShotsLeft = 0;
    this.burstPause = 0;
    this.suppressionTimer = 0;
    this.jumpCooldown = 0;
    this.debugPath = opts.debugPath ?? false;

    // AI-only events (the player-facing signals are inherited from `Player`).
    this.TargetSpotted = new Signal('Bot.TargetSpotted');
    this.StateChanged = new Signal('Bot.StateChanged');
    this.LostTarget = new Signal('Bot.LostTarget');
    this.ContactReported = new Signal('Bot.ContactReported');
  }

  static create(scene, opts) { return new Bot(scene, opts); }

  _pickRole(rng = { chance: () => Math.random() < 0.5 }) {
    return rng.chance(0.4) ? BotRole.Rusher : rng.chance(0.5) ? BotRole.Anchor : BotRole.Overwatch;
  }

  // ------------------------------------------------------------------ perception
  /**
   * Fills `memory` with what this bot can see/hear this frame.
   * @param {Iterable<Player>} candidates
   */
  perceive(candidates, dt) {
    const eye = this.character.eyePosition;
    const forward = this.getForward(_botForward);
    const fovCos = Math.cos((this.settings.fov * 0.5) * DEG2RAD);
    const viewDistance = this.settings.viewDistance ?? 120;
    const visible = [];

    for (const candidate of candidates) {
      if (!candidate || candidate === this || candidate.team === this.team) continue;
      if (!candidate.alive || candidate.health?.dead) {
        const entry = this.memory.get(candidate);
        if (entry) entry.known = false;
        continue;
      }
      let entry = this.memory.get(candidate);
      if (!entry) {
        entry = { known: false, lastSeen: new Vector3(), lastSeenTime: -Infinity, visible: false, threat: 0 };
        this.memory.set(candidate, entry);
      }
      const target = _botTo.copy(candidate.character.eyePosition).sub(eye);
      const distance = target.magnitude;
      let canSee = false;
      if (distance < viewDistance) {
        target.scale(1 / Math.max(1e-4, distance));
        const inCone = target.dot(forward) > fovCos;
        // Close-range peripheral awareness: you notice someone breathing down your neck.
        const peripheral = distance < 4.5;
        if (inCone || peripheral) {
          const los = this.scene.collision
            ? this.scene.collision.lineOfSight(eye, candidate.character.eyePosition, { ignore: [this], layerMask: CollisionLayer.Static | CollisionLayer.Dynamic | CollisionLayer.Glass })
            : true;
          canSee = los && !this.ballistics?.isVisionBlocked?.(eye, candidate.character.eyePosition);
        }
      }
      if (this.flashIntensity > 0.6) canSee = false;                 // blinded
      if (this.health.hasEffect(StatusEffect.Gassed) && distance > 18) canSee = false;
      entry.visible = canSee;
      if (canSee) {
        entry.known = true;
        entry.lastSeen.copy(candidate.character.position);
        entry.lastSeenTime = this.scene.time;
        entry.threat = 1 - clamp01(distance / viewDistance) + (candidate.weapon?.definition?.class === 'sniper' ? 0.2 : 0);
        visible.push(candidate);
      }
    }
    this.visibleTargets = visible;
    return visible;
  }

  /**
   * Squad comms: the instant a bot gains a visual, it calls the contact out to its team. Teammates
   * pick it up through the normal hearing channel, so one scout turns a squad into a reacting unit
   * instead of eight bots wandering a maze six metres apart with nobody shooting.
   */
  _shareContact(target, candidates) {
    const position = target.character?.position;
    if (!position) return;
    for (const mate of candidates) {
      if (!mate || mate === this || mate.team !== this.team || typeof mate.hear !== 'function') continue;
      if (!mate.health?.alive) continue;
      if (mate.character.position.distanceTo(this.character.position) > 45) continue;
      mate.hear(position, 0.5, { source: target });
    }
    this.ContactReported.emit({ bot: this, target, position: position.clone() });
  }

  /** Reacts to audible events (gunfire, footsteps, explosions) — hearing is a real mechanic. */
  hear(position, loudness = 1, { source = null } = {}) {
    if (!position) return this;
    const distance = this.character.position.distanceTo(position);
    const range = 90 * loudness * this.settings.hearing;
    if (distance > range) return this;
    this.lastNoisePosition ??= new Vector3();
    this.lastNoisePosition.copy(position);
    this.lastNoiseTime = this.scene.time;
    this.alertness = Math.min(1, this.alertness + clamp01(1 - distance / range) * 0.6);
    if (source && source.team && source.team !== this.team) {
      const entry = this.memory.get(source) ?? { known: false, lastSeen: new Vector3(), lastSeenTime: -Infinity, visible: false, threat: 0.4 };
      entry.lastSeen.copy(source.character?.position ?? position);
      entry.lastSeenTime = this.scene.time;
      entry.known = true;
      this.memory.set(source, entry);
    }
    return this;
  }

  /** Chooses the highest-threat visible target (closest + most dangerous). */
  selectTarget(visible) {
    if (visible.length === 0) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of visible) {
      const distance = this.character.position.distanceTo(candidate.character.position);
      let score = 60 - distance * 0.4;
      if (candidate === this.target) score += 12;                    // target stickiness
      if (candidate.health.healthFraction < 0.35) score += 18;       // finish the wounded
      if (candidate.weapon?.definition?.class === 'sniper') score += 10;
      if (candidate.suppression > 0.5) score += 5;
      score += this.rng.nextNumber(-2, 2);
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    return best;
  }

  // ------------------------------------------------------------------ main tick
  /**
   * Runs one AI frame.
   * @param {number} dt
   * @param {object} ctx { players, nav, teammates, objectives, gameMode }
   */
  think(dt, ctx = {}) {
    if (!this.health.alive) {
      this.botState = BotState.Dead;
      return this;
    }
    const candidates = ctx.players ?? ctx.candidates ?? [];
    this.nav = ctx.nav ?? this.nav;
    // Adopt the session's objective when no squad has assigned one. Without this a bot on a maze
    // map just patrols random corners, and two teams can play a whole round without meeting.
    if (ctx.objective) this.objective = ctx.objective;
    // Perception (50 raycasts per bot per frame on a 5v5) is staggered so a large bot count
    // spreads its cost across frames instead of spiking on one. Reaction timers hide the
    // latency for the player.
    this._perceivePhase = (this._perceivePhase ?? 0) + dt;
    const perceiveInterval = this.perceiveInterval ?? 1 / 15;
    if (this._perceivePhase >= perceiveInterval || !this._perceived) {
      this._perceivePhase = 0;
      this._perceived = true;
      this.perceive(candidates, dt);
    }

    const target = this.selectTarget(this.visibleTargets);
    if (target) {
      if (this.target !== target) {
        this.target = target;
        this.reactionTimer = this.settings.reactionTime * this.rng.nextNumber(0.75, 1.35);
        this.TargetSpotted.emit({ bot: this, target });
        this._shareContact(target, candidates);
      }
      this.timeSinceSeenEnemy = 0;
    } else {
      this.timeSinceSeenEnemy += dt;
      if (this.target && this.timeSinceSeenEnemy > 6) {
        this.LostTarget.emit({ bot: this, target: this.target });
        this.target = null;
      }
    }

    this.threatLevel = clamp01(this.suppression * 0.5 + (this.health.healthFraction < 0.4 ? 0.5 : 0));
    this.alertness = Math.max(0, this.alertness - dt * 0.06);
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);

    // Decide + act.
    const nextState = this._decideState(dt, ctx);
    if (nextState !== this.botState) {
      const previous = this.botState;
      this._enterState(nextState, dt, ctx);
      this.StateChanged.emit({ bot: this, state: nextState, previous });
    }
    this.ctx = ctx;

    const input = this._buildInput(dt, ctx);
    // Aiming writes yaw/pitch directly (smooth turn-rate limited), so the movement update sees
    // the new facing immediately and no look delta is applied twice.
    this._aim(dt, ctx);
    super.update(dt, input);
    return this;
  }

  _decideState(dt, ctx) {
    const health01 = this.health.healthFraction;
    if (!this.health.alive) return BotState.Dead;
    const hasTarget = !!this.visibleTargets.length;
    // Reload when safe, retreat when hurt, engage when the target is there.
    if (this.isReloading && hasTarget && this.weapon.ammo === 0 && this.threatLevel > 0.6) return BotState.Retreat;
    if (this.weapon?.magazineEmpty) return hasTarget && this._hasCover() ? BotState.Reload : BotState.Engage;
    if (health01 < this.retreatThreshold()) {
      const healer = (ctx.teammates ?? []).some((t) => t.role === BotRole.Support && t.health.healthFraction > 0.5);
      if (!hasTarget || this.health.healthFraction < 0.22 || healer) return BotState.Retreat;
    }
    if (hasTarget) {
      if (this.weapon?.reloading) return BotState.Reload;
      return BotState.Engage;
    }
    if (this.target && this.timeSinceSeenEnemy < 8) return BotState.Investigate;
    if (this.alertness > 0.25 && this.lastNoisePosition) return BotState.Investigate;
    if (this.holdingPosition(ctx)) return BotState.Hold;
    // Nothing to shoot → advance on the objective rather than milling around spawn.
    if (this.objective && this.character.position.distanceTo(this.objective) > 12) return BotState.Investigate;
    return BotState.Patrol;
  }

  retreatThreshold() { return this.role === BotRole.Rusher ? 0.18 : 0.35; }
  holdingPosition(ctx) {
    if (!this.objective) return this.role === BotRole.Anchor && this.character.position.distanceTo(this.homePosition) < 12;
    const distance = this.character.position.distanceTo(this.objective);
    return distance < 14 && this.role !== BotRole.Rusher && ctx.holdObjectives !== false;
  }

  _enterState(state, dt, ctx) {
    this.previousState = this.botState;
    this.botState = state;
    this.stateTime = 0;
    switch (state) {
      case BotState.Engage:
        this.fireDiscipline = 0;
        break;
      case BotState.Reload:
        this.weapon?.startReload?.();
        this.coverNode ??= this._pickCover();
        break;
      case BotState.Retreat:
        this.coverNode = this._pickCover({ fromCombat: true });
        this._repath(dt, ctx, this.coverNode?.position ?? this.homePosition, { immediate: true });
        break;
      case BotState.Investigate:
        this._repath(dt, ctx, this._investigateGoal(ctx), { immediate: true });
        break;
      case BotState.Hold:
        this.coverNode ??= this._pickCover();
        this.holdTimer = 0;
        this.holdDuration = this.rng.nextNumber(this.role === BotRole.Overwatch ? 18 : 10, this.role === BotRole.Overwatch ? 34 : 22);
        if (this.coverNode) this._repath(dt, ctx, this.coverNode.position, { immediate: true });
        break;
      case BotState.Patrol:
        this.patrolPoint = null;
        break;
      default: break;
    }
  }

  /** Builds the synthetic input this bot "presses" this frame. */
  _buildInput(dt, ctx) {
    const input = {
      moveX: 0, moveY: 0, jump: false, crouch: false, prone: false, sprint: false,
      fire: false, aim: false, reload: false, grenade: false, melee: false, look: { yaw: 0, pitch: 0 },
    };
    const state = this.botState ?? BotState.Idle;
    const hasTarget = this.visibleTargets.length > 0;

    switch (state) {
      case BotState.Engage: this._engageInput(input, dt, ctx); break;
      case BotState.Reload: this._reloadInput(input, dt, ctx); break;
      case BotState.Retreat: this._retreatInput(input, dt, ctx); break;
      case BotState.Investigate: this._followPathInput(input, dt, ctx, { sprint: this.alertness > 0.5 }); break;
      case BotState.Hold: this._holdInput(input, dt, ctx); break;
      case BotState.Patrol: this._patrolInput(input, dt, ctx); break;
      default: this._idleInput(input, dt, ctx); break;
    }
    // Reaction delay: until the timer elapses the bot tracks but does not shoot.
    if (this.reactionTimer > 0 && hasTarget) {
      this.reactionTimer -= dt;
      input.fire = false;
    }
    // Suppression makes bots flinch and lose accuracy.
    if (this.suppressionTimer > 0) {
      this.suppressionTimer -= dt;
      input.moveX += this.strafeDirection * 0.4;
    }
    this.input = input;
    return input;
  }

  _engageInput(input, dt, ctx) {
    const target = this.target ?? this.visibleTargets[0];
    if (!target) return;
    const targetPos = target.character.position;
    const distance = this.character.position.distanceTo(targetPos);
    const def = this.weapon?.definition;

    // Shooting discipline: burst fire, don't spray at long range from the hip.
    this.fireDiscipline -= dt;
    if (this.burstPause > 0) this.burstPause -= dt;
    // Effective range: bots do not trade rifle fire across a 100 m map, they close distance.
    const engagementRange = this.settings.engagementRange ?? (def?.class === 'sniper' ? 140 : def?.class === 'shotgun' ? 16 : 62);
    const withinRange = distance < Math.min(def?.range ?? 100, engagementRange);
    const wantAim = distance > 12 || (def?.class === 'sniper');
    input.aim = wantAim;

    if (this.burstShotsLeft <= 0 && this.burstPause <= 0) {
      const [minBurst, maxBurst] = this.settings.burstLength;
      this.burstShotsLeft = Math.round(this.rng.nextNumber(minBurst, maxBurst));
      this.burstPause = this.rng.nextNumber(0.12, 0.4) * (1 + distance / 120);
    }
    // Trigger discipline: a bot that has held the sights on a visible target for a while takes
    // the shot even without a perfect solution — that is what suppression fire looks like.
    const solved = this._hasFiringSolution(target);
    this._solutionTimer = solved ? 0 : (this._solutionTimer ?? 0) + dt;
    // Settle for the shot: beyond close range a bot plants its feet (or nearly so) to shoot
    // straight, instead of spraying while strafing at full speed.
    this._settleForShot = solved && distance > 20;
    const pressureShot = this._solutionTimer > 0.9 && this.rng.chance(this.settings.accuracy * 0.5 * dt * 8);
    const canShoot = withinRange && this.weapon && !this.weapon.reloading && this.weapon.ammo > 0;
    if (canShoot && this.burstShotsLeft > 0 && (solved || pressureShot)) {
      input.fire = true;
      if (!solved) this._solutionTimer = 0;
      this.burstShotsLeft -= 1;
      if (this.burstShotsLeft <= 0) this.burstPause = Math.max(this.burstPause, this.rng.nextNumber(0.25, 0.7));
    }
    // Movement: strafe, push or back off based on role and distance.
    const movingAllowed = !this._settleForShot && (this.rng.chance(this.settings.fireWhileMoving) || distance > 25);
    const idealRange = this.role === BotRole.Rusher ? 8 : this.role === BotRole.Overwatch ? 45 : 18;
    const distanceError = distance - idealRange;
    this.strafeTimer += dt;
    if (this.strafeTimer > this.nextStrafeFlip) {
      this.strafeTimer = 0;
      this.nextStrafeFlip = this.rng.nextNumber(0.5, 1.5);
      this.strafeDirection *= this.rng.chance(0.7) ? -1 : 1;
    }
    if (movingAllowed) {
      input.moveY = clamp(distanceError / 12, -1, 1) * (Math.abs(distanceError) > 6 ? 1 : 0);
      input.moveX = this.strafeDirection * this.settings.strafeSkill;
      input.sprint = distanceError > 20 && this.rng.chance(0.4);
    }
    // Cover seeking while under fire.
    if (this.suppression > 0.5 && this.settings.coverUse > this.rng.nextNumber(0, 1)) {
      this.coverNode ??= this._pickCover();
      if (this.coverNode) this._followCover(input, dt);
    }
    // Grenades: only when the target is behind cover and out of grenade range.
    if (this.grenadeCooldown <= 0 && this.rng.chance(this.settings.grenadeChance * dt * 6) && distance > 9 && distance < 30 && this._hasThrowLine(targetPos, distance)) {
      input.grenade = true;
      this.grenadeType = this.grenadeType ?? 'frag';
      this.grenadeCooldown = this.rng.nextNumber(12, 30);
    }
    // Melee if someone is on top of us.
    if (distance < 1.8) input.melee = this.rng.chance(0.35);
    // Jump over obstacles when the path is blocked.
    if (this.jumpCooldown <= 0 && this._stuckFor(dt, input)) { input.jump = true; this.jumpCooldown = 0.8; }
    // Reload in the middle of a fight if the magazine is nearly empty and there's cover.
    if (this.weapon && this.weapon.ammo <= Math.max(1, (def?.magazineSize ?? 30) * 0.15) && this._hasCover()) input.reload = true;
    this._reposition(dt, ctx);
    void ctx;
  }

  _reloadInput(input, dt, ctx) {
    input.reload = true;
    input.aim = false;
    if (this.coverNode) this._followCover(input, dt);
    else if (this.target) this._moveAwayFrom(this.target.character.position, input);
    void ctx;
  }

  _retreatInput(input, dt, ctx) {
    input.sprint = true;
    const threat = this.target?.character.position ?? this.lastNoisePosition;
    if (this.coverNode && this.coverNode.position.distanceTo(this.character.position) > 3) {
      this._followCover(input, dt);
    } else if (threat) {
      this._moveAwayFrom(threat, input);
    }
    this._reposition(dt, ctx);
  }

  _holdInput(input, dt, ctx) {
    // Nobody guards the same box forever: after a spell on station the bot rotates to a new
    // position, which is what keeps a match from turning into a stalemate.
    this.holdTimer = (this.holdTimer ?? 0) + dt;
    if (this.holdTimer > (this.holdDuration ?? 18)) {
      if (this.coverNode) { this.coverNode.claimedBy = null; this.coverNode = null; }
      this.coverQuery = null;
      this.patrolPoint = null;
      this.holdTimer = 0;
      return this._patrolInput(input, dt, ctx);
    }
    if (this.coverNode) {
      const distance = this.coverNode.position.distanceTo(this.character.position);
      if (distance > 2.5) { this._followCover(input, dt); return; }
      input.crouch = this.coverNode.cover > 0.5;
      input.aim = true;
      this._scanForTargets(dt, ctx);
    } else {
      this._idleInput(input, dt, ctx);
    }
  }

  _patrolInput(input, dt, ctx) {
    if (!this.patrolPoint || this.character.position.distanceTo(this.patrolPoint) < 2.5) {
      this.patrolPoint = this._pickPatrolPoint(ctx);
      if (this.patrolPoint) this._repath(dt, ctx, this.patrolPoint, { immediate: true });
    }
    this._followPathInput(input, dt, ctx, { sprint: this.role === BotRole.Rusher });
  }

  _idleInput(input, dt, ctx) {
    this.idleTime -= dt;
    input.crouch = false;
    this._scanForTargets(dt, ctx);
    if (this.idleTime <= 0) {
      this.idleTime = this.rng.nextNumber(0.8, 2.4);
      this.strafeDirection *= -1;
    }
  }

  /** Slowly sweeps the view, looking for targets (and picking up noise). */
  _scanForTargets(dt, ctx) {
    const sweepSpeed = 0.9 * this.settings.hearing;
    this._scanAngle = (this._scanAngle ?? 0) + dt * sweepSpeed;
    this._patrolYaw ??= this.yaw;
    this._desiredYaw = this._patrolYaw - Math.sin(this._scanAngle) * 0.7;
    this._desiredPitch = Math.sin(this._scanAngle * 0.37) * 0.12;
    void ctx;
  }

  _followPathInput(input, dt, ctx, { sprint = false } = {}) {
    this._updatePath(dt, ctx);
    const exhausted = !this.path || this.pathIndex >= this.path.points.length;
    // A one-point path means the goal sits in the cell we already occupy — the bot still has to
    // walk those last few metres. Parking on an exhausted path is how a bot used to freeze solid
    // a metre short of its objective for the rest of the match.
    const goal = this.pathGoal;
    if (exhausted && (!goal || this.character.position.distanceTo(goal) < 1.6)) {
      input.moveY = 0;
      return;
    }
    const waypoint = exhausted
      ? goal
      : this._pathAim(this.path.points[this.pathIndex], this.path.points[this.pathIndex + 1]);
    const toWaypoint = _botTo.copy(waypoint).sub(this.character.position);
    toWaypoint.y = 0;
    const distance = toWaypoint.magnitude;
    if (!exhausted && distance < (this.pathIndex === this.path.points.length - 1 ? 1.2 : 0.9)) {
      this.pathIndex++;
      if (this.pathIndex >= this.path.points.length) { this.path = null; return; }
    }
    toWaypoint.scale(1 / Math.max(1e-4, distance));
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const fx = -sin, fz = -cos;
    const rx = cos, rz = -sin;
    input.moveY = clamp(toWaypoint.x * fx + toWaypoint.z * fz, -1, 1);
    input.moveX = clamp(toWaypoint.x * rx + toWaypoint.z * rz, -1, 1) * 0.6;
    input.sprint = sprint && input.moveY > 0.5;
    // Smooth facing toward the movement direction; remember it so the scan sweep centres on it.
    this._patrolYaw = Math.atan2(-toWaypoint.x, -toWaypoint.z);
    this._desiredYaw = this._patrolYaw;
    this._desiredPitch = 0;
    // Blocked? Sidestep, hop, and blacklist the waypoint that led us into the wall. Without this
    // the bot re-paths to the same node forever and stands still for the rest of the match.
    if (this.stuckTimer > 0) {
      this.stuckTimer -= dt;
      input.moveX = this.strafeDirection * 0.85;
      input.moveY = Math.min(input.moveY, 0.35);
      return;
    }
    if (this._stuckFor(dt, input)) {
      this.stuckTimer = this.rng.nextNumber(0.45, 1.0);
      this.strafeDirection *= -1;
      this.avoidPoint = this.patrolPoint?.clone?.() ?? this.avoidPoint;
      this.avoidUntil = this.scene.time + 10;
      this.patrolPoint = null;
      this.path = null;
      this.pathTimer = 0;
      if (this.jumpCooldown <= 0) { input.jump = true; this.jumpCooldown = 1.1; }
    }
  }

  /**
   * Chooses the point to steer at: the current waypoint, pulled up to 1.5 m toward the next one
   * when that shortcut is clear. Steering at raw cell centres makes a bot grind into wall corners;
   * aiming slightly *into* the turn tracks the corner the way a player would.
   */
  _pathAim(waypoint, next) {
    if (!next) return waypoint;
    const dx = next.x - waypoint.x;
    const dz = next.z - waypoint.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.5) return waypoint;
    const step = Math.min(1.5, length * 0.5) / length;
    const aim = _botAimPoint.set(waypoint.x + dx * step, waypoint.y, waypoint.z + dz * step);
    const from = _botEye.set(this.character.position.x, this.character.position.y + 0.9, this.character.position.z);
    const collision = this.scene?.collision;
    if (collision?.lineOfSight && !collision.lineOfSight(from, aim, { ignore: [this] })) return waypoint;
    return aim;
  }

  _moveAwayFrom(position, input) {
    const away = _botTo.copy(this.character.position).sub(position);
    away.y = 0;
    if (away.sqrMagnitude < 1e-4) return;
    away.normalize();
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    input.moveY = clamp(away.x * -sin + away.z * -cos, -1, 1);
    input.moveX = clamp(away.x * cos + away.z * -sin, -1, 1) * 0.5;
    if (input.moveY < 0) input.moveY = 0.2;   // don't walk backwards; turn and run
  }

  _followCover(input, dt) {
    if (!this.coverNode) return;
    this._followPathInput(input, dt, this.ctx ?? {}, { sprint: this.botState === BotState.Retreat });
    // Following the path can drop the cover assignment (arrival, re-target), so re-check it.
    if (this.coverNode?.cover > 0.4) input.crouch = this.botState !== BotState.Retreat;
    void dt;
  }

  // ------------------------------------------------------------------ aiming
  /** Aims with human error: reaction delay, smoothing, per-difficulty jitter and lead. */
  _aim(dt, ctx) {
    const target = this.target;
    const desired = _botAimTarget;
    if (target && (this.visibleTargets.includes(target) || this.timeSinceSeenEnemy < 1.2)) {
      this._desiredYaw = null;
      const targetPos = target.character.position;
      desired.copy(targetPos);
      desired.y += this.aimTarget === 'head' ? 1.62 : this.aimTarget === 'legs' ? 0.4 : 1.2;
      // Lead moving targets (projectile weapons only).
      if (this.settings.leadAim > 0 && this.weapon?.definition.projectiles > 0) {
        const speed = this.weapon.definition.projectileSpeed;
        const travel = this.character.position.distanceTo(targetPos) / Math.max(1, speed);
        desired.addScaled(target.character.velocity, travel * this.settings.leadAim);
      }
      this._desiredYawOverride = null;
    } else if (this._desiredYaw !== undefined && this._desiredYaw !== null) {
      // No visible enemy: face the movement direction / scan sweep.
      this._aimAngles(dt, this._desiredYaw, this._desiredPitch ?? 0);
      return;
    } else {
      this._aimAngles(dt, this._patrolYaw ?? this.yaw, 0);
      return;
    }

    const eye = this.character.eyePosition;
    const toTarget = _botTo.copy(desired).sub(eye);
    const distance = toTarget.magnitude;
    if (distance < 1e-3) return;
    const desiredYaw = Math.atan2(-toTarget.x, -toTarget.z);
    const desiredPitch = Math.asin(clamp(toTarget.y / distance, -1, 1));
    // The trigger is decided on the *commanded* direction, not the wobbled one. Gating the shot on
    // the wobble means a bot whose aim error exceeds its tolerance never fires at all — the aim
    // wobble is there to make bullets miss, not to make the bot refuse to shoot.
    this._aimIntent = { yaw: desiredYaw, pitch: desiredPitch };

    // Aim error scales with distance, movement and suppression — misses feel earned.
    const movementPenalty = 1 + this.character.horizontalSpeed * 0.12;
    const suppressPenalty = 1 + this.suppression * 2.5;
    const error = this.settings.aimError * (1 + distance / 60) * movementPenalty * suppressPenalty;
    this.aimSmoothing.x = damp(this.aimSmoothing.x, this.rng.nextNumber(-error, error), 3.5, dt);
    this.aimSmoothing.y = damp(this.aimSmoothing.y, this.rng.nextNumber(-error, error), 3.5, dt);
    this.aimSmoothing.z = damp(this.aimSmoothing.z, this.rng.nextNumber(-error * 0.5, error * 0.5), 3.5, dt);

    this._aimAngles(dt, desiredYaw + this.aimSmoothing.y, desiredPitch + this.aimSmoothing.x);
  }

  _aimAngles(dt, desiredYaw, desiredPitch) {
    // Wrap-aware smoothing so the bot doesn't take the long way round.
    let deltaYaw = desiredYaw - this.yaw;
    while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
    while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;
    const speed = this.settings.aimSpeed;
    const yawStep = clamp(deltaYaw, -speed * dt, speed * dt);
    const pitchStep = clamp(desiredPitch - this.pitch, -speed * dt * 0.8, speed * dt * 0.8);
    this._look = { yaw: yawStep, pitch: pitchStep };
    this.yaw += yawStep;
    this.pitch = clamp(this.pitch + pitchStep, this.pitchMin, this.pitchMax);
    this.character.yaw = this.yaw;
  }

  /** Sense-of-fire gate: only shoot when the aim is close enough to plausibly hit. */
  _hasFiringSolution(target) {
    // Must be the *same* point `_aim` commands the gun to: subtracting the eye height twice used
    // to leave a permanent ~1.6 m offset (≈8° at 11 m), so the trigger check never matched the aim.
    const aimHeight = this.aimTarget === 'head' ? 1.62 : this.aimTarget === 'legs' ? 0.4 : 1.2;
    const toTarget = _botTo.copy(target.character.position).sub(this.character.eyePosition);
    toTarget.y += aimHeight;
    const distance = toTarget.magnitude;
    if (distance < 1e-3) return false;
    toTarget.scale(1 / distance);
    const forward = this.getForward(_botForward);
    // Friendly-fire check: never shoot through a teammate. Measured as the closest approach of the
    // mate to the bullet line, not as an angle: a mate on the same floor sits 1.6 m below the eye
    // line, so a dot-product test (which is what this used to be) silently misses them.
    if (this.squad) {
      const eye = this.character.eyePosition;
      for (const mate of this.squad.members ?? []) {
        if (mate === this || mate.health.dead) continue;
        const mx = mate.character.position.x - eye.x;
        const my = mate.character.position.y + 1.05 - eye.y;
        const mz = mate.character.position.z - eye.z;
        const along = mx * toTarget.x + my * toTarget.y + mz * toTarget.z;
        if (along <= 0 || along >= distance) continue;      // behind the muzzle, or past the enemy
        const perp = Math.hypot(mx - toTarget.x * along, my - toTarget.y * along, mz - toTarget.z * along);
        if (perp < 0.55) return false;                      // their body is in the firing line
      }
    }
    const intent = this._aimIntent;
    let angleError;
    if (intent) {
      const cp = Math.cos(intent.pitch);
      const ix = -Math.sin(intent.yaw) * cp;
      const iy = Math.sin(intent.pitch);
      const iz = -Math.cos(intent.yaw) * cp;
      angleError = Math.acos(clamp(toTarget.x * ix + toTarget.y * iy + toTarget.z * iz, -1, 1));
    } else {
      angleError = Math.acos(clamp(toTarget.dot(forward), -1, 1));
    }
    // Tolerance is "would a bullet from the muzzle plausibly cross the body": a ~0.6 m wide target
    // at `distance`, never tighter than the aim wobble the difficulty injects.
    const tolerance = Math.max(Math.atan2(0.6, distance), this.settings.aimError * 1.35, 0.004);
    void target;
    return angleError < tolerance;
  }

  // ------------------------------------------------------------------ pathing
  _repath(dt, ctx, goal, { immediate = false } = {}) {
    const nav = this.nav ?? ctx.nav;
    if (!nav) return false;
    if (!immediate && this.path && this.character.position.distanceTo(this.path.points[this.path.points.length - 1]) < 2) return false;
    const path = nav.findPath(this.character.position, goal, { maxNodes: 2500 });
    this.path = path;
    this.pathIndex = path ? 1 : 0;
    this.pathTimer = 0;
    // Remember where we were heading: when the path is a single point (or null) the goal itself is
    // the last stretch the bot still has to walk.
    this.pathGoal ??= new Vector3();
    this.pathGoal.copy(goal);
    void dt;
    return !!path;
  }

  _updatePath(dt, ctx) {
    this.pathTimer -= dt;
    if (!this.path || this.pathTimer <= 0) {
      this.pathTimer = this.pathRefreshRate;
      const goal = this._currentGoal(ctx);
      if (goal) this._repath(dt, ctx, goal);
    }
  }

  _currentGoal(ctx) {
    if (this.botState === BotState.Investigate) return this._investigateGoal(ctx);
    if (this.botState === BotState.Retreat) return this.coverNode?.position ?? this.homePosition;
    if (this.botState === BotState.Reload && this.coverNode) return this.coverNode.position;
    if (this.botState === BotState.Engage && this.target && this.role === BotRole.Rusher) return this.target.character.position;
    if (this.objective) return this.objective;
    if (this.investigatePoint) return this.investigatePoint;
    if (this.patrolPoint) return this.patrolPoint;
    return this._pushGoal(ctx) ?? this.homePosition;
  }

  /**
   * Where to go when nothing else applies. A team-deathmatch map with no capture points leaves bots
   * with no reason to advance, which reads as "the AI does nothing": so the fallback is the enemy
   * front line — the centroid of the *living* enemies, or the last place an enemy was seen.
   */
  _pushGoal(ctx) {
    const enemies = (ctx?.players ?? []).filter((other) => other !== this && other.team !== this.team && other.health?.alive !== false);
    if (enemies.length) {
      const centroid = this._goalScratch ??= new Vector3();
      centroid.set(0, 0, 0);
      for (const enemy of enemies) {
        const position = enemy.character?.position ?? enemy.position;
        if (!position) continue;
        centroid.x += position.x;
        centroid.y += position.y;
        centroid.z += position.z;
      }
      centroid.x /= enemies.length;
      centroid.y /= enemies.length;
      centroid.z /= enemies.length;
      // Charge the front line, stopping ~6 m short of the enemy centroid rather than walking into
      // the muzzle. A proportional stand-off made bots hover a quarter of the map away and never
      // actually close on anybody.
      const back = _botStandoff.copy(this.character.position).sub(centroid);
      const length = back.magnitude;
      if (length > 9) centroid.addScaled(back.scale(6 / length), 1);
      else centroid.copy(this.character.position);
      return centroid;
    }
    if (this.lastNoisePosition && this.scene.time - this.lastNoiseTime < 12) return this.lastNoisePosition;
    return null;
  }

  _pickPatrolPoint(ctx) {
    const nav = this.nav ?? ctx.nav;
    if (!nav) return this.homePosition.clone().add(_botPatrol.set(this.rng.nextNumber(-10, 10), 0, this.rng.nextNumber(-10, 10)));
    // Patrols drift toward the fight: sample a handful of nodes and keep the one that both
    // advances on the objective and is a reasonable march away.
    const goal = this.objective ?? ctx.objective ?? this._pushGoal(ctx) ?? this.homePosition;
    let best = null;
    let bestScore = -Infinity;
    const samples = nav.nodes.length > 2000 ? 6 : 12;
    for (let i = 0; i < samples; i++) {
      const node = nav.randomNode?.(this.rng) ?? null;
      if (!node) continue;
      const toGoal = node.position.distanceTo(goal);
      const mine = this.character.position.distanceTo(goal);
      const travel = node.position.distanceTo(this.character.position);
      // Closer to the objective than we are, but not a teleport across the map.
      let score = (mine - toGoal) * 1.2 - Math.max(0, travel - 45) * 2 + this.rng.nextNumber(-3, 3);
      if (node.cover >= 0.4) score += 2;
      if (travel < 4) score -= 8;
      // Never pick the node we just got wedged on (walls, doorframes, unreachable islands).
      if (this.avoidPoint && this.avoidUntil > this.scene.time && node.position.distanceTo(this.avoidPoint) < 8) score -= 60;
      if (score > bestScore) { bestScore = score; best = node; }
    }
    return best ? best.position.clone() : this.homePosition.clone();
  }

  /** Picks a cover node: close, protected from the threat direction, not already held. */
  _pickCover({ fromCombat = false } = {}) {
    const nav = this.nav;
    if (!nav || !nav.coverPoints?.length) return null;
    const threat = this.target?.character.position ?? this.lastNoisePosition ?? null;
    let best = null;
    let bestScore = -Infinity;
    const samples = Math.min(nav.coverPoints.length, 14);
    for (let i = 0; i < samples; i++) {
      const node = nav.randomCoverPoint ? nav.randomCoverPoint(this.rng, 0.25) : nav.coverPoints[this.rng.nextInteger(0, nav.coverPoints.length - 1)];
      if (!node || node.claimedBy && node.claimedBy !== this) continue;
      const distance = node.position.distanceTo(this.character.position);
      if (distance > (fromCombat ? 26 : 18) || distance < 0.8) continue;
      let score = node.cover * 6 - distance * 0.25;
      if (threat) {
        // Cover should sit between us and the threat: walk *away* from the threat.
        const away = node.position.clone().sub(threat).normalize();
        const mine = this.character.position.clone().sub(threat).normalize();
        score += away.dot(mine) * 4;
        if (node.position.distanceTo(threat) < 4) score -= 6;
      }
      if (this.squad) {
        for (const mate of this.squad.members ?? []) {
          if (mate === this) continue;
          if (mate.coverNode === node) score -= 20;
        }
      }
      score += this.rng.nextNumber(-1, 1);
      if (score > bestScore) { bestScore = score; best = node; }
    }
    if (best) {
      best.claimedBy = this;
      if (this.coverNode && this.coverNode !== best) this.coverNode.claimedBy = null;
    }
    return best;
  }

  /** Where an investigation walk goes: fresh noise first, then the squad objective. */
  _investigateGoal(ctx) {
    if (this.lastNoisePosition && this.scene.time - this.lastNoiseTime < 12) return this.lastNoisePosition;
    if (this.target && this.timeSinceSeenEnemy < 10) return this.memory.get(this.target)?.lastSeen ?? this.target.character.position;
    return this.objective ?? ctx.objective ?? this.homePosition;
  }

  /** Grenades need a clear arc: a wall in the way turns a good throw into a suicide. */
  _hasThrowLine(targetPos, distance) {
    if (!this.scene.collision) return true;
    const origin = this.character.eyePosition;
    const apex = _botGrenade.copy(targetPos).lerp(origin, 0.35);
    apex.y = Math.max(origin.y, targetPos.y) + clamp(distance * 0.22, 1.2, 5.5);
    const hitLow = this.scene.collision.raycast(origin, _botTo.copy(apex).sub(origin).normalize(), origin.distanceTo(apex), { ignore: [this] });
    if (hitLow) return false;
    const down = _botTo.copy(targetPos).sub(apex);
    const hitHigh = this.scene.collision.raycast(apex, down.normalize(), down.magnitude, { ignore: [this] });
    return !hitHigh || hitHigh.distance < 1.5;
  }

  _hasCover() {
    if (this.coverNode && this.coverNode.position.distanceTo(this.character.position) < 3) return true;
    // Cached: the cover list can hold thousands of nodes and this is asked every frame.
    this._coverQuery ??= { time: -Infinity, position: new Vector3(), result: false };
    const query = this.coverQuery ?? this._coverQuery;
    if (query.time > this.scene.time - 0.5 && query.position.distanceToSquared(this.character.position) < 4) return query.result;
    let result = false;
    if (this.nav?.coverPoints?.length) {
      const cell = this.nav.cellSize ?? 2;
      for (const node of this.nav.coverPoints) {
        if (Math.abs(node.position.x - this.character.position.x) > cell * 2) continue;
        if (Math.abs(node.position.z - this.character.position.z) > cell * 2) continue;
        if (node.position.distanceTo(this.character.position) < 4) { result = true; break; }
      }
    }
    query.time = this.scene.time;
    query.position.copy(this.character.position);
    query.result = result;
    return result;
  }

  /** Detects being stuck (walking into a wall for a while) so the bot can jump or repath. */
  _stuckFor(dt, input = null) {
    const position = this.character.position;
    this._lastStuckCheck ??= { position: position.clone(), timer: 0 };
    const moved = position.distanceTo(this._lastStuckCheck.position);
    // Gate on *intent*, not just measured speed: a fully wedged bot has ~0 speed, so a
    // speed-only test never trips and it stands there for the rest of the match.
    const intent = input ? Math.hypot(input.moveX ?? 0, input.moveY ?? 0) : 0;
    const wantsToMove = intent > 0.15;
    // `Bot` has no `speed` field of its own: the character carries it. Reading the missing property
    // gave `NaN`, every comparison came out false, and the detector never fired once.
    const speed = this.character?.speed ?? this.speed ?? 0;
    const expected = Math.max(0.6, speed) * dt * 2;
    if (moved < expected && (speed > 0.5 || wantsToMove)) this._lastStuckCheck.timer += dt;
    else { this._lastStuckCheck.timer = 0; this._lastStuckCheck.position.copy(position); }
    if (this._lastStuckCheck.timer > 0.8) {
      this._lastStuckCheck.timer = 0;
      this._lastStuckCheck.position.copy(position);
      this.path = null;
      this.coverNode = null;
      return true;
    }
    return false;
  }

  /** Re-positions between bursts: sidestep to a new firing angle instead of standing still. */
  _reposition(dt, ctx) {
    this.repositionTimer = (this.repositionTimer ?? this.rng.nextNumber(1.5, 4)) - dt;
    if (this.repositionTimer > 0) return;
    this.repositionTimer = this.rng.nextNumber(1.6, 4.2);
    if (!this.target || this.role === BotRole.Overwatch) return;
    const nav = this.nav ?? ctx.nav;
    if (!nav) return;
    const offset = _botPatrol.set(this.rng.nextNumber(-6, 6), 0, this.rng.nextNumber(-6, 6));
    const position = this.target.character.position.clone().add(offset);
    if (this._repath(dt, ctx, position, { immediate: true })) this.coverNode = null;
  }

  /** Suppression reaction: flinch, seek cover calls, and lose accuracy briefly. */
  onSuppressed() {
    this.suppressionTimer = this.rng.nextNumber(0.4, 1.2);
    this.suppression = Math.min(1, this.suppression + 0.4);
    this.alertness = 1;
    return this;
  }

  /** Called when the bot takes damage: reacts to being shot from an unknown direction. */
  applyDamage(info) {
    const result = super.applyDamage(info);
    this.alertness = 1;
    if (!this.target && info.attacker && info.attacker.team !== this.team) {
      this.target = info.attacker;
      this.reactionTimer = this.settings.reactionTime * 1.6;
      const entry = this.memory.get(info.attacker) ?? { known: false, lastSeen: new Vector3(), lastSeenTime: -Infinity, visible: false, threat: 1 };
      entry.known = true;
      entry.lastSeen.copy(info.attacker.character?.position ?? info.point);
      entry.lastSeenTime = this.scene.time;
      this.memory.set(info.attacker, entry);
    }
    if (result.applied > 0) this.onSuppressed();
    return result;
  }

  /** Death clean-up: release cover claims so living bots can use them. */
  _die(event) {
    super._die(event);
    this.botState = BotState.Dead;
    if (this.coverNode) { this.coverNode.claimedBy = null; this.coverNode = null; }
    this.squad?.onMemberDeath?.(this);
    return this;
  }

  getDebugState() {
    return {
      name: this.displayName,
      team: this.team,
      role: this.role,
      state: this.botState,
      difficulty: this.difficultyName,
      hp: Math.round(this.health.health),
      target: this.target?.displayName ?? null,
      visible: this.visibleTargets.length,
      path: this.path ? this.path.points.length : 0,
      cover: this.coverNode ? 1 : 0,
      alert: +this.alertness.toFixed(2),
      suppression: +this.suppression.toFixed(2),
      ammo: this.weapon?.ammo ?? 0,
    };
  }
}

/** A group of bots that share target focus, cover reservations and grenade calls. */
export class Squad {
  constructor({ id = `squad_${++_squadId}`, team = 'red', objective = null } = {}) {
    this.id = id;
    this.team = team;
    this.objective = objective;
    /** @type {Bot[]} */
    this.members = [];
    this.focusTarget = null;
    this.lastGrenadeCall = -Infinity;
    this.roles = [BotRole.Rusher, BotRole.Anchor, BotRole.Anchor, BotRole.Overwatch];
  }

  add(bot) {
    bot.squad = this;
    bot.role = bot.role ?? this.roles[this.members.length % this.roles.length];
    bot.objective = this.objective;
    this.members.push(bot);
    return bot;
  }

  remove(bot) {
    const index = this.members.indexOf(bot);
    if (index >= 0) this.members.splice(index, 1);
    return bot;
  }

  onMemberDeath(bot) { void bot; }

  get aliveMembers() { return this.members.filter((m) => !m.health.dead); }

  /** One squad frame: focus fire, spread out, share contacts. */
  update(dt, ctx = {}) {
    const alive = this.aliveMembers;
    if (alive.length === 0) return this;
    // Focus fire: the majority target becomes the squad target; everyone gets the contact.
    const counts = new Map();
    for (const bot of alive) {
      for (const enemy of bot.visibleTargets) counts.set(enemy, (counts.get(enemy) ?? 0) + 1);
    }
    let focus = null;
    let best = 0;
    for (const [enemy, count] of counts) if (count > best) { best = count; focus = enemy; }
    if (focus) {
      this.focusTarget = focus;
      for (const bot of alive) {
        if (!bot.target) {
          bot.target = focus;
          bot.alertness = 1;
        }
      }
    }
    // Spacing: push overlapping members apart so they don't stack into one target.
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const separation = a.character.position.distanceTo(b.character.position);
        if (separation < 3.2 && separation > 1e-3) {
          // Nudge with an impulse so the character controller resolves the actual collision —
          // teleporting members here used to push them through walls.
          const push = _squadPush.copy(a.character.position).sub(b.character.position).normalize().scale(3.2 - separation);
          a.character.addImpulse(push.scale(0.35), { verticalScale: 0 });
          b.character.addImpulse(push.scale(-0.35), { verticalScale: 0 });
        }
      }
    }
    this.objective = ctx.objective ?? this.objective;
    for (const bot of alive) bot.objective = this.objective;
    void dt;
    return this;
  }

  /** Called by the game mode when a grenade lands nearby: bots react as a group. */
  onGrenade(position) {
    for (const bot of this.members) {
      if (bot.health.dead) continue;
      const distance = bot.character.position.distanceTo(position);
      if (distance < 12) {
        bot.onSuppressed();
        bot.lastNoisePosition = position.clone();
      }
    }
    return this;
  }

  serialize() {
    return { id: this.id, team: this.team, members: this.members.map((m) => m.id), objective: this.objective?.toString?.() ?? null };
  }
}

function hashCode(text) {
  let h = 0;
  for (let i = 0; i < String(text).length; i++) h = (Math.imul(31, h) + String(text).charCodeAt(i)) | 0;
  return Math.abs(h);
}

let _squadId = 0;
const _botForward = new Vector3();
const _botAimPoint = new Vector3();
const _botStandoff = new Vector3();
const _botEye = new Vector3();
const _botTo = new Vector3();
const _botMate = new Vector3();
const _botAimTarget = new Vector3();
const _botPatrol = new Vector3();
const _botGrenade = new Vector3();
const _squadPush = new Vector3();
void lerp;
void DamageType;
void HitZone;
void GrenadeLibrary;

export default Bot;
