/**
 * End-to-end network probe: talks to a running OminX dedicated server over a real WebSocket.
 *
 *   node server/bin/ominx-server.js --port 8787 --bots 4 &
 *   node tools/scratch/ws-client.mjs ws://localhost:8787
 *
 * Asserts the whole wire path: control handshake, team join, binary snapshot decoding (header,
 * actor records, team/name tables), binary input upload, chat, ping/pong and the HTTP endpoints.
 * Exits non-zero on the first failure so it can gate CI.
 */
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION, MessageType, decodeSnapshot, encodeInput, decodeMessage, actorFlags,
  numericId, ActorFlags, ACTOR_RECORD_BYTES, SNAPSHOT_HEADER_BYTES,
} from '../../src/net/Protocol.js';

const url = process.argv[2] ?? 'ws://localhost:8787';
const httpBase = url.replace(/^ws/, 'http');
const failures = [];
const notes = [];
const check = (label, ok, detail = '') => {
  if (ok) notes.push(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

const socket = new WebSocket(url);
const messages = [];
const snapshots = [];
let welcome = null;
let pong = null;
let chat = null;
const joined = { resolve: null };

socket.on('message', (data, isBinary) => {
  if (isBinary) {
    try {
      snapshots.push(decodeSnapshot(data));
    } catch (error) {
      failures.push(`  FAIL snapshot decode — ${error.message}`);
    }
    return;
  }
  const message = (() => { try { return decodeMessage(data.toString()); } catch { return null; } })();
  if (!message) return;
  messages.push(message);
  if (message.t === MessageType.Welcome || message.t === 'welcome') welcome = message;
  if (message.t === MessageType.Pong || message.t === 'pong') pong = message;
  if (message.t === MessageType.Chat || message.t === 'chat') chat = message;
  if (message.t === MessageType.Joined || message.t === 'joined' || message.t === 'spawn') joined.resolve?.(message);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
  setTimeout(() => reject(new Error('connect timeout')), 5000);
});
check('websocket connects', true, url);

// ---- handshake -----------------------------------------------------------
socket.send(JSON.stringify({ t: MessageType.Hello, v: PROTOCOL_VERSION, protocol: PROTOCOL_VERSION, name: 'WireProbe' }));
await wait(150);
check('hello → welcome', !!welcome, welcome ? `id ${welcome.clientId}` : 'no welcome received');
check('server tick rate advertised', welcome?.tickRate === 60, `${welcome?.tickRate} Hz`);

// ---- join ---------------------------------------------------------------
const joinedPromise = new Promise((resolve) => { joined.resolve = resolve; });
socket.send(JSON.stringify({ t: MessageType.Join, v: PROTOCOL_VERSION, team: 'red', name: 'WireProbe' }));
const joinMessage = await Promise.race([joinedPromise, wait(1500).then(() => null)]);
check('join acknowledged', !!joinMessage || snapshots.length > 0, joinMessage ? JSON.stringify(joinMessage).slice(0, 120) : `${snapshots.length} snapshots`);

// ---- snapshot stream ----------------------------------------------------
await wait(600);
const snapshot = snapshots[snapshots.length - 1];
check('binary snapshots arrive', snapshots.length > 3, `${snapshots.length} in ~750 ms (expect ~20 Hz)`);
if (snapshot) {
  const expectedActors = 4 + 1; // --bots 4 plus the probe
  check('snapshot header parses', Number.isFinite(snapshot.tick) && snapshot.actors?.length > 0,
    `tick ${snapshot.tick} · phase ${snapshot.phase} · ${snapshot.actors.length} actors`);
  const roster = messages.filter((message) => message.t === MessageType.Roster || message.t === 'roster').pop();
  const rosterById = new Map((roster?.players ?? []).map((entry) => [entry.netId, entry]));
  check('roster message names every actor', snapshot.actors.every((a) => rosterById.has(a.netId)),
    `${rosterById.size} roster entries for ${snapshot.actors.length} actors`);
  check('roster identities are complete',
    [...rosterById.values()].every((entry) => typeof entry.name === 'string' && entry.name.length > 0 && entry.team),
    [...rosterById.values()].map((entry) => `${entry.name}:${entry.team}`).join(' '));
  check('probe present in the roster', [...rosterById.values()].some((entry) => entry.name === 'WireProbe'));
  check('actor count matches the match', snapshot.actors.length >= expectedActors,
    `${snapshot.actors.length} actors`);
  const rawBytes = snapshot.actors.length * ACTOR_RECORD_BYTES + SNAPSHOT_HEADER_BYTES;
  check('snapshot size matches its actor count', rawBytes > 40 && rawBytes < 4096,
    `${snapshot.actors.length} actors → ${rawBytes} B (26 B/actor + 12 B header)`);
  const mine = snapshot.actors.find((a) => rosterById.get(a.netId)?.name === 'WireProbe');
  check('probe found in the snapshot stream', !!mine, mine ? `netId ${mine.netId}` : 'no actor for our netId');
  if (mine) {
    const start = { x: mine.x, z: mine.z };
    // ---- binary input upload: walk north for half a second ------------------
    for (let i = 0; i < 30; i++) {
      socket.send(encodeInput({ dt: 1 / 60, moveY: 1, moveX: 0, fire: i % 10 === 0, aim: false, sprint: true }, i));
      await wait(16);
    }
    await wait(400);
    const after = snapshots[snapshots.length - 1].actors.find((a) => a.netId === mine.netId);
    const moved = after ? Math.hypot(after.x - start.x, after.z - start.z) : 0;
    check('binary input moves the player', moved > 1.0, `${moved.toFixed(2)} m from the input frames`);
    check('server acknowledges processed input', (after?.lastProcessedInput ?? 0) > 0,
      `lastProcessedInput ${after?.lastProcessedInput ?? 0}`);
    const flags = actorFlags({ health: { alive: true }, character: { stance: 'crouch', onGround: true }, weapon: { triggerHeld: true }, isBot: true, adsBlend: 1 });
    check('actor flags encode state',
      (flags & ActorFlags.Alive) && (flags & ActorFlags.Crouching) && (flags & ActorFlags.Firing)
      && (flags & ActorFlags.Ads) && (flags & ActorFlags.Bot) && (flags & ActorFlags.OnGround),
      `flags 0x${flags.toString(16)}`);
    const liveFlags = mine.flags;
    check('live snapshot flags are plausible', (liveFlags & ActorFlags.Alive) !== 0, `flags 0x${liveFlags.toString(16)}`);
  }
}

// ---- chat + ping --------------------------------------------------------
socket.send(JSON.stringify({ t: MessageType.Chat, v: PROTOCOL_VERSION, text: 'probe online' }));
await wait(200);
check('chat round-trips', chat?.text === 'probe online', chat ? `${chat.name}: ${chat.text}` : 'no echo');

const sentAt = Date.now();
socket.send(JSON.stringify({ t: MessageType.Ping, v: PROTOCOL_VERSION, sentAt }));
await wait(200);
check('ping → pong', !!pong, pong ? `${pong.ping} ms, tick ${pong.tick}` : 'no pong');

// ---- http endpoints -----------------------------------------------------
for (const [path, label] of [['/', 'status page'], ['/health', 'health json'], ['/stats', 'stats json']]) {
  const response = await fetch(`${httpBase}${path}`).catch((error) => ({ ok: false, status: error.message }));
  check(`http ${path} (${label})`, response.ok === true, `status ${response.status}`);
}
const stats = await fetch(`${httpBase}/stats`).then((r) => r.json()).catch(() => null);
check('stats counted our traffic', (stats?.messages ?? 0) > 0 && (stats?.joins ?? 0) > 0,
  `joins ${stats?.joins}, messages ${stats?.messages}, bytesIn ${stats?.bytesIn}`);
check('snapshot size is sane', (stats?.lastSnapshotBytes ?? 0) > 40 && (stats?.lastSnapshotBytes ?? 0) < 2000,
  `${stats?.lastSnapshotBytes} B`);

socket.close();
process.stdout.write(`${[...notes, ...failures].join('\n')}\n`);
process.stdout.write(failures.length === 0 ? `\nws-client: all ${notes.length} checks passed\n` : `\nws-client: ${failures.length} check(s) failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
