// Counts, per tick, how many opposing bot pairs have mutual line of sight (an "engagement
// opportunity") and how many of those turn into shots. Separates map problems from AI problems.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const map = process.argv[2] ?? 'facility';
const r = new MatchRunner({ map, seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
const ticks = Number(process.argv[3] ?? 1800);
let opportunities = 0;
let seenTicks = 0;
const los = r.scene.collision;
for (let tick = 0; tick < ticks; tick++) {
  let pairs = 0;
  for (const a of r.bots) {
    if (!a.health.alive) continue;
    for (const b of r.bots) {
      if (a.team === b.team || !b.health.alive) continue;
      if (a.character.position.distanceTo(b.character.position) > 60) continue;
      if (los.lineOfSight(a.character.eyePosition, b.character.eyePosition, { ignore: [a, b] })) pairs++;
    }
  }
  if (pairs) seenTicks++;
  opportunities += pairs;
  r.update();
}
console.log(`${map}: LOS opportunities ${(opportunities / ticks).toFixed(2)}/tick (${seenTicks}/${ticks} ticks with contact) · shots ${r.ballistics.stats.shots} · hits ${r.ballistics.stats.hits} · kills ${r.ballistics.stats.kills}`);
