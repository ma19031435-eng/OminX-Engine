# OminX Engine — Core

The core is the part of the engine that does not know what a gun is. It is the object model,
lifetime management, configuration, content, scheduling, composition and profiling that everything
else — renderer, physics, gameplay, editor — is built out of. It runs headless, it runs in a browser,
and it is testable without a GPU: `node --test tests/core.test.js` is 84 tests in ~0.5 s.

## Layering

Nothing below depends on anything above. That rule is what lets the core boot in a Node process, in
a worker, or inside a 4 ms frame budget.

| Layer | Modules | Responsibility |
| --- | --- | --- |
| 1 — Foundations | `Logger` `Delegate` `Signal` `Containers` `Stats` `Trace` | Logging, event delivery, data structures, measurement |
| 2 — Object model | `Object` `GarbageCollector` `Memory` | Reflection, identity, lifetimes, allocation |
| 3 — Services | `Config` `Console` `AssetRegistry` `Localization` `JobGraph` `TimerManager` `Curve` `EventBus` `Async` | Settings, commands, content, text, frame work, timing, feel, messaging, off-frame work |
| 4 — Composition | `Subsystem` `ModuleManager` `Plugin` | What the engine is made of, and how it is extended |
| 5 — Runtime | `Scheduler` `EngineCore` `InputMapping` `Replay` `Archive` `SaveGame` | One clock, one engine object, input, playback, serialization, saved games |

```js
import {
  createEngine, reflectClass, Object, Subsystem, LOCTEXT, Keys, createShooterContext,
} from './engine/src/core/index.js';
```

`CORE_MODULES` in `index.js` is the machine-readable version of the table above — it is what the
report tool prints and what a test asserts stays in sync.

## Design rules

1. **Explicit lifecycles.** Every subsystem goes `created → initializing → ready → deinitializing →
   dead`, and every engine goes `PreInit → Init → PostInit → Running → Shutdown`. Nothing starts
   implicitly, and initialization is reversible (`engine.restart()` re-initializes the same graph).
2. **Errors are isolated, not fatal.** A throwing delegate listener, job, module, plugin or console
   command is recorded where it happened and the rest of the engine keeps running. `describe()`
   on any core object reports what went wrong.
3. **Nothing is unbounded.** Traces ring-buffer, console output is capped, log buffers are capped,
   asset loads dedupe, job graph concurrency is bounded.
4. **Off means free.** `stats.setEnabled(false)` and `trace.stop()` leave a boolean check on the hot
   path and nothing else.
5. **Determinism is a feature.** Fixed-step simulation, ordered callbacks with stable tie-breaks,
   sorted registries, and `runFixedFrames()` for tests.

## Module reference

### Logger (`Logger.js`)
Levelled, channelled logging with a bounded buffer and an event stream.

```js
const log = createLogger('Physics');   // channel: OminX.Physics
log.debug('broadphase', { pairs: 412 });
setLogLevel('warn');                   // reaches every channel already handed out
```

### Delegate (`Delegate.js`) and Signal (`Signal.js`)
Two event flavours, on purpose. `Delegate` is the UE model: bind a function or an object's method,
execute one or broadcast to many, with priorities.

```js
multicast.add(cameraShake, 'onHit', { priority: 10 });  // higher priority first
multicast.broadcast(hitInfo);
```

`Signal` is the Roblox model (`connect`, `fire`, `wait`) and is what the `Scheduler` phases use.
Both isolate listener errors, both defer structural changes made during dispatch, and both hold
object-bound listeners weakly so a delegate never keeps a dead object alive.

### Containers (`Containers.js`)
`ObjectPool`, `FixedPool`, `RingBuffer`, `Deque`, `PriorityQueue`, `SparseSet`, `FreeList`, `BitSet`,
`SpatialHashGrid`, `LRUCache`, `SlotMap`. Written for frame-time use: no allocation on the hot path,
documented overflow semantics (a `FixedPool` refuses past capacity instead of growing), and
`SlotMap`/`FreeList` generation guards that catch use-after-free.

### Stats (`Stats.js`) and Trace (`Trace.js`)
`Stats` is the always-cheap measurement layer (counters, gauges, accumulations, histograms, frame
capture). `Trace` is the profiler: scoped events with categories, instants, counters, frame markers
and a Chrome/Perfetto export.

```js
stats.count('Shots/Fired');
trace.scope('PhysicsStep', 'physics', () => world.step(dt));
trace.exportChrome();       // → chrome://tracing
```

The engine wires the two together: jobs record a `job` scope, subsystem dispatch records `engine`
scopes, and every frame emits a marker.

### Memory (`Memory.js`)
A JS engine cannot own its allocator, but it owns how much garbage it makes — and a GC pause is a
40 ms frozen crosshair.

```js
const scratch = engine.frameArena.allocFloat64(3 * botCount);   // no garbage, freed by the frame
const block = memory.getPool('audio').acquireF32(1024);          // reused, not reallocated
memory.getPool('audio').release(block);
memory.track('textures', bytes);                                 // accounting, per category
memory.budget('textures', 256 * 1024 * 1024);                    // warn when a category grows past it
memory.measure('LevelLoad', () => loadLevel());                  // what did that cost?
```

`FrameArena` is a bump allocator over one `ArrayBuffer` (typed views, mark/release, automatic reset
at the frame boundary, growth on demand, a non-growing mode that refuses instead of throwing).
`BufferPool` is size-classed typed-buffer reuse with leak reporting. `MemoryTracker` accounts bytes
per category, checks budgets, samples the real JS heap where the host exposes it, and answers
"has the last minute of frames leaked?" with `leakCheck()`.

### Object (`Object.js`) and GarbageCollector (`GarbageCollector.js`)
The reflection model: classes, hierarchy, typed properties, events, methods, categories, tags.

```js
class Actor extends Object {}
reflectClass(Actor, {
  parent: Object, category: ClassCategory.Gameplay,
  properties: [{ name: 'health', type: 'number', default: 100 }],
  events: [{ name: 'onDied' }],
});
const info = getClassInfo(Actor);
info.allProperties();          // Map, inherited included, subclass overrides win
info.hierarchy();              // [Object, Actor]
info.isChildOf(Object);        // true
```

Members may be declared as an array of `{ name, … }` descriptors or as a `{ name: … }` map; the class
name must be an *own* static (`static ClassName`), never inherited — both are enforced, because both
have silently corrupted class directories in the wild.

Lifetimes are explicit: `ObjectHandle` (strong, pins), `WeakHandle` (observes), `ObjectScope`
(ownership trees: a level scope destroys its children), `Collector.markPendingKill` + `sweep()`
(deferred destruction at a frame boundary so no callback observes a half-dead object).

### Config (`Config.js`)
Six layers — defaults, engine, project, user, command line, runtime — with schema validation,
provenance and change notification.

```js
config.define('renderer.fov', { default: 90, min: 60, max: 130, group: 'Renderer', requiresRestart: true });
config.on('renderer.*', (value, previous, key) => renderer.setFov(value));
config.apply(parseCommandLine(argv), { layer: ConfigLayer.CommandLine });
config.origin('renderer.fov');   // { layer: 'commandline', value: 110 }
```

Out-of-range values are rejected with the offending layer named, and the previous value stays — a
bad settings file must not produce a broken client. `toText()`/`loadText()` round-trip the INI format.

### Console (`Console.js`)
Commands, variables (config keys are variables automatically), aliases with `$1…$9`, tab completion,
statement lists (`;`), quoted arguments, `--flags`, and a bounded output buffer plus an event stream
that the HUD, a DOM overlay and CI all read.

```js
engine.console.exec('renderer.fov 110; engine.gc; trace on physics');
```

Argument specs are validated (`{ name: 'count', type: 'int', min: 1, max: 32 }`), usage is generated,
and a throwing or async command cannot take the engine down.

### AssetRegistry (`AssetRegistry.js`)
Identity is a path (`/Game/Maps/Arena`). Assets are registered with metadata first (an editor content
browser or a streaming manifest needs to know what exists without loading it), then loaded through a
type-specific loader.

```js
registry.registerType({ name: 'map', extensions: ['.map'], loader: async (entry) => parseMap(entry) });
registry.scan(manifest);
const handle = await registry.loadHandle('/Game/Maps/Arena.map');   // reference counted
const soft = registry.soft('/Game/Maps/Dust.map');                  // resolve later
registry.collectGarbage();                                          // unreferenced assets only
```

Bundles group assets (a level's textures), dependencies load first, concurrent loads of one path are
deduped into a single promise, derived data (nav mesh, cooked meshes) is cached and invalidated by
content hash, and a failed load is remembered instead of retried every frame.

### Localization (`Localization.js`)
Culture with a fallback chain (`ar-AE → ar → en`), string tables from JSON/CSV/assets, plural
categories (Arabic has six, English has two), `select`, culture-aware numbers/dates/lists, and
missing-string tracking so an untranslated key is a test failure instead of a player complaint.

```js
const { LOCTEXT } = localization;
hud.setAmmo(LOCTEXT('HUD', 'AmmoCounter', '{current} / {reserve}'), { current, reserve });
```

### JobGraph (`JobGraph.js`)
The frame, as a graph. Jobs declare dependencies and groups; the graph resolves levels, runs
independent jobs up to a concurrency bound, isolates failures (dependents are skipped, unrelated work
still runs), tracks per-job budgets and timings, and reports a frame breakdown.

```js
jobs.add({ name: 'physics.sim', group: 'sim', budgetMs: 4, run: (ctx, dt) => world.step(dt) });
jobs.add({ name: 'render.submit', group: 'render', dependsOn: ['sim'], run: () => renderer.submit() });
```

`WorkQueue` is the fan-out form (asset decodes, chunk builds): bounded concurrency, one promise.

### Curve (`Curve.js`)
Half of a shooter's feel is a curve: recoil climb, damage falloff, spread ramp, ADS transition,
muzzle-flash decay. `FloatCurve`/`VectorCurve` interpolate between keys (constant, linear, cubic with
explicit tangents, or monotone automatic tangents so a damage curve cannot overshoot and "heal" at
range), clamp/loop/cycle/extrapolate outside their range, integrate, report extrema, bake to tables,
round-trip through CSV/JSON, plot in the console, and come with shooter presets.

```js
const library = new CurveLibrary();
for (const [name, curve] of Object.entries(shooterCurvePresets())) library.add(name, curve);
const damage = baseDamage * library.evaluate('damageFalloff', distance);
const recoil = VectorCurve.fromPattern(pattern, { step: 0.08 }).evaluate(timeSinceFirstShot);
```

### TimerManager (`TimerManager.js`)
`setTimeout` is the wrong clock for a game: it keeps running after shutdown, ignores pause, and
cannot be inspected. Timers here advance on the engine's fixed step, so they are deterministic and
testable.

```js
const reload = engine.setTimer('Reload', weapon, { method: 'finishReload', time: 1.5, owner: weapon });
engine.timers.isActive(reload);          // still reloading?
engine.timers.getRemaining(reload);      // what the HUD shows
engine.timers.setRate(reload, 2);        // fast-forward
engine.timers.clearAllFor(weapon);       // the weapon was destroyed
engine.every(0.5, () => hud.tick());     // looping, with the phase kept free of drift
```

One-shots, loops with a separate first delay (ability cooldowns), pause per timer and globally,
rate scaling, owner-scoped cleanup, weak object-bound callbacks, capacity guard, and events for
set/fired/cleared. Each timer fires at most once per advance — the fixed step keeps the rate honest
instead of firing a burst after a stall.

### Event queue and message bus (`EventBus.js`)
Systems do not call each other for notifications. They publish onto a bounded, prioritized queue and
the engine drains it once per frame at Heartbeat. Priority decides order (ties by insertion id),
events raised inside a handler are deferred to the next pass, channels can be gated, TTLs are
counted in drain cycles, capacity is bounded, and a throwing handler is recorded without stopping
the rest of the batch. `MessageBus` layers topics (`player.*`, `*`), request/reply with
drain-based timeouts, and responders (an RPC shape) on top.

```js
engine.messages.subscribe('player.*', (body) => hud.onPlayer(body));
engine.messages.respond('inventory.query', (body) => ({ item: 'rifle', slot: body.slot }));
engine.messages.publish('player.damaged', { amount: 12 });   // delivered on the next frame
const { promise } = engine.messages.request('inventory.query', { slot: 2 });
const answer = await promise;
```

Both classes work standalone (`EventQueue`/`MessageBus`), expose `describe()`/`format()`, and
install `events.*` and `bus.*` console commands. The bus owns its queue, so a host calls one
installer and gets the whole surface.

### Async tasks and workers (`Async.js`)
Work that must not block a frame goes through a `TaskScheduler`: a priority queue with bounded
concurrency, deterministic drains, retries, progress and cooperative cancellation. Every
`AsyncTask` exposes its state, attempts, elapsed time and a promise; an `AsyncScope` cancels
everything it submitted on teardown. Execution is pluggable — the default runs inline (correct in
Node and in a browser), and `WorkerPool` gives a bounded pool of `Worker`-like objects with one
request/response protocol, so real off-thread decoding needs no caller changes.

```js
const task = engine.tasks.submit('navmesh.bake', async ({ token, progress }) => {
  for (const tile of tiles) { token.throwIfCancelled(); bake(tile); progress(done++ / tiles.length); }
  return navmesh;
}, { priority: TaskPriority.High, group: 'navigation' });
const navmesh = await task.promise;
engine.tasks.setExecutor(workerPool.asExecutor());       // opt into Web Workers
const results = await parallel([decodeA, decodeB], { concurrency: 2 });
```

Helpers: `delay`, `retry`, `parallel`, `series`. Console: `tasks`, `tasks.drain`, `tasks.cancel`,
`tasks.pause`. The engine pumps `tasks.drain()` and `messages.drain()` once per frame, so both are
deterministic in a replay and free when idle.

### Subsystem (`Subsystem.js`) and ModuleManager (`ModuleManager.js`)
Subsystems are the engine's own systems — assets, renderer, physics, audio — each with a lifetime and
declared dependencies. Registration order is irrelevant: the collection resolves dependencies
(case-insensitively), initializes parent-first, tears down in reverse, and supports late registration
in either order.

Modules are the boot-phasing counterpart (`PreInit → PreEngineInit → PostEngineInit`, plus editor and
server-only targets) with dependency resolution, exports and hot reload.

### Plugin (`Plugin.js`)
A plugin is a self-describing optional feature: dependencies with version gates, a content root,
settings that join the engine config, modules, subsystems, console commands, string tables and its
own lifecycle hooks. Enabling a plugin enables its dependencies; disabling one disables its
dependents (or refuses, under the strict policy); cyclic graphs are reported instead of recursing.

### Scheduler (`Scheduler.js`) and EngineCore (`EngineCore.js`)
There is exactly one clock. The `Scheduler` owns the fixed-step accumulator, the phase signals
(`PreRender → PreSimulation/Stepped → Heartbeat → RenderStepped → PostRender`) and the task API
(`spawn/defer/delay/wait`). `EngineCore` binds itself to those phases instead of running a second
loop, and exposes the whole engine as one object:

```js
const engine = await createEngine({ argv: process.argv, target: 'client', tracing: true });

engine.jobs.add({ name: 'gameplay.ai', group: 'simulation', run: (ctx, dt) => ai.update(dt) });

function frame(now) { requestAnimationFrame(frame); engine.frame(); }  // host owns the loop
frame();

engine.pause(); engine.step(1); engine.setTimeScale(0.5);
engine.requestBundle('arena');                   // streamed across frames
engine.shutdown();
```

A frame is: pre-render (input mapping, network receive, stats) → N fixed steps (subsystem fixed
update, simulation jobs) → per-frame work (subsystem update, frame jobs) → render phase → post-render
(stats, trace frame marker, collection cadence). Deltas are clamped, catch-up is bounded, and
`runFixedFrames(n, dt)` gives a headless soak test the exact same path.

### InputMapping (`InputMapping.js`)
UE5's Enhanced Input, adapted for a shooter: actions with value types, prioritized mapping contexts
that can consume input, modifier stacks and trigger stacks, and full rebinding.

```js
const { actions, context } = createShooterContext();
const input = engine.createInputMapping({ name: 'P1' });
for (const action of Object.values(actions)) input.addAction(action);
input.addContext(context);
input.setKeyValue(Keys.W, 1);          // the platform layer feeds raw keys
input.getActionVector('Move');         // → { x: 0, y: 1, z: 0 }
input.wasTriggered('ThrowGrenade');    // Hold(0.35) fired once
```

Nothing in gameplay reads a key. That is what makes rebinding, gamepad support, ADS sensitivity
curves, replay files and headless input tests possible without touching a single gameplay file.

### Replay (`Replay.js`)
Record what the player did, run the same simulation again, and the bug happens on demand instead of
once every forty matches.

```js
const replay = engine.createReplaySystem({ name: 'Session', sampleEvery: 30 });
replay.startRecording({ name: 'Round 3', metadata: { map: 'arena' } });
…
const recording = replay.stopRecording();
replay.player.load(recording); replay.player.play();     // tick-accurate, same input path
replay.player.seekToTick(412);                           // nearest snapshot
replay.player.verify({ checksum: (e) => hashWorld(e) });  // diverged at tick 412, not "somewhere"
```

Frames are recorded per **simulation tick** (not per rendered frame), in either action mode (resolved
inputs, insensitive to rebinding) or keys mode (raw keys, re-resolved through whatever mapping is
current). The buffer is bounded, playback supports speed/pause/seek/step, saves go through the
archive, and a checksum mismatch names the tick where two runs parted ways.

### Archive (`Archive.js`)
Versioned binary (and JSON) serialization for saves, replays, bundles and snapshots: named sections,
a string table, struct registry with migrations, lazy per-section decoding behind a resolver, and
forward compatibility (a section this build does not know is skipped, not fatal).

```js
defineStruct('ActorRecord', { name: 'string', health: 'f32', position: 'vec3' });
const writer = new ArchiveWriter({ kind: PayloadKind.Save, version: 4 });
writer.section('player', 'ActorRecord', player);
const bytes = writer.finish();
const reader = new ArchiveReader(bytes);
reader.read('player');                    // lazily decoded
reader.readAll('ActorRecord');            // every section of one struct
```

### Saved games (`SaveGame.js`)
Atomic, versioned slots on top of any four-operation storage adapter. A write is staged, decoded
back and verified before it is promoted; the previous good value is kept in a backup chain, so a
truncated, refused or corrupted slot recovers automatically. Payloads carry a version and a
checksum, `Map`/`Set` sections round-trip, registered schemas validate field types, chained
migrations upgrade old profiles, and autosave runs on the engine's fixed-step clock with readable
rotated history. The engine owns `engine.saves` and installs `save*` commands at boot.

```js
const saves = engine.saves;
saves.defineSchema(3);
saves.registerSection('progress', { level: 'u8', score: 'u32', unlocked: 'array:string' });
saves.migrate(1, (save) => save.patch('progress', { level: 1 }));
saves.write('profile', { progress: { level: 4, score: 12900, unlocked: ['rifle'] } });
saves.readSlot('profile', 'progress');             // → the section, Maps/Sets revived
saves.verify();                                   // → { checked, ok, corrupt: [ … ] }
saves.exportAll();                                // portable JSON for profile sync
saves.enableAutosave({ slot: 'auto', intervalSeconds: 60, keep: 3, collect: () => snapshot() });
saves.read('auto.1');                             // rotated autosave, re-headered as its own slot
```

`SaveStorage.browser()` uses `localStorage` (with a memory fallback); `SaveStorage.memory()` is for
tests and headless runs. Binary records are wrapped in a marked string so string-only storage works
for both `format: 'json'` and `format: 'binary'`. Console: `save`, `save.write`, `save.read`,
`save.delete`, `save.autosave`, `save.verify`, `save.export`.

## Composition recipe

```js
// 1. A subsystem: one engine system with a lifetime.
class AudioSubsystem extends Subsystem {
  static TypeName = 'Audio';
  static Dependencies = ['assets'];
  onInitialize(ctx) { this.engine = ctx.engine; }
  onUpdate(dt) { /* mix, stream, duck */ }
  onDeinitialize() { /* release the audio context */ }
}

// 2. A module: boots at a phase, may import lazily and hot-reload.
const audioModule = { name: 'audio', phase: ModulePhase.PreEngineInit, dependencies: ['core'],
  load: () => import('./audio/AudioModule.js') };

// 3. A plugin: optional content + code, with its own commands, settings and content root.
const arenaPlugin = { name: 'Arena', version: '1.0.0', dependencies: ['Weapons'],
  contentManifest: [{ path: 'Maps/Arena.map', type: 'map' }], commands: [ /* … */ ] };

const engine = await createEngine({
  name: 'OminXClient', target: 'client', argv: process.argv,
  modules: [audioModule], plugins: [arenaPlugin], manifest: contentManifest,
  subsystemsList: [AudioSubsystem], tracing: true,
});
```

## Conventions

- One class per file, one concern per class; a file starts with a doc block that says what the module
  is *for*, not what it does.
- Public API in `camelCase`; UE-style aliases (`IsBound`, `Add`, `Broadcast`) exist where they help
  people coming from Unreal.
- Anything with state exposes `describe()` (machine-readable) and, where it is shown to a person,
  `format()` (text). Data fields never use that name (`SaveSystem` calls its encoding
  `storageFormat`) — an instance field silently shadows the prototype method.
- Anything user-facing registers its own console commands via `installConsoleCommands(console)`.
- Priorities are always "higher runs first" and ties break by insertion order.

## Verification

```bash
node --test tests/core.test.js        # 84 tests, the core contract
node --test tests/*.test.js           # 157 tests (engine + gameplay + network + renderer)
node tools/syntax-check.js            # 152 JS modules + 24 WGSL programs / 80 variants
node tools/core-report.mjs            # boot a headless engine and print the full report
npm run core                          # same report via npm
npm run build                         # vite build
```

Every module is also exercised by a scratch probe under `tools/scratch/` where the behaviour is
easier to see printed than asserted (archive framing, plugin boot, trace export).
