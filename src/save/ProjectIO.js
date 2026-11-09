/**
 * OminX Engine — project persistence.
 *
 * A project is the scene (parts, environment, tags) plus the settings, scripts and metadata that
 * make it a game rather than a level file. Everything is plain JSON so a project can live in
 * localStorage, be handed around as a file, committed to git or streamed to a server.
 *
 * ```js
 * const io = new ProjectIO(engine);
 * io.saveSlot('autosave');            // localStorage slot
 * io.download('my-arena');            // .ominx.json file
 * await io.importFile(file);          // load a project back
 * ```
 *
 * @module src/save/ProjectIO
 */
import { SCENE_FORMAT_VERSION } from '../../engine/src/world/Scene.js';
import { createLogger } from '../../engine/src/core/Logger.js';
import { MapKind } from '../../engine/src/world/LevelBuilder.js';

const log = createLogger('ProjectIO');

export const PROJECT_FORMAT = 'ominx-project';
export const PROJECT_VERSION = 2;

export class ProjectIO {
  /**
   * @param {import('../app/Engine.js').Engine} engine
   * @param {object} [opts] `{ prefix }` — localStorage key prefix
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.prefix = opts.prefix ?? 'ominx.project.';
    this.scripts = opts.scripts ?? null;
    this.metadata = { name: 'Untitled Project', author: 'Anonymous', created: Date.now() };
  }

  // ------------------------------------------------------------------ serialize
  /** Captures the current world as a project object. */
  serialize(overrides = {}) {
    const engine = this.engine;
    const scene = engine.scene;
    return {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      sceneFormatVersion: SCENE_FORMAT_VERSION,
      name: overrides.name ?? this.metadata.name,
      author: overrides.author ?? this.metadata.author,
      created: this.metadata.created,
      savedAt: Date.now(),
      map: { kind: engine._mapInfo?.kind ?? null, seed: engine._mapInfo?.seed ?? null },
      settings: { ...engine.settings },
      scene: scene ? scene.save() : null,
      scripts: this.scripts?.serialize?.() ?? [],
      editor: engine.editor?.serialize?.() ?? null,
      stats: scene?.getStats?.() ?? null,
    };
  }

  /**
   * Replaces the running world with a project.
   * @param {object} project parsed project JSON
   */
  apply(project) {
    if (!project || typeof project !== 'object') throw new Error('not a project file');
    if (project.format && project.format !== PROJECT_FORMAT) throw new Error(`unknown project format "${project.format}"`);
    const engine = this.engine;
    const scene = engine.scene;
    if (!scene) throw new Error('no scene loaded — build a map first');

    if (project.settings) engine.applySettings(project.settings, { silent: true });
    if (project.scene) {
      // `Scene.load` clears the workspace and rebuilds the collision world + tag index.
      scene.load(project.scene);
      engine._syncRendererScene?.();
      engine.rebuildNav?.({ cell: 2 });
    }
    if (Array.isArray(project.scripts)) this.scripts?.load?.(project.scripts);
    if (project.editor) engine.editor?.restore?.(project.editor);
    this.metadata.name = project.name ?? this.metadata.name;
    this.metadata.author = project.author ?? this.metadata.author;
    this.metadata.created = project.created ?? this.metadata.created;
    engine.Notice?.emit?.(`Loaded "${this.metadata.name}"`);
    log.info(`project applied: ${project.scene?.workspace?.length ?? 0} workspace entries`);
    return this;
  }

  // ------------------------------------------------------------------ localStorage
  listSlots() {
    if (typeof localStorage === 'undefined') return [];
    const slots = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(this.prefix)) continue;
      try {
        const data = JSON.parse(localStorage.getItem(key));
        slots.push({ slot: key.slice(this.prefix.length), name: data.name, savedAt: data.savedAt, stats: data.stats });
      } catch {
        slots.push({ slot: key.slice(this.prefix.length), name: '(corrupt)', savedAt: null });
      }
    }
    return slots.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  }

  saveSlot(slot = 'autosave', overrides = {}) {
    if (typeof localStorage === 'undefined') return false;
    const project = this.serialize(overrides);
    try {
      localStorage.setItem(this.prefix + slot, JSON.stringify(project));
      log.info(`saved to slot "${slot}" (${(JSON.stringify(project).length / 1024).toFixed(1)} kB)`);
      this.engine.Notice?.emit?.(`Saved slot "${slot}"`);
      return project;
    } catch (error) {
      this.engine.Notice?.emit?.(`Save failed: ${error.message}`);
      log.error(error);
      return false;
    }
  }

  loadSlot(slot = 'autosave') {
    if (typeof localStorage === 'undefined') throw new Error('localStorage is unavailable');
    const raw = localStorage.getItem(this.prefix + slot);
    if (!raw) throw new Error(`slot "${slot}" is empty`);
    return this.apply(JSON.parse(raw));
  }

  deleteSlot(slot) {
    if (typeof localStorage === 'undefined') return false;
    localStorage.removeItem(this.prefix + slot);
    return true;
  }

  // ------------------------------------------------------------------ files
  /** Serializes and triggers a browser download of a `.ominx.json` project file. */
  download(name = this.metadata.name, overrides = {}) {
    const project = this.serialize({ name, ...overrides });
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${slugify(name)}.ominx.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log.info(`downloaded project file ${anchor.download}`);
    return project;
  }

  /** Reads a `File`/`Blob`/string and applies it. */
  async importFile(file) {
    const text = typeof file === 'string' ? file : await file.text();
    return this.apply(JSON.parse(text));
  }

  /** Opens a file picker and applies the chosen project (browser only). */
  openFilePicker() {
    if (typeof document === 'undefined') return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.ominx,application/json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { resolve(null); return; }
        try { resolve(this.importFile(file)); } catch (error) { reject(error); }
      };
      input.click();
    });
  }

  /** Regenerates the world from a map archetype (the editor's "New Map" flow). */
  async newProject({ kind = MapKind.Arena, seed = Math.floor(Math.random() * 100000), name = null } = {}) {
    await this.engine.loadMap(kind, { seed, nav: true });
    this.metadata = { name: name ?? `${kind}-${seed}`, author: this.metadata.author, created: Date.now() };
    this.engine.editor?.clearSelection?.();
    this.engine.Notice?.emit?.(`New map: ${this.metadata.name}`);
    return this;
  }
}

function slugify(text) {
  return String(text ?? 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

export { MapKind, slugify };
export default ProjectIO;
