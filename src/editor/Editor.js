/**
 * OminX Engine — Studio editor.
 *
 * The editor layer of the engine: viewport navigation, picking, selection, gizmos, undo/redo,
 * instance authoring, play-mode hand-off and project commands. It owns no DOM of its own — the
 * panels are built by `EditorUI` (loaded on demand) — so the same core drives an in-game level
 * editor, a headless scene tool or the full Studio chrome.
 *
 * ```js
 * const editor = await engine.enableEditor({ ui: true });
 * editor.setTool('move');
 * editor.addPart({ Shape: 'box', Position: [0, 2, 0] });
 * editor.play();               // snapshot → play → restore on stop
 * ```
 *
 * @module src/editor/Editor
 */
import { EditorCamera, EditorCameraMode } from './EditorCamera.js';
import { Gizmo, GizmoMode, GizmoSpace, setWorldPosition } from './Gizmo.js';
import { Vector3 } from '../../engine/src/math/Vector3.js';
import { Color3 } from '../../engine/src/math/Color3.js';
import { clamp } from '../../engine/src/math/MathUtils.js';
import { createLogger } from '../../engine/src/core/Logger.js';
import { Part, PartShape, SpawnPart, TriggerPart, CollisionLayer } from '../../engine/src/world/Part.js';
import { Instance } from '../../engine/src/core/Instance.js';
import { PropLibrary } from '../../engine/src/geometry/Props.js';
import { listProperties, getPropertyDefinition, PropertyCategory } from '../../engine/src/core/Property.js';

const log = createLogger('Editor');

const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

export class Editor {
  /**
   * @param {import('../app/Engine.js').Engine} engine
   * @param {object} [opts]
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.opts = opts;
    this.viewCamera = new EditorCamera(engine);
    this.camera = engine.camera;
    this.gizmo = new Gizmo(this);
    this.selected = [];
    this.history = new History(this);
    this.clipboard = [];
    this.console = [];
    this.consoleBuffer = 400;
    this.ui = null;
    this.mounted = false;
    this.playing = false;
    this.hovered = null;
    this.snap = true;
    this.gridVisible = true;
    this.showWires = false;
    this._playSnapshot = null;
    this._pointer = { x: 0, y: 0, inside: false, down: false, moved: false, button: -1, downAt: 0 };
    this._handlers = [];
    this._outlineItems = new Map();
    this._lastPickMs = 0;
    this._playUi = null;
    this._scratchRay = null;
    this._treeDirty = true;
    this.engine.renderer.editorMode = true;
    this.engine.renderer.editorGrid = this.gridVisible;
    this.engine.scene?.SceneChanged?.connect?.(() => { this._treeDirty = true; });
  }

  // ------------------------------------------------------------------ lifecycle
  /** Builds the Studio chrome and binds the viewport. */
  async mountUI(opts = {}) {
    const viewport = $('viewport') ?? this.engine.canvas?.parentElement;
    this.viewCamera.attach(viewport ?? window);
    this.attachViewport(viewport ?? this.engine.canvas);
    this.viewCamera.frameAll();
    try {
      const { EditorUI } = await import('./EditorUI.js');
      this.ui = new EditorUI(this, opts);
      await this.ui.mount();
    } catch (error) {
      log.warn(`Studio UI unavailable: ${error.message}`);
      this.mounted = false;
    }
    for (const line of this.console.slice(-6)) this.log(line.level, line.message, { silent: true });
    this.log('info', 'Studio ready — WASD fly, right-drag look, Q/W/E/R tools, F5 play');
    this.engine.Notice?.emit?.('Studio ready');
    return this.ui;
  }

  get mounted_() { return this.mounted; }

  /** Pointer + keyboard handling on the viewport. */
  attachViewport(element) {
    if (!element) return this;
    this._viewport = element;
    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this._handlers.push([target, type, handler]);
    };
    on(element, 'pointerdown', (event) => this.onPointerDown(event));
    on(window, 'pointermove', (event) => this.onPointerMove(event));
    on(window, 'pointerup', (event) => this.onPointerUp(event));
    on(element, 'dblclick', () => this.focusSelection());
    on(window, 'keydown', (event) => this.onKeyDown(event));
    on(window, 'beforeunload', () => this.persistLocal());
    this.mounted = true;
    return this;
  }

  detach() {
    for (const [target, type, handler] of this._handlers) target.removeEventListener(type, handler);
    this._handlers.length = 0;
    this.viewCamera.detach();
    this.gizmo._clear();
    return this;
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    if (this.playing) return this;
    this.viewCamera.enabled = !this.engine.input?.pointerLocked;
    this.viewCamera.update(dt);
    this.refreshSelectionRender();

    // Hover + gizmo highlight follow the pointer (throttled to ~60 Hz) while not dragging.
    if (this._pointer.inside && !this.gizmo.drag && !this.viewCamera.dragging && performance.now() - this._lastPickMs > 16) {
      this._lastPickMs = performance.now();
      this.updateHover();
    }
    const camera = this.engine.camera;
    this.gizmo.update(camera, this.selected);
    this.updateOverlay();
    return this;
  }

  updateOverlay() {
    const stats = $('viewport-stats');
    if (stats && this.engine.frame % 6 === 0) {
      const info = this.engine.stats;
      const selection = this.selected.length;
      stats.textContent = `${info.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'} · ${info.fps} fps · ${info.drawCalls} draws · ${info.triangles.toLocaleString()} tris · ${info.parts} parts · ${selection} selected · ${this.viewCamera.speedLabel}`;
    }
    const hint = $('gizmo-hint');
    if (hint) {
      const hovered = this.gizmo.hovered ? `axis ${this.gizmo.hovered.axis.toUpperCase()} · ` : '';
      hint.textContent = this.playing ? '' : `${hovered}${this.gizmo.mode} tool · ${this.gizmo.space} space${this.gizmo.snap ? ' · snap on' : ''}`;
    }
  }

  onPlayStart() {
    this.playing = true;
    this._playSnapshot = this.engine.scene.save();
    this._selectionBeforePlay = this.selected.slice();
    this.playSelection = this.selected.slice();
    this.selected = [];
    this.gizmo._clear();
    this.viewCamera.enabled = false;
    $('studio')?.classList.add('playing');
    return this;
  }

  onPlayStop() {
    this.playing = false;
    this.viewCamera.enabled = true;
    $('studio')?.classList.remove('playing');
    if (this._playSnapshot) {
      // Play mode may have destroyed parts, spawned bots or mutated the environment — restore it.
      this.engine.scene.load(this._playSnapshot);
      this.engine._syncRendererScene();
      this.engine.rebuildNav({ cell: 2 });
      this._playSnapshot = null;
    }
    const restored = (this._selectionBeforePlay ?? []).filter((instance) => !instance.IsDestroyed && instance.Parent);
    this.setSelection(restored);
    this.gizmo._clear();
    this.log('info', 'play mode stopped — scene restored');
    return this;
  }

  /** Enters play mode (F5). */
  play(opts = {}) {
    if (this.playing) return this.engine.session;
    return this.engine.play(opts);
  }

  /** Leaves play mode and restores the edited scene. */
  stop() {
    if (this.engine.mode === 'play') this.engine.stopPlay();
    this.playing = false;
    return this;
  }

  // ------------------------------------------------------------------ selection
  get primary() { return this.selected[this.selected.length - 1] ?? null; }

  setSelection(instances, { silent = false } = {}) {
    this.selected = (Array.isArray(instances) ? instances : [instances]).filter(Boolean);
    this.refreshSelectionRender();
    this.ui?.onSelectionChanged?.(this.selected);
    if (!silent && this.selected.length === 1) this.log('info', `selected ${this.selected[0].getFullName()}`);
    return this;
  }

  select(instance, { additive = false } = {}) {
    if (!instance) return this.setSelection([]);
    if (this.gizmo.mode === GizmoMode.Select || !additive) return this.setSelection([instance]);
    const index = this.selected.indexOf(instance);
    if (index >= 0) this.selected.splice(index, 1);
    else this.selected.push(instance);
    return this.setSelection(this.selected);
  }

  clearSelection() { return this.setSelection([]); }

  selectByName(name, { recursive = true } = {}) {
    const instance = this.engine.scene?.findFirstChild?.(name, recursive) ?? null;
    if (!instance) { this.log('warn', `no instance named "${name}"`); return null; }
    this.setSelection([instance]);
    this.focusSelection();
    return instance;
  }

  selectByTag(tag) {
    const instances = this.engine.scene?.getTagged?.(tag) ?? [];
    this.setSelection(instances);
    this.log('info', `${instances.length} instances tagged "${tag}"`);
    return instances;
  }

  /** Highlights the selection with the renderer's outline pass. */
  refreshSelectionRender() {
    const renderer = this.engine.renderer;
    const list = renderer.renderList?.items ?? [];
    for (const item of this._outlineItems.values()) renderer.renderOutline(item, this.engine.camera, [0, 0, 0, 0]);
    this._outlineItems.clear();
    for (const instance of this.selected) {
      const item = list.find((candidate) => candidate.owner === instance);
      if (!item) continue;
      renderer.renderOutline(item, this.engine.camera, [1, 0.62, 0.1, 1]);
      this._outlineItems.set(instance, item);
    }
    return this;
  }

  // ------------------------------------------------------------------ picking
  /** Canvas-relative pixel point → world ray. */
  rayFromPointer(clientX, clientY) {
    const canvas = this.engine.canvas;
    const rect = canvas.getBoundingClientRect();
    const x = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1) * this.camera.viewport.width;
    const y = clamp((clientY - rect.top) / Math.max(rect.height, 1), 0, 1) * this.camera.viewport.height;
    const ray = this.camera.screenToRay(x, y);
    ray.screen = { x: clientX, y: clientY, canvasX: x, canvasY: y };
    return ray;
  }

  /** A ray in clip space plus the screen delta carried by `updateDrag` for free-move. */
  _dragRay(ray) {
    const delta = {
      x: this._pointer.x - this._pointer.lastX,
      y: this._pointer.y - this._pointer.lastY,
    };
    this._pointer.lastX = this._pointer.x;
    this._pointer.lastY = this._pointer.y;
    return { origin: ray.origin, direction: ray.direction, screenDelta: delta, screen: ray.screen };
  }

  /** Finds the topmost part under a ray (collision first, AABB fallback). */
  pickPart(ray) {
    const scene = this.engine.scene;
    if (!scene) return null;
    const hits = scene.raycastAll?.(ray.origin, ray.direction, {
      maxDistance: 500,
      triggers: true,
      layerMask: CollisionLayer.All,
      ignore: this._ignoreParts(),
    }) ?? [];
    for (const hit of hits) {
      const part = hit.part ?? hit.collider?.part;
      if (part && !part.Locked) return { part, hit };
    }
    // Fallback: analytic AABB test over every part (catches parts with collisions disabled).
    let best = null;
    let bestDistance = Infinity;
    for (const part of scene.getParts?.() ?? []) {
      if (part.Locked || part.Transparency >= 1) continue;
      const bounds = part.worldBounds;
      if (!bounds || bounds.isEmpty()) continue;
      const distance = rayAABB(ray, bounds);
      if (distance === null || distance > bestDistance) continue;
      bestDistance = distance;
      best = part;
    }
    return best ? { part: best, hit: null } : null;
  }

  _ignoreParts() {
    return [];
  }

  updateHover() {
    const ray = this.rayFromPointer(this._pointer.x, this._pointer.y);
    const gizmoHit = this.gizmo.hitTest(ray);
    this.gizmo.hovered = gizmoHit;
    this.engine.canvas.style.cursor = gizmoHit ? 'crosshair' : 'default';
    const picked = gizmoHit ? null : this.pickPart(ray);
    this.hovered = picked?.part ?? null;
    this.ui?.onHoverChanged?.(this.hovered);
  }

  // ------------------------------------------------------------------ pointer
  onPointerDown(event) {
    if (this.playing) return;
    if (event.button === 2) return; // camera look
    if (event.button === 1) return; // camera pan
    this._pointer.x = event.clientX;
    this._pointer.y = event.clientY;
    this._pointer.lastX = event.clientX;
    this._pointer.lastY = event.clientY;
    this._pointer.down = true;
    this._pointer.moved = false;
    this._pointer.button = event.button;
    this._pointer.altKey = event.altKey;
    this._pointer.downAt = performance.now();

    const ray = this.rayFromPointer(event.clientX, event.clientY);
    const gizmoHit = this.gizmo.hitTest(ray);
    if (gizmoHit && this.selected.length) {
      this.gizmo.beginDrag(gizmoHit, ray, this.selected);
      this._pointer.mode = 'gizmo';
      event.preventDefault();
      return;
    }
    this._pointer.mode = 'select';
  }

  onPointerMove(event) {
    this._pointer.inside = true;
    this._pointer.x = event.clientX;
    this._pointer.y = event.clientY;
    if (!this._pointer.down) return;
    if (this.gizmo.drag && this._pointer.mode === 'gizmo') {
      const ray = this.rayFromPointer(event.clientX, event.clientY);
      this.gizmo.updateDrag(this._dragRay(ray));
      this.ui?.onTransformChanged?.(this.selected);
      return;
    }
    if (Math.abs(event.clientX - this._pointer.lastX) + Math.abs(event.clientY - this._pointer.lastY) > 3) this._pointer.moved = true;
  }

  onPointerUp(event) {
    if (!this._pointer.down) {
      this._pointer.inside = true;
      return;
    }
    this._pointer.down = false;
    if (this._pointer.mode === 'gizmo' && this.gizmo.drag) {
      this.gizmo.endDrag(true);
      this.ui?.onTransformChanged?.(this.selected);
      this._pointer.mode = null;
      return;
    }
    this._pointer.mode = null;
    if (event.button !== 0) return;
    if (this._pointer.moved) return; // drag-select / camera drag, not a click
    const ray = this.rayFromPointer(event.clientX, event.clientY);
    const picked = this.pickPart(ray);
    if (!picked) { if (!event.shiftKey) this.clearSelection(); return; }
    this.select(picked.part, { additive: event.shiftKey || event.ctrlKey || event.metaKey });
  }

  // ------------------------------------------------------------------ keyboard
  onKeyDown(event) {
    if (this.playing) return;
    const target = event.target;
    if (target && (/input|textarea|select/i.test(target.tagName ?? '') || target.isContentEditable)) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const code = event.code;
    if (ctrl && code === 'KeyZ') { event.preventDefault(); event.shiftKey ? this.history.redo() : this.history.undo(); this.ui?.refresh(); return; }
    if (ctrl && code === 'KeyY') { event.preventDefault(); this.history.redo(); this.ui?.refresh(); return; }
    if (ctrl && code === 'KeyD') { event.preventDefault(); this.duplicateSelection(); return; }
    if (ctrl && code === 'KeyC') { this.copySelection(); return; }
    if (ctrl && code === 'KeyV') { this.paste(); return; }
    if (ctrl && code === 'KeyS') { event.preventDefault(); this.saveProject(); return; }
    if (ctrl && code === 'KeyN') { event.preventDefault(); this.newMap(); return; }
    if (ctrl && code === 'KeyA') { event.preventDefault(); this.setSelection(this.engine.scene?.getParts?.() ?? []); return; }
    if (event.shiftKey && code === 'KeyS') { event.preventDefault(); this.toggleSnap(); return; }
    switch (code) {
      case 'KeyQ': this.setTool(GizmoMode.Select); break;
      case 'KeyW': this.setTool(GizmoMode.Move); break;
      case 'KeyE': this.setTool(GizmoMode.Rotate); break;
      case 'KeyR': this.setTool(GizmoMode.Scale); break;
      case 'KeyG': this.toggleGrid(); break;
      case 'KeyX': this.toggleSpace(); break;
      case 'KeyF': this.focusSelection(); break;
      case 'Home': this.viewCamera.frameAll(); break;
      case 'Digit1': this.viewCamera.setView('front'); break;
      case 'Digit3': this.viewCamera.setView('side'); break;
      case 'Digit7': this.viewCamera.setView('top'); break;
      case 'Delete': case 'Backspace': event.preventDefault(); this.deleteSelection(); break;
      case 'F5': event.preventDefault(); event.shiftKey ? this.stop() : this.play(); break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ tools
  setTool(mode) {
    if (!Object.values(GizmoMode).includes(mode)) return this;
    this.gizmo.setMode(mode);
    this.ui?.onToolChanged?.(mode);
    return this;
  }

  toggleSpace() {
    this.gizmo.setSpace(this.gizmo.space === GizmoSpace.World ? GizmoSpace.Local : GizmoSpace.World);
    this.log('info', `gizmo space: ${this.gizmo.space}`);
    return this;
  }

  toggleSnap(force = null) {
    this.gizmo.snap = force ?? !this.gizmo.snap;
    this.ui?.onToolChanged?.(this.gizmo.mode);
    return this;
  }

  toggleGrid(force = null) {
    this.gridVisible = force ?? !this.gridVisible;
    this.engine.renderer.editorGrid = this.gridVisible;
    return this;
  }

  toggleWires() {
    this.showWires = !this.showWires;
    this.engine.renderer.setDebugMode?.(this.showWires ? 'collision' : 'none');
    this.log('info', `collision wireframes ${this.showWires ? 'on' : 'off'}`);
    return this;
  }

  focusSelection() {
    if (!this.selected.length) return this.viewCamera.frameAll();
    const center = new Vector3();
    let radius = 2;
    for (const instance of this.selected) {
      const world = instance.worldPosition ?? instance.Position ?? new Vector3();
      center.addScaled(world, 1 / this.selected.length);
      const size = instance.Size ?? null;
      radius = Math.max(radius, size ? Math.max(size.x, size.y, size.z) * 0.9 : 2);
    }
    return this.viewCamera.focus(center, radius);
  }

  // ------------------------------------------------------------------ authoring
  /** Inserts a part at the camera focus point (or above a fixed spot). */
  addPart(opts = {}) {
    const scene = this.engine.scene;
    if (!scene) return null;
    const position = opts.Position ? Vector3.new(opts.Position.x ?? opts.Position[0], opts.Position.y ?? opts.Position[1], opts.Position.z ?? opts.Position[2])
      : this.spawnPointAhead();
    this.history.begin('insert part');
    const part = scene.createPart({
      Name: opts.Name ?? (opts.Shape ? `${cap(opts.Shape)}` : 'Part'),
      Shape: opts.Shape ?? PartShape.Box,
      Size: opts.Size ? new Vector3(opts.Size.x ?? opts.Size[0], opts.Size.y ?? opts.Size[1], opts.Size.z ?? opts.Size[2]) : new Vector3(2, 2, 2),
      Anchored: opts.Anchored ?? true,
      ...opts,
      Position: position,
    });
    this.history.end(true);
    this.setSelection([part]);
    this.log('info', `inserted ${part.Name} at ${fmt(position)}`);
    return part;
  }

  /** Instantiates a prop from the geometry library under the pointer. */
  addProp(name, position = null) {
    const scene = this.engine.scene;
    if (!scene) return null;
    const def = PropLibrary[name];
    if (!def) { this.log('warn', `unknown prop "${name}"`); return null; }
    this.history.begin(`insert ${name}`);
    const part = scene.spawnProp(name, position ?? this.spawnPointAhead());
    this.history.end(true);
    if (part) {
      this.setSelection([part]);
      this.log('info', `inserted prop ${name}`);
    }
    return part;
  }

  /** Spawn point (SpawnLocation) for the current team layout. */
  addSpawn(team = 'red') {
    const scene = this.engine.scene;
    const { SpawnPart } = SceneParts;
    const part = new SpawnPart({ Name: `Spawn_${team}_${(scene.getTagged('spawn').length % 99) + 1}`, Team: team, Color: Color3.fromCSS(team === 'red' ? '#e0503c' : '#3f7dff') });
    part.Position = this.spawnPointAhead(0.2);
    scene.addPart(part);
    this.setSelection([part]);
    this.log('info', `added ${team} spawn point`);
    return part;
  }

  /** Capture objective (point) — the TDM/Domination marker. */
  addObjective(label = null) {
    const scene = this.engine.scene;
    const { TriggerPart } = SceneParts;
    const objectives = scene.getTagged('objective');
    const name = label ?? String.fromCharCode(65 + (objectives.length % 26));
    const part = new TriggerPart({
      Name: `Objective_${name}`,
      Size: new Vector3(6, 3, 6),
      Label: name,
      tags: ['objective', `objective:${name}`],
    });
    part.Position = this.spawnPointAhead(0.2);
    scene.addPart(part);
    scene.objectives.push(part);
    this.setSelection([part]);
    this.log('info', `added objective ${name}`);
    return part;
  }

  /** Lights live in the scene's Lighting folder; this inserts a lamp part. */
  addLight(kind = 'point') {
    const scene = this.engine.scene;
    const part = scene.createPart({
      Name: `${cap(kind)}Light`,
      Shape: PartShape.Sphere,
      Size: new Vector3(0.6, 0.6, 0.6),
      Material: 'hazard',
      Anchored: true,
      CanCollide: false,
    });
    part.Position = this.spawnPointAhead(0.4);
    part.setAttribute?.('light', { kind, range: 14, intensity: 2.2, color: '#ffd9a0' });
    this.setSelection([part]);
    this.log('info', `inserted ${kind} light`);
    return part;
  }

  /** Point in front of the editor camera, placed on the ground plane. */
  spawnPointAhead(drop = 0.4) {
    const camera = this.camera;
    const forward = Vector3.new(camera.forward.x, 0, camera.forward.z).normalize();
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    const origin = camera.worldPosition;
    const height = Math.max(origin.y, 2);
    const distance = clamp(height * 1.4, 4, 26);
    const point = Vector3.new(origin.x + forward.x * distance, 0, origin.z + forward.z * distance);
    const probe = this.engine.scene?.raycast?.(Vector3.new(point.x, origin.y + 30, point.z), Vector3.new(0, -1, 0), { maxDistance: 200 });
    point.y = (probe?.point?.y ?? 0) + drop;
    return point;
  }

  deleteSelection() {
    if (!this.selected.length) return 0;
    this.history.begin('delete');
    const count = this.selected.length;
    for (const instance of this.selected) instance.destroy();
    this.history.end(true);
    this.setSelection([]);
    this.engine._syncRendererScene?.();
    this.log('info', `deleted ${count} instance${count === 1 ? '' : 's'}`);
    return count;
  }

  duplicateSelection() {
    if (!this.selected.length) return [];
    this.history.begin('duplicate');
    const clones = this.selected.map((instance) => {
      const clone = instance.clone(true);
      clone.Name = `${instance.Name}_copy`;
      const parent = instance.Parent ?? this.engine.scene.Workspace;
      clone.setParent(parent);
      const offset = Vector3.new(2, 0, 2);
      if (clone.Position) setWorldPosition(clone, (instance.worldPosition ?? instance.Position).clone().add(offset));
      return clone;
    });
    this.history.end(true);
    this.engine._syncRendererScene?.();
    this.setSelection(clones);
    return clones;
  }

  copySelection() {
    this.clipboard = this.selected.map((instance) => instance.toJSON?.() ?? null).filter(Boolean);
    this.log('info', `copied ${this.clipboard.length} instance(s)`);
    return this.clipboard;
  }

  paste(position = null) {
    if (!this.clipboard.length) return [];
    this.history.begin('paste');
    const clones = [];
    for (const json of this.clipboard) {
      const instance = Instance.deserialize(json);
      if (!instance) continue;
      instance.setParent?.(this.engine.scene.Workspace);
      if (position && instance.Position) instance.Position = position;
      clones.push(instance);
    }
    this.history.end(true);
    this.engine._syncRendererScene?.();
    this.setSelection(clones);
    return clones;
  }

  /** Reparents the current selection. */
  reparent(child, parent) {
    if (!child || !parent || child === parent) return false;
    if (child.isAncestorOf?.(parent)) { this.log('warn', 'cannot parent an instance to its own descendant'); return false; }
    this.history.begin('reparent');
    child.setParent(parent, true);
    this.history.end(true);
    this._treeDirty = true;
    return true;
  }

  rename(instance, name) {
    if (!instance || !name) return false;
    this.history.begin('rename');
    instance.Name = name;
    this.history.end(true);
    this._treeDirty = true;
    this.log('info', `renamed to "${name}"`);
    return true;
  }

  /** Sets a property through its descriptor (used by the inspector). */
  setProperty(instance, name, value, { commit = true } = {}) {
    if (!instance) return false;
    const definition = getPropertyDefinition(instance.constructor, name);
    if (!definition) return false;
    if (!this._propertyTx) {
      this._propertyTx = this.history.begin(`set ${name}`);
    }
    instance[name] = value;
    if (commit && this._propertyTx) {
      const tx = this._propertyTx;
      this._propertyTx = null;
      this.history.end(true, tx);
    }
    return true;
  }

  setEnvironment(key, value) {
    const scene = this.engine.scene;
    if (!scene?.environment) return false;
    scene.environment[key] = value;
    this.engine.applyEnvironment?.();
    this.engine.renderer?.applyEnvironment?.(scene.environment);
    return true;
  }

  /** Rebuilds the AI navmesh after large geometry edits. */
  rebuildNav() {
    const info = this.engine.rebuildNav?.({ cell: 2 });
    this.ui?.refreshEnvironment?.();
    return info;
  }

  // ------------------------------------------------------------------ projects
  async newMap(kind = null, seed = null) {
    this.history.clear();
    this.setSelection([]);
    const mapKind = kind ?? this.engine._mapInfo?.kind ?? 'arena';
    await this.engine.loadMap(mapKind === 'sandbox' ? 'arena' : mapKind, {
      seed: seed ?? Math.floor(Math.random() * 100000),
      nav: true,
    });
    this.engine.io?.newProject?.({ kind: mapKind, seed: seed ?? (this.engine._mapInfo?.seed ?? 21) });
    this.viewCamera.frameAll();
    this._treeDirty = true;
    this.ui?.refresh();
    return this.engine._mapInfo;
  }

  saveProject(slot = 'autosave') {
    const io = this.engine.io;
    if (!io) return null;
    const saved = io.saveSlot(slot, { name: io.metadata.name });
    if (saved) this.log('info', `project saved to slot "${slot}"`);
    return saved;
  }

  loadProject(slot = 'autosave') {
    const io = this.engine.io;
    if (!io) return null;
    this.history.clear();
    this.setSelection([]);
    const project = io.loadSlot(slot);
    this.engine._syncRendererScene?.();
    this.viewCamera.frameAll();
    this.ui?.refresh();
    return project;
  }

  /** Autosave into localStorage (also called before unload). */
  persistLocal() {
    try { this.engine.io?.saveSlot?.('autosave', { name: this.engine.io?.metadata?.name }); } catch { /* storage full or unavailable */ }
    return this;
  }

  async exportHTML(opts = {}) {
    const exporter = this.engine.exporter;
    if (!exporter) return null;
    const html = exporter.downloadStandalone({ title: this.engine.io?.metadata?.name ?? 'OminX Game', ...opts });
    this.log('info', 'standalone build exported');
    return html;
  }

  /** Boots the host manifest download for the local server. */
  buildProjectManifest(opts = {}) {
    return this.engine.exporter?.buildServerManifest?.(opts) ?? null;
  }

  // ------------------------------------------------------------------ console
  log(level, message, { silent = false } = {}) {
    const line = { level, message: String(message), time: Date.now() };
    this.console.push(line);
    if (this.console.length > this.consoleBuffer) this.console.splice(0, this.console.length - this.consoleBuffer);
    if (!silent) this.ui?.appendConsole?.(line);
    if (level === 'error') log.error(message);
    return line;
  }

  consoleBufferLines() { return this.console; }

  /**
   * Runs a Studio console command. The command set is intentionally small but complete enough to
   * drive a whole session from the keyboard: `help`, `spawn`, `select`, `goto`, `set`, `play`,
   * `stop`, `bots`, `quality`, `net`, `nav`, `save`, `load`, `export`, `fps`, `time`, `clear`.
   */
  runCommand(text) {
    const input = String(text ?? '').trim();
    if (!input) return null;
    this.log('info', `> ${input}`);
    const [command, ...args] = input.split(/\s+/);
    const rest = args.join(' ');
    switch (command.toLowerCase()) {
      case 'help':
        this.log('info', COMMANDS.join('  ·  '));
        return COMMANDS;
      case 'spawn': case 'prop': {
        const name = args[0];
        if (!name || !PropLibrary[name]) { this.log('warn', `unknown prop — try: ${Object.keys(PropLibrary).slice(0, 12).join(', ')}…`); return null; }
        return this.addProp(name);
      }
      case 'part':
        return this.addPart({ Shape: args[0] ?? 'box' });
      case 'select':
        return this.selectByName(args[0]);
      case 'tag':
        return this.selectByTag(args[0]);
      case 'goto': {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((value) => !Number.isFinite(value))) { this.log('warn', 'usage: goto <x> <y> <z>'); return null; }
        this.viewCamera.position.set(x, y, z);
        this.viewCamera.apply();
        return true;
      }
      case 'set': {
        const instance = this.primary;
        if (!instance) { this.log('warn', 'nothing selected'); return null; }
        const value = parseValue(rest.slice(args[0].length));
        this.setProperty(instance, args[0], value);
        this.ui?.refreshInspector?.();
        return value;
      }
      case 'play': this.play(); return true;
      case 'stop': this.stop(); return true;
      case 'bots': {
        const count = Number(args[0]);
        if (!Number.isFinite(count)) { this.engine.settings.botCount = this.engine.session?.bots?.length ?? 0; }
        else this.engine.settings.botCount = clamp(count, 0, 32);
        this.log('info', `botCount = ${this.engine.settings.botCount}`);
        return this.engine.settings.botCount;
      }
      case 'quality': {
        const name = args[0];
        if (!name) { this.log('info', `quality = ${this.engine.settings.quality}`); return this.engine.settings.quality; }
        this.engine.applySettings({ quality: name });
        this.engine.saveSettings?.();
        this.log('info', `quality = ${name}`);
        return name;
      }
      case 'time': {
        const hours = Number(args[0]);
        if (!Number.isFinite(hours)) { this.log('info', `time of day = ${this.engine.scene?.environment?.dayTime ?? 12}`); return null; }
        this.setEnvironment('dayTime', clamp(hours, 0, 24));
        this.ui?.refreshEnvironment?.();
        return hours;
      }
      case 'nav': this.rebuildNav(); return true;
      case 'save': this.saveProject(args[0] ?? 'autosave'); return true;
      case 'load': this.loadProject(args[0] ?? 'autosave'); return true;
      case 'export': this.exportHTML(); return true;
      case 'fps': this.log('info', `${this.engine.stats.fps} fps · ${this.engine.stats.drawCalls} draws · ${this.engine.stats.triangles} tris`); return this.engine.stats;
      case 'net': {
        this.log('info', this.engine.net ? `net ${this.engine.net.state} · ping ${this.engine.net.ping ?? '—'} ms` : 'not connected');
        return this.engine.net;
      }
      case 'wire': this.toggleWires(); return true;
      case 'clear': this.console.length = 0; this.ui?.clearConsole?.(); return true;
      default:
        this.log('warn', `unknown command "${command}" — try help`);
        return null;
    }
  }

  // ------------------------------------------------------------------ data
  /** Nested hierarchy model for the Explorer panel. */
  getHierarchy() {
    const root = this.engine.scene;
    if (!root) return [];
    const walk = (instance) => instance.getChildren()
      .filter((child) => child.ClassName !== 'Camera' && !child.Name.startsWith('__'))
      .map((child) => ({ instance: child, children: walk(child) }));
    return walk(root);
  }

  /** Property groups for the inspector: `[{ category, definitions: [{def, value}] }]`. */
  getPropertyGroups(instance = this.primary) {
    if (!instance) return [];
    const definitions = listProperties(instance.constructor, { includeHidden: true });
    const groups = new Map();
    for (const definition of definitions) {
      const category = definition.category ?? PropertyCategory.Behavior;
      if (definition.name === 'Tags') continue; // tags are edited in the header
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push({ definition, value: instance[definition.name] });
    }
    for (const [instance2] of groups) void instance2;
    return [...groups].map(([category, entries]) => ({
      category,
      entries: entries.sort((a, b) => (a.definition.order ?? 0) - (b.definition.order ?? 0)),
    }));
  }

  describeTransaction(label) { return label; }

  serialize() {
    return {
      camera: this.viewCamera.serialize(),
      gizmo: { mode: this.gizmo.mode, space: this.gizmo.space, snap: this.gizmo.snap },
      grid: this.gridVisible,
      selection: this.selected.map((instance) => instance.getFullName()),
    };
  }

  restore(data = {}) {
    if (!data) return this;
    this.viewCamera.restore(data.camera);
    if (data.gizmo) {
      this.gizmo.setMode(data.gizmo.mode ?? GizmoMode.Move);
      this.gizmo.setSpace(data.gizmo.space ?? GizmoSpace.World);
      this.gizmo.snap = data.gizmo.snap !== false;
    }
    if (typeof data.grid === 'boolean') this.toggleGrid(data.grid);
    if (data.selection?.length) {
      const instances = data.selection.map((path) => this.engine.scene?.findByPath?.(path)).filter(Boolean);
      this.setSelection(instances);
    }
    return this;
  }
}

// --------------------------------------------------------------------------- undo/redo
class History {
  constructor(editor) {
    this.editor = editor;
    this.undoStack = [];
    this.redoStack = [];
    this.limit = 64;
    this.pending = null;
  }

  /** Opens a transaction — the scene is snapshotted so it can be rolled back. */
  begin(label = 'edit') {
    if (this.pending) return this.pending;
    this.pending = { label, before: this.snapshot() };
    return this.pending;
  }

  /** Closes the transaction. `commit: false` rolls back to the snapshot. */
  end(commit = true, explicit = null) {
    const transaction = explicit ?? this.pending;
    this.pending = null;
    if (!transaction) return false;
    if (!commit) {
      this.editor.engine.scene?.load?.(transaction.before);
      this.editor.engine._syncRendererScene?.();
      return false;
    }
    const after = this.snapshot();
    if (after === transaction.before) return false;
    this.undoStack.push({ label: transaction.label, before: transaction.before, after });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.editor.ui?.updateHistoryButtons?.();
    return true;
  }

  snapshot() { return JSON.stringify(this.editor.engine.scene?.save?.() ?? {}); }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) { this.editor.log('info', 'nothing to undo'); return false; }
    this.editor.engine.scene.load(JSON.parse(entry.before));
    this.editor.engine._syncRendererScene?.();
    this.editor.setSelection([]);
    this.redoStack.push(entry);
    this.editor.log('info', `undo ${entry.label}`);
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) { this.editor.log('info', 'nothing to redo'); return false; }
    this.editor.engine.scene.load(JSON.parse(entry.after));
    this.editor.engine._syncRendererScene?.();
    this.editor.setSelection([]);
    this.undoStack.push(entry);
    this.editor.log('info', `redo ${entry.label}`);
    return true;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pending = null;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}

// --------------------------------------------------------------------------- helpers
const COMMANDS = [
  'help', 'spawn <prop>', 'part <shape>', 'select <name>', 'tag <tag>', 'goto <x> <y> <z>',
  'set <Property> <value>', 'play', 'stop', 'bots <n>', 'quality <preset>', 'time <hours>',
  'nav', 'save [slot]', 'load [slot]', 'export', 'fps', 'net', 'wire', 'clear',
];

function cap(text) { return String(text ?? '').charAt(0).toUpperCase() + String(text ?? '').slice(1); }
function fmt(v) { return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`; }

function parseValue(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return true;
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed);
  if (/^-?\d*\.?\d+$/.test(trimmed)) return Number(trimmed);
  const parts = trimmed.split(/[,\s]+/).map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) return new Vector3(parts[0], parts[1], parts[2]);
  if (parts.length === 2 && parts.every(Number.isFinite)) return { x: parts[0], y: parts[1] };
  return trimmed;
}

/** Slab test against an AABB; returns the entry distance or null. */
function rayAABB(ray, bounds) {
  const origin = ray.origin;
  const direction = ray.direction;
  let tMin = 0;
  let tMax = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const o = origin[axis];
    const d = direction[axis];
    const min = bounds.min[axis];
    const max = bounds.max[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < min || o > max) return null;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}

const SceneParts = { SpawnPart, TriggerPart };

export { History, GizmoMode, GizmoSpace, EditorCameraMode, rayAABB, parseValue, COMMANDS, SceneParts, Instance, Part };
export default Editor;
