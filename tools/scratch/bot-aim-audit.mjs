// Why the firing solution fails at close range: prints angle error vs tolerance for failing ticks.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const map = process.argv[2] ?? 'facility';
const r = new MatchRunner({ map, seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
let printed = 0;
const buckets = new Map();
for (let tick = 0; tick < 900; tick++) {
  for (const bot of r.bots) {
    if (!bot.target || bot.botState !== 'engage' || !bot.health.alive) continue;
    const target = bot.target;
    const eye = bot.character.eyePosition;
    const dx = target.character.position.x - eye.x;
    const dz = target.character.position.z - eye.z;
    const distance = Math.hypot(target.character.position.x - bot.character.position.x, target.character.position.z - bot.character.position.z);
    // Horizontal angle between the bot's facing and the target.
    const desiredYaw = Math.atan2(-dx, -dz);
    let delta = desiredYaw - bot.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const tolerance = Math.max(Math.atan2(0.6, Math.max(0.5, distance)), bot.settings.aimError * 1.35, 0.004);
    const bucket = Math.floor(Math.abs(delta) / (Math.PI / 12));
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    if (printed < 6 && Math.abs(delta) > tolerance) {
      console.log(`tick ${tick} ${bot.name} dist ${distance.toFixed(1)} m · yaw ${bot.yaw.toFixed(3)} · desired ${desiredYaw.toFixed(3)} · off by ${(delta * 57.3).toFixed(1)}° · tolerance ${(tolerance * 57.3).toFixed(1)}° · state ${bot.botState} · strafing ${bot.character.horizontalSpeed.toFixed(2)} m/s`);
      printed++;
    }
  }
  r.update();
}
console.log('angle-error histogram (15° buckets, ticks):', [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k * 15}-${k * 15 + 15}°:${v}`).join(' '));
