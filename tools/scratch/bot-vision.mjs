// Reports whether bots ever acquire targets, and how far apart the teams are over time.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const map = process.argv[2] ?? 'urban';
const r = new MatchRunner({ map, seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
let everSaw = 0, engagements = 0;
const seen = new Set();
for (let tick = 0; tick < 1800; tick++) {
  r.update();
  for (const b of r.bots) {
    if (b.visibleTargets?.length) { seen.add(b.name); }
    if (b.botState === 'engage') engagements++;
  }
  if (tick % 300 === 0) {
    const enemy = (b) => [...r.players].filter((o) => o.team !== b.team && o.health.alive)
      .reduce((best, o) => Math.min(best, b.character.position.distanceTo(o.character.position)), Infinity);
    console.log(
      `t${String(tick).padStart(4)}`,
      r.bots.map((b) => `${b.name.slice(0, 2)}${b.botState.slice(0, 3)}:${b.visibleTargets?.length ?? 0}:${enemy(b) === Infinity ? '-' : enemy(b).toFixed(0)}`).join(' '),
    );
  }
}
console.log('bots that ever saw an enemy:', seen.size ? [...seen].join(',') : 'NONE', '| engage-ticks', engagements, '| shots', r.ballistics.stats.shots, 'hits', r.ballistics.stats.hits, 'kills', r.ballistics.stats.kills);
