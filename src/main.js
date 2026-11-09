/**
 * OminX Engine — application entry point.
 *
 * Boots the runtime, decides between Studio (editor) and the shipped FPS game, and wires the
 * globals the UI needs. Everything else lives in modules:
 *
 * ```
 *   src/app/Engine.js        runtime facade (renderer, scene, systems, mode switching)
 *   src/game/*               FPS layer: match session, player controller, HUD
 *   src/editor/*             Studio: hierarchy, inspector, gizmos, editor camera
 *   src/net/*  server/*      multiplayer transport + authoritative server
 *   src/audio/*              WebAudio mixer and procedural weapon/impact synthesis
 *   src/scripting/*          instance scripts (the engine's "code editor" runtime)
 *   src/save/* src/export/*  project persistence and standalone HTML builds
 * ```
 *
 * URL parameters: `?mode=play|studio`, `?map=urban`, `?seed=21`, `?bots=8`, `?difficulty=hardened`,
 * `?backend=webgl|webgpu`, `?server=ws://host:port`, `?quality=High`, `?debug=1`.
 *
 * @module src/main
 */
import { Engine } from './app/Engine.js';
import { MapKind } from '../engine/src/world/LevelBuilder.js';
import { createLogger } from '../engine/src/core/Logger.js';
import { PlayUI } from './app/PlayUI.js';

const log = createLogger('main');

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

const loading = {
  el: $('loading'),
  status: $('loading-status'),
  bar: $('loading-progress'),
  log: $('loading-log'),
  lines: 0,
};
function boot(message, progress = null) {
  log.info(message);
  if (loading.status) loading.status.textContent = message;
  if (loading.bar && progress !== null) loading.bar.style.width = `${Math.round(progress * 100)}%`;
  if (loading.log && loading.lines < 8) {
    const line = document.createElement('li');
    line.textContent = message;
    loading.log.appendChild(line);
    loading.lines++;
  }
}
function bootDone() {
  loading.el?.classList.add('done');
  setTimeout(() => loading.el?.remove?.(), 400);
}
function bootFail(error) {
  if (!loading.el) return;
  loading.el.classList.add('failed');
  if (loading.status) loading.status.innerHTML = `<b>Failed to start:</b> ${escapeHtml(error.message ?? String(error))}`;
  const pre = document.createElement('pre');
  pre.className = 'loading-error';
  pre.textContent = error.stack ?? '';
  loading.log?.appendChild(pre);
  log.error(error);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const mapFromParam = (name) => {
  if (!name) return null;
  const key = Object.keys(MapKind).find((k) => MapKind[k] === name.toLowerCase() || k.toLowerCase() === name.toLowerCase());
  return key ? MapKind[key] : null;
};

async function main() {
  const canvas = $('canvas');
  if (!canvas) throw new Error('#canvas is missing from index.html');
  const hudCanvas = $('hud-canvas');
  const requestedBackend = params.get('backend');
  const quality = params.get('quality');
  const botCount = Number(params.get('bots') ?? NaN);
  const mode = (params.get('mode') ?? 'studio').toLowerCase();
  const mapName = mapFromParam(params.get('map')) ?? (mode === 'play' ? MapKind.Urban : MapKind.Arena);
  const seed = Number(params.get('seed') ?? 21);

  boot('Creating the render device…', 0.05);
  if (!('gpu' in navigator)) boot('WebGPU not available in this browser — falling back to WebGL2');
  const engine = await Engine.create(canvas, {
    hudCanvas,
    backend: requestedBackend ?? 'auto',
    quality: quality ?? undefined,
    settings: {
      ...(quality ? { quality } : {}),
      ...(Number.isFinite(botCount) ? { botCount } : {}),
      ...(params.get('difficulty') ? { botDifficulty: params.get('difficulty') } : {}),
      ...(params.get('fov') ? { fov: Number(params.get('fov')) } : {}),
    },
    debug: params.get('debug') === '1',
  });
  globalThis.ominx = engine;
  boot(`Backend: ${engine.backend === 'webgpu' ? 'WebGPU (WGSL)' : 'WebGL2 (GLSL)'}`, 0.25);

  boot(`Building ${mapName} (seed ${seed})…`, 0.4);
  await engine.loadMap(mapName, { seed, nav: true });
  const info = engine._mapInfo;
  boot(`Map ready — ${info.stats?.parts ?? 0} parts, ${info.stats?.triangles ?? 0} triangles`, 0.6);

  // Notices and errors always reach the player, in both modes.
  engine.Notice.connect((message) => engine.hud?.notice?.(typeof message === 'string' ? message : message?.text ?? ''));

  const serverUrl = params.get('server');
  if (serverUrl) {
    boot(`Connecting to ${serverUrl}…`, 0.7);
    try {
      const { NetworkClient } = await import('./net/NetworkClient.js');
      engine.net = new NetworkClient(engine, { url: serverUrl, name: params.get('name') ?? 'Player' });
      await engine.net.connect();
      engine.hud.pushChat('system', `connected to ${serverUrl}`);
      boot('Connected — syncing match state', 0.8);
    } catch (error) {
      boot(`Multiplayer unavailable: ${error.message}`);
    }
  }

  if (mode === 'play') {
    boot('Starting match…', 0.85);
    const playUi = new PlayUI(engine);
    playUi.attach();
    engine.play();
    engine.topUpBots();
  } else {
    boot('Mounting Studio…', 0.85);
    try {
      await engine.enableEditor({ ui: true });
    } catch (error) {
      // The game must still run even if the editor bundle fails to mount.
      log.error(error);
      engine.Notice.emit(`Studio UI failed to mount: ${error.message}`);
    }
  }

  engine.start();
  bootDone();
  engine.hud.notice(`OminX Engine ready — ${engine.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}`, `${engine.stats.fps || 0} fps target`, 3.2);
  log.info(`boot complete in ${(performance.now() / 1000).toFixed(2)}s`);
}

main().catch((error) => {
  bootFail(error);
  console.error(error);
});

export { main, boot };
