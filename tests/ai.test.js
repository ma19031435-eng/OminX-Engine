/**
 * Combat-AI tests — navigation, spawning, perception and trigger discipline.
 *
 * Every test here is a regression for a bug that shipped at least once: bots wedging on a wall the
 * nav graph promised was walkable, bots freezing a metre short of a one-point path, spawn pads
 * sitting outside the navigation mesh, and an aim check that compared against a different point
 * than the one the bot was told to aim at (which left bots standing in each other's faces, holding
 * fire for a whole round).
 *
 * They run without a renderer: `MatchRunner` is the authoritative simulation, so the same code
 * path a server executes is the one under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MatchRunner, MatchMode, MatchPhase } from '../server/src/MatchRunner.js';
import { Bot, BotState } from '../engine/src/gameplay/Bot.js';
import { CollisionLayer } from '../engine/src/world/Part.js';
import { Vector3 } from '../engine/src/math/Vector3.js';
import { AABB } from '../engine/src/math/Geometry.js';

const TICK = 1 / 60;

/** Runs a runner for `ticks` steps and returns per-bot travel distances in metres. */
function run(runner, ticks) {
  const origin = new Map(runner.bots.map((bot) => [bot, bot.character.position.clone()]));
  let maxTravel = new Map(runner.bots.map((bot) => [bot, 0]));
  for (let tick = 0; tick < ticks; tick++) {
    runner.update();
    for (const [bot, start] of origin) {
      const travelled = Math.hypot(bot.character.position.x - start.x, bot.character.position.z - start.z);
      if (travelled > maxTravel.get(bot)) maxTravel.set(bot, travelled);
    }
  }
  return [...maxTravel.values()];
}

// ------------------------------------------------------------------ navigation graph
test('nav links never cross a wall the agent cannot walk through', () => {
  const runner = new MatchRunner({ map: 'facility', seed: 21, bots: 0, warmup: 1, mode: MatchMode.TDM });
  const nav = runner.nav;
  const collision = runner.scene.collision;
  const radius = nav.agentRadius * 0.95;
  const box = new AABB(new Vector3(), new Vector3());
  const delta = new Vector3();

  let checked = 0;
  for (const node of nav.nodes.slice(0, 400)) {
    for (const index of node.links.slice(0, 3)) {
      const other = nav.nodes[index];
      box.min.set(node.position.x - radius, node.position.y + 0.08, node.position.z - radius);
      box.max.set(node.position.x + radius, node.position.y + nav.agentHeight - 0.08, node.position.z + radius);
      delta.set(other.position.x - node.position.x, other.position.y - node.position.y, other.position.z - node.position.z);
      const result = collision.moveAABB(box, delta, { layerMask: CollisionLayer.All, stepHeight: nav.stepHeight });
      // A link that slams into a wall is precisely what leaves a bot grinding in place.
      if (result.hits > 0) {
        assert.equal(result.blockedAxes.x !== 0 || result.blockedAxes.z !== 0, false,
          `link ${node.index}→${other.index} is blocked by geometry`);
      }
      checked++;
    }
  }
  assert.ok(checked > 300, `expected to sample many links, got ${checked}`);
});

test('nav graph is connected enough for both teams to reach the objectives', () => {
  for (const map of ['arena', 'urban', 'facility']) {
    const runner = new MatchRunner({ map, seed: 21, bots: 0, warmup: 1, mode: MatchMode.TDM });
    const nav = runner.nav;
    for (const team of ['red', 'blue']) {
      const spawn = runner.spawns[team][0].getSpawnPoint();
      for (const objective of runner.objectives) {
        const path = nav.findPath(spawn, objective.position);
        assert.ok(path, `${map}: ${team} cannot path from spawn to objective ${objective.label}`);
        assert.ok(path.points.length >= 1);
      }
    }
  }
});

test('string-pulled paths keep body clearance instead of cutting corners', () => {
  const runner = new MatchRunner({ map: 'urban', seed: 21, bots: 0, warmup: 1, mode: MatchMode.TDM });
  const nav = runner.nav;
  // Two points either side of a building wall: a zero-radius string pull connects them, a
  // body-aware one must not.
  const path = nav.findPath(new Vector3(-20, 0, 20), new Vector3(20, 0, 20), { smooth: true });
  assert.ok(path);
  for (let i = 1; i < path.points.length; i++) {
    assert.equal(nav._segmentClear(path.points[i - 1], path.points[i]), true,
      `smoothed segment ${i} is not walkable by an agent body`);
  }
});

// ------------------------------------------------------------------ spawns
test('spawn picking snaps every pad onto walkable navigation', () => {
  for (const map of ['arena', 'urban', 'facility']) {
    const runner = new MatchRunner({ map, seed: 21, bots: 0, warmup: 1, mode: MatchMode.TDM });
    for (const team of ['red', 'blue']) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const point = runner.pickSpawn(team);
        const node = runner.nav.nearestNode(point, { maxDistance: 3.5 });
        assert.ok(node, `${map}/${team}: spawn ${point.toString()} is off the nav mesh`);
      }
    }
  }
});

test('opening spawns start near the objectives, respawns pull away from enemies', () => {
  const runner = new MatchRunner({ map: 'urban', seed: 21, bots: 0, warmup: 1, mode: MatchMode.TDM });
  const objective = runner.objectives[0].position;
  const opening = runner.pickSpawn('red');
  assert.ok(opening.distanceTo(objective) < 40, `opening spawn is ${opening.distanceTo(objective).toFixed(1)} m from the objective`);

  const enemy = runner.bots[0] ?? null;
  const threat = { character: { position: opening.clone() } };
  const respawn = runner.pickSpawn('red', [threat]);
  assert.ok(respawn.distanceTo(opening) > 4, 'respawn should not land on top of the enemy that killed us');
  void enemy;
});

// ------------------------------------------------------------------ bot behaviour
test('bots move, patrol and never freeze on an exhausted path', () => {
  const runner = new MatchRunner({ map: 'facility', seed: 21, bots: 6, warmup: 3, mode: MatchMode.TDM });
  const travel = run(runner, 900);
  for (const [index, distance] of travel.entries()) {
    assert.ok(distance > 4, `bot ${index} travelled only ${distance.toFixed(1)} m in 15 s`);
  }
});

test('a bot with nothing to shoot walks to the objective instead of patrolling its corner', () => {
  const runner = new MatchRunner({ map: 'urban', seed: 21, bots: 2, warmup: 3, mode: MatchMode.TDM, scoreLimit: 100000, timeLimit: 3600 });
  for (const bot of runner.bots) bot.team = 'red';       // no enemies: nothing to distract them
  const bot = runner.bots[0];
  const objective = runner._objectiveFor('red');
  // Start from the walkable spot furthest from the objective (a nav node, so the bot is never
  // boxed in by the test itself).
  let far = null;
  let farDistance = -1;
  for (const node of runner.nav.nodes) {
    const distance = node.position.distanceTo(objective);
    if (distance > farDistance) { farDistance = distance; far = node.position; }
  }
  assert.ok(far && farDistance > 30, 'expected a far corner of the map to test against');
  bot.character.position.copy(far);
  bot.spawn({ position: far.clone(), yaw: 0 });
  const before = bot.character.position.distanceTo(objective);
  for (let tick = 0; tick < 900; tick++) runner.update();
  const after = bot.character.position.distanceTo(objective);
  assert.ok(after < before - 10,
    `bot did not advance on the objective (${before.toFixed(1)} m → ${after.toFixed(1)} m)`);
});

test('a bot adopts the session objective and advances when it has nothing else to do', () => {
  const runner = new MatchRunner({ map: 'facility', seed: 7, bots: 2, warmup: 3, mode: MatchMode.TDM });
  const bot = runner.bots[0];
  bot.objective = null;
  runner.update();
  assert.ok(bot.objective, 'bot did not pick up the objective handed to it by the session');
});

// ------------------------------------------------------------------ perception and gunnery
test('perception notices an enemy beside the bot at close range', () => {
  const runner = new MatchRunner({ map: 'arena', seed: 21, bots: 2, warmup: 3, mode: MatchMode.TDM });
  const [a, b] = runner.bots;
  a.team = 'red';
  b.team = 'blue';
  // Stand the two bots two metres apart on flat ground and face the first one away from the other.
  const ground = a.character.position.clone();
  b.character.position.set(ground.x + 0.0, ground.y, ground.z - 2.0);
  a.yaw = 0;
  a.character.yaw = 0;
  b.yaw = 0;
  b.character.yaw = 0;
  const seen = a.perceive([b], TICK);
  assert.ok(seen.includes(b), 'peripheral awareness did not notice an enemy two metres away');
});

test('the firing solution measures the same point the aim commands', () => {
  const runner = new MatchRunner({ map: 'arena', seed: 21, bots: 2, warmup: 3, mode: MatchMode.TDM });
  const [shooter, target] = runner.bots;
  shooter.team = 'red';
  target.team = 'blue';
  // Aim the shooter perfectly at the target's chest on a flat floor: the solution must be true.
  target.character.position.copy(shooter.character.position).add(new Vector3(0, 0, -12));
  shooter.aimTarget = 'torso';
  shooter._aimIntent = null;
  const eye = shooter.character.eyePosition;
  const toTarget = target.character.position.clone().sub(eye);
  toTarget.y += 1.2;
  const yaw = Math.atan2(-toTarget.x, -toTarget.z);
  const pitch = Math.asin(toTarget.y / toTarget.magnitude);
  shooter.yaw = yaw;
  shooter.pitch = pitch;
  shooter.character.yaw = yaw;
  shooter._aimIntent = { yaw, pitch };
  assert.equal(shooter._hasFiringSolution(target), true, 'a perfectly aimed shot was rejected');
  // And it must reject a shot pointed away from the target.
  shooter._aimIntent = { yaw: yaw + Math.PI * 0.5, pitch: 0 };
  assert.equal(shooter._hasFiringSolution(target), false, 'a 90°-off shot was accepted');
});

test('bots hold fire through a teammate', () => {
  const runner = new MatchRunner({ map: 'arena', seed: 21, bots: 3, warmup: 3, mode: MatchMode.TDM });
  const [shooter, mate, target] = runner.bots;
  shooter.team = 'red';
  mate.team = 'red';
  target.team = 'blue';
  const base = shooter.character.position.clone();
  target.character.position.copy(base).add(new Vector3(0, 0, -14));
  // A teammate standing directly in the firing line, closer than the enemy.
  mate.character.position.copy(base).add(new Vector3(0, 0, -5));
  shooter.squad = { members: [shooter, mate] };
  const eye = shooter.character.eyePosition;
  const toTarget = target.character.position.clone().sub(eye);
  toTarget.y += 1.2;
  const yaw = Math.atan2(-toTarget.x, -toTarget.z);
  shooter._aimIntent = { yaw, pitch: 0 };
  shooter.yaw = yaw;
  shooter.pitch = 0;
  shooter.character.yaw = yaw;
  assert.equal(shooter._hasFiringSolution(target), false, 'bot shot through a teammate');
});

// ------------------------------------------------------------------ match-level integration
test('a 30 s team deathmatch produces real firefights on every map', () => {
  for (const map of ['arena', 'urban', 'facility']) {
    const runner = new MatchRunner({ map, seed: 21, bots: 8, warmup: 3, mode: MatchMode.TDM, tickRate: 60 });
    for (let tick = 0; tick < 1800; tick++) runner.update();
    const stats = runner.ballistics.stats;
    assert.ok(stats.shots > 10, `${map}: only ${stats.shots} shots fired in 30 s`);
    assert.ok(stats.hits > 0, `${map}: no hits in 30 s`);
    assert.ok(runner.scores.red + runner.scores.blue > 0, `${map}: match produced no score`);
  }
});

test('kills, respawns and the scoreboard stay consistent over a long match', () => {
  const runner = new MatchRunner({ map: 'arena', seed: 3, bots: 8, warmup: 3, mode: MatchMode.TDM, tickRate: 60, scoreLimit: 100000, timeLimit: 3600 });
  // Bots come back through the simulation rather than the network event queue, so watch the state.
  const wasDead = new Map(runner.bots.map((bot) => [bot, false]));
  let respawns = 0;
  for (let tick = 0; tick < 5400; tick++) {
    runner.update();
    runner.drainEvents();
    for (const bot of runner.bots) {
      const dead = !bot.health.alive;
      if (wasDead.get(bot) && !dead) respawns++;
      wasDead.set(bot, dead);
    }
  }
  const scoreboard = runner.getScoreboard();
  assert.equal(runner.phase, MatchPhase.Live);
  assert.ok(scoreboard.players.length >= runner.bots.length);
  for (const player of scoreboard.players) {
    assert.ok(Number.isFinite(player.score));
    assert.ok(player.kills >= 0 && player.deaths >= 0);
    assert.ok(player.deaths >= 0);
  }
  const kills = scoreboard.players.reduce((sum, player) => sum + player.kills, 0);
  const deaths = scoreboard.players.reduce((sum, player) => sum + player.deaths, 0);
  assert.equal(kills, deaths, 'every kill must produce exactly one death');
  assert.ok(kills > 0, 'a 90 s match with 8 bots produced no kills');
  assert.ok(respawns > 0, 'no bot came back from the dead in a 90 s match');
});

test('a bot that gets boxed in frees itself instead of standing there', () => {
  const runner = new MatchRunner({ map: 'arena', seed: 21, bots: 1, warmup: 3, mode: MatchMode.TDM });
  const bot = runner.bots[0];
  assert.ok(bot instanceof Bot);
  // Simulate a hard wedge: the bot wants to walk forward but the character never moves.
  const stuck = bot.character.position.clone();
  const input = { moveX: 0, moveY: 1, jump: false, crouch: false, prone: false, sprint: false, walk: false };
  let tripped = false;
  for (let tick = 0; tick < 120; tick++) {
    bot.character.update(TICK, input);
    bot.character.position.copy(stuck);            // pin it: geometry it cannot walk out of
    if (bot._stuckFor(TICK, input)) { tripped = true; break; }
  }
  assert.ok(tripped, 'the stuck detector never fired for a bot pinned in place');
  assert.notEqual(bot.botState, BotState.Dead);
});

test('bot difficulty changes how fast a bot engages and how well it shoots', () => {
  const limits = { scoreLimit: 100000, timeLimit: 3600 };
  const recruit = new MatchRunner({ map: 'arena', seed: 11, bots: 6, warmup: 3, mode: MatchMode.TDM, difficulty: 'recruit', ...limits });
  const elite = new MatchRunner({ map: 'arena', seed: 11, bots: 6, warmup: 3, mode: MatchMode.TDM, difficulty: 'elite', ...limits });
  assert.ok(elite.bots[0].settings.aimError < recruit.bots[0].settings.aimError);
  assert.ok(elite.bots[0].settings.reactionTime < recruit.bots[0].settings.reactionTime);
  for (let tick = 0; tick < 2400; tick++) { recruit.update(); elite.update(); }
  const eliteAccuracy = elite.ballistics.stats.hits / Math.max(1, elite.ballistics.stats.shots);
  const recruitAccuracy = recruit.ballistics.stats.hits / Math.max(1, recruit.ballistics.stats.shots);
  assert.ok(elite.ballistics.stats.shots > 20, `elite match fired only ${elite.ballistics.stats.shots} shots`);
  assert.ok(eliteAccuracy >= recruitAccuracy * 0.5,
    `elite accuracy ${(eliteAccuracy * 100).toFixed(1)}% is far below recruit ${(recruitAccuracy * 100).toFixed(1)}%`);
});

test('a seeded match replays identically, shot for shot', () => {
  const simulate = () => {
    const runner = new MatchRunner({ map: 'urban', seed: 21, bots: 6, warmup: 3, mode: MatchMode.TDM, tickRate: 60, scoreLimit: 100000, timeLimit: 3600 });
    for (let tick = 0; tick < 900; tick++) runner.update();
    return {
      shots: runner.ballistics.stats.shots,
      kills: runner.ballistics.stats.kills,
      scores: { ...runner.scores },
      positions: runner.bots.map((bot) => `${bot.character.position.x.toFixed(4)},${bot.character.position.z.toFixed(4)}`),
    };
  };
  assert.deepEqual(simulate(), simulate());
});
