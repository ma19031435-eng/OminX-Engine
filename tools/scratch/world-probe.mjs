#!/usr/bin/env node
/** Scratch probe for the UE-style world: actors, components, tick groups, levels, replication. */
import {
  World, ActorComponent, SceneComponent, TickGroup, ReplicationSystem, NetMode, NetRole,
} from '../../engine/src/core/index.js';
import { Console } from '../../engine/src/core/Console.js';

const net = new ReplicationSystem({ name: 'ProbeNet', mode: NetMode.Server, localRole: NetRole.Authority });
const world = new World({ name: 'ProbeWorld', replication: net });

const player = world.spawnActor({
  name: 'RedPlayer', className: 'Player', tags: ['player', 'red'],
}, { level: 'Arena', replicate: true, properties: { health: 100, kills: 0 } });
player.setPosition(0, 2, -12);

const muzzle = new SceneComponent({ name: 'Muzzle' });
muzzle.setPosition(0, 0, -0.8);
muzzle.attachTo(player.root);
console.log('muzzle world position:', muzzle.getWorldPosition().toJSON());

const order = [];
player.addComponent(new ActorComponent({
  name: 'input', tickGroup: TickGroup.PrePhysics, tickEnabled: true,
  hooks: { onTick: (delta) => order.push(`input:${delta.toFixed(3)}`) },
}));
player.addComponent(new ActorComponent({
  name: 'hud', tickGroup: TickGroup.PostUpdateWork, tickEnabled: true,
  hooks: { onTick: () => order.push('hud') },
}));
player.addComponent(new ActorComponent({
  name: 'crashy', tickGroup: TickGroup.DuringPhysics, tickEnabled: true,
  hooks: { onTick: () => { throw new Error('isolated component failure'); } },
}));
world.tick(1 / 60);
console.log('tick order:', order, 'component error:', player.getComponent('crashy').lastError, 'world errors:', world.errors.length);

const pickup = world.spawnActor({ name: 'Medkit', className: 'Pickup' }, { level: 'Arena' });
pickup.setPosition(4, 0.5, -3);
console.log('queries:', {
  total: world.count,
  players: world.actorsOfClass('Player').map((actor) => actor.name),
  red: world.actorsWithTag('red').map((actor) => actor.name),
  arenaActors: world.levels.get('Arena').actors.size,
});

player.setReplicated('kills', 3);
console.log('net deltas:', world.collectNetDeltas());
console.log('world snapshot:', JSON.stringify(world.snapshot()).slice(0, 220) + '…');

const restored = new World({ name: 'Restored' });
console.log('restored actors:', restored.loadSnapshot(world.snapshot()), restored.format().split('\n')[0]);

console.log('unloaded Arena actors:', world.unloadLevel('Arena'), 'remaining:', world.count);
const temporary = world.spawnActor({ name: 'Temporary', lifespan: 0.05 });
world.runFixedFrames(4, 0.02);
console.log('lifespan expired:', temporary.isDestroyed);

const console_ = new Console();
world.installConsoleCommands(console_);
console.log('console:', console_.exec('world.spawn Probe Actor', { silent: true }).output);
console.log('levels:', console_.exec('world.levels', { silent: true }).output);
console.log('tick:', console_.exec('world.tick 2', { silent: true }).output);
console.log(world.format());
