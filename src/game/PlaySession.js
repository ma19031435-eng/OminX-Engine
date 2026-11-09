/**
 * OminX Engine — FPS match session.
 *
 * Owns everything that makes a deathmatch: teams, bot squads, spawn waves, respawn timers,
 * objective capture, scoring, the kill feed and the match clock. It is deliberately independent of
 * rendering and of the transport: the same session runs locally (bots + player), on the listen
 * server, or driven by a snapshot stream from `net/NetworkClient`.
 *
 * @module src/game/PlaySession
 */
import { Bot, Squad, BotDifficulty } from '../../engine/src/gameplay/Bot.js';
import { LoadoutPresets, PlayerState } from '../../engine/src/gameplay/Player.js';
import { humanoidHitboxes } from '../../engine/src/gameplay/Ballistics.js';
import { Signal } from '../../engine/src/core/Signal.js';
import { createLogger } from '../../engine/src/core/Logger.js';
import { Vector3 } from '../../engine/src/math/Vector3.js';
import { RNG } from '../../engine/src/math/Random.js';
import { clamp, clamp01 } from '../../engine/src/math/MathUtils.js';

const log = createLogger('PlaySession');

export const MatchPhase = { Warmup: 'warmup', Live: 'live', Overtime: 'overtime', Over: 'over' };
export const GameMode = { TeamDeathmatch: 'tdm', Domination: 'domination', GunGame: 'gungame' };

export class PlaySession {
  /**
   * @param {import('../app/Engine.js').Engine} engine
   * @param {object} [opts]
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.scene = engine.scene;
    this.ballistics = engine.ballistics;
    this.nav = engine.nav;
    this.renderer = engine.renderer;
    this.audio = engine.audio;
    this.hud = engine.hud;
    this.settings = engine.settings;
    this.mode = opts.mode ?? GameMode.TeamDeathmatch;
    this.rng = new RNG(opts.seed ?? 0x5eed);
    this.time = 0;
    this.matchTime = 0;
    this.round = 1;
    this.phase = MatchPhase.Warmup;
    this.warmupTime = opts.warmup ?? 3;
    this.timeLimit = (opts.timeLimitMinutes ?? this.settings.timeLimitMinutes) * 60;
    this.scoreLimit = opts.scoreLimit ?? this.settings.scoreLimit;
    this.respawnTime = opts.respawnTime ?? this.settings.respawnTime;
    this.friendlyFire = opts.friendlyFire ?? this.settings.friendlyFire;
    this.botDifficulty = opts.botDifficulty ?? this.settings.botDifficulty;
    this.maxBotsPerTeam = opts.maxBotsPerTeam ?? Math.max(2, Math.ceil((opts.botCount ?? this.settings.botCount) / 2) + 1);

    this.teams = { red: { name: 'Red', score: 0, kills: 0, deaths: 0, bots: [], squads: [] }, blue: { name: 'Blue', score: 0, kills: 0, deaths: 0, bots: [], squads: [] } };
    this.redTeam = this.teams.red.bots;
    this.blueTeam = this.teams.blue.bots;
    this.respawnQueue = [];
    this.objectives = (engine._mapInfo?.objectives ?? []).map((objective) => ({
      label: objective.label,
      position: objective.position.clone ? objective.position.clone() : new Vector3(objective.position.x, 0, objective.position.z),
      zone: objective.zone ?? null,
      owner: 'neutral',
      progress: 0,
      contested: false,
      capturers: { red: 0, blue: 0 },
    }));
    this.captureRate = opts.captureRate ?? 0.35;
    this.killFeed = [];
    this.maxKillFeed = 8;
    this.events = [];
    this.streetFights = 0;
    this.actorsByTeam = { red: new Set(), blue: new Set() };

    this.Kill = new Signal('PlaySession.Kill');
    this.ObjectiveCaptured = new Signal('PlaySession.ObjectiveCaptured');
    this.PhaseChanged = new Signal('PlaySession.PhaseChanged');
    this.MatchOver = new Signal('PlaySession.MatchOver');
    this.Respawn = new Signal('PlaySession.Respawn');
    this._pickupTimers = new Map();
  }

  // ------------------------------------------------------------------ lifecycle
  start() {
    const engine = this.engine;
    // Objective zones notify the session directly instead of polling the collision world.
    for (const objective of this.objectives) {
      if (!objective.zone) continue;
      objective.zone.onEnter = (instance) => this._onZoneEnter(objective, instance);
      objective.zone.onExit = (instance) => this._onZoneExit(objective, instance);
    }
    engine.player = engine.player ?? engine.spawnPlayer({ team: 'blue' });
    this.localPlayer = engine.player;
    this.localPlayer.registerWith?.(this.ballistics);
    this.actorsByTeam.blue.add(this.localPlayer);
    engine.actors.add(this.localPlayer);
    this.spawnBots({ count: this.settings.botCount });

    // Pickup respawn wiring: pickups live in the scene, the session owns their timers.
    for (const pickup of engine.scene.getTagged('pickup')) {
      pickup.CanCollide = false;
      pickup.visible = true;
      pickup.touchedAt = -Infinity;
    }
    this.scene.PartAdded.connect?.(() => { /* editor inserts during play are ignored by the match */ });
    this.setPhase(MatchPhase.Warmup);
    log.info(`match started: ${this.mode}, ${this.settings.botCount} bots, ${this.objectives.length} objectives`);
    return this;
  }

  destroy() {
    for (const team of ['red', 'blue']) {
      for (const bot of this.teams[team].bots) {
        this.ballistics?.unregisterActor?.(bot);
        bot.destroy?.();
        this.engine.actors.delete(bot);
      }
      this.teams[team].bots.length = 0;
      this.teams[team].squads.length = 0;
    }
    this.actorsByTeam.red.clear();
    this.actorsByTeam.blue.clear();
    this.respawnQueue.length = 0;
  }

  setPhase(phase) {
    if (this.phase === phase) return this;
    this.phase = phase;
    this.PhaseChanged.emit(phase);
    return this;
  }

  // ------------------------------------------------------------------ spawning
  /**
   * Creates a bot, registers it with ballistics and slots it into a squad.
   * @param {{team?: string, difficulty?: object, skill?: object, position?: Vector3, name?: string}} [opts]
   */
  spawnBot(opts = {}) {
    const team = opts.team ?? (this.teams.red.bots.length <= this.teams.blue.bots.length ? 'red' : 'blue');
    const spawn = opts.position ?? this.engine.pickSpawnPoint(team, { avoid: this._recentSpawnPoints(team) });
    const difficulty = opts.difficulty ?? BotDifficulty[this.botDifficulty] ?? BotDifficulty.regular;
    const bot = new Bot(this.scene, {
      team,
      name: opts.name ?? `${team === 'red' ? 'R' : 'B'}_${this.teams[team].bots.length + 1}`,
      difficulty: typeof difficulty === 'string' ? difficulty : undefined,
      settings: typeof difficulty === 'object' ? difficulty : opts.skill,
      position: spawn,
      yaw: this.rng.nextNumber(-Math.PI, Math.PI),
      nav: this.nav,
      renderer: this.renderer,
      ballistics: this.ballistics,
      audio: this.audio,
      squad: opts.squad ?? null,
      rng: undefined,
    });
    bot.loadout ??= this.rng.pick(Object.values(LoadoutPresets));
    bot.setLoadout(bot.loadout ?? LoadoutPresets.Rifle);
    bot.registerWith?.(this.ballistics);
    bot.objective = this.objectives.length ? this.objectives[0].position : null;
    // Spawn on the pad the bot was constructed at — `spawn()` with no argument would drop it
    // at the world origin (and stack every bot on top of each other).
    bot.spawn(spawn ?? { position: bot.character.position.clone(), yaw: this.rng.nextNumber(-Math.PI, Math.PI) });
    this.teams[team].bots.push(bot);
    this.actorsByTeam[team].add(bot);
    this.engine.actors.add(bot);
    if (opts.squad) opts.squad.add(bot);
    bot.Killed?.connect?.((event) => this._onBotDeath(bot, event));
    return bot;
  }

  /** Keeps both teams at the configured size (respawn top-up). */
  topUp(count = this.settings.botCount, difficulty = null) {
    const perTeam = Math.max(1, Math.ceil(count / 2));
    const wanted = { red: perTeam, blue: Math.max(1, count - perTeam) };
    for (const team of ['red', 'blue']) {
      const alive = this.teams[team].bots.filter((bot) => bot.health.alive).length;
      const deficit = wanted[team] - alive;
      for (let i = 0; i < deficit; i++) this.spawnBot({ team, difficulty });
    }
    return this.teams.red.bots.length + this.teams.blue.bots.length;
  }

  _ensureSquads(team, count = 2) {
    const squads = this.teams[team].squads;
    while (squads.length < count) squads.push(new Squad({ team, objective: this.objectives[0]?.position ?? null }));
    return squads;
  }

  _recentSpawnPoints(team) {
    const points = [];
    for (const bot of this.teams[team].bots) {
      if (bot.health.alive) points.push(bot.character.position);
    }
    if (this.localPlayer && this.localPlayer.team === team && this.localPlayer.health.alive) points.push(this.localPlayer.character.position);
    return points.slice(0, 6);
  }

  /** Respawns the local player (called by the HUD / controller). */
  requestRespawn(player = this.localPlayer) {
    if (!player) return null;
    if (player.alive) return player;
    const spawn = this.engine.pickSpawnPoint(player.team, { avoid: this._recentSpawnPoints(player.team) });
    player.spawn({ position: spawn, yaw: this.rng.nextNumber(-Math.PI, Math.PI) });
    player.registerWith?.(this.ballistics);
    this.Respawn.emit({ actor: player, position: spawn });
    this.engine.controller?.onRespawn?.();
    return player;
  }

  /** Actors on a team that are alive (spectate targets, scoring). */
  aliveActors(team = null) {
    const out = [];
    for (const actor of this.engine.actors) {
      if (team && actor.team !== team) continue;
      if (actor.health?.alive !== false && actor.state !== PlayerState.Dead) out.push(actor);
    }
    return out;
  }

  enemiesOf(team) {
    const out = [];
    for (const actor of this.engine.actors) {
      if (actor.team === team) continue;
      if (actor.health?.alive === false) continue;
      out.push(actor);
    }
    return out;
  }

  // ------------------------------------------------------------------ per-frame
  update(dt) {
    this.time += dt;
    if (this.phase === MatchPhase.Warmup) {
      this.warmupTime -= dt;
      if (this.warmupTime <= 0) this.setPhase(MatchPhase.Live);
    } else if (this.phase === MatchPhase.Live || this.phase === MatchPhase.Overtime) {
      this.matchTime += dt;
    }

    this._updateBots(dt);
    this._updateRespawns(dt);
    this._updateObjectives(dt);
    this._updatePickups(dt);
    this._updateMatchClock(dt);
    if (this.killFeed.length) {
      for (const entry of this.killFeed) entry.age += dt;
      while (this.killFeed.length && this.killFeed[0].age > 9) this.killFeed.shift();
    }
  }

  _updateBots(dt) {
    const alive = [];
    for (const actor of this.engine.actors) {
      if (actor.health?.alive !== false) alive.push(actor);
    }
    const ctx = {
      players: alive,
      nav: this.nav,
      objective: this._nextObjective()?.position ?? null,
      holdObjectives: this.objectives.filter((o) => o.owner !== 'neutral').map((o) => o.position),
      session: this,
    };
    for (const team of ['red', 'blue']) {
      const entry = this.teams[team];
      for (const squad of entry.squads) squad.update(dt, ctx);
      for (const bot of entry.bots) {
        if (!bot.health.alive) continue;
        bot.think(dt, ctx);
      }
    }
  }

  _updateRespawns(dt) {
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      const entry = this.respawnQueue[i];
      entry.timer -= dt;
      if (entry.timer > 0) continue;
      this.respawnQueue.splice(i, 1);
      if (entry.actor === this.localPlayer) {
        this.requestRespawn(entry.actor);
      } else {
        const spawn = this.engine.pickSpawnPoint(entry.team, { avoid: this._recentSpawnPoints(entry.team) });
        entry.actor.spawn({ position: spawn, yaw: this.rng.nextNumber(-Math.PI, Math.PI) });
        entry.actor.registerWith?.(this.ballistics);
      }
    }
  }

  _onBotDeath(bot, event) {
    void event;
    this.scheduleRespawn(bot, this.respawnTime + this.rng.nextNumber(0, 1.5));
  }

  scheduleRespawn(actor, delay = this.respawnTime) {
    if (this.respawnQueue.some((entry) => entry.actor === actor)) return;
    this.respawnQueue.push({ actor, team: actor.team, timer: delay });
  }

  // ------------------------------------------------------------------ objectives
  _nextObjective() {
    if (!this.objectives.length) return null;
    // Attack the objective the enemy owns, then the closest neutral one.
    const enemyOwned = this.objectives.filter((o) => o.owner === 'red');
    const neutral = this.objectives.filter((o) => o.owner === 'neutral');
    return enemyOwned[0] ?? neutral[0] ?? this.objectives[0];
  }

  _onZoneEnter(objective, instance) {
    const actor = instance?.owner ?? instance;
    if (!actor?.team) return;
    objective.capturers[actor.team] = (objective.capturers[actor.team] ?? 0) + 1;
  }

  _onZoneExit(objective, instance) {
    const actor = instance?.owner ?? instance;
    if (!actor?.team) return;
    objective.capturers[actor.team] = Math.max(0, (objective.capturers[actor.team] ?? 0) - 1);
  }

  _updateObjectives(dt) {
    if (this.mode !== GameMode.Domination) {
      // Team deathmatch still shows capture zones, but they do not score.
      for (const objective of this.objectives) this._trackZone(objective);
      return;
    }
    for (const objective of this.objectives) {
      this._trackZone(objective);
      const red = objective.capturers.red ?? 0;
      const blue = objective.capturers.blue ?? 0;
      objective.contested = red > 0 && blue > 0;
      if (objective.contested || (red === 0 && blue === 0)) continue;
      const team = red > 0 ? 'red' : 'blue';
      const delta = this.captureRate * dt * Math.min(3, Math.max(1, red + blue));
      if (objective.owner === team) {
        objective.progress = clamp01(objective.progress + delta * 0.5);
        continue;
      }
      objective.progress = clamp01(objective.progress + delta);
      if (objective.progress >= 1) {
        objective.owner = team;
        objective.progress = 1;
        this.teams[team].score += 5;
        this.ObjectiveCaptured.emit({ objective, team, session: this });
        this.hud?.notice?.(`${this.teams[team].name} captured ${objective.label}`);
        this.audio?.playObjective?.(team === this.localPlayer?.team ? 'captured' : 'lost');
      }
      // Ownership conversion: progress bleeds back down to 0 before flipping again.
      if (objective.owner !== 'neutral' && objective.owner !== team) {
        objective.progress = clamp01(objective.progress - delta * 1.6);
        if (objective.progress <= 0) objective.owner = 'neutral';
      }
    }
  }

  _trackZone(objective) {
    if (!objective.zone) return;
    const center = objective.zone.worldPosition;
    const half = objective.zone.worldBounds?.max ? objective.zone.worldBounds.max.y : 2;
    void half;
    for (const team of ['red', 'blue']) objective.capturers[team] = 0;
    for (const actor of this.engine.actors) {
      if (actor.health?.alive === false) continue;
      const position = actor.character?.position;
      if (!position) continue;
      const dx = position.x - center.x;
      const dz = position.z - center.z;
      const dy = position.y - (center.y - 1.5);
      if (dx * dx + dz * dz <= 9 && dy > -1.5 && dy < 6) {
        objective.capturers[actor.team] = (objective.capturers[actor.team] ?? 0) + 1;
      }
    }
  }

  // ------------------------------------------------------------------ pickups
  _updatePickups(dt) {
    const pickups = this.scene?.getTagged?.('pickup') ?? [];
    for (const pickup of pickups) {
      const touched = this._pickupTimers.get(pickup);
      if (touched !== undefined) {
        touched.timer -= dt;
        if (touched.timer <= 0) {
          this._pickupTimers.delete(pickup);
          pickup.visible = true;
          pickup.Transparency = pickup.originalTransparency ?? 0;
          this.audio?.playPickupSpawn?.(pickup.worldPosition);
        }
        continue;
      }
      for (const actor of this.engine.actors) {
        if (actor.health?.alive === false) continue;
        const position = actor.character?.position;
        if (!position) continue;
        if (position.distanceTo(pickup.worldPosition) > 1.6) continue;
        this._applyPickup(actor, pickup);
        break;
      }
    }
  }

  _applyPickup(actor, pickup) {
    const kind = (pickup.getTags?.() ?? []).find((tag) => tag.startsWith('pickup:'))?.split(':')[1] ?? 'healthPickup';
    const amount = pickup.amount ?? 25;
    if (kind === 'healthPickup') {
      let healed = 0;
      for (const weapon of Object.values(actor.weapons ?? {})) void weapon;
      healed = actor.health.heal(amount, { source: pickup });
      if (!healed && actor.health.health >= actor.health.maxHealth) return;
    } else if (kind === 'armorPickup') {
      actor.health.addArmor(amount);
    } else if (kind === 'ammoPickup') {
      for (const slot of Object.values(actor.weaponSlots ?? {})) slot?.addAmmo?.(slot.definition.magazineSize * 2);
    }
    pickup.originalTransparency ??= pickup.Transparency ?? 0;
    pickup.visible = false;
    this._pickupTimers.set(pickup, { timer: pickup.respawnTime ?? 25 });
    if (actor.isLocal) this.audio?.playPickup?.(kind);
  }

  // ------------------------------------------------------------------ scoring
  /**
   * Kill feed + scoring. Fired by `BallisticsSystem.Kill`.
   * @param {object} event  `{ killer, victim, weapon, headshot, distance, ... }`
   */
  onKill(event) {
    if (!event) return;
    const killer = event.killer ?? null;
    const victim = event.victim ?? null;
    if (!victim) return;
    const sameTeam = killer && victim && killer.team === victim.team && killer !== victim;
    if (sameTeam && !this.friendlyFire) {
      // A friendly-fire kill still registers a death but scores nothing (and penalises the killer).
      if (killer) this.teams[killer.team].score = Math.max(0, this.teams[killer.team].score - 3);
    } else if (killer && killer !== victim) {
      const base = event.headshot ? 150 : 100;
      const bonus = event.wallbang ? 25 : 0;
      const longshot = (event.distance ?? 0) > 45 ? 25 : 0;
      if (killer.team) this.teams[killer.team].score += base + bonus + longshot;
      if (killer.team) this.teams[killer.team].kills++;
    }
    if (victim.team) this.teams[victim.team].deaths++;

    const entry = {
      killer: killer ? { name: killer.displayName ?? killer.name, team: killer.team } : null,
      victim: { name: victim.displayName ?? victim.name, team: victim.team },
      weapon: event.weapon?.definition?.name ?? event.weapon?.name ?? 'world',
      headshot: !!event.headshot,
      wallbang: !!event.wallbang,
      distance: Math.round(event.distance ?? 0),
      time: this.time,
      age: 0,
    };
    this.killFeed.push(entry);
    if (this.killFeed.length > this.maxKillFeed) this.killFeed.shift();
    this.events.push({ kind: 'kill', ...entry });
    if (this.events.length > 200) this.events.shift();

    // Respawn scheduling for bots and for whoever is not the local player.
    if (victim !== this.localPlayer && victim.isBot) this.scheduleRespawn(victim, this.respawnTime + this.rng.nextNumber(0, 1.5));
    if (killer?.isLocal && victim.team) this.streetFights++;

    this.Kill.emit(entry);
    this._checkMatchEnd();
  }

  _updateMatchClock(dt) {
    if (this.phase !== MatchPhase.Live) return;
    if (this.timeLimit > 0 && this.matchTime >= this.timeLimit) {
      this._endMatch(this.teams.red.score === this.teams.blue.score ? null : this._leadingTeam());
    }
    void dt;
  }

  _checkMatchEnd() {
    if (this.phase === MatchPhase.Over) return;
    const red = this.teams.red.score;
    const blue = this.teams.blue.score;
    if (red >= this.scoreLimit || blue >= this.scoreLimit) {
      this._endMatch(red >= blue ? 'red' : 'blue');
    }
  }

  _leadingTeam() {
    const red = this.teams.red.score;
    const blue = this.teams.blue.score;
    if (red === blue) return null;
    return red > blue ? 'red' : 'blue';
  }

  _endMatch(winner) {
    this.setPhase(MatchPhase.Over);
    this.winner = winner;
    const info = this.getMatchSummary();
    this.MatchOver.emit(info);
    this.hud?.setMatchOver?.(info);
    log.info(`match over — winner ${winner ?? 'draw'} (${info.red.score} : ${info.blue.score})`);
  }

  /** Restarts the match (post-game screen / editor "play again"). */
  restart() {
    for (const objective of this.objectives) {
      objective.owner = 'neutral';
      objective.progress = 0;
      objective.capturers = { red: 0, blue: 0 };
    }
    for (const team of ['red', 'blue']) {
      this.teams[team].score = 0;
      this.teams[team].kills = 0;
      this.teams[team].deaths = 0;
    }
    this.killFeed.length = 0;
    this.matchTime = 0;
    this.round++;
    this.winner = null;
    this.setPhase(MatchPhase.Warmup);
    this.warmupTime = this.warmupTime0 ?? 3;
    for (const actor of this.engine.actors) {
      if (actor.isLocal) this.requestRespawn(actor);
      else if (actor.isBot) {
        actor.spawn({ position: this.engine.pickSpawnPoint(actor.team, {}), yaw: this.rng.nextNumber(-Math.PI, Math.PI) });
      }
    }
    return this;
  }

  // ------------------------------------------------------------------ reporting
  getMatchSummary() {
    return {
      mode: this.mode,
      phase: this.phase,
      round: this.round,
      winner: this.winner ?? null,
      time: this.matchTime,
      red: { ...this.teams.red, score: this.teams.red.score, kills: this.teams.red.kills },
      blue: { ...this.teams.blue, score: this.teams.blue.score, kills: this.teams.blue.kills },
      objectives: this.objectives.map((o) => ({ label: o.label, owner: o.owner, progress: o.progress })),
    };
  }

  /** Rows for the scoreboard, best first (score, then kills, then fewest deaths). */
  getScoreboard() {
    const rows = [];
    for (const actor of this.engine.actors) {
      if (!actor.team) continue;
      rows.push({
        name: actor.displayName ?? actor.name,
        team: actor.team,
        kills: actor.kills ?? 0,
        deaths: actor.deaths ?? 0,
        assists: actor.assists ?? 0,
        score: actor.score ?? 0,
        ping: actor.ping ?? (actor.isBot ? 0 : Math.round(this.engine.net?.ping ?? 0)),
        isLocal: !!actor.isLocal,
        isBot: !!actor.isBot,
        alive: actor.health?.alive !== false,
        streak: actor.streak ?? 0,
        weapon: actor.weapon?.definition?.name ?? null,
      });
    }
    rows.sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
    return rows;
  }

  getKillFeed() { return this.killFeed; }

  getStats() {
    return {
      phase: this.phase,
      time: this.matchTime,
      red: this.teams.red.score,
      blue: this.teams.blue.score,
      bots: this.teams.red.bots.length + this.teams.blue.bots.length,
      alive: this.aliveActors().length,
      objectives: this.objectives.map((o) => `${o.label}:${o.owner}`).join(' '),
      ballistics: this.ballistics?.getStats?.() ?? null,
    };
  }

  serialize() {
    return {
      mode: this.mode,
      phase: this.phase,
      time: this.matchTime,
      teams: { red: { score: this.teams.red.score }, blue: { score: this.teams.blue.score } },
      objectives: this.objectives.map((o) => ({ label: o.label, owner: o.owner, progress: o.progress })),
    };
  }
}

export { BotDifficulty, clamp };
export default PlaySession;
