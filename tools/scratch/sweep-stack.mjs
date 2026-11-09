// Prints the full call stack for the worst sweepAABB call sites, once per unique stack shape.
const { MatchRunner } = await import('../../server/src/MatchRunner.js');
const { CollisionWorld } = await import('../../engine/src/world/CollisionWorld.js');
const shapes = new Map();
const original = CollisionWorld.prototype.sweepAABB;
CollisionWorld.prototype.sweepAABB = function patched(...args) {
  const stack = new Error().stack.split('\n').slice(2, 9)
    .map((l) => l.trim().replace(/^at /, '').replace(/ \(.*/, '').replace(/.*\/(engine|src|server)\//, ''))
    .join(' < ');
  shapes.set(stack, (shapes.get(stack) ?? 0) + 1);
  return original.apply(this, args);
};
const r = new MatchRunner({ map: process.argv[2] ?? 'facility', seed: 21, bots: 8, warmup: 3, mode: 'tdm', tickRate: 60 });
for (let i = 0; i < 60; i++) r.update();
[...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([k, v]) => console.log(String(v).padStart(8), (v / 60).toFixed(1) + '/tick\n         ', k, '\n'));
