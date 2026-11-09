/**
 * OminX Engine — headless match runner.
 *
 * The server-side simulation. It builds a scene from the same `LevelBuilder` the browser uses,
 * spawns real `Player`/`Bot` instances (the very same gameplay classes, no renderer, no camera, no
 * DOM), and ticks them at a fixed rate. Everything that decides the outcome of a match happens
 * here: movement integration from client input, hit resolution through `BallisticsSystem`, health,
 * death, respawns, scoring, captures and phase transitions.
 *
 * The runner is transport-agnostic — `MatchServer` feeds it input frames and reads snapshots — so a
 * soak test, a headless CI match and a live server all run the same code.
 *
 * @module server/src/MatchRunner
 */
import { Scene } from '../../engine/src/world/Scene.js';
import { LevelBuilder, MapKind } from '../../engine/src/world/LevelBuilder.js';
import { BallisticsSystem } from '../../engine/src/gameplay/Ballistics.js';
import { Player, LoadoutPresets } from '../../engine/src/gameplay/Player.js';
import { Bot } from '../../engine/src/gameplay/Bot.js';
import { RNG } from '../../engine/src/math/Random.js';
import { Vector3 } from '../../engine/src/math/Vector3.js';
import { clamp, clamp01 } from '../../engine/src/math/MathUtils.js';
import { createLogger } from '../../engine/src/core/Logger.js';
import { actorFlags, numericId } from '../../src/net/Protocol.js';
import { angleDelta } from './protocol.js';

const log = createLogger('MatchRunner');

export const MatchPhase = {
  Warmup: 'warmup',
  Live: 'live',
  Intermission: 'intermission',
  Over: 'over',
};

export const MatchMode = { TDM: 'tdm', Domination: 'domination', FFA: 'ffa', Skirmish: 'skirmish' };

/** Beyond this distance a spawn is "as safe as it gets"; keeps spawn pads from polarising. */
const SPAWN_SAFETY_RANGE = 34;

const SCORE = { kill: 100, headshot: 150, wallbang: 25, longshot: 25, capture: 5, assist: 25, suicide: -10, teamKill: -50 };
const RESPAWN_TIME = 4;

export class MatchRunner {
  /**
   * @param {object} [opts] `{ map, seed, bots, difficulty, mode, scoreLimit, timeLimit, maxPlayers, tickRate }`
   */
  constructor(opts = {}) {
    this.options = {
      map: MapKind.Urban,
      seed: 21,
      bots: 8,
      difficulty: 'regular',
      mode: MatchMode.TDM,
      scoreLimit: 60,
      timeLimit: 600,
      maxPlayers: 16,
      tickRate: 60,
      warmup: 5,
      loadout: 'assault',
      ...opts,
    };
    this.rng = new RNG(this.options.seed);
    this.tickRate = this.options.tickRate;
    this.step = 1 / this.tickRate;
    this.tick = 0;
    this.time = 0;
    this.phase = MatchPhase.Warmup;
    this.phaseTime = this.options.warmup;
    this.clients = new Map(); // id → client record
    this.players = new Set();
    this.events = []; // drained by the transport every tick
    this.scoreboardDirty = false;
    this._nextPlayerId = 1;
    this._buildWorld();
    this.spawnBots();
    log.info(`match ready — ${this.options.mode} on ${this.options.map} (seed ${this.options.seed}), ${this.bots.length} bots`);
  }

  // ------------------------------------------------------------------ world
  _buildWorld() {
    this.scene = new Scene({ Name: `Server_${this.options.map}` });
    this.scene.objectives = [];
    const builder = new LevelBuilder(this.scene, { kind: this.options.map, seed: this.options.seed });
    const built = builder.build({ withNav: true });
    this.nav = built.nav;
    this.spawns = built.spawns;
    // `LevelBuilder` hands out descriptors `{ label, position, zone }`. The match needs its own
    // mutable capture state on top (owner/progress/capturers), exactly like `PlaySession` has.
    this.objectives = (built.objectives ?? []).map((objective) => ({
      label: objective.label,
      position: objective.position?.clone ? objective.position.clone() : new Vector3(objective.position?.x ?? 0, 0, objective.position?.z ?? 0),
      zone: objective.zone ?? null,
      owner: 'neutral',
      progress: 0,
      contested: false,
      capturers: { red: 0, blue: 0 },
    }));
    this.captureRate = this.options.captureRate ?? 0.35;
    this.scene.objectives = this.objectives;
    this.mapStats = built.stats;
    this.ballistics = new BallisticsSystem(this.scene, {
      renderer: null,
      audio: null,
      particles: null,
      decals: null,
      rng: this.rng,
    });
    this.ballistics.Kill.connect((event) => this._onKill(event));
    this.ballistics.ActorHit.connect((event) => this._onActorHit(event));
    this.bots = [];
    this.teams = { red: [], blue: [] };
    this.scores = { red: 0, blue: 0 };
    /** Round-robin cursor for opening spawns, so a squad spreads over the front-line pads. */
    this._spawnCursor = { red: 0, blue: 0 };
  }

  get spawnList() { return this.spawns; }

  /**
   * Chooses where a player (or bot) enters the map.
   *
   * Two regimes, because they want opposite things:
   *   - **Opening spawn** (no threats): the pads nearest the objectives, cycled, so a round starts
   *     at the front line instead of with a 40 second cross-map sprint.
   *   - **Respawn** (threats alive): safe but not exiled — clearance is rewarded up to 34 m, and
   *     the far corner is penalised so a death never means a full-map commute back.
   *
   * Every pad is snapped onto the nav mesh first, so a pad authored inside geometry or on a ledge
   * can never trap a player.
   */
  pickSpawn(team = 'blue', avoid = []) {
    const pads = this.spawns[team] ?? [];
    if (!pads.length) return new Vector3(0, 0.4, 0);
    const candidates = [];
    for (const pad of pads) {
      const point = this._safeSpawnPoint(pad);
      if (!point) continue;
      let threatDistance = Infinity;
      for (const threat of avoid) {
        const position = threat.character?.position ?? threat.position ?? threat;
        threatDistance = Math.min(threatDistance, point.distanceTo(position));
      }
      candidates.push({ pad, point, threatDistance });
    }
    if (!candidates.length) return new Vector3(0, 0.4, 0);
    return avoid.length ? this._safestSpawn(candidates) : this._frontLineSpawn(team, candidates);
  }

  /** Opening spawn: the pads nearest the fight, cycled so a squad never stacks on one pad. */
  _frontLineSpawn(team, candidates) {
    const targets = [];
    for (const objective of this.objectives) {
      const position = objective.position ?? objective.zone?.worldPosition;
      if (position) targets.push({ x: position.x, z: position.z });
    }
    if (!targets.length) targets.push({ x: 0, z: 0 });
    const frontier = (point) => {
      let best = Infinity;
      for (const target of targets) best = Math.min(best, Math.hypot(point.x - target.x, point.z - target.z));
      return best;
    };
    let closest = Infinity;
    for (const candidate of candidates) closest = Math.min(closest, frontier(candidate.point));
    const front = candidates.filter((candidate) => frontier(candidate.point) <= closest + 6);
    this._spawnCursor[team] = (this._spawnCursor[team] ?? 0) + 1;
    return front[this._spawnCursor[team] % front.length].point;
  }

  /** Respawn: rewards 12–34 m of clearance and punishes the far corner. */
  _safestSpawn(candidates) {
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      let score = this.rng.nextNumber(0, 0.8) + ((candidate.pad.Priority ?? 1) - 1) * 2;
      score += Math.min(candidate.threatDistance, SPAWN_SAFETY_RANGE) * 0.3;
      score -= Math.max(0, candidate.threatDistance - SPAWN_SAFETY_RANGE * 1.7) * 0.25;
      if (candidate.threatDistance < 12) score -= 40;
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    return best.point;
  }

  /** Snaps a pad to walkable ground, or rejects it when there is no navigation nearby. */
  _safeSpawnPoint(pad) {
    const point = pad.getSpawnPoint();
    const nav = this.nav;
    if (!nav?.nodes?.length) return point;
    const node = nav.nearestNode(point, { maxDistance: 3.5 });
    if (!node) return null;
    return new Vector3(node.position.x, node.position.y + 0.05, node.position.z);
  }

  // ------------------------------------------------------------------ players
  /**
   * Adds a human player (the caller's socket) to the match.
   * @returns {object} the player record
   */
  addPlayer({ id = null, name = 'Player', team = null } = {}) {
    const playerId = id ?? `p${this._nextPlayerId++}`;
    const assigned = team ?? this._autoTeam();
    const point = this.pickSpawn(assigned);
    const player = new Player(this.scene, {
      ballistics: this.ballistics,
      input: null,
      audio: null,
      hud: null,
      camera: null,
      renderer: null,
      position: point,
      team: assigned,
      isLocal: false,
      name,
      maxHealth: 100,
    });
    player.setLoadout(this.options.loadout ?? 'assault');
    player.spawn({ position: point.clone(), yaw: this.rng.nextNumber(-Math.PI, Math.PI) });
    player.netId = playerId;
    player.isBot = false;
    player.inputQueue = [];
    player.lastProcessedInput = 0;
    player.lastInputSequence = 0;
    player.lastRequestAt = Date.now();
    this.players.add(player);
    this.teams[assigned].push(player);
    player.registerWith(this.ballistics);
    this.emit('join', { id: playerId, name, team: assigned });
    this.scoreboardDirty = true;
    log.info(`${name} (${playerId}) joined ${assigned}`);
    return { id: playerId, name, team: assigned, player };
  }

  removePlayer(id) {
    const player = [...this.players].find((candidate) => candidate.netId === id);
    if (!player) return false;
    this.players.delete(player);
    for (const team of ['red', 'blue']) {
      const index = this.teams[team].indexOf(player);
      if (index >= 0) this.teams[team].splice(index, 1);
    }
    player.destroy?.();
    this.emit('leave', { id, name: player.name });
    this.scoreboardDirty = true;
    return true;
  }

  _autoTeam() {
    const red = this.teams.red.length;
    const blue = this.teams.blue.length;
    return red <= blue ? 'red' : 'blue';
  }

  spawnBots(count = this.options.bots) {
    const difficulty = this.options.difficulty;
    for (let i = 0; i < count; i++) {
      const team = i % 2 === 0 ? 'red' : 'blue';
      const point = this.pickSpawn(team);
      const bot = new Bot(this.scene, {
        ballistics: this.ballistics,
        position: point,
        team,
        difficulty,
        skill: difficulty,
        // Deterministic seed: the same match seed must produce the same bots, shot for shot.
        seed: (this.options.seed * 131 + i * 7 + 3) >>> 0,
        name: `${team === 'red' ? 'Red' : 'Blue'}Bot_${Math.floor(i / 2) + 1}`,
        isLocal: false,
      });
      bot.setLoadout(this.rng.pick(Object.values(LoadoutPresets)));
      bot.spawn({ position: point.clone(), yaw: this.rng.nextNumber(-Math.PI, Math.PI) });
      bot.netId = `b${i + 1}`;
      bot.isBot = true;
      bot.respawnTimer = 0;
      this.bots.push(bot);
      this.players.add(bot);
      this.teams[team].push(bot);
      bot.registerWith(this.ballistics);
    }
    this.scoreboardDirty = true;
    return this.bots;
  }

  /** Resizes the bot population (server console `bots <n>`). */
  setBotCount(count) {
    const target = clamp(Math.round(count), 0, 32);
    while (this.bots.length > target) {
      const bot = this.bots.pop();
      this.removePlayer(bot.netId);
    }
    while (this.bots.length < target) {
      const team = this._autoTeam();
      const point = this.pickSpawn(team);
      const bot = new Bot(this.scene, {
        ballistics: this.ballistics,
        position: point,
        team,
        difficulty: this.options.difficulty,
        seed: (this.options.seed * 131 + this.bots.length * 7 + 3) >>> 0,
        name: `${team}Bot_${this.bots.length + 1}`,
      });
      bot.setLoadout(this.rng.pick(Object.values(LoadoutPresets)));
      bot.spawn({ position: point.clone(), yaw: this.rng.nextNumber(-Math.PI, Math.PI) });
      bot.netId = `b${++this._nextPlayerId}`;
      bot.isBot = true;
      bot.respawnTimer = 0;
      this.bots.push(bot);
      this.players.add(bot);
      this.teams[team].push(bot);
      bot.registerWith(this.ballistics);
    }
    this.options.bots = target;
    this.scoreboardDirty = true;
    return this.bots.length;
  }

  /** Queues a client input frame; consumed on the next tick (never more than 4 to avoid speed hacks). */
  queueInput(id, frame) {
    const player = [...this.players].find((candidate) => candidate.netId === id);
    if (!player || player.isBot) return false;
    const queue = player.inputQueue;
    if (frame.sequence <= player.lastInputSequence) return false;
    player.lastInputSequence = frame.sequence;
    player.lastRequestAt = Date.now();
    queue.push(frame);
    if (queue.length > 4) queue.splice(0, queue.length - 4);
    return true;
  }

  // ------------------------------------------------------------------ simulation
  /** Advances the match by exactly one tick. */
  update() {
    this.tick++;
    this.time += this.step;
    this._updatePhase();
    this._applyInputs();
    this._thinkBots();
    this.scene.update(this.step);
    this.ballistics.update(this.step);
    // Humans integrate their latest input; bots were already advanced by `think()` above
    // (which calls `Player.update` itself), so they must not be stepped twice.
    for (const player of this.players) {
      if (player.isBot) continue;
      player.update(this.step, player.activeInput ?? {});
    }
    this._updateRespawns();
    this._updateObjectives();
    if (this.tick % (this.tickRate * 5) === 0) this.scoreboardDirty = true;
    return this;
  }

  _updatePhase() {
    if (this.phase === MatchPhase.Warmup) {
      this.phaseTime -= this.step;
      if (this.phaseTime <= 0) {
        this.phase = MatchPhase.Live;
        this.phaseTime = this.options.timeLimit;
        this.emit('phase', { phase: this.phase, time: this.phaseTime });
        log.info('match live');
      }
      return;
    }
    if (this.phase === MatchPhase.Live) {
      this.phaseTime -= this.step;
      const winner = this._checkVictory();
      if (winner) this._endMatch(winner);
      else if (this.phaseTime <= 0) this._endMatch(this.scores.red === this.scores.blue ? 'draw' : (this.scores.red > this.scores.blue ? 'red' : 'blue'));
    }
  }

  _checkVictory() {
    if (this.options.mode === MatchMode.FFA) {
      const best = this._ranked()[0];
      if (best && best.score >= this.options.scoreLimit) return best.team;
      return null;
    }
    if (this.scores.red >= this.options.scoreLimit) return 'red';
    if (this.scores.blue >= this.options.scoreLimit) return 'blue';
    return null;
  }

  _endMatch(winner) {
    this.phase = MatchPhase.Over;
    this.phaseTime = 0;
    this.emit('phase', { phase: this.phase, winner, scores: { ...this.scores } });
    log.info(`match over — ${winner} wins ${this.scores.red}:${this.scores.blue}`);
  }

  /** Re-runs the warmup so the server can host back-to-back matches. */
  restart() {
    this.scores.red = 0;
    this.scores.blue = 0;
    for (const player of this.players) {
      player.kills = 0;
      player.deaths = 0;
      player.score = 0;
      player.spawn({ position: this.pickSpawn(player.team), yaw: this.rng.nextNumber(-Math.PI, Math.PI) });
    }
    this.phase = MatchPhase.Warmup;
    this.phaseTime = this.options.warmup;
    this.tick = 0;
    this.emit('phase', { phase: this.phase, time: this.phaseTime });
    log.info('match restarted');
  }

  _applyInputs() {
    for (const player of this.players) {
      if (player.isBot) continue;
      const frame = player.inputQueue.shift();
      if (!frame) {
        // No input this tick: keep simulating with the last known input so the player coasts
        // instead of freezing (a 1-frame network hiccup must not look like a teleport).
        player.activeInput = { ...(player.activeInput ?? {}), fire: false };
        continue;
      }
      player.lastProcessedInput = frame.sequence;
      // Clients send absolute aim (quantised); `Player` consumes per-tick deltas.
      const yawDelta = angleDelta(player.yaw, frame.yaw);
      const pitchDelta = clamp(frame.pitch - player.pitch, -0.6, 0.6);
      player.activeInput = {
        moveX: frame.moveX,
        moveY: frame.moveY,
        look: { yaw: yawDelta, pitch: pitchDelta },
        fire: !!frame.fire,
        aim: !!frame.aim,
        sprint: !!frame.sprint,
        crouch: !!frame.crouch,
        jump: !!frame.jump,
      };
    }
  }

  _thinkBots() {
    const ctx = {
      players: [...this.players],
      nav: this.nav,
      objective: this._botObjective(),
      holdObjectives: this.options.mode === MatchMode.Domination,
      session: this,
    };
    for (const bot of this.bots) {
      if (!bot.health.alive) continue;
      // Per-team objective: bots attack what the enemy holds, not where their own team stands.
      ctx.objective = this._objectiveFor(bot.team);
      bot.think(this.step, ctx);
    }
    for (const squad of this.squads ?? []) {
      squad.update?.(this.step, { objective: this._objectiveFor(squad.team ?? 'red'), holdObjectives: ctx.holdObjectives });
    }
  }

  _botObjective(team = null) {
    if (!this.objectives.length) return null;
    // Bots push an objective that is not theirs: enemy-held first, then neutral, then anything.
    const enemyHeld = this.objectives.filter((objective) => team ? objective.owner !== team && objective.owner !== 'neutral' : objective.owner !== 'neutral');
    const neutral = this.objectives.filter((objective) => objective.owner === 'neutral');
    const target = enemyHeld[0] ?? neutral[0] ?? this.objectives[0];
    return target.position;
  }

  /** Team-aware objective context for a squad of bots. */
  _objectiveFor(team) {
    return this._botObjective(team) ?? this.objectives[0]?.position ?? null;
  }

  _updateRespawns() {
    for (const player of this.players) {
      if (player.health.alive) continue;
      player.respawnTimer = (player.respawnTimer ?? RESPAWN_TIME) - this.step;
      if (player.respawnTimer > 0) continue;
      player.respawnTimer = RESPAWN_TIME;
      if (player.isBot) player.spawn({ position: this.pickSpawn(player.team, this._enemyPositions(player.team)), yaw: this.rng.nextNumber(-Math.PI, Math.PI) });
      else {
        this.emit('respawn', {
          id: player.netId,
          position: this.pickSpawn(player.team, this._enemyPositions(player.team)).toArray(),
          yaw: this.rng.nextNumber(-Math.PI, Math.PI),
        });
      }
    }
  }

  _enemyPositions(team) {
    const enemy = team === 'red' ? 'blue' : 'red';
    return this.teams[enemy].filter((player) => player.health.alive).map((player) => player.character.position);
  }

  _updateObjectives() {
    if (!this.objectives.length) return;
    const scoring = this.options.mode === MatchMode.Domination;
    for (const objective of this.objectives) {
      const zone = objective.zone;
      const occupants = { red: 0, blue: 0 };
      for (const player of this.players) {
        if (!player.health.alive) continue;
        if (!this._insideZone(zone, objective, player.character.position)) continue;
        occupants[player.team] = (occupants[player.team] ?? 0) + 1;
      }
      objective.capturers = occupants;
      const red = occupants.red ?? 0;
      const blue = occupants.blue ?? 0;
      objective.contested = red > 0 && blue > 0;
      if (objective.contested || (red === 0 && blue === 0)) {
        // Nobody (or both teams) on the point: progress holds but does not advance.
        objective.progress = clamp01(objective.progress);
        continue;
      }
      const team = red > 0 ? 'red' : 'blue';
      const delta = this.captureRate * this.step * (1 + Math.min(2, (red + blue) - 1) * 0.5);
      if (objective.owner === team) {
        objective.progress = clamp01(objective.progress + delta * 0.4);
        continue;
      }
      const before = objective.progress;
      objective.progress = clamp01(objective.progress + delta);
      if (Math.floor(before * 4) !== Math.floor(objective.progress * 4)) {
        this.emit('objective', { label: objective.label, owner: objective.owner, progress: objective.progress, capturing: team });
      }
      if (objective.progress >= 1) {
        // Only a completed capture takes the point; progress (not the team score) flips first.
        const previous = objective.owner;
        objective.owner = team;
        if (scoring) this.scores[team] = (this.scores[team] ?? 0) + SCORE.capture;
        this.emit('objective', { label: objective.label, owner: team, previous, progress: 1, captured: true });
        this.scoreboardDirty = true;
      }
    }
  }

  /** Horizontal containment with a vertical band: a player's feet sit on the pad surface. */
  _insideZone(zone, objective, position) {
    if (!zone) {
      const half = 3;
      return Math.abs(position.x - objective.position.x) <= half && Math.abs(position.z - objective.position.z) <= half;
    }
    const center = zone.worldPosition;
    const size = zone.Size ?? { x: 6, y: 3, z: 6 };
    if (Math.abs(position.x - center.x) > size.x * 0.5) return false;
    if (Math.abs(position.z - center.z) > size.z * 0.5) return false;
    const feet = position.y;
    return feet >= center.y - size.y * 0.5 - 1.2 && feet <= center.y + size.y * 0.5;
  }

  // ------------------------------------------------------------------ scoring
  _onActorHit(event) {
    const attacker = event.attacker ?? event.source ?? null;
    const victim = event.actor ?? event.victim ?? null;
    if (!attacker || !victim || attacker === victim) return;
    attacker.damageDealt = (attacker.damageDealt ?? 0) + (event.applied ?? event.damage ?? 0);
    this.emit('hit', {
      attacker: attacker.netId ?? null,
      victim: victim.netId ?? null,
      damage: Math.round(event.applied ?? event.damage ?? 0),
      headshot: !!event.headshot,
      lethal: !victim.health?.alive,
    });
  }

  _onKill(event) {
    const killer = event.killer ?? event.attacker ?? null;
    const victim = event.victim ?? event.player ?? null;
    const headshot = !!event.headshot;
    const wallbang = !!event.wallbang;
    const distance = event.distance ?? (killer && victim ? killer.character.position.distanceTo(victim.character.position) : 0);
    if (victim) {
      victim.deaths = (victim.deaths ?? 0) + 1;
      this.emit('death', { id: victim.netId ?? null, killer: killer?.netId ?? null, position: victim.character.position.toArray() });
    }
    if (killer && victim && killer.team === victim.team && killer !== victim) {
      this.scores[killer.team] += SCORE.teamKill;
      killer.score = (killer.score ?? 0) + SCORE.teamKill;
      this.emit('kill', { killer: killer.name, victim: victim.name, weapon: event.weapon?.name ?? 'weapon', teamKill: true, headshot, wallbang, distance: Math.round(distance) });
      this.scoreboardDirty = true;
      return;
    }
    if (killer && victim && killer !== victim) {
      let points = SCORE.kill + (headshot ? SCORE.headshot - SCORE.kill : 0) + (wallbang ? SCORE.wallbang : 0) + (distance > 45 ? SCORE.longshot : 0);
      if (this.options.mode === MatchMode.FFA) {
        killer.score = (killer.score ?? 0) + points;
      } else {
        this.scores[killer.team] = (this.scores[killer.team] ?? 0) + Math.round(points / 10);
        killer.score = (killer.score ?? 0) + points;
      }
      killer.kills = (killer.kills ?? 0) + 1;
      killer.streak = (killer.streak ?? 0) + 1;
      this.emit('kill', {
        killer: killer.name ?? '?', victim: victim.name ?? '?',
        killerId: killer.netId, victimId: victim.netId,
        weapon: event.weapon?.name ?? event.weaponName ?? 'weapon',
        headshot, wallbang, distance: Math.round(distance),
        points,
      });
      this.scoreboardDirty = true;
      return;
    }
    // Suicide / environmental death.
    if (victim) {
      victim.score = (victim.score ?? 0) + SCORE.suicide;
      if (this.options.mode === MatchMode.FFA) victim.score += SCORE.suicide;
      else this.scores[victim.team] += Math.round(SCORE.suicide / 10);
      this.emit('kill', { killer: '', victim: victim.name, weapon: event.weapon?.name ?? 'world', suicide: true });
      this.scoreboardDirty = true;
    }
  }

  // ------------------------------------------------------------------ output
  /** Current ranked scoreboard (score → kills → deaths). */
  _ranked() {
    return [...this.players]
      .map((player) => ({
        id: player.netId,
        name: player.name ?? 'Player',
        team: player.team,
        kills: player.kills ?? 0,
        deaths: player.deaths ?? 0,
        score: player.score ?? 0,
        ping: player.ping ?? 0,
        bot: !!player.isBot,
        alive: !!player.health.alive,
        weapon: player.weapon?.definition?.name ?? null,
        damage: Math.round(player.damageDealt ?? 0),
      }))
      .sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
  }

  getScoreboard() {
    return {
      mode: this.options.mode,
      phase: this.phase,
      time: Math.max(0, Math.round(this.phaseTime)),
      scores: { ...this.scores },
      scoreLimit: this.options.scoreLimit,
      players: this._ranked().slice(0, this.options.maxPlayers * 2),
      objectives: this.objectives.map((objective) => ({ label: objective.label, owner: objective.owner, progress: Math.round(objective.progress * 100) / 100, contested: objective.contested })),
    };
  }

  /** Binary snapshot payload for the transport. */
  buildSnapshot() {
    return {
      tick: this.tick & 0xffffffff,
      serverTime: this.time,
      phase: Object.values(MatchPhase).indexOf(this.phase),
      actors: [...this.players].map((player) => ({
        netId: numericId(player.netId),
        id: numericId(player.netId),
        position: player.character.position,
        yaw: player.look?.yaw ?? player.yaw ?? 0,
        pitch: player.look?.pitch ?? player.pitch ?? 0,
        healthValue: player.health.health,
        armorValue: player.health.armor,
        velocity: player.character.velocity,
        team: player.team,
        weaponIndex: player.currentSlot ?? 0,
        lastProcessedInput: player.lastProcessedInput ?? 0,
        flags: actorFlags(player),
      })),
    };
  }

  /** Pushes an outbound event for the transport to broadcast. */
  emit(type, payload) {
    this.events.push({ type, payload, tick: this.tick });
    return this;
  }

  drainEvents() {
    if (!this.events.length) return [];
    const events = this.events;
    this.events = [];
    return events;
  }

  get playerCount() { return this.players.size; }
  get humanCount() { return [...this.players].filter((player) => !player.isBot).length; }
  get stats() {
    return {
      tick: this.tick,
      players: this.players.size,
      bots: this.bots.length,
      phase: this.phase,
      score: { ...this.scores },
      mapParts: this.mapStats?.parts ?? 0,
      shots: this.ballistics?.stats?.shots ?? 0,
      hits: this.ballistics?.stats?.hits ?? 0,
      kills: this.ballistics?.stats?.kills ?? 0,
    };
  }
}

export { SCORE, RESPAWN_TIME, clamp01 };
export default MatchRunner;
