/**
 * OminX Engine — play-mode chrome.
 *
 * The DOM shell around the game: the pause menu, the settings panel, the match-over actions, the
 * pointer-lock prompt and the "back to Studio" hand-off. Kept separate from `HUD` (which draws the
 * in-game information) and from `Engine` (which owns simulation) so a game can ship with the HUD
 * alone and no menus at all.
 *
 * @module src/app/PlayUI
 */
import { createLogger } from '../../engine/src/core/Logger.js';
import { QualityPreset } from '../../engine/src/renderer/Renderer.js';
import { MapKind } from '../../engine/src/world/LevelBuilder.js';

const log = createLogger('PlayUI');
const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

export class PlayUI {
  /**
   * @param {import('./Engine.js').Engine} engine
   * @param {object} [opts] `{ onStop }` — called when the player leaves play mode
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.onStop = opts.onStop ?? null;
    this.paused = false;
    this.attached = false;
    this.chrome = $('play-chrome');
    this.menu = $('menu');
    this.menuTitle = $('menu-title');
    this.menuSettings = $('menu-settings');
    this.chromeInfo = $('play-info');
    this.backendLabel = $('menu-backend');
    this._handlers = [];
  }

  attach() {
    if (this.attached) return this;
    this.attached = true;
    this.chrome.hidden = false;
    this._buildSettings();
    this._bindChrome();
    this._bindKeys();
    this._bindPointerLock();
    this._bindSession();
    this.backendLabel.textContent = `${this.engine.backend === 'webgpu' ? 'WebGPU / WGSL' : 'WebGL2 / GLSL'} · quality ${this.engine.settings.quality}`;
    this._tick = setInterval(() => this._updateInfo(), 250);
    return this;
  }

  detach() {
    this.attached = false;
    if (this.chrome) this.chrome.hidden = true;
    if (this.menu) this.menu.hidden = true;
    clearInterval(this._tick);
    for (const [target, type, handler] of this._handlers) target.removeEventListener(type, handler);
    this._handlers.length = 0;
    return this;
  }

  _on(target, type, handler) {
    if (!target) return;
    target.addEventListener(type, handler);
    this._handlers.push([target, type, handler]);
  }

  _bindChrome() {
    const handle = (action) => {
      switch (action) {
        case 'pause': this.showMenu(!this.paused); break;
        case 'resume': this.showMenu(false); break;
        case 'stop': this.stopToStudio(); break;
        case 'restart': this.engine.session?.restart?.(); this.engine.hud?.notice?.('Match restarted'); this.showMenu(false); break;
        case 'settings': this.engine.hud?.notice?.('Settings are in the pause menu (Esc)', '', 2); this.showMenu(true); break;
        default: log.warn(`unknown play action "${action}"`);
      }
    };
    for (const button of document.querySelectorAll('#play-chrome [data-action], #menu [data-action]')) {
      button.classList.add('bound');
      this._on(button, 'click', () => handle(button.dataset.action));
    }
    this._on(this.chrome, 'click', () => this.engine.input?.requestPointerLock?.());
  }

  _bindKeys() {
    this._on(document, 'keydown', (event) => {
      const typing = event.target && /input|textarea/i.test(event.target.tagName ?? '');
      if (typing) return;
      if (event.code === 'Escape') { event.preventDefault(); this.showMenu(!this.paused); return; }
      if (event.code === 'F5') { event.preventDefault(); this.engine.session?.restart?.(); return; }
      if (event.code === 'KeyP' && event.ctrlKey) { event.preventDefault(); this.showMenu(!this.paused); return; }
      if (event.code === 'Space' && this.engine.session?.phase === 'over') {
        event.preventDefault();
        this.engine.session.restart();
        this.showMenu(false);
      }
      if (event.code === 'Tab') {
        event.preventDefault();
        this.engine.hud?.setScoreboardVisible?.(true);
        this.engine.controller && (this.engine.controller.scoreboardVisible = true);
      }
    });
    this._on(document, 'keyup', (event) => {
      if (event.code === 'Tab') {
        this.engine.hud?.setScoreboardVisible?.(false);
        this.engine.controller && (this.engine.controller.scoreboardVisible = false);
      }
    });
  }

  _bindPointerLock() {
    this._on(document, 'pointerlockchange', () => {
      const locked = !!document.pointerLockElement;
      if (!locked && this.engine.mode === 'play' && !this.paused) this.showMenu(true);
      if (locked && this.paused) this.showMenu(false);
    });
    this._on(this.engine.canvas, 'click', () => {
      if (!this.paused) this.engine.input?.requestPointerLock?.();
    });
  }

  _bindSession() {
    const session = this.engine.session;
    session?.MatchOver?.connect?.((info) => {
      this.menuTitle.textContent = 'Match over';
      this.showMenu(true);
      void info;
    });
  }

  showMenu(show) {
    this.paused = !!show;
    if (this.menu) this.menu.hidden = !show;
    this.engine.paused = !!show;
    if (!show) {
      this.engine.input?.requestPointerLock?.();
      this.engine.input?.releaseAll?.();
    } else {
      this.engine.input?.exitPointerLock?.();
    }
    if (this.menuTitle) this.menuTitle.textContent = this.engine.session?.phase === 'over' ? 'Match over' : 'Paused';
    return this;
  }

  stopToStudio() {
    this.showMenu(false);
    this.detach();
    if (this.onStop) { this.onStop(); return; }
    // Default: reload into the Studio so the editor gets a clean scene.
    const url = new URL(location.href);
    url.searchParams.set('mode', 'studio');
    location.href = url.toString();
  }

  _updateInfo() {
    if (!this.chromeInfo) return;
    const engine = this.engine;
    const session = engine.session;
    if (!session) { this.chromeInfo.textContent = ''; return; }
    const local = session.localPlayer;
    const objectives = session.objectives.map((o) => `${o.label}:${o.owner}`).join(' ');
    this.chromeInfo.textContent = [
      `${Math.round(engine.fps)} fps`,
      `${session.teams.red.score} : ${session.teams.blue.score}`,
      `${session.phase} r${session.round}`,
      local ? `${local.kills}/${local.deaths} k/d` : '',
      objectives,
      `${engine.backend}`,
    ].filter(Boolean).join('   ·   ');
  }

  /** Settings panel: sliders and toggles bound straight to `Engine.applySettings`. */
  _buildSettings() {
    if (!this.menuSettings) return;
    const engine = this.engine;
    const rows = [];
    const slider = (key, label, min, max, step) => rows.push(`
      <label class="setting-row">
        <span>${label}</span>
        <input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}" value="${engine.settings[key]}" />
        <output data-output="${key}">${engine.settings[key]}</output>
      </label>`);
    const toggle = (key, label) => rows.push(`
      <label class="setting-row">
        <span>${label}</span>
        <input type="checkbox" data-setting="${key}" ${engine.settings[key] ? 'checked' : ''} />
        <output data-output="${key}"></output>
      </label>`);
    const select = (key, label, options) => rows.push(`
      <label class="setting-row">
        <span>${label}</span>
        <select data-setting="${key}">${options.map((option) => `<option value="${option}" ${engine.settings[key] === option ? 'selected' : ''}>${option}</option>`).join('')}</select>
        <output></output>
      </label>`);

    slider('sensitivity', 'Mouse sensitivity', 0.0004, 0.008, 0.0001);
    slider('fov', 'Field of view', 60, 120, 1);
    toggle('invertY', 'Invert vertical look');
    select('quality', 'Quality', Object.keys(QualityPreset));
    slider('renderScale', 'Render scale', 0.5, 1.5, 0.05);
    toggle('adaptiveQuality', 'Adaptive quality');
    toggle('shadows', 'Shadows');
    slider('viewDistance', 'View distance', 120, 900, 20);
    slider('masterVolume', 'Master volume', 0, 1, 0.05);
    slider('sfxVolume', 'SFX volume', 0, 1, 0.05);
    slider('hudScale', 'HUD scale', 0.7, 1.6, 0.05);
    toggle('showFps', 'Show performance stats');
    toggle('showNetGraph', 'Show network graph');
    select('botDifficulty', 'Bot difficulty', ['recruit', 'regular', 'hardened', 'elite']);
    slider('botCount', 'Bots (next match)', 0, 20, 1);
    toggle('friendlyFire', 'Friendly fire');
    select('crosshairStyle', 'Crosshair', ['dynamic', 'cross', 'static']);

    this.menuSettings.innerHTML = `<div class="settings-grid">${rows.join('')}</div>
      <div class="settings-row-actions">
        <button class="tool" data-action="apply-quality">Apply &amp; rebuild shaders</button>
        <button class="tool" data-action="reset-settings">Reset to defaults</button>
      </div>`;

    for (const input of this.menuSettings.querySelectorAll('[data-setting]')) {
      const key = input.dataset.setting;
      const output = this.menuSettings.querySelector(`[data-output="${key}"]`);
      this._on(input, 'input', () => {
        const value = input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value;
        engine.applySettings({ [key]: value });
        if (output && input.type === 'range') output.textContent = value;
      });
    }
    this._on(this.menuSettings.querySelector('[data-action="apply-quality"]'), 'click', () => {
      engine.renderer?.setQuality(engine.settings.quality);
      engine.hud?.notice?.(`Quality: ${engine.settings.quality}`);
    });
    this._on(this.menuSettings.querySelector('[data-action="reset-settings"]'), 'click', async () => {
      const { DefaultSettings } = await import('./Engine.js');
      engine.applySettings({ ...DefaultSettings }, { silent: true });
      engine.saveSettings();
      this._buildSettings();
      engine.hud?.notice?.('Settings reset');
    });
  }
}

export { MapKind };
export default PlayUI;
