// Traces one bot's brain→body pipeline tick by tick. Usage: node tools/scratch/bot-trace.mjs [map] [seed]
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const map = process.argv[2] ?? 'facility';
const seed = Number(process.argv[3] ?? 21);
const r = new MatchRunner({ map, seed, bots: 2, warmup: 2, mode: 'tdm', tickRate: 60 });
const bot = r.bots[0];
for (let i = 0; i < 240; i++) r.update();
const enemy = [...r.players].find((o) => o !== bot && o.team !== bot.team && o.health.alive);
console.log(`${map} seed ${seed} | bot`, bot.name, bot.botState, 'team', bot.team);
for (let i = 0; i < 8; i++) {
  const before = bot.character.position.clone();
  const goal = bot._currentGoal({ players: [...r.players], nav: r.nav, objective: null });
  const input = bot._buildInput(1 / 60, { players: [...r.players], nav: r.nav, objective: null });
  r.update();
  const after = bot.character.position;
  console.log(
    `t${i}`,
    'goal', goal ? `${goal.x.toFixed(1)},${goal.z.toFixed(1)}` : 'null',
    'input', `mx${input.moveX.toFixed(2)} my${input.moveY.toFixed(2)} jmp${input.jump ? 1 : 0}`,
    'Δ', `(${(after.x - before.x).toFixed(3)},${(after.y - before.y).toFixed(3)},${(after.z - before.z).toFixed(3)})`,
    'vel', bot.character.velocity ? `${bot.character.velocity.x.toFixed(2)},${bot.character.velocity.z.toFixed(2)}` : 'n/a',
    'ground', bot.character.onGround ?? bot.character.grounded,
    'state', bot.state ?? '?',
    'stuck', bot.stuckTimer.toFixed(2), 'idx', bot.pathIndex,
    'blocked', JSON.stringify(bot.character.blockedAxes ?? null),
    'overlap', bot.scene?.collision?.overlapAABB?.(bot.character.aabb ?? bot.character.bounds, { ignore: [bot] }) ?? 'n/a',
  );
}
const t = enemy ? r.nav.findPath(bot.character.position, enemy.character.position) : null;
console.log('nav path to enemy:', t ? t.length : 'NO PATH', '| nav nodes', r.nav.nodes.length, '| bounds', JSON.stringify(r.bounds ?? r.world?.bounds ?? null));
