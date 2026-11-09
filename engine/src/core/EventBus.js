/**
 * OminX Engine — deterministic event queue and message bus.
 *
 * A frame is a bad place to discover that a callback order depends on which system happened to be
 * constructed first. Systems therefore do not call each other for notifications; they *publish*
 * onto a queue, and the engine drains that queue once per frame in a defined phase. That gives
 * four things an FPS needs from its plumbing:
 *
 *   - **Order** — higher priority first, ties break by insertion id, so a damage event always beats
 *     the HUD update that reads it.
 *   - **Determinism** — events raised while draining are delivered on the next pass, never in the
 *     middle of the batch that produced them. A headless soak run and a browser run see the same
 *     sequence; replays stay reproducible.
 *   - **Isolation** — one throwing handler is recorded and the rest of the batch still runs.
 *   - **Bounded** — capacity, per-channel gating, drain-cycle TTLs and drop policies. Nothing
 *     grows without limit when a consumer is paused.
 *
 * `EventQueue` is the primitive (typed events + handlers). `MessageBus` sits on it with topics,
 * wildcard subscriptions, request/reply with drain-based timeouts, and responders (RPC shape).
 * Both are standalone; the engine owns one bus and pumps it at the end of each frame.
 *
 * ```
 * bus.subscribe('player.*', (body) => hud.onEvent(body));
 * bus.publish('player.damaged', { amount: 12 });          // queued, delivered on the next frame
 * const reply = await bus.request('inventory.query', { slot: 2 }).promise;
 * bus.respond('inventory.query', (body) => ({ item: 'rifle', slot: body.slot }));
 * ```
 *
 * @module engine/src/core/EventBus
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Bus');

/** Observable bus operations. Delegates isolate listener errors, so telemetry cannot break delivery. */
export const busEvents = {
  onEnqueued: new MulticastDelegate('bus.onEnqueued'),
  onDelivered: new MulticastDelegate('bus.onDelivered'),
  onDropped: new MulticastDelegate('bus.onDropped'),
  onExpired: new MulticastDelegate('bus.onExpired'),
  onError: new MulticastDelegate('bus.onError'),
  onReply: new MulticastDelegate('bus.onReply'),
  onDrained: new MulticastDelegate('bus.onDrained'),
};

/** Named priorities; any integer works, larger runs first. */
export const EventPriority = Object.freeze({
  Lowest: -100, Low: -10, Normal: 0, High: 10, Highest: 100,
});

/** One queued event. `tick` is a drain counter, not wall time — TTLs are simulation-deterministic. */
export class EventRecord {
  constructor({ id, type, payload = null, priority = 0, channel = 'default', ttl = 0, tick = 0, headers = null }) {
    this.id = id;
    this.type = type;
    this.payload = payload;
    this.priority = priority;
    this.channel = channel;
    this.ttl = ttl;
    this.tick = tick;
    this.headers = headers ?? {};
  }

  describe() {
    return {
      id: this.id, type: this.type, priority: this.priority, channel: this.channel,
      ttl: this.ttl, tick: this.tick, headers: { ...this.headers },
    };
  }
}

/** Handle returned by `on()`/`subscribe()`/`respond()`. */
export class EventSubscription {
  constructor(owner, id, type) {
    this.owner = owner;
    this.id = id;
    this.type = type;
    this._valid = true;
    this.calls = 0;
  }

  get isValid() { return this._valid; }
  /** Boolean like `DelegateHandle.unbind()`; `owner.off()` returns a count, which is different. */
  unbind() { return this._valid ? !!this.owner.off(this) : false; }
  clear() { return this.unbind(); }
  unsubscribe() { return this.unbind(); }
  disconnect() { return this.unbind(); }
}

/**
 * A bounded, prioritized, deferred event queue. `drain()` is called by the host (the engine does
 * it once per frame); nothing is delivered implicitly.
 */
export class EventQueue {
  constructor({
    name = 'Events', capacity = 4096, stats = null, defaultTtl = 0,
    dropPolicy = 'lowest', channels = null,
  } = {}) {
    this.name = name;
    this.capacity = Math.max(1, Math.floor(capacity));
    this.stats = stats;
    this.defaultTtl = Math.max(0, Math.floor(defaultTtl));
    this.dropPolicy = dropPolicy === 'newest' ? 'newest' : 'lowest';
    this.queue = [];
    this.handlers = new Map();
    this.channels = new Map();
    for (const [key, enabled] of Object.entries(channels ?? {})) this.registerChannel(key, enabled);
    this.registerChannel('default', true);
    this.tick = 0;
    this.paused = false;
    this.draining = false;
    this._seq = 0;
    this._handlerSeq = 0;
    this.enqueued = 0;
    this.delivered = 0;
    this.handled = 0;
    this.unhandled = 0;
    this.deferred = 0;
    this.dropped = 0;
    this.expired = 0;
    this.errors = [];
    this.lastDrain = null;
  }

  static create(options) { return new EventQueue(options); }

  get count() { return this.queue.length; }
  get handlerCount() { return [...this.handlers.values()].reduce((sum, list) => sum + list.length, 0); }
  get activeChannelNames() { return [...this.channels.entries()].filter(([, channel]) => channel.enabled).map(([name]) => name); }

  // ------------------------------------------------------------------ channels
  registerChannel(name, enabled = true) {
    if (!this.channels.has(name)) this.channels.set(name, { name, enabled: !!enabled, delivered: 0, held: 0 });
    return this.channels.get(name);
  }

  channel(name) { return this.registerChannel(name); }

  enableChannel(name, enabled = true) {
    const channel = this.registerChannel(name);
    channel.enabled = !!enabled;
    return this;
  }

  // ------------------------------------------------------------------ handlers
  /**
   * Registers a handler. `type` may be a string, an array of strings, `'*'` (all events) or a
   * prefix wildcard such as `'player.*'`. Owner-bound handlers are weakly held by default — pass
   * `{ weak: false }` to keep a subsystem alive through its subscription.
   */
  on(type, fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('EventQueue.on() needs a handler function');
    const types = Array.isArray(type) ? type : [type];
    const {
      priority = EventPriority.Normal, once = false, filter = null, channel = null,
      owner = null, weak = true,
    } = options;
    const id = ++this._handlerSeq;
    const entry = {
      id, type: types[0], fn, priority, once, filter, channel, owner,
      ownerRef: owner && weak && typeof WeakRef !== 'undefined' ? new WeakRef(owner) : null,
      calls: 0, enabled: true,
    };
    const handle = new EventSubscription(this, id, types[0]);
    entry.handle = handle;
    for (const name of types) {
      if (!this.handlers.has(name)) this.handlers.set(name, []);
      this.handlers.get(name).push(entry);
    }
    return handle;
  }

  /** Removes by handle, by callback reference, or by type (all handlers of that type). */
  off(target) {
    if (target instanceof EventSubscription) {
      target._valid = false;
      let removed = 0;
      for (const [type, list] of this.handlers) {
        const next = list.filter((entry) => entry.id !== target.id);
        removed += list.length - next.length;
        if (next.length) this.handlers.set(type, next);
        else this.handlers.delete(type);
      }
      this._pruneRemovedHandles();
      return removed > 0;
    }
    let removed = 0;
    for (const [type, list] of this.handlers) {
      const next = list.filter((entry) => {
        const match = typeof target === 'string' ? entry.type === target : entry.fn === target;
        if (match) { if (entry.handle) entry.handle._valid = false; removed++; return false; }
        return true;
      });
      if (next.length) this.handlers.set(type, next);
      else this.handlers.delete(type);
    }
    this._pruneRemovedHandles();
    return removed;
  }

  _pruneRemovedHandles() { /* handles are lightweight; the maps above are the source of truth */ }

  /** All handlers that should see `record`, in priority then registration order. */
  _handlersFor(record) {
    const matches = [];
    const seen = new Set();
    for (const [pattern, list] of this.handlers) {
      if (!topicMatches(pattern, record.type)) continue;
      for (const entry of list) {
        if (!entry.enabled || seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (entry.channel && entry.channel !== record.channel) continue;
        if (entry.ownerRef && !entry.ownerRef.deref()) { entry.enabled = false; continue; }
        matches.push(entry);
      }
    }
    return matches.sort((a, b) => b.priority - a.priority || a.id - b.id);
  }

  // ------------------------------------------------------------------ enqueue
  /**
   * Queues an event. Returns the `EventRecord`, or `null` when the queue is full and the drop
   * policy refuses the newest event. `ttl` is measured in drain cycles (0 = never expires).
   */
  enqueue(type, payload = null, { priority = EventPriority.Normal, channel = 'default', ttl = null, headers = null } = {}) {
    const record = new EventRecord({
      id: ++this._seq, type, payload, priority, channel,
      ttl: ttl === null ? this.defaultTtl : Math.max(0, Math.floor(ttl)),
      tick: this.tick, headers,
    });
    if (this.queue.length >= this.capacity) {
      if (this.dropPolicy === 'newest') {
        this.dropped++;
        busEvents.onDropped.broadcast(record, 'capacity', this);
        log.warn(`event queue \"${this.name}\" full — dropped \"${type}\"`);
        return null;
      }
      let victim = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i].priority < this.queue[victim].priority) victim = i;
      }
      const [dropped] = this.queue.splice(victim, 1);
      this.dropped++;
      busEvents.onDropped.broadcast(dropped, 'capacity', this);
    }
    this.queue.push(record);
    this.enqueued++;
    this.stats?.count('Bus/Enqueued');
    busEvents.onEnqueued.broadcast(record, this);
    return record;
  }

  /** Drops queued events, optionally filtered by type or channel. */
  clear({ type = null, channel = null } = {}) {
    const before = this.queue.length;
    this.queue = this.queue.filter((record) => (type && record.type !== type) || (channel && record.channel !== channel));
    const removed = before - this.queue.length;
    this.dropped += removed;
    return removed;
  }

  // ------------------------------------------------------------------ drain
  /**
   * Delivers a batch. Each pass swaps the queue out first, so events enqueued *by* a handler land
   * in the fresh queue and are delivered on the next pass — never inside the batch that raised
   * them. `maxPasses > 1` chains those passes in one call (`flush()` does this).
   */
  drain({ maxEvents = Infinity, maxPasses = 1, tick = null } = {}) {
    if (this.draining) return { delivered: 0, handled: 0, unhandled: 0, expired: 0, held: 0, deferred: this.queue.length, errors: 0, passes: 0, remaining: this.queue.length, reentrant: true };
    this.draining = true;
    this.tick = tick === null ? this.tick + 1 : Number(tick);
    const report = {
      delivered: 0, handled: 0, unhandled: 0, expired: 0, held: 0, deferred: 0,
      errors: 0, passes: 0, remaining: 0, reentrant: false,
    };
    try {
      for (let pass = 0; pass < Math.max(1, Math.floor(maxPasses)); pass++) {
        const batch = this.queue;
        this.queue = [];
        if (!batch.length) break;
        report.passes++;
        batch.sort((a, b) => b.priority - a.priority || a.id - b.id);
        for (const record of batch) {
          if (report.delivered >= maxEvents) { this.queue.push(record); continue; }
          if (record.ttl > 0 && this.tick - record.tick > record.ttl) {
            report.expired++;
            this.expired++;
            busEvents.onExpired.broadcast(record, this);
            continue;
          }
          const channel = this.registerChannel(record.channel);
          if (this.paused || !channel.enabled) {
            report.held++;
            channel.held++;
            this.queue.push(record);
            continue;
          }
          const result = this._dispatch(record);
          report.delivered++;
          report.handled += result.handled;
          report.unhandled += result.unhandled ? 1 : 0;
          report.errors += result.errors;
          channel.delivered++;
        }
        if (!this.queue.length || report.delivered >= maxEvents) break;
      }
    } finally {
      this.draining = false;
    }
    report.deferred = this.queue.length;
    report.remaining = this.queue.length;
    this.deferred += report.deferred;
    this.lastDrain = { ...report, tick: this.tick };
    this.stats?.count('Bus/Delivered', report.delivered);
    this.stats?.gauge('Bus/Queued', this.queue.length);
    busEvents.onDrained.broadcast(report, this);
    return report;
  }

  /** Drains until the queue is empty or `maxPasses` is reached (shutdown, tests, level load). */
  flush(options = {}) { return this.drain({ maxPasses: 16, ...options }); }

  _dispatch(record) {
    const handlers = this._handlersFor(record);
    let handled = 0;
    let errors = 0;
    const expired = [];
    for (const entry of handlers) {
      try {
        if (entry.filter && !entry.filter(record.payload, record)) continue;
        entry.fn(record.payload, record, this);
        entry.calls++;
        if (entry.handle) entry.handle.calls++;
        handled++;
        this.handled++;
        if (entry.once) expired.push(entry.id);
      } catch (error) {
        errors++;
        this.errors.push({ type: record.type, handler: entry.id, message: error?.message ?? String(error) });
        if (this.errors.length > 64) this.errors.shift();
        log.error(`handler for \"${record.type}\" threw: ${error?.message ?? error}`);
        busEvents.onError.broadcast(record, error, this);
      }
    }
    if (expired.length) for (const id of expired) this.offById(id);
    this.delivered++;
    this.unhandled += handlers.length ? 0 : 1;
    busEvents.onDelivered.broadcast(record, { handled, errors }, this);
    return { handled, errors, unhandled: handlers.length === 0 };
  }

  offById(id) {
    let removed = 0;
    for (const [type, list] of this.handlers) {
      const next = list.filter((entry) => {
        if (entry.id !== id) return true;
        removed++;
        if (entry.handle) entry.handle._valid = false;
        return false;
      });
      if (next.length) this.handlers.set(type, next);
      else this.handlers.delete(type);
    }
    return removed;
  }

  // ------------------------------------------------------------------ reporting
  describe() {
    return {
      name: this.name, queued: this.queue.length, capacity: this.capacity, tick: this.tick,
      paused: this.paused, dropPolicy: this.dropPolicy, defaultTtl: this.defaultTtl,
      channels: [...this.channels.values()].map((channel) => ({ ...channel })),
      handlers: this.handlerCount,
      handlerTypes: [...this.handlers.keys()],
      enqueued: this.enqueued, delivered: this.delivered, handled: this.handled,
      unhandled: this.unhandled, deferred: this.deferred, dropped: this.dropped,
      expired: this.expired, errors: this.errors.length, lastDrain: this.lastDrain,
    };
  }

  format() {
    const lines = [
      `  ${this.name} — ${this.queue.length}/${this.capacity} queued · tick ${this.tick} · ${this.handlerCount} handlers · ${this.delivered} delivered`,
    ];
    for (const channel of this.channels.values()) {
      lines.push(`  ${(channel.enabled ? 'on ' : 'off').padEnd(4)}${channel.name.padEnd(16)} ${channel.delivered} delivered, ${channel.held} held`);
    }
    if (this.dropped || this.expired || this.errors.length) {
      lines.push(`  dropped ${this.dropped} · expired ${this.expired} · errors ${this.errors.length}`);
    }
    if (!this.queue.length) lines.push('  (queue empty)');
    return lines.join('\n');
  }

  installConsoleCommands(console_) {
    const events = this;
    console_.registerCommand({
      name: 'events', aliases: ['events.list'], category: 'Events', description: 'Event queue state.',
      execute: () => events.format(),
    });
    console_.registerCommand({
      name: 'events.push', category: 'Events', description: 'Queues an event from a JSON payload.',
      args: [{ name: 'type' }, { name: 'json', required: false, default: '{}' }, { name: 'priority', type: 'int', required: false, default: 0 }],
      execute: (args) => {
        let payload = {};
        try { payload = JSON.parse(args.json); } catch (error) { return `invalid json: ${error.message}`; }
        const record = events.enqueue(args.type, payload, { priority: args.priority });
        return record ? `queued #${record.id} \"${args.type}\"` : 'queue refused the event (full)';
      },
    });
    console_.registerCommand({
      name: 'events.drain', category: 'Events', description: 'Delivers queued events.',
      args: [{ name: 'max', type: 'int', min: 1, max: 100000, required: false, default: 0 }],
      execute: (args) => {
        const report = events.drain(args.max ? { maxEvents: args.max } : {});
        return `delivered ${report.delivered} · handled ${report.handled} · expired ${report.expired} · remaining ${report.remaining}`;
      },
    });
    console_.registerCommand({
      name: 'events.flush', category: 'Events', description: 'Drains until the queue is empty.',
      execute: () => { const report = events.flush(); return `flushed ${report.delivered} in ${report.passes} passes`; },
    });
    console_.registerCommand({
      name: 'events.clear', category: 'Events', description: 'Drops queued events (optionally of one type).',
      args: [{ name: 'type', required: false }],
      execute: (args) => `dropped ${events.clear({ type: args.type ?? null })} events`,
    });
    console_.registerCommand({
      name: 'events.channel', category: 'Events', description: 'Enables or disables an event channel.',
      args: [{ name: 'name' }, { name: 'state', type: 'boolean', required: false, default: true }],
      execute: (args) => { events.enableChannel(args.name, args.state); return `channel \"${args.name}\" ${args.state ? 'on' : 'off'}`; },
    });
    return console_;
  }
}

/**
 * A pending `request()`. `promise` resolves with the reply body or rejects on timeout/cancel; a
 * no-op catch is attached internally so an unobserved request never produces an unhandled
 * rejection warning in a headless run.
 */
export class MessageRequest {
  constructor(bus, { id, topic, body, createdTick, timeoutDrains }) {
    this.bus = bus;
    this.id = id;
    this.topic = topic;
    this.body = body;
    this.createdTick = createdTick;
    this.timeoutDrains = timeoutDrains;
    this.settled = false;
    this.asyncPending = false;
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    this.promise.catch(() => {});
  }

  cancel(reason = 'cancelled') { return this.bus.reject(this.id, reason); }
  describe() {
    return {
      id: this.id, topic: this.topic, settled: this.settled,
      asyncPending: this.asyncPending, age: this.bus.queue.tick - this.createdTick,
      timeoutDrains: this.timeoutDrains,
    };
  }
}

/** Topic-based messaging with wildcard subscriptions, request/reply and responders. */
export class MessageBus {
  constructor({ name = 'Bus', queue = null, capacity = 4096, stats = null, timeoutDrains = 60, defaultTtl = 0 } = {}) {
    this.name = name;
    this.stats = stats;
    this.queue = queue ?? new EventQueue({ name: `${name}/Queue`, capacity, stats, defaultTtl });
    this.timeoutDrains = Math.max(0, Math.floor(timeoutDrains));
    this.subscriptions = new Map();
    this.responders = new Map();
    this.requests = new Map();
    this._seq = 0;
    this._handlerSeq = 0;
    this.published = 0;
    this.replies = 0;
    this.dropped = 0;
    this.expiredRequests = 0;
    this.orphanReplies = 0;
    this.errors = [];
    // The one queue hook: every bus message is a 'message' event, so it shares the queue's
    // ordering, channels, capacity and error isolation with plain typed events.
    this._hook = this.queue.on('message', (envelope, record) => this._deliver(envelope, record), { priority: 0 });
  }

  static create(options) { return new MessageBus(options); }

  get pendingRequests() { return this.requests.size; }
  get count() { return this.queue.count; }

  // ------------------------------------------------------------------ registration
  /** `subscribe('player.*', fn)` — exact topics, `'*'`, and prefix wildcards all work. */
  subscribe(topic, fn, options = {}) { return this._add(this.subscriptions, topic, fn, options); }
  /** A responder answers requests; its return value (or `envelope.reply(v)`) is the reply body. */
  respond(topic, fn, options = {}) { return this._add(this.responders, topic, fn, options); }

  _add(map, topic, fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('MessageBus subscription needs a handler function');
    const {
      priority = EventPriority.Normal, once = false, filter = null, owner = null, weak = true,
    } = options;
    const id = ++this._handlerSeq;
    const entry = {
      id, topic, fn, priority, once, filter, owner,
      ownerRef: owner && weak && typeof WeakRef !== 'undefined' ? new WeakRef(owner) : null,
      calls: 0, enabled: true,
    };
    const handle = new EventSubscription(this, id, topic);
    entry.handle = handle;
    if (!map.has(topic)) map.set(topic, []);
    map.get(topic).push(entry);
    return handle;
  }

  off(target) {
    let removed = 0;
    for (const map of [this.subscriptions, this.responders]) {
      for (const [topic, list] of map) {
        const next = list.filter((entry) => {
          const match = target instanceof EventSubscription
            ? entry.id === target.id
            : (typeof target === 'string' ? entry.topic === target : entry.fn === target);
          if (match) { if (entry.handle) entry.handle._valid = false; removed++; return false; }
          return true;
        });
        if (next.length) map.set(topic, next);
        else map.delete(topic);
      }
    }
    if (target instanceof EventSubscription) target._valid = false;
    return removed;
  }

  _handlersFor(map, topic) {
    const matches = [];
    const seen = new Set();
    for (const [pattern, list] of map) {
      if (!topicMatches(pattern, topic)) continue;
      for (const entry of list) {
        if (!entry.enabled || seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (entry.ownerRef && !entry.ownerRef.deref()) { entry.enabled = false; continue; }
        matches.push(entry);
      }
    }
    return matches.sort((a, b) => b.priority - a.priority || a.id - b.id);
  }

  // ------------------------------------------------------------------ publish
  /**
   * Queues a message (delivered on the next drain) or dispatches it right away with
   * `{ immediate: true }`. Returns the envelope; `null` means the queue refused it.
   */
  publish(topic, body = null, { priority = EventPriority.Normal, channel = 'default', ttl = null, headers = null, immediate = false } = {}) {
    const envelope = this._envelope('publish', topic, body, headers);
    if (immediate) {
      this._deliver(envelope, new EventRecord({ id: -1, type: 'message', payload: envelope, priority, channel, tick: this.queue.tick }));
      return envelope;
    }
    const record = this.queue.enqueue('message', envelope, { priority, channel, ttl, headers });
    if (!record) {
      this.dropped++;
      busEvents.onDropped.broadcast(envelope, 'capacity', this);
      return null;
    }
    this.published++;
    this.stats?.count('Bus/Published');
    return envelope;
  }

  /** A request whose reply resolves `.promise`. Timeouts are counted in drains, not wall time. */
  request(topic, body = null, { priority = EventPriority.High, channel = 'default', headers = null, timeoutDrains = this.timeoutDrains, immediate = false } = {}) {
    const id = `req-${++this._seq}`;
    const pending = new MessageRequest(this, {
      id, topic, body, createdTick: this.queue.tick, timeoutDrains,
    });
    this.requests.set(id, pending);
    const envelope = this._envelope('request', topic, body, headers, id);
    envelope.reply = (value, options) => this.reply(id, value, options);
    if (immediate) {
      this._deliver(envelope, new EventRecord({ id: -1, type: 'message', payload: envelope, priority, channel, tick: this.queue.tick }));
    } else {
      const record = this.queue.enqueue('message', envelope, { priority, channel, headers });
      if (!record) {
        this.dropped++;
        pending._reject(new Error(`request \"${topic}\" was dropped (queue full)`));
        pending.settled = true;
        this.requests.delete(id);
        return pending;
      }
    }
    this.published++;
    return pending;
  }

  /** Answers a pending request. Unknown/expired correlation ids are counted, not thrown. */
  reply(correlationId, value = null, { error = false } = {}) {
    const pending = this.requests.get(correlationId);
    if (!pending || pending.settled) { this.orphanReplies++; return false; }
    pending.settled = true;
    pending.asyncPending = false;
    this.requests.delete(correlationId);
    this.replies++;
    if (error) pending._reject(value instanceof Error ? value : new Error(String(value?.message ?? value)));
    else pending._resolve(value);
    busEvents.onReply.broadcast(pending, value, this);
    return true;
  }

  /** Rejects a pending request (cancellation, shutdown, authority check). */
  reject(correlationId, reason = 'rejected') { return this.reply(correlationId, reason, { error: true }); }

  /** Broadcasts a reply envelope through the queue (ordered, cross-worker friendly). */
  publishReply(correlationId, value, options = {}) {
    const envelope = this._envelope('reply', 'reply', value, options.headers, correlationId);
    return this.queue.enqueue('message', envelope, { priority: options.priority ?? EventPriority.High, channel: options.channel ?? 'default' });
  }

  _envelope(kind, topic, body, headers, correlationId = null) {
    return {
      format: 'ominx-message-1', id: `msg-${++this._seq}`, kind, topic, body,
      headers: headers ?? {}, correlationId, tick: this.queue.tick,
    };
  }

  _deliver(envelope, record) {
    if (envelope.kind === 'reply') {
      const pending = this.requests.get(envelope.correlationId);
      if (pending) this.reply(envelope.correlationId, envelope.body, { error: !!envelope.headers?.error });
      else this.orphanReplies++;
    }
    const handlers = this._handlersFor(this.subscriptions, envelope.topic);
    const responders = envelope.kind === 'request' ? this._handlersFor(this.responders, envelope.topic) : [];
    const once = [];
    for (const entry of [...handlers, ...responders]) {
      try {
        if (entry.filter && !entry.filter(envelope.body, envelope)) continue;
        const result = entry.fn(envelope.body, envelope, this);
        entry.calls++;
        if (entry.handle) entry.handle.calls++;
        if (entry.once) once.push(entry.id);
        if (responders.includes(entry) && result !== undefined && !envelope.replied) {
          if (result && typeof result.then === 'function') {
            const pending = this.requests.get(envelope.correlationId);
            if (pending) pending.asyncPending = true;
            envelope.replied = true;
            result.then(
              (value) => this.reply(envelope.correlationId, value),
              (error) => this.reply(envelope.correlationId, error, { error: true }),
            );
          } else {
            envelope.replied = true;
            this.reply(envelope.correlationId, result);
          }
        }
      } catch (error) {
        this.errors.push({ topic: envelope.topic, handler: entry.id, message: error?.message ?? String(error) });
        if (this.errors.length > 64) this.errors.shift();
        log.error(`message handler for \"${envelope.topic}\" threw: ${error?.message ?? error}`);
        busEvents.onError.broadcast(envelope, error, this);
      }
    }
    if (once.length) for (const id of once) this.offById(id);
    busEvents.onDelivered.broadcast(envelope, { handlers: handlers.length, responders: responders.length }, this);
    return handlers.length + responders.length;
  }

  offById(id) {
    let removed = 0;
    for (const map of [this.subscriptions, this.responders]) {
      for (const [topic, list] of map) {
        const next = list.filter((entry) => {
          if (entry.id !== id) return true;
          removed++;
          if (entry.handle) entry.handle._valid = false;
          return false;
        });
        if (next.length) map.set(topic, next);
        else map.delete(topic);
      }
    }
    return removed;
  }

  // ------------------------------------------------------------------ pumping
  /** Delivers queued messages, then expires requests older than their drain budget. */
  drain(options = {}) {
    const report = this.queue.drain(options);
    this._expireRequests();
    return { ...report, pendingRequests: this.requests.size };
  }

  flush(options = {}) { return this.drain({ maxPasses: 16, ...options }); }

  _expireRequests() {
    for (const pending of [...this.requests.values()]) {
      if (pending.asyncPending) continue;
      if (this.queue.tick - pending.createdTick <= pending.timeoutDrains) continue;
      pending.settled = true;
      this.requests.delete(pending.id);
      this.expiredRequests++;
      pending._reject(new Error(`request \"${pending.topic}\" timed out after ${pending.timeoutDrains} drains`));
      busEvents.onExpired.broadcast(pending, this);
    }
  }

  /** Drops queued messages and rejects every pending request (shutdown / map change). */
  clear() {
    const dropped = this.queue.clear({ type: 'message' });
    for (const pending of [...this.requests.values()]) this.reject(pending.id, 'bus cleared');
    return dropped;
  }

  // ------------------------------------------------------------------ reporting
  describe() {
    return {
      name: this.name, queued: this.queue.count, tick: this.queue.tick,
      subscriptions: [...this.subscriptions.keys()], responders: [...this.responders.keys()],
      published: this.published, replies: this.replies, pendingRequests: this.requests.size,
      pending: [...this.requests.values()].map((pending) => pending.describe()),
      dropped: this.dropped, expiredRequests: this.expiredRequests,
      orphanReplies: this.orphanReplies, errors: this.errors.length,
      queue: this.queue.describe(),
    };
  }

  format() {
    const lines = [
      `  ${this.name} — ${this.queue.count} queued · ${this.published} published · ${this.replies} replies · ${this.requests.size} pending`,
      `  topics         ${[...this.subscriptions.keys()].join(', ') || '(none)'}`,
      `  responders     ${[...this.responders.keys()].join(', ') || '(none)'}`,
      `  dropped ${this.dropped} · timeouts ${this.expiredRequests} · orphan replies ${this.orphanReplies} · errors ${this.errors.length}`,
    ];
    if (this.requests.size) {
      for (const pending of this.requests.values()) lines.push(`  pending ${pending.id.padEnd(12)} \"${pending.topic}\" age ${pending.describe().age}/${pending.timeoutDrains}`);
    }
    return lines.join('\n');
  }

  installConsoleCommands(console_) {
    const bus = this;
    // The bus owns its queue, so installing the bus also makes the queue's `events.*` commands
    // reachable — an engine host calls one installer and gets the whole messaging surface.
    this.queue.installConsoleCommands(console_);
    console_.registerCommand({
      name: 'bus', aliases: ['bus.list'], category: 'Events', description: 'Message bus state and pending requests.',
      execute: () => bus.format(),
    });
    console_.registerCommand({
      name: 'bus.publish', category: 'Events', description: 'Publishes a message from a JSON body.',
      args: [{ name: 'topic' }, { name: 'json', required: false, default: '{}' }],
      execute: (args) => {
        let body = {};
        try { body = JSON.parse(args.json); } catch (error) { return `invalid json: ${error.message}`; }
        return bus.publish(args.topic, body) ? `published \"${args.topic}\"` : 'queue refused the message (full)';
      },
    });
    console_.registerCommand({
      name: 'bus.drain', category: 'Events', description: 'Delivers queued messages.',
      execute: () => { const report = bus.drain(); return `delivered ${report.delivered} · pending requests ${report.pendingRequests}`; },
    });
    console_.registerCommand({
      name: 'bus.requests', category: 'Events', description: 'Lists pending requests.',
      execute: () => JSON.stringify([...bus.requests.values()].map((pending) => pending.describe()), null, 2) || 'none',
    });
    console_.registerCommand({
      name: 'bus.clear', category: 'Events', description: 'Drops queued messages and rejects pending requests.',
      execute: () => `dropped ${bus.clear()} messages`,
    });
    return console_;
  }
}

/** Exact topic, `'*'`, or a trailing `.*` prefix wildcard. */
export function topicMatches(pattern, topic) {
  if (pattern === '*') return true;
  if (pattern === topic) return true;
  if (pattern.endsWith('.*')) return String(topic).startsWith(pattern.slice(0, -1));
  return false;
}

export default MessageBus;
