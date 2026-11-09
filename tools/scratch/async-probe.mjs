#!/usr/bin/env node
/** Scratch probe for the async/task layer: priority, cancellation, retries, worker pool. */
import {
  TaskScheduler, TaskPriority, CancellationSource, AsyncScope, WorkerPool, parallel, retry,
} from '../../engine/src/core/Async.js';
import { Console } from '../../engine/src/core/Console.js';

const scheduler = new TaskScheduler({ name: 'Probe', concurrency: 2 });
const order = [];
scheduler.submit('low', () => { order.push('low'); return 1; }, { priority: TaskPriority.Low });
scheduler.submit('high', () => { order.push('high'); return 2; }, { priority: TaskPriority.High });
const asyncTask = scheduler.submit('decode', async ({ progress }) => {
  progress(0.5);
  await Promise.resolve();
  progress(1);
  return 'decoded';
});
console.log('drain:', scheduler.drain());
console.log('result:', await asyncTask.promise, 'order:', order);
await scheduler.runAll();

const source = new CancellationSource('level');
const doomed = scheduler.submit('bake', () => 'never', { token: source.token, group: 'navigation' });
source.cancel('map changed');
scheduler.drain();
console.log('cancelled:', doomed.state, doomed.error?.message, 'cancelled count:', scheduler.cancelled);

let attempts = 0;
const flaky = scheduler.submit('flaky', () => {
  attempts++;
  if (attempts < 2) throw new Error('transient');
  return 'ok';
}, { retries: 2 });
await scheduler.runAll();
console.log('retry:', flaky.state, flaky.result, 'attempts:', flaky.attempts, 'retried:', scheduler.retried);

const scope = new AsyncScope(scheduler, 'Level');
scope.submit('scope.a', () => 1);
scope.submit('scope.b', () => 2);
console.log('scope:', scope.describe(), 'cancelled by dispose:', scope.dispose());
console.log('parallel:', (await parallel([() => 10, async () => 20, () => 30], { concurrency: 2 })).map((row) => row.value));
console.log('retry helper:', await retry(async (n) => { if (n < 2) throw new Error('again'); return n; }, { attempts: 3 }));

const pool = new WorkerPool({
  size: 2,
  createWorker: (index) => ({
    name: `worker-${index}`,
    postMessage(message) {
      queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true, result: message.payload * 3 } }));
    },
    onmessage: null,
    terminate() {},
  }),
});
console.log('pool:', await Promise.all([1, 2, 3].map((value) => pool.execute(value))), pool.describe());
pool.terminate();

const console_ = new Console();
scheduler.installConsoleCommands(console_);
console.log('console:', console_.exec('tasks', { silent: true }).output);
console.log(scheduler.format());
