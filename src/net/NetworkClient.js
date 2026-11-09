/**
 * OminX Engine — multiplayer client.
 *
 * Connects to `server/bin/ominx-server.js` over a WebSocket and keeps this engine instance in sync
 * with the authoritative match:
 *
 *  · **input** — the local player's input frame is sent at the input rate (60 Hz);
 *  · **snapshots** — remote actors are interpolated between the last two binary snapshots (20 Hz)
 *    so movement stays smooth even though packets are not;
 *  · **authority** — the server decides damage and death; the client predicts its own movement and
 *    reconciles with the server's `lastProcessedInput`;
 *  · **session events** — kills, captures and phase changes arrive as control messages and are
 *    forwarded to the local session/HUD, so a networked match uses the same presentation code as a
 *    bot match.
 *
 * @module src/net/NetworkClient
 */
import { createLogger } from '../../engine/src/core/Logger.js';
import {
  PROTOCOL_VERSION, MessageType, ActorFlags,
  encodeSnapshot, decodeSnapshot, encodeMessage, decodeMessage, actorFlags, numericId,
} from './Protocol.js';
import { clamp } from '../../engine/src/math/MathUtils.js';

const log = createLogger('NetworkClient');

export const NetState = {
  Idle: 'idle',
  Connecting: 'connecting',
  Connected: 'connected',
  Reconnecting: 'reconnecting',
  Closed: 'closed',
  Error: 'error',
};

export class NetworkClient {
  /**
   * @param {import('../app/Engine.js').Engine} engine
   * @param {object} opts `{ url, name, reconnect }`
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.url = opts.url ?? 'ws://localhost:8787';
    this.name = opts.name ?? 'Player';
    this.autoReconnect = opts.reconnect !== false;
    this.state = NetState.Idle;
    this.socket = null;
    this.players = new Map();
    this.remoteActors = new Map();
    this.localId = null;
    this.clientId = null;
    this.ping = 0;
    this.loss = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.snapshotRate = 20;
    this.snapshots = { previous: null, current: null, receivedAt: 0 };
    this.sequence = 0;
    this.lastProcessedInput = 0;
    this.serverTick = 0;
    this.interpolationDelayMs = 100;
    this.messagesSent = 0;
    this.messagesReceived = 0;
    this.errors = [];
    this._pingTimer = 0;
    this._rttSamples = [];
    this._inputAccumulator = 0;
    this._reconnectTimer = null;
    this._handlers = [];
    this.MatchOver = this.engine.session?.MatchOver ?? null;
  }

  get connected() { return this.state === NetState.Connected; }
  get actorCount() { return this.remoteActors.size; }

  // ------------------------------------------------------------------ lifecycle
  connect() {
    if (this.socket) this.close();
    this.state = NetState.Connecting;
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        this.state = NetState.Error;
        reject(error);
        return;
      }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const onOpen = () => {
        this.state = NetState.Connected;
        this.send(MessageType.Hello, { name: this.name, protocol: PROTOCOL_VERSION, engine: 'ominx' });
        log.info(`connected to ${this.url}`);
        resolve(this);
      };
      const onError = (event) => {
        this.state = NetState.Error;
        this.errors.push(event?.message ?? 'socket error');
        if (this.state === NetState.Connecting) reject(new Error(`could not reach ${this.url}`));
      };
      const onClose = () => {
        this.state = NetState.Closed;
        this.socket = null;
        this.engine.hud?.pushChat?.('system', 'disconnected');
        if (this.autoReconnect) this._scheduleReconnect();
      };
      const onMessage = (event) => {
        this.bytesIn += typeof event.data === 'string' ? event.data.length : event.data.byteLength ?? 0;
        this.messagesReceived++;
        if (typeof event.data === 'string') this._onControl(event.data);
        else this._onSnapshot(event.data);
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      this._handlers = [['open', onOpen], ['message', onMessage], ['error', onError], ['close', onClose]];
    });
  }

  _scheduleReconnect(delay = 2000) {
    if (this._reconnectTimer || !this.autoReconnect) return;
    this.state = NetState.Reconnecting;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => this._scheduleReconnect(Math.min(delay * 2, 15000)));
    }, delay);
  }

  close() {
    this.autoReconnect = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this.socket) {
      for (const [type, handler] of this._handlers) this.socket.removeEventListener(type, handler);
      try { this.socket.close(); } catch { /* already closing */ }
    }
    this.socket = null;
    this.state = NetState.Closed;
    this.remoteActors.clear();
    return this;
  }

  // ------------------------------------------------------------------ sending
  send(type, payload = {}, meta = {}) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    const text = encodeMessage(type, payload);
    this.socket.send(text);
    this.bytesOut += text.length;
    this.messagesSent++;
    void meta;
    return true;
  }

  sendBinary(buffer) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(buffer);
    this.bytesOut += buffer.byteLength ?? 0;
    return true;
  }

  /** Sends the local input frame (called every simulated tick). */
  sendInput(frame) {
    this.sequence = (this.sequence + 1) & 0xffff;
    this.send(MessageType.Command, { kind: 'input', sequence: this.sequence, frame });
    return this.sequence;
  }

  // ------------------------------------------------------------------ receiving
  _onSnapshot(data) {
    const snapshot = decodeSnapshot(data);
    this.serverTick = snapshot.tick;
    this.snapshots.previous = this.snapshots.current;
    this.snapshots.current = snapshot;
    this.snapshots.receivedAt = performance.now();
    this.rates ??= { snapshots: 0, windowStart: performance.now() };
    this.rates.snapshots++;
    const elapsed = performance.now() - this.rates.windowStart;
    if (elapsed > 2000) {
      this.snapshotRate = (this.rates.snapshots / elapsed) * 1000;
      this.rates.snapshots = 0;
      this.rates.windowStart = performance.now();
    }
    this._applySnapshot(snapshot);
  }

  _onControl(text) {
    let message;
    try {
      message = decodeMessage(text);
    } catch (error) {
      log.warn(`bad control message: ${error.message}`);
      return;
    }
    switch (message.t) {
      case MessageType.Welcome: {
        this.clientId = message.clientId;
        this.localId = message.playerId ?? message.clientId;
        // Snapshots address actors by 16-bit id, so cache ours in the same space — comparing a
        // string id against a numeric snapshot id silently made the client treat itself as remote.
        this.localNetId = numericId(this.localId);
        this.snapshotRate = message.snapshotRate ?? this.snapshotRate;
        this.engine.hud?.pushChat?.('system', `joined ${message.serverName ?? 'server'} as ${this.name}`);
        this.send(MessageType.Join, { name: this.name });
        break;
      }
      case MessageType.Join:
        this.players.set(message.id, { id: message.id, name: message.name, team: message.team, ping: message.ping ?? 0, bot: !!message.bot });
        this.engine.hud?.pushChat?.('system', `${message.name} joined`);
        break;
      case MessageType.Roster: {
        // Binary snapshots carry no strings: this is the table that names them.
        this.roster = new Map();
        for (const entry of message.players ?? []) {
          this.roster.set(entry.netId ?? numericId(entry.id), entry);
          this.players.set(entry.id, { ...(this.players.get(entry.id) ?? {}), ...entry });
        }
        break;
      }
      case MessageType.Leave:
        this.players.delete(message.id);
        this.remoteActors.delete(message.id);
        this.engine.hud?.pushChat?.('system', `${message.name ?? 'player'} left`);
        break;
      case MessageType.Kill:
        this.engine.hud?.killfeed?.(message.killer, message.victim, message.weapon, { headshot: message.headshot, wallbang: message.wallbang, distance: message.distance });
        break;
      case MessageType.Death:
        if (message.id === this.localId) this.engine.session?.onNetworkDeath?.(message);
        break;
      case MessageType.Hit:
        if (message.attacker === this.localId) this.engine.hud?.hitmarker?.(message.headshot ? 'headshot' : message.kill ? 'kill' : 'hit');
        break;
      case MessageType.Scoreboard:
        this.players = new Map((message.players ?? []).map((player) => [player.id, player]));
        this.engine.session?.applyNetworkScoreboard?.(message);
        break;
      case MessageType.Phase:
        this.engine.session?.applyNetworkPhase?.(message);
        break;
      case MessageType.Chat:
        this.engine.hud?.pushChat?.(message.name, message.text, { team: message.team });
        break;
      case MessageType.Pong: {
        const rtt = performance.now() - (message.sentAt ?? performance.now());
        this._rttSamples.push(rtt);
        if (this._rttSamples.length > 12) this._rttSamples.shift();
        this.ping = Math.round(this._rttSamples.reduce((sum, value) => sum + value, 0) / this._rttSamples.length);
        this.loss = clamp((message.lost ?? 0) / Math.max(1, message.sent ?? 1), 0, 1);
        break;
      }
      case MessageType.Tick:
        this.serverTick = message.tick ?? this.serverTick;
        break;
      case MessageType.Error:
        this.errors.push(message.message);
        log.warn(`server: ${message.message}`);
        this.engine.hud?.notice?.('Server', message.message, 3);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ actor sync
  /**
   * Applies a snapshot to the local world: remote players are moved (falls back to spawning a
   * lightweight actor when a peer appears), and the local player is reconciled.
   */
  /** Name and team for a snapshot actor, resolved through the roster table. */
  identityFor(netId) {
    const entry = this.roster?.get(netId);
    if (entry) return entry;
    for (const player of this.players.values()) {
      if (numericId(player.id) === netId) return player;
    }
    return null;
  }

  _applySnapshot(snapshot) {
    const seen = new Set();
    for (const record of snapshot.actors) {
      seen.add(record.netId);
      if (record.netId === (this.localNetId ?? numericId(this.localId))) {
        this.lastProcessedInput = record.lastProcessedInput;
        continue;
      }
      let actor = this.remoteActors.get(record.netId);
      if (!actor) actor = this._spawnRemoteActor(record);
      if (!actor) continue;
      actor.netSnapshot = { ...record, receivedAt: performance.now() };
      actor.targetPosition = { x: record.x, y: record.y, z: record.z };
      actor.targetYaw = record.yaw;
      actor.targetPitch = record.pitch;
      if (actor.health) {
        actor.health.health = record.health;
        actor.health.armor = record.armor;
      }
      actor.netFlags = record.flags;
    }
    for (const [netId, actor] of this.remoteActors) {
      if (seen.has(netId)) continue;
      actor.destroy?.();
      this.remoteActors.delete(netId);
    }
  }

  _spawnRemoteActor(record) {
    const session = this.engine.session;
    const spawn = { x: record.x, y: record.y, z: record.z };
    const isFriendly = record.team === this.engine.session?.localTeam;
    const actor = session?.spawnRemotePlayer?.({
      netId: record.netId,
      name: this.players.get(record.netId)?.name ?? `Player_${record.netId}`,
      team: record.team,
      position: spawn,
      isBot: !!(record.flags & ActorFlags.Bot),
      friendly: isFriendly,
    }) ?? null;
    if (actor) this.remoteActors.set(record.netId, actor);
    else log.warn(`no session to host remote actor ${record.netId}`);
    return actor;
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    if (this.state !== NetState.Connected) return this;
    this._pingTimer += dt;
    if (this._pingTimer >= 1) {
      this._pingTimer = 0;
      this.send(MessageType.Ping, { sentAt: performance.now() });
    }
    // Send input at the input rate.
    this._inputAccumulator += dt;
    const interval = 1 / 60;
    while (this._inputAccumulator >= interval) {
      this._inputAccumulator -= interval;
      const input = this.engine.input?.getNetworkFrame?.() ?? this._sampleInput();
      this.sendInput(input);
    }
    this._interpolate();
    return this;
  }

  _sampleInput() {
    const input = this.engine.input;
    const state = input?.state ?? {};
    const look = input?.getLookDelta?.({}) ?? { yaw: 0, pitch: 0 };
    return {
      moveX: state.move?.x ?? 0,
      moveY: state.move?.y ?? 0,
      yaw: look.yaw,
      pitch: look.pitch,
      fire: !!state.fire,
      aim: !!state.aim,
      sprint: !!state.sprint,
      crouch: !!state.crouch,
      jump: input?.wasReleased?.(input.Bindings?.jump?.[0] ?? 'Space') ?? false,
    };
  }

  /**
   * Interpolates remote actors between snapshots. The interpolation window is deliberately a
   * little behind the newest snapshot so late packets do not cause stutter.
   */
  _interpolate(dt = this.engine.fixedStep) {
    const now = performance.now();
    for (const actor of this.remoteActors.values()) {
      const snapshot = actor.netSnapshot;
      if (!snapshot) continue;
      const age = (now - snapshot.receivedAt) / 1000;
      const smoothing = clamp(1 - Math.exp(-(age < 0.4 ? 18 : 8) * dt), 0, 1);
      actor.character?.teleport?.(snapshot.x, snapshot.y, snapshot.z) ?? this._lerpActor(actor, snapshot, smoothing);
      if (actor.look) {
        actor.look.yaw = lerpAngle(actor.look.yaw, snapshot.yaw, smoothing);
        actor.look.pitch = actor.look.pitch + (snapshot.pitch - actor.look.pitch) * smoothing;
      }
      actor.character && (actor.character.velocity.x = snapshot.vx ?? 0, actor.character.velocity.z = snapshot.vz ?? 0);
    }
  }

  _lerpActor(actor, snapshot, t) {
    const character = actor.character;
    if (!character) return;
    character.position.x += (snapshot.x - character.position.x) * t;
    character.position.y += (snapshot.y - character.position.y) * t;
    character.position.z += (snapshot.z - character.position.z) * t;
  }

  /** Local snapshot of this client's actors — used when hosting from the Studio. */
  buildLocalSnapshot(tick, actors) {
    return encodeSnapshot({
      tick,
      serverTime: performance.now() / 1000,
      actors: actors.map((actor, index) => ({
        netId: actor.netId ?? index + 1,
        position: actor.character?.position,
        yaw: actor.look?.yaw ?? 0,
        pitch: actor.look?.pitch ?? 0,
        health: actor.health?.health ?? 0,
        armor: actor.health?.armor ?? 0,
        velocity: actor.character?.velocity,
        team: actor.team,
        flags: actorFlags(actor),
      })),
    });
  }
}

function lerpAngle(from, to, t) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

export { encodeSnapshot, decodeSnapshot, MessageType, ActorFlags };
export default NetworkClient;
