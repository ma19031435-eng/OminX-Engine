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
    const bot = new Bot(scene, { name: team[0] + k, team, nav: map.nav, ballistics, difficulty: 'regular' });
    bot.setLoadout('assault');
    bot.registerWith(ballistics);
    bot.spawn(spawns[(k * 3) % spawns.length]);
    squads[ti].add(bot); bots.push(bot);
  }
}
const t = { perceive: 0, decide: 0, input: 0, aim: 0, playerUpdate: 0, squad: 0, scene: 0, ballistics: 0, cover: 0, path: 0 };
const time = (k, fn) => { const a = process.hrtime.bigint(); const r = fn(); t[k] += Number(process.hrtime.bigint() - a) / 1e6; return r; };
const dt = 1 / 30;
for (let step = 0; step < 30 * 20; step++) {
  for (const bot of bots) {
    if (!bot.health.alive) continue;
    time('perceive', () => bot.perceive(bots, dt));
    const target = bot.selectTarget(bot.visibleTargets);
    if (target && bot.target !== target) { bot.target = target; bot.reactionTimer = bot.settings.reactionTime; }
    else if (!target) bot.timeSinceSeenEnemy += dt;
    time('decide', () => { const s = bot._decideState(dt, { players: bots }); if (s !== bot.botState) bot._enterState(s, dt, { players: bots }); bot.stateTime += dt; });
    bot.ctx = { players: bots, nav: map.nav };
    time('input', () => bot._buildInput(dt, bot.ctx));
    time('aim', () => bot._aim(dt, bot.ctx));
    time('playerUpdate', () => bot.update(dt, bot.input));
  }
  time('squad', () => { for (const s of squads) s.update(dt, {}); });
  time('scene', () => scene.update(dt));
  time('ballistics', () => ballistics.update(dt));
}
const total = Object.values(t).reduce((a, b) => a + b, 0);
console.log('total', total.toFixed(0) + 'ms over 600 ticks →', (total / 600).toFixed(2) + 'ms/tick');
for (const [k, v] of Object.entries(t).sort((a, b) => b[1] - a[1])) console.log(' ', k.padEnd(13), v.toFixed(1) + 'ms', (v / total * 100).toFixed(1) + '%');
console.log('nav stats:', JSON.stringify(map.nav.stats));
console.log('bots alive:', bots.filter((b) => b.health.alive).length, 'shots', bots.reduce((s, b) => s + b.shotsFired, 0), 'kills', bots.reduce((s, b) => s + b.kills, 0));
console.log('bot states:', bots.map((b) => b.botState).join(','));
