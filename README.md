# OminX Engine

An extensive, **headless-first web game engine** for a browser FPS. The core is written in plain
ESM JavaScript with no runtime CDN dependencies: it boots in Node, in a worker and in a browser,
and it is exercised by a deterministic headless test suite rather than by a screenshot.

The project is being built in the order its target needs: **the UE5-style core is perfected first**,
then the WebGPU render layer, then FPS gameplay. Gameplay systems (weapons, bots, characters,
levels), geometry/meshes and the editor shell are intentionally parked until the core is complete;
the render backend is WebGPU, not WebGL.

## Layout

| Path | What lives there |
| --- | --- |
| `engine/src/core/` | The engine core: 32 layered modules (object model, lifetimes, containers, subsystems, modules, plugins, jobs, stats, trace, memory, timers, curves, replays, assets, config, console, localization, serialization, saves, messaging, async tasks, schema, diagnostics, data tables, replication, world/actors). See [`engine/src/core/README.md`](engine/src/core/README.md). |
| `engine/src/math/` | Vectors, quaternions, matrices, transforms, curves, colour, noise, deterministic RNG. |
| `engine/src/world/` | Scene graph, collision world, navigation graph, parts, level builder. |
| `engine/src/physics/` | Kinematic character controller. |
| `engine/src/renderer/` | WebGPU device/renderer, WGSL shader library and preprocessing/layout tools. |
| `engine/src/gameplay/`, `engine/src/input/`, `engine/src/geometry/` | Parked until the core is finished. |
| `src/net/`, `server/` | Wire protocol (`PROTOCOL_VERSION 3`), client, authoritative match server. |
| `src/app/`, `src/editor/`, `src/scripting/`, `src/audio/` | Host application, editor shell, scripting runtime, procedural audio. |
| `tests/` | 172 tests: core contract, engine, network, AI, renderer, WebGPU. |
| `tools/` | Syntax/WGSL checker, headless core report, scratch probes, simulation tools. |

## Quick start

```bash
npm install
npm test                              # node --test tests/*.test.js
npm run check                         # syntax-check JS + every WGSL permutation
npm run core                          # boot the engine headless and print the full core report
npm run core:json                     # same report as JSON (for CI)
npm run build                         # vite production bundle
npm run dev                           # browser host (WebGPU required)
npm run server                        # authoritative match server on :8787
```

The core alone needs no browser and no GPU:

```js
import { createEngine, World, DataRegistry, ReplicationSystem, diagnostics } from './engine/src/core/index.js';

const engine = await createEngine({ name: 'FPSHost', target: 'client', netMode: 'server' });

engine.data.define('Weapons', { name: 'string', damage: 'u8', rpm: 'u16' }, { keyField: 'id' });
engine.data.get('Weapons').add('rifle', { name: 'Rifle', damage: 24, rpm: 600 });

const spawn = engine.world.spawnActor(
  { name: 'RedSpawn', className: 'PlayerStart', tags: ['spawn', 'red'] },
  { level: 'Arena', replicate: true, properties: { health: 100 } },
);
spawn.setPosition(0, 2, -10);

engine.frame(1 / 60);                 // one frame: fixed steps → world ticks → messages/tasks
console.log(engine.describe());       // machine-readable state for HUDs, tools, tests
console.log(engine.console.exec('world').output);
await engine.shutdown();
```

## Design contract

- **Single clock.** `Scheduler`/`EngineCore` own one fixed-step simulation; subsystems, timers,
  jobs, actor tick groups, message drains and task pumps all hang off it.
- **Explicit lifecycles.** Engines, subsystems, modules, plugins and actors transition through
  named states; initialization is reversible (`engine.restart()`).
- **Errors are isolated.** A throwing delegate, job, plugin, console command, component `onTick`
  or RPC handler is recorded locally, and the rest of the frame keeps running.
- **Nothing unbounded.** Every queue, buffer, cache, resend window and history has a capacity.
- **One reflected field vocabulary.** `Schema.js` defines what `u8`, `vec3`, `array:string` and
  `struct:Name` mean for saves, data tables, archive structs and config columns alike.
- **Transport-agnostic replication.** `Replication.js` owns roles, dirty deltas, ordered reliable
  channels, RPCs and snapshots; `src/net/Protocol.js` owns the bytes.
- **Everything observable.** Every stateful service exposes `describe()`, usually `format()`, and
  installs its own console commands.

## Verification

```bash
node --test tests/core.test.js        # 99 core tests
node --test tests/*.test.js           # 172 tests in total
node tools/syntax-check.js            # 160 JS modules + 24 WGSL programs / 80 variants
node tools/core-report.mjs            # 32 core modules, 600 frames, ~80× realtime
node tools/scratch/world-probe.mjs    # actors/components/tick groups/levels/replication
```

`npm run core` boots a project-shaped engine (subsystems, module, plugins, assets, localization,
archive snapshot, saves, message bus, async tasks, data tables, diagnostics, replication, world)
and runs 600 fixed frames in ~120 ms with zero recorded errors.
