import { Scene } from '../../engine/src/world/Scene.js';
import { LevelBuilder } from '../../engine/src/world/LevelBuilder.js';
import { BallisticsSystem } from '../../engine/src/gameplay/Ballistics.js';
import { Bot, Squad } from '../../engine/src/gameplay/Bot.js';

const scene = new Scene();
const map = new LevelBuilder(scene, { kind: 'urban', seed: 21, navCell: 2 }).build();
const ballistics = new BallisticsSystem(scene);
const bots = [];
const squads = [new Squad({ team: 'red' }), new Squad({ team: 'blue' })];
for (const [ti, team] of ['red', 'blue'].entries()) {
  const spawns = scene.getSpawnPoints(team);
  for (let k = 0; k < 5; k++) {
    const bot = new Bot(scene, { name: team[0].toUpperCase() + k, team, nav: map.nav, ballistics, difficulty: k < 2 ? 'hardened' : 'regular' });
    bot.setLoadout(['assault', 'closeQuarters', 'marksman', 'sniper', 'support'][k]);
    bot.registerWith(ballistics);
    bot.spawn(spawns[(k * 3) % spawns.length]);
    bot.homePosition.copy(bot.character.position);
    squads[ti].add(bot); bots.push(bot);
  }
}
const dt = 1 / 30;
const t0 = Date.now();
for (let step = 0; step < 30 * 60; step++) {
  const ctx = { players: bots, nav: map.nav };
  for (const bot of bots) bot.think(dt, ctx);
  squads[0].update(dt, { objective: scene.getSpawnPoints('blue')[0].getSpawnPoint() });
  squads[1].update(dt, { objective: scene.getSpawnPoints('red')[0].getSpawnPoint() });
  scene.update(dt); ballistics.update(dt);
  for (const bot of bots) if (bot.health.dead && bot.health.respawnTimer <= 0) { bot.spawn(scene.getSpawnPoints(bot.team)[0]); bot.homePosition.copy(bot.character.position); }
}
const ms = Date.now() - t0;
console.log('60s / 10 bots:', ms + 'ms', (ms / 1800).toFixed(2) + 'ms/tick');
console.log('scoreboard:', bots.map((b) => `${b.name}(${b.team[0]}) k${b.kills} d${b.deaths} a${b.assists} score${b.score} acc${b.shotsFired ? (b.shotsHit / b.shotsFired * 100).toFixed(0) : 0}%`).join(' | '));
console.log('totals: shots', bots.reduce((s, b) => s + b.shotsFired, 0), 'hits', bots.reduce((s, b) => s + b.shotsHit, 0), 'kills', bots.reduce((s, b) => s + b.kills, 0), 'deaths', bots.reduce((s, b) => s + b.deaths, 0), 'teamkills', bots.reduce((s, b) => s + b.teamKills, 0));
console.log('ballistics:', JSON.stringify(ballistics.stats));
console.log('states:', bots.map((b) => b.botState).join(','));
console.log('travel(m):', bots.map((b) => b.character.position.distanceTo(b.homePosition).toFixed(0)).join(' '));
