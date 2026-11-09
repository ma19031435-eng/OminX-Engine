#!/usr/bin/env node
/** Scratch probe for the event queue and message bus: ordering, deferral, request/reply, TTLs. */
import { EventQueue, MessageBus, EventPriority } from '../../engine/src/core/EventBus.js';
import { Console } from '../../engine/src/core/Console.js';

const queue = new EventQueue({ name: 'Probe', capacity: 8 });
const order = [];
queue.on('damage', (amount) => order.push(`low:${amount}`), { priority: -1 });
queue.on('damage', (amount) => order.push(`high:${amount}`), { priority: 10 });
queue.on('*', (_payload, record) => order.push(`any:${record.type}`));
queue.on('chain', (step) => { order.push(`chain:${step}`); if (step === 1) queue.enqueue('chain', 2); });
queue.enqueue('damage', 12);
queue.enqueue('damage', 40, { priority: EventPriority.Highest });
queue.enqueue('chain', 1);
console.log('pass 1:', queue.drain());
console.log('pass 2:', queue.drain());
console.log('order:', order);
console.log(queue.format());

const bus = new MessageBus({ name: 'ProbeBus', timeoutDrains: 2 });
const delivered = [];
bus.subscribe('match.*', (body, envelope) => delivered.push(`${envelope.topic}:${body.score ?? ''}`));
bus.respond('match.score', () => ({ score: 12, map: 'arena' }));
bus.publish('match.start', { score: 0 });
const request = bus.request('match.score', {});
const report = bus.drain();
console.log('bus drain:', { delivered: report.delivered, pending: report.pendingRequests });
console.log('reply:', await request.promise);
console.log('subscriptions saw:', delivered);

const timedOut = bus.request('nobody.home', {}, { timeoutDrains: 0 });
bus.drain();
try { await timedOut.promise; } catch (error) { console.log('timeout:', error.message); }

const console_ = new Console();
bus.installConsoleCommands(console_);
console.log('console:', console_.exec('bus', { silent: true }).output);
console.log('events:', console_.exec('events', { silent: true }).output);
console.log('describe:', {
  queue: queue.describe().handlerTypes,
  bus: { published: bus.published, replies: bus.replies, timeouts: bus.expiredRequests },
});
