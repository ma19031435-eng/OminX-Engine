#!/usr/bin/env node
/**
 * OminX Engine — headless match runner (benchmark + CI harness).
 *
 * Runs a full match with no browser, no renderer and no sockets: `--ticks` simulation steps across
 * `--bots` bots, reporting tick cost, network snapshot size and gameplay density. This is how the
 * engine is profiled in CI (no GPU needed) and how balance changes are measured.
 *
 * ```sh
 * npm run headless                                     # 1200 ticks, 8 bots, urban
 * node server/bin/ominx-headless.js --ticks 7200 --bots 12 --map facility --json
 * ```
 *
 * @module server/bin/ominx-headless
 */
import { setLogLevel } from '../../engine/src/core/Logger.js';
import { MatchRunner } from '../src/MatchRunner.js';
import { MatchMode } from '../src/MatchRunner.js';
import { MapKind } from '../../engine/src/world/LevelBuilder.js';
import { encodeSnapshot } from '../../src/net/Protocol.js';
import { formatBytes } from '../../src/net/Protocol.js';
import { performance } from 'node:perf_hooks';

const HELP = `
OminX headless match

Usage: node server/bin/ominx-headless.js [options]

  --ticks <n>        simulation ticks               (default 1200)
  --bots <n>         bot count 0–32                 (default 8)
  --map <name>       ${Object.values(MapKind).join(' | ')}
  --maps all         run every map and print a comparison table
  --seed <n>         map seed                       (default 21)
  --difficulty <d>   recruit|regular|hardened|elite|nightmare
  --mode <m>         ${Object.values(MatchMode).join(' | ')}
  --warmup <s>       warmup seconds                 (default 0)
  --json             print a machine-readable report
  --verbose          keep engine log lines on stdout (default: errors only)
  --help
`;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'help') return { help: true };
    if (key === 'json') { options.json = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    i++;
    options[key] = value;
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
// stdout is the report channel: keep it machine-readable unless the caller asks for chatter.
setLogLevel(args.verbose ? 'info' : 'error');

const number = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const mapName = Object.values(MapKind).find((kind) => kind === args.map) ?? MapKind.Urban;
const ticks = Math.max(60, number(args.ticks, 1200));
const bots = Math.max(0, Math.min(32, number(args.bots, 8)));
const tickRate = 60;

const buildStart = performance.now();
const runner = new MatchRunner({
  map: mapName,
  seed: number(args.seed, 21),
  bots,
  difficulty: args.difficulty ?? 'regular',
  mode: Object.values(MatchMode).find((kind) => kind === args.mode) ?? MatchMode.TDM,
  warmup: number(args.warmup, 0),
  tickRate,
});
const buildMs = performance.now() - buildStart;

// Two human-ish clients with scripted input, so the network path is exercised too.
const humans = [
  runner.addPlayer({ id: 'p1', name: 'Runner_A', team: 'red' }),
  runner.addPlayer({ id: 'p2', name: 'Runner_B', team: 'blue' }),
];
const scripted = (index) => (tick) => ({
  sequence: tick,
  dt: 1 / tickRate,
  yaw: Math.sin(tick * 0.01 + index) * Math.PI,
  pitch: Math.sin(tick * 0.004) * 0.25,
  moveX: Math.sin(tick * 0.02 + index) > 0 ? 1 : -1,
  moveY: Math.cos(tick * 0.013) > -0.2 ? 1 : 0.2,
  fire: tick % (12 + index * 7) === 0,
  aim: tick % 90 < 45,
  sprint: tick % 200 < 90,
  crouch: false,
  jump: tick % 320 === 0,
});

const brains = humans.map((human, index) => scripted(index));
const timings = [];
const snapshotSizes = [];
let snapshots = 0;

const start = performance.now();
for (let tick = 0; tick < ticks; tick++) {
  brains.forEach((brain, index) => runner.queueInput(humans[index].id, brain(tick)));
  const tickStart = performance.now();
  runner.update();
  if (tick % 20 === 0) {
    for (const bot of runner.bots) {
      const origin = (bot._travelOrigin ??= bot.character.position.clone());
      const travelled = Math.hypot(bot.character.position.x - origin.x, bot.character.position.z - origin.z);
      (bot._travelSamples ??= []).push(travelled);
    }
  }
  timings.push(performance.now() - tickStart);
  if (tick % 3 === 0) {
    const buffer = encodeSnapshot(runner.buildSnapshot());
    snapshotSizes.push(buffer.byteLength);
    snapshots++;
  }
}
const elapsed = performance.now() - start;

const scoreboard = runner.getScoreboard();
const bounds = runner.bounds ?? null;
let motionless = 0;
let outside = 0;
let travelAverage = 0;
for (const bot of runner.bots) {
  let travel = 0;
  for (const sample of bot._travelSamples ?? []) travel = Math.max(travel, sample);
  travelAverage += travel;
  if (travel < 3) motionless++;
  if (bounds) {
    const p = bot.character.position;
    if (p.x < bounds.min - 1 || p.x > bounds.max + 1 || p.z < bounds.min - 1 || p.z > bounds.max + 1) outside++;
  }
}
travelAverage = runner.bots.length ? travelAverage / runner.bots.length : 0;
const sorted = [...timings].sort((a, b) => a - b);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const totalMs = timings.reduce((sum, value) => sum + value, 0);
const snapshotBytes = snapshotSizes.reduce((sum, value) => sum + value, 0) / Math.max(1, snapshots);

const report = {
  map: mapName,
  seed: number(args.seed, 21),
  mode: runner.options.mode,
  bots,
  humans: humans.length,
  ticks,
  mapBuildMs: round(buildMs),
  wallMs: round(elapsed),
  tick: {
    meanMs: round(totalMs / timings.length),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    maxMs: round(sorted[sorted.length - 1]),
    budgetMs: round(1000 / tickRate),
    headroomPct: round((1 - (totalMs / timings.length) / (1000 / tickRate)) * 100),
    realtimeFactor: round((ticks * (1000 / tickRate)) / elapsed),
  },
  network: {
    snapshotBytes: round(snapshotBytes),
    snapshotBytesPerClientPerSecond: round(snapshotBytes * 3),
    at16PlayersKbPerSecond: round((snapshotBytes * 3 * 16) / 1024),
  },
  ai: {
    // AI health: a bot that never travels, or one that walks out of the playable area, is a
    // navigation bug rather than a balance issue — these two numbers are the smoke test for it.
    travelAvgM: round(travelAverage),
    motionlessBots: motionless,
    outsideBounds: outside,
    bounds: runner.bounds ?? null,
  },
  gameplay: {
    shots: runner.ballistics.stats.shots,
    hits: runner.ballistics.stats.hits,
    kills: runner.ballistics.stats.kills,
    accuracy: round(runner.ballistics.stats.shots ? runner.ballistics.stats.hits / runner.ballistics.stats.shots : 0),
    phase: runner.phase,
    score: scoreboard.scores,
    topPlayer: scoreboard.players[0] ?? null,
  },
};

if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const m = report;
  process.stdout.write(`
  OminX headless match — ${m.map} (seed ${m.seed}), ${m.bots} bots + ${m.humans} scripted clients
  ───────────────────────────────────────────────────────────────
  map build        ${m.mapBuildMs} ms
  simulated        ${m.ticks} ticks in ${m.wallMs} ms  (${m.tick.realtimeFactor}× realtime)
  tick cost        mean ${m.tick.meanMs} ms · p50 ${m.tick.p50Ms} · p95 ${m.tick.p95Ms} · max ${m.tick.maxMs}
  budget           ${m.tick.budgetMs} ms/tick → ${m.tick.headroomPct}% headroom
  snapshot         ${formatBytes(m.network.snapshotBytes)} per client per snapshot
                   ≈ ${m.network.at16PlayersKbPerSecond} kB/s for 16 players at 20 Hz
  gameplay         ${m.gameplay.shots} shots → ${m.gameplay.hits} hits (${(m.gameplay.accuracy * 100).toFixed(1)}%), ${m.gameplay.kills} kills
  match            phase ${m.gameplay.phase} · score ${m.gameplay.score.red}:${m.gameplay.score.blue}
  ───────────────────────────────────────────────────────────────
`);
  if (m.gameplay.topPlayer) process.stdout.write(`  leader           ${m.gameplay.topPlayer.name} — ${m.gameplay.topPlayer.score} pts (${m.gameplay.topPlayer.kills}/${m.gameplay.topPlayer.deaths})\n\n`);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
