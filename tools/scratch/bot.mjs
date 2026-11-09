import { Scene } from '../../engine/src/world/Scene.js';
import { LevelBuilder } from '../../engine/src/world/LevelBuilder.js';
import { BallisticsSystem } from '../../engine/src/gameplay/Ballistics.js';
import { Bot, Squad } from '../../engine/src/gameplay/Bot.js';

const scene = new Scene();
const map = new LevelBuilder(scene, { kind: 'urban', seed: 21, navCell: 2 }).build();
const ballistics = new BallisticsSystem(scene);
const bots = [];
const squads = { red: new Squad({ team: 'red' }), blue: new Squad({ team: 'blue' }) };
for (const team of ['red', 'blue']) {
  const spawns = scene.getSpawnPoints(team);
  for (let k = 0; k < 5; k++) {
    const bot = new Bot(scene, { name: team[0].toUpperCase() + k, team, nav: map.nav, ballistics, difficulty: k < 2 ? 'hardened' : 'regular' });
    bot.setLoadout(['assault', 'closeQuarters', 'marksman', 'sniper', 'support'][k]);
    bot.registerWith(ballistics);
    bot.spawn(spawns[(k * 3) % spawns.length]);
    bot.homePosition.copy(bot.character.position);
    squads[team].add(bot);
    bots.push(bot);
  }
}
const players = bots;
const dt = 1 / 30;
const t0 = Date.now();
for (let step = 0; step < 30 * 60; step++) {
  const ctx = { players, nav: map.nav };
  for (const bot of bots) bot.think(dt, ctx);
  squads.red.update(dt, { objective: scene.getSpawnPoints('blue')[0].getSpawnPoint() });
  squads.blue.update(dt, { objective: scene.getSpawnPoints('red')[0].getSpawnPoint() });
  scene.update(dt);
  ballistics.update(dt);
  for (const bot of bots) if (bot.health.dead && bot.health.respawnTimer <= 0) { bot.spawn(scene.getSpawnPoints(bot.team)[0]); bot.homePosition.copy(bot.character.position); }
}
const ms = Date.now() - t0;
const states = {};
for (const bot of bots) states[bot.botState] = (states[bot.botState] ?? 0) + 1;
const totalShots = bots.reduce((s, b) => s + b.shotsFired, 0);
const totalHits = bots.reduce((s, b) => s + b.shotsHit, 0);
console.log('simulated 60s of 10 bots in', ms + 'ms', (ms / 1800).toFixed(2) + 'ms/tick for 10 bots');
console.log('states:', JSON.stringify(states));
console.log('shots', totalShots, 'hits', totalHits, 'accuracy', (totalHits / Math.max(1, totalShots) * 100).toFixed(1) + '%',
  'kills', bots.reduce((s, b) => s + b.kills, 0), 'deaths', bots.reduce((s, b) => s + b.deaths, 0),
  'explosions', ballistics.stats.explosions, 'projectiles', ballistics.stats.projectiles);
console.log('bot0:', JSON.stringify(bots[0].getDebugState()));
console.log('bot6:', JSON.stringify(bots[6].getDebugState()));
console.log('moved from spawn (m):', bots.map((b) => b.character.position.distanceTo(b.homePosition).toFixed(0)).join(' '));
console.log('path/covers:', bots.map((b) => (b.path ? b.path.points.length : 0) + '/' + (b.coverNode ? 1 : 0)).join(' '));
console.log('shots per bot:', bots.map((b) => b.shotsFired).join(' '));
