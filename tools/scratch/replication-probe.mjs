#!/usr/bin/env node
/** Scratch probe for replication: deltas, ordered channels, RPCs, conflicts, late join. */
import {
  ReplicationSystem, NetChannel, NetMode, NetRole, RpcTarget,
} from '../../engine/src/core/index.js';
import { Console } from '../../engine/src/core/Console.js';

const server = new ReplicationSystem({ name: 'AuthoritativeServer', mode: NetMode.Server, localRole: NetRole.Authority });
server.register(7, { classId: 'Player', role: NetRole.Authority, properties: { health: 100, team: 'red', kills: 0 } });
server.register(8, { classId: 'Pickup', role: NetRole.Authority, properties: { active: true } });

server.tick();
server.setProperty(7, 'health', 82);
server.setProperty(7, 'kills', 1);
server.setProperty(8, 'active', false);
const deltas = server.collectDeltas();
console.log('deltas:', deltas);
console.log('clean second flush:', server.collectDeltas());

const client = new ReplicationSystem({ name: 'Client', mode: NetMode.Client, localRole: NetRole.SimulatedProxy });
console.log('applied:', client.applyDeltas(deltas));
console.log('client state:', client.get(7).snapshot());
console.log('replayed (stale):', client.applyDeltas(deltas));

const authority = new ReplicationSystem({ name: 'ConflictServer', mode: NetMode.Server, localRole: NetRole.Authority });
authority.register(7, { role: NetRole.Authority, properties: { health: 100, team: 'red', kills: 0 } });
console.log('conflicts:', authority.applyDeltas(deltas), 'state held:', authority.get(7).snapshot().health);

const snapshot = server.snapshot();
const lateJoin = new ReplicationSystem({ name: 'LateJoin' });
console.log('late join objects:', lateJoin.loadSnapshot(JSON.stringify(snapshot)), 'state:', lateJoin.get(8).snapshot());

const channel = new NetChannel({ name: 'state' });
const records = [channel.send({ x: 1 }), channel.send({ x: 2 }), channel.send({ x: 3 })];
console.log('out of order:', channel.receive(records[2]).length, channel.receive(records[1]).length,
  'then in order:', channel.receive(records[0]).map((record) => record.payload.x));
console.log('duplicate:', channel.receive(records[0]).length, 'ack:', channel.ack(3), channel.describe());

const rpc = server.queueRpc(7, 'fire', { weapon: 'rifle', tick: server.tickCount }, { target: RpcTarget.All });
client.onRpc(7, 'fire', (args) => console.log('rpc received:', args));
console.log('rpc queue:', server.drainRpcs().length, 'dispatch:', client.receiveRpc(rpc));
console.log('unhandled:', client.receiveRpc({ netId: 99, name: 'missing', args: null }).handled);

server.setRelevancyFilter((object, viewer) => object.netId <= (viewer?.maxId ?? 0));
server.setProperty(7, 'health', 55);
console.log('dormant flush:', server.collectDeltas({ viewer: { maxId: 0 } }).length,
  'relevant flush:', server.collectDeltas({ viewer: { maxId: 10 } }).length);

server.setRelevancyFilter(null);
const console_ = new Console();
server.installConsoleCommands(console_);
console.log('console net.tick:', console_.exec('net.tick 2', { silent: true }).output);
console.log('console net.set:', console_.exec('net.set 7 health 40', { silent: true }).output);
console.log('console net.flush:', console_.exec('net.flush', { silent: true }).output);
console.log(server.format());
