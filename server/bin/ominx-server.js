#!/usr/bin/env node
/**
 * OminX Engine — dedicated server entry point.
 *
 * ```sh
 * npm run server                                     # defaults: urban, seed 21, 8 bots, port 8787
 * node server/bin/ominx-server.js --map facility --bots 12 --port 9000 --mode domination
 * node server/bin/ominx-server.js --help
 * ```
 *
 * The server owns the match: clients send input, the server simulates, everyone receives snapshots.
 * A status page (player list, score, tick rate) is served on the same port as the WebSocket, so
 * `http://localhost:8787` is always a quick way to check that a match is alive.
 *
 * @module server/bin/ominx-server
 */
import { MatchServer } from '../src/MatchServer.js';
import { MatchMode } from '../src/MatchRunner.js';
import { MapKind } from '../../engine/src/world/LevelBuilder.js';
import { setLogLevel } from '../../engine/src/core/Logger.js';

const HELP = `
OminX dedicated server

Usage: node server/bin/ominx-server.js [options]

  --port <n>          listen port                     (default 8787)
  --host <addr>       bind address                    (default 0.0.0.0)
  --map <name>        ${Object.values(MapKind).join(' | ')}
  --seed <n>          map seed                        (default 21)
  --bots <n>          bot count, 0–32                 (default 8)
  --difficulty <d>    recruit | regular | hardened | elite | nightmare
  --mode <m>          ${Object.values(MatchMode).join(' | ')}
  --score-limit <n>   team score to win                (default 60)
  --time-limit <s>    round length in seconds          (default 600)
  --tick-rate <n>     simulation rate                  (default 60)
  --snapshot-rate <n> broadcast rate                   (default 20)
  --warmup <s>        warmup duration                  (default 5)
  --max-players <n>   connection cap                   (default 16)
  --quiet             only warnings and errors
  --help
`;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'help') return { help: true };
    if (key === 'quiet') { options.quiet = true; continue; }
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

if (args.quiet) setLogLevel('error');

const number = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const mapName = Object.values(MapKind).find((kind) => kind === args.map) ?? MapKind.Urban;
const mode = Object.values(MatchMode).find((kind) => kind === args.mode) ?? MatchMode.TDM;

const server = new MatchServer({
  port: number(args.port, 8787),
  host: args.host ?? '0.0.0.0',
  tickRate: number(args['tick-rate'], 60),
  snapshotRate: number(args['snapshot-rate'], 20),
  match: {
    map: mapName,
    seed: number(args.seed, 21),
    bots: Math.min(32, number(args.bots, 8)),
    difficulty: args.difficulty ?? 'regular',
    mode,
    scoreLimit: number(args['score-limit'], 60),
    timeLimit: number(args['time-limit'], 600),
    warmup: number(args.warmup, 5),
    maxPlayers: number(args['max-players'], 16),
  },
});

async function main() {
  const banner = (port) => `
    OminX dedicated server
    ─────────────────────────────────────────
    map        ${mapName} (seed ${number(args.seed, 21)})
    mode       ${mode}   score limit ${number(args['score-limit'], 60)}
    bots       ${Math.min(32, number(args.bots, 8))} · ${args.difficulty ?? 'regular'}
    sim        ${number(args['tick-rate'], 60)} Hz · snapshots ${number(args['snapshot-rate'], 20)} Hz
    status     http://localhost:${port}/
    websocket  ws://localhost:${port}
    ─────────────────────────────────────────
    point the Studio at the ws:// URL, or open the game with
    ?mode=play&server=ws://localhost:${port}
  `;


  // Bring the listener up *before* the console: `main` returning without it is a clean exit with
  // no server running, which is exactly what happened the first time this CLI was launched.
  await server.listen();
  process.stdout.write(banner(server.options.port));

  /** Console commands, so a running server can be driven without a client. */
  if (!process.stdin.isTTY) return;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const [command, ...rest] = line.trim().split(/\s+/);
      switch (command) {
        case '': break;
        case 'help':
          process.stdout.write('commands: stats, players, bots <n>, restart, difficulty <d>, quit\n');
          break;
        case 'stats':
          process.stdout.write(`${JSON.stringify(server.runner.stats, null, 2)}\n`);
          break;
        case 'players':
          for (const row of server.runner.getScoreboard().players) {
            process.stdout.write(`  ${row.name.padEnd(18)} ${String(row.team).padEnd(5)} ${String(row.kills).padStart(3)}/${String(row.deaths).padEnd(3)} ${String(row.score).padStart(5)} ${row.bot ? 'bot' : 'human'}\n`);
          }
          break;
        case 'bots':
          process.stdout.write(`bots → ${server.runner.setBotCount(Number(rest[0]) || 0)}\n`);
          break;
        case 'restart':
          server.runner.restart();
          process.stdout.write('match restarted\n');
          break;
        case 'difficulty':
          if (rest[0]) {
            server.runner.options.difficulty = rest[0];
            process.stdout.write(`difficulty → ${rest[0]} (applies to new bots)\n`);
          }
          break;
        case 'quit':
          process.stdout.write('shutting down…\n');
          await server.close();
          process.exit(0);
          break;
        default:
          process.stdout.write(`unknown command "${command}" — try help\n`);
      }
    }
  });

  const shutdown = async (signal) => {
    process.stdout.write(`\n${signal} received — closing server\n`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  process.stderr.write(`server failed to start: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
