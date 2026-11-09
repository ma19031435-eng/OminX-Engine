// Prints the aim geometry for the first N firing-solution checks of one bot.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const { Bot } = await import('../../engine/src/gameplay/Bot.js');
const { Vector3 } = await import('../../engine/src/math/Vector3.js');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r = new MatchRunner({ map: process.argv[2] ?? 'facility', seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
let n = 0;
const original = Bot.prototype._hasFiringSolution;
Bot.prototype._hasFiringSolution = function patched(target) {
  const eye = this.character.eyePosition;
  const toTarget = new Vector3(target.character.position.x, target.character.position.y, target.character.position.z).sub(eye);
  toTarget.y += 1.2 - this.character.eyePosition.y + this.character.position.y;
  const distance = toTarget.magnitude;
  toTarget.scale(1 / Math.max(1e-6, distance));
  const forward = this.getForward(new Vector3());
  const err = Math.acos(clamp(toTarget.dot(forward), -1, 1));
  const tolerance = Math.max(Math.atan2(0.6, distance), this.settings.aimError * 1.35, 0.004);
  const ai = this._aimIntent;
  let intentErr = NaN;
  if (ai) {
    const cp = Math.cos(ai.pitch);
    const ix = -Math.sin(ai.yaw) * cp, iy = Math.sin(ai.pitch), iz = -Math.cos(ai.yaw) * cp;
    intentErr = Math.acos(clamp(toTarget.x * ix + toTarget.y * iy + toTarget.z * iz, -1, 1));
  }
  const result = original.call(this, target);
  if (n < 10) {
    n++;
    console.log(
      `${this.name} ${result ? 'SOLVED ' : 'miss   '} dist ${distance.toFixed(2)} m · err ${(err * 57.3).toFixed(1)}° / tol ${(tolerance * 57.3).toFixed(1)}°`,
      `· yaw ${this.yaw.toFixed(2)} pitch ${this.pitch.toFixed(2)} · fwd ${forward.x.toFixed(2)},${forward.y.toFixed(2)},${forward.z.toFixed(2)} · dir ${toTarget.x.toFixed(2)},${toTarget.y.toFixed(2)},${toTarget.z.toFixed(2)}`,
      `· intentErr ${(intentErr * 57.3).toFixed(1)}° · visible ${this.visibleTargets.length} · aimTarget ${this.aimTarget} · speed ${this.character.horizontalSpeed.toFixed(2)}`,
    );
  }
  return result;
};
for (let i = 0; i < 1200; i++) r.update();
