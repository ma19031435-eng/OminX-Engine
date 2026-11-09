/**
 * OminX Engine — authoritative game server.
 *
 * A `ws` WebSocket server in front of a `MatchRunner`. Its job is small and strict:
 *
 *   1. accept connections, hand out a `welcome` with tick/snapshot rates;
 *   2. decode client input frames (binary) and queue them into the runner — clients never send
 *      positions, only intent;
 *   3. tick the runner at a fixed rate and broadcast world snapshots (binary) at the snapshot rate;
 *   4. fan out control messages (kills, captures, phase, scoreboard, chat) and answer pings;
 *   5. host a tiny HTTP surface for health checks and project manifests (`GET /health`,
 *      `GET /stats`, `POST /project`), including a `/` status page.
 *
 * It also self-heals: clients that stop sending input are dropped after a timeout, and the bot
 * population tops the match back up to a configured size.
 *
 * @module server/src/MatchServer
 */
import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { MatchRunner, MatchPhase, MatchMode } from './MatchRunner.js';
import {
  PROTOCOL_VERSION, MessageType, SNAPSHOT_RATE,
  encodeSnapshot, encodeMessage, generateId, decodeInputFrame, numericId,
} from './protocol.js';
import { createLogger } from '../../engine/src/core/Logger.js';

const log = createLogger('MatchServer');

export class MatchServer {
  /**
   * @param {object} [opts] `{ port, host, match: {...}, tickRate, snapshotRate, clientTimeout }`
   */
  constructor(opts = {}) {
    this.options = {
      port: 8787,
      host: '0.0.0.0',
      tickRate: 60,
      snapshotRate: SNAPSHOT_RATE,
      clientTimeout: 15000,
      topUpBots: true,
      ...opts,
    };
    this.runner = new MatchRunner({ ...(opts.match ?? {}), tickRate: this.options.tickRate });
    this.clients = new Map(); // socket → { id, name, team, socket, lastSeen, ping, sentAt, loss }
    this.running = false;
    this.startedAt = Date.now();
    this.stats = { ticks: 0, snapshots: 0, bytesOut: 0, bytesIn: 0, peakClients: 0, joins: 0, messages: 0 };
    this._http = null;
    this._wss = null;
    this._tickTimer = null;
    this._snapshotDivisor = Math.max(1, Math.round(this.options.tickRate / this.options.snapshotRate));
  }

  // ------------------------------------------------------------------ lifecycle
  async listen() {
    if (this.running) return this;
    this._http = createHttpServer((request, response) => this._handleHttp(request, response));
    this._wss = new WebSocketServer({ server: this._http, perMessageDeflate: false, maxPayload: 64 * 1024 });
    this._wss.on('connection', (socket, request) => this._onConnection(socket, request));
    this._wss.on('error', (error) => log.error(`websocket server: ${error.message}`));
    await new Promise((resolve, reject) => {
      this._http.once('error', reject);
      this._http.listen(this.options.port, this.options.host, () => {
        this._http.removeListener('error', reject);
        resolve();
      });
    });
    this.running = true;
    this.startTicking();
    log.info(`listening on ws://${this.options.host === '0.0.0.0' ? 'localhost' : this.options.host}:${this.options.port} (http status page on the same port)`);
    return this;
  }

  async close() {
    this.running = false;
    clearInterval(this._tickTimer);
    this._tickTimer = null;
    for (const client of this.clients.values()) {
      try { client.socket.close(1001, 'server shutting down'); } catch { /* already closed */ }
    }
    this.clients.clear();
    if (this._wss) await new Promise((resolve) => this._wss.close(resolve));
    if (this._http) await new Promise((resolve) => this._http.close(resolve));
    this._wss = null;
    this._http = null;
    log.info('server closed');
    return this;
  }

  /** Starts the fixed-rate simulation loop. */
  startTicking() {
    if (this._tickTimer) return this;
    const intervalMs = 1000 / this.options.tickRate;
    let expected = performance.now();
    this._tickTimer = setInterval(() => {
      // Catch-up loop: if the process was starved, run the missed ticks instead of time-warping.
      let steps = 0;
      const now = performance.now();
      while (expected <= now && steps < 5) {
        this.tickOnce();
        expected += intervalMs;
        steps++;
      }
      if (steps === 0) expected = now;
    }, Math.max(1, Math.floor(intervalMs)));
    if (this._tickTimer.unref) this._tickTimer.unref();
    return this;
  }

  /** One authoritative step: simulate, then publish (snapshots at the snapshot rate). */
  tickOnce() {
    this.runner.update();
    this.stats.ticks++;
    if (this.options.topUpBots && this.runner.bots.length < this.runner.options.bots) this.runner.setBotCount(this.runner.options.bots);
    const events = this.runner.drainEvents();
    for (const event of events) this._broadcastEvent(event);
    if (this.runner.tick % this._snapshotDivisor === 0) this.broadcastSnapshot();
    if (this.runner.scoreboardDirty) {
      this.runner.scoreboardDirty = false;
      this.broadcast(MessageType.Scoreboard, this.runner.getScoreboard());
    }
    this._sweepClients();
    return this;
  }

  // ------------------------------------------------------------------ connections
  _onConnection(socket, request) {
    const id = generateId('p');
    const client = {
      id,
      socket,
      name: `Player_${this.stats.joins + 1}`,
      team: null,
      lastSeen: Date.now(),
      ping: 0,
      sent: 0,
      lost: 0,
      address: request?.socket?.remoteAddress ?? 'unknown',
      joined: false,
    };
    this.clients.set(socket, client);
    this.stats.joins++;
    this.stats.peakClients = Math.max(this.stats.peakClients, this.clients.size);
    socket.binaryType = 'arraybuffer';
    socket.on('message', (data, isBinary) => this._onMessage(client, data, isBinary));
    socket.on('close', () => this._onDisconnect(client));
    socket.on('error', (error) => log.warn(`${client.name}: ${error.message}`));
    this._send(client, MessageType.Welcome, {
      protocol: PROTOCOL_VERSION,
      clientId: id,
      serverName: 'OminX Dedicated',
      tickRate: this.options.tickRate,
      snapshotRate: this.options.snapshotRate,
      match: {
        mode: this.runner.options.mode,
        map: this.runner.options.map,
        phase: this.runner.phase,
        scoreLimit: this.runner.options.scoreLimit,
      },
      players: this.runner.playerCount,
    });
    log.info(`${client.address} connected (${this.clients.size} clients)`);
  }

  _onDisconnect(client) {
    this.clients.delete(client.socket);
    if (client.joined) {
      this.runner.removePlayer(client.id);
      this.broadcastRoster();
    }
    log.info(`${client.name} disconnected (${this.clients.size} clients)`);
  }

  _onMessage(client, data, isBinary) {
    client.lastSeen = Date.now();
    if (isBinary) {
      this.stats.bytesIn += data.byteLength ?? data.length ?? 0;
      this._onBinary(client, data);
      return;
    }
    const text = data.toString?.() ?? String(data);
    this.stats.bytesIn += text.length;
    this.stats.messages++;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this._send(client, MessageType.Error, { message: 'malformed message' });
      return;
    }
    this._onControl(client, message);
  }

  /**
   * Net-id → identity table. Snapshots are pure binary (26 B/actor) and carry no strings, so this is
   * what turns a snapshot actor into a name for nametags, the kill feed and the scoreboard.
   * Sent on join and whenever somebody joins, leaves or switches teams.
   */
  buildRoster() {
    return {
      players: [...this.runner.players].map((player) => ({
        id: player.netId,
        netId: numericId(player.netId),
        name: player.name ?? 'Player',
        team: player.team,
        bot: !!player.isBot,
      })),
    };
  }

  broadcastRoster() {
    return this.broadcast(MessageType.Roster, this.buildRoster());
  }

  _onBinary(client, data) {
    if (!client.joined) return;
    try {
      const frame = decodeInputFrame(data);
      this.runner.queueInput(client.id, frame);
    } catch (error) {
      log.warn(`bad input frame from ${client.name}: ${error.message}`);
    }
  }

  _onControl(client, message) {
    switch (message.t) {
      case MessageType.Hello: {
        client.name = sanitizeName(message.name) ?? client.name;
        client.protocol = message.protocol;
        if (message.protocol !== PROTOCOL_VERSION) {
          this._send(client, MessageType.Error, { message: `protocol mismatch (server ${PROTOCOL_VERSION}, client ${message.protocol})` });
          client.socket.close(1002, 'protocol mismatch');
          return;
        }
        this._send(client, MessageType.Welcome, {
          clientId: client.id,
          alreadyJoined: true,
          tickRate: this.options.tickRate,
          snapshotRate: this.options.snapshotRate,
          match: { mode: this.runner.options.mode, map: this.runner.options.map, phase: this.runner.phase },
        });
        break;
      }
      case MessageType.Join:
        this._join(client, message);
        break;
      case MessageType.Chat: {
        const text = String(message.text ?? '').slice(0, 240);
        if (!text) return;
        this.broadcast(MessageType.Chat, { id: client.id, name: client.name, text, team: message.team ?? null });
        log.info(`chat ${client.name}: ${text}`);
        break;
      }
      case MessageType.Ping: {
        client.ping = Math.round(Date.now() - (message.sentAt ?? Date.now()));
        this._send(client, MessageType.Pong, { sentAt: message.sentAt, ping: client.ping, sent: client.sent, lost: client.lost, tick: this.runner.tick });
        break;
      }
      case MessageType.Command:
        this._onCommand(client, message);
        break;
      case MessageType.Project:
        this._onProject(client, message);
        break;
      default:
        break;
    }
  }

  _join(client, message) {
    if (client.joined) return;
    client.name = sanitizeName(message.name) ?? client.name;
    const record = this.runner.addPlayer({ id: client.id, name: client.name, team: message.team ?? null });
    client.team = record.team;
    client.joined = true;
    // Everything the client needs to render the map without downloading it: seed + archetype.
    this._send(client, MessageType.Join, {
      id: client.id,
      name: client.name,
      team: record.team,
      protocol: PROTOCOL_VERSION,
      match: {
        mode: this.runner.options.mode,
        map: this.runner.options.map,
        seed: this.runner.options.seed,
        phase: this.runner.phase,
        scoreLimit: this.runner.options.scoreLimit,
      },
      spawn: this.runner.pickSpawn(record.team).toArray(),
    });
    this.broadcast(MessageType.Join, { id: client.id, name: client.name, team: record.team, joined: true }, client.socket);
    this.broadcast(MessageType.Scoreboard, this.runner.getScoreboard());
    this._send(client, MessageType.Scoreboard, this.runner.getScoreboard());
    this.broadcastRoster();
    log.info(`${client.name} spawned on ${record.team}`);
  }

  /** In-match client commands: respawn requests, team switches, loadouts, votes. */
  _onCommand(client, message) {
    if (!client.joined) return;
    const runner = this.runner;
    const player = [...runner.players].find((candidate) => candidate.netId === client.id);
    if (!player) return;
    switch (message.kind) {
      case 'respawn':
        if (!player.health.alive) player.respawnTimer = 0.05;
        break;
      case 'team': {
        const team = message.team === 'red' || message.team === 'blue' ? message.team : null;
        if (!team || team === player.team) return;
        const index = runner.teams[player.team].indexOf(player);
        if (index >= 0) runner.teams[player.team].splice(index, 1);
        player.team = team;
        runner.teams[team].push(player);
        player.spawn({ position: runner.pickSpawn(team), yaw: 0 });
        this.broadcast(MessageType.Join, { id: client.id, name: client.name, team, switched: true });
        runner.scoreboardDirty = true;
        break;
      }
      case 'kill':
        if (message.victimId) runner.ballistics.actorByNetId?.(message.victimId)?.applyDamage?.({ amount: 9999, attacker: player, type: 'script' });
        break;
      case 'restart':
        if (client.admin) runner.restart();
        break;
      case 'bots':
        if (client.admin) runner.setBotCount(Number(message.count) || 0);
        break;
      default:
        break;
    }
  }

  /** `POST /project` — the Studio publishes a manifest so the server can report what it hosts. */
  _onProject(client, message) {
    this.project = message.manifest ?? message;
    log.info(`project manifest received from ${client.name}: ${this.project?.name ?? 'untitled'}`);
    this._send(client, MessageType.Project, { accepted: true, name: this.project?.name ?? null, tick: this.runner.tick });
  }

  _sweepClients() {
    const now = Date.now();
    for (const [socket, client] of this.clients) {
      if (!client.joined) continue;
      if (now - client.lastSeen > this.options.clientTimeout) {
        log.warn(`${client.name} timed out`);
        try { socket.close(1000, 'timeout'); } catch { /* already gone */ }
        this.clients.delete(socket);
        this.runner.removePlayer(client.id);
      }
    }
  }

  // ------------------------------------------------------------------ sending
  _send(client, type, payload) {
    if (client.socket.readyState !== 1) return false;
    const text = encodeMessage(type, payload);
    client.socket.send(text);
    this.stats.bytesOut += text.length;
    return true;
  }

  broadcast(type, payload, exclude = null) {
    const text = encodeMessage(type, payload);
    for (const client of this.clients.values()) {
      if (client.socket === exclude || client.socket.readyState !== 1) continue;
      client.socket.send(text);
      this.stats.bytesOut += text.length;
    }
    return this;
  }

  broadcastSnapshot() {
    const buffer = encodeSnapshot(this.runner.buildSnapshot());
    this.stats.snapshots++;
    for (const client of this.clients.values()) {
      if (!client.joined || client.socket.readyState !== 1) continue;
      client.socket.send(buffer, { binary: true });
      client.sent++;
    }
    this.stats.bytesOut += buffer.byteLength * Math.max(1, this.clients.size);
    this.stats.lastSnapshotBytes = buffer.byteLength;
    return buffer;
  }

  /** Maps a runner event onto the wire protocol. */
  _broadcastEvent(event) {
    const { type, payload } = event;
    switch (type) {
      case 'kill':
        this.broadcast(MessageType.Kill, payload);
        break;
      case 'death':
        this.broadcast(MessageType.Death, payload);
        break;
      case 'hit':
        this.broadcast(MessageType.Hit, payload);
        break;
      case 'join':
        this.broadcast(MessageType.Join, payload);
        break;
      case 'leave':
        this.broadcast(MessageType.Leave, payload);
        break;
      case 'phase':
        this.broadcast(MessageType.Phase, { ...payload, scores: this.runner.scores });
        break;
      case 'objective':
        this.broadcast(MessageType.Phase, { phase: this.runner.phase, objective: payload });
        break;
      case 'respawn': {
        const client = [...this.clients.values()].find((candidate) => candidate.id === payload.id);
        if (client) this._send(client, MessageType.Spawn, payload);
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ http
  _handleHttp(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const json = (status, body) => {
      const text = JSON.stringify(body, null, 2);
      response.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      response.end(text);
    };
    if (url.pathname === '/health') {
      json(200, { ok: true, uptime: (Date.now() - this.startedAt) / 1000, ...this.runner.stats });
      return;
    }
    if (url.pathname === '/stats') {
      json(200, { ...this.stats, clients: this.clients.size, match: this.runner.stats, project: this.project?.name ?? null });
      return;
    }
    if (url.pathname === '/project' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; if (body.length > 1e6) request.destroy(); });
      request.on('end', () => {
        try {
          this.project = JSON.parse(body);
          log.info(`project manifest published: ${this.project?.name ?? 'untitled'}`);
          json(200, { accepted: true, name: this.project?.name ?? null });
        } catch (error) {
          json(400, { accepted: false, error: error.message });
        }
      });
      return;
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(statusPage({
        clients: this.clients.size,
        startedAt: this.startedAt,
        match: this.runner.stats,
        stats: this.stats,
        options: this.runner.options,
        project: this.project?.name ?? null,
        clientsList: [...this.clients.values()].map((client) => ({ name: client.name, team: client.team, ping: client.ping })),
      }));
      return;
    }
    json(404, { error: 'not found', routes: ['/', '/health', '/stats', 'POST /project', 'ws://…'] });
  }
}

// --------------------------------------------------------------------------- helpers
function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const cleaned = name.replace(/[^\w .\-[\]()]/g, '').trim().slice(0, 24);
  return cleaned.length ? cleaned : null;
}

function statusPage({ clients, match, stats, options, project, clientsList, startedAt }) {
  const rows = clientsList.map((client) => `<tr><td>${escapeHtml(client.name)}</td><td>${escapeHtml(client.team ?? '—')}</td><td>${client.ping ?? 0} ms</td></tr>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>OminX Dedicated Server</title>
<style>
 body{background:#070a0f;color:#dbe4ee;font-family:system-ui,sans-serif;margin:0;padding:32px}
 h1{font-size:20px;letter-spacing:2px;margin:0 0 4px} h1 span{color:#ffb347}
 .sub{color:#61708a;font-size:12px;margin-bottom:24px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;max-width:900px}
 .card{background:#0d1219;border:1px solid #232f3d;border-radius:10px;padding:14px}
 .card b{display:block;font-size:22px;font-family:ui-monospace,monospace}
 .card span{color:#61708a;font-size:11px;text-transform:uppercase;letter-spacing:1px}
 table{border-collapse:collapse;margin-top:20px;font-size:13px;min-width:320px}
 th,td{text-align:left;padding:5px 10px;border-bottom:1px solid #1a2330}
 th{color:#61708a;font-size:10px;text-transform:uppercase}
 code{font-family:ui-monospace,monospace;color:#57b6ff}
</style></head><body>
<h1>OminX <span>Dedicated</span></h1>
<div class="sub">${escapeHtml(options.mode)} on ${escapeHtml(String(options.map))} · seed ${options.seed} · tick ${options.tickRate} Hz · ${stats.ticks} ticks served${project ? ` · hosting “${escapeHtml(project)}”` : ''}</div>
<div class="grid">
  <div class="card"><span>Clients</span><b>${clients}</b></div>
  <div class="card"><span>Players</span><b>${match.players}</b></div>
  <div class="card"><span>Bots</span><b>${match.bots}</b></div>
  <div class="card"><span>Phase</span><b>${match.phase}</b></div>
  <div class="card"><span>Score</span><b>${match.score.red}:${match.score.blue}</b></div>
  <div class="card"><span>Snapshots</span><b>${stats.snapshots}</b></div>
  <div class="card"><span>Up</span><b>${Math.round((Date.now() - startedAt) / 1000)}s</b></div>
</div>
${rows ? `<table><tr><th>Player</th><th>Team</th><th>Ping</th></tr>${rows}</table>` : ''}
<p class="sub" style="margin-top:24px">Connect the Studio: <code>npm run dev</code> → Network panel → <code>ws://localhost:${options.port}</code></p>
</body></html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export { MatchPhase, MatchMode, statusPage };
export default MatchServer;
