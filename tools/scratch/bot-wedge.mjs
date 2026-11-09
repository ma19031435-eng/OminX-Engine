// Diagnoses why a bot stops moving: samples input, velocity, blocked axes and the parts in the way.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const map = process.argv[2] ?? 'facility';
const r = new MatchRunner({ map, seed: 21, bots: 2, warmup: 2, mode: 'tdm', tickRate: 60 });
const b = r.bots[0];
const scene = r.scene;
const rad = b.character.radius;
for (let tick = 0; tick <= 600; tick++) {
  if (tick % 60 === 0) {
    const p = b.character.position;
    const box = { min: { x: p.x - rad, y: p.y + 0.05, z: p.z - rad }, max: { x: p.x + rad, y: p.y + 1.8, z: p.z + rad } };
    const hits = scene.collision.overlapsBox(box, { layerMask: b.character.layerMask & ~(1 << 8) }).filter((part) => part.CanCollide !== false);
    console.log(
      `t${String(tick).padStart(3)}`,
      String(b.botState ?? 'new').padEnd(9), 'pos', `${p.x.toFixed(1)},${p.y.toFixed(2)},${p.z.toFixed(1)}`,
      'speed', b.character.horizontalSpeed.toFixed(2), 'yaw', b.yaw.toFixed(2),
      'stuckT', b.stuckTimer.toFixed(2), 'idx', b.pathIndex, 'wp', b.path?.points?.[b.pathIndex] ? `${b.path.points[b.pathIndex].x.toFixed(1)},${b.path.points[b.pathIndex].z.toFixed(1)}` : '-', 'tgt', b.target ? 'y' : 'n', 'path', b.path?.length ?? '-', 'goal', b.patrolPoint ? 'patrol' : b.objective ? 'obj' : b.investigatePoint ? 'inv' : 'none',
      '| in the way:', hits.map((h) => `${h.name}@${h.position.x.toFixed(1)},${h.position.y.toFixed(1)},${h.position.z.toFixed(1)}`).join(' ') || 'clear',
    );
  }
  if (tick === 120 || tick === 121 || tick === 130 || tick === 200) {
    const built = b._buildInput(1 / 60, { players: [...r.players], nav: r.nav });
    const wp = b.path?.points?.[b.pathIndex];
    console.log('      > input', built.moveX.toFixed(3), built.moveY.toFixed(3), 'jump', built.jump, '| waypoint', wp ? `${wp.x.toFixed(2)},${wp.z.toFixed(2)}` : 'none', '| dist', wp ? b.character.position.distanceTo(wp).toFixed(3) : '-', '| patrolPoint', b.patrolPoint ? `${b.patrolPoint.x.toFixed(1)},${b.patrolPoint.z.toFixed(1)}` : 'none', '| goal', b._currentGoal({ players: [...r.players], nav: r.nav })?.x?.toFixed(1));
  }
  r.update();
}
