/**
 * OminX Engine — Studio UI.
 *
 * The panels around the viewport: Explorer (hierarchy), Assets, Scripts, Properties/inspector,
 * Environment, Network, the Output console and the toolbar. It is a thin DOM layer over `Editor`
 * (which owns selection, tools, undo/redo and commands) — every button here maps to an `Editor`
 * method, so the same actions are available from the console, from scripts and from the keyboard.
 *
 * The markup it generates matches `src/styles.css`; no framework, no template engine, no CDN: the
 * Studio is a few hundred lines of explicit DOM plus a code editor that upgrades itself to Monaco
 * when the module is available and falls back to a styled textarea when it is not.
 *
 * @module src/editor/EditorUI
 */
import { PropLibrary } from '../../engine/src/geometry/Props.js';
import { MaterialLibrary } from '../../engine/src/renderer/Material.js';
import { WeaponLibrary, GrenadeLibrary } from '../../engine/src/gameplay/Weapons.js';
import { GizmoMode } from './Gizmo.js';
import { DEFAULT_SCRIPT_SOURCE } from '../scripting/ScriptRuntime.js';
import { Vector3 } from '../../engine/src/math/Vector3.js';
import { Color3 } from '../../engine/src/math/Color3.js';
import { clamp, clamp01 } from '../../engine/src/math/MathUtils.js';
import { createLogger } from '../../engine/src/core/Logger.js';

const log = createLogger('EditorUI');
const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

const CLASS_ICONS = {
  Scene: '◆', Folder: '▤', Part: '▣', MeshPart: '◈', TriggerPart: '◎', SpawnPart: '⌖',
  Light: '☀', Camera: '⌾', Actor: '☻', Player: '☻', Bot: '☻', Model: '▦', Decal: '▧',
  Prop: '▣', Weapon: '⌐', Instance: '·', SpawnLocation: '⌖', PointLight: '☀',
};

export class EditorUI {
  constructor(editor, opts = {}) {
    this.editor = editor;
    this.engine = editor.engine;
    this.opts = opts;
    this.filter = 'all';
    this.treeFilter = '';
    this.assetFilter = '';
    this.assetCategory = 'props';
    this.activeTab = { left: 'hierarchy', right: 'properties' };
    this.expanded = new Set();
    this.selectedScript = null;
    this.collapsedTree = new Set();
    this._handlers = [];
    this._treeDirty = true;
    this._lastFrameUpdate = 0;
  }

  // ------------------------------------------------------------------ mount
  async mount() {
    this._cacheDom();
    this._bindToolbar();
    this._bindTabs();
    this._bindConsole();
    this._bindSearch();
    this._bindInspectorHeader();
    this._bindViewportDrops();
    this._bindSignals();
    this._bindKeys();
    this.refresh();
    await this._mountCodeEditor();
    this.appendConsole({ level: 'info', message: 'Studio UI ready', time: Date.now() });
    return this;
  }

  _cacheDom() {
    this.dom = {
      toolbar: $('toolbar'),
      studio: $('studio'),
      status: $('studio-status'),
      tree: $('hierarchy'),
      treeSearch: $('tree-search'),
      assets: $('asset-browser'),
      assetSearch: $('asset-search'),
      inspector: $('inspector'),
      selectionClass: $('selection-class'),
      selectionName: $('selection-name'),
      environment: $('environment-panel'),
      environmentExtra: $('environment-extra'),
      networkPlayers: $('net-players'),
      netUrl: $('net-url'),
      scriptList: $('script-list'),
      scriptEditor: $('script-editor'),
      scriptOutput: $('script-output'),
      consoleBody: $('console-body'),
      consoleInput: $('console-input'),
      consoleFilters: $('console-filters'),
      viewport: $('viewport'),
      playRestore: $('play-restore'),
      menu: $('menu'),
      dialog: $('dialog'),
      dialogTitle: $('dialog-title'),
      dialogBody: $('dialog-body'),
      dialogOk: $('dialog-ok'),
      dialogCancel: $('dialog-cancel'),
    };
  }

  /** Every `[data-action]` in the toolbar/panels maps to a method on `Editor`. */
  _bindToolbar() {
    const handlers = {
      'new-map': () => this.confirmNewMap(),
      'open-slot': () => this.editor.loadProject('autosave'),
      'save-slot': () => this.editor.saveProject('autosave'),
      'download-project': () => this.engine.io?.download?.() ?? this.editor.log('warn', 'project I/O unavailable'),
      'export-html': () => this.editor.exportHTML(),
      'tool-select': () => this.editor.setTool(GizmoMode.Select),
      'tool-move': () => this.editor.setTool(GizmoMode.Move),
      'tool-rotate': () => this.editor.setTool(GizmoMode.Rotate),
      'tool-scale': () => this.editor.setTool(GizmoMode.Scale),
      'toggle-snap': () => this.editor.toggleSnap(),
      'toggle-space': () => this.editor.toggleSpace(),
      undo: () => { this.editor.history.undo(); this.refreshInspector(); },
      redo: () => { this.editor.history.redo(); this.refreshInspector(); },
      duplicate: () => this.editor.duplicateSelection(),
      delete: () => this.editor.deleteSelection(),
      'add-part': () => this.editor.addPart({ Shape: 'box' }),
      'add-spawn': () => this.editor.addSpawn('red'),
      'add-objective': () => this.editor.addObjective(),
      'add-light': () => this.editor.addLight('point'),
      'rebuild-nav': () => this.editor.rebuildNav(),
      play: () => this.editor.play(),
      'play-bots': () => this.editor.play({ bots: this.engine.settings.botCount || 8 }),
      stop: () => this.editor.stop(),
      'console-clear': () => this.clearConsole(),
      'console-collapse': () => this.toggleConsole(),
      'net-connect': () => this.connectNetwork(),
      'net-disconnect': () => this.engine.net?.close?.(),
      'script-new': () => this.createScript(),
      'script-run': () => this.runScript(),
      'script-stop': () => { this.engine.scripts?.stop?.(); this.refreshScripts(); },
    };
    for (const element of document.querySelectorAll('[data-action]')) {
      const action = element.dataset.action;
      const handler = handlers[action];
      if (!handler) continue;
      const listener = (event) => {
        event.preventDefault();
        try { handler(); } catch (error) { this.editor.log('error', `${action}: ${error.message}`); log.error(error); }
      };
      element.addEventListener('click', listener);
      this._handlers.push([element, 'click', listener]);
    }
    this.dom.playRestore?.addEventListener('change', () => { this.editor.restoreOnStop = this.dom.playRestore.checked; });
  }

  _bindTabs() {
    for (const group of document.querySelectorAll('.panel-tabs[data-tabs]')) {
      const side = group.dataset.tabs;
      const panel = group.parentElement;
      for (const tab of group.querySelectorAll('.tab')) {
        const listener = () => {
          for (const other of group.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
          for (const page of panel.querySelectorAll('.tab-page')) page.classList.toggle('active', page.dataset.page === tab.dataset.tab);
          this.activeTab[side] = tab.dataset.tab;
          if (tab.dataset.tab === 'assets') this.refreshAssets();
          if (tab.dataset.tab === 'scripts') this.refreshScripts();
          if (tab.dataset.tab === 'network') this.refreshNetwork();
          if (tab.dataset.tab === 'environment') this.refreshEnvironment();
        };
        tab.addEventListener('click', listener);
        this._handlers.push([tab, 'click', listener]);
      }
    }
  }

  _bindConsole() {
    this.dom.consoleInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const value = this.dom.consoleInput.value;
      this.dom.consoleInput.value = '';
      this.runConsoleCommand(value);
    });
    for (const chip of document.querySelectorAll('#console-filters .chip')) {
      const listener = () => {
        this.filter = chip.dataset.filter;
        for (const other of document.querySelectorAll('#console-filters .chip')) other.classList.toggle('active', other === chip);
        this.renderConsole();
      };
      chip.addEventListener('click', listener);
      this._handlers.push([chip, 'click', listener]);
    }
  }

  _bindSearch() {
    this.dom.treeSearch?.addEventListener('input', () => {
      this.treeFilter = this.dom.treeSearch.value.toLowerCase();
      this.refreshTree();
    });
    this.dom.assetSearch?.addEventListener('input', () => {
      this.assetFilter = this.dom.assetSearch.value.toLowerCase();
      this.refreshAssets();
    });
  }

  _bindInspectorHeader() {
    this.dom.selectionName?.addEventListener('change', () => {
      const instance = this.editor.primary;
      if (!instance) return;
      this.editor.rename(instance, this.dom.selectionName.value.trim() || instance.Name);
      this.refreshTree();
    });
  }

  /** Asset cards can be dragged straight into the 3D viewport. */
  _bindViewportDrops() {
    const viewport = this.dom.viewport;
    if (!viewport) return;
    const over = (event) => { event.preventDefault(); };
    const drop = (event) => {
      event.preventDefault();
      const name = event.dataTransfer?.getData('text/ominx-prop');
      if (!name) return;
      const ray = this.editor.rayFromPointer(event.clientX, event.clientY);
      const picked = this.editor.pickPart(ray);
      const position = picked?.hit?.point ? picked.hit.point.clone().add(new Vector3(0, 0.2, 0)) : this.editor.spawnPointAhead();
      if (PropLibrary[name]) this.editor.addProp(name, position);
      else this.editor.addPart({ Name: name, Material: name, Position: position });
    };
    viewport.addEventListener('dragover', over);
    viewport.addEventListener('drop', drop);
    this._handlers.push([viewport, 'dragover', over], [viewport, 'drop', drop]);
  }

  _bindSignals() {
    const connect = (signal, handler) => {
      if (!signal?.connect) return;
      const wrapped = (...args) => handler(...args);
      signal.connect(wrapped);
      this._handlers.push([signal, 'disconnect', wrapped]);
    };
    this.engine.Notice?.connect?.((message) => {
      this.appendConsole({ level: 'info', message: typeof message === 'string' ? message : message?.text ?? '', time: Date.now() });
    });
    connect(this.engine.scene?.SceneChanged, () => { this._treeDirty = true; });
    connect(this.engine.MapLoaded, () => { this.refresh(); this.editor.viewCamera.frameAll(); });
    connect(this.engine.ModeChanged, () => this.updatePlayButtons());
    this.engine.FrameEnd?.connect?.(() => this.tickFrame());
  }

  _bindKeys() {
    const listener = (event) => {
      const target = event.target;
      if (target && /input|textarea|select/i.test(target.tagName ?? '')) {
        if (event.ctrlKey && event.key === 'Enter' && target.id === 'script-code') this.runScript();
        return;
      }
      if (event.ctrlKey && event.code === 'KeyP') { event.preventDefault(); this.cycleRightTab(); }
      if (event.ctrlKey && event.code === 'KeyB') { event.preventDefault(); this.toggleConsole(); }
    };
    document.addEventListener('keydown', listener);
    this._handlers.push([document, 'keydown', listener]);
  }

  // ------------------------------------------------------------------ frame
  tickFrame() {
    const now = performance.now();
    if (now - this._lastFrameUpdate < 250) return;
    this._lastFrameUpdate = now;
    if (!this.dom.status) return;
    const stats = this.engine.stats;
    const net = this.engine.net;
    const parts = [
      `<b>${stats.fps}</b> fps`,
      `${stats.drawCalls} draws`,
      `${(stats.triangles / 1000).toFixed(0)}k tris`,
      `${stats.parts} parts`,
      this.engine.nav ? `${this.engine.nav.nodes?.length ?? 0} nav` : 'no nav',
      this.engine.backend === 'webgpu' ? 'WebGPU' : 'WebGL2',
    ];
    if (net) parts.push(`net ${net.ping ?? '—'}ms`);
    this.dom.status.innerHTML = parts.join(' · ');
    const playInfo = $('play-info');
    if (playInfo && this.engine.mode === 'play' && this.engine.session) {
      const session = this.engine.session;
      playInfo.textContent = `${session.mode?.toUpperCase?.() ?? 'MATCH'} · ${session.redTeam?.length ?? 0}v${session.blueTeam?.length ?? 0} · score ${session.teams?.red?.score ?? 0}:${session.teams?.blue?.score ?? 0} · ${stats.fps} fps`;
    }
  }

  refresh() {
    this.refreshTree();
    this.refreshAssets();
    this.refreshInspector();
    this.refreshEnvironment();
    this.refreshScripts();
    this.refreshNetwork();
    this.updateHistoryButtons();
    this.updatePlayButtons();
  }

  // ------------------------------------------------------------------ explorer
  refreshTree() {
    const root = this.dom.tree;
    if (!root) return;
    const hierarchy = this.editor.getHierarchy();
    if (!hierarchy.length && this.engine.scene) {
      root.innerHTML = '<div class="empty-hint">The workspace is empty — insert a part from the toolbar.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const node of hierarchy) this._buildTreeNode(node, fragment, 0);
    root.replaceChildren(fragment);
  }

  _buildTreeNode(node, parent, depth) {
    const instance = node.instance;
    const name = instance.Name ?? '?';
    if (this.treeFilter && !this._matchesFilter(instance, node)) return;
    const path = instance.getFullName?.() ?? name;
    const open = !this.collapsedTree.has(path);
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = path;
    row.dataset.class = instance.ClassName;
    if (this.editor.selected.includes(instance)) row.classList.add('selected');
    if (instance.Visible === false) row.classList.add('hidden-instance');
    row.innerHTML = `
      <span class="twisty">${node.children.length ? (open ? '▾' : '▸') : '·'}</span>
      <span class="icon">${CLASS_ICONS[instance.ClassName] ?? '▫'}</span>
      <span class="label">${escapeHtml(name)}</span>
      <span class="meta">${this._instanceMeta(instance)}</span>`;
    row.draggable = true;
    row.addEventListener('click', (event) => {
      const twisty = event.target.closest('.twisty');
      if (twisty && node.children.length) {
        if (this.collapsedTree.has(path)) this.collapsedTree.delete(path);
        else this.collapsedTree.add(path);
        this.refreshTree();
        return;
      }
      this.editor.select(instance, { additive: event.shiftKey || event.ctrlKey || event.metaKey });
    });
    row.addEventListener('dblclick', () => { this.editor.setSelection([instance]); this.editor.focusSelection(); });
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/ominx-instance', path);
      event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.style.borderColor = 'var(--accent)';
    });
    row.addEventListener('dragleave', () => { row.style.borderColor = ''; });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.style.borderColor = '';
      const from = event.dataTransfer?.getData('text/ominx-instance');
      if (!from) return;
      const child = this.engine.scene?.findByPath?.(from) ?? this.engine.scene?.findFirstChild?.(from.split('.').pop(), true);
      if (child && instance.isA?.('Instance') !== false) this.editor.reparent(child, instance);
      this.refreshTree();
    });
    parent.appendChild(row);
    if (node.children.length && open) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      for (const child of node.children) this._buildTreeNode(child, children, depth + 1);
      parent.appendChild(children);
    }
  }

  _matchesFilter(instance, node) {
    if (instance.Name?.toLowerCase().includes(this.treeFilter)) return true;
    if (instance.ClassName?.toLowerCase().includes(this.treeFilter)) return true;
    if ((instance.getAllAttributes?.() ? Object.keys(instance.getAllAttributes()).join(' ') : '').toLowerCase().includes(this.treeFilter)) return true;
    return node.children.some((child) => this._matchesFilter(child.instance, child));
  }

  _instanceMeta(instance) {
    if (instance.Size) return `${instance.Size.x.toFixed(1)}×${instance.Size.y.toFixed(1)}×${instance.Size.z.toFixed(1)}`;
    if (instance.ClassName === 'Scene') return 'scene';
    const children = instance.getChildren?.().length ?? 0;
    return children ? `${children} items` : '';
  }

  // ------------------------------------------------------------------ assets
  refreshAssets() {
    const root = this.dom.assets;
    if (!root) return;
    const entries = [];
    for (const name of Object.keys(PropLibrary)) entries.push({ name, kind: 'prop' });
    for (const name of [...new Set(Object.values(MaterialLibrary))].sort()) entries.push({ name, kind: 'material' });
    for (const id of Object.keys(WeaponLibrary)) entries.push({ name: id, kind: 'weapon' });
    for (const id of Object.keys(GrenadeLibrary)) entries.push({ name: id, kind: 'grenade' });

    const filter = this.assetFilter;
    const visible = entries.filter((entry) => (!filter || entry.name.toLowerCase().includes(filter)));
    const groups = { prop: [], material: [], weapon: [], grenade: [] };
    for (const entry of visible) groups[entry.kind].push(entry);

    const fragment = document.createDocumentFragment();
    for (const [kind, list] of Object.entries(groups)) {
      if (!list.length) continue;
      const header = document.createElement('div');
      header.className = 'inspector-section';
      header.innerHTML = `<header>${kind}s <span class="meta">${list.length}</span></header>`;
      fragment.appendChild(header);
      const grid = document.createElement('div');
      grid.className = 'asset-browser';
      for (const entry of list) {
        const card = document.createElement('div');
        card.className = 'asset-card';
        card.draggable = true;
        card.title = `Click to insert ${entry.name} in front of the camera — or drag it into the viewport`;
        card.innerHTML = `<div class="thumb">${thumbFor(entry)}</div><div class="name">${escapeHtml(entry.name)}</div>`;
        card.addEventListener('dragstart', (event) => {
          event.dataTransfer?.setData('text/ominx-prop', entry.name);
          event.dataTransfer.effectAllowed = 'copy';
        });
        card.addEventListener('click', () => this.insertAsset(entry));
        grid.appendChild(card);
      }
      fragment.appendChild(grid);
    }
    if (!fragment.childNodes.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'Nothing matches that search.';
      fragment.appendChild(hint);
    }
    root.replaceChildren(fragment);
  }

  insertAsset(entry) {
    const position = this.editor.spawnPointAhead();
    if (entry.kind === 'prop') return this.editor.addProp(entry.name, position);
    if (entry.kind === 'weapon') return this.editor.addPart({ Name: `Weapon_${entry.name}`, Shape: 'box', Size: new Vector3(0.9, 0.25, 0.25), Material: 'WeaponGunmetal', Position: position });
    if (entry.kind === 'grenade') return this.editor.addPart({ Name: `Grenade_${entry.name}`, Shape: 'sphere', Size: new Vector3(0.16, 0.16, 0.16), Material: 'metal', Position: position });
    return this.editor.addPart({ Name: `Part_${entry.name}`, Material: entry.name, Position: position });
  }

  // ------------------------------------------------------------------ inspector
  refreshInspector() {
    const inspector = this.dom.inspector;
    const instance = this.editor.primary;
    if (!inspector) return;
    if (this.dom.selectionClass) this.dom.selectionClass.textContent = instance ? instance.ClassName : 'nothing selected';
    if (this.dom.selectionName) {
      this.dom.selectionName.disabled = !instance;
      this.dom.selectionName.value = instance?.Name ?? '';
    }
    if (!instance) {
      inspector.innerHTML = '<div class="empty-hint">Select an instance in the Explorer, or click it in the viewport.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const group of this.editor.getPropertyGroups(instance)) {
      const section = document.createElement('div');
      section.className = 'inspector-section';
      const header = document.createElement('header');
      header.textContent = group.category;
      section.appendChild(header);
      const fields = document.createElement('div');
      fields.className = 'fields';
      for (const entry of group.entries) fields.appendChild(this._buildPropertyRow(instance, entry.definition, entry.value));
      section.appendChild(fields);
      fragment.appendChild(section);
    }
    const tags = document.createElement('div');
    tags.className = 'inspector-section';
    tags.innerHTML = '<header>Tags &amp; attributes</header>';
    const tagFields = document.createElement('div');
    tagFields.className = 'fields';
    tagFields.appendChild(this._buildTextRow('Tags', [...(instance._tags ?? [])].join(', '), (value) => {
      for (const tag of [...(instance._tags ?? [])]) instance.removeTag?.(tag);
      for (const tag of value.split(',').map((t) => t.trim()).filter(Boolean)) instance.addTag?.(tag);
      this.refreshTree();
    }));
    for (const [name, value] of Object.entries(instance.getAllAttributes?.() ?? {})) {
      tagFields.appendChild(this._buildTextRow(name, typeof value === 'object' ? JSON.stringify(value) : String(value), (text) => {
        try { instance.setAttribute(name, JSON.parse(text)); } catch { instance.setAttribute(name, text); }
      }));
    }
    tags.appendChild(tagFields);
    fragment.appendChild(tags);
    inspector.replaceChildren(fragment);
  }

  _buildPropertyRow(instance, definition, value) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const label = document.createElement('label');
    label.textContent = definition.label ?? definition.name;
    label.title = `${definition.name}${definition.tooltip ? ` — ${definition.tooltip}` : ''}`;
    row.appendChild(label);
    const commit = (next) => {
      this.editor.setProperty(instance, definition.name, next);
      this.editor.refreshSelectionRender();
      this._treeDirty = true;
    };

    const type = definition.type;
    if (type === 'boolean') {
      row.classList.add('checkbox');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.disabled = !!definition.readonly;
      input.addEventListener('change', () => commit(input.checked));
      row.appendChild(input);
      return row;
    }
    if (type === 'enum' || Array.isArray(definition.enum)) {
      const select = document.createElement('select');
      for (const option of definition.enum ?? []) {
        const element = document.createElement('option');
        element.value = String(option);
        element.textContent = String(option);
        select.appendChild(element);
      }
      select.value = String(value);
      select.disabled = !!definition.readonly;
      select.addEventListener('change', () => commit(select.value));
      row.appendChild(select);
      return row;
    }
    if (type === 'number' || type === 'integer') {
      const wrapper = document.createElement('div');
      wrapper.className = 'color-row';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(definition.min ?? 0);
      input.max = String(definition.max ?? 1);
      input.step = String(definition.step ?? 0.01);
      input.value = String(Number(value) || 0);
      input.disabled = !!definition.readonly;
      const output = document.createElement('output');
      output.textContent = formatNumber(input.value);
      input.addEventListener('input', () => {
        output.textContent = formatNumber(input.value);
        commit(Number(input.value));
      });
      if (definition.min === undefined || definition.max === undefined) {
        const number = document.createElement('input');
        number.type = 'number';
        number.step = String(definition.step ?? 0.1);
        number.value = String(Number(value) || 0);
        number.addEventListener('change', () => commit(Number(number.value)));
        row.appendChild(number);
        return row;
      }
      wrapper.appendChild(input);
      wrapper.appendChild(output);
      row.appendChild(wrapper);
      return row;
    }
    if (type === 'Vector3' || type === 'Vector2' || type === 'Color3' || type === 'Color4') {
      const isColor = type.startsWith('Color');
      const wrapper = document.createElement('div');
      wrapper.className = isColor ? 'color-row' : 'vec';
      const components = isColor ? ['x', 'y', 'z'] : (type === 'Vector2' ? ['x', 'y'] : ['x', 'y', 'z']);
      const inputs = {};
      for (const component of components) {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.1';
        input.title = component.toUpperCase();
        input.value = formatNumber(value?.[component] ?? 0);
        input.disabled = !!definition.readonly;
        input.addEventListener('change', () => {
          const next = Vector3.new(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
          next[component] = Number(input.value) || 0;
          commit(isColor ? toColorLike(value, next) : (type === 'Vector2' ? { x: next.x, y: next.y } : next));
        });
        inputs[component] = input;
        wrapper.appendChild(input);
      }
      if (isColor) {
        const swatch = document.createElement('input');
        swatch.type = 'color';
        swatch.value = colorToHex(value);
        swatch.addEventListener('input', () => commit(new Color3(...hexToRgb(swatch.value))));
        wrapper.insertBefore(swatch, wrapper.firstChild);
      }
      row.appendChild(wrapper);
      return row;
    }
    if (type === 'string' || type === 'text' || type === 'asset' || type === 'Material' || type === 'texture') {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value ?? '';
      input.disabled = !!definition.readonly;
      input.addEventListener('change', () => commit(input.value));
      row.appendChild(input);
      return row;
    }
    const readout = document.createElement('input');
    readout.type = 'text';
    readout.value = typeof value === 'object' ? (value === null ? 'null' : JSON.stringify(value)) : String(value ?? '');
    readout.readOnly = true;
    row.appendChild(readout);
    if (definition.tooltip) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = definition.tooltip;
      row.appendChild(hint);
    }
    return row;
  }

  _buildTextRow(labelText, value, onCommit) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.addEventListener('change', () => onCommit(input.value));
    row.appendChild(label);
    row.appendChild(input);
    return row;
  }

  // ------------------------------------------------------------------ environment
  refreshEnvironment() {
    const root = this.dom.environment;
    if (!root) return;
    const scene = this.engine.scene;
    const environment = scene?.environment ?? {};
    const lights = this.engine.renderer?.lights;
    const rows = [
      { key: 'dayTime', label: 'Time of day', min: 0, max: 24, step: 0.1, value: environment.dayTime ?? 12, apply: (v) => this.editor.setEnvironment('dayTime', v) },
      { key: 'timeScale', label: 'Day speed', min: 0, max: 60, step: 1, value: environment.timeScale ?? 0, apply: (v) => this.editor.setEnvironment('timeScale', v) },
      { key: 'fogDensity', label: 'Fog density', min: 0, max: 0.1, step: 0.001, value: environment.fogDensity ?? 0.01, apply: (v) => this.editor.setEnvironment('fogDensity', v) },
      { key: 'ambientIntensity', label: 'Ambient', min: 0, max: 3, step: 0.05, value: environment.ambientIntensity ?? 0.35, apply: (v) => this.editor.setEnvironment('ambientIntensity', v) },
      { key: 'exposure', label: 'Exposure', min: 0.2, max: 3, step: 0.05, value: this.engine.renderer?.exposure ?? 1, apply: (v) => { if (this.engine.renderer) this.engine.renderer.exposure = v; } },
      { key: 'sunIntensity', label: 'Sun', min: 0, max: 6, step: 0.05, value: lights?.sunIntensity ?? 1, apply: (v) => { if (lights) lights.sunIntensity = v; } },
    ];
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.appendChild(this._buildSettingRow(row));
    const skyRow = document.createElement('div');
    skyRow.className = 'setting-row';
    skyRow.innerHTML = `<label>Sky mode</label><select id="env-sky">${['procedural', 'color', 'cubemap', 'none'].map((mode) => `<option value="${mode}">${mode}</option>`).join('')}</select>`;
    fragment.appendChild(skyRow);
    const skySelect = skyRow.querySelector('select');
    if (skySelect) {
      skySelect.value = environment.skyMode ?? 'procedural';
      skySelect.addEventListener('change', () => this.editor.setEnvironment('skyMode', skySelect.value));
    }
    root.replaceChildren(fragment);
    if (this.dom.environmentExtra) {
      const stats = scene?.getStats?.() ?? {};
      this.dom.environmentExtra.innerHTML = `
        <div class="inspector-section"><header>World</header><div class="fields">
          <div class="prop-row"><label>Parts</label><input type="text" readonly value="${stats.parts ?? 0}" /></div>
          <div class="prop-row"><label>Triangles</label><input type="text" readonly value="${(stats.triangles ?? 0).toLocaleString()}" /></div>
          <div class="prop-row"><label>Colliders</label><input type="text" readonly value="${stats.colliders ?? 0}" /></div>
          <div class="prop-row"><label>Nav nodes</label><input type="text" readonly value="${this.engine.nav?.nodes?.length ?? 0}" /></div>
          <div class="prop-row"><label>Actors</label><input type="text" readonly value="${this.engine.actors.size}" /></div>
        </div></div>`;
    }
  }

  _buildSettingRow({ label, min, max, step, value, apply }) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const name = document.createElement('label');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const output = document.createElement('output');
    output.textContent = formatNumber(value);
    input.addEventListener('input', () => {
      output.textContent = formatNumber(input.value);
      apply(Number(input.value));
    });
    row.append(name, input, output);
    return row;
  }

  // ------------------------------------------------------------------ scripts
  async _mountCodeEditor() {
    const host = this.dom.scriptEditor;
    if (!host) return;
    // Monaco is optional: try to load it, otherwise fall back to a styled textarea.
    try {
      const monaco = await import(/* @vite-ignore */ 'monaco-editor');
      monaco.editor.defineTheme('ominx-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'keyword', foreground: 'ffb347' },
          { token: 'string', foreground: '9ae66e' },
          { token: 'comment', foreground: '61708a', fontStyle: 'italic' },
          { token: 'number', foreground: '57b6ff' },
        ],
        colors: { 'editor.background': '#070a0f', 'editor.lineHighlightBackground': '#131a24' },
      });
      this.monaco = monaco;
      this.codeEditor = monaco.editor.create(host, {
        value: DEFAULT_SCRIPT_SOURCE,
        language: 'javascript',
        theme: 'ominx-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        tabSize: 2,
      });
      this.codeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => this.runScript());
      return;
    } catch (error) {
      log.info(`Monaco unavailable (${error.message}) — using the built-in text editor`);
    }
    const textarea = document.createElement('textarea');
    textarea.className = 'script-code';
    textarea.id = 'script-code';
    textarea.spellcheck = false;
    textarea.value = DEFAULT_SCRIPT_SOURCE;
    host.replaceChildren(textarea);
    this.codeEditor = {
      getValue: () => textarea.value,
      setValue: (value) => { textarea.value = value; },
    };
  }

  getCode() { return this.codeEditor?.getValue?.() ?? ''; }

  refreshScripts() {
    const list = this.dom.scriptList;
    if (!list) return;
    const runtime = this.engine.scripts;
    if (!runtime) {
      list.innerHTML = '<div class="empty-hint">Script runtime unavailable.</div>';
      return;
    }
    const scripts = runtime.list();
    if (!scripts.length) {
      list.innerHTML = '<div class="empty-hint">No scripts yet — “New script” creates one.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const script of scripts) {
      const row = document.createElement('div');
      row.className = 'script-row';
      if (script.id === this.selectedScript) row.classList.add('active');
      row.innerHTML = `<span class="script-name">${escapeHtml(script.name)}</span><span class="script-state">${script.state}${script.error ? ' ⚠' : ''}${script.tickCount ? ` · ${script.tickCount}` : ''}</span>`;
      row.addEventListener('click', () => {
        this.selectedScript = script.id;
        this.codeEditor?.setValue?.(script.source);
        this.refreshScripts();
      });
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
  }

  createScript() {
    const runtime = this.engine.scripts;
    if (!runtime) return null;
    const script = runtime.create({
      name: `Script_${runtime.list().length + 1}`,
      source: this.getCode() || DEFAULT_SCRIPT_SOURCE,
      instance: this.editor.primary ?? this.engine.scene,
    });
    this.selectedScript = script.id;
    this.refreshScripts();
    this.editor.log('info', `created ${script.name}`);
    return script;
  }

  runScript() {
    const runtime = this.engine.scripts;
    if (!runtime) return null;
    let script = this.selectedScript ? runtime.get(this.selectedScript) : null;
    if (!script) script = this.createScript();
    if (!script) return null;
    runtime.updateSource(script.id, this.getCode());
    if (!runtime.started) runtime.start();
    this.appendScriptOutput(script);
    this.refreshScripts();
    return script;
  }

  appendScriptOutput(script) {
    if (!this.dom.scriptOutput) return;
    const line = document.createElement('div');
    line.className = `console-line ${script.error ? 'error' : 'info'}`;
    line.textContent = script.error ? `${script.name}: ${script.error.message}` : `${script.name} → ${script.state}`;
    this.dom.scriptOutput.appendChild(line);
    while (this.dom.scriptOutput.childElementCount > 60) this.dom.scriptOutput.firstElementChild.remove();
  }

  // ------------------------------------------------------------------ network
  async connectNetwork() {
    const url = this.dom.netUrl?.value?.trim();
    if (!url) return null;
    try {
      const { NetworkClient } = await import('../net/NetworkClient.js');
      this.engine.net?.close?.();
      this.engine.net = new NetworkClient(this.engine, { url, name: 'Studio' });
      await this.engine.net.connect();
      this.editor.log('info', `connected to ${url}`);
      this.refreshNetwork();
    } catch (error) {
      this.editor.log('error', `network: ${error.message}`);
    }
    return this.engine.net;
  }

  refreshNetwork() {
    const root = this.dom.networkPlayers;
    if (!root) return;
    const net = this.engine.net;
    if (!net) {
      root.innerHTML = '<div class="empty-hint">Not connected. Start a server with <code>npm run server</code>.</div>';
      return;
    }
    const rows = [...(net.players?.values?.() ?? [])].map((player) => `
      <div class="prop-row"><label>${escapeHtml(player.name ?? 'player')}</label><input type="text" readonly value="${player.team ?? '—'} · ${player.ping ?? 0} ms" /></div>`);
    root.innerHTML = `<div class="inspector-section"><header>Session</header><div class="fields">
      <div class="prop-row"><label>State</label><input type="text" readonly value="${net.state}" /></div>
      <div class="prop-row"><label>Ping</label><input type="text" readonly value="${net.ping ?? 0} ms" /></div>
      <div class="prop-row"><label>Players</label><input type="text" readonly value="${net.players?.size ?? 0}" /></div>
      ${rows.join('')}
    </div></div>`;
  }

  // ------------------------------------------------------------------ console
  appendConsole(line) {
    this.editor.console.push(line);
    const buffer = this.editor.console;
    if (buffer.length > this.editor.consoleBuffer) buffer.splice(0, buffer.length - this.editor.consoleBuffer);
    this.renderConsole();
  }

  renderConsole() {
    const body = this.dom.consoleBody;
    if (!body) return;
    const lines = this.editor.console.filter((line) => this.filter === 'all' || line.level === this.filter);
    const fragment = document.createDocumentFragment();
    for (const line of lines.slice(-160)) {
      const row = document.createElement('div');
      row.className = `console-line ${line.level}`;
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = new Date(line.time ?? Date.now()).toLocaleTimeString([], { hour12: false });
      const scope = document.createElement('span');
      scope.className = 'scope';
      scope.textContent = 'Studio';
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = line.message;
      row.append(time, scope, text);
      fragment.appendChild(row);
    }
    body.replaceChildren(fragment);
    body.scrollTop = body.scrollHeight;
  }

  clearConsole() {
    this.editor.console.length = 0;
    this.renderConsole();
  }

  toggleConsole() {
    const console_ = $('console');
    console_?.classList.toggle('collapsed');
  }

  runConsoleCommand(value) {
    const result = this.editor.runCommand(value);
    this.refresh();
    if (result && typeof result.then === 'function') result.catch((error) => this.editor.log('error', error.message));
    return result;
  }

  cycleRightTab() {
    const tabs = [...document.querySelectorAll('.panel-tabs[data-tabs="right"] .tab')];
    const index = tabs.findIndex((tab) => tab.classList.contains('active'));
    tabs[(index + 1) % tabs.length]?.click();
  }

  // ------------------------------------------------------------------ misc UI state
  updateHistoryButtons() {
    const undo = document.querySelector('[data-action="undo"]');
    const redo = document.querySelector('[data-action="redo"]');
    if (undo) undo.disabled = !this.editor.history.canUndo;
    if (redo) redo.disabled = !this.editor.history.canRedo;
  }

  updatePlayButtons() {
    const playing = this.engine.mode === 'play';
    this.dom.playRestore?.toggleAttribute('disabled', playing);
    for (const element of document.querySelectorAll('[data-action="play"], [data-action="play-bots"]')) element.disabled = playing;
    for (const element of document.querySelectorAll('[data-action="stop"]')) element.disabled = !playing;
    this.dom.studio?.classList.toggle('playing', playing);
  }

  onSelectionChanged() { this.refreshInspector(); }
  onHoverChanged() { /* reserved for the outline hover highlight */ }
  onTransformChanged() { this.refreshInspector(); this.refreshTree(); }
  onToolChanged(mode) {
    for (const button of document.querySelectorAll('[data-tool]')) button.classList.toggle('active', button.dataset.tool === mode);
    const snapButton = document.querySelector('[data-action="toggle-snap"]');
    snapButton?.classList.toggle('active', this.editor.gizmo.snap);
    const spaceButton = document.querySelector('[data-action="toggle-space"]');
    if (spaceButton) spaceButton.textContent = this.editor.gizmo.space === 'local' ? 'Local' : 'World';
  }

  /** Modal dialog helper (confirmations for destructive actions). */
  dialog(title, body, { ok = 'OK', cancel = 'Cancel' } = {}) {
    return new Promise((resolve) => {
      const dialog = this.dom.dialog;
      if (!dialog) { resolve(true); return; }
      this.dom.dialogTitle.textContent = title;
      this.dom.dialogBody.textContent = body;
      this.dom.dialogOk.textContent = ok;
      this.dom.dialogCancel.textContent = cancel;
      this.dom.dialogCancel.hidden = false;
      dialog.hidden = false;
      const done = (result) => {
        dialog.hidden = true;
        this.dom.dialogOk.removeEventListener('click', onOk);
        this.dom.dialogCancel.removeEventListener('click', onCancel);
        resolve(result);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      this.dom.dialogOk.addEventListener('click', onOk);
      this.dom.dialogCancel.addEventListener('click', onCancel);
    });
  }

  async confirmNewMap() {
    const confirmed = await this.dialog('Generate a new map?', 'The current workspace will be replaced (unsaved changes are lost).', { ok: 'Generate' });
    if (!confirmed) return;
    await this.editor.newMap();
  }

  destroy() {
    for (const [target, type, handler] of this._handlers) {
      if (type === 'disconnect') target?.[type]?.(handler);
      else target.removeEventListener?.(type, handler);
    }
    this._handlers.length = 0;
    this.codeEditor?.dispose?.();
  }
}

// --------------------------------------------------------------------------- helpers
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  if (Math.abs(number) >= 100) return number.toFixed(0);
  if (Math.abs(number) >= 10) return number.toFixed(1);
  return number.toFixed(2);
}

function colorToHex(color) {
  if (!color) return '#ffffff';
  const channel = (value) => clamp(Math.round((Number(value) || 0) * 255), 0, 255).toString(16).padStart(2, '0');
  return `#${channel(color.x ?? color.r ?? 0)}${channel(color.y ?? color.g ?? 0)}${channel(color.z ?? color.b ?? 0)}`;
}

function hexToRgb(hex) {
  const value = String(hex).replace('#', '');
  const int = parseInt(value.length === 3 ? value.split('').map((c) => c + c).join('') : value, 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

function toColorLike(original, next) {
  if (original instanceof Color3) return new Color3(clamp01(next.x), clamp01(next.y), clamp01(next.z));
  if (original && 'r' in original) return { r: clamp01(next.x), g: clamp01(next.y), b: clamp01(next.z), a: original.a ?? 1 };
  return next;
}

function thumbFor(entry) {
  if (entry.kind === 'weapon') return '⌐';
  if (entry.kind === 'grenade') return '◍';
  if (entry.kind === 'material') return '▩';
  return '▣';
}

export default EditorUI;
