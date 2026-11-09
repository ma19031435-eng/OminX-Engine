import { Scene } from '../../engine/src/world/Scene.js';
import { LevelBuilder } from '../../engine/src/world/LevelBuilder.js';
import { BallisticsSystem } from '../../engine/src/gameplay/Ballistics.js';
import { Bot, Squad } from '../../engine/src/gameplay/Bot.js';
const scene = new Scene();
const map = new LevelBuilder(scene, { kind: 'urban', seed: 21, navCell: 2 }).build();
const ballistics = new BallisticsSystem(scene);
const bots = []; const squads = [new Squad({ team: 'red' }), new Squad({ team: 'blue' })];
for (const [ti, team] of ['red','blue'].entries()) {
  const spawns = scene.getSpawnPoints(team);
  for (let k = 0; k < 5; k++) {
    const bot = new Bot(scene, { name: team[0]+k, team, nav: map.nav, ballistics, difficulty: k<2?'hardened':'regular' });
    bot.setLoadout(['assault','closeQuarters','marksman','sniper','support'][k]);
    bot.registerWith(ballistics); bot.spawn(spawns[(k*3)%spawns.length]); squads[ti].add(bot); bots.push(bot);
  }
}
const perf = {};
const time = (k, fn) => { const a = process.hrtime.bigint(); fn(); perf[k] = (perf[k] ?? 0) + Number(process.hrtime.bigint()-a)/1e6; };
const dt = 1/30; let ticks = 0;
for (let step = 0; step < 30*60; step++) {
  const ctx = { players: bots, nav: map.nav };
  time('think', () => { for (const bot of bots) bot.think(dt, ctx); }); ticks++;
  time('squad', () => { squads[0].update(dt, {}); squads[1].update(dt, {}); });
  time('scene', () => scene.update(dt));
  time('ballistics', () => ballistics.update(dt));
}
if (process.env.CPU_PROF) { /* handled by node flag */ }
const total = Object.values(perf).reduce((a,b)=>a+b,0);
console.log('total', total.toFixed(0)+'ms', (total/ticks).toFixed(2)+'ms/tick');
for (const [k,v] of Object.entries(perf).sort((a,b)=>b[1]-a[1])) console.log(' ', k.padEnd(11), v.toFixed(1)+'ms', (v/total*100).toFixed(0)+'%');
