// Counts collision queries per tick and attributes them to the engine call site that issued them.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const { CollisionWorld } = await import('../../engine/src/world/CollisionWorld.js');
const counts = new Map();
const record = (name) => {
  const stack = new Error().stack.split('\n').slice(2, 5)
    .map((l) => l.trim().replace(/^at /, '').replace(/ \(.*/, '').replace(/.*\//, ''))
    .join(' < ');
  const key = `${name} <- ${stack}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
};
for (const method of ['sweepAABB', 'raycast', 'raycastAll', 'overlapsBox', 'overlapsSphere', 'moveAABB', 'lineOfSight']) {
  const original = CollisionWorld.prototype[method];
  if (!original) continue;
  CollisionWorld.prototype[method] = function patched(...args) {
    record(method);
    return original.apply(this, args);
  };
}
const r = new MatchRunner({ map: process.argv[2] ?? 'facility', seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
for (let i = 0; i < 120; i++) r.update();
const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`collision queries over 120 ticks: ${total} (${(total / 120).toFixed(0)}/tick)`);
[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  .forEach(([k, v]) => console.log(String(v).padStart(7), (v / 120).toFixed(1) + '/tick', k));
