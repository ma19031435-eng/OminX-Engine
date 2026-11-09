/**
 * OminX Engine — multiplayer protocol.
 *
 * Two wire formats on one WebSocket:
 *  · **control messages** (JSON text) — handshake, chat, kills, phase changes, scoreboard, ping;
 *  · **snapshots** (binary `ArrayBuffer`) — 20 Hz world state, quantised so a 16-player snapshot
 *    fits in ~200 bytes: positions to 1 cm, yaw/pitch to 1/100 rad, health to a byte, flags in a
 *    bitfield. Text frames carry no snapshot state, binary frames carry no control state, so a
 *    decoder never has to guess.
 *
 * The same encoding is used by the server (`server/bin/ominx-server.js`) and the client, and is
 * unit-tested round-trip in `tests/net.test.js`.
 *
 * @module src/net/Protocol
 */
export const PROTOCOL_VERSION = 3;
export const DEFAULT_PORT = 8787;
export const SNAPSHOT_RATE = 20;
export const INPUT_RATE = 60;

/** Control message types (text frames). */
export const MessageType = {
  Hello: 'hello',
  Welcome: 'welcome',
  Join: 'join',
  Leave: 'leave',
  Spawn: 'spawn',
  Death: 'death',
  Kill: 'kill',
  Hit: 'hit',
  Damage: 'damage',
  Chat: 'chat',
  Roster: 'roster',
  Scoreboard: 'scoreboard',
  Phase: 'phase',
  Tick: 'tick',
  Ping: 'ping',
  Pong: 'pong',
  Project: 'project',
  Error: 'error',
  Command: 'command',
};

/** Actor flags inside a snapshot record. */
export const ActorFlags = {
  Alive: 1 << 0,
  Crouching: 1 << 1,
  Sprinting: 1 << 2,
  Ads: 1 << 3,
  Firing: 1 << 4,
  Reloading: 1 << 5,
  Jumping: 1 << 6,
  OnGround: 1 << 7,
  Bot: 1 << 8,
  Local: 1 << 9,
};

/**
 * Stable 16-bit id for an actor. Snapshots carry integers and the roster carries names, so both
 * ends must derive the same number from the same string — this is the one implementation.
 */
/** Bytes in one client input frame (server and client must agree). */
export const INPUT_FRAME_BYTES = 16;

export function numericId(value) {
  if (typeof value === 'number') return value & 0xffff;
  let hash = 0;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) & 0xffff;
  return hash === 0 ? 1 : hash;
}

export const POSITION_SCALE = 100; // 1 cm
export const ANGLE_SCALE = 100; // 1/100 rad
export const SNAPSHOT_HEADER_BYTES = 12;
export const ACTOR_RECORD_BYTES = 26;

const TEAM_INDEX = { neutral: 0, red: 1, blue: 2, spectators: 3 };

function clampInt(value, min, max) {
  const v = Math.round(value);
  return v < min ? min : v > max ? max : v;
}

/** Encodes a snapshot into an `ArrayBuffer` sized exactly for the actor count. */
export function encodeSnapshot({ tick = 0, serverTime = 0, actors = [], phase = 0, mode = 0 } = {}, buffer = null) {
  const count = Math.min(actors.length, 255);
  const bytes = SNAPSHOT_HEADER_BYTES + count * ACTOR_RECORD_BYTES;
  const target = buffer && buffer.byteLength >= bytes ? buffer : new ArrayBuffer(bytes);
  const view = new DataView(target);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, count);
  view.setUint8(2, phase & 0xff);
  view.setUint8(3, mode & 0xff);
  view.setUint32(4, tick >>> 0, true);
  view.setFloat32(8, serverTime, true);
  let offset = SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const actor = actors[i];
    const position = actor.position ?? actor.character?.position ?? { x: 0, y: 0, z: 0 };
    view.setUint16(offset, actor.netId ?? i, true);
    view.setUint16(offset + 2, actor.id ?? 0, true);
    view.setInt16(offset + 4, clampInt(position.x * POSITION_SCALE, -32000, 32000), true);
    view.setInt16(offset + 6, clampInt(position.y * POSITION_SCALE, -32000, 32000), true);
    view.setInt16(offset + 8, clampInt(position.z * POSITION_SCALE, -32000, 32000), true);
    view.setInt16(offset + 10, clampInt((actor.yaw ?? 0) * ANGLE_SCALE, -32000, 32000), true);
    view.setInt16(offset + 12, clampInt((actor.pitch ?? 0) * ANGLE_SCALE, -32000, 32000), true);
    view.setUint8(offset + 14, clampInt(actor.health?.health ?? actor.healthValue ?? 0, 0, 255));
    view.setUint8(offset + 15, clampInt(actor.health?.armor ?? actor.armorValue ?? 0, 0, 255));
    view.setUint16(offset + 16, actor.flags ?? 0, true);
    view.setUint8(offset + 18, TEAM_INDEX[actor.team] ?? 0);
    view.setUint8(offset + 19, actor.weaponIndex ?? 0);
    view.setInt16(offset + 20, clampInt((actor.velocity?.x ?? 0) * POSITION_SCALE, -32000, 32000), true);
    view.setInt16(offset + 22, clampInt((actor.velocity?.z ?? 0) * POSITION_SCALE, -32000, 32000), true);
    view.setUint16(offset + 24, actor.lastProcessedInput ?? 0, true);
    offset += ACTOR_RECORD_BYTES;
  }
  return target.byteLength === bytes ? target : target.slice(0, bytes);
}

/** Decodes a snapshot buffer (accepts `ArrayBuffer` or a typed-array view). */
export function decodeSnapshot(data) {
  const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) throw new Error(`snapshot protocol mismatch: got ${version}, expected ${PROTOCOL_VERSION}`);
  const count = view.getUint8(1);
  const snapshot = {
    version,
    tick: view.getUint32(4, true),
    serverTime: view.getFloat32(8, true),
    phase: view.getUint8(2),
    mode: view.getUint8(3),
    actors: new Array(count),
  };
  let offset = SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    snapshot.actors[i] = {
      netId: view.getUint16(offset, true),
      id: view.getUint16(offset + 2, true),
      x: view.getInt16(offset + 4, true) / POSITION_SCALE,
      y: view.getInt16(offset + 6, true) / POSITION_SCALE,
      z: view.getInt16(offset + 8, true) / POSITION_SCALE,
      yaw: view.getInt16(offset + 10, true) / ANGLE_SCALE,
      pitch: view.getInt16(offset + 12, true) / ANGLE_SCALE,
      health: view.getUint8(offset + 14),
      armor: view.getUint8(offset + 15),
      flags: view.getUint16(offset + 16, true),
      team: Object.keys(TEAM_INDEX).find((key) => TEAM_INDEX[key] === view.getUint8(offset + 18)) ?? 'neutral',
      weaponIndex: view.getUint8(offset + 19),
      vx: view.getInt16(offset + 20, true) / POSITION_SCALE,
      vz: view.getInt16(offset + 22, true) / POSITION_SCALE,
      lastProcessedInput: view.getUint16(offset + 24, true),
    };
    offset += ACTOR_RECORD_BYTES;
  }
  return snapshot;
}

/**
 * Client input frame: the exact input object `Player.update` consumes, quantised. The server
 * re-simulates the local player from these (client-side prediction + server reconciliation).
 */
export function encodeInput(frame = {}, sequence = 0, buffer = null) {
  // Fixed 16-byte frame: seq(4) dt(4) yaw(2) pitch(2) moveX(1) moveY(1) buttons(1) stance(1).
  // The old size was one byte short of the last write, so *every* call threw a RangeError — the
  // browser client could never send a frame.
  const bytes = INPUT_FRAME_BYTES;
  const target = buffer && buffer.byteLength >= bytes ? buffer : new ArrayBuffer(bytes);
  const view = new DataView(target);
  view.setUint32(0, sequence >>> 0, true);
  view.setFloat32(4, frame.dt ?? 0, true);
  view.setInt16(8, clampInt((frame.yaw ?? 0) * ANGLE_SCALE, -32000, 32000), true);
  view.setInt16(10, clampInt((frame.pitch ?? 0) * ANGLE_SCALE, -32000, 32000), true);
  view.setInt8(12, clampInt((frame.moveX ?? 0) * 127, -127, 127));
  view.setInt8(13, clampInt((frame.moveY ?? 0) * 127, -127, 127));
  let buttons = 0;
  if (frame.fire) buttons |= 1;
  if (frame.aim) buttons |= 2;
  if (frame.sprint) buttons |= 4;
  if (frame.crouch) buttons |= 8;
  if (frame.jump) buttons |= 16;
  if (frame.reload) buttons |= 32;
  if (frame.interact) buttons |= 64;
  view.setUint8(14, buttons);
  view.setUint8(15, frame.stanceIndex ?? 0);
  return target;
}

export function decodeInput(data) {
  const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (buffer.byteLength < INPUT_FRAME_BYTES) throw new Error(`input frame too short: ${buffer.byteLength} bytes`);
  const view = new DataView(buffer);
  const buttons = view.getUint8(14);
  return {
    sequence: view.getUint32(0, true),
    dt: view.getFloat32(4, true),
    yaw: view.getInt16(8, true) / ANGLE_SCALE,
    pitch: view.getInt16(10, true) / ANGLE_SCALE,
    moveX: view.getInt8(12) / 127,
    moveY: view.getInt8(13) / 127,
    fire: !!(buttons & 1),
    aim: !!(buttons & 2),
    sprint: !!(buttons & 4),
    crouch: !!(buttons & 8),
    jump: !!(buttons & 16),
    reload: !!(buttons & 32),
    interact: !!(buttons & 64),
    stanceIndex: view.getUint8(15),
  };
}

/** Control messages are JSON with `{ t, ...payload }`. */
export function encodeMessage(type, payload = {}) {
  return JSON.stringify({ t: type, v: PROTOCOL_VERSION, ...payload });
}

export function decodeMessage(text) {
  const message = typeof text === 'string' ? JSON.parse(text) : text;
  if (!message || typeof message !== 'object' || !message.t) throw new Error('malformed control message');
  return message;
}

/** Builds the per-actor flags bitfield from an engine actor. */
export function actorFlags(actor) {
  let flags = 0;
  if (actor.health?.alive !== false) flags |= ActorFlags.Alive;
  if (actor.character?.stance === 'crouch') flags |= ActorFlags.Crouching;
  if (actor.character?.sprinting) flags |= ActorFlags.Sprinting;
  if ((actor.adsBlend ?? 0) > 0.5) flags |= ActorFlags.Ads;
  if (actor.weapon?.triggerHeld) flags |= ActorFlags.Firing;
  if (actor.weapon?.reloading) flags |= ActorFlags.Reloading;
  if (!actor.character?.onGround) flags |= ActorFlags.Jumping;
  if (actor.character?.onGround) flags |= ActorFlags.OnGround;
  if (actor.isBot) flags |= ActorFlags.Bot;
  if (actor.isLocal) flags |= ActorFlags.Local;
  return flags;
}

/** Human-readable size helper used by the netgraph. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

export { TEAM_INDEX };
export default {
  PROTOCOL_VERSION, MessageType, ActorFlags,
  encodeSnapshot, decodeSnapshot, encodeInput, decodeInput, encodeMessage, decodeMessage, actorFlags,
};
