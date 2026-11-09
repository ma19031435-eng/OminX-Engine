// Recomputes the firing-solution internals inside the real call, so the numbers cannot drift.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const { Bot } = await import('../../engine/src/gameplay/Bot.js');
const { Vector3 } = await import('../../engine/src/math/Vector3.js');
const map = process.argv[2] ?? 'facility';
const r = new MatchRunner({ map, seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
const samples = [];
const original = Bot.prototype._hasFiringSolution;
Bot.prototype._hasFiringSolution = function patched(target) {
  const before = this.character.eyePosition;
  const toTarget = new Vector3(target.character.position.x - before.x, 0, target.character.position.z - before.z);
  toTarget.y += 1.2 - before.y + this.character.position.y;
  const distance = toTarget.magnitude;
  toTarget.scale(1 / Math.max(1e-6, distance));
  const forward = this.getForward(new Vector3());
  const angleError = Math.acos(Math.max(-1, Math.min(1, toTarget.dot(forward))));
  const tolerance = Math.max(Math.atan2(0.6, distance), this.settings.aimError * 1.35, 0.004);
  let mateBlocked = false;
  if (this.squad) {
    for (const mate of this.squad.members ?? []) {
      if (mate === this || mate.health.dead) continue;
      const toMate = new Vector3(mate.character.position.x - before.x, mate.character.position.y - before.y, mate.character.position.z - before.z);
      const mateDistance = toMate.magnitude;
      if (mateDistance > distance) continue;
      toMate.scale(1 / Math.max(1e-4, mateDistance));
      if (toMate.dot(forward) > 0.985) { mateBlocked = true; break; }
    }
  }
  const result = original.call(this, target);
  if (samples.length < 400) samples.push({ distance, angleError, tolerance, mateBlocked, result, pitch: this.pitch, health: this.health.healthFraction });
  return result;
};
for (let i = 0; i < 1200; i++) r.update();
const solvedCount = samples.filter((s) => s.result).length;
const angleBlocked = samples.filter((s) => !s.result && !s.mateBlocked);
const mateBlockedCount = samples.filter((s) => s.mateBlocked).length;
console.log(`${map}: ${samples.length} solution checks → ${solvedCount} passed · ${samples.length - solvedCount} failed (mate-in-line ${mateBlockedCount}, angle ${angleBlocked.length})`);
console.log('mean distance', (samples.reduce((a, s) => a + s.distance, 0) / Math.max(1, samples.length)).toFixed(1), 'm');
const ratios = angleBlocked.map((s) => s.angleError / s.tolerance).sort((a, b) => a - b);
if (ratios.length) console.log('angle-error / tolerance ratio: min', ratios[0].toFixed(2), 'p50', ratios[Math.floor(ratios.length / 2)].toFixed(2), 'max', ratios[ratios.length - 1].toFixed(2));
console.log('mean angleError', (angleBlocked.reduce((a, s) => a + s.angleError, 0) / Math.max(1, angleBlocked.length) * 57.3).toFixed(1), '° vs mean tolerance', (angleBlocked.reduce((a, s) => a + s.tolerance, 0) / Math.max(1, angleBlocked.length) * 57.3).toFixed(1), '°');
console.log('pitch spread:', angleBlocked.slice(0, 6).map((s) => (s.pitch * 57.3).toFixed(1)).join(' '));
