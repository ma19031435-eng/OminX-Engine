import { Scene } from '../../engine/src/world/Scene.js';
import { LevelBuilder } from '../../engine/src/world/LevelBuilder.js';
import { Vector3 } from '../../engine/src/math/Vector3.js';
const scene = new Scene();
const map = new LevelBuilder(scene, { kind: 'urban', seed: 21, navCell: 2 }).build();
const nav = map.nav;
const spawns = scene.getSpawnPoints('red');
const start = spawns[0].getSpawnPoint();
const goal = scene.getSpawnPoints('blue')[0].getSpawnPoint();
console.log('start', start.toString(), 'goal', goal.toString(), 'dist', start.distanceTo(goal).toFixed(1));
for (const maxNodes of [1200, 2500, 6000, 20000]) {
  const path = nav.findPath(start, goal, { maxNodes });
  console.log('maxNodes', maxNodes, '→', path ? path.points.length + ' pts, cost ' + path.cost.toFixed(1) : 'FAILED', 'end', path ? path.points[path.points.length-1].toString() : '-');
}
console.log('snap start:', JSON.stringify(nav.snap(start, { maxDistance: 40 })), 'nearest:', nav.nearestNode(start)?.index);
// random goal reachability
let ok = 0, fail = 0;
const rng = map.rng ?? { nextInteger: (a,b)=>Math.floor(Math.random()*(b-a+1))+a };
const t0 = Date.now();
for (let i = 0; i < 60; i++) {
  const node = nav.nodes[rng.nextInteger(0, nav.nodes.length - 1)];
  const path = nav.findPath(start, node.position, { maxNodes: 2500 });
  if (path && path.points.length) ok++; else fail++;
}
console.log('60 random long paths: ok', ok, 'fail', fail, 'in', Date.now()-t0+'ms');
