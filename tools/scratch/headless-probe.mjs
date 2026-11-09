import { Scene } from '../../engine/src/world/Scene.js';
import { LevelBuilder, MapKind } from '../../engine/src/world/LevelBuilder.js';
import { BallisticsSystem } from '../../engine/src/gameplay/Ballistics.js';
import { Player } from '../../engine/src/gameplay/Player.js';
import { Bot } from '../../engine/src/gameplay/Bot.js';
import { NavGraph } from '../../engine/src/world/NavGraph.js';

const scene = new Scene({ Name: 'probe' });
const builder = new LevelBuilder(scene, { kind: MapKind.Arena, seed: 11, size: 56 });
const built = builder.build({ withNav: true });
console.log('built', built.stats, 'nav nodes', built.nav?.nodes?.length);
const ballistics = new BallisticsSystem(scene, { renderer: null, audio: null });
const player = new Player(scene, { ballistics, position: built.spawns.blue[0], team: 'blue', isLocal: true });
const bot = new Bot(scene, { ballistics, position: built.spawns.red[0], team: 'red', difficulty: 'regular' });
console.log('player', player.constructor.name, 'bot', bot.constructor.name);
for (let i = 0; i < 120; i++) {
  player.update(1 / 60, { moveX: 0.4, moveY: 1, fire: i % 30 === 0, look: { yaw: 0.01, pitch: 0 } });
  bot.think?.(1 / 60, { players: [player], nav: built.nav, objective: built.objectives[0] ?? null });
  ballistics.update(1 / 60);
  scene.update(1 / 60);
}
const hud = player.getHudState();
console.log('after 2s: health', hud.health, 'ammo', hud.ammo?.mag ?? 'n/a', 'position', hud.position);
console.log('kills', player.kills, 'deaths', player.deaths, 'shots', ballistics.stats?.shots ?? 'n/a');
