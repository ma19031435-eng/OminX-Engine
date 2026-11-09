// Traces yaw vs desired yaw tick by tick to find why a bot's aim never settles on target.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const map = process.argv[2] ?? 'facility';
const r = new MatchRunner({ map, seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
for (let tick = 0; tick < 195; tick++) r.update();
for (let tick = 195; tick < 224; tick++) {
  for (const bot of r.bots) {
    if (!bot.target || bot.botState !== 'engage') continue;
    const t = bot.target;
    const eye = bot.character.eyePosition;
    const dx = t.character.position.x - eye.x, dz = t.character.position.z - eye.z;
    const desired = Math.atan2(-dx, -dz);
    console.log(
      `${bot.name} yaw ${bot.yaw.toFixed(3)} desired ${desired.toFixed(3)} diff ${(((desired - bot.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI).toFixed(3)}`,
      `pitch ${bot.pitch.toFixed(3)} aimTarget ${bot.aimTarget} tgt ${t.name} move ${bot.lastMoveX?.toFixed?.(2) ?? '?'}/${bot.lastMoveY?.toFixed?.(2) ?? '?'}`,
      `look ${JSON.stringify(bot.lastLookDelta)}`,
    );
  }
  r.update();
}
