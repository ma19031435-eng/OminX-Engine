/**
 * OminX Engine — core barrel.
 *
 * `import { createEngine, Object, reflectClass, LOCTEXT } from 'ominx/engine/src/core'`.
 *
 * The core is layered, lowest first — nothing below depends on anything above:
 *
 *   1. **Foundations** — `Delegate`, `Signal`, `Logger`, `Containers`, `Stats`, `Trace`, `Memory`
 *   2. **Object model** — `Object` (reflection, ids, tags, lifetimes), `GarbageCollector`
 *   3. **Services** — `Config`, `Console`, `AssetRegistry`, `Localization`, `JobGraph`, `TimerManager`, `Curve`, `EventBus`, `Async`
 *   4. **Composition** — `Subsystem`, `ModuleManager`, `Plugin`
 *   5. **Runtime** — `EngineCore` (one clock over `Scheduler`), `InputMapping`, `Archive`, `Replay`, `SaveGame`
 *
 * `CORE_MODULES` is the machine-readable version of that list: it is what `engine/core-report`
 * prints, what a documentation test asserts has a header comment, and what a plugin's
 * `requiresCore` gate checks.
 *
 * @module engine/src/core
 */

export const CORE_VERSION = '0.3.0';

// ------------------------------------------------------------------ foundations
export {
  Delegate, MulticastDelegate, DelegateHandle, bindToDelegate, setDelegateErrorHandler,
} from './Delegate.js';
export { Signal, Connection, EventEmitter, setSignalErrorHandler } from './Signal.js';
export { Logger, LogLevel, createLogger, setLogLevel, getLogLevel, logger } from './Logger.js';
export {
  ObjectPool, FixedPool, RingBuffer, Deque, PriorityQueue, SparseSet, FreeList, BitSet,
  SpatialHashGrid, LRUCache, SlotMap,
} from './Containers.js';
export {
  Stats, Stat, StatScope, Histogram, StatUnit, stats as defaultStats, withScope,
} from './Stats.js';
export {
  Trace, TraceEvent, TraceScope, traceEvents, traceScoped, traceScope, trace as sharedTrace,
} from './Trace.js';
export {
  TimerManager, TimerHandle, TimerMode, timerEvents,
} from './TimerManager.js';
export {
  Memory, MemoryTracker, MemoryScope, FrameArena, BufferPool, memoryEvents,
} from './Memory.js';
export {
  FloatCurve, VectorCurve, CurveLibrary, CurveInterp, CurveExtrap, curveEvents, shooterCurvePresets,
} from './Curve.js';
export {
  ReplaySystem, ReplayRecorder, ReplayPlayer, Replay, ReplayFrame, ReplayState, replayEvents,
} from './Replay.js';

// ------------------------------------------------------------------ object model
export {
  Object, ClassInfo, ClassCategory, reflectClass, getClassInfo, isClass, listClasses, getClassCount,
  buildClassTree, engineEvents, setObjectTracking, isTrackingObjects, liveObjectCount, getLiveObjects,
  findObjectById, findLeakedObjects,
} from './Object.js';
export {
  Collector, ObjectHandle, WeakHandle, ObjectScope, HandleState, createScope,
} from './GarbageCollector.js';

// ------------------------------------------------------------------ services
export {
  Config, ConfigSchema, ConfigLayer, ConfigType, DEFAULT_LAYER_ORDER, configEvents, parseCommandLine,
} from './Config.js';
export {
  Console, ConsoleCommand, ConsoleAlias, OutputLevel, consoleEvents,
} from './Console.js';
export {
  AssetRegistry, AssetType, AssetEntry, AssetHandle, SoftAssetRef, AssetBundle, AssetState,
  assetTypeCategory, assetEvents, defaultIO,
} from './AssetRegistry.js';
export {
  Localization, StringTable, LocalizedText, LOCTEXT, TABLE_TEXT, INVARIANT_TEXT, localizationEvents,
  createLocalization, parseTablePayload, formatText, pickPlural,
} from './Localization.js';
export {
  JobGraph, Job, WorkQueue, JobState, jobEvents,
} from './JobGraph.js';
export {
  EventQueue, EventRecord, EventPriority, EventSubscription, MessageBus, MessageRequest,
  busEvents, topicMatches,
} from './EventBus.js';
export {
  TaskScheduler, AsyncTask, AsyncScope, TaskState, TaskPriority, CancellationSource,
  CancellationToken, CancellationError, WorkerPool, asyncEvents,
  delay, retry, parallel, series,
} from './Async.js';

// ------------------------------------------------------------------ composition
export {
  Subsystem, SubsystemCollection, SubsystemState, subsystemEvents, createSubsystemCollection,
} from './Subsystem.js';
export {
  ModuleManager, ModuleDescriptor, ModulePhase, ModuleTarget, ModuleState, moduleEvents,
} from './ModuleManager.js';
export {
  PluginManager, PluginDescriptor, PluginState, PluginTarget, pluginEvents, createPluginContext,
} from './Plugin.js';

// ------------------------------------------------------------------ runtime
export { Scheduler, Task, HeadlessLoop, RunPhase } from './Scheduler.js';
export {
  EngineCore, EnginePhase, EngineCore as Engine, CoreJobGroup, engineCoreEvents, createEngine,
  currentEngine, requireEngine,
} from './EngineCore.js';
export {
  InputMappingSystem, InputAction, InputMappingContext, InputBinding, InputValueType, Keys,
  Modifiers, Triggers, inputEvents, createShooterActions, createShooterContext,
} from './InputMapping.js';
export {
  ArchiveWriter, ArchiveReader, BinaryArchive, BinaryArchiveReader, JsonArchive, FieldType,
  PayloadKind, ARCHIVE_MAGIC, ARCHIVE_VERSION, defineStruct, getStruct, listStructs, migrateStruct, applyMigrations,
  writeStruct, readStruct, encodeStruct, decodeStruct, parseFieldType,
} from './Archive.js';
export {
  SaveGame, SaveSystem, SaveStorage, SaveSlotHeader, saveEvents, checksumOf, reviveSavedValue,
} from './SaveGame.js';

/**
 * The core manifest: module → { layer, summary }. Kept next to the exports on purpose — a module
 * that is exported here says what it is for, and a test asserts every file in `core/` appears.
 */
export const CORE_MODULES = Object.freeze({
  Logger: { layer: 1, summary: 'Levelled, channelled logging with a bounded buffer and an event stream.' },
  Delegate: { layer: 1, summary: 'Single-cast and multicast delegates with weak owners and priorities.' },
  Signal: { layer: 1, summary: 'Roblox-style signals: connect/emit/await with error isolation.' },
  Containers: { layer: 1, summary: 'Pools, rings, deques, priority queues, sparse sets, bit sets, LRU, slot maps, spatial hash.' },
  Stats: { layer: 1, summary: 'Frame capture, counters, gauges, accumulations and histograms.' },
  Trace: { layer: 1, summary: 'Bounded profiler: scoped events, categories, counters and Chrome-trace export.' },
  TimerManager: { layer: 3, summary: 'Deterministic timers: one-shot, looping, owned, pausable, rate-scaled.' },
  Object: { layer: 2, summary: 'Reflected object base: class info, ids, net ids, tags, world binding, lifecycle.' },
  GarbageCollector: { layer: 2, summary: 'Handles, pins, scopes, weak handles and deferred destruction.' },
  Memory: { layer: 1, summary: 'Frame arena, typed-buffer pools and per-category memory accounting.' },
  Curve: { layer: 3, summary: 'Keyed float/vector curves with monotone tangents, presets and text I/O.' },
  Replay: { layer: 5, summary: 'Tick-accurate input recording, playback, seeking and divergence checks.' },
  Config: { layer: 3, summary: 'Layered, schema-validated settings with change notification and INI/CLI parsing.' },
  Console: { layer: 3, summary: 'Commands, variables bound to config, aliases, completion, output stream.' },
  AssetRegistry: { layer: 3, summary: 'Asset identity, types, handles, soft refs, bundles, streaming and collection.' },
  Localization: { layer: 3, summary: 'Cultures with fallback, string tables, plurals, culture-aware formatting.' },
  JobGraph: { layer: 3, summary: 'Dependency-ordered frame jobs with levels, budgets and failure isolation.' },
  EventBus: { layer: 3, summary: 'Deterministic event queue and topic message bus with request/reply and TTLs.' },
  Async: { layer: 3, summary: 'Priority task scheduler, cancellation, async scopes and a bounded worker pool.' },
  Subsystem: { layer: 4, summary: 'Dependency-ordered engine subsystems with lifecycle and frame dispatch.' },
  ModuleManager: { layer: 4, summary: 'Boot-phase modules, target gating, dependency order, hot reload.' },
  Plugin: { layer: 4, summary: 'Self-describing optional features: dependencies, content, settings, lifecycle.' },
  Scheduler: { layer: 5, summary: 'Fixed-step frame loop, phase signals and the spawn/defer/delay task API.' },
  EngineCore: { layer: 5, summary: 'The engine object: one clock, all services, explicit lifecycle.' },
  InputMapping: { layer: 5, summary: 'Enhanced-Input-style actions, contexts, modifiers and triggers.' },
  Archive: { layer: 5, summary: 'Versioned, sectioned binary/JSON serialization with migration and lazy reads.' },
  SaveGame: { layer: 5, summary: 'Atomic saved-game slots: checksums, backups, migrations, autosave and rotation.' },
});

/** Core modules in dependency order (lowest layer first) — boot reports and docs use this. */
export function coreModuleList() {
  return Object.entries(CORE_MODULES)
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => a.layer - b.layer || a.name.localeCompare(b.name));
}

export default {
  CORE_VERSION,
  CORE_MODULES,
  coreModuleList,
};
