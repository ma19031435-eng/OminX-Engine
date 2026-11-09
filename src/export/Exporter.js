/**
 * OminX Engine — build & asset export.
 *
 * Three export paths, in increasing fidelity:
 *
 *  1. **Scene JSON** — the workspace only, for handing a level to another tool.
 *  2. **Standalone HTML** — a single file that boots the engine with the project inlined as JSON.
 *     It loads the engine modules that ship with the deployment (`/src/...`, produced by
 *     `npm run build`), so the file is a launcher: the same page works locally, on a static host,
 *     or inside the game's own viewer route.
 *  3. **Server manifest** — the server-side descriptor (`server/manifests/*.json`) used by the
 *     authoritative server to run a match without a browser.
 *
 * The exporter never mutates the running project: it serializes, then writes.
 *
 * @module src/export/Exporter
 */
import { createLogger } from '../../engine/src/core/Logger.js';
import { PROJECT_FORMAT, PROJECT_VERSION, slugify } from '../save/ProjectIO.js';

const log = createLogger('Exporter');

export class Exporter {
  /**
   * @param {import('../app/Engine.js').Engine} engine
   * @param {import('../save/ProjectIO.js').ProjectIO} [io]
   */
  constructor(engine, io = null) {
    this.engine = engine;
    this.io = io;
  }

  /** Workspace-only export: parts, transforms, tags — no settings, no scripts. */
  exportScene() {
    const scene = this.engine.scene;
    if (!scene) throw new Error('no scene to export');
    return scene.save({ pretty: true });
  }

  /** Full project descriptor (the same object `ProjectIO.serialize` writes to disk). */
  exportProject(overrides = {}) {
    return this.io?.serialize(overrides) ?? null;
  }

  /**
   * Builds the standalone HTML viewer.
   * @param {object} [opts] `{ title, play, server, quality }`
   * @returns {string} HTML document
   */
  buildStandaloneHTML(opts = {}) {
    const project = this.exportProject({ name: opts.title ?? this.io?.metadata.name });
    const title = opts.title ?? project?.name ?? 'OminX Game';
    const params = new URLSearchParams({
      mode: opts.play === false ? 'studio' : 'play',
      ...(opts.server ? { server: opts.server } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
    });
    const json = JSON.stringify(project);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STANDALONE_CSS}</style>
</head>
<body>
<div id="viewport" class="viewport">
  <canvas id="canvas" class="render-canvas"></canvas>
  <canvas id="hud-canvas" class="hud-canvas"></canvas>
  <div id="hud-root" class="hud-root"></div>
</div>
<div id="play-chrome" class="play-chrome" hidden></div>
<div id="menu" class="menu-overlay" hidden>
  <div class="menu-card">
    <h2 id="menu-title">Paused</h2>
    <div class="menu-actions">
      <button class="tool accent" data-action="resume">Resume</button>
      <button class="tool" data-action="restart">Restart</button>
    </div>
  </div>
</div>
<div id="loading" class="loading">
  <div class="loading-card">
    <h1>${escapeHtml(title)}</h1>
    <p id="loading-status">Loading…</p>
    <div class="loading-bar"><span id="loading-progress"></span></div>
  </div>
</div>
<script type="application/json" id="ominx-project">${json.replace(/</g, '\\u003c')}</script>
<script type="module">
  import { Engine } from '/src/app/Engine.js';
  import { PlayUI } from '/src/app/PlayUI.js';
  import { AudioEngine } from '/src/audio/AudioEngine.js';
  import { ScriptRuntime } from '/src/scripting/ScriptRuntime.js';
  import { ProjectIO } from '/src/save/ProjectIO.js';

  const params = new URLSearchParams(${JSON.stringify(params.toString())});
  const project = JSON.parse(document.getElementById('ominx-project').textContent);
  const status = (text, progress) => {
    document.getElementById('loading-status').textContent = text;
    if (progress !== undefined) document.getElementById('loading-progress').style.width = progress + '%';
  };

  const engine = await Engine.create(document.getElementById('canvas'), {
    hudCanvas: document.getElementById('hud-canvas'),
    settings: project.settings ?? {},
  });
  window.ominx = engine;
  engine.audio ??= new AudioEngine({ settings: engine.settings });
  engine.scripts = new ScriptRuntime(engine, {
    onOutput: ({ level, message }) => (level === 'error' ? console.error(message) : level === 'warn' ? console.warn(message) : console.log(message)),
  });
  engine.io = new ProjectIO(engine, { scripts: engine.scripts });

  status('Building world…', 35);
  const map = project.map ?? { kind: 'arena', seed: 1337 };
  await engine.loadMap(map.kind ?? 'arena', { seed: map.seed ?? 1337, nav: true });
  engine.io.apply(project);
  status('Starting match…', 70);

  const ui = new PlayUI(engine);
  ui.attach();
  engine.play();
  engine.scripts.start();
  engine.start();
  document.getElementById('loading').style.opacity = '0';
  setTimeout(() => document.getElementById('loading')?.remove(), 400);
  ${opts.server ? `_net: { engine.net = (await import('/src/net/NetworkClient.js')).NetworkClient ? new (await import('/src/net/NetworkClient.js')).NetworkClient(engine, { url: '${opts.server}' }) : null; await engine.net?.connect(); }` : ''}
</script>
</body>
</html>`;
  }

  /** Triggers a browser download of the standalone build. */
  downloadStandalone(opts = {}) {
    const html = this.buildStandaloneHTML(opts);
    const name = slugify(opts.title ?? this.io?.metadata.name ?? 'game');
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name}.html`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log.info(`standalone build written: ${anchor.download} (${(html.length / 1024).toFixed(1)} kB)`);
    return html;
  }

  /**
   * Server manifest: what `server/bin/ominx-server.js` needs to host this project headlessly.
   */
  buildServerManifest(opts = {}) {
    const project = this.exportProject();
    const spawns = this.engine._mapInfo?.spawns ?? { red: [], blue: [] };
    return {
      format: `${PROJECT_FORMAT}-server`,
      version: PROJECT_VERSION,
      name: project?.name ?? 'untitled',
      mode: opts.mode ?? 'tdm',
      map: project?.map ?? null,
      ticksPerSecond: opts.ticksPerSecond ?? 60,
      snapshotRate: opts.snapshotRate ?? 20,
      maxPlayers: opts.maxPlayers ?? 16,
      bots: opts.bots ?? this.engine.settings.botCount,
      botDifficulty: opts.botDifficulty ?? this.engine.settings.botDifficulty,
      scoreLimit: this.engine.settings.scoreLimit,
      timeLimit: this.engine.settings.timeLimitMinutes * 60,
      spawns: {
        red: (spawns.red ?? []).map(toPlain),
        blue: (spawns.blue ?? []).map(toPlain),
      },
      objectives: (this.engine._mapInfo?.objectives ?? []).map((objective) => ({
        label: objective.label,
        position: toPlain(objective.position),
      })),
      parts: this.engine.scene?.getParts?.().length ?? 0,
      exportedAt: Date.now(),
    };
  }

  /** Publishes the project to a running server (used by the Studio's "Host match" action). */
  async publish(url, opts = {}) {
    const manifest = this.buildServerManifest(opts);
    const response = await fetch(`${url.replace(/\/$/, '')}/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    if (!response.ok) throw new Error(`server rejected the manifest (${response.status})`);
    return response.json();
  }
}

function toPlain(vector) {
  if (!vector) return { x: 0, y: 0, z: 0 };
  return { x: vector.x ?? 0, y: vector.y ?? 0, z: vector.z ?? 0 };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

const STANDALONE_CSS = `
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#05070a;color:#dbe4ee;font-family:system-ui,sans-serif;overflow:hidden}
.viewport{position:absolute;inset:0}.render-canvas,.hud-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.hud-canvas{pointer-events:none;z-index:5}.hud-root{position:absolute;inset:0;pointer-events:none;z-index:6}
.play-chrome{position:absolute;inset:0;z-index:12;pointer-events:none}.play-chrome>*{pointer-events:auto}
.menu-overlay,.loading{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(4,6,10,.75)}
.menu-overlay[hidden]{display:none}.menu-card,.loading-card{background:#0d1219;border:1px solid #232f3d;border-radius:12px;padding:22px 26px;min-width:320px;text-align:center}
.menu-actions{display:flex;gap:6px;justify-content:center}
.tool{background:#131a24;border:1px solid #232f3d;color:#8fa0b4;padding:6px 12px;border-radius:5px;cursor:pointer}
.tool.accent{background:linear-gradient(180deg,#ffbe5c,#f0a02f);color:#17130a;border-color:#ffcf80;font-weight:600}
.loading-bar{height:4px;background:#1b2430;border-radius:3px;overflow:hidden;margin-top:12px}
.loading-bar span{display:block;height:100%;width:2%;background:linear-gradient(90deg,#ffb347,#57b6ff);transition:width .3s}
`;

export default Exporter;
