/**
 * OminX Engine — actor/property replication core.
 *
 * The wire format (`src/net/Protocol.js`) decides *how many bytes* a snapshot costs. This module
 * decides **what state exists to be sent**: which objects are networked, which role each side has,
 * which properties changed this tick, which RPCs are reliable, and what happens when a packet
 * arrives late, twice, or out of order. It is deliberately transport-agnostic — a host feeds the
 * deltas into WebSocket, WebRTC, a replay or a bot's simulated connection.
 *
 * UE-shaped rules:
 *   - **Roles.** `Authority`, `AutonomousProxy` (locally controlled), `SimulatedProxy`, `None`.
 *     Only authority writes authoritative state; a proxy that receives a delta while believing it
 *     is authority is a conflict, reported rather than silently accepted.
 *   - **Deltas, not whole state.** `setProperty()` marks one field dirty; `collectDeltas()` emits a
 *     per-object change set and clears the dirty flags. A clean object costs nothing.
 *   - **Reliable ordered channels.** Reliable records are held until the sequence gap closes, so
 *     `spawn → damage → death` never becomes `damage → death → spawn`; duplicates are discarded.
 *   - **RPCs.** Named, targetable (`Server`/`Client`/`Owner`/`All`), queued and dispatched with
 *     isolated handlers, so a bad callback cannot stall the network phase.
 *
 * ```
 * const net = engine.createReplicationSystem({ mode: NetMode.Server, localRole: NetRole.Authority });
 * net.register(7, { classId: 'Player', role: NetRole.Authority, properties: { health: 100 } });
 * net.setProperty(7, 'health', 82);
 * const deltas = net.collectDeltas();        // → [{ netId: 7, properties: { health: 82 }, … }]
 * client.applyDeltas(deltas);                // ordered, stale-delta safe
 * ```
 *
 * @module engine/src/core/Replication
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Replication');

export const NetRole = Object.freeze({
  None: 'none', SimulatedProxy: 'simulated', AutonomousProxy: 'autonomous', Authority: 'authority',
});

export const NetMode = Object.freeze({
  Standalone: 'standalone', Client: 'client', Server: 'server', ListenServer: 'listen',
});

export const RpcTarget = Object.freeze({
  Server: 'server', Client: 'client', Owner: 'owner', All: 'all',
});

export const replicationEvents = {
  onRegistered: new MulticastDelegate('net.onRegistered'),
  onUnregistered: new MulticastDelegate('net.onUnregistered'),
  onPropertyChanged: new MulticastDelegate('net.onPropertyChanged'),
  onDelta: new MulticastDelegate('net.onDelta'),
  onApplied: new MulticastDelegate('net.onApplied'),
  onConflict: new MulticastDelegate('net.onConflict'),
  onStale: new MulticastDelegate('net.onStale'),
  onRpcQueued: new MulticastDelegate('net.onRpcQueued'),
  onRpcReceived: new MulticastDelegate('net.onRpcReceived'),
  onError: new MulticastDelegate('net.onError'),
};

/**
 * One ordered channel. Reliable records are buffered until their sequence gap closes; unreliable
 * records are delivered immediately and never retried. Capacity is bounded (oldest dropped).
 */
export class NetChannel {
  constructor({ name = 'default', reliable = true, capacity = 256 } = {}) {
    this.name = name;
    this.reliable = !!reliable;
    this.capacity = Math.max(1, Math.floor(capacity));
    this.sequence = 0;
    this.lastApplied = 0;
    this.pending = [];
    this.outOfOrder = new Map();
    this.sent = 0;
    this.delivered = 0;
    this.acknowledged = 0;
    this.duplicates = 0;
    this.dropped = 0;
    this.lastError = null;
  }

  static create(options) { return new NetChannel(options); }

  /** Enqueues one record. Returns the record, or `null` when the channel is full. */
  send(payload, { reliable = this.reliable } = {}) {
    const record = {
      sequence: ++this.sequence, payload, reliable: !!reliable,
      channel: this.name, tick: null,
    };
    if (record.reliable) {
      if (this.pending.length >= this.capacity) {
        const dropped = this.pending.shift();
        this.dropped++;
        this.lastError = new Error(`channel \"${this.name}\" dropped reliable record #${dropped.sequence}`);
        log.warn(this.lastError.message);
        replicationEvents.onError.broadcast(this.lastError, this);
      }
      this.pending.push(record);
    }
    this.sent++;
    return record;
  }

  /** Delivers records in order. Returns the records that became deliverable now. */
  receive(record) {
    if (!record || record.channel !== this.name) return [];
    if (!record.reliable) { this.delivered++; return [record]; }
    if (record.sequence <= this.lastApplied) { this.duplicates++; return []; }
    this.outOfOrder.set(record.sequence, record);
    const ready = [];
    while (this.outOfOrder.has(this.lastApplied + 1)) {
      const next = this.outOfOrder.get(this.lastApplied + 1);
      this.outOfOrder.delete(this.lastApplied + 1);
      this.lastApplied++;
      this.delivered++;
      ready.push(next);
    }
    return ready;
  }

  /** Acknowledges reliable records up to `sequence`, removing them from the resend window. */
  ack(sequence) {
    const before = this.pending.length;
    this.pending = this.pending.filter((record) => record.sequence > sequence);
    this.acknowledged += before - this.pending.length;
    return before - this.pending.length;
  }

  /** Everything still awaiting an ack (a resend pass after a timeout). */
  unacknowledged() { return [...this.pending]; }
  get gapCount() { return this.outOfOrder.size; }

  describe() {
    return {
      name: this.name, reliable: this.reliable, capacity: this.capacity,
      sequence: this.sequence, lastApplied: this.lastApplied,
      pending: this.pending.length, gaps: this.outOfOrder.size,
      sent: this.sent, delivered: this.delivered, acknowledged: this.acknowledged,
      duplicates: this.duplicates, dropped: this.dropped,
      lastError: this.lastError?.message ?? null,
    };
  }

  format() {
    return `  ${this.name.padEnd(14)} ${this.reliable ? 'reliable  ' : 'unreliable'} seq ${this.sequence} · applied ${this.lastApplied} · pending ${this.pending.length} · gaps ${this.outOfOrder.size} · dup ${this.duplicates} · drop ${this.dropped}`;
  }
}

/** One networked object: its role, properties and the set that changed since the last flush. */
export class ReplicatedObject {
  constructor({ netId, classId = null, role = NetRole.SimulatedProxy, owner = null, properties = null, system = null }) {
    this.netId = netId;
    this.classId = classId;
    this.role = role;
    this.owner = owner;
    this.properties = new Map(Object.entries(properties ?? {}));
    this.dirty = new Set();
    this.sequence = 0;
    this.lastUpdateTick = 0;
    this.relevant = true;
    this.system = system;
    this.changesSent = 0;
    this.changesApplied = 0;
  }

  get isAuthority() { return this.role === NetRole.Authority; }
  get dirtyCount() { return this.dirty.size; }

  get(name) { return this.properties.get(name); }

  /** Marks a property dirty only when the value actually changed (or `force` is set). */
  set(name, value, { force = false } = {}) {
    const previous = this.properties.get(name);
    if (!force && Object.is(previous, value)) return false;
    this.properties.set(name, value);
    this.dirty.add(name);
    if (this.system) this.lastUpdateTick = this.system.tickCount;
    replicationEvents.onPropertyChanged.broadcast(this, name, value, previous);
    return true;
  }

  markDirty(name) {
    if (!this.properties.has(name)) return false;
    this.dirty.add(name);
    return true;
  }

  snapshot() { return Object.fromEntries(this.properties); }

  /** Produces a delta and clears the dirty set. Returns `null` for a clean object. */
  flush({ tick = null } = {}) {
    if (!this.dirty.size) return null;
    const properties = {};
    for (const name of this.dirty) properties[name] = this.properties.get(name);
    this.dirty.clear();
    const delta = {
      netId: this.netId, classId: this.classId, sequence: ++this.sequence,
      tick: tick ?? (this.system?.tickCount ?? 0), properties,
    };
    this.lastUpdateTick = delta.tick;
    this.changesSent += Object.keys(properties).length;
    return delta;
  }

  /** Applies a delta unless it is stale or conflicts with local authority. */
  apply(delta, { authority = false } = {}) {
    if (!delta || delta.netId !== this.netId) return { applied: 0, reason: 'mismatch' };
    if (typeof delta.sequence === 'number' && delta.sequence <= this.sequence) {
      replicationEvents.onStale.broadcast(this, delta, this.system);
      return { applied: 0, reason: 'stale' };
    }
    if (this.isAuthority && !authority) {
      replicationEvents.onConflict.broadcast(this, delta, this.system);
      log.warn(`replication conflict on \"${this.netId}\": local authority refused a remote delta`);
      return { applied: 0, reason: 'conflict' };
    }
    let applied = 0;
    for (const [name, value] of Object.entries(delta.properties ?? {})) {
      this.properties.set(name, value);
      this.dirty.delete(name);
      applied++;
    }
    this.sequence = Math.max(this.sequence, delta.sequence ?? 0);
    this.lastUpdateTick = delta.tick ?? this.lastUpdateTick;
    this.changesApplied += applied;
    return { applied, reason: 'ok' };
  }

  describe() {
    return {
      netId: this.netId, classId: this.classId, role: this.role, owner: this.owner,
      properties: Object.keys(this.snapshot()), dirty: [...this.dirty],
      sequence: this.sequence, lastUpdateTick: this.lastUpdateTick, relevant: this.relevant,
      changesSent: this.changesSent, changesApplied: this.changesApplied,
    };
  }
}

/** The replication graph: objects, channels, RPCs, deltas and snapshots. */
export class ReplicationSystem {
  constructor({ name = 'Replication', mode = NetMode.Standalone, localRole = NetRole.None, stats = null, channels = null, maxRpcs = 512 } = {}) {
    this.name = name;
    this.mode = mode;
    this.localRole = localRole;
    this.stats = stats;
    this.objects = new Map();
    this.channels = new Map();
    this.rpcQueue = [];
    this.rpcHandlers = new Map();
    this.maxRpcs = Math.max(1, Math.floor(maxRpcs));
    this.tickCount = 0;
    this.deltasSent = 0;
    this.deltasApplied = 0;
    this.staleCount = 0;
    this.conflictCount = 0;
    this.unhandledRpcs = 0;
    this.rpcsReceived = 0;
    this.rpcsSent = 0;
    this.errors = [];
    this.relevancyFilter = null;
    this._rpcSeq = 0;
    for (const entry of channels ?? []) this.registerChannel(entry);
    this.registerChannel({ name: 'state', reliable: true });
    this.registerChannel({ name: 'rpc', reliable: true });
    this.registerChannel({ name: 'effects', reliable: false });
  }

  static create(options) { return new ReplicationSystem(options); }

  get count() { return this.objects.size; }
  ids() { return [...this.objects.keys()]; }

  registerChannel(options) {
    const channel = options instanceof NetChannel ? options : new NetChannel(options);
    this.channels.set(channel.name, channel);
    return channel;
  }

  channel(name = 'state') { return this.channels.get(name) ?? this.registerChannel({ name }); }

  /** Registers (or replaces) a networked object. */
  register(netId, options = {}) {
    const object = options instanceof ReplicatedObject ? options : new ReplicatedObject({ netId, ...options, system: this });
    object.system = this;
    this.objects.set(netId, object);
    replicationEvents.onRegistered.broadcast(object, this);
    this.stats?.gauge('Net/Objects', this.objects.size);
    return object;
  }

  unregister(netId) {
    const removed = this.objects.delete(netId);
    if (removed) replicationEvents.onUnregistered.broadcast(netId, this);
    return removed;
  }

  get(netId) { return this.objects.get(netId) ?? null; }
  has(netId) { return this.objects.has(netId); }
  setRole(netId, role) {
    const object = this.get(netId);
    if (object) object.role = role;
    return !!object;
  }

  setProperty(netId, name, value, options = {}) {
    const object = this.get(netId);
    return object ? object.set(name, value, options) : false;
  }

  markDirty(netId, name) {
    const object = this.get(netId);
    return object ? object.markDirty(name) : false;
  }

  /** `setRelevancyFilter((object, viewer) => distance(viewer, object) < 80_000)`. */
  setRelevancyFilter(fn) { this.relevancyFilter = typeof fn === 'function' ? fn : null; return this; }

  /** Increments the simulation tick (the engine calls this on its fixed step). */
  tick() { this.tickCount++; return this.tickCount; }

  /**
   * Emits deltas for every dirty, relevant object and sends them on the `state` channel.
   * `viewer` is passed to the relevancy filter for per-connection dormancy.
   */
  collectDeltas({ viewer = null, maxObjects = Infinity, channelName = 'state' } = {}) {
    const deltas = [];
    const channel = this.channel(channelName);
    for (const object of this.objects.values()) {
      if (deltas.length >= maxObjects) break;
      if (!object.dirty.size || !object.relevant) continue;
      if (this.relevancyFilter && !this.relevancyFilter(object, viewer)) continue;
      const delta = object.flush({ tick: this.tickCount });
      if (!delta) continue;
      delta.channel = channelName;
      channel.send(delta, { reliable: true });
      deltas.push(delta);
    }
    this.deltasSent += deltas.length;
    if (deltas.length) {
      this.stats?.count('Net/Deltas', deltas.length);
      replicationEvents.onDelta.broadcast(deltas, this);
    }
    return deltas;
  }

  /** Applies incoming deltas; creates unknown objects as simulated proxies by default. */
  applyDeltas(deltas, { authority = false, createMissing = true } = {}) {
    const report = { applied: 0, created: 0, stale: 0, conflicts: 0, objects: 0 };
    for (const delta of deltas ?? []) {
      let object = this.get(delta.netId);
      if (!object) {
        if (!createMissing) continue;
        object = this.register(delta.netId, {
          classId: delta.classId ?? null,
          role: authority ? NetRole.Authority : NetRole.SimulatedProxy,
          properties: {},
        });
        report.created++;
      }
      const result = object.apply(delta, { authority });
      if (result.reason === 'stale') { this.staleCount++; report.stale++; continue; }
      if (result.reason === 'conflict') { this.conflictCount++; report.conflicts++; continue; }
      report.applied += result.applied;
      report.objects++;
      replicationEvents.onApplied.broadcast(object, delta, result.applied);
    }
    this.deltasApplied += report.objects;
    return report;
  }

  /** Queues a named RPC on a channel. `target` decides who should execute it. */
  queueRpc(netId, name, args = null, { reliable = true, target = RpcTarget.Server, channelName = 'rpc' } = {}) {
    if (this.rpcQueue.length >= this.maxRpcs) {
      this.rpcQueue.shift();
      this.errors.push('rpc queue full — dropped oldest');
      if (this.errors.length > 32) this.errors.shift();
    }
    const record = {
      id: ++this._rpcSeq, netId, name, args, reliable: !!reliable,
      target, channel: channelName, tick: this.tickCount,
    };
    this.rpcQueue.push(record);
    this.channel(channelName).send(record, { reliable });
    this.rpcsSent++;
    replicationEvents.onRpcQueued.broadcast(record, this);
    return record;
  }

  /** Takes the queued RPCs (a transport layer sends these after the frame's simulation). */
  drainRpcs({ max = Infinity } = {}) {
    const out = this.rpcQueue.splice(0, Math.max(0, max));
    return out;
  }

  /** Registers a handler for one object, one RPC name on any object, or a wildcard catch-all. */
  onRpc(netId, name, fn) {
    if (typeof fn !== 'function') throw new TypeError('onRpc() needs a handler function');
    const key = `${netId ?? '*'}:${name ?? '*'}`;
    if (!this.rpcHandlers.has(key)) this.rpcHandlers.set(key, []);
    this.rpcHandlers.get(key).push(fn);
    return { unbind: () => this.offRpc(netId, name, fn) };
  }

  offRpc(netId, name, fn) {
    const key = `${netId ?? '*'}:${name ?? '*'}`;
    const list = this.rpcHandlers.get(key);
    if (!list) return false;
    const index = list.indexOf(fn);
    if (index < 0) return false;
    list.splice(index, 1);
    if (!list.length) this.rpcHandlers.delete(key);
    return true;
  }

  /** Dispatches an incoming RPC. Handler errors are isolated and recorded. */
  receiveRpc(record, { authority = false } = {}) {
    if (!record) return { ok: false, handled: 0 };
    this.rpcsReceived++;
    const keys = [`${record.netId}:${record.name}`, `*:${record.name}`, `*:*`, `${record.netId}:*`];
    const handlers = [];
    const seen = new Set();
    for (const key of keys) for (const fn of this.rpcHandlers.get(key) ?? []) {
      if (!seen.has(fn)) { seen.add(fn); handlers.push(fn); }
    }
    if (!handlers.length) {
      this.unhandledRpcs++;
      replicationEvents.onRpcReceived.broadcast(record, 0, this);
      return { ok: true, handled: 0 };
    }
    let handled = 0;
    for (const fn of handlers) {
      try { fn(record.args, record, { authority, system: this }); handled++; }
      catch (error) {
        this.errors.push(`rpc \"${record.name}\" threw: ${error?.message ?? error}`);
        if (this.errors.length > 32) this.errors.shift();
        log.error(`rpc \"${record.name}\" threw: ${error?.message ?? error}`);
        replicationEvents.onError.broadcast(error, this);
      }
    }
    replicationEvents.onRpcReceived.broadcast(record, handled, this);
    return { ok: true, handled };
  }

  /** Full state snapshot (late join, replay start, save/restore). */
  snapshot() {
    return {
      format: 'ominx-replication', version: 1, mode: this.mode, tick: this.tickCount,
      objects: [...this.objects.values()].map((object) => ({
        netId: object.netId, classId: object.classId, role: object.role, owner: object.owner,
        sequence: object.sequence, properties: object.snapshot(),
      })),
    };
  }

  loadSnapshot(data, { replace = true } = {}) {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (parsed?.format !== 'ominx-replication' || !Array.isArray(parsed.objects)) throw new Error('not an OminX replication snapshot');
    if (replace) this.objects.clear();
    this.mode = parsed.mode ?? this.mode;
    this.tickCount = parsed.tick ?? this.tickCount;
    for (const entry of parsed.objects) {
      const object = this.register(entry.netId, {
        classId: entry.classId, role: entry.role, owner: entry.owner, properties: entry.properties,
      });
      object.sequence = entry.sequence ?? 0;
    }
    return this.objects.size;
  }

  describe() {
    return {
      name: this.name, mode: this.mode, localRole: this.localRole, tick: this.tickCount,
      objects: this.objects.size, channels: [...this.channels.values()].map((channel) => channel.describe()),
      queuedRpcs: this.rpcQueue.length, rpcHandlers: [...this.rpcHandlers.keys()],
      deltasSent: this.deltasSent, deltasApplied: this.deltasApplied,
      stale: this.staleCount, conflicts: this.conflictCount,
      rpcsSent: this.rpcsSent, rpcsReceived: this.rpcsReceived, unhandledRpcs: this.unhandledRpcs,
      errors: this.errors.length,
      objectsView: [...this.objects.values()].slice(0, 8).map((object) => object.describe()),
    };
  }

  format() {
    const lines = [
      `  ${this.name} — ${this.mode} · local role ${this.localRole} · tick ${this.tickCount}`,
      `  objects ${this.objects.size} · deltas ${this.deltasSent} out / ${this.deltasApplied} in · stale ${this.staleCount} · conflicts ${this.conflictCount}`,
      `  rpcs ${this.rpcsSent} out / ${this.rpcsReceived} in · ${this.rpcQueue.length} queued · ${this.unhandledRpcs} unhandled · errors ${this.errors.length}`,
    ];
    for (const channel of this.channels.values()) lines.push(channel.format());
    for (const object of [...this.objects.values()].slice(0, 6)) {
      lines.push(`  #${String(object.netId).padEnd(6)} ${String(object.classId ?? 'Object').padEnd(14)} ${object.role.padEnd(11)} ${object.dirty.size} dirty · seq ${object.sequence}`);
    }
    if (!this.objects.size) lines.push('  (no networked objects)');
    return lines.join('\n');
  }

  installConsoleCommands(console_) {
    const net = this;
    console_.registerCommand({
      name: 'net', aliases: ['net.list'], category: 'Replication', description: 'Replication state.',
      execute: () => net.format(),
    });
    console_.registerCommand({
      name: 'net.actors', category: 'Replication', description: 'Networked objects as JSON.',
      execute: () => JSON.stringify([...net.objects.values()].map((object) => object.describe()), null, 2),
    });
    console_.registerCommand({
      name: 'net.set', category: 'Replication', description: 'Sets a replicated property.',
      args: [{ name: 'netId', type: 'int' }, { name: 'field' }, { name: 'value' }],
      execute: (args) => {
        const value = args.value === 'true' ? true : (args.value === 'false' ? false : (Number.isFinite(Number(args.value)) && args.value !== '' ? Number(args.value) : args.value));
        return net.setProperty(args.netId, args.field, value) ? `set #${args.netId}.${args.field} = ${value}` : `no object #${args.netId}`;
      },
    });
    console_.registerCommand({
      name: 'net.flush', category: 'Replication', description: 'Collects dirty deltas.',
      execute: () => {
        const deltas = net.collectDeltas();
        return deltas.length ? JSON.stringify(deltas, null, 2) : 'no dirty properties';
      },
    });
    console_.registerCommand({
      name: 'net.channels', category: 'Replication', description: 'Channel state.',
      execute: () => [...net.channels.values()].map((channel) => channel.format()).join('\n'),
    });
    console_.registerCommand({
      name: 'net.tick', category: 'Replication', description: 'Advances the replication tick.',
      args: [{ name: 'count', type: 'int', min: 1, max: 1000, required: false, default: 1 }],
      execute: (args) => { for (let i = 0; i < args.count; i++) net.tick(); return `net tick ${net.tickCount}`; },
    });
    return console_;
  }
}

export default ReplicationSystem;
