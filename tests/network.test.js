/**
 * Network integration tests — a real WebSocket client against a real MatchServer.
 *
 * The server is started in-process on an ephemeral port and driven through the same wire protocol a
 * browser uses: JSON handshake, 20 Hz binary snapshots, a roster table, 16-byte input frames, chat
 * and ping. Every assertion here failed at least once before this file existed — the input encoder
 * used to be one byte short, snapshots carried no way to name an actor, and the client compared its
 * string id against the numeric one in the snapshot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { MatchServer } from '../server/src/MatchServer.js';
import { MatchMode } from '../server/src/MatchRunner.js';
import {
  PROTOCOL_VERSION, MessageType, ActorFlags, decodeSnapshot, encodeInput, decodeInput, decodeMessage,
  actorFlags, numericId, INPUT_FRAME_BYTES, ACTOR_RECORD_BYTES, SNAPSHOT_HEADER_BYTES,
} from '../src/net/Protocol.js';

/** Boots a server on a free port and hands the test its URL. */
async function startServer(options = {}) {
  const server = new MatchServer({
    port: 0,
    host: '127.0.0.1',
    tickRate: 60,
    snapshotRate: 20,
    ...options,
  });
  await server.listen();
  const port = server._http.address().port;
  return { server, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

/** Collects control and binary messages for `ms`, then resolves. */
async function collect(socket, ms) {
  const control = [];
  const snapshots = [];
  const onMessage = (data, isBinary) => {
    if (isBinary) {
      snapshots.push(decodeSnapshot(data));
      return;
    }
    try { control.push(decodeMessage(data.toString())); } catch { /* ignore */ }
  };
  socket.on('message', onMessage);
  await new Promise((resolve) => setTimeout(resolve, ms));
  socket.off('message', onMessage);
  return { control, snapshots };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('input frames round-trip at a fixed 16-byte size', () => {
  const frame = { dt: 1 / 60, yaw: 0.5, pitch: -0.2, moveX: 0.5, moveY: 1, fire: true, aim: true, sprint: true, jump: true, reload: false };
  const buffer = encodeInput(frame, 42);
  assert.equal(buffer.byteLength, INPUT_FRAME_BYTES);
  const decoded = decodeInput(buffer);
  assert.equal(decoded.sequence, 42);
  assert.ok(Math.abs(decoded.yaw - 0.5) < 0.01);
  assert.ok(Math.abs(decoded.pitch + 0.2) < 0.01);
  assert.ok(decoded.fire && decoded.aim && decoded.sprint && decoded.jump && !decoded.reload);
  assert.throws(() => decodeInput(new ArrayBuffer(8)), /too short/);
});

test('a client completes the handshake, joins and receives a snapshot stream', async (t) => {
  const { server, url, http } = await startServer({ match: { map: 'arena', bots: 4, warmup: 2, tickRate: 60 } });
  t.after(() => server.close());

  const socket = new WebSocket(url);
  await once(socket, 'open');
  t.after(() => socket.close());

  socket.send(JSON.stringify({ t: MessageType.Hello, v: PROTOCOL_VERSION, protocol: PROTOCOL_VERSION, name: 'NetProbe' }));
  const hello = await collect(socket, 200);
  const welcome = hello.control.find((message) => message.t === MessageType.Welcome);
  assert.ok(welcome, 'no welcome message');
  assert.equal(welcome.tickRate, 60);

  socket.send(JSON.stringify({ t: MessageType.Join, v: PROTOCOL_VERSION, team: 'red', name: 'NetProbe' }));
  const { control, snapshots } = await collect(socket, 700);

  assert.ok(snapshots.length >= 8, `expected ~20 Hz snapshots, got ${snapshots.length}`);
  const snapshot = snapshots.at(-1);
  assert.ok(snapshot.actors.length >= 5, `expected 4 bots + the client, got ${snapshot.actors.length}`);
  const expectedBytes = snapshot.actors.length * ACTOR_RECORD_BYTES + SNAPSHOT_HEADER_BYTES;
  assert.ok(expectedBytes > 100);

  // Names travel in the roster: snapshots are pure binary.
  const roster = control.filter((message) => message.t === MessageType.Roster).at(-1);
  assert.ok(roster, 'no roster message');
  const byNetId = new Map(roster.players.map((entry) => [entry.netId, entry]));
  for (const actor of snapshot.actors) {
    assert.ok(byNetId.has(actor.netId), `actor ${actor.netId} is missing from the roster`);
    assert.ok(byNetId.get(actor.netId).name.length > 0);
  }
  assert.ok([...byNetId.values()].some((entry) => entry.name === 'NetProbe'), 'our own name is missing');
  assert.ok([...byNetId.values()].some((entry) => entry.bot), 'bots should be flagged in the roster');

  // HTTP endpoints share the port.
  const health = await fetch(`${http}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.players, snapshot.actors.length);
  const stats = await fetch(`${http}/stats`).then((response) => response.json());
  assert.ok(stats.joins >= 1);
  const page = await fetch(`${http}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /OminX Dedicated Server/);
});

test('binary input drives the authoritative player and is acknowledged', async (t) => {
  const { server, url } = await startServer({ match: { map: 'arena', bots: 2, warmup: 2, tickRate: 60 } });
  t.after(() => server.close());

  const socket = new WebSocket(url);
  await once(socket, 'open');
  t.after(() => socket.close());

  socket.send(JSON.stringify({ t: MessageType.Hello, v: PROTOCOL_VERSION, protocol: PROTOCOL_VERSION, name: 'Walker' }));
  await collect(socket, 120);
  socket.send(JSON.stringify({ t: MessageType.Join, v: PROTOCOL_VERSION, team: 'blue', name: 'Walker' }));
  const start = await collect(socket, 400);

  const roster = start.control.filter((message) => message.t === MessageType.Roster).at(-1);
  const myNetId = roster.players.find((entry) => entry.name === 'Walker').netId;
  const findSelf = (snapshots) => snapshots.at(-1).actors.find((actor) => actor.netId === myNetId);
  const first = findSelf(start.snapshots);
  assert.ok(first, 'our actor never appeared in a snapshot');

  for (let i = 0; i < 30; i++) {
    socket.send(encodeInput({ dt: 1 / 60, moveY: 1, sprint: true, fire: i % 10 === 0 }, i));
    await wait(16);
  }
  const after = await collect(socket, 400);
  const moved = findSelf(after.snapshots);
  const distance = Math.hypot(moved.x - first.x, moved.z - first.z);
  assert.ok(distance > 0.5, `client input moved the player only ${distance.toFixed(2)} m`);
  assert.ok(moved.lastProcessedInput > 0, 'server never acknowledged an input frame');
  assert.ok((moved.flags & ActorFlags.Alive) !== 0);
});

test('chat, ping and the scoreboard round-trip', async (t) => {
  const { server, url } = await startServer({ match: { map: 'arena', bots: 2, warmup: 2 } });
  t.after(() => server.close());

  const socket = new WebSocket(url);
  await once(socket, 'open');
  t.after(() => socket.close());

  socket.send(JSON.stringify({ t: MessageType.Hello, v: PROTOCOL_VERSION, protocol: PROTOCOL_VERSION, name: 'Talker' }));
  await collect(socket, 120);
  // Join, chat and ping inside one collection window: the scoreboard is pushed *at* join time.
  socket.send(JSON.stringify({ t: MessageType.Join, v: PROTOCOL_VERSION, team: 'red', name: 'Talker' }));
  const sentAt = Date.now();
  socket.send(JSON.stringify({ t: MessageType.Chat, v: PROTOCOL_VERSION, text: 'hold the point' }));
  socket.send(JSON.stringify({ t: MessageType.Ping, v: PROTOCOL_VERSION, sentAt }));
  const { control } = await collect(socket, 500);

  const chat = control.filter((message) => message.t === MessageType.Chat).at(-1);
  assert.equal(chat.text, 'hold the point');
  assert.equal(chat.name, 'Talker');
  const pong = control.filter((message) => message.t === MessageType.Pong).at(-1);
  assert.ok(pong, 'no pong');
  assert.equal(pong.sentAt, sentAt);
  assert.ok(pong.tick > 0);

  const scoreboard = control.filter((message) => message.t === MessageType.Scoreboard).at(-1);
  assert.ok(scoreboard, 'no scoreboard');
  assert.ok(scoreboard.players.some((player) => player.name === 'Talker'));
  assert.equal(scoreboard.mode, MatchMode.TDM);
});

test('a protocol mismatch is rejected instead of half-joined', async (t) => {
  const { server, url } = await startServer({ match: { map: 'arena', bots: 1 } });
  t.after(() => server.close());

  const socket = new WebSocket(url);
  await once(socket, 'open');
  socket.send(JSON.stringify({ t: MessageType.Hello, v: PROTOCOL_VERSION - 1, protocol: PROTOCOL_VERSION - 1, name: 'Old' }));
  const { control } = await collect(socket, 250);
  const error = control.find((message) => message.t === MessageType.Error);
  assert.ok(error, 'a stale protocol was accepted');
  assert.match(error.message, /protocol mismatch/);
  socket.close();
});

test('actor flags describe what the actor is doing', () => {
  const flags = actorFlags({
    health: { alive: true },
    character: { stance: 'crouch', onGround: true, sprinting: true },
    weapon: { triggerHeld: true, reloading: true },
    isBot: true,
    adsBlend: 1,
  });
  for (const bit of ['Alive', 'Crouching', 'Sprinting', 'Ads', 'Firing', 'Reloading', 'OnGround', 'Bot']) {
    assert.ok((flags & ActorFlags[bit]) !== 0, `${bit} flag missing (flags 0x${flags.toString(16)})`);
  }
  assert.equal(flags & ActorFlags.Jumping, 0);
  // Dead actors must not report Alive.
  const dead = actorFlags({ health: { alive: false }, character: { onGround: true } });
  assert.equal(dead & ActorFlags.Alive, 0);
});

test('net ids are stable across both ends of the wire', () => {
  assert.equal(numericId('b1'), numericId('b1'));
  assert.notEqual(numericId('b1'), numericId('b2'));
  assert.equal(numericId(1234), 1234);
  assert.ok(numericId('a very long player name') <= 0xffff);
});
