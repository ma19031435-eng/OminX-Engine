#!/usr/bin/env node
/**
 * Core report: boots the engine core headless and prints everything it knows.
 *
 * This is the "does the engine actually work" tool: it creates an engine, registers a project-like
 * set of subsystems, modules, plugins, assets, settings and input mappings, runs a fixed number of
 * frames at a fixed delta (no wall clock, no GPU, no browser), then reports the frame budget, the
 * job breakdown, content state, collection, tracing and configuration.
 *
 * Usage:
 *   node tools/core-report.mjs [--frames 600] [--bots 8] [--tracing] [--plugins] [--json] [--quiet]
 */
import { performance } from 'node:perf_hooks';

import {
  createEngine, Subsystem, ModulePhase, PluginTarget, Keys, createShooterContext,
  ConfigLayer, parseCommandLine, CORE_VERSION, coreModuleList, LOCTEXT, defineStruct,
  ArchiveWriter, ArchiveReader, PayloadKind, ARCHIVE_VERSION, SaveStorage,
  NetMode, NetRole, engineCoreEvents, TickGroup, ActorComponent,
} from '../engine/src/core/index.js';
import { setLogLevel } from '../engine/src/core/Logger.js';

function parseArgs(argv) {
  const out = { frames: 600, bots: 8, tracing: false, plugins: true, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--frames': out.frames = Number(next()); break;
      case '--bots': out.bots = Number(next()); break;
      case '--tracing': out.tracing = true; break;
      case '--no-plugins': out.plugins = false; break;
      case '--json': out.json = true; break;
      case '--quiet': case '-q': out.quiet = true; break;
      case '--help': case '-h': out.help = true; break;
      default: break;
    }
  }
  return out;
}

// --------------------------------------------------------------------- a project-ish subsystem set

class ContentSubsystem extends Subsystem {
  static TypeName = 'Content';
  onInitialize(context) { this.engine = context.engine; this.streamed = 0; }
  onUpdate(deltaSeconds) { this.streamed++; this.delta = deltaSeconds; }
}

class SimulationSubsystem extends Subsystem {
  static TypeName = 'Simulation';
  static Dependencies = ['content'];
  onInitialize() { this.ticks = 0; this.actors = []; }
  onFixedUpdate(fixedDelta) {
    this.ticks++;
    for (const actor of this.actors) actor.x += actor.speed * fixedDelta;
  }
}

class RenderSubsystem extends Subsystem {
  static TypeName = 'Renderer';
  static Dependencies = ['simulation'];
  onInitialize() { this.drawCalls = 0; }
  onUpdate() { this.drawCalls = 40 + (this.simulation ? 0 : 0); }
}

// --------------------------------------------------------------------- boot

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node tools/core-report.mjs [--frames 600] [--bots 8] [--tracing] [--no-plugins] [--json] [--quiet]');
    return;
  }
  if (options.quiet) setLogLevel('error');

  const manifest = [
    { path: '/Game/Maps/Arena.map', type: 'map', size: 262144, bundle: 'arena', tags: ['maps'] },
    { path: '/Game/Maps/Foundry.map', type: 'map', size: 311296, bundle: 'foundry', tags: ['maps'] },
    { path: '/Game/Tex/rock.png', type: 'texture', size: 1048576, tags: ['environment'] },
    { path: '/Game/Tex/metal.png', type: 'texture', size: 786432, tags: ['environment'] },
    { path: '/Game/Mat/floor.mat', type: 'material', size: 4096, dependencies: ['/Game/Tex/rock.png', '/Game/Tex/metal.png'] },
    { path: '/Game/Audio/rifle_shot.ogg', type: 'audio', size: 32768 },
  ];

  const engine = await createEngine({
    name: 'OminXCoreReport',
    version: CORE_VERSION,
    target: PluginTarget.Client,
    tickRate: 60,
    netMode: NetMode.ListenServer, netRole: NetRole.Authority,
    tracing: options.tracing,
    culture: process.env.OMINX_CULTURE ?? 'en',
    argv: process.argv.slice(2),
    savePrefix: 'ominx.report',
    saveOptions: { storage: SaveStorage.memory() },
  });

  // --- a project-like configuration surface
  engine.config.defineMany({
    'game.mode': { type: 'enum', enum: ['deathmatch', 'ctf', 'survival'], default: 'deathmatch', group: 'Game' },
    'game.botCount': { type: 'int', default: options.bots, min: 0, max: 64, group: 'Game' },
    'game.scoreLimit': { type: 'int', default: 30, min: 1, max: 1000, group: 'Game' },
    'renderer.fov': { type: 'number', default: 100, min: 60, max: 130, group: 'Renderer' },
    'renderer.resolutionScale': { type: 'number', default: 1, min: 0.5, max: 2, group: 'Renderer' },
    'audio.masterVolume': { type: 'number', default: 0.8, min: 0, max: 1, group: 'Audio' },
  });
  engine.config.apply(parseCommandLine(process.argv.slice(2), engine.config.schema), { layer: ConfigLayer.CommandLine });

  // --- content types, so the registry can actually load the manifest
  engine.assets.registerType({ name: 'map', extensions: ['.map'], loader: async (entry) => ({ path: entry.path, spawns: 8 }) });
  engine.assets.registerType({ name: 'texture', extensions: ['.png'], loader: async () => ({ width: 1024, height: 1024 }) });
  engine.assets.registerType({ name: 'material', extensions: ['.mat'], loader: async (entry, context) => ({ path: entry.path, textures: await Promise.all(entry.dependencies.map((dep) => context.registry.load(dep))) }) });
  engine.assets.registerType({ name: 'audio', extensions: ['.ogg'], loader: async () => ({ duration: 0.8 }) });
  engine.assets.scan(manifest);

  // --- subsystems (registered after boot: the collection brings them up in dependency order)
  engine.subsystems.register(RenderSubsystem);
  engine.subsystems.register(SimulationSubsystem);
  engine.subsystems.register(ContentSubsystem);
  const simulation = engine.subsystems.get('Simulation');
  for (let i = 0; i < options.bots; i++) simulation.actors.push({ id: i, x: i * 1.5, speed: 3 + (i % 3) });
  simulation.speed = 3;

  // --- a module and a plugin, to prove the composition paths
  engine.modules.register({ name: 'report.core', phase: ModulePhase.PreEngineInit, target: 'both', load: () => ({ ok: true }) });
  if (options.plugins) {
    engine.plugins.register({
      name: 'Weapons', version: '1.2.0', category: 'Gameplay', description: 'weapon framework (report stand-in)',
      settings: { 'weapons.maxSpread': { default: 0.035, min: 0, max: 1, group: 'Weapons' } },
      commands: [{ name: 'weapons.list', category: 'Gameplay', description: 'Lists weapons.', execute: () => 'rifle, pistol, knife' }],
      commands_: null,
      load: async () => ({ count: 3 }),
    });
    engine.plugins.register({ name: 'Arena', version: '1.0.0', dependencies: [{ name: 'Weapons', version: '>=1.0.0' }], contentManifest: [{ path: 'Maps/Arena.map', type: 'map', size: 10 }] });
    await engine.plugins.loadAll({ engine });
  }

  // --- localization
  engine.localization.addTable('HUD', {
    en: { Ammo: '{current} / {reserve}', Kills: '{count, plural, one {# kill} other {# kills}}' },
    ar: { Ammo: 'الذخيرة: {current} / {reserve}', Kills: '{count, plural, zero {لا قتلى} one {قتيل واحد} two {قتيلان} few {# قتلى} many {# قتيلاً}}' },
  });

  // --- messaging: a topic subscription, a responder and a request answered on the frame pump
  const messageLog = [];
  engine.messages.subscribe('report.*', (body, envelope) => messageLog.push({ topic: envelope.topic, ...body }));
  engine.messages.respond('report.stats', () => ({ bots: options.bots, map: 'arena' }));
  engine.messages.publish('report.begin', { frames: options.frames });
  const statsRequest = engine.messages.request('report.stats', {});
  engine.messages.publish('report.end', { frames: options.frames }, { priority: -10 });

  // --- off-frame work: two tasks, pumped by the engine's frame (priority order preserved)
  const taskOrder = [];
  engine.tasks.submit('report.heavy', () => { taskOrder.push('heavy'); return 1; }, { priority: -10, group: 'report' });
  engine.tasks.submit('report.quick', () => { taskOrder.push('quick'); return 2; }, { priority: 10, group: 'report' });
  const asyncTask = engine.tasks.submit('report.later', async ({ progress }) => {
    await Promise.resolve();
    progress(1);
    return 3;
  }, { group: 'report' });

  // --- input mapping, evaluated by the engine every frame
  const input = engine.createInputMapping({ name: 'LocalPlayer' });
  const { actions, context } = createShooterContext();
  for (const action of Object.values(actions)) input.addAction(action);
  input.addContext(context);
  input.setKeys({ [Keys.W]: 1, [Keys.MouseLeft]: 1 });

  // --- a gameplay job, so the frame budget has something to measure
  engine.jobs.add({
    name: 'gameplay.simulate', group: 'simulation', budgetMs: 4,
    run: (ctx, deltaSeconds) => {
      for (const actor of simulation.actors) actor.x += actor.speed * deltaSeconds * 0.25;
      ctx.stats.accumulate('Gameplay/DistanceTravelled', simulation.actors.length * deltaSeconds);
    },
  });

  // --- serialize/restore a snapshot to exercise the archive path
  defineStruct('ActorRecord', { id: 'u32', x: 'f32', speed: 'f32' });
  defineStruct('ActorTable', { actors: 'array:struct:ActorRecord' });
  defineStruct('SettingsRecord', { mode: 'string', bots: 'u32', scoreLimit: 'u32' }, { version: 2 });
  const writer = new ArchiveWriter({ kind: PayloadKind.Snapshot, version: ARCHIVE_VERSION });
  writer.section('actors', 'ActorTable', { actors: simulation.actors.map((actor) => ({ id: actor.id, x: actor.x, speed: actor.speed })) });
  writer.section('settings', 'SettingsRecord', {
    mode: engine.config.getString('game.mode'),
    bots: engine.config.getNumber('game.botCount'),
    scoreLimit: engine.config.getNumber('game.scoreLimit'),
  });
  const snapshot = writer.finish();
  const restored = new ArchiveReader(snapshot).read('actors').actors;
  const settings = new ArchiveReader(snapshot).read('settings');

  // --- content: load a level bundle (streamed) and a material (which pulls its textures)
  await engine.assets.loadBundle('arena');
  const materialHandle = await engine.assets.loadHandle('/Game/Mat/floor.mat');
  // The material loaded its textures as dependencies, but only referenced assets survive the
  // collection pass — so the report holds one explicitly to show the difference.
  const textureHandle = await engine.assets.loadHandle('/Game/Tex/rock.png');

  // --- saved games: schema, migration, atomic write and an autosave on the engine clock
  engine.saves.defineSchema(2);
  engine.saves.registerSection('progress', { level: 'u8', bots: 'u8' });
  engine.saves.migrate(1, (save) => save.patch('progress', { level: 1 }));
  engine.saves.write('profile', { progress: { level: 4, bots: options.bots } }, { metadata: { player: 'ReportBot', map: 'arena' } });
  engine.saves.enableAutosave({
    slot: 'auto', intervalSeconds: 2, keep: 3,
    collect: () => ({ progress: { level: 4, bots: options.bots, tick: engine.tickCount } }),
  });

  // --- typed data tables: one shared field vocabulary is used for saves, CSV and archives
  engine.data.define('Weapons', {
    name: 'string', damage: 'u8', rpm: 'u16', spread: 'f32', tags: 'array:string',
  }, { keyField: 'id' });
  const weaponTable = engine.data.get('Weapons');
  weaponTable.add('rifle', { name: 'Rifle', damage: 24, rpm: 600, spread: 0.02, tags: ['primary', 'hitscan'] });
  weaponTable.add('pistol', { name: 'Pistol', damage: 18, rpm: 300, spread: 0.05, tags: ['sidearm'] });
  const dataValidation = engine.data.validate();

  // --- diagnostics: an info record proves the hub is bounded, queryable and console-reachable
  engine.diagnostics.report({ level: 'info', code: 'E_REPORT', message: 'core report boot completed' });

  // --- replication: a few networked actors, driven by the fixed-step delegate
  engine.replication.register(1, { classId: 'Player', role: NetRole.Authority, properties: { health: 100, kills: 0 } });
  engine.replication.register(2, { classId: 'Pickup', role: NetRole.Authority, properties: { active: true } });
  const netDeltas = [];
  const rpcLog = [];
  engine.replication.onRpc(1, 'report.ping', (args) => rpcLog.push(args));
  const worldActor = engine.world.spawnActor({
    name: 'ReportActor', className: 'ReportActor', tags: ['report'],
  }, { level: 'ReportLevel', replicate: true, properties: { health: 100 } });
  worldActor.setPosition(0, 1, -5);
  let worldTicks = 0;
  worldActor.addComponent(new ActorComponent({
    name: 'report.tick', tickGroup: TickGroup.PrePhysics, tickEnabled: true,
    hooks: { onTick: () => { worldTicks++; } },
  }));

  const netConnection = engineCoreEvents.onFixedStep.connect((host, { tick }) => {
    if (tick % 60 !== 0) return;
    host.replication.setProperty(1, 'kills', tick / 60);
    netDeltas.push(...host.replication.collectDeltas());
    const rpc = host.replication.queueRpc(1, 'report.ping', { tick });
    host.replication.receiveRpc(rpc);
    host.replication.drainRpcs();
    worldActor.setReplicated('health', 100 - Math.round(tick / 60));
  });

  // --- run frames
  const started = performance.now();
  engine.runFixedFrames(options.frames, 1 / 60);
  const wallMs = performance.now() - started;
  const saveVerification = engine.saves.verify();
  const saveRows = engine.saves.list();
  const requestedStats = await statsRequest.promise;
  const asyncTaskValue = await asyncTask.promise;
  netConnection.disconnect();

  // --- report
  const report = {
    coreVersion: CORE_VERSION,
    modules: coreModuleList().map((module) => `${module.layer}:${module.name}`),
    frames: engine.frameNumber,
    ticks: engine.tickCount,
    simulatedSeconds: round(engine.gameTime),
    wallMs: round(wallMs),
    msPerFrame: round(wallMs / Math.max(1, options.frames)),
    msPerTick: round(wallMs / Math.max(1, engine.tickCount)),
    realtimeFactor: round((options.frames / 60 * 1000) / Math.max(1, wallMs)),
    frameBudget: engine.lastFrameRecord()?.frameMs ?? 0,
    jobs: engine.jobs.report({ limit: 8 }).jobs.map((job) => ({ name: job.name, group: job.group, runs: job.calls ?? job.runs, averageMs: job.averageMs, peakMs: job.peakMs, overBudget: job.overBudget })),
    subsystems: engine.subsystems.describe().subsystems.map((subsystem) => ({ type: subsystem.type, state: subsystem.state, updates: subsystem.updates, fixedUpdates: subsystem.fixedUpdates })),
    modules_loaded: engine.modules.count,
    plugins: engine.plugins.describe().plugins.map((plugin) => ({ name: plugin.name, version: plugin.version, state: plugin.state })),
    assets: engine.assets.report(),
    contentPlan: {
      bundleLoaded: engine.assets.isLoaded('/Game/Maps/Arena.map'),
      materialResolvedDependency: engine.assets.isLoaded('/Game/Tex/rock.png'),
      textureHeldByHandle: textureHandle?.isValid === true,
      collectedDuringRun: engine.assets.report().loads >= 2,
    },
    localization: { culture: engine.localization.culture, sample: engine.localization.resolve(LOCTEXT('HUD', 'Kills', 'kills'), { count: 3 }) },
    archive: { bytes: snapshot.length, actorsRestored: restored.length, settings },
    saves: {
      storage: engine.saves.storage.name, format: engine.saves.storageFormat,
      slots: saveRows.map((row) => ({ slot: row.slot, bytes: row.bytes, version: row.version, history: row.history })),
      writes: engine.saves.writeCount, autosaves: engine.saves.autosaveCount,
      autosaveActive: engine.saves.autosaveActive, verified: saveVerification.ok, checked: saveVerification.checked,
      corrupt: saveVerification.corrupt.length,
    },
    messages: {
      published: engine.messages.published, replies: engine.messages.replies,
      pending: engine.messages.pendingRequests, queued: engine.messages.count,
      delivered: messageLog.length, topics: [...engine.messages.subscriptions.keys()],
      request: requestedStats, errors: engine.messages.errors.length,
    },
    tasks: {
      submitted: engine.tasks.submitted, completed: engine.tasks.completed,
      failed: engine.tasks.failed, cancelled: engine.tasks.cancelled,
      running: engine.tasks.runningCount, concurrency: engine.tasks.concurrency,
      order: taskOrder, asyncResult: asyncTaskValue,
    },
    diagnostics: {
      reports: engine.diagnostics.total, suppressed: engine.diagnostics.suppressed,
      byLevel: { ...engine.diagnostics.counts }, minLevel: engine.diagnostics.minLevel,
    },
    data: {
      tables: engine.data.count, rows: weaponTable.count,
      validationIssues: dataValidation.total, csvColumns: weaponTable.columns.length,
      sample: engine.data.lookup('Weapons', 'rifle'),
    },
    replication: {
      objects: engine.replication.count, tick: engine.replication.tickCount,
      deltas: netDeltas.length, rpcs: rpcLog.length, stale: engine.replication.staleCount,
      conflicts: engine.replication.conflictCount, errors: engine.replication.errors.length,
      channels: engine.replication.describe().channels.map((channel) => ({ name: channel.name, sent: channel.sent, dropped: channel.dropped })),
    },
    world: {
      actors: engine.world.count, levels: engine.world.levels.size,
      tick: engine.world.tickCount, componentTicks: worldTicks,
      errors: engine.world.errors.length, spawned: engine.world.spawnCount,
      snapshotActors: engine.world.snapshot().actors.length,
    },
    objects: { live: engine.lastFrameRecord().objects.live, classes: engine.lastFrameRecord().objects.classes },
    collector: engine.collector.stats(),
    input: { contexts: input.contextNames(), move: input.getActionVector('Move'), fire: input.isActionActive('Fire') },
    stats: engine.stats.enabled ? engine.stats.getFrameStats() : null,
    trace: engine.trace.enabled ? { events: engine.trace.eventCount, top: engine.trace.top(5) } : { enabled: false },
    config: { mode: engine.config.getString('game.mode'), bots: engine.config.getNumber('game.botCount'), fov: engine.config.getNumber('renderer.fov'), origin: engine.config.origin('renderer.fov')?.layer },
    console: { commands: engine.console.commandsList().length, variables: engine.console.variableNames().length },
    errors: { modules: engine.modules.errors.length, subsystems: engine.subsystems.errors.length, plugins: engine.plugins.errors.length, jobs: engine.jobs.errors.length, saves: saveVerification.corrupt.length, messages: engine.messages.errors.length, tasks: engine.tasks.failed, diagnostics: engine.diagnostics.counts.fatal, data: dataValidation.total, replication: engine.replication.errors.length, world: engine.world.errors.length },
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`OminX core ${CORE_VERSION} — ${report.modules.length} core modules`);
    console.log('');
    console.log(`  frames          ${report.frames} (${report.ticks} fixed ticks, ${report.simulatedSeconds}s simulated)`);
    console.log(`  wall time       ${report.wallMs} ms → ${report.msPerFrame} ms/frame, ${report.msPerTick} ms/tick, ${report.realtimeFactor}× realtime`);
    console.log(`  subsystems      ${report.subsystems.map((entry) => `${entry.type}(${entry.state})`).join(', ')}`);
    console.log(`  modules         ${report.modules_loaded} loaded`);
    console.log(`  plugins         ${report.plugins.map((entry) => `${entry.name}@${entry.version}:${entry.state}`).join(', ') || 'none'}`);
    console.log(`  content         ${report.assets.registered} registered, ${report.assets.loaded} loaded (${report.assets.loadedBytes} B), ${report.assets.unreferenced} unreferenced`);
    console.log(`  bundle          arena loaded=${report.contentPlan.bundleLoaded} · material pulled its texture=${report.contentPlan.materialResolvedDependency} · held by handle=${report.contentPlan.textureHeldByHandle}`);
    console.log(`  text            culture ${report.localization.culture} → "${report.localization.sample}"`);
    console.log(`  archive         ${report.archive.bytes} B snapshot, ${report.archive.actorsRestored} actors restored, settings ${JSON.stringify(report.archive.settings)}`);
    console.log(`  saves           ${report.saves.checked} slots (${report.saves.verified} verified, ${report.saves.corrupt} corrupt) · ${report.saves.writes} writes · ${report.saves.autosaves} autosaves · ${report.saves.format}`);
    console.log(`  messages        ${report.messages.published} published · ${report.messages.delivered} delivered · ${report.messages.replies} replies · ${report.messages.pending} pending · request ${JSON.stringify(report.messages.request)}`);
    console.log(`  tasks           ${report.tasks.completed}/${report.tasks.submitted} completed · ${report.tasks.failed} failed · ${report.tasks.running} running · concurrency ${report.tasks.concurrency} · order [${report.tasks.order.join(', ')}]`);
    console.log(`  diagnostics     ${report.diagnostics.reports} reports · ${report.diagnostics.suppressed} deduplicated · ${report.diagnostics.byLevel.fatal} fatal`);
    console.log(`  data            ${report.data.tables} tables / ${report.data.rows} rows · ${report.data.validationIssues} validation issues · ${report.data.csvColumns} CSV columns`);
    console.log(`  replication     ${report.replication.objects} objects · ${report.replication.deltas} deltas · ${report.replication.rpcs} RPCs · ${report.replication.conflicts} conflicts · tick ${report.replication.tick}`);
    console.log(`  world           ${report.world.actors} actors / ${report.world.levels} levels · ${report.world.componentTicks} component ticks · ${report.world.snapshotActors} actors in snapshot`);
    console.log(`  objects         ${report.objects.live} live / ${report.objects.classes} classes, ${report.collector.destroyedHistory} destroyed`);
    console.log(`  input           contexts [${report.input.contexts.join(', ')}] move ${JSON.stringify(report.input.move)} fire ${report.input.fire}`);
    console.log(`  console         ${report.console.commands} commands, ${report.console.variables} variables`);
    console.log(`  config          mode=${report.config.mode} bots=${report.config.bots} fov=${report.config.fov} (${report.config.origin})`);
    if (report.stats) console.log(`  frame stats     mean ${report.stats.mean} ms (p95 ${report.stats.p95} ms, ${report.stats.fps} fps reported)`);
    if (report.trace.events) console.log(`  trace           ${report.trace.events} events: ${report.trace.top.map((row) => `${row.name} ${row.totalMs}ms`).join(', ')}`);
    console.log('');
    console.log(engine.jobs.format());
    console.log('');
    console.log(engine.assets.format());
    console.log('');
    console.log(engine.saves.format());
    console.log('');
    console.log(engine.messages.format());
    console.log('');
    console.log(engine.messages.queue.format());
    console.log('');
    console.log(engine.tasks.format());
    console.log('');
    console.log(engine.diagnostics.format());
    console.log('');
    console.log(engine.data.format());
    console.log('');
    console.log(engine.replication.format());
    console.log('');
    console.log(engine.world.format());
    console.log('');
    console.log(`  errors          modules ${report.errors.modules} · subsystems ${report.errors.subsystems} · plugins ${report.errors.plugins} · jobs ${report.errors.jobs} · saves ${report.errors.saves} · messages ${report.errors.messages} · tasks ${report.errors.tasks} · diagnostics ${report.errors.diagnostics} · data ${report.errors.data} · replication ${report.errors.replication} · world ${report.errors.world}`);
    console.log('');
    console.log('  reachable through the console:');
    for (const line of ['engine', 'engine.subsystems', 'engine.modules', 'plugins', 'loc.report', 'engine.assets', 'weapons.list', 'trace.categories', 'save', 'save.verify', 'save.export', 'bus', 'bus.requests', 'events', 'events.drain', 'tasks', 'tasks.drain', 'diag', 'diag.codes', 'diag.errors', 'data', 'data.get Weapons rifle', 'data.validate', 'net', 'net.actors', 'net.channels', 'world', 'world.actors', 'world.levels', 'world.net'].entries()) {
      const [index, command] = line;
      const result = engine.console.exec(command, { silent: true });
      console.log(`    ${String(index + 1).padStart(2)}. ${command.padEnd(18)} ${result.ok ? 'ok' : 'FAILED'}`);
    }
  }

  textureHandle?.release();
  materialHandle?.release();
  const collected = engine.assets.collectGarbage();
  if (!options.json) console.log(`  collection      freed ${collected.collected.length} assets (${collected.freedBytes} B), ${engine.assets.loadedCount()} still loaded`);

  await engine.shutdown();
  const failed = Object.values(report.errors).some((count) => count > 0);
  process.exitCode = failed ? 1 : 0;
}

function round(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
