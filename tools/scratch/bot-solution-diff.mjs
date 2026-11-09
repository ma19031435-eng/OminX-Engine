// Dumps the exact numbers for calls where a faithful recomputation disagrees with the engine.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const { Bot } = await import('../../engine/src/gameplay/Bot.js');
const { Vector3 } = await import('../../engine/src/math/Vector3.js');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r = new MatchRunner({ map: process.argv[2] ?? 'facility', seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
let printed = 0, passed = 0, called = 0;
const original = Bot.prototype._hasFiringSolution;
Bot.prototype._hasFiringSolution = function patched(target) {
  called++;
  const eye = this.character.eyePosition;
  const toTarget = new Vector3(target.character.position.x, target.character.position.y, target.character.position.z).sub(eye);
  toTarget.y += 1.2 - this.character.eyePosition.y + this.character.position.y;
  const distance = toTarget.magnitude;
  toTarget.scale(1 / Math.max(1e-6, distance));
  const forward = this.getForward(new Vector3());
  const copyError = Math.acos(clamp(toTarget.dot(forward), -1, 1));
  const tolerance = Math.max(Math.atan2(0.6, distance), this.settings.aimError * 1.35, 0.004);
  const result = original.call(this, target);
  if (result) passed++;
  if (!result && copyError < tolerance && printed < 5) {
    printed++;
    console.log(`MISMATCH ${this.name}: copy ${(copyError * 57.3).toFixed(2)}° < tol ${(tolerance * 57.3).toFixed(2)}° but engine returned false · dist ${distance.toFixed(2)} · yaw ${this.yaw.toFixed(3)} pitch ${this.pitch.toFixed(3)} look ${JSON.stringify(this._look ?? null)}`);
  }
  return result;
};
for (let i = 0; i < 1200; i++) r.update();
console.log(`calls ${called} · engine passed ${passed}`);
