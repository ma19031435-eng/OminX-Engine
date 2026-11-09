// Per-bot-tick audit of the engage gate: why a bot that can see an enemy still holds fire.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const map = process.argv[2] ?? 'facility';
const r = new MatchRunner({ map, seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
const audit = { targetTicks: 0, engageTicks: 0, noWeapon: 0, reloading: 0, noAmmo: 0, outOfRange: 0, noSolution: 0, solved: 0, fired: 0, distSum: 0 };
const reasons = new Map();
for (let tick = 0; tick < 900; tick++) {
  for (const bot of r.bots) {
    if (!bot.target || !bot.health.alive) continue;
    audit.targetTicks++;
    if (bot.botState !== 'engage') { reasons.set('state:' + bot.botState, (reasons.get('state:' + bot.botState) ?? 0) + 1); continue; }
    audit.engageTicks++;
    const distance = bot.character.position.distanceTo(bot.target.character.position);
    audit.distSum += distance;
    const def = bot.weapon?.definition;
    if (!bot.weapon) { audit.noWeapon++; continue; }
    if (bot.weapon.reloading) { audit.reloading++; continue; }
    if (bot.weapon.ammo <= 0) { audit.noAmmo++; continue; }
    const engagementRange = bot.settings.engagementRange ?? (def.class === 'sniper' ? 140 : def.class === 'shotgun' ? 16 : 62);
    if (distance >= Math.min(def.range ?? 100, engagementRange)) { audit.outOfRange++; continue; }
    const solved = bot._hasFiringSolution(bot.target);
    if (solved) audit.solved++; else audit.noSolution++;
  }
  r.update();
}
console.log(`${map}: target-ticks ${audit.targetTicks} · engage-ticks ${audit.engageTicks} · mean distance ${(audit.distSum / Math.max(1, audit.engageTicks)).toFixed(1)} m`);
console.log(`   weapon ${audit.noWeapon} · reloading ${audit.reloading} · no ammo ${audit.noAmmo} · out of range ${audit.outOfRange} · solved ${audit.solved} · no solution ${audit.noSolution}`);
console.log('   non-engage states:', [...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
