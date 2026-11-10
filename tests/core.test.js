/**
 * OminX Engine core tests.
 *
 * One suite per core module, verifying the *contract* rather than the implementation: ordering
 * guarantees, lifetime guarantees, error isolation, serialization round-trips and the integration
 * points between modules (subsystem dependency order, plugin boot, engine frame phases).
 *
 * Run with `node --test tests/core.test.js` or as part of `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Delegate, MulticastDelegate,
  Object as EngineObject, reflectClass, ClassCategory, getClassInfo, listClasses, getClassCount,
  buildClassTree, liveObjectCount, findLeakedObjects, setObjectTracking,
  Collector, ObjectHandle, WeakHandle, createScope,
  ObjectPool, FixedPool, RingBuffer, Deque, PriorityQueue, SparseSet, FreeList, BitSet,
  SpatialHashGrid, LRUCache, SlotMap,
  Stats,
  Subsystem, SubsystemCollection,
  ModuleManager, ModulePhase, ModuleTarget,
  JobGraph, WorkQueue, JobState,
  Config, ConfigLayer, ConfigType, parseCommandLine,
  Console, OutputLevel,
  AssetRegistry, AssetState, SoftAssetRef,
  createLocalization, LOCTEXT, LocalizedText, formatText, parseTablePayload,
  InputMappingSystem, InputMappingContext, InputAction, InputValueType, Keys, Modifiers, Triggers,
  createShooterActions, createShooterContext,
  ArchiveWriter, ArchiveReader, PayloadKind, defineStruct, getStruct, encodeStruct, decodeStruct,
  PluginManager, PluginState, PluginTarget, migrateStruct,
  Trace, traceEvents, TimerManager, timerEvents,
  Memory, MemoryTracker, MemoryScope, FrameArena, BufferPool, memoryEvents,
  FloatCurve, VectorCurve, CurveLibrary, CurveInterp, CurveExtrap, shooterCurvePresets, curveEvents,
  ReplaySystem, ReplayRecorder, ReplayPlayer, Replay, ReplayFrame, ReplayState, replayEvents,
  SaveGame, SaveSystem, SaveStorage, SaveSlotHeader, saveEvents, checksumOf, reviveSavedValue,
  EventQueue, EventRecord, EventPriority, EventSubscription, MessageBus, MessageRequest,
  busEvents, topicMatches,
  TaskScheduler, AsyncTask, AsyncScope, TaskState, TaskPriority, CancellationSource,
  CancellationToken, CancellationError, WorkerPool, asyncEvents,
  delay, retry, parallel, series,
  EngineCore, EnginePhase, createEngine, currentEngine, requireEngine,
  CORE_MODULES, CORE_VERSION, coreModuleList,
  INTEGER_RANGES, FIELD_TYPES, validateField, coerceField, validateObject, coerceObject,
  isPlainObject, describeFieldTypes,
  EngineError, DiagnosticLevel, DiagnosticHub, diagnostics, registerErrorCode, getErrorCode,
  listErrorCodes, formatMessage, describeError, check, ensure, verify, guard,
  diagnosticScope,
  DataTable, DataRegistry, parseCsv, dataEvents,
  NetRole, NetMode, RpcTarget, NetChannel, ReplicatedObject, ReplicationSystem, replicationEvents,
  TickGroup, TICK_GROUP_ORDER, ActorLifecycle, worldEvents, ActorComponent, SceneComponent, Actor, World,
} from '../engine/src/core/index.js';

const DT = 1 / 60;

// ---------------------------------------------------------------------- delegates

test('Delegate: single-cast binds, executes and clears', () => {
  const delegate = new Delegate('onDamage');
  const owner = { total: 0, apply(amount) { this.total += amount; } };
  assert.equal(delegate.isBound, false);
  assert.equal(delegate.execute(1), undefined, 'an unbound delegate runs nothing');
  delegate.bind(function (amount) { owner.total += amount; }, owner);
  assert.equal(delegate.isBound, true);
  delegate.execute(5);
  assert.equal(owner.total, 5);
  delegate.clear();
  assert.equal(delegate.isBound, false);

  // Owner-bound form: binds a method weakly, and `once` disarms after the first call.
  let calls = 0;
  const target = { onHit() { calls++; } };
  delegate.bindUObject(target, 'onHit');
  delegate.execute();
  delegate.execute();
  assert.equal(calls, 2);
  const once = new Delegate('onOnce');
  once.bind(() => { calls++; }, null, { once: true });
  once.execute();
  once.execute();
  assert.equal(calls, 3, 'once() disarms after the first execution');
});

test('MulticastDelegate: priorities order dispatch, higher first, insertion breaks ties', () => {
  const multicast = new MulticastDelegate('onTick');
  const order = [];
  const low = { run() { order.push('low'); } };
  const high = { run() { order.push('high'); } };
  const midA = { run() { order.push('midA'); } };
  const midB = { run() { order.push('midB'); } };
  multicast.add(low, 'run', { priority: 0 });
  multicast.add(high, 'run', { priority: 10 });
  multicast.add(midA, 'run', { priority: 5 });
  multicast.add(midB, 'run', { priority: 5 });
  multicast.broadcast();
  assert.deepEqual(order, ['high', 'midA', 'midB', 'low']);
  assert.equal(multicast.listenerCount, 4);
});

test('MulticastDelegate: one-shot listeners fire once; mutations during dispatch are deferred', () => {
  const multicast = new MulticastDelegate('onSpawn');
  let once = 0;
  let added = 0;
  let adderRuns = 0;
  multicast.add(() => { once++; }, { once: true });
  multicast.add(() => {
    adderRuns++;
    if (adderRuns > 1) return;                 // add exactly one listener, on the first pass
    multicast.add(() => { added++; });
  }, { priority: 10 });
  multicast.broadcast();
  multicast.broadcast();
  multicast.broadcast();
  assert.equal(once, 1, 'once() listener must only fire once');
  assert.equal(added, 2, 'listeners added during dispatch apply to the next broadcast');
});

test('MulticastDelegate: a throwing listener does not stop the others', () => {
  const multicast = new MulticastDelegate('onEvent');
  let survived = 0;
  multicast.add(() => { throw new Error('boom'); }, { priority: 10 });
  multicast.add(() => { survived++; });
  multicast.broadcast();
  assert.equal(survived, 1);
});

test('MulticastDelegate: handles unbind, removeAllFor drops an owner and weak owners are supported', () => {
  const multicast = new MulticastDelegate('onHit');
  let hits = 0;
  const owner = { onHit() { hits++; } };
  const handle = multicast.add(owner, 'onHit');
  multicast.add(() => { hits++; });
  multicast.broadcast();
  assert.equal(hits, 2);
  handle.unbind();
  multicast.broadcast();
  assert.equal(hits, 3);
  multicast.removeAllFor(owner);
  assert.equal(multicast.listenerCount, 1);
  const description = multicast.describe();
  assert.ok(Array.isArray(description), 'describe() lists the remaining listeners');
  assert.equal(description.length, multicast.listenerCount);
  assert.equal(typeof description[0].id, 'number');
  assert.equal(description[0].once, false);
});

// ---------------------------------------------------------------------- object model

test('Object: reflection records hierarchy, properties, methods and events', () => {
  class Actor extends EngineObject { static ClassName = 'Actor'; }
  reflectClass(Actor, {
    parent: EngineObject, category: ClassCategory.Gameplay, displayName: 'Actor',
    properties: [{ name: 'health', type: 'number', default: 100 }],
    events: [{ name: 'onDied', description: 'health reached zero' }],
    methods: [{ name: 'kill', description: 'kills the actor' }],
  });
  class Pawn extends Actor { static ClassName = 'Pawn'; }
  reflectClass(Pawn, { parent: Actor, category: ClassCategory.Gameplay, properties: [{ name: 'speed', type: 'number', default: 6 }] });

  const info = getClassInfo(Pawn);
  assert.equal(info.name, 'Pawn');
  assert.equal(info.parent.name, 'Actor');
  assert.deepEqual(info.hierarchy().map((entry) => entry.name), ['Object', 'Actor', 'Pawn'], 'root first');
  const names = [...info.allProperties().keys()];
  assert.ok(names.includes('speed') && names.includes('health') && names.includes('name'));
  assert.equal(info.allEvents().has('onDied'), true);
  assert.equal(info.allMethods().has('kill'), true);
  assert.equal(info.isChildOf(Actor), true);
  assert.equal(info.allProperties().get('health').default, 100, 'property descriptors survive reflection');
  assert.deepEqual(listClasses({ category: 'gameplay' }).map((entry) => entry.name).sort(), ['Actor', 'Pawn']);

  // Cycles must not hang the hierarchy walk.
  const tree = buildClassTree('Object');
  assert.ok(tree.children.length >= 1);
  const actor = new Pawn('Player1');
  assert.equal(actor.className, 'Pawn');
  assert.ok(typeof actor.id === 'number' && actor.id > 0);
  assert.equal(actor.isInitialized, false);
  actor.initialize({ seed: 1 });
  assert.equal(actor.isInitialized, true);
  actor.addTag('player');
  assert.equal(actor.hasTag('player'), true);
  actor.destroy();
  assert.equal(actor.isDestroyed, true);
  assert.ok(getClassCount() >= 3);
  assert.ok(listClasses({ category: ClassCategory.Gameplay }).some((entry) => entry.name === 'Pawn'));
});

test('Object: tracking finds live objects and leaks', () => {
  setObjectTracking(true);
  const before = liveObjectCount();
  const tracked = new EngineObject('Tracked');
  assert.equal(liveObjectCount(), before + 1);
  const leaked = findLeakedObjects();
  assert.ok(Array.isArray(leaked));
  tracked.destroy();
  assert.equal(liveObjectCount(), before);
});

// ---------------------------------------------------------------------- lifetimes

test('Collector: pins block collection, release permits it, flush destroys pending kills', () => {
  const collector = new Collector();
  const victim = new EngineObject('Victim');
  collector.markPendingKill(victim);
  assert.equal(collector.isPendingKill(victim), true);
  assert.equal(collector.pendingCount, 1);

  collector.pin(victim);
  collector.flushPendingKill();
  assert.equal(victim.isDestroyed, false, 'a pinned object must survive pending kill');

  collector.unpin(victim);
  collector.markPendingKill(victim);
  collector.flushPendingKill();
  assert.equal(victim.isDestroyed, true);
  assert.equal(collector.wasDestroyed(victim.id), true);
  assert.ok(collector.stats().sweeps >= 0);
});

test('Collector: scopes own their children, and killing a scope tears the tree down', () => {
  const scope = createScope('Level');
  const child = scope.spawn(() => new EngineObject('Child'), EngineObject);
  assert.equal(scope.objectCount, 1);
  assert.equal(child.isDestroyed, false);
  scope.destroy();
  assert.equal(scope.objectCount, 0);
});

test('Handles: ObjectHandle pins a target, WeakHandle observes collection', () => {
  const target = new EngineObject('Target');
  const handle = new ObjectHandle(target);
  assert.equal(handle.get(), target);
  assert.equal(Collector.pinCount(target), 1);
  handle.release();
  assert.equal(Collector.pinCount(target), 0);

  const weak = new WeakHandle(target);
  assert.equal(weak.get(), target);
  assert.equal(weak.isValid, true);
  target.destroy();
  assert.equal(weak.state, 'destroyed');
});

// ---------------------------------------------------------------------- containers

test('Containers: pools recycle, rings overwrite, deques and sorted sets behave', () => {
  const pool = new ObjectPool(() => ({ value: 0 }), { capacity: 2, grow: true });
  const first = pool.acquire();
  const second = pool.acquire();
  first.value = 42;
  pool.release(first);
  const reused = pool.acquire();
  assert.equal(reused, first, 'pools must recycle the released instance');
  assert.equal(reused.value, 42);
  assert.equal(pool.stats().acquired, 3);

  const fixed = new FixedPool(() => ({}), 2, {});
  fixed.acquire(); fixed.acquire();
  assert.equal(fixed.acquire(), null, 'a non-growing pool refuses past capacity');

  const ring = new RingBuffer(3);
  ring.push(1); ring.push(2); ring.push(3); const overwritten = ring.push(4);
  assert.equal(overwritten, 1);
  assert.deepEqual(ring.toArray(), [2, 3, 4]);
  assert.equal(ring.at(0), 4, 'index 0 is the newest entry');
  assert.equal(ring.length, 3);

  const deque = new Deque();
  deque.pushBack(2); deque.pushFront(1); deque.pushBack(3);
  assert.equal(deque.popFront(), 1);
  assert.equal(deque.popBack(), 3);
  assert.equal(deque.length, 1);

  const queue = new PriorityQueue({ minQueue: false });   // higher priority pops first
  queue.push('low', 1); queue.push('high', 10); queue.push('mid', 5);
  assert.equal(queue.pop(), 'high');
  assert.equal(queue.pop(), 'mid');
  assert.equal(queue.peek(), 'low');
  const minQueue = new PriorityQueue();
  minQueue.push('cheap', 1); minQueue.push('expensive', 100);
  assert.equal(minQueue.pop(), 'cheap', 'the default collects the numerically smallest priority first');
});

test('Containers: sparse sets, free lists and bit sets maintain dense indices', () => {
  const sparse = new SparseSet();
  sparse.add(7);
  sparse.add(3);
  assert.equal(sparse.has(7), true);
  assert.equal(sparse.has(5), false);
  sparse.remove(7);
  assert.equal(sparse.has(7), false);
  assert.deepEqual([...sparse].map((entry) => entry.entity), [3], 'iteration yields dense entity/component pairs');

  const free = new FreeList({ capacity: 2 });
  const freeHandleId = free.alloc();
  free.alloc();
  assert.equal(free.alloc(), -1, 'an exhausted free list reports the sentinel');
  assert.equal(free.freeHandle(freeHandleId), true);
  assert.equal(free.alloc(), freeHandleId, 'a freed index is handed back out');

  const bits = new BitSet(64);
  bits.set(3); bits.set(40); bits.set(3);
  assert.equal(bits.get(3), true);
  assert.equal(bits.countBits(), 2);
  assert.deepEqual(bits.toArray(), [3, 40]);
  bits.clearBit(3);
  assert.equal(bits.countBits(), 1);
});

test('Containers: spatial grid, LRU cache and slot map enforce their invariants', () => {
  const grid = new SpatialHashGrid({ cellSize: 10 });
  grid.insert({ x: 0, y: 0, z: 0 }, { id: 'a' });      // insert(position, payload)
  grid.insert({ x: 5, y: 5, z: 0 }, { id: 'b' });
  grid.insert({ x: 100, y: 0, z: 0 }, { id: 'c' });
  assert.equal(grid.count, 3);
  const near = grid.query({ x: 0, y: 0, z: 0 }, 12).map((item) => item.id).sort();
  assert.deepEqual(near, ['a', 'b']);
  grid.clear();
  assert.equal(grid.query({ x: 0, y: 0, z: 0 }, 12).length, 0);

  const cache = new LRUCache(2);
  cache.set('a', 1); cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.has('b'), false, 'the least recently used entry is evicted');
  assert.equal(cache.get('a'), 1);

  const slots = new SlotMap();
  const handle = slots.insert({ name: 'first' });
  slots.remove(handle);
  const reused = slots.insert({ name: 'second' });
  assert.equal(slots.get(handle), undefined, 'stale handles must not read recycled slots');
  assert.deepEqual(slots.get(reused), { name: 'second' });
});

// ---------------------------------------------------------------------- stats

test('Stats: counters, gauges, timings and frame capture report the frame', () => {
  const stats = new Stats({ history: 8 });
  stats.beginFrame();
  stats.count('Shots/Fired', 3);
  stats.gauge('Players/Online', 12);
  stats.accumulate('Bytes/Out', 512);
  stats.timing('Physics/Step', 1.5);
  stats.record('Frame/Ms', 16.2);
  stats.endFrame({ map: 'arena' });
  assert.equal(stats.getCounter('Shots/Fired'), 3);
  assert.equal(stats.getGauge('Players/Online'), 12);
  assert.equal(stats.value('Physics/Step'), 1.5);
  const frame = stats.getFrameStats();
  assert.ok(frame.frames >= 1);
  assert.ok(stats.getHistogram('Frame/Ms').count >= 1);
  assert.ok(stats.getReport());
  stats.count('Shots/Fired', 2);
  assert.equal(stats.getCounter('Shots/Fired'), 5, 'counters accumulate');
  // `measure` returns the callback's value and times it.
  const value = stats.measure('Work/Do', () => 7);
  assert.equal(value, 7);
  assert.ok(stats.get('Work/Do'));
});

test('Stats: disabling makes collection a no-op', () => {
  const stats = new Stats();
  stats.setEnabled(false);
  const start = performance.now();
  for (let i = 0; i < 2000; i++) stats.count('Noop/Counter');
  const elapsed = performance.now() - start;
  assert.equal(stats.getCounter('Noop/Counter'), 0);
  assert.ok(elapsed < 200);
});

// ---------------------------------------------------------------------- subsystems

test('Subsystem: dependencies initialize first regardless of registration order', async () => {
  const order = [];
  const make = (name, deps) => {
    class Subsystem_ extends Subsystem {
      static TypeName = name;
      static Dependencies = deps;
      onInitialize() { order.push(`init:${this.name}`); }
      onDeinitialize() { order.push(`deinit:${this.name}`); }
    }
    return Subsystem_;
  };
  const collection = new SubsystemCollection('Test');
  collection.register(make('Physics', ['renderer']));
  collection.register(make('Renderer', ['assets']));
  collection.register(make('Assets', ['config']));
  collection.register(make('Config', []));
  await collection.initializeAll({ engine: null });
  assert.deepEqual(order, ['init:Config', 'init:Assets', 'init:Renderer', 'init:Physics']);
  assert.equal(collection.errors.length, 0, 'case-insensitive dependency matching');
  assert.equal(collection.count, 4);
  assert.equal(collection.instances.every((subsystem) => subsystem.isReady), true);
  collection.deinitializeAll();
  assert.deepEqual(order.slice(-4), ['deinit:Physics', 'deinit:Renderer', 'deinit:Assets', 'deinit:Config']);
  assert.equal(collection.instances.every((subsystem) => subsystem.isDead), true);
});

test('Subsystem: late registration with an unresolved dependency waits, then comes up', async () => {
  const seen = [];
  class Alpha extends Subsystem { static TypeName = 'Alpha'; onInitialize() { seen.push('alpha'); } }
  class Beta extends Subsystem { static TypeName = 'Beta'; static Dependencies = ['alpha']; onInitialize() { seen.push('beta'); } }
  const collection = new SubsystemCollection('Late');
  await collection.initializeAll({ engine: 'ctx' });
  collection.register(Beta);                       // dependency missing: must not throw or error
  assert.deepEqual(seen, []);
  assert.equal(collection.errors.length, 0);
  collection.register(Alpha);                      // dependency arrives: both come up
  assert.deepEqual(seen, ['alpha', 'beta']);
  assert.equal(collection.get('beta').isReady, true);
  assert.equal(collection.get('BETA').name, 'Beta', 'lookup is case-insensitive');
});

test('Subsystem: cycles and missing dependencies are reported, not fatal', async () => {
  const collection = new SubsystemCollection('Broken');
  collection.register(class A extends Subsystem { static TypeName = 'A'; static Dependencies = ['b']; });
  collection.register(class B extends Subsystem { static TypeName = 'B'; static Dependencies = ['a']; });
  collection.register(class C extends Subsystem { static TypeName = 'C'; static Dependencies = ['missing'] });
  await collection.initializeAll({});
  assert.ok(collection.errors.length >= 2, 'cycle and missing dependency are both reported');
  assert.equal(collection.get('C').isReady, false);
});

test('Subsystem: disabled subsystems are skipped, timing is recorded, state serializes', async () => {
  const stats = new Stats();
  const collection = new SubsystemCollection('Timed', { stats });
  collection.register(class Ticker extends Subsystem {
    static TypeName = 'Ticker';
    onUpdate(delta) { this.lastDelta = delta; }
  });
  await collection.initializeAll({});
  collection.update(DT);
  const ticker = collection.get('Ticker');
  assert.equal(ticker.lastDelta, DT);
  assert.ok(collection.lastUpdateMs >= 0);
  assert.ok(stats.get('Subsystems/Update'));
  collection.setEnabled('Ticker', false);
  ticker.lastDelta = null;
  collection.update(DT);
  assert.equal(ticker.lastDelta, null, 'disabled subsystems do not update');
  const saved = collection.serialize();
  assert.equal(saved[0].name, 'Ticker');
  assert.equal(saved[0].enabled, false);
  assert.equal(saved[0].type, 'Ticker');
  collection.deserialize([{ name: 'Ticker', enabled: true, data: {} }]);
  assert.equal(ticker.enabled, true);
});

// ---------------------------------------------------------------------- modules

test('ModuleManager: phases load in order, targets gate modules, dependencies resolve', async () => {
  const loaded = [];
  const manager = new ModuleManager({ target: ModuleTarget.Client });
  manager.register({ name: 'core', phase: ModulePhase.PreInit, target: ModuleTarget.Both, load: () => { loaded.push('core'); return { api: 1 }; } });
  manager.register({ name: 'render', phase: ModulePhase.GameInit, target: ModuleTarget.Client, dependencies: ['core'], load: () => { loaded.push('render'); } });
  manager.register({ name: 'servermgr', phase: ModulePhase.GameInit, target: ModuleTarget.Server, load: () => { loaded.push('servermgr'); } });
  manager.register({ name: 'game', phase: ModulePhase.PostEngineInit, target: ModuleTarget.Both, dependencies: ['render'], load: () => { loaded.push('game'); } });
  assert.equal(manager.count, 4);
  assert.deepEqual([...manager.eligible()].map((descriptor) => descriptor.name), ['core', 'render', 'game']);
  await manager.loadAll(ModulePhase.PreEngineInit);
  await manager.startupAll();
  assert.deepEqual(loaded, ['core', 'render', 'game']);
  assert.equal(manager.get('servermgr').state, 'registered', 'server-only modules stay unloaded on a client');
  assert.equal(manager.exports.core?.api, 1, 'module exports are reachable by name');
  assert.equal(manager.describe().startupOrder.length >= 1, true);
});

test('ModuleManager: a failing module fails its dependents and records both errors', async () => {
  const manager = new ModuleManager({ target: ModuleTarget.Client });
  manager.register({ name: 'bad', load: async () => { throw new Error('cannot load'); } });
  manager.register({ name: 'dependent', dependencies: ['bad'], load: () => {} });
  await manager.loadAll();
  assert.equal(manager.get('bad').state, 'failed');
  assert.equal(manager.get('dependent').state, 'failed');
  assert.ok(manager.errors.length >= 1);
});

test('ModuleManager: hot reload re-runs the module and can unregister', async () => {
  let generation = 0;
  const manager = new ModuleManager({ target: ModuleTarget.Client });
  manager.register({ name: 'hot', hotReload: true, load: () => `gen${++generation}` });
  await manager.loadAll();
  assert.equal(manager.exports.hot, 'gen1');
  await manager.reload('hot');
  assert.equal(manager.exports.hot, 'gen2');
  assert.equal(manager.unregister('hot'), true);
  assert.equal(manager.count, 0);
});

// ---------------------------------------------------------------------- jobs

test('JobGraph: dependencies order execution, independent jobs share a level', async () => {
  const jobs = new JobGraph({ concurrency: 2 });
  const log = [];
  jobs.add({ name: 'input', group: 'sim', run: () => log.push('input') });
  jobs.add({ name: 'physics', group: 'sim', dependsOn: ['input'], run: () => log.push('physics') });
  jobs.add({ name: 'ai', group: 'sim', dependsOn: ['physics'], run: () => log.push('ai') });
  jobs.add({ name: 'stream', group: 'io', run: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); log.push('stream'); } });
  jobs.add({ name: 'render', group: 'render', dependsOn: ['ai', 'stream'], run: () => log.push('render') });
  jobs.setGroupDependency('render', 'sim');
  const report = await jobs.executeAsync({}, DT);
  assert.equal(log.at(-1), 'render');
  assert.ok(log.indexOf('input') < log.indexOf('physics'));
  assert.ok(report.jobs.input !== undefined);
  assert.ok(jobs.resolveLevels().length >= 3);
  assert.ok(jobs.groups().get('sim').includes('physics'));
  assert.ok(jobs.report({ limit: 3 }).jobs.length === 3);
  assert.match(jobs.format(), /job/);
});

test('JobGraph: a failing job skips dependents, isolates errors and records budgets', async () => {
  const jobs = new JobGraph();
  const ran = [];
  jobs.add({ name: 'broken', run: () => { throw new Error('nope'); } });
  jobs.add({ name: 'dependent', dependsOn: ['broken'], run: () => ran.push('dependent') });
  jobs.add({ name: 'independent', run: () => ran.push('independent') });
  const report = await jobs.executeAsync({}, DT);
  assert.equal(jobs.get('broken').state, JobState.Failed);
  assert.equal(jobs.get('dependent').state, JobState.Skipped);
  assert.ok(ran.includes('independent'), 'unrelated jobs still run');
  assert.ok(jobs.errors.length >= 1);
  assert.ok(report.jobs.independent !== undefined);

  const budgeted = new JobGraph();
  budgeted.add({ name: 'slow', budgetMs: 0.0001, run: () => { const end = performance.now() + 3; while (performance.now() < end); } });
  await budgeted.execute({}, DT);
  assert.equal(budgeted.get('slow').budgetStrikes, 1);
});

test('JobGraph: dependency cycles are reported rather than hanging', async () => {
  const jobs = new JobGraph();
  jobs.add({ name: 'a', dependsOn: ['b'], run: () => {} });
  jobs.add({ name: 'b', dependsOn: ['a'], run: () => {} });
  await assert.rejects(() => jobs.executeAsync({}, DT), /cycle/);
});

test('WorkQueue: drains with bounded concurrency and survives task failures', async () => {
  const queue = new WorkQueue({ concurrency: 2 });
  const done = [];
  let peak = 0;
  for (let i = 0; i < 8; i++) {
    queue.push(async () => {
      peak = Math.max(peak, queue.running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      done.push(i);
    }, i);
  }
  queue.push(async () => { throw new Error('task failure'); });
  await queue.drain();
  assert.equal(done.length, 8);
  assert.ok(peak <= 2);
  assert.equal(queue.stats.failed, 1);
  assert.equal(queue.size, 0);
});

// ---------------------------------------------------------------------- config

test('Config: layers override in priority order and the origin stays inspectable', () => {
  const config = new Config();
  config.define('renderer.fov', { type: ConfigType.Number, default: 90, min: 60, max: 130 });
  config.define('renderer.vsync', { default: true });
  config.define('game.mode', { type: ConfigType.Enum, enum: ['deathmatch', 'ctf'], default: 'deathmatch' });
  assert.equal(config.getNumber('renderer.fov'), 90);
  assert.equal(config.origin('renderer.fov').layer, 'defaults');

  config.apply({ 'renderer.fov': 100 }, { layer: ConfigLayer.Project });
  config.apply({ 'renderer.fov': 120 }, { layer: ConfigLayer.CommandLine });
  assert.equal(config.getNumber('renderer.fov'), 120);
  assert.equal(config.origin('renderer.fov').layer, 'commandline');

  // Out-of-range values are rejected, with the offending layer named, and do not change the value.
  assert.equal(config.set('renderer.fov', 400, { layer: ConfigLayer.Runtime }), false);
  assert.equal(config.getNumber('renderer.fov'), 120);
  assert.equal(config.validationErrors.length, 1);
  assert.match(config.validationErrors[0].message, /maximum/);

  // Removing the top layer reveals the layer below.
  assert.equal(config.unset('renderer.fov', { layer: ConfigLayer.CommandLine }), true);
  assert.equal(config.getNumber('renderer.fov'), 100);

  // Type coercion from files/CLI.
  assert.equal(config.set('renderer.vsync', 'false'), true);
  assert.equal(config.getBool('renderer.vsync'), false);
  assert.equal(config.set('game.mode', 'ctf'), true);
  assert.equal(config.set('game.mode', 'nope'), false);
  assert.equal(config.getString('game.mode'), 'ctf');
});

test('Config: change listeners work per key and per wildcard, and text/CLI round-trip', () => {
  const config = new Config({ name: 'RoundTrip' });
  config.define('renderer.fov', { default: 90, group: 'Renderer', description: 'Field of view' });
  config.define('renderer.scale', { default: 1, min: 0.25, max: 2, group: 'Renderer' });
  config.define('audio.volume', { default: 0.8, min: 0, max: 1 });
  const changes = [];
  config.on('renderer.*', (value, previous, key) => changes.push(`${key}=${value}`));
  config.on('audio.volume', (value) => changes.push(`volume=${value}`));
  config.apply({ 'renderer.fov': 110, 'audio.volume': 0.5 });
  assert.deepEqual(changes, ['renderer.fov=110', 'volume=0.5'], 'wildcard and exact listeners both fire');

  const text = config.toText();
  assert.match(text, /\[renderer\]/);
  const reloaded = new Config({ schema: config.schema });
  reloaded.loadText(text, { layer: ConfigLayer.User });
  assert.equal(reloaded.getNumber('renderer.fov'), 110);
  assert.equal(reloaded.getNumber('audio.volume'), 0.5);

  const cli = parseCommandLine('--renderer.fov 100 --mute --bots=8', config.schema);
  assert.equal(cli['renderer.fov'], 100);
  assert.equal(cli.mute, true);
  assert.equal(cli.bots, 8);
  config.apply(cli, { layer: ConfigLayer.CommandLine });
  assert.equal(config.getNumber('renderer.fov'), 100);

  assert.deepEqual(Object.keys(config.section('renderer')).sort(), ['fov', 'scale']);
  const rows = config.describe({ group: 'Renderer' });
  assert.equal(rows.length, 2);
  assert.match(config.format({ group: 'Renderer' }), /renderer\.fov/);
  assert.equal(config.report().changes >= 2, true);
});

// ---------------------------------------------------------------------- console

test('Console: commands parse arguments, validate ranges and report usage', () => {
  const console_ = new Console();
  let spawned = null;
  console_.registerCommand({
    name: 'spawn', category: 'Game', description: 'Spawns bots.',
    args: [{ name: 'count', type: 'int', min: 1, max: 32 }, { name: 'team', required: false, default: 'red' }],
    execute: (args) => { spawned = args; return `spawned ${args.count} for ${args.team}`; },
  });
  const ok = console_.exec('spawn 4 blue', { silent: true });
  assert.equal(ok.ok, true);
  assert.deepEqual({ count: spawned.count, team: spawned.team }, { count: 4, team: 'blue' });
  const missing = console_.exec('spawn', { silent: true });
  assert.equal(missing.ok, false);
  assert.match(missing.output, /usage: spawn/);
  const outOfRange = console_.exec('spawn 99', { silent: true });
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.output, /above 32/);
  assert.equal(console_.exec('spawn 4', { silent: true }).ok, true, 'optional argument uses its default');

  // Quotes survive statement splitting and are removed exactly once, so a quoted JSON argument
  // (save.write, replay metadata, a config blob) arrives intact; a `;` inside quotes is not a
  // statement separator.
  let payload = null;
  console_.registerCommand({
    name: 'json', args: [{ name: 'payload' }],
    execute: (args) => { payload = args.payload; return 'ok'; },
  });
  assert.equal(console_.exec('json \'{"progress":{"level":9}}\'', { silent: true }).ok, true);
  assert.deepEqual(JSON.parse(payload), { progress: { level: 9 } });
  assert.equal(console_.exec('echo "a; b"', { silent: true }).results.length, 1);
});

test('Console: variables bind to config, aliases expand, statements chain', () => {
  const config = new Config();
  config.define('renderer.fov', { default: 90, min: 60, max: 130 });
  config.define('net.tickRate', { default: 60 });
  const console_ = new Console({ config });
  assert.equal(console_.exec('renderer.fov', { silent: true }).output, 'renderer.fov = 90');
  console_.exec('renderer.fov 110', { silent: true });
  assert.equal(config.getNumber('renderer.fov'), 110);
  assert.equal(console_.exec('renderer.fov 999', { silent: true }).ok, false);
  assert.equal(config.getNumber('renderer.fov'), 110);

  console_.alias('fps', 'renderer.fov 120; echo done');
  const aliasRun = console_.exec('fps', { silent: true });
  assert.equal(aliasRun.ok, true);
  assert.equal(config.getNumber('renderer.fov'), 120);
  assert.match(console_.exec('history 5', { silent: true }).output, /fps/);
  assert.ok(console_.complete('renderer').includes('renderer.fov'));
  assert.equal(console_.completionPrefix('renderer'), 'renderer.fov', 'a unique match completes fully');
  console_.registerCommand({ name: 'renderer.debug', execute: () => '' });
  assert.equal(console_.completionPrefix('renderer.'), 'renderer.');
  assert.match(console_.help('renderer.fov'), /variable|renderer\.fov/);
  assert.match(console_.help(), /commands/);
});

test('Console: async commands settle later, failures are isolated, output streams', async () => {
  const console_ = new Console();
  const output = [];
  console_.registerCommand({ name: 'sink', execute: (record) => { output.push(record); } });
  const seen = [];
  const { consoleEvents } = await import('../engine/src/core/Console.js');
  consoleEvents.onOutput.add((record) => seen.push(record.message));
  console_.registerCommand({ name: 'boom', execute: () => { throw new Error('kaboom'); } });
  console_.registerCommand({ name: 'later', execute: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return 'finished'; } });
  assert.equal(console_.exec('boom', { silent: true }).ok, false);
  assert.equal(console_.exec('echo alive', { silent: true }).ok, true);
  const pending = console_.exec('later', { silent: true });
  assert.equal(pending.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(seen.includes('finished'), 'async command output is printed when it settles');
  const script = console_.execText('# comment\nspawn 1\nrenderer.fov\n', { silent: true });
  assert.equal(script.results.length, 2);
  assert.equal(console_.lines().length >= 1, true);
  assert.match(console_.transcript(), /finished/);
});

// ---------------------------------------------------------------------- assets

test('AssetRegistry: scanning, type inference, dedupe, dependencies and handles', async () => {
  const reads = [];
  const registry = new AssetRegistry({
    io: async (path) => { reads.push(path); return new TextEncoder().encode(path).buffer; },
  });
  registry.registerType({ name: 'texture', extensions: ['.png', '.ktx2'], loader: async (entry) => ({ texture: entry.path }) });
  registry.registerType({ name: 'material', extensions: ['.mat'], loader: async (entry, context) => ({ material: entry.path, textures: await Promise.all(entry.dependencies.map((dependency) => context.registry.load(dependency))) }) });
  registry.scan([
    { path: '/Game/Tex/rock.png', size: 1000, tags: ['environment'] },
    { path: '/Game/Mat/floor.mat', size: 100, dependencies: ['/Game/Tex/rock.png'], bundle: 'arena' },
  ]);
  assert.equal(registry.count(), 2);
  assert.equal(registry.get('/Game/Tex/rock.png').type, 'texture');
  assert.equal(registry.find({ tag: 'environment' }).length, 1);
  assert.equal(registry.bundle('arena').assets.size, 1);

  const material = await registry.load('/Game/Mat/floor.mat');
  assert.equal(material.material, '/Game/Mat/floor.mat');
  assert.equal(material.textures.length, 1);
  assert.equal(registry.isLoaded('/Game/Tex/rock.png'), true, 'dependencies load with their asset');

  const readsAfterFirstLoad = reads.length;
  await registry.load('/Game/Mat/floor.mat');
  assert.equal(reads.length, readsAfterFirstLoad, 're-loading an already loaded asset does not re-read');

  const handle = await registry.loadHandle('/Game/Tex/rock.png');
  assert.equal(registry.get('/Game/Tex/rock.png').hardRefs, 1);
  const collected = registry.collectGarbage();
  assert.equal(collected.collected.includes('/Game/Tex/rock.png'), false, 'referenced assets are not collected');
  handle.release();
  registry.unload('/Game/Mat/floor.mat');
  const second = registry.collectGarbage();
  assert.ok(second.collected.includes('/Game/Tex/rock.png'));
  assert.ok(second.freedBytes >= 1000);
  assert.match(registry.format(), /registered/);
  assert.ok(registry.report().byType.texture);
});

test('AssetRegistry: soft references, bundles, derived data and failure handling', async () => {
  const registry = new AssetRegistry({ io: async () => new ArrayBuffer(8) });
  registry.registerType({ name: 'map', extensions: ['.map'], loader: async () => ({ spawns: 4 }) });
  registry.registerType({ name: 'broken', extensions: ['.broken'], loader: async () => { throw new Error('corrupt'); } });
  registry.scan([{ path: '/Game/Maps/Arena.map', size: 2048, bundle: 'arena' }, { path: '/Game/Maps/Bad.broken', size: 16 }]);

  const soft = registry.soft('/Game/Maps/Arena.map');
  assert.ok(soft instanceof SoftAssetRef);
  assert.equal(soft.isLoaded, false);
  assert.deepEqual(await soft.get(), { spawns: 4 });
  assert.equal(await registry.soft('/Game/Maps/Missing.map').get(), null, 'a missing soft ref resolves to null');

  let builds = 0;
  registry.derive('/Game/Maps/Arena.map', 'navmesh', () => { builds++; return { nodes: 3110 }; });
  registry.derive('/Game/Maps/Arena.map', 'navmesh', () => { builds++; return { nodes: 0 }; });
  assert.equal(builds, 1);
  assert.equal(registry.invalidateDerived('/Game/Maps/Arena.map', 'navmesh'), true);

  assert.equal(await registry.load('/Game/Maps/Bad.broken'), null);
  assert.equal(registry.get('/Game/Maps/Bad.broken').state, AssetState.Failed);
  registry.retry('/Game/Maps/Bad.broken');
  assert.equal(registry.get('/Game/Maps/Bad.broken').state, AssetState.Registered);

  registry.bundle('dlc', { dependsOn: [] });
  registry.register('/Game/Dlc/Extra.map', { size: 100, bundle: 'dlc' });
  const bundle = await registry.loadBundle('arena');
  assert.equal(bundle.state, 'loaded');
  assert.ok(bundle.loadedCount >= 1);
  bundle.unload();
  assert.equal(bundle.state, 'unloaded');
  assert.equal(registry.dependentsOf('/Game/Maps/Arena.map') !== null, true);
});

// ---------------------------------------------------------------------- localization

test('Localization: culture fallback chain resolves through parents to source text', () => {
  const localization = createLocalization({ culture: 'en-GB', fallbackCulture: 'en' });
  localization.addTable('HUD', {
    en: { Ammo: '{current} / {reserve}', Wave: 'Wave {wave}' },
    'en-GB': { Ammo: '{current} / {reserve} rounds' },
    ar: { Ammo: 'الذخيرة: {current} / {reserve}' },
  });
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Ammo', 'Ammo'), { current: 24, reserve: 90 }), '24 / 90 rounds');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Wave', 'Wave')), 'Wave {wave}', 'unfilled arguments stay literal');
  localization.setCulture('ar-AE');
  assert.deepEqual(localization.cultureChain(), ['ar-AE', 'ar', 'en'], 'exact culture, its parent, then the fallback');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Ammo', 'Ammo'), { current: 7, reserve: 21 }), 'الذخيرة: 7 / 21');
  assert.equal(localization.isRightToLeft, true);
  localization.setCulture('de');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Ammo', 'Ammo'), { current: 1, reserve: 2 }), '1 / 2', 'unknown culture falls back to the fallback culture');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Unknown', 'Source text')), 'Source text');
  assert.equal(localization.missingReport().length, 1);
  assert.match(localization.formatReport(), /untranslated|missing/);
});

test('Localization: plurals follow each culture, selects and formatting work', () => {
  const localization = createLocalization({ culture: 'en' });
  localization.addTable('HUD', {
    en: { Kills: '{count, plural, one {# kill} other {# kills}}' },
    ar: { Kills: '{count, plural, zero {لا قتلى} one {قتيل واحد} two {قتيلان} few {# قتلى} many {# قتيلاً}}' },
    ru: { Kills: '{count, plural, one {# убийство} few {# убийства} many {# убийств}}' },
  });
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Kills', 'kills'), { count: 1 }), '1 kill');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Kills', 'kills'), { count: 5 }), '5 kills');
  localization.setCulture('ar');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Kills', 'kills'), { count: 0 }), 'لا قتلى');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Kills', 'kills'), { count: 2 }), 'قتيلان');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Kills', 'kills'), { count: 3 }), '3 قتلى');
  localization.setCulture('ru');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Kills', 'kills'), { count: 21 }), '21 убийство');
  assert.equal(localization.resolve(LOCTEXT('HUD', 'Kills', 'kills'), { count: 22 }), '22 убийства');

  assert.equal(formatText('{gender, select, male {he} other {they}} scored', { gender: 'female' }), 'they scored');
  assert.equal(formatText('{n, plural, other {{name} has # kills}}', { n: 3, name: 'Raven' }, localization), 'Raven has 3 kills');
  localization.setCulture('en-GB');
  assert.match(localization.formatNumber(1234567.5), /1,234,567/);
  assert.match(localization.formatList(['a', 'b']), /and/);
  assert.equal(localization.format('{a}-{b}', { a: 1, b: 2 }), '1-2');
});

test('Localization: tables load from JSON, CSV and the asset registry; overrides win', async () => {
  const localization = createLocalization({ culture: 'en' });
  localization.loadTableFromText('Weapons', 'key,culture,text\nRifle,en,Assault Rifle\nRifle,fr,Fusil d\'assaut\n');
  assert.equal(localization.resolve(LOCTEXT('Weapons', 'Rifle', 'Rifle')), 'Assault Rifle');
  localization.setCulture('fr');
  assert.equal(localization.resolve(LOCTEXT('Weapons', 'Rifle', 'Rifle')), 'Fusil d\'assaut');
  localization.loadTableFromText('Menus', JSON.stringify({ cultures: { fr: { Play: 'Jouer' } } }));
  assert.equal(localization.resolve(LOCTEXT('Menus', 'Play', 'Play')), 'Jouer');
  assert.equal(parseTablePayload('key,culture,text\nA,en,Alpha').cultures.en.A, 'Alpha');

  localization.setOverride('Menus', 'Play', 'Lancer');
  assert.equal(localization.resolve(LOCTEXT('Menus', 'Play', 'Play')), 'Lancer');
  localization.setOverride('Menus', 'Play', null);
  assert.equal(localization.resolve(LOCTEXT('Menus', 'Play', 'Play')), 'Jouer');
  assert.equal(localization.resolve(new LocalizedText({ namespace: 'X', key: 'y', source: '{raw}', cultureInvariant: true })), '{raw}');

  const registry = new AssetRegistry({ io: async () => new ArrayBuffer(0) });
  registry.registerType({ name: 'loc', extensions: ['.loc'], loader: async () => new TextEncoder().encode(JSON.stringify({ cultures: { en: { ready: 'Ready up' } } })).buffer });
  registry.register('/Game/Localization/Lobby.loc', { size: 64 });
  const viaAssets = createLocalization({ assetRegistry: registry, culture: 'en' });
  await viaAssets.loadTable('Lobby');
  assert.equal(viaAssets.resolve(LOCTEXT('Lobby', 'ready', 'Ready')), 'Ready up');
  assert.equal(viaAssets.getTable('Lobby').loadedFrom, '/Game/Localization/Lobby.loc');
});

// ---------------------------------------------------------------------- input mapping

test('InputMapping: keyboard and gamepad resolve to the same 2D action', () => {
  const { actions, context } = createShooterContext();
  const input = new InputMappingSystem();
  for (const action of Object.values(actions)) input.addAction(action);
  input.addContext(context);

  input.setKeys({ [Keys.W]: 1, [Keys.D]: 1 });
  input.evaluate(DT);
  assert.deepEqual(input.getActionVector('Move'), { x: 1, y: 1, z: 0 });
  input.setKeys({ [Keys.W]: 0, [Keys.D]: 0, [Keys.S]: 1, [Keys.A]: 1 });
  input.evaluate(DT);
  assert.deepEqual(input.getActionVector('Move'), { x: -1, y: -1, z: 0 });

  // Mouse deltas are transient: consumed by the evaluation that sees them.
  input.setKeyValue(Keys.MouseX, 12);
  assert.equal(input.getActionVector('Look').x, 0);
  input.evaluate(DT);
  assert.equal(input.getActionVector('Look').x, 12);
  input.evaluate(DT);
  assert.equal(input.getActionVector('Look').x, 0);
  input.setKeyValue('Key.Tilde', 1);
  input.evaluate(DT);
  assert.deepEqual(input.describe().unmappedKeys, ['Key.Tilde'], 'a key that no context maps is reported');
  input.setKeyValue('Key.Tilde', 0);
  input.evaluate(DT);
  assert.deepEqual(input.describe().unmappedKeys, []);
});

test('InputMapping: dead zone suppresses drift, modifiers scale, contexts take priority', () => {
  const input = new InputMappingSystem();
  const move = input.addAction('Move', { valueType: InputValueType.Axis2D });
  const pad = new InputMappingContext('Pad', { priority: 0 });
  pad.map(move, Keys.Gamepad_LeftX, { axes: ['x'], modifiers: [Modifiers.DeadZone({ lower: 0.25 }), Modifiers.Scale({ factor: 2, axes: ['x'] })] });
  input.addContext(pad);
  input.setKeyValue(Keys.Gamepad_LeftX, 0.2);
  input.evaluate(DT);
  assert.equal(input.getActionVector('Move').x, 0, 'inside the dead zone the input is rejected entirely');
  input.setKeyValue(Keys.Gamepad_LeftX, 1);
  input.evaluate(DT);
  assert.equal(input.getActionVector('Move').x, 2, 'modifiers compose in order');

  const menu = new InputMappingContext('Menu', { priority: 10 });
  const open = menu.map(input.addAction('OpenMenu'), Keys.Escape, { triggers: [Triggers.Pressed()] });
  assert.ok(open);
  input.addContext(menu);
  assert.deepEqual(input.contextNames(), ['Menu', 'Pad']);
  input.setKeyValue(Keys.Escape, 1);
  input.evaluate(DT);
  assert.equal(input.wasTriggered('OpenMenu'), true);
  input.removeContext(menu);
  assert.equal(input.hasContext(menu), false);
});

test('InputMapping: triggers fire when they should and only as often as they should', () => {
  const input = new InputMappingSystem();
  const fired = {};
  const watch = (name, key, triggers) => {
    const action = input.addAction(name);
    const context = new InputMappingContext(name);
    context.map(action, key, { triggers });
    input.addContext(context);
    return action;
  };
  watch('Jump', Keys.SpaceBar, [Triggers.Pressed()]);
  watch('Fire', Keys.MouseLeft, [Triggers.Down()]);
  watch('Melee', Keys.V, [Triggers.Tap({ seconds: 0.2 })]);
  watch('Grenade', Keys.G, [Triggers.Hold({ seconds: 0.3 })]);

  const counts = { Jump: 0, Fire: 0, Melee: 0, Grenade: 0 };
  // Counted through the per-frame trigger flag: deterministic and frame-exact.
  const step = (frames, key, value) => {
    input.setKeyValue(key, value);
    for (let i = 0; i < frames; i++) {
      input.evaluate(DT);
      for (const name of Object.keys(counts)) if (input.wasTriggered(name)) counts[name]++;
    }
  };
  step(5, Keys.SpaceBar, 1);
  assert.equal(counts.Jump, 1, 'Pressed fires once per press');
  step(1, Keys.SpaceBar, 0);
  step(1, Keys.SpaceBar, 1);
  assert.equal(counts.Jump, 2, 'and re-arms after release');
  step(1, Keys.SpaceBar, 0);

  step(4, Keys.MouseLeft, 1);
  assert.equal(counts.Fire, 4, 'Down fires every frame while held');
  step(1, Keys.MouseLeft, 0);

  input.setKeyValue(Keys.V, 1);
  input.evaluate(DT);
  step(1, Keys.V, 0);
  assert.equal(counts.Melee, 1, 'a short press is a tap');
  step(30, Keys.V, 1);
  step(1, Keys.V, 0);
  assert.equal(counts.Melee, 1, 'a long press is not a tap');

  step(30, Keys.G, 1);
  assert.equal(counts.Grenade, 1, 'Hold fires once, not once per frame past the threshold');
  step(1, Keys.G, 0);
  step(30, Keys.G, 1);
  assert.equal(counts.Grenade, 2, 'and re-arms after release');
});

test('InputMapping: rebinding, export/import, blocking and snapshots', () => {
  const { actions, context } = createShooterContext();
  const input = new InputMappingSystem();
  for (const action of Object.values(actions)) input.addAction(action);
  input.addContext(context);

  assert.equal(context.rebindAction('Jump', [Keys.X]), 1);
  input.setKeyValue(Keys.X, 1);
  input.evaluate(DT);
  assert.equal(input.isActionActive('Jump'), true);
  input.setKeyValue(Keys.X, 0);
  input.setKeyValue(Keys.SpaceBar, 1);
  input.evaluate(DT);
  assert.equal(input.isActionActive('Jump'), false, 'the old key no longer maps');

  const exported = input.exportBindings('Player');
  assert.equal(exported[0].bindings.length, context.bindings.length);
  const reloaded = new InputMappingSystem();
  for (const action of Object.values(actions)) reloaded.addAction(action);
  const reloadContext = new InputMappingContext('Player');
  reloaded.addContext(reloadContext);
  assert.equal(reloaded.applyBindings('Player', exported[0].bindings), context.bindings.length);
  assert.equal(reloadContext.bindings.find((binding) => binding.actionName === 'Jump').key, 'X');

  input.setBlocked(true);
  input.setKeyValue(Keys.MouseLeft, 1);
  input.evaluate(DT);
  assert.equal(input.isActionActive('Fire'), false, 'blocked input is suppressed without unmapping');
  input.setBlocked(false);
  input.setKeyValue(Keys.MouseLeft, 0);
  input.evaluate(DT);

  input.setKeys({ [Keys.W]: 1, [Keys.MouseLeft]: 1 });
  input.evaluate(DT);
  const snapshot = input.snapshot();
  assert.equal(typeof snapshot.Move.y, 'number');
  assert.equal(input.encodeBits(['Move', 'Fire']) > 0, true);
  assert.match(input.format(), /contexts/);
  assert.ok(input.describe().actions.length >= 10);
});

// ---------------------------------------------------------------------- archive

test('Archive: multi-section binary round-trip, lazy reads, resolvers and describe', () => {
  defineStruct('Transform', { position: 'vec3', rotation: 'quat', scale: 'vec3' });
  defineStruct('ActorRecord', {
    name: 'string', team: 'u8', health: 'f32', alive: 'bool', position: 'vec3',
    transform: 'struct:Transform', inventory: 'array:string', scores: 'map:string:f32', skin: 'object',
  });
  const value = {
    name: 'RedBot', team: 1, health: 87.5, alive: true, position: { x: 1.5, y: 0.2, z: -3.25 },
    transform: { position: { x: 1.5, y: 0.2, z: -3.25 }, rotation: { x: 0, y: 0.707, z: 0, w: 0.707 }, scale: { x: 1, y: 1, z: 1 } },
    inventory: ['rifle', 'pistol'], scores: new Map([['kills', 12]]), skin: { id: 42 },
  };
  const writer = new ArchiveWriter({ kind: PayloadKind.Save, version: 4 });
  writer.section('player', 'ActorRecord', value);
  writer.section('bot', 'ActorRecord', { ...value, name: 'BlueBot', health: 100 });
  const bytes = writer.finish();
  assert.ok(bytes instanceof Uint8Array);

  const reader = new ArchiveReader(bytes);
  assert.equal(reader.kind, PayloadKind.Save);
  assert.equal(reader.version, 4);
  assert.deepEqual(reader.list().sort(), ['bot', 'player']);
  const player = reader.read('player');
  assert.equal(player.name, 'RedBot');
  assert.equal(player.health, 87.5);
  assert.equal(player.alive, true);
  assert.equal(Math.round(player.transform.rotation.y * 1000) / 1000, 0.707);
  assert.deepEqual(player.inventory, ['rifle', 'pistol']);
  assert.equal(player.scores.get('kills'), 12);
  assert.equal(reader.read('bot').name, 'BlueBot');
  assert.equal(reader.readAll('ActorRecord').length, 2);
  assert.equal(reader.read('missing'), null);

  const withResolver = new ArchiveReader(bytes);
  assert.deepEqual(withResolver.read('player', { resolver: (id) => ({ id, name: 'by-id' }) }).skin, { id: 42, name: 'by-id' });

  const describe = reader.describe();
  assert.equal(describe.sections.length, 2);
  assert.equal(describe.sections[0].name, 'player');
  assert.ok(describe.sections[0].bytes > 0);
  assert.equal(reader.list().includes('player'), true);
});

test('Archive: JSON format, inferred sections, migrations and forward compatibility', () => {
  defineStruct('LegacySave', { coins: 'u32' });
  const writer = new ArchiveWriter({ format: 'json', kind: PayloadKind.Project, version: 2 });
  writer.section('settings', 'LegacySave', { coins: 5 });
  const json = writer.finish();
  assert.equal(typeof json, 'string');
  const read = new ArchiveReader(json);
  assert.equal(read.format, 'json');
  assert.equal(read.read('settings').coins, 5);

  const inferred = new ArchiveWriter({});
  inferred.sectionInferred('input', { sensitivity: 0.0026, fov: 90, name: 'default', inverted: false });
  const inferredRead = new ArchiveReader(inferred.finish()).read('input');
  assert.equal(Math.round(inferredRead.fov), 90);
  assert.equal(inferredRead.name, 'default');

  // Migration: a v1 payload read by a v2 schema runs every migration between the two versions.
  const legacyWriter = new ArchiveWriter({});
  legacyWriter.section('save', 'LegacySave', { coins: 5 });
  const legacyBytes = legacyWriter.finish();
  defineStruct('LegacySave', { coins: 'u32', bonus: 'u32' }, { version: 2 });
  migrateStruct('LegacySave', 1, (data) => ({ ...data, coins: (data.coins ?? 0) + 100, migrated: true }));
  const migrated = new ArchiveReader(legacyBytes).read('save');
  assert.equal(migrated.coins, 105);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.bonus, null, 'a field the migration never set reads as null rather than disappearing');

  // Forward compatibility: a section whose struct this build does not know stays skipped.
  defineStruct('FutureStruct', { a: 'f32' });
  const forward = new ArchiveWriter({});
  forward.section('known', 'LegacySave', { coins: 1, bonus: 0 });
  forward.section('future', 'FutureStruct', { a: 9 });
  const forwardReader = new ArchiveReader(forward.finish());
  assert.equal(forwardReader.has('future'), true);
  assert.deepEqual(forwardReader.read('known'), { coins: 1, bonus: 0 });
  assert.equal(forwardReader.read('future').a, 9);

  const roundTrip = decodeStruct('LegacySave', encodeStruct('LegacySave', { coins: 9, bonus: 2 }));
  assert.deepEqual(roundTrip, { coins: 9, bonus: 2 });
});

// ---------------------------------------------------------------------- plugins

test('Plugin: dependency order, target gating, contributions and teardown', async () => {
  const engine = await createEngine({ name: 'PluginHost', target: PluginTarget.Client });
  const manager = new PluginManager({ engine });
  const log = [];
  manager.register({
    name: 'Weapons', version: '1.4.0', category: 'Gameplay',
    settings: { 'weapons.maxSpread': { default: 0.035, min: 0, max: 1, group: 'Weapons' } },
    commands: [{ name: 'weapons.give', args: [{ name: 'id' }], execute: (args) => `gave ${args.id}` }],
    contentManifest: [{ path: 'Textures/rifle.png', type: 'texture', size: 2048 }],
    load: async () => { log.push('weapons.load'); return { version: '1.4.0' }; },
    startup: async () => log.push('weapons.startup'),
    shutdown: () => log.push('weapons.shutdown'),
  });
  manager.register({
    name: 'Arena', version: '1.0.0', dependencies: [{ name: 'Weapons', version: '>=1.0.0' }],
    subsystems: [class ArenaSubsystem extends Subsystem { static TypeName = 'Arena'; onInitialize() { this.online = true; } }],
    load: async () => log.push('arena.load'),
  });
  manager.register({ name: 'ServerMetrics', target: PluginTarget.Server });
  manager.register({ name: 'Cheats', enabledByDefault: false });

  assert.deepEqual(manager.resolveOrder().map((plugin) => plugin.name), ['Weapons', 'Arena'], 'dependencies first');
  await manager.loadAll({ engine });
  assert.deepEqual(log.filter((entry) => entry.endsWith('.load')), ['weapons.load', 'arena.load'], 'dependencies load first');
  assert.equal(manager.get('Weapons').state, PluginState.Started);
  assert.equal(manager.get('ServerMetrics').state, PluginState.Registered, 'server-only plugin is not loaded on a client');
  assert.equal(manager.get('Cheats').state, PluginState.Disabled);
  assert.equal(engine.config.getNumber('weapons.maxSpread'), 0.035, 'plugin settings join the engine config');
  assert.equal(engine.console.exec('weapons.give rifle', { silent: true }).output, 'gave rifle');
  assert.equal(engine.assets.has('/Plugin/Weapons/Textures/rifle.png'), true, 'content mounts under the plugin root');
  assert.equal(engine.subsystems.get('Arena').online, true, 'plugin subsystems register with the collection');
  assert.deepEqual(manager.get('Weapons').exports, { version: '1.4.0' });

  await manager.shutdownAll();
  assert.ok(log.includes('weapons.shutdown'));
  await engine.shutdown();
});

test('Plugin: missing dependencies, cycles, failure propagation and policies are reported', async () => {
  const engine = await createEngine({ name: 'PluginErrors', target: PluginTarget.Client });
  const manager = new PluginManager({ engine });
  manager.register({ name: 'NeedsMissing', dependencies: ['NotInstalled'] });
  manager.register({ name: 'CycleA', dependencies: ['CycleB'] });
  manager.register({ name: 'CycleB', dependencies: ['CycleA'] });
  manager.register({ name: 'Broken', load: async () => { throw new Error('nope'); } });
  manager.register({ name: 'DependsOnBroken', dependencies: ['Broken'], load: () => {} });
  manager.resolveOrder();
  assert.ok(manager.errors.some((entry) => entry.includes('NotInstalled')));
  assert.ok(manager.errors.some((entry) => entry.includes('cycle')));
  await manager.loadAll({ engine });
  assert.equal(manager.get('Broken').state, PluginState.Failed);
  assert.equal(manager.get('DependsOnBroken').state, PluginState.Failed, 'a dependent never runs on a broken dependency');
  assert.ok(manager.errors.some((entry) => entry.includes('Broken')));

  // Version gates: a requirement the installed plugin cannot satisfy refuses to enable.
  const gated = new PluginManager({ engine });
  gated.register({ name: 'Lib', version: '1.4.2' });
  gated.register({ name: 'NeedsNewer', version: '1.0.0', enabledByDefault: false, dependencies: [{ name: 'Lib', version: '>=2.0.0' }] });
  assert.equal(gated.enable('NeedsNewer'), false);
  assert.ok(gated.errors.at(-1).includes('requires Lib'));

  // Disabling cascades to dependents by default and refuses under the strict policy.
  const cascade = new PluginManager({ engine });
  cascade.register({ name: 'Base' });
  cascade.register({ name: 'Child', dependencies: ['Base'] });
  await cascade.loadAll({ engine });
  assert.equal(cascade.disable('Base'), true);
  assert.equal(cascade.get('Child').state, PluginState.Disabled);
  assert.ok(cascade.warnings.some((entry) => entry.includes('Child')));

  const strict = new PluginManager({ engine, policy: 'refuse' });
  strict.register({ name: 'Base' });
  strict.register({ name: 'Child', dependencies: ['Base'] });
  await strict.loadAll({ engine });
  assert.equal(strict.disable('Base'), false);

  // A failed plugin can be retried explicitly, and only explicitly.
  let attempt = 0;
  const flaky = new PluginManager({ engine });
  flaky.register({ name: 'Flaky', load: async () => { if (++attempt === 1) throw new Error('first'); } });
  await flaky.loadAll({ engine });
  assert.equal(flaky.get('Flaky').state, PluginState.Failed);
  await flaky.reload('Flaky');
  assert.equal(flaky.get('Flaky').state, PluginState.Started);

  assert.match(manager.format(), /plugins/);
  assert.ok(manager.describe().plugins.length === 5);
  await engine.shutdown();
});

// ---------------------------------------------------------------------- engine

test('Engine: lifecycle boots subsystems, modules, plugins and jobs in order', async () => {
  const order = [];
  class ConfigSubsystem extends Subsystem { static TypeName = 'Config'; onInitialize() { order.push('config'); } }
  class AssetsSubsystem extends Subsystem { static TypeName = 'Assets'; static Dependencies = ['config']; onInitialize() { order.push('assets'); } }
  class RenderSubsystem extends Subsystem { static TypeName = 'Renderer'; static Dependencies = ['assets']; onInitialize() { order.push('renderer'); } }

  const engine = new EngineCore('BootTest', { target: 'client' });
  engine.subsystems.register(RenderSubsystem).register(AssetsSubsystem).register(ConfigSubsystem);
  engine.console.registerCommand({ name: 'ping', execute: () => 'pong' });
  await engine.initialize({
    modules: [{ name: 'core', phase: ModulePhase.PreInit, target: 'both', load: () => order.push('module') }],
    plugins: [{ name: 'Extra', load: async () => order.push('plugin') }],
    manifest: [{ path: '/Game/Maps/Arena.map', size: 2048 }],
    registerTypes: [{ name: 'map', extensions: ['.map'], loader: async () => ({ spawns: 4 }) }],
    argv: '--engine.tickRate=120',
  });
  assert.equal(engine.phase, EnginePhase.Running);
  assert.equal(engine.tickRate, 120, 'command line overrides reach the live scheduler');
  assert.ok(order.includes('plugin'), 'plugins load before the boot pass');
  assert.deepEqual(order.filter((entry) => ['config', 'assets', 'renderer'].includes(entry)), ['config', 'assets', 'renderer']);
  assert.equal(engine.subsystems.count, 3);
  assert.equal(engine.modules.count, 1);
  assert.equal(engine.assets.count(), 1);
  assert.ok(engine.jobs.has('engine.collect'));
  await engine.shutdown();
});

test('Engine: fixed stepping, time scaling, pause and step', async () => {
  const engine = await createEngine({ name: 'TimeTest', tickRate: 60, target: 'client' });
  engine.fixedUpdateCount = 0;
  class Counter extends Subsystem { static TypeName = 'Counter'; onFixedUpdate() { engine.fixedUpdateCount++; } }
  engine.subsystems.register(Counter);

  const frame1 = engine.frame(1 / 60);
  assert.equal(frame1.subSteps, 1);
  const frame2 = engine.frame(1 / 20);
  assert.equal(frame2.subSteps, 3, 'a larger delta runs more fixed steps');
  assert.equal(engine.tickCount, 4);
  assert.equal(engine.fixedUpdateCount, 4, 'subsystems see every fixed step');
  assert.ok(Math.abs(engine.gameTime - 4 / 60) < 1e-9);

  engine.setTimeScale(0.5);
  const beforeTime = engine.gameTime;
  engine.runFixedFrames(120, 1 / 60);              // two wall seconds
  const advanced = engine.gameTime - beforeTime;
  assert.ok(Math.abs(advanced - 1) < 0.02, `the clock ran at half speed (${advanced.toFixed(3)}s in 2s wall)`);

  engine.setTimeScale(1);
  engine.pause();
  assert.equal(engine.phase, EnginePhase.Paused);
  const frozen = engine.gameTime;
  engine.frame(1 / 60);
  assert.equal(engine.gameTime, frozen, 'paused frames do not advance the clock');
  engine.step(2);
  engine.frame(1 / 60);
  assert.equal(engine.phase, EnginePhase.Paused, 'stepping does not resume the engine');
  assert.ok(engine.gameTime > frozen, 'stepping advances exactly the requested step');
  assert.ok(Math.abs(engine.gameTime - (frozen + 1 / 60)) < 1e-9, 'one requested step, not the whole accumulator');
  engine.resume();
  assert.equal(engine.phase, EnginePhase.Running);

  // Delta clamping: a huge frame (tab restore, breakpoint) must not teleport the simulation.
  engine.frame(9);
  assert.ok(engine.deltaTime <= engine.maxDeltaTime);
  assert.ok(engine.subStepsLastFrame <= engine.scheduler.maxSubSteps);
  await engine.shutdown();
});

test('Engine: scheduler tasks, jobs, collection cadence and asset streaming', async () => {
  const engine = await createEngine({ name: 'TaskTest', tickRate: 60, target: 'client' });
  let deferred = false;
  let delayed = false;
  let jobRuns = 0;
  engine.defer(() => { deferred = true; });
  engine.delay(0.05, () => { delayed = true; });
  engine.jobs.add({ name: 'gameplay.sim', group: 'simulation', run: () => { jobRuns++; } });
  engine.assets.register('/Game/Maps/Arena.map', { size: 2048 });
  engine.assets.registerType({ name: 'map', extensions: ['.map'], loader: async () => ({ spawns: 4 }) });
  engine.assets.bundle('arena').add('/Game/Maps/Arena.map');

  engine.frame(1 / 60);
  assert.equal(deferred, true, 'deferred calls run inside the frame');
  engine.runFixedFrames(10, 1 / 60);
  assert.equal(delayed, true, 'delayed calls run once their game time arrives');
  assert.ok(jobRuns >= 11, 'registered jobs run every frame');
  assert.ok(engine.lastFrameRecord().jobs.jobs['gameplay.sim'] !== undefined);

  engine.requestBundle('arena');
  for (let i = 0; i < 3; i++) engine.frame(1 / 60);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(engine.assets.isLoaded('/Game/Maps/Arena.map'), true, 'requested bundles stream in during frames');

  // Garbage collection runs on its cadence and destroys unreferenced objects.
  engine.gcIntervalFrames = 2;
  engine._nextGcFrame = 0;
  const leaked = new EngineObject('Leaked');
  engine.collector.markPendingKill(leaked);
  engine.frame(1 / 60);
  assert.equal(leaked.isDestroyed, true, 'the collection job runs on the configured cadence');
  await engine.shutdown();
});

test('Engine: input mappings evaluate before simulation; describe/format/serialize work', async () => {
  const engine = await createEngine({ name: 'ReportTest', tickRate: 60, target: 'client', culture: 'ar' });
  const input = engine.createInputMapping({ name: 'P1' });
  const { actions, context } = createShooterContext();
  for (const action of Object.values(actions)) input.addAction(action);
  input.addContext(context);
  input.setKeyValue(Keys.W, 1);
  engine.frame(1 / 60);
  assert.equal(input.getActionVector('Move').y, 1, 'the engine evaluates input each frame');
  assert.equal(engine.input, input);

  const described = engine.describe();
  assert.equal(described.phase, EnginePhase.Running);
  assert.equal(described.frame, 1);
  assert.ok(described.jobs.jobs.length >= 1);
  assert.equal(described.localization.culture, 'ar');
  assert.ok(described.console.commands >= 5);
  assert.ok(described.assets.registered >= 0);
  assert.ok(described.subsystems.count >= 0);
  assert.equal(described.objects.classes, getClassCount());

  const formatted = engine.format();
  assert.match(formatted, /OminX/);
  assert.match(formatted, /subsystems/);
  assert.match(formatted, /culture ar/);
  assert.match(engine.console.exec('engine', { silent: true }).output, /OminX/);

  const saved = engine.serialize();
  assert.equal(typeof saved.time, 'number');
  const restored = await createEngine({ name: 'RestoreTest', target: 'client' });
  restored.deserialize(saved);
  assert.ok(restored.gameTime >= saved.time - 1e-6);
  assert.equal(currentEngine() === restored, true);
  assert.equal(requireEngine(), restored);
  await restored.shutdown();
  assert.throws(() => requireEngine(), /no engine instance/);
  await engine.shutdown();
});

test('Engine: shutdown tears everything down and can be restarted', async () => {
  let deinitialized = 0;
  const engine = new EngineCore('RestartTest', { target: 'client' });
  engine.subsystems.register(class Temp extends Subsystem { static TypeName = 'Temp'; onDeinitialize() { deinitialized++; } });
  await engine.initialize({});
  assert.equal(engine.subsystems.get('Temp').isReady, true);
  await engine.shutdown();
  assert.equal(engine.phase, EnginePhase.Shutdown);
  assert.equal(deinitialized, 1);
  assert.equal(currentEngine(), null);
  engine.assets.register('/Game/Maps/Arena.map', { size: 10 });
  await engine.restart({});
  assert.equal(engine.phase, EnginePhase.Running);
  assert.equal(engine.subsystems.get('Temp').isReady, true, 'restart brings subsystems back up');
  await engine.shutdown();
});

test('Core manifest describes every module in the barrel', () => {
  assert.match(CORE_VERSION, /^\d+\.\d+\.\d+$/);
  const modules = coreModuleList();
  assert.ok(modules.length >= 32);
  for (const name of ['Schema', 'Diagnostics', 'DataRegistry', 'Replication', 'World']) {
    assert.ok(CORE_MODULES[name], `the barrel manifest knows about ${name}`);
  }
  for (const module of modules) {
    assert.ok(typeof module.summary === 'string' && module.summary.length > 10, `${module.name} needs a summary`);
    assert.ok(module.layer >= 1 && module.layer <= 5, `${module.name} needs a layer`);
  }
  assert.deepEqual(modules.map((module) => module.layer), [...modules.map((module) => module.layer)].sort((a, b) => a - b), 'sorted by layer');
  assert.ok(getClassInfo(EngineCore).isChildOf(getClassInfo(EngineObject)));
});

// ---------------------------------------------------------------------- tracing

test('Trace: scopes, instants and counters record only what the filter allows', () => {
  const stats = new Stats();
  const trace = new Trace({ enabled: true, capacity: 4096, stats });
  const scope = trace.begin('PlayerThink', 'ai', { bot: 'RedBot' });
  const busyUntil = performance.now() + 1;
  while (performance.now() < busyUntil);
  const elapsed = scope.end();
  assert.ok(elapsed >= 0.5, `the scope measured real time (${elapsed} ms)`);
  assert.equal(scope.end(), 0, 'ending twice does not double count');

  assert.equal(trace.scope('PhysicsStep', 'physics', () => 42), 42, 'scope() returns the callback value');
  assert.throws(() => trace.scope('Boom', 'physics', () => { throw new Error('x'); }), /x/);
  assert.ok(trace.top(20).some((row) => row.name === 'Boom'), 'a throwing scope is still recorded');
  assert.ok(trace.top(20).some((row) => row.name === 'PlayerThink' && row.calls === 1));

  // Disabled: nothing is allocated or recorded, and callbacks still run.
  trace.stop();
  const before = trace.eventCount;
  assert.equal(trace.scope('Ignored', 'physics', () => 'ran'), 'ran');
  assert.equal(trace.eventCount, before);
  assert.equal(trace.accepts('physics'), false);
  trace.start();

  // Category filter is what makes tracing cheap enough to leave in a build.
  trace.setCategories(['render']);
  trace.scope('DrawScene', 'render', () => {});
  trace.scope('StepWorld', 'physics', () => {});
  const names = trace.top(10).map((row) => row.name);
  assert.ok(names.includes('DrawScene'));
  assert.equal(names.includes('StepWorld'), false, 'filtered categories record nothing');
  trace.setCategories(null);

  trace.instant('ShotFired', 'combat', { weapon: 'rifle' });
  assert.equal(trace.events({ category: 'combat' }).length, 1);
  trace.counter('Bots/Alive', 7);
  trace.counter('Bots/Alive', 9);
  assert.equal(trace.getCounter('Bots/Alive'), 9, 'counters keep the latest value for the HUD');
  assert.ok(stats.get('Trace/ai'), 'recorded scopes feed the stats system');
});

test('Trace: frames, threads, nesting and export feed the profiler', () => {
  const trace = new Trace({ enabled: true, capacity: 8192 });
  trace.beginFrame(1);
  trace.scope('Frame/Work', 'frame', () => {});
  const frameMs = trace.endFrame();
  assert.ok(frameMs >= 0);
  trace.beginFrame(2);
  trace.endFrame();
  assert.deepEqual(trace.frameTimes().map((row) => row.frame), [1, 2]);

  const worker = trace.withThread(4, 'worker-0');
  worker.scope('ChunkBuild', 'streaming', () => {});
  assert.equal(trace.threads.get(4), 'worker-0');
  assert.ok(trace.events({ name: 'ChunkBuild' })[0].thread === 4, 'events carry the thread they came from');

  const parent = trace.begin('LoadMap', 'streaming');
  const child = parent.child('ParseGeometry');
  const spin = performance.now() + 1;
  while (performance.now() < spin);
  child.end();
  parent.end();
  const loadRow = trace.top(30).find((row) => row.name === 'LoadMap');
  assert.equal(loadRow.calls, 1);

  // Bounded memory: the ring drops the oldest events and says so.
  const small = new Trace({ enabled: true, capacity: 1024 });
  let overflowReports = 0;
  traceEvents.onOverflow.add(() => overflowReports++);
  for (let i = 0; i < 3000; i++) small.instant('Spam', 'noise');
  assert.equal(small.buffer.length, 1024, 'the ring never grows past its capacity');
  // The metadata event written at start-up also occupies a slot, so the invariant is the relation,
  // not a hard-coded number.
  assert.equal(small.dropped, small.eventCount - small.buffer.length, 'every event past the ring capacity is counted');
  assert.ok(small.dropped >= 3000 - 1024);
  assert.ok(overflowReports > 0, 'overflow is reported rather than silent');

  const chrome = trace.exportChrome();
  assert.equal(chrome.displayTimeUnit, 'ms');
  assert.ok(chrome.traceEvents.some((event) => event.ph === 'M'), 'thread metadata is emitted');
  const complete = chrome.traceEvents.find((event) => event.ph === 'X');
  assert.ok(complete.dur >= 0 && typeof complete.ts === 'number' && complete.pid === 1);
  assert.ok(trace.exportJson().length > 100);

  assert.ok(trace.categorySummary().length >= 2);
  assert.match(trace.format({ limit: 3 }), /trace ON/);
  assert.ok(Object.keys(trace.describe()).length >= 8);
  assert.equal(trace.describe().filter, null, 'describe() reports the filter separately from the summary');

  trace.reset();
  assert.equal(trace.eventCount, 0);
  assert.equal(trace.buffer.length, 0);
  assert.equal(trace.enabled, true, 'reset keeps recording by default');
});

test('Trace: console commands and job/engine integration', async () => {
  const console_ = new Console();
  const trace = new Trace({ enabled: false });
  trace.installConsoleCommands(console_);
  assert.match(console_.exec('trace.start physics,ai', { silent: true }).output, /tracing on/);
  assert.deepEqual(trace.describe().filter, ['physics', 'ai']);
  trace.scope('StepWorld', 'physics', () => {});
  assert.match(console_.exec('trace', { silent: true }).output, /StepWorld/);
  assert.ok(console_.exec('trace.top total 5', { silent: true }).ok);
  assert.ok(console_.exec('trace.categories', { silent: true }).ok);
  assert.ok(console_.exec('trace.export', { silent: true }).output.includes('traceEvents'));
  console_.exec('trace.reset', { silent: true });
  assert.equal(trace.eventCount, 0);
  assert.match(console_.exec('trace.stop', { silent: true }).output, /off/);

  // A traced job graph turns a frame into a profile.
  const jobs = new JobGraph({ trace: new Trace({ enabled: true, capacity: 2048 }) });
  jobs.add({ name: 'physics.sim', group: 'sim', run: () => {} });
  jobs.add({ name: 'ai.think', group: 'sim', dependsOn: ['physics.sim'], run: () => {} });
  await jobs.executeAsync({}, DT);
  assert.ok(jobs.trace.top(5).some((row) => row.name === 'physics.sim'));
  jobs.execute({}, DT);
  assert.ok(jobs.trace.top(5).some((row) => row.name === 'ai.think' && row.calls === 2), 'the synchronous frame path traces too');

  // The engine records frame markers and subsystem scopes.
  const engine = await createEngine({ name: 'TraceHost', tickRate: 60, target: 'client', tracing: true, traceCapacity: 4096 });
  engine.runFixedFrames(10, DT);
  assert.equal(engine.trace.frameMarkers.length, 10);
  const names = engine.trace.top(20).map((row) => row.name);
  assert.ok(names.includes('Subsystems/Update'));
  assert.ok(names.includes('Subsystems/FixedUpdate'));
  assert.ok(names.includes('engine.collect'), 'engine jobs are traced');
  assert.equal(engine.trace.getCounter('Frame/SubSteps') >= 0, true);
  assert.ok(engine.describe().trace.events > 0);
  await engine.shutdown();
});

// ---------------------------------------------------------------------- timers

test('Timers: one-shot, looping, first delay and rate all follow the engine clock', () => {
  const timers = new TimerManager();
  let reloads = 0;
  const reload = timers.setTimer('Reload', () => reloads++, { time: 1.5 });
  assert.equal(timers.isActive(reload), true);
  assert.equal(timers.getRemaining(reload), 1.5);
  assert.equal(timers.getInterval(reload), 1.5);
  timers.advance(1);
  assert.equal(reloads, 0, 'not yet');
  assert.ok(Math.abs(timers.getRemaining(reload) - 0.5) < 1e-9);
  assert.ok(Math.abs(timers.getProgress(reload) - 2 / 3) < 1e-6);
  timers.advance(0.5);
  assert.equal(reloads, 1);
  assert.equal(timers.isActive(reload), false, 'a one-shot timer is no longer active');
  assert.equal(timers.getFiredCount(reload), 1, 'the handle still answers after it fired');
  assert.equal(reload.firedCount, 1);
  assert.ok(reload.lastFiredAt >= 1.5);
  timers.advance(10);
  assert.equal(reloads, 1, 'and never fires again');

  // Looping with a first delay: 1 s of silence, then every 0.25 s — measured at 60 Hz.
  let waves = 0;
  const wave = timers.setTimer('Wave', () => waves++, { time: 0.25, firstDelay: 1, looping: true });
  for (let i = 0; i < 59; i++) timers.advance(1 / 60);
  assert.equal(waves, 0, 'the first delay holds');
  for (let i = 0; i < 91; i++) timers.advance(1 / 60);      // to 2.5 s
  assert.equal(waves, 7, 'then one fire per 0.25 s (fires at 1.0, 1.25 … 2.5)');
  assert.ok(timers.getRemaining(wave) < 0.26, 'the loop keeps its phase instead of drifting');

  // Rate scales the wait (a perk, a replay at 4×).
  let bursts = 0;
  const burst = timers.setTimer('Burst', () => bursts++, { time: 1, rate: 4 });
  timers.advance(0.25);
  assert.equal(bursts, 1);
  assert.equal(timers.getRate(burst), 4);
  timers.setRate(burst, 1);
  assert.equal(timers.getRate(burst), 1);

  // One fire per advance, even for a huge delta: no burst storms.
  let spams = 0;
  const spam = timers.setTimer('Spam', () => spams++, { time: 0.1, looping: true });
  timers.advance(5);
  assert.equal(spams, 1);
  assert.ok(timers.isActive(spam));
  timers.clear(spam);
});

test('Timers: ownership, pausing, clearing and reporting', () => {
  const timers = new TimerManager();
  const weapon = { cooldowns: 0, onCooldown() { this.cooldowns++; } };
  const cooldown = timers.setTimer('Cooldown', weapon, { method: 'onCooldown', time: 1 });
  assert.equal(timers.handlersFor(weapon).length, 1, 'owner form registers the owner');
  timers.advance(1.01);
  assert.equal(weapon.cooldowns, 1);

  // Delegate callbacks are supported (the engine's own event type).
  const delegate = new Delegate('onLanded');
  let landed = 0;
  delegate.bind(() => { landed++; });
  timers.setTimer('Land', delegate, { time: 0.5 });
  timers.advance(0.6);
  assert.equal(landed, 1);

  // Pause is per timer and global.
  let pings = 0;
  const ping = timers.setTimer('Ping', () => pings++, { time: 1 });
  timers.pause(ping);
  timers.advance(5);
  assert.equal(pings, 0, 'a paused timer does not advance');
  assert.equal(timers.isPaused(ping), true);
  timers.togglePaused(ping);
  timers.advance(1.01);
  assert.equal(pings, 1);

  timers.every(0.1, () => pings++);
  timers.pause();
  const before = pings;
  timers.advance(1);
  assert.equal(pings, before, 'pausing the manager freezes every timer');
  timers.resume();
  timers.advance(0.5);
  assert.ok(pings > before);

  // Owner-scoped cleanup is what a destroyed weapon does.
  const gun = { name: 'gun' };
  timers.setTimer('GunA', gun, { method: 'name', time: 5 });
  timers.setTimer('GunB', gun, { method: 'name', time: 5 });
  timers.setTimer('Other', () => {}, { time: 5 });
  assert.equal(timers.handlersFor(gun).length, 2);
  assert.equal(timers.clearAllFor(gun), 2);
  assert.equal(timers.handlersFor(gun).length, 0);
  assert.ok(timers.activeNames().includes('Other'));

  const cleared = timers.clearMatching({ name: 'Other' });
  assert.equal(cleared, 1);
  assert.equal(timers.clearAll() >= 0, true);
  assert.equal(timers.count, 0);

  // Capacity guard, reset and setInterval.
  const tiny = new TimerManager({ maxTimers: 2 });
  tiny.after(1, () => {});
  tiny.after(1, () => {});
  tiny.after(1, () => {});
  assert.equal(tiny.count, 2, 'the capacity guard refuses extra timers instead of growing without bound');
  const resettable = timers.setTimer('Reset', () => {}, { time: 1, looping: true });
  timers.advance(0.6);
  timers.reset(resettable);
  assert.equal(timers.getRemaining(resettable), 1);
  timers.setInterval(resettable, 2);
  assert.equal(timers.getInterval(resettable), 2);

  // Events and stats.
  let setEvents = 0;
  let firedEvents = 0;
  let clearedEvents = 0;
  timerEvents.onTimerSet.add(() => setEvents++);
  timerEvents.onTimerFired.add(() => firedEvents++);
  timerEvents.onTimerCleared.add(() => clearedEvents++);
  const stats = new Stats();
  const counted = new TimerManager({ stats });
  const handle = counted.after(0.05, () => {});
  counted.advance(0.06);
  const looped = counted.every(1, () => {});
  counted.clear(looped);
  assert.equal(setEvents, 2);
  assert.equal(firedEvents, 1);
  assert.equal(clearedEvents, 1, 'clearing an active timer raises the cleared event');
  assert.equal(counted.clear(counted.after(1, () => {})), true);
  assert.equal(clearedEvents, 2);
  assert.equal(stats.getCounter('Timers/Set'), 3);
  assert.equal(stats.getCounter('Timers/Fired'), 1);
  assert.equal(handle.isValid, false, 'a fired one-shot is no longer valid');

  assert.match(timers.format(), /Timers:/);
  assert.ok(Object.keys(timers.describe()).includes('timers'));

  const console_ = new Console();
  timers.installConsoleCommands(console_);
  assert.ok(console_.exec('timers', { silent: true }).ok);
  assert.match(console_.exec('timer.clear', { silent: true }).output, /cleared \d+ timers/);
  assert.match(console_.exec('timers.scale 2', { silent: true }).output, /timer scale = 2/);
});

test('Timers: engine integration runs them on the fixed step and clears on shutdown', async () => {
  const engine = await createEngine({ name: 'TimerEngine', tickRate: 60, target: 'client' });
  let reloads = 0;
  const handle = engine.setTimer('Reload', () => reloads++, { time: 1.5 });
  const ticks = [];
  engine.every(0.25, () => ticks.push(engine.gameTime));

  engine.runFixedFrames(60, DT);
  assert.equal(reloads, 0);
  engine.runFixedFrames(40, DT);            // 1.667 s total
  assert.equal(reloads, 1, 'the timer fired on the engine clock');
  assert.equal(ticks.length, 6, 'a 0.25 s interval fires 6 times in 1.667 s');
  engine.runFixedFrames(20, DT);            // 2.0 s total
  assert.equal(ticks.length, 8);
  assert.equal(engine.timers.getFiredCount(handle), 1);

  engine.pause();
  const frozen = ticks.length;
  engine.runFixedFrames(30, DT);
  assert.equal(ticks.length, frozen, 'a paused engine does not advance timers');
  engine.resume();
  engine.runFixedFrames(30, DT);
  assert.ok(ticks.length > frozen);

  assert.deepEqual(Object.keys(engine.describe().timers), ['active', 'fired']);
  assert.ok(engine.console.exec('timers', { silent: true }).ok);
  engine.nextTick(() => ticks.push('next tick'));
  engine.frame(DT);
  assert.ok(ticks.includes('next tick'));

  await engine.shutdown();
  assert.equal(engine.timers.count, 0, 'shutdown clears pending timers');
});

// ---------------------------------------------------------------------- memory

test('Memory: the frame arena allocates without garbage, survives growth and resets', () => {
  const memoryEventsLocal = [];
  const arena = new FrameArena({ bytes: 256, name: 'Scratch' });
  const f32 = arena.allocFloat32(4);
  f32.set([1, 2, 3, 4]);
  assert.equal(arena.usedBytes, 16);
  assert.equal(arena.allocations, 1);
  const f64 = arena.allocFloat64(2);
  const i32 = arena.allocInt32(1);
  const bytes = arena.allocUint8(3);
  assert.ok(f64.length === 2 && i32.length === 1 && bytes.length === 3);
  assert.equal(arena.usedBytes, 16 + 16 + 4 + 3);
  assert.ok(arena.utilisation > 0);

  // The arena hands out views onto one buffer: growth must preserve what is live.
  const before = arena.capacity;
  const big = arena.allocFloat64(100);
  assert.equal(big.length, 100);
  assert.ok(arena.capacity > before, 'the arena grew');
  assert.equal(arena.growths, 1);
  assert.equal(f32[1], 2, 'existing views still read their data after a grow');

  // Mark/release lets a caller own its own temporary lifetime.
  const mark = arena.mark();
  arena.allocFloat32(64);
  assert.ok(arena.usedBytes > mark);
  arena.release(mark);
  assert.equal(arena.usedBytes, mark);

  const peak = arena.peakHighWater;
  arena.reset();
  assert.equal(arena.usedBytes, 0);
  assert.equal(arena.resets, 1);
  assert.equal(arena.peakHighWater, peak, 'the peak survives a reset (it is a high-water mark)');
  void memoryEventsLocal;

  // A non-growing arena refuses instead of throwing, and says so.
  const fixed = new FrameArena({ bytes: 64, grow: false });
  assert.ok(fixed.reserve(32) >= 0);
  assert.equal(fixed.reserve(64), -1);
  assert.equal(fixed.refused, 1);
  assert.match(fixed.format(), /FrameArena|Scratch/);

  // Struct allocation: field offsets, typed reads and writes.
  const arena2 = new FrameArena({ bytes: 512 });
  const particles = arena2.allocStruct(100, [{ name: 'x', type: 'f32' }, { name: 'y', type: 'f32' }, { name: 'age', type: 'f64' }]);
  assert.equal(particles.stride, 16);
  particles.set(7, 'x', 1.25);
  particles.set(7, 'age', 3.5);
  assert.equal(particles.get(7, 'x'), 1.25);
  assert.equal(particles.get(7, 'age'), 3.5);
  assert.equal(particles.get(0, 'missing'), undefined);
  assert.equal(particles.set(0, 'missing', 1), false);

  const stats = new Stats();
  const memory = new Memory({ arenaBytes: 1024, name: 'Mem' });
  void stats;
  memory.frameArena.allocUint8(16);
  memory.beginFrame(1);
  assert.equal(memory.frameArena.usedBytes, 0, 'beginFrame resets the arena');
  memory.track('scratch', 128);
  assert.equal(memory.endFrame(), 128);
  assert.equal(memory.describe().tracker.growthLastFrame, 128);
});

test('Memory: buffer pools reuse typed views and report churn and leaks', () => {
  const pool = new BufferPool({ minBytes: 64, maxPerClass: 2, clearOnAcquire: false });
  const first = pool.acquireF32(10);
  const second = pool.acquireF32(10);
  assert.equal(pool.created, 2, 'each acquire with an empty pool creates one buffer');
  assert.equal(pool.acquire(300).byteLength, 512, 'a request maps to the next power-of-two class');

  // Releasing a view must return the buffer it aliases.
  assert.equal(pool.release(first), true);
  const createdBefore = pool.created;
  const reused = pool.acquireF32(10);
  assert.equal(reused.buffer, first.buffer, 'the released buffer is handed back out');
  assert.equal(pool.created, createdBefore, 'no new buffer was allocated');
  assert.equal(pool.release(reused), true);
  assert.equal(pool.release(reused), false, 'releasing the same buffer twice is refused');
  assert.equal(pool.release(second), true);

  const peak = pool.peakOutstanding;
  assert.ok(peak >= 3);
  assert.ok(pool.pooledBytes > 0);
  assert.equal(pool.outstanding.size, 1, 'the 512-byte buffer is still held');

  // Borrow-and-return for a callback; the buffer is always returned.
  const result = pool.with(128, (view) => { view.fill(9); return view.length; });
  assert.equal(result, 128);
  assert.equal(pool.outstanding.size, 1);

  pool.release(pool.outstanding.values().next().value);
  assert.equal(pool.outstanding.size, 0);
  assert.equal(pool.leaked().length, 0);

  // Prewarm: a level load should not allocate during play.
  const warmed = new BufferPool({ minBytes: 128 });
  warmed.prewarm({ 128: 2, 512: 1 });
  assert.equal(warmed.pooledBytes, 128 * 2 + 512);
  const prewarmed = warmed.acquire(300);
  assert.equal(prewarmed.byteLength, 512);
  assert.equal(warmed.created, 3);

  // Size classes cap what is kept; oversized requests are never pooled.
  const capped = new BufferPool({ minBytes: 64, maxPerClass: 1, maxBytes: 1024 });
  const buffers = [capped.acquire(64), capped.acquire(64)];
  capped.release(buffers[0]);
  capped.release(buffers[1]);
  assert.equal(capped.discarded, 1, 'the second buffer of a full class is discarded, not kept forever');
  const oversized = capped.acquire(4096);
  capped.release(oversized);
  assert.equal(capped.discarded, 2);

  assert.match(pool.format(), /BufferPool/);
  assert.ok(Object.keys(pool.describe()).includes('acquired'));

  const memory = new Memory({ name: 'Pools' });
  memory.createPool('audio', { minBytes: 256 });
  const view = memory.acquireF32(4, 'audio');
  assert.equal(memory.getPool('audio').outstanding.size, 1);
  memory.releaseView(view, 'audio');
  assert.equal(memory.getPool('audio').outstanding.size, 0);
  assert.equal(memory.getPool('nope'), null);
});

test('Memory: accounting, budgets, scopes and reports drive placement decisions', () => {
  const tracker = new MemoryTracker({ name: 'Accounting' });
  tracker.track('textures', 8 * 1024 * 1024, { count: 4 });
  tracker.track('audio', 512 * 1024, { count: 12 });
  assert.equal(tracker.totalBytes, 8 * 1024 * 1024 + 512 * 1024);
  assert.equal(tracker.totalAllocated, tracker.totalBytes);
  assert.equal(tracker.categories.get('textures').allocations, 4);
  assert.deepEqual(tracker.summary(2).map((row) => row.category), ['textures', 'audio']);

  tracker.untrack('textures', 8 * 1024 * 1024);
  assert.equal(tracker.categories.get('textures').bytes, 0, 'untracking frees the category');
  assert.equal(tracker.categories.get('textures').peak, 8 * 1024 * 1024, 'the peak is history, not current usage');
  assert.ok(tracker.totalFreed >= 8 * 1024 * 1024);

  // Budgets: exceeding one warns, records and fires an event; it does not throw in a frame.
  let exceeded = 0;
  memoryEvents.onBudgetExceeded.add(() => exceeded++);
  tracker.budget('audio', 256 * 1024);
  tracker.track('audio', 64 * 1024);
  assert.equal(exceeded, 1);
  assert.equal(tracker.warnings.length, 1);
  assert.ok(tracker.describe().warnings.length >= 1);
  assert.throws(() => tracker.assertBudget('audio', 256 * 1024), /budget for "audio"/);

  // Scopes are inclusive: a nested scope's bytes show up in the parent's delta.
  const outer = tracker.scope('LevelLoad');
  tracker.track('geometry', 1024);
  let inner = null;
  tracker.measure('Cook', (scope) => { inner = scope; tracker.track('cooked', 2048); });
  assert.equal(inner.bytes, 2048);
  assert.equal(outer.bytes, 3072);
  outer.close();
  assert.equal(outer.bytes, 3072, 'a closed scope keeps its number');
  assert.equal(inner.closed, true);
  assert.ok(tracker.closedScopes.some((row) => row.name === 'LevelLoad'));
  assert.equal(tracker.describe().scopes.length, 0);

  const usage = tracker.trackUsage('temporary', 4096);
  usage[Symbol.dispose]();
  assert.equal(tracker.categories.get('temporary').bytes, 0);

  // Frame accounting + heap sampling where the host exposes it.
  tracker.beginFrame(4);
  tracker.track('frame', 512);
  const growth = tracker.endFrame();
  assert.equal(growth, 512);
  assert.equal(tracker.growthLastFrame, 512);
  const heap = tracker.heapUsage();
  assert.equal(typeof heap.available, 'boolean');
  assert.ok(typeof tracker.leakCheck().stable === 'boolean');

  // Facade: one tracker, one arena, several pools.
  const memory = new Memory({ name: 'Facade', arenaBytes: 2048 });
  memory.track('meshes', 1024);
  assert.equal(memory.totalBytes, 1024);
  memory.budget('meshes', 512);
  memory.track('meshes', 1024);
  assert.equal(memory.tracker.warnings.length, 1);
  assert.match(memory.format(), /Facade/);
  assert.ok(Object.keys(memory.describe()).includes('arena'));

  const console_ = new Console();
  memory.installConsoleCommands(console_);
  assert.ok(console_.exec('mem', { silent: true }).ok);
  assert.ok(console_.exec('mem.arena', { silent: true }).ok);
  assert.ok(console_.exec('mem.pools', { silent: true }).ok);
  assert.match(console_.exec('mem.budget meshes 8', { silent: true }).output, /budget = 8 MB/);
  assert.ok(console_.exec('mem.snapshot', { silent: true }).ok);
  assert.ok(console_.exec('mem.leak 10', { silent: true }).ok);

  // Engine integration: the arena is reset once per frame and reported.
  const engine = createEngine({ name: 'MemoryEngine', target: 'client', frameArenaBytes: 8192, sampleHeap: false });
  return engine.then(async (running) => {
    running.runFixedFrames(4, DT);
    assert.ok(running.memory.frameArena.resets >= 4, 'the engine resets the frame arena every frame');
    assert.equal(running.frameArena, running.memory.frameArena);
    const scratch = running.frameArena.allocFloat32(8);
    assert.equal(scratch.length, 8);
    running.memory.track('engine-test', 4096);
    assert.ok(running.describe().memory.tracked >= 4096);
    assert.ok(running.console.exec('mem', { silent: true }).output.includes('engine-test'));
    await running.shutdown();
  });
});

// ---------------------------------------------------------------------- curves

test('Curves: interpolation modes, extrapolation, calculus and serialization', () => {
  const linear = new FloatCurve({ name: 'Linear', interp: CurveInterp.Linear });
  linear.addKeys([[0, 0], [10, 100]]);
  assert.equal(linear.evaluate(0), 0);
  assert.equal(linear.evaluate(5), 50);
  assert.equal(linear.evaluate(10), 100);
  assert.equal(linear.evaluate(20), 100, 'clamped past the last key by default');
  assert.equal(linear.evaluate(-5), 0);
  assert.deepEqual(linear.timeRange, [0, 10]);
  assert.equal(linear.duration, 10);
  assert.equal(linear.count, 2);

  const stepped = new FloatCurve({ interp: CurveInterp.Constant });
  stepped.addKeys([[0, 1], [1, 5], [2, 9]]);
  assert.equal(stepped.evaluate(0.99), 1);
  assert.equal(stepped.evaluate(1), 5);
  assert.equal(stepped.evaluate(1.99), 5);

  const cubic = new FloatCurve({ interp: CurveInterp.Cubic });
  cubic.addKey(0, 0, { leave: 0 }).addKey(1, 1, { arrive: 0 });
  assert.ok(Math.abs(cubic.evaluate(0.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(cubic.derivative(0)) < 0.15, 'a zero tangent means a soft start');
  assert.ok(cubic.derivative(0.5) > cubic.derivative(0.1), 'and accelerates through the middle');

  // Automatic tangents must not overshoot: a damage curve that heals at range is a bug report.
  const monotone = new FloatCurve({ name: 'Monotone', interp: CurveInterp.Auto });
  monotone.addKeys([[0, 0], [1, 1], [2, 1], [3, 0.5]]);
  let overshoot = 0;
  for (let t = 0; t <= 3; t += 0.01) { const value = monotone.evaluate(t); if (value < -1e-6 || value > 1 + 1e-6) overshoot++; }
  assert.equal(overshoot, 0);
  monotone.autoTangents();
  assert.ok(monotone.evaluate(0.5) > 0 && monotone.evaluate(0.5) < 1);

  const looped = new FloatCurve({ extrap: CurveExtrap.Loop, interp: CurveInterp.Linear });
  looped.addKeys([[0, 0], [10, 10]]);
  assert.equal(looped.evaluate(15), 5);
  const cycled = new FloatCurve({ extrap: CurveExtrap.Cycle, interp: CurveInterp.Linear });
  cycled.addKeys([[0, 0], [10, 10]]);
  assert.equal(cycled.evaluate(15), 5, 'cycle mirrors back');
  const extrapolated = new FloatCurve({ extrap: CurveExtrap.Linear, interp: CurveInterp.Linear });
  extrapolated.addKeys([[0, 0], [10, 10]]);
  assert.equal(extrapolated.evaluate(20), 20, 'linear extrapolation keeps the slope');

  const baked = monotone.bake(5);
  assert.equal(baked.length, 5);
  assert.ok(monotone.bake(4, { asFloat32: true }) instanceof Float32Array);
  assert.ok(Math.abs(monotone.integrate({ steps: 600 }) - 2.25) < 0.05);
  const extrema = monotone.extrema();
  assert.equal(extrema.max, 1);
  assert.equal(extrema.min, 0);
  assert.ok(extrema.maxTime > 0.9 && extrema.maxTime < 1.2);
  assert.ok(Math.abs(monotone.normalized(1.5) - 1) < 1e-6);

  // Editing: replacing a key keeps order, removing works, changing fires an event.
  let changed = 0;
  curveEvents.onChanged.add(() => changed++);
  const editable = new FloatCurve();
  editable.addKey(0, 1).addKey(1, 2).addKey(0, 5);
  assert.equal(editable.count, 2, 'a key at an existing time replaces it');
  assert.equal(editable.evaluate(0), 5);
  assert.equal(editable.removeKey(1), true);
  assert.equal(editable.count, 1);
  assert.ok(changed >= 3);
  assert.equal(editable.setTangent(9, 1), false);
  editable.clear();
  assert.equal(editable.isEmpty, true);
  assert.equal(editable.evaluate(3), 0, 'an empty curve falls back to its default');

  // Text round-trip: a designer's spreadsheet is where these numbers live.
  const csv = monotone.toCsv();
  assert.match(csv.split('\n')[0], /time,value/);
  const fromCsv = new FloatCurve().fromCsv(csv);
  assert.equal(fromCsv.count, monotone.count);
  assert.ok(Math.abs(fromCsv.evaluate(1.5) - monotone.evaluate(1.5)) < 1e-9);
  const fromJson = FloatCurve.fromJSON(JSON.parse(JSON.stringify(monotone.toJSON())));
  assert.equal(fromJson.count, monotone.count);
  assert.equal(fromJson.evaluate(1).toFixed(3), '1.000');
  assert.ok(monotone.plot({ width: 32, height: 5 }).split('\n').length === 6);
  assert.ok(monotone.describe().keyList.length === 4);
});

test('Curves: vector patterns, presets and the console', () => {
  const recoil = VectorCurve.fromPattern([[0, 0], [0.4, 1.2], [0.9, 2.1], [1.4, 2.4], [1.6, 2.35]], { name: 'RifleRecoil', step: 0.08 });
  assert.equal(recoil.keys, 5);
  const at = recoil.evaluate(0.24);
  assert.ok(at.x > 0.8 && at.x < 1.6, `recoil rises through the burst (x=${at.x})`);
  assert.ok(at.y > 2);
  assert.equal(recoil.timeRange[1], 4 * 0.08);
  const restored = VectorCurve.fromJSON(JSON.parse(JSON.stringify(recoil.toJSON())));
  assert.equal(restored.keys, recoil.keys);
  assert.ok(Math.abs(restored.evaluate(0.24).y - at.y) < 1e-9);

  const presets = shooterCurvePresets();
  assert.equal(presets.damageFalloff.evaluate(10), 1, 'no falloff inside 25 m');
  assert.ok(presets.damageFalloff.evaluate(100) < 0.3);
  assert.ok(presets.recoilPitch.evaluate(0.5) > 1, 'recoil climbs');
  assert.ok(presets.muzzleFlash.evaluate(0.09) === 0, 'the flash is over by 90 ms');
  assert.ok(presets.adsTransition.evaluate(0.22) === 1);

  const library = new CurveLibrary();
  for (const [name, curve] of Object.entries(presets)) library.add(name, curve);
  library.load({ Extra: [[0, 0], [1, 1]] });
  assert.equal(library.names().length, 7);
  assert.equal(library.get('DamageFalloff'), library.get('damageFalloff'), 'lookup is case-insensitive');
  assert.equal(library.keyFor('DAMAGEFALLOFF'), 'damageFalloff');
  assert.ok(Math.abs(library.evaluate('damageFalloff', 60) - 0.555) < 0.06);
  assert.equal(library.evaluate('missing', 1, -1), -1);
  assert.ok(library.describe().curves.length === 7);

  const console_ = new Console();
  library.installConsoleCommands(console_);
  assert.ok(console_.exec('curves', { silent: true }).ok);
  assert.match(console_.exec('curve.plot DamageFalloff 40', { silent: true }).output, /DamageFalloff|damageFalloff/);
  assert.match(console_.exec('curve.eval damageFalloff 45', { silent: true }).output, /\{?/);
  assert.match(console_.exec('curve.eval nope 1', { silent: true }).output, /no curve/);
});

// ---------------------------------------------------------------------- replays

test('Replays: recording captures what the simulation consumed, tick for tick', async () => {
  const engine = await createEngine({ name: 'ReplayRecord', tickRate: 60, target: 'client' });
  const input = engine.createInputMapping({ name: 'P1' });
  const { actions, context } = createShooterContext();
  for (const action of Object.values(actions)) input.addAction(action);
  input.addContext(context);

  const system = engine.createReplaySystem({ name: 'Session', sampleEvery: 30, maxFrames: 1000 });
  assert.equal(system.state, ReplayState.Idle);
  system.startRecording({ name: 'Run', metadata: { map: 'arena', player: 'Raven' } });
  assert.equal(system.recording, true);

  let liveTriggers = 0;
  const originalEvaluate = input.evaluate.bind(input);
  input.evaluate = (delta) => {
    const result = originalEvaluate(delta);
    if (input.wasTriggered('ThrowGrenade')) liveTriggers++;
    return result;
  };
  for (let i = 0; i < 120; i++) {
    input.setKeyValue(Keys.W, i < 60 ? 1 : 0);
    input.setKeyValue(Keys.MouseLeft, i % 20 < 10 ? 1 : 0);
    if (i % 5 === 0) input.setKeyValue(Keys.G, 1);
    else input.setKeyValue(Keys.G, 0);
    engine.frame(DT);
  }
  const replay = system.stopRecording();
  assert.equal(replay.frameCount, 120, 'one recorded frame per simulation tick');
  assert.equal(replay.seconds, 2);
  assert.equal(replay.tickRate, 60);
  assert.equal(replay.mode, 'actions');
  assert.equal(replay.empty, false);
  assert.ok(replay.channels.includes('Move'));
  assert.ok(replay.snapshots.length >= 4, 'periodic snapshots for seeking');
  assert.equal(replay.frames.filter((frame) => frame.triggers?.includes('ThrowGrenade')).length, liveTriggers);
  assert.ok(replay.frames.some((frame) => frame.actions?.Fire !== undefined), 'held keys are recorded');
  const description = replay.describe();
  assert.equal(description.frames, 120);
  assert.ok(description.bytesPerFrame > 0);

  // Keys mode records raw key values instead, so the replay survives rebinding.
  const keysRecorder = new ReplayRecorder({ engine, mode: 'keys', sampleEvery: 0 });
  keysRecorder.start();
  for (let i = 0; i < 10; i++) { input.setKeyValue(Keys.A, i % 2); engine.frame(DT); }
  const keysReplay = keysRecorder.stop();
  assert.equal(keysReplay.mode, 'keys');
  assert.equal(keysReplay.snapshots.length, 0);
  assert.ok(keysReplay.frames.some((frame) => frame.keys && Object.keys(frame.keys).length > 0));

  // The buffer is bounded: a session that forgets to stop cannot exhaust memory.
  const capped = new ReplayRecorder({ engine, maxFrames: 5 });
  capped.start();
  for (let i = 0; i < 8; i++) engine.frame(DT);
  const cappedReplay = capped.stop();
  assert.equal(cappedReplay.frameCount, 5);
  assert.equal(capped.dropped, 3);

  // Recording stops when the engine does.
  const events = [];
  replayEvents.onRecordingStarted.add(() => events.push('started'));
  replayEvents.onRecordingStopped.add(() => events.push('stopped'));
  const again = new ReplayRecorder({ engine, maxFrames: 10 });
  again.start();
  again.stop();
  assert.deepEqual(events, ['started', 'stopped']);
  await engine.shutdown();
});

test('Replays: playback drives the same input path, with seeking, speed and divergence checks', async () => {
  const engine = await createEngine({ name: 'ReplayPlay', tickRate: 60, target: 'client' });
  const input = engine.createInputMapping({ name: 'P1' });
  const { actions, context } = createShooterContext();
  for (const action of Object.values(actions)) input.addAction(action);
  input.addContext(context);

  const system = engine.createReplaySystem({ name: 'Session', sampleEvery: 20 });
  system.startRecording({ name: 'Strafe' });
  for (let i = 0; i < 90; i++) {
    input.setKeyValue(Keys.D, i % 30 < 15 ? 1 : 0);
    input.setKeyValue(Keys.MouseX, i % 10 === 0 ? 8 : 0);
    engine.frame(DT);
  }
  const replay = system.stopRecording();

  // Playback: every tick applies exactly one recorded frame through the input system.
  const player = new ReplayPlayer({ engine });
  player.load(replay);
  assert.equal(player.state, ReplayState.Loaded);
  assert.equal(player.play(), true);
  assert.equal(player.playing, true);
  let applied = 0;
  const looked = [];
  while (!player.finished && applied < 200) {
    const frame = player.step();
    if (!frame) break;
    applied++;
    looked.push(input.getActionVector('Look').x);
  }
  assert.equal(applied, replay.frameCount);
  assert.equal(player.finished, true);
  assert.ok(looked.some((value) => value === 8), 'recorded mouse deltas are re-applied');

  // Seeking uses the nearest snapshot.
  player.load(replay);
  assert.equal(player.seekToTick(45), true);
  assert.equal(player.tick, 45);
  assert.ok(player.snapshotApplied !== null);

  // Speed: 0.25 s of wall time at 4× is one second of replay = one tick rate worth of frames.
  player.load(replay);
  player.setSpeed(4);
  player.play({ from: 0 });
  const fast = player.advance(0.25);
  assert.equal(fast, Math.min(replay.tickRate, replay.frameCount), 'playback consumed one second of recorded frames');
  if (fast < replay.frameCount) assert.equal(player.finished, false);
  player.advance(5);
  assert.equal(player.finished, true, 'playback finishes and stops');
  assert.equal(player.cursor, replay.frameCount);

  // Divergence detection needs recorded checksums: a replay recorded with a checksum function can
  // tell a rebuild exactly which tick stopped matching.
  let divergedAt = null;
  replayEvents.onDivergence.add((frame) => { divergedAt = frame.tick; });
  const checkedRecorder = new ReplayRecorder({ engine, name: 'Checked', checksum: (e) => (e.tickCount * 2654435761) >>> 0 });
  checkedRecorder.start();
  for (let i = 0; i < 20; i++) engine.frame(DT);
  const checkedReplay = checkedRecorder.stop();
  assert.ok(checkedReplay.frames.some((frame) => frame.checksum !== 0), 'checksums were recorded');

  const checked = new ReplayPlayer({ engine });
  checked.load(checkedReplay);
  const mismatched = checked.verify({ checksum: (engineRef, tick) => (tick * 7919) >>> 0 });
  assert.equal(mismatched.ok, false, 'a diverged run is detected');
  assert.equal(divergedAt, checkedReplay.frames[0].tick);
  assert.equal(mismatched.framesChecked, 1, 'verification stops at the first divergence');
  const unverifiable = checked.verify({});
  assert.equal(unverifiable.ok, true, 'without a comparator there is nothing to disagree with');
  assert.equal(unverifiable.framesChecked, checkedReplay.frameCount);

  // Save/load through the archive keeps frames, snapshots, channels and metadata.
  const payload = system.save();
  assert.ok(payload instanceof Uint8Array);
  const loaded = system.load(payload);
  assert.equal(loaded.frameCount, replay.frameCount);
  assert.deepEqual(loaded.channels, replay.channels);
  assert.equal(loaded.mode, replay.mode);
  assert.ok(loaded.frames.some((frame) => frame.actions !== undefined));
  const jsonPayload = system.save({ format: 'json' });
  assert.equal(typeof jsonPayload, 'string');
  assert.equal(system.load(jsonPayload).frameCount, replay.frameCount);

  // The console surface: record, stop, play, pause, seek.
  assert.match(engine.console.exec('replay', { silent: true }).output, /replay "/);
  assert.match(engine.console.exec('replay.start Demo', { silent: true }).output, /recording "Demo"/);
  engine.runFixedFrames(5, DT);
  assert.match(engine.console.exec('replay.stop', { silent: true }).output, /recorded 5 frames/);
  assert.ok(engine.console.exec('replay.play 2', { silent: true }).ok);
  assert.ok(engine.console.exec('replay.pause', { silent: true }).ok);
  assert.ok(engine.console.exec('replay.seek 2', { silent: true }).ok);
  assert.ok(engine.console.exec('replay.save', { silent: true }).output.includes('payload'));
  assert.ok(engine.describe() !== null);

  // A playing replay is applied by the engine's own frame loop.
  const live = engine.createReplaySystem({ name: 'Live', sampleEvery: 0 });
  system.startRecording({ name: 'One' });
  for (let i = 0; i < 30; i++) { input.setKeyValue(Keys.W, 1); engine.frame(DT); }
  const one = system.stopRecording();
  input.setKeyValue(Keys.W, 0);
  live.player.load(one);
  live.player.play();
  engine.runFixedFrames(10, DT);
  assert.equal(input.getActionVector('Move').y, 1, 'the engine applies recorded input while a replay plays');
  await engine.shutdown();
});

// ---------------------------------------------------------------------- saved games

test('SaveGame: atomic slots round-trip headers, sections, metadata and counters', () => {
  const storage = SaveStorage.memory();
  const saves = new SaveSystem({ storage, prefix: 'test', version: 2 });
  assert.ok(CORE_MODULES.SaveGame, 'the barrel manifest knows about saved games');
  assert.equal(SaveSlotHeader.payload, 'string');
  assert.equal(typeof saves.format, 'function', 'format() must not be shadowed by the encoding field');
  assert.equal(saves.storageFormat, 'json');

  const written = saves.write('profile', {
    progress: { level: 4, score: 12900, unlocked: ['rifle', 'smg'] },
  }, { metadata: { player: 'Raven', map: 'arena', playtimeSeconds: 125 } });
  assert.ok(written instanceof SaveGame);
  assert.equal(written.slot, 'profile');
  assert.equal(written.version, 2);
  assert.ok(written.checksum > 0);
  assert.ok(written.savedAt);
  assert.equal(saves.writeCount, 1);

  const read = saves.read('profile');
  assert.deepEqual(read.get('progress'), { level: 4, score: 12900, unlocked: ['rifle', 'smg'] });
  assert.equal(read.metadata.player, 'Raven');
  assert.equal(read.metadata.playtimeSeconds, 125);
  assert.equal(read.bytes, storage.read(saves.keyFor('profile')).length, 'bytes is the stored record size');
  assert.equal(read.recoveredFrom, null);
  assert.equal(saves.exists('profile'), true);
  assert.equal(saves.exists('missing'), false);
  assert.equal(saves.read('missing'), null);

  const before = saves.readCount;
  assert.ok(saves.peek('profile'));
  assert.equal(saves.readCount, before, 'peek() does not count as a load');
  const rows = saves.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot, 'profile');
  assert.equal(rows[0].history, false);
  assert.equal(saves.readCount, before, 'list() does not fire load events');

  // Single-section helpers and SaveGame editing.
  assert.equal(saves.readSlot('profile', 'progress').level, 4);
  saves.writeSection('profile', 'settings', { fov: 100 });
  assert.equal(saves.readSlot('profile', 'settings').fov, 100);
  assert.equal(saves.readSlot('profile', 'progress').level, 4, 'writeSection keeps the other sections');
  const game = new SaveGame({ slot: 'scratch' });
  game.patch('progress', { level: 1 }).patch('progress', { score: 10 });
  assert.deepEqual(game.get('progress'), { level: 1, score: 10 });
  game.remove('progress');
  assert.equal(game.has('progress'), false);
  assert.match(game.format(), /scratch/);
});

test('SaveGame: checksum corruption is reported and recovered from the backup chain', () => {
  const storage = SaveStorage.memory();
  const saves = new SaveSystem({ storage, prefix: 'test', backupSlots: 2 });
  saves.write('profile', { progress: { level: 4 } });
  const key = saves.keyFor('profile');
  const record = JSON.parse(storage.read(key));
  record.payload = record.payload.replace('"level":4', '"level":99');
  storage.write(key, JSON.stringify(record));
  let corrupt = 0;
  const handle = saveEvents.onCorrupt.add(() => { corrupt++; });
  const recovered = saves.read('profile');
  handle.unbind();
  assert.ok(recovered);
  assert.equal(recovered.get('progress').level, 4, 'a tampered payload never reaches the game');
  assert.equal(recovered.recoveredFrom, 'backup');
  assert.equal(corrupt, 1);
  assert.equal(saves.corruptCount, 1);
  const verification = saves.verify();
  assert.equal(verification.checked, 1);
  assert.equal(verification.corrupt.length, 1, 'verify() names the corrupt slot');

  // When every copy is bad, read() returns null instead of half a profile.
  storage.write(saves.backupKeyFor('profile'), '{"format":"saveslot-json","slot":"profile","payload":"garbage","checksum":1}');
  storage.write(saves.backupKeyFor('profile', 1), 'garbage');
  assert.equal(saves.read('profile'), null);
  assert.match(saves.format(), /UNREADABLE/);

  const junk = new SaveSystem({ storage: SaveStorage.memory(), prefix: 'junk' });
  junk.storage.write(junk.keyFor('garbage'), 'this is not a save');
  assert.equal(junk.read('garbage'), null);
});

test('SaveGame: a refused write never damages the previous save', () => {
  const backing = SaveStorage.memory();
  let failKey = null;
  const storage = {
    name: 'failing',
    read: (key) => backing.read(key),
    write: (key, value) => (key === failKey ? false : backing.write(key, value)),
    remove: (key) => backing.remove(key),
    keys: () => backing.keys(),
  };
  const saves = new SaveSystem({ storage, prefix: 'test' });
  assert.ok(saves.write('profile', { progress: { level: 1 } }));

  failKey = saves.stagingKeyFor('profile');
  assert.equal(saves.write('profile', { progress: { level: 2 } }), null);
  assert.equal(saves.readSlot('profile', 'progress').level, 1);
  assert.equal(backing.read(failKey), null, 'the staging key is cleaned up on failure');

  failKey = saves.keyFor('profile');
  assert.equal(saves.write('profile', { progress: { level: 3 } }), null);
  assert.equal(saves.readSlot('profile', 'progress').level, 1, 'the failed commit did not replace the good slot');
  assert.equal(saves.writeCount, 1);

  failKey = null;
  assert.ok(saves.write('profile', { progress: { level: 4 } }));
  assert.equal(saves.readSlot('profile', 'progress').level, 4);
});

test('SaveGame: chained migrations, patches and Map/Set sections survive a round-trip', () => {
  const saves = new SaveSystem({ storage: SaveStorage.memory(), version: 3 });
  const trail = [];
  const handle = saveEvents.onMigrated.add((_save, versions) => trail.push(...versions));
  saves.migrate(1, (save) => save.patch('progress', { coins: save.get('progress').coins * 10 }));
  saves.migrate(2, (save) => save.patch('progress', { level: 1, upgraded: true }));
  const legacy = new SaveGame({ slot: 'legacy', version: 1, sections: { progress: { coins: 3 } } });
  assert.ok(saves.write('legacy', legacy));
  const loaded = saves.read('legacy');
  handle.unbind();
  assert.equal(loaded.version, 3);
  assert.equal(loaded.get('progress').coins, 30);
  assert.equal(loaded.get('progress').level, 1);
  assert.equal(loaded.get('progress').upgraded, true);
  assert.deepEqual(trail, [2, 3]);

  const tagged = { seen: new Set(['a', 'b']), lookup: new Map([['k', 7]]) };
  assert.ok(saves.write('complex', { inventory: tagged }));
  const restored = saves.read('complex').get('inventory');
  assert.ok(restored.seen instanceof Set);
  assert.ok(restored.lookup instanceof Map);
  assert.equal(restored.lookup.get('k'), 7);
  assert.deepEqual([...restored.seen], ['a', 'b']);
  assert.ok(reviveSavedValue({ __type: 'Set', values: [1] }) instanceof Set);
  assert.equal(checksumOf('abc'), checksumOf('abc'));
  assert.notEqual(checksumOf('abc'), checksumOf('abd'));
});

test('SaveGame: registered schemas validate fields and strict mode refuses bad writes', () => {
  const saves = new SaveSystem({ storage: SaveStorage.memory(), strict: true });
  saves.registerSection('progress', {
    level: 'u8', unlocked: 'array:string', hp: 'f32', origin: 'vec3', alive: 'boolean',
  });
  const issues = saves.validate({
    progress: { level: 999, unlocked: 'rifle', hp: NaN, origin: [1, 2], alive: 'yes' },
  });
  assert.ok(issues.length >= 5, issues.join('; '));
  assert.ok(issues.some((issue) => issue.includes('level')));
  assert.equal(saves.write('bad', {
    progress: { level: 999, unlocked: [], hp: 100, origin: { x: 1, y: 2, z: 3 }, alive: true },
  }), null);
  assert.equal(saves.exists('bad'), false);
  assert.ok(saves.write('good', {
    progress: { level: 4, unlocked: ['rifle'], hp: 100, origin: [0, 0, 0], alive: true },
  }));
  assert.deepEqual(saves.validationIssues, []);
  assert.equal(saves.describe().schemaSections[0], 'progress');
});

test('SaveGame: autosave cadence, rotation, readable history and shutdown', () => {
  const timers = new TimerManager();
  const saves = new SaveSystem({ storage: SaveStorage.memory(), timerManager: timers, prefix: 'run' });
  let events = 0;
  const listener = saveEvents.onAutosave.add(() => { events++; });
  const handle = saves.enableAutosave({
    slot: 'auto', intervalSeconds: 5, keep: 3,
    collect: () => ({ progress: { tick: Math.round(timers.time * 60) } }),
  });
  assert.ok(handle);
  assert.equal(saves.autosaveActive, true);
  for (let i = 0; i < 16 * 60; i++) timers.advance(DT);
  listener.unbind();
  assert.equal(events, 3, 'a 5 s interval fires three times in 16 s');
  assert.equal(saves.autosaveCount, 3);
  assert.equal(timers.getFiredCount(handle), 3);
  assert.deepEqual(saves.slotKeys().map((key) => key.slice('run.save.'.length)).sort(), ['auto', 'auto.1', 'auto.2']);
  assert.deepEqual(
    ['auto', 'auto.1', 'auto.2'].map((slot) => saves.readSlot(slot, 'progress').tick),
    [900, 600, 300], 'rotation keeps the previous saves, not a duplicate of the newest',
  );
  for (const slot of ['auto', 'auto.1', 'auto.2']) {
    assert.equal(saves.read(slot).slot, slot, 'each rotated record carries its own slot header');
  }
  assert.equal(saves.list().filter((row) => row.history).length, 2);
  assert.match(saves.format(), /autosave every 5s/);
  assert.equal(saves.verify().ok, 3);
  saves.stopAutosave();
  assert.equal(saves.autosaveActive, false);
  timers.advance(20);
  assert.equal(saves.autosaveCount, 3, 'a stopped autosave does not fire again');
  saves.remove('auto');
  assert.equal(saves.slotKeys().length, 0, 'remove() clears the autosave history too');
});

test('SaveGame: binary records work with string-only storage and export/import', () => {
  const data = new Map();
  const localStorageLike = {
    get length() { return data.size; },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  const storage = SaveStorage.browser(localStorageLike);
  assert.equal(storage.name, 'localStorage');
  const saves = new SaveSystem({ storage, prefix: 'test', format: 'binary', version: 2 });
  assert.equal(saves.storageFormat, 'binary');
  assert.ok(saves.write('binary', { progress: { level: 7, tags: new Set(['a']), table: new Map([['k', 3]]) } }));
  assert.equal(typeof storage.read(saves.keyFor('binary')), 'string', 'a binary record is stored as a marked string');
  const read = saves.read('binary');
  assert.equal(read.get('progress').level, 7);
  assert.ok(read.get('progress').tags instanceof Set);
  assert.equal(read.get('progress').table.get('k'), 3);
  assert.equal(saves.verify().ok, 1);
  assert.ok(saves.write('binary', { progress: { level: 8 } }));

  const exported = saves.exportAll();
  assert.match(exported, /ominx-saves/);
  const other = new SaveSystem({ storage: SaveStorage.memory(), prefix: 'copy', format: 'binary', version: 2 });
  assert.equal(other.importAll(exported), 1);
  assert.equal(other.readSlot('binary', 'progress').level, 8);
  assert.equal(other.importAll(exported), 0, 'existing slots are kept by default');
  assert.equal(other.importAll(exported, { overwrite: true }), 1);
  assert.throws(() => other.importAll('{"format":"nope","slots":[]}'), /not an OminX save export/);
});

test('SaveGame: console surface writes, reads, verifies and deletes slots', () => {
  const console_ = new Console();
  const saves = new SaveSystem({ storage: SaveStorage.memory(), prefix: 'cmd', timerManager: new TimerManager() });
  saves.installConsoleCommands(console_);
  assert.equal(console_.hasCommand('save'), true);
  assert.equal(console_.hasCommand('save.list'), true);
  assert.match(console_.exec('save', { silent: true }).output, /no saved games/);
  const wrote = console_.exec('save.write profile \'{"progress":{"level":9}}\'', { silent: true });
  assert.equal(wrote.ok, true);
  assert.match(wrote.output, /wrote "profile"/);
  assert.equal(saves.readSlot('profile', 'progress').level, 9);
  assert.match(console_.exec('save.read profile', { silent: true }).output, /"slot": "profile"/);
  assert.match(console_.exec('save.verify', { silent: true }).output, /1\/1 slots ok/);
  assert.match(console_.exec('save.export', { silent: true }).output, /ominx-saves/);
  assert.match(console_.exec('save.autosave 10', { silent: true }).output, /autosave every 10s/);
  assert.equal(saves.autosaveActive, true);
  assert.match(console_.exec('save.autosave 0', { silent: true }).output, /autosave off/);
  assert.equal(saves.autosaveActive, false);
  assert.match(console_.exec('save.delete profile', { silent: true }).output, /deleted/);
  assert.equal(saves.exists('profile'), false);
  assert.match(console_.exec('save.write broken {oops', { silent: true }).output, /invalid json/);
});

test('EngineCore: saved games are wired to the console, the clock and the reports', async () => {
  const engine = await createEngine({ name: 'SaveEngine', tickRate: 60, target: 'client', savePrefix: 'unittest' });
  assert.ok(engine.saves instanceof SaveSystem);
  assert.equal(engine.saves.timers, engine.timers);
  assert.equal(engine.console.hasCommand('save'), true);
  assert.equal(engine.console.exec('save', { silent: true }).ok, true);
  assert.match(engine.console.exec('save', { silent: true }).output, /Saves/);
  assert.match(engine.console.exec('save.write profile \'{"progress":{"level":2}}\'', { silent: true }).output, /wrote/);
  assert.equal(engine.saves.readSlot('profile', 'progress').level, 2);
  assert.equal(engine.describe().saves.slots >= 1, true);
  assert.match(engine.format(), /saves/);

  const replaced = engine.createSaveSystem({ prefix: 'unittest2', version: 4 });
  assert.equal(replaced.version, 4);
  assert.equal(replaced.timers, engine.timers);
  replaced.enableAutosave({
    slot: 'auto', intervalSeconds: 0.5, keep: 2,
    collect: () => ({ tick: { frame: engine.frameNumber } }),
  });
  engine.runFixedFrames(60, DT);
  assert.equal(replaced.autosaveCount, 2, 'autosave is driven by the engine fixed-step clock');
  assert.ok(replaced.exists('auto'));
  await engine.shutdown();
  assert.equal(replaced.autosaveActive, false, 'shutdown stops autosave');
});

// ---------------------------------------------------------------------- event queue and message bus

test('EventBus: the queue orders by priority, defers reentrant events and honours once/wildcards', () => {
  const queue = new EventQueue({ name: 'Ordered' });
  const calls = [];
  const low = queue.on('tick', (payload) => calls.push(`low:${payload}`), { priority: -1 });
  queue.on('tick', (payload) => calls.push(`high:${payload}`), { priority: 10 });
  queue.on(['tick', 'other'], (payload, record) => calls.push(`wild:${record.type}:${payload}`));
  queue.on('once', () => calls.push('once'), { once: true });
  queue.enqueue('tick', 1);
  const record = queue.enqueue('tick', 2, { priority: 100 });
  assert.ok(record instanceof EventRecord);
  assert.equal(queue.count, 2);
  assert.equal(EventPriority.Highest, 100);
  const report = queue.drain();
  assert.equal(report.delivered, 2);
  assert.equal(report.handled, 6, 'three handlers see each tick event');
  assert.deepEqual(calls, ['high:2', 'wild:tick:2', 'low:2', 'high:1', 'wild:tick:1', 'low:1']);

  queue.enqueue('once', null);
  queue.enqueue('once', null);
  queue.drain();
  assert.equal(calls.filter((call) => call === 'once').length, 1, 'a once handler fires exactly once');
  low.unbind();
  assert.equal(low.isValid, false);
  queue.enqueue('tick', 3);
  queue.drain();
  assert.equal(calls.filter((call) => call.startsWith('low:')).length, 2, 'unbind removed the low handler');

  // An event raised inside a handler is deferred to the next pass, not delivered mid-batch.
  const chain = [];
  queue.on('chain', (payload) => { chain.push(payload); if (payload === 1) queue.enqueue('chain', 2); });
  queue.enqueue('chain', 1);
  const first = queue.drain();
  assert.deepEqual(chain, [1]);
  assert.equal(first.deferred, 1);
  assert.equal(first.passes, 1);
  queue.drain();
  assert.deepEqual(chain, [1, 2]);
  assert.equal(queue.lastDrain.delivered, 1);
});

test('EventBus: channels, capacity policies, TTL, filters and error isolation', () => {
  const bounded = new EventQueue({ capacity: 3, dropPolicy: 'lowest' });
  bounded.on('x', () => {});
  for (const priority of [-10, 10, 0, 5]) assert.ok(bounded.enqueue('x', priority, { priority }));
  assert.equal(bounded.count, 3);
  assert.equal(bounded.dropped, 1, 'the lowest-priority event is the one dropped');
  assert.equal(bounded.drain().delivered, 3);
  assert.ok(bounded.describe().lastDrain);
  const refuse = new EventQueue({ capacity: 1, dropPolicy: 'newest' });
  assert.ok(refuse.enqueue('a', 1));
  assert.equal(refuse.enqueue('a', 2), null);

  const channels = new EventQueue();
  const got = [];
  channels.on('x', (payload) => got.push(payload));
  channels.enableChannel('custom', false);
  channels.enqueue('x', 1, { channel: 'custom' });
  assert.equal(channels.drain().held, 1);
  assert.deepEqual(got, []);
  channels.enableChannel('custom', true);
  assert.equal(channels.drain().delivered, 1);
  assert.deepEqual(got, [1]);

  const expiring = new EventQueue();
  expiring.enableChannel('slow', false);
  expiring.enqueue('x', 1, { channel: 'slow', ttl: 1 });
  expiring.drain(); // age 1: still held, not expired
  expiring.drain(); // age 2: expired
  assert.equal(expiring.expired, 1);
  assert.equal(expiring.count, 0);

  const errors = new EventQueue();
  const seen = [];
  errors.on('x', () => { throw new Error('bad handler'); });
  errors.on('x', (payload) => seen.push(payload), { filter: (payload) => payload > 2 });
  errors.enqueue('x', 1);
  errors.enqueue('x', 3);
  const report = errors.drain();
  assert.equal(report.errors, 2, 'one throwing handler fails twice, once per event');
  assert.deepEqual(seen, [3], 'the other handler still ran and its filter was honoured');
  assert.equal(errors.errors.length, 2);
  assert.match(errors.format(), /errors 2/);
  assert.equal(errors.clear({ type: 'x' }), 0);
  assert.equal(topicMatches('player.*', 'player.damaged'), true);
  assert.equal(topicMatches('player.*', 'weapon.fired'), false);
  assert.equal(topicMatches('*', 'anything'), true);
});

test('EventBus: bus topics, wildcards, priority and immediate delivery', () => {
  const bus = new MessageBus({ name: 'Topics' });
  const seen = [];
  const handle = bus.subscribe('player.*', (body) => seen.push(`prefix:${body.amount}`));
  bus.subscribe('*', (_body, envelope) => seen.push(`all:${envelope.topic}`), { priority: -1 });
  bus.subscribe('player.damaged', () => seen.push('exact'), { priority: 10 });
  assert.ok(handle instanceof EventSubscription);
  bus.publish('player.damaged', { amount: 12 });
  assert.equal(bus.count, 1);
  assert.deepEqual(seen, [], 'publish is deferred until a drain');
  assert.equal(bus.drain().delivered, 1);
  assert.deepEqual(seen, ['exact', 'prefix:12', 'all:player.damaged']);

  bus.publish('player.damaged', { amount: 1 }, { immediate: true });
  assert.equal(bus.count, 0, 'immediate publish bypasses the queue');
  assert.equal(seen.length, 6);
  assert.match(bus.format(), /Topics/);
  const described = bus.describe();
  assert.ok(described.subscriptions.includes('player.*'));
  assert.equal(described.queue.channels[0].name, 'default');
  assert.equal(handle.unbind(), true);
  assert.equal(bus.off(handle), 0, 'unbinding twice is harmless');
});

test('EventBus: request/reply, responders, timeouts, cancellation and async replies', async () => {
  const bus = new MessageBus({ timeoutDrains: 2 });
  bus.respond('inventory.query', (body) => ({ item: 'rifle', slot: body.slot }));
  const request = bus.request('inventory.query', { slot: 2 });
  assert.ok(request instanceof MessageRequest);
  assert.equal(bus.pendingRequests, 1);
  assert.equal(bus.drain().pendingRequests, 0);
  assert.deepEqual(await request.promise, { item: 'rifle', slot: 2 });

  // A reply can also travel through the queue, keeping cross-worker delivery ordered.
  const queued = bus.request('echo', { value: 1 });
  bus.drain(); // no responder yet, still pending
  assert.equal(bus.pendingRequests, 1);
  bus.publishReply(queued.id, { value: 2 });
  bus.drain();
  assert.deepEqual(await queued.promise, { value: 2 });

  bus.respond('async.echo', () => Promise.resolve({ ok: true }));
  const asyncRequest = bus.request('async.echo', {});
  bus.drain();
  assert.equal(asyncRequest.asyncPending, true, 'an async responder holds its timeout open');
  assert.deepEqual(await asyncRequest.promise, { ok: true });

  const timedOut = bus.request('nobody.home', {}, { timeoutDrains: 0 });
  bus.drain();
  await assert.rejects(timedOut.promise, /timed out after 0 drains/);
  assert.equal(bus.expiredRequests, 1);

  const cancelled = bus.request('nobody.home', {});
  assert.equal(cancelled.cancel('cancelled'), true);
  await assert.rejects(cancelled.promise, /cancelled/);
  assert.equal(bus.reply('no-such-id', 1), false);
  assert.equal(bus.orphanReplies, 1);
  assert.equal(bus.replies, 4, 'three replies plus the cancellation');
});

test('EventBus: console surface publishes, drains, clears and toggles channels', () => {
  const console_ = new Console();
  const queue = new EventQueue({ name: 'CmdQueue' });
  const bus = new MessageBus({ name: 'CmdBus', queue });
  const seen = [];
  bus.subscribe('demo', (body) => seen.push(body.n));
  queue.installConsoleCommands(console_);
  bus.installConsoleCommands(console_);
  assert.match(console_.exec('events', { silent: true }).output, /CmdQueue/);
  assert.match(console_.exec('bus', { silent: true }).output, /CmdBus/);
  assert.match(console_.exec("bus.publish demo '{\"n\":7}'", { silent: true }).output, /published/);
  assert.deepEqual(seen, []);
  assert.match(console_.exec('bus.drain', { silent: true }).output, /delivered 1/);
  assert.deepEqual(seen, [7]);
  assert.match(console_.exec("events.push x '{\"v\":1}' 5", { silent: true }).output, /queued/);
  assert.match(console_.exec('events.drain', { silent: true }).output, /delivered 1/);
  assert.match(console_.exec('events.channel slow off', { silent: true }).output, /off/);
  assert.equal(queue.channel('slow').enabled, false);
  assert.match(console_.exec('events.flush', { silent: true }).output, /flushed/);
  assert.match(console_.exec('bus.requests', { silent: true }).output, /\[/);
  assert.match(console_.exec('bus.clear', { silent: true }).output, /dropped/);
});

test('EngineCore: the message bus is pumped once per frame and reachable from the console', async () => {
  const engine = await createEngine({ name: 'BusEngine', tickRate: 60, target: 'client' });
  assert.ok(engine.messages instanceof MessageBus);
  assert.equal(engine.messages.queue.stats, engine.stats);
  assert.equal(engine.console.hasCommand('bus'), true);
  assert.equal(engine.console.hasCommand('events'), true);
  const seen = [];
  engine.messages.subscribe('engine.frame', (body) => seen.push(body.tick));
  engine.messages.publish('engine.frame', { tick: 1 });
  assert.deepEqual(seen, [], 'a published message waits for the frame pump');
  engine.frame(DT);
  assert.deepEqual(seen, [1]);
  assert.equal(engine.describe().messages.published >= 1, true);
  assert.match(engine.format(), /messages/);

  // A handler that publishes during the pump is deferred to the next frame, not this one.
  let chained = 0;
  engine.messages.subscribe('chain.start', () => engine.messages.publish('chain.done', {}));
  engine.messages.subscribe('chain.done', () => { chained++; });
  engine.messages.publish('chain.start', {});
  engine.frame(DT);
  assert.equal(chained, 0);
  engine.frame(DT);
  assert.equal(chained, 1);

  const replaced = engine.createMessageBus({ name: 'Other', timeoutDrains: 4 });
  assert.equal(replaced.name, 'Other');
  assert.equal(replaced.timeoutDrains, 4);
  await engine.shutdown();
});

// ---------------------------------------------------------------------- async tasks and workers

test('Async: cancellation tokens are observable, idempotent and reach task bodies', async () => {
  const source = new CancellationSource('level');
  const token = source.token;
  const reasons = [];
  const handle = token.onCancelled((reason) => reasons.push(reason));
  assert.equal(token.cancelled, false);
  assert.equal(source.cancel('map changed'), true);
  assert.equal(source.cancel('again'), false, 'cancellation fires once');
  assert.deepEqual(reasons, ['map changed']);
  assert.equal(token.reason, 'map changed');
  assert.throws(() => token.throwIfCancelled(), CancellationError);
  assert.equal(handle.unbind(), false, 'listeners are consumed after cancellation');
  const late = token.onCancelled((reason) => reasons.push(`late:${reason}`));
  assert.equal(late.isValid, false, 'a late listener runs immediately and is already done');
  assert.equal(CancellationToken.none.cancelled, false);
  assert.doesNotThrow(() => CancellationToken.none.throwIfCancelled());

  const pendingSource = new CancellationSource();
  const pending = delay(1000, 'never', pendingSource.token);
  pendingSource.cancel('stop');
  await assert.rejects(pending, CancellationError);
  assert.match(source.describe().name, /level/);
});

test('Async: the scheduler orders by priority, bounds concurrency and settles results', async () => {
  const scheduler = new TaskScheduler({ name: 'Jobs', concurrency: 2 });
  const order = [];
  const low = scheduler.submit('low', () => { order.push('low'); return 1; }, { priority: TaskPriority.Low });
  const high = scheduler.submit('high', () => { order.push('high'); return 2; }, { priority: TaskPriority.High });
  const normal = scheduler.submit('normal', () => { order.push('normal'); return 3; });
  const first = scheduler.drain();
  assert.equal(first.started, 2, 'concurrency is 2');
  assert.equal(first.queued, 1);
  assert.deepEqual(order, ['high', 'normal']);
  assert.ok(high instanceof AsyncTask);
  assert.equal(await high.promise, 2);
  assert.equal(await normal.promise, 3);
  scheduler.drain();
  assert.equal(await low.promise, 1);
  await scheduler.runAll();
  assert.equal(scheduler.completed, 3);
  assert.equal(scheduler.runningCount, 0);
  assert.equal(scheduler.describe().history.length, 3);
  assert.match(scheduler.format(), /Jobs/);
  assert.ok(low.durationMs >= 0);
  assert.equal(low.state, TaskState.Succeeded);
});

test('Async: async work, progress, failures and retries are isolated', async () => {
  const scheduler = new TaskScheduler({ concurrency: 2 });
  const slow = scheduler.submit('slow', async ({ progress, token }) => {
    token.throwIfCancelled();
    await delay(2);
    progress(0.5);
    await delay(2);
    progress(1);
    return 42;
  });
  const report = scheduler.drain();
  assert.equal(report.started, 1);
  assert.equal(scheduler.runningCount, 1, 'promise work stays running until it settles');
  assert.equal(await slow.promise, 42);
  assert.equal(slow.progress, 1);
  assert.equal(slow.state, TaskState.Succeeded);

  let attempts = 0;
  const flaky = scheduler.submit('flaky', () => {
    attempts++;
    if (attempts < 2) throw new Error('transient');
    return 'ok';
  }, { retries: 2 });
  await scheduler.runAll();
  assert.equal(flaky.state, TaskState.Succeeded);
  assert.equal(flaky.attempts, 2);
  assert.equal(scheduler.retried, 1);

  const doomed = scheduler.submit('doomed', async () => { throw new Error('fatal'); });
  await scheduler.runAll();
  assert.equal(doomed.state, TaskState.Failed);
  await assert.rejects(doomed.promise, /fatal/);
  assert.equal(scheduler.failed, 1);
  assert.equal(scheduler.describe().history.at(-1).state, 'failed');
});

test('Async: cancellation, pause/resume, groups and scope teardown', async () => {
  const scheduler = new TaskScheduler({ concurrency: 1 });
  scheduler.pause();
  scheduler.submit('paused', () => 1);
  assert.equal(scheduler.drain().started, 0, 'a paused scheduler starts nothing');
  scheduler.resume();
  assert.equal(scheduler.drain().started, 1);

  const source = new CancellationSource();
  const cancelled = scheduler.submit('cancel', () => 1, { token: source.token, group: 'level' });
  source.cancel('level changed');
  scheduler.drain();
  assert.equal(cancelled.state, TaskState.Cancelled);
  await assert.rejects(cancelled.promise, CancellationError);

  const levelTask = scheduler.submit('level.work', () => 1, { group: 'level' });
  const uiTask = scheduler.submit('ui.work', () => 2, { group: 'ui' });
  assert.equal(scheduler.cancelGroup('level'), 1);
  assert.equal(levelTask.state, TaskState.Cancelled);
  assert.equal(uiTask.state, TaskState.Queued);

  const scope = new AsyncScope(scheduler, 'Level');
  const one = scope.submit('scope.one', () => 1);
  const two = scope.submit('scope.two', () => 2);
  assert.equal(scope.pending, 2);
  assert.equal(scope.dispose(), 2, 'dispose cancels every task it submitted');
  assert.equal(one.state, TaskState.Cancelled);
  assert.equal(two.state, TaskState.Cancelled);
  assert.equal(scope.describe().disposed, true);
  assert.ok(scheduler.cancelAll() >= 1);
  assert.equal(scheduler.activeCount, 0);
  assert.equal(scheduler.cancelled >= 5, true);
});

test('Async: helpers and the worker pool keep bounded concurrency and a stable protocol', async () => {
  const parallelResults = await parallel([() => 1, async () => 2, () => 3], { concurrency: 2 });
  assert.deepEqual(parallelResults.map((row) => row.value), [1, 2, 3], 'input order is preserved');
  assert.ok(parallelResults.every((row) => row.ok));
  assert.deepEqual((await series([() => 4, () => Promise.resolve(5)])).map((row) => row.value), [4, 5]);
  let tries = 0;
  assert.equal(await retry(async () => {
    tries++;
    if (tries < 3) throw new Error('again');
    return 'done';
  }, { attempts: 3 }), 'done');
  assert.equal(tries, 3);
  assert.equal(await delay(1, 'ok'), 'ok');

  let created = 0;
  let busy = 0;
  let maxBusy = 0;
  const pool = new WorkerPool({
    size: 2,
    createWorker: () => {
      created++;
      return {
        postMessage(message) {
          busy++;
          maxBusy = Math.max(maxBusy, busy);
          const value = typeof message.payload === 'number' ? message.payload : message.payload.payload;
          queueMicrotask(() => {
            busy--;
            this.onmessage({ data: { id: message.id, ok: true, result: value * 2 } });
          });
        },
        onmessage: null,
        terminate() {},
      };
    },
  });
  assert.deepEqual(await Promise.all([1, 2, 3, 4].map((value) => pool.execute(value))), [2, 4, 6, 8]);
  assert.equal(created, 2, 'no more than `size` workers are created');
  assert.ok(maxBusy <= 2);
  assert.equal(pool.describe().completed, 4);
  assert.match(pool.format(), /Workers/);

  const scheduler = new TaskScheduler({ concurrency: 2 });
  scheduler.setExecutor(pool.asExecutor());
  const workerTask = scheduler.submit('pool.work', () => null, { metadata: { payload: 21 } });
  await scheduler.runAll();
  assert.equal(await workerTask.promise, 42);
  assert.equal(scheduler.describe().executor, 'custom');
  assert.equal(pool.terminate(), 2);
  await assert.rejects(pool.execute(1), /terminated/);
});

test('Async: console commands and the engine task service', async () => {
  const console_ = new Console();
  const scheduler = new TaskScheduler({ name: 'CmdTasks' });
  const task = scheduler.submit('cmd.work', () => 7);
  scheduler.installConsoleCommands(console_);
  assert.match(console_.exec('tasks', { silent: true }).output, /CmdTasks/);
  assert.match(console_.exec('tasks.drain', { silent: true }).output, /started 1/);
  assert.equal(await task.promise, 7);
  assert.match(console_.exec('tasks.pause false', { silent: true }).output, /tasks running/);
  assert.match(console_.exec('tasks.cancel', { silent: true }).output, /cancelled 0/);
  assert.match(console_.exec('tasks.list', { silent: true }).output, /CmdTasks/);

  const engine = await createEngine({ name: 'TaskEngine', target: 'client', taskConcurrency: 2 });
  assert.ok(engine.tasks instanceof TaskScheduler);
  assert.equal(engine.tasks.concurrency, 2);
  assert.equal(engine.console.hasCommand('tasks'), true);
  const engineTask = engine.tasks.submit('engine.work', () => 'done');
  engine.frame(DT);
  assert.equal(await engineTask.promise, 'done', 'the engine pumps tasks on its frame');
  assert.equal(engine.describe().tasks.completed, 1);
  assert.match(engine.format(), /tasks/);
  const replaced = engine.createTaskScheduler({ name: 'Other', concurrency: 3 });
  assert.equal(replaced.concurrency, 3);
  await engine.shutdown();
});

// ---------------------------------------------------------------------- shared field schema

test('Schema: field vocabulary validates primitives, vectors, arrays and unknown types', () => {
  assert.equal(validateField('u8', 200), null);
  assert.match(validateField('u8', 300), /outside u8/);
  assert.match(validateField('i8', 1.5), /integer/);
  assert.equal(validateField('f32', 0.5), null);
  assert.match(validateField('f32', Number.NaN), /finite number/);
  assert.equal(validateField('bool', false), null);
  assert.match(validateField('bool', 0), /boolean/);
  assert.equal(validateField('vec3', [1, 2, 3]), null);
  assert.equal(validateField('vec3', { x: 1, y: 2, z: 3 }), null);
  assert.match(validateField('vec3', [1, 2]), /needs 3/);
  assert.equal(validateField('array:u8', [1, 2, 255]), null);
  assert.match(validateField('array:u8', [1, 999]), /\[1\] is outside u8/);
  assert.equal(validateField('enum:primary|secondary', 'anything'), null, 'enums are forward compatible');
  assert.equal(validateField('struct:WeaponRow', { a: 1 }), null);
  assert.equal(validateField('future:type', Symbol('x')), null, 'unknown types never reject a save');
  assert.deepEqual(INTEGER_RANGES.u16, [0, 65535]);
  assert.ok(FIELD_TYPES.includes('array'));
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject(new Map()), false);
  assert.equal(describeFieldTypes().types.length, FIELD_TYPES.length);
});

test('Schema: coercion parses textual fields and object validation reports every issue', () => {
  assert.equal(coerceField('u8', ' 24 '), 24);
  assert.equal(coerceField('f32', '0.125'), 0.125);
  assert.equal(coerceField('u8', 'nope'), undefined);
  assert.equal(coerceField('bool', 'yes'), true);
  assert.equal(coerceField('bool', 'off'), false);
  assert.equal(coerceField('bool', 'maybe'), undefined);
  assert.deepEqual(coerceField('vec3', '1,2,3'), [1, 2, 3]);
  assert.deepEqual(coerceField('array:string', '["primary","sidearm"]'), ['primary', 'sidearm']);
  assert.deepEqual(coerceField('json', '{"a":1}'), { a: 1 });
  assert.equal(coerceField('json', 'plain text'), 'plain text');

  const schema = { hp: 'u8', name: 'string' };
  assert.deepEqual(validateObject(schema, { hp: 10, name: 'Bot' }), []);
  assert.deepEqual(validateObject(schema, { hp: 10 }), ['name is missing']);
  assert.deepEqual(validateObject(schema, { hp: 10, name: 'Bot' }, { pathPrefix: 'Row' }), []);
  assert.match(validateObject(schema, { hp: 999, name: 'Bot' }, { pathPrefix: 'Row' })[0], /Row.hp/);
  assert.deepEqual(validateObject(schema, { hp: 1, name: 'x', extra: true }, { allowMissing: true, allowExtra: false }), ['extra is not declared']);
  assert.deepEqual(validateObject(schema, null), ['value should be an object']);
  const coerced = coerceObject(schema, { hp: '7', name: 'Bot' });
  assert.deepEqual(coerced.value, { hp: 7, name: 'Bot' });
  assert.deepEqual(coerced.errors, []);
  assert.match(coerceObject(schema, { hp: 'abc', name: 'Bot' }).errors[0], /cannot parse/);
});

// ---------------------------------------------------------------------- diagnostics

test('Diagnostics: assertion levels, codes, fatal handler and bounded deduplication', () => {
  const hub = new DiagnosticHub({ name: 'TestDiagnostics', capacity: 8 });
  let fatal = null;
  hub.setFatalHandler((error) => { fatal = error; });
  assert.throws(() => hub.checkFailed('invariant broke', { frame: 4 }), (error) => error instanceof EngineError && error.code === 'E_CHECK');
  assert.equal(fatal.code, 'E_CHECK');
  assert.equal(fatal.context.frame, 4);
  assert.deepEqual(describeError(fatal).code, 'E_CHECK');
  assert.equal(describeError('oops').name, 'ThrownValue');

  for (let i = 0; i < 3; i++) hub.ensureFailed('once per call site');
  assert.equal(hub.describe().counts.warning, 1, 'a repeated ensure at one call site is deduplicated');
  assert.equal(hub.suppressed, 2);
  assert.equal(hub.ensureFailed('always', null, { always: true }), false);
  assert.equal(hub.describe().counts.warning, 2);

  assert.deepEqual(hub.guard(() => JSON.parse('bad'), { code: 'E_PARSE', fallback: {} }), {});
  assert.equal(hub.scope('work', () => 42, { budgetMs: 0 }), 42);
  assert.equal(hub.lastScope.name, 'work');
  assert.throws(() => hub.guard(() => { throw new Error('rethrow me'); }, { rethrow: true, fallback: 1 }), /rethrow me/);

  registerErrorCode('E_TEST_CUSTOM', { description: 'test code', level: DiagnosticLevel.Warning });
  assert.equal(getErrorCode('E_TEST_CUSTOM').description, 'test code');
  assert.ok(listErrorCodes().some((entry) => entry.code === 'E_TEST_CUSTOM'));
  hub.setMinLevel(DiagnosticLevel.Error);
  assert.equal(hub.report({ level: DiagnosticLevel.Info, code: 'E_INFO', message: 'filtered' }), null);
  assert.ok(hub.report({ level: DiagnosticLevel.Error, code: 'E_INFO', message: 'kept' }));
  assert.equal(hub.clear() > 0, true);
  assert.equal(hub.describe().total, 0);
  assert.match(hub.format(), /TestDiagnostics/);
});

test('Diagnostics: formatMessage, module-level helpers and console commands', () => {
  assert.equal(formatMessage('x={x} 0={0} {}', { x: 5, 0: 'zero' }), 'x=5 0=zero {}');
  assert.equal(formatMessage('{0} then {1}', ['a', 'b']), 'a then b');
  assert.equal(formatMessage('{missing}', {}), '{missing}');
  assert.equal(check(true, 'ok'), true);
  assert.throws(() => check(false, 'bad'), (error) => error instanceof EngineError && error.code === 'E_CHECK');
  assert.equal(verify(true), true);
  assert.equal(ensure(false, 'once'), false);
  assert.deepEqual(guard(() => JSON.parse('bad'), { code: 'E_PARSE', fallback: {} }), {});
  assert.equal(diagnosticScope('scope.work', () => 7), 7);

  const console_ = new Console();
  const hub = new DiagnosticHub({ name: 'CmdDiagnostics' });
  hub.installConsoleCommands(console_);
  assert.match(console_.exec('diag', { silent: true }).output, /CmdDiagnostics/);
  assert.match(console_.exec('diag.codes', { silent: true }).output, /E_CHECK/);
  assert.match(console_.exec('diag.throw hello', { silent: true }).output, /E_TEST/);
  assert.equal(console_.exec('diag.errors', { silent: true }).ok, true);
  assert.match(console_.exec('diag.level error', { silent: true }).output, /error/);
  assert.equal(hub.minLevel, DiagnosticLevel.Error);
  assert.match(console_.exec('diag.clear', { silent: true }).output, /cleared/);
  assert.ok(diagnostics instanceof DiagnosticHub, 'the module-level helpers share a hub');
});

// ---------------------------------------------------------------------- data registry

const WEAPON_SCHEMA = Object.freeze({
  name: 'string', damage: 'u8', rpm: 'u16', spread: 'f32', tags: 'array:string',
});

test('DataRegistry: typed rows, validation, query, diff and CSV round-trip', () => {
  const registry = new DataRegistry({ name: 'GameData' });
  const table = registry.define('Weapons', WEAPON_SCHEMA, { keyField: 'id' });
  assert.ok(table instanceof DataTable);
  assert.equal(table.add('rifle', { name: 'Rifle', damage: 24, rpm: 600, spread: 0.02, tags: ['primary'] }).id, 'rifle');
  assert.ok(table.add('pistol', { name: 'Pistol', damage: 18, rpm: 300, spread: 0.05, tags: ['sidearm'] }));
  assert.equal(table.add('bad', { name: 'Bad', damage: 999, rpm: 1, spread: 0, tags: [] }), null, 'u8 overflow is rejected');
  assert.ok(table.lastErrors.length);
  assert.equal(table.count, 2);
  assert.equal(registry.lookup('Weapons', 'rifle').damage, 24);
  assert.equal(registry.query('Weapons', { where: { rpm: 300 } }).length, 1);
  assert.deepEqual(table.query({ sort: { field: 'damage', descending: true } }).map((row) => row.id), ['rifle', 'pistol']);
  assert.deepEqual(table.query({ where: (row) => row.damage > 20, limit: 1 }).map((row) => row.id), ['rifle']);
  assert.ok(table.find((row) => row.name === 'Pistol'));
  assert.deepEqual(table.validate(), []);
  assert.deepEqual(registry.validate(), { total: 0, byTable: {} });

  const copy = table.clone('Copy');
  assert.deepEqual(copy.diff(table), { added: [], removed: [], changed: [] });
  copy.add('smg', { name: 'SMG', damage: 14, rpm: 900, spread: 0.08, tags: ['primary'] });
  assert.deepEqual(copy.diff(table).added, ['smg']);
  assert.equal(copy.remove('smg'), true);

  const csv = table.toCsv();
  assert.match(csv, /^id,name,damage,rpm,spread,tags/);
  const restored = new DataRegistry();
  assert.deepEqual(restored.loadFromText('Weapons', csv, { format: 'csv', schema: WEAPON_SCHEMA, keyField: 'id' }), { loaded: 2, errors: [] });
  assert.equal(restored.lookup('Weapons', 'rifle').damage, 24);
  assert.deepEqual(restored.lookup('Weapons', 'pistol').tags, ['sidearm']);
  assert.deepEqual(restored.validate(), { total: 0, byTable: {} });

  assert.deepEqual(parseCsv('a,b\n"x,y","he said ""hi"""\n'), [['a', 'b'], ['x,y', 'he said "hi"']]);
  assert.deepEqual(parseCsv('# comment\nid,name\n1,One\n'), [['id', 'name'], ['1', 'One']]);
});

test('DataRegistry: JSON export/import, async sources and console reachability', async () => {
  const registry = new DataRegistry({ name: 'GameData' });
  const table = registry.define('Weapons', WEAPON_SCHEMA, { keyField: 'id' });
  table.add('rifle', { name: 'Rifle', damage: 24, rpm: 600, spread: 0.02, tags: ['primary'] });
  const exported = registry.exportAll();
  assert.match(exported, /ominx-data/);
  const imported = new DataRegistry();
  assert.equal(imported.importAll(exported), 1);
  assert.equal(imported.lookup('Weapons', 'rifle').name, 'Rifle');
  assert.equal(imported.importAll('{"format":"other"}'), 0);
  assert.equal(imported.describe().rows, 1);
  assert.match(imported.format(), /1 rows/);

  let loaded = 0;
  const lazy = new DataRegistry();
  lazy.registerSource('Weapons', {
    format: 'csv', schema: WEAPON_SCHEMA, keyField: 'id',
    loader: async () => { loaded++; return table.toCsv(); },
  });
  const results = await lazy.loadAll();
  assert.equal(loaded, 1);
  assert.equal(results[0].table.count, 1);
  assert.equal(lazy.lookup('Weapons', 'rifle').damage, 24);
  assert.equal(lazy.loadedCount, 1);
  assert.equal(await lazy.load('Missing'), null);

  const console_ = new Console();
  registry.installConsoleCommands(console_);
  assert.match(console_.exec('data', { silent: true }).output, /GameData/);
  assert.match(console_.exec('data.get Weapons rifle', { silent: true }).output, /Rifle/);
  assert.match(console_.exec('data.query Weapons rpm=600', { silent: true }).output, /rifle/);
  assert.match(console_.exec('data.csv Weapons', { silent: true }).output, /^id,name/);
  assert.match(console_.exec('data.validate', { silent: true }).output, /valid/);
  assert.equal(console_.exec('data.get Missing', { silent: true }).ok, true);
  assert.ok(dataEvents.onLoaded instanceof Object);
});

// ---------------------------------------------------------------------- replication

test('Replication: role-aware deltas, stale detection, conflicts and snapshots', () => {
  const server = new ReplicationSystem({ mode: NetMode.Server, localRole: NetRole.Authority });
  const actor = server.register(7, { classId: 'Player', role: NetRole.Authority, properties: { health: 100, team: 'red' } });
  assert.ok(actor instanceof ReplicatedObject);
  assert.equal(actor.isAuthority, true);
  assert.equal(server.setProperty(7, 'health', 82), true);
  assert.equal(server.setProperty(7, 'team', 'red'), false, 'an unchanged property stays clean');
  assert.equal(actor.dirtyCount, 1);
  const deltas = server.collectDeltas();
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0].properties, { health: 82 });
  assert.equal(server.collectDeltas().length, 0, 'dirty flags are cleared after one flush');

  const client = new ReplicationSystem({ mode: NetMode.Client, localRole: NetRole.SimulatedProxy });
  const report = client.applyDeltas(deltas);
  assert.equal(report.created, 1);
  assert.equal(report.applied, 1);
  assert.equal(client.get(7).role, NetRole.SimulatedProxy);
  assert.equal(client.get(7).snapshot().health, 82);
  assert.equal(client.applyDeltas(deltas).stale, 1, 'a repeated delta is stale');

  const authority = new ReplicationSystem({ mode: NetMode.Server, localRole: NetRole.Authority });
  authority.register(7, { role: NetRole.Authority, properties: { health: 100 } });
  assert.equal(authority.applyDeltas(deltas).conflicts, 1, 'local authority refuses a remote delta');
  assert.equal(authority.get(7).snapshot().health, 100);

  const snapshot = server.snapshot();
  assert.equal(snapshot.format, 'ominx-replication');
  const lateJoin = new ReplicationSystem();
  assert.equal(lateJoin.loadSnapshot(JSON.stringify(snapshot)), 1);
  assert.equal(lateJoin.get(7).snapshot().team, 'red');
  assert.throws(() => lateJoin.loadSnapshot('{"format":"other"}'), /not an OminX/);

  server.setRelevancyFilter((object, viewer) => object.netId === viewer?.id);
  server.setProperty(7, 'health', 50);
  assert.equal(server.collectDeltas({ viewer: { id: 99 } }).length, 0, 'irrelevant objects stay dormant');
  assert.equal(server.collectDeltas({ viewer: { id: 7 } }).length, 1, 'the dirty property survives until relevant');
  assert.match(server.format(), /authority/);
  assert.equal(server.describe().objects, 1);
  assert.ok(replicationEvents.onDelta instanceof Object);
});

test('Replication: ordered reliable channels and bounded resend windows', () => {
  const channel = new NetChannel({ name: 'state', capacity: 4 });
  const a = channel.send({ x: 1 });
  const b = channel.send({ x: 2 });
  const c = channel.send({ x: 3 });
  assert.equal(channel.receive(c).length, 0, 'a gap is held');
  assert.equal(channel.gapCount, 1);
  assert.equal(channel.receive(b).length, 0);
  assert.deepEqual(channel.receive(a).map((record) => record.payload.x), [1, 2, 3], 'delivered in send order');
  assert.equal(channel.receive(a).length, 0);
  assert.equal(channel.duplicates, 1);
  assert.equal(channel.ack(3), 3);
  assert.equal(channel.unacknowledged().length, 0);
  assert.equal(channel.describe().delivered, 3);

  const lossy = new NetChannel({ name: 'effects', reliable: false });
  assert.deepEqual(lossy.receive(lossy.send({ fx: 'tracer' })).map((record) => record.payload.fx), ['tracer']);
  assert.equal(lossy.pending.length, 0, 'unreliable records are not retained');

  for (let i = 0; i < 8; i++) channel.send({ i });
  assert.equal(channel.dropped, 4, 'capacity drops the oldest pending records');
  assert.ok(channel.lastError);
});

test('Replication: RPC dispatch, error isolation and console commands', () => {
  const net = new ReplicationSystem({ name: 'RpcNet' });
  net.register(7, { classId: 'Player', properties: { health: 100 } });
  const received = [];
  const handle = net.onRpc(7, 'fire', (args) => received.push(args));
  const rpc = net.queueRpc(7, 'fire', { weapon: 'rifle' }, { target: RpcTarget.All });
  assert.equal(rpc.target, RpcTarget.All);
  assert.equal(net.drainRpcs().length, 1);
  assert.equal(net.drainRpcs().length, 0);
  assert.equal(net.receiveRpc(rpc).handled, 1);
  assert.deepEqual(received, [{ weapon: 'rifle' }]);
  assert.equal(handle.unbind(), true);
  assert.equal(net.receiveRpc(rpc).handled, 0);
  assert.equal(net.unhandledRpcs, 1);

  net.onRpc(7, 'boom', () => { throw new Error('bad handler'); });
  net.onRpc(7, 'boom', () => received.push('ok'));
  const result = net.receiveRpc(net.queueRpc(7, 'boom', {}));
  assert.equal(result.handled, 1, 'one throwing handler does not block the next');
  assert.equal(net.errors.length, 1);
  assert.equal(received[received.length - 1], 'ok');

  const console_ = new Console();
  net.installConsoleCommands(console_);
  assert.match(console_.exec('net', { silent: true }).output, /RpcNet/);
  assert.match(console_.exec('net.actors', { silent: true }).output, /netId/);
  assert.match(console_.exec('net.channels', { silent: true }).output, /state/);
  assert.match(console_.exec('net.tick 3', { silent: true }).output, /net tick 3/);
  assert.equal(net.tickCount, 3);
});

// ---------------------------------------------------------------------- engine wiring

test('Engine: diagnostics, data tables and replication are boot-wired to the frame and console', async () => {
  const engine = await createEngine({ name: 'NetEngine', target: 'client', netMode: NetMode.Server, netRole: NetRole.Authority });
  assert.ok(engine.diagnostics instanceof DiagnosticHub);
  assert.ok(engine.data instanceof DataRegistry);
  assert.ok(engine.replication instanceof ReplicationSystem);
  for (const command of ['diag', 'diag.codes', 'diag.errors', 'data', 'data.get', 'data.validate', 'net', 'net.actors', 'net.channels', 'net.set', 'net.flush']) {
    assert.equal(engine.console.hasCommand(command), true, `${command} must be reachable`);
  }

  engine.data.define('Weapons', WEAPON_SCHEMA, { keyField: 'id' });
  engine.data.get('Weapons').add('rifle', { name: 'Rifle', damage: 24, rpm: 600, spread: 0.02, tags: [] });
  engine.replication.register(1, { classId: 'Bot', role: NetRole.Authority, properties: { hp: 10 } });
  engine.replication.setProperty(1, 'hp', 9);
  engine.frame(DT);
  assert.equal(engine.replication.tickCount, 1, 'replication ticks on the fixed simulation clock');
  assert.equal(engine.describe().data.tables, 1);
  assert.equal(engine.describe().data.rows, 1);
  assert.equal(engine.describe().replication.objects, 1);
  assert.match(engine.format(), /data 1 tables/);
  assert.match(engine.format(), /net 1 objects/);
  assert.match(engine.console.exec('data.validate', { silent: true }).output, /valid/);
  assert.match(engine.console.exec('net.flush', { silent: true }).output, /hp/);

  const replaced = engine.createReplicationSystem({ name: 'OtherNet', mode: NetMode.Client });
  assert.equal(replaced.name, 'OtherNet');
  assert.equal(engine.replication, replaced);
  const data = engine.createDataRegistry({ name: 'OtherData' });
  assert.equal(data.name, 'OtherData');
  await engine.shutdown();
});

// ---------------------------------------------------------------------- world / actors / components

function near(actual, expected, tolerance = 1e-6) {
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${actual[i]} ≈ ${expected[i]}`);
}

test('World: actor lifecycle, components, tick groups and isolated errors', () => {
  const world = new World({ name: 'LifecycleWorld' });
  const events = [];
  const actor = world.spawnActor({ name: 'Actor1', className: 'TestActor' });
  assert.ok(actor instanceof Actor);
  assert.equal(actor.state, ActorLifecycle.Playing, 'spawning into a running world begins play');
  assert.equal(actor.components.length, 1, 'an actor always has a root scene component');
  assert.ok(actor.root instanceof SceneComponent);
  assert.deepEqual(TICK_GROUP_ORDER, [TickGroup.PrePhysics, TickGroup.DuringPhysics, TickGroup.PostPhysics, TickGroup.PostUpdateWork]);

  const order = [];
  const pre = actor.addComponent(new ActorComponent({
    name: 'pre', tickGroup: TickGroup.PrePhysics, tickEnabled: true,
    hooks: { onBeginPlay: () => events.push('begin'), onEndPlay: () => events.push('end'), onTick: () => order.push('pre') },
  }));
  pre.beginPlay();
  actor.addComponent(new ActorComponent({ name: 'post', tickGroup: TickGroup.PostUpdateWork, tickEnabled: true, hooks: { onTick: () => order.push('post') } }));
  const boom = actor.addComponent(new ActorComponent({
    name: 'boom', tickGroup: TickGroup.DuringPhysics, tickEnabled: true,
    hooks: { onTick: () => { throw new Error('bad tick'); } },
  }));
  const slow = actor.addComponent(new ActorComponent({ name: 'slow', tickEnabled: true, tickInterval: 0.05, hooks: { onTick: () => order.push('slow') } }));

  world.tick(DT);
  assert.deepEqual(order, ['pre', 'post'], 'tick groups dispatch in order');
  assert.equal(boom.lastError, 'bad tick', 'a throwing component records its own error');
  assert.equal(world.errors.length, 0, 'a bad component does not fail the world');
  assert.equal(world.ticksDispatched, 3);
  world.runFixedFrames(2, DT);
  assert.equal(slow.tickCount, 1, 'a tick interval accumulates across fixed steps');
  assert.ok(events.includes('begin'));

  assert.equal(actor.getComponent('post').name, 'post');
  assert.equal(actor.getComponent(ActorComponent), actor.root, 'the root scene component is an ActorComponent');
  assert.equal(actor.removeComponent(boom), true);
  assert.equal(actor.components.includes(boom), false);
  assert.equal(actor.tickGroup(TickGroup.DuringPhysics, DT), 0);

  worldEvents.onActorSpawned.broadcast(actor, world);
  assert.equal(world.endPlay(), world);
  assert.equal(actor.endPlay(), actor);
  assert.equal(world.beginPlay(), world);
  assert.equal(actor.state, ActorLifecycle.EndedPlay, 'beginPlay() does not resurrect an ended actor');
  assert.ok(worldEvents.onTickGroup instanceof Object);
});

test('World: scene component hierarchy composes transforms and keepWorld attachment preserves placement', () => {
  const world = new World({ name: 'HierarchyWorld' });
  const parent = world.spawnActor({ name: 'Parent' });
  parent.setPosition(0, 2, -10);
  const child = new SceneComponent({ name: 'Child' });
  child.setPosition(0, 0, -1);
  assert.equal(child.attachTo(parent.root), true);
  near(child.getWorldPosition().toJSON(), [0, 2, -11]);
  assert.equal(parent.root.children.length, 1);
  assert.equal(child.descendants().length, 0);

  const grandchild = new SceneComponent({ name: 'Grandchild' });
  grandchild.setPosition(1, 0, 0);
  grandchild.attachTo(child);
  near(grandchild.getWorldPosition().toJSON(), [1, 2, -11]);
  assert.equal(parent.root.descendants().length, 2);
  assert.throws(() => child.attachTo(grandchild), /cycle/);

  const beforeRotation = grandchild.getWorldPosition().toJSON();
  parent.root.rotateY(90);
  const rotated = grandchild.getWorldPosition().toJSON();
  assert.ok(rotated.some((value, index) => Math.abs(value - beforeRotation[index]) > 0.1), 'a parent rotation moves attached children');

  const before = grandchild.getWorldPosition().toJSON();
  const newParent = world.spawnActor({ name: 'NewParent' });
  newParent.setPosition(10, 5, 0);
  assert.equal(grandchild.attachTo(newParent.root, { keepWorld: true }), true);
  near(grandchild.getWorldPosition().toJSON(), before);
  assert.equal(newParent.root.children.length, 1);
  assert.equal(child.children.length, 0);
  assert.equal(grandchild.detach(), true);
  assert.equal(grandchild.detach(), false);
  assert.match(child.describe().worldPosition.length + '', /3/);
});

test('World: queries, tags, levels, lifespan and actor destruction', () => {
  const world = new World({ name: 'QueryWorld' });
  const red = world.spawnActor({ name: 'RedSpawn', className: 'PlayerStart', tags: ['spawn', 'red'] }, { level: 'Arena' });
  world.spawnActor({ name: 'BlueSpawn', className: 'PlayerStart', tags: ['spawn', 'blue'] }, { level: 'Arena' });
  world.spawnActor({ name: 'Crate', className: 'Prop' }, { level: 'Props' });
  assert.equal(world.count, 3);
  assert.equal(world.actorsWithTag('spawn').length, 2);
  assert.equal(world.actorsOfClass('PlayerStart').length, 2);
  assert.equal(world.findActor('RedSpawn'), red);
  assert.equal(red.addTag('team'), red);
  assert.equal(red.hasTag('team'), true);
  assert.equal(red.removeTag('team'), true);
  assert.equal(world.levels.get('Arena').actors.size, 2);
  assert.equal(world.loadLevel('Arena').name, 'Arena');
  assert.equal(world.unloadLevel('Arena'), 2);
  assert.equal(world.count, 1);

  const temp = world.spawnActor({ name: 'Temp', lifespan: 0.05 });
  world.runFixedFrames(4, 0.02);
  assert.equal(temp.isDestroyed, true, 'a lifespan expires after the elapsed time');
  assert.equal(world.destroyActor(temp), false, 'destroying twice is a no-op');
  const doomed = world.spawnActor({ name: 'Doomed' });
  assert.equal(doomed.destroy(), true);
  assert.equal(doomed.state, ActorLifecycle.Destroyed);
  assert.equal(world.describe().destroyed, 4);
  assert.match(world.format(), /QueryWorld/);
});

test('World: replication binding, net deltas and portable snapshots', () => {
  const net = new ReplicationSystem({ mode: NetMode.Server, localRole: NetRole.Authority });
  const world = new World({ name: 'ArenaWorld', replication: net });
  const actor = world.spawnActor({ name: 'Player', className: 'Player', tags: ['local'] }, {
    replicate: true, properties: { health: 100 },
  });
  assert.equal(actor.netId, 1);
  assert.equal(net.has(1), true);
  assert.equal(actor.getReplicated('health'), 100);
  actor.setPosition(3, 1, -4);
  actor.setReplicated('health', 82);
  const deltas = world.collectNetDeltas();
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0].properties, { health: 82 });

  const snapshot = world.snapshot();
  assert.equal(snapshot.format, 'ominx-world');
  assert.equal(snapshot.actors.length, 1);
  const restored = new World({ name: 'Restored', replication: new ReplicationSystem() });
  assert.equal(restored.loadSnapshot(JSON.stringify(snapshot)), 1);
  const copy = restored.findActor('Player');
  assert.equal(copy.getReplicated('health'), 82);
  near(copy.getWorldPosition().toJSON(), [3, 1, -4]);
  assert.equal(copy.hasTag('local'), true);
  assert.throws(() => restored.loadSnapshot('{"format":"other"}'), /not an OminX/);

  assert.equal(world.destroyActor(actor), true);
  assert.equal(net.has(1), false, 'destroying an actor unregisters its replicated object');
  assert.equal(world.bindReplication(null).replication, null);
});

test('World: console commands and the engine world service', async () => {
  const console_ = new Console();
  const world = new World({ name: 'CmdWorld' });
  world.installConsoleCommands(console_);
  assert.match(console_.exec('world', { silent: true }).output, /CmdWorld/);
  assert.match(console_.exec('world.spawn Test Bot', { silent: true }).output, /spawned/);
  assert.equal(world.count, 1);
  assert.match(console_.exec('world.actors', { silent: true }).output, /actorId/);
  assert.match(console_.exec('world.levels', { silent: true }).output, /PersistentLevel/);
  assert.match(console_.exec('world.tick 3', { silent: true }).output, /world tick 3/);
  assert.match(console_.exec('world.net', { silent: true }).output, /\[\]/);
  assert.equal(console_.exec('world.destroy 999', { silent: true }).ok, true);

  const engine = await createEngine({ name: 'WorldEngine', target: 'client' });
  assert.ok(engine.world instanceof World);
  for (const command of ['world', 'world.actors', 'world.spawn', 'world.destroy', 'world.levels', 'world.tick', 'world.net']) {
    assert.equal(engine.console.hasCommand(command), true, `${command} must be reachable`);
  }
  const actor = engine.world.spawnActor({ name: 'Bot', className: 'Bot' }, { replicate: true });
  actor.addComponent(new ActorComponent({ name: 'think', tickEnabled: true, hooks: { onTick: () => {} } }));
  engine.frame(DT);
  assert.equal(engine.world.tickCount, 1, 'the world ticks on the fixed simulation step');
  assert.equal(engine.describe().world.actors, 1);
  assert.equal(engine.describe().world.errors, 0);
  assert.match(engine.format(), /world OminXWorld/);
  actor.setReplicated('alive', true);
  assert.equal(engine.console.exec('world.net', { silent: true }).ok, true);
  const replaced = engine.createWorld({ name: 'OtherWorld' });
  assert.equal(replaced.name, 'OtherWorld');
  assert.equal(engine.world, replaced);
  await engine.shutdown();
});
