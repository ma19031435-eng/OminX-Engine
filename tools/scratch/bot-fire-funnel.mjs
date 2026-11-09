// Fire funnel: visible → firing solution → trigger. Shows exactly where bots stop shooting.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const { Bot } = await import('../../engine/src/gameplay/Bot.js');
const map = process.argv[2] ?? 'facility';
const stats = { visible: 0, solution: 0, fire: 0, reactBlocked: 0, reloadBlocked: 0, burstBlocked: 0 };
const originalSolution = Bot.prototype._hasFiringSolution;
Bot.prototype._hasFiringSolution = function patched(target) {
  const ok = originalSolution.call(this, target);
  stats.solution += ok ? 1 : 0;
  return ok;
};
const originalInput = Bot.prototype._buildInput;
Bot.prototype._buildInput = function patched(dt, ctx) {
  const input = originalInput.call(this, dt, ctx);
  if (this.visibleTargets?.length) stats.visible++;
  if (input.fire) stats.fire++;
  if (!input.fire && this.target) {
    if (this.reactionTimer > 0) stats.reactBlocked++;
    else if (this.weapon?.reloading || this.isReloading) stats.reloadBlocked++;
    else if (this.burstPause > 0 || this.burstShotsLeft <= 0) stats.burstBlocked++;
  }
  return input;
};
const r = new MatchRunner({ map, seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
for (let i = 0; i < 1200; i++) r.update();
const total = r.ballistics.stats.shots;
console.log(`${map}: bot-ticks with a visible enemy ${stats.visible} · firing-solution ticks ${stats.solution} (blocked ${stats.visible - stats.solution}) · trigger ticks ${stats.fire} · actual shots ${total}`);
console.log(`   withheld: reaction ${stats.reactBlocked} · reload ${stats.reloadBlocked} · burst pause ${stats.burstBlocked}`);
