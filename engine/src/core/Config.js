/**
 * OminX Engine — layered configuration.
 *
 * Configuration arrives from several places and they must not fight: engine defaults, a project
 * file, a user profile, command-line flags, and runtime overrides from the editor. A *layer stack*
 * settles that deterministically — the last layer that defines a key wins, and the origin of every
 * value stays inspectable, which is what makes "why is the FOV 110?" answerable in one query.
 *
 * Layers (lowest to highest priority by default):
 *   `defaults` → `engine` → `project` → `user` → `commandline` → `runtime`
 *
 * Values are described by a schema (`Config.define('renderer.fov', { type: 'number', min: 60, … })`)
 * so a bad value fails loudly at the point of entry — with the layer name in the message — instead of
 * corrupting the frame three systems later. Every change emits `config.onChanged` with
 * `{ key, value, previous, source }`, which is how subsystems react without polling.
 *
 * The file format is an INI-style text form (sections + `key = value`), deliberately human-editable
 * and diff-friendly; JSON import/export goes through the same schema.
 *
 * @module engine/src/core/Config
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Config');

export const ConfigLayer = {
  Defaults: 'defaults',
  Engine: 'engine',
  Project: 'project',
  User: 'user',
  CommandLine: 'commandline',
  Runtime: 'runtime',
};

export const DEFAULT_LAYER_ORDER = [
  ConfigLayer.Defaults, ConfigLayer.Engine, ConfigLayer.Project,
  ConfigLayer.User, ConfigLayer.CommandLine, ConfigLayer.Runtime,
];

export const ConfigType = {
  Number: 'number',
  Integer: 'integer',
  Boolean: 'boolean',
  String: 'string',
  Enum: 'enum',
  Array: 'array',
  Object: 'object',
  Color: 'color',
  Vector3: 'vector3',
};

export const configEvents = {
  onChanged: new MulticastDelegate('config.onChanged'),
  onLayerLoaded: new MulticastDelegate('config.onLayerLoaded'),
  onReset: new MulticastDelegate('config.onReset'),
};

/** Declares a key: type, default, range, doc and whether it is replicated to clients. */
export class ConfigSchema {
  constructor() {
    /** @type {Map<string, object>} */
    this.keys = new Map();
    /** @type {Map<string, string>} */
    this.groups = new Map();
  }

  define(key, definition = {}) {
    if (this.keys.has(key)) log.debug(`config key "${key}" redefined`);
    const type = definition.type ?? inferConfigType(definition.default ?? definition.value);
    const entry = {
      key,
      type,
      default: definition.default ?? defaultForType(type),
      min: definition.min,
      max: definition.max,
      step: definition.step,
      enum: definition.enum ? [...definition.enum] : null,
      values: definition.values ? [...definition.values] : null,
      description: definition.description ?? '',
      displayName: definition.displayName ?? key,
      group: definition.group ?? 'General',
      advanced: definition.advanced === true,
      requiresRestart: definition.requiresRestart === true,
      replicated: definition.replicated === true,
      secret: definition.secret === true,
      validate: definition.validate ?? null,
      normalize: definition.normalize ?? null,
    };
    this.keys.set(key, entry);
    if (!this.groups.has(entry.group)) this.groups.set(entry.group, []);
    const group = this.groups.get(entry.group);
    if (!group.includes(key)) group.push(key);
    return entry;
  }

  /** Bulk declaration: `defineGroup('Renderer', { 'renderer.fov': { … } })`. */
  defineMany(definitions) {
    for (const [key, definition] of Object.entries(definitions)) this.define(key, definition);
    return this;
  }

  get(key) { return this.keys.get(key) ?? null; }
  has(key) { return this.keys.has(key); }
  keysInGroup(group) { return [...(this.groups.get(group) ?? [])]; }
  all() { return [...this.keys.values()]; }
  groupNames() { return [...this.groups.keys()]; }
}

function defaultForType(type) {
  switch (type) {
    case ConfigType.Number: case ConfigType.Integer: return 0;
    case ConfigType.Boolean: return false;
    case ConfigType.String: case ConfigType.Enum: return '';
    case ConfigType.Array: case ConfigType.Object: return null;
    case ConfigType.Color: return { r: 0, g: 0, b: 0, a: 1 };
    case ConfigType.Vector3: return { x: 0, y: 0, z: 0 };
    default: return null;
  }
}

function inferConfigType(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? ConfigType.Integer : ConfigType.Number;
  if (typeof value === 'boolean') return ConfigType.Boolean;
  if (typeof value === 'string') return ConfigType.String;
  if (Array.isArray(value)) return ConfigType.Array;
  if (value && typeof value === 'object') {
    if ('x' in value && 'y' in value && 'z' in value) return ConfigType.Vector3;
    if ('r' in value && 'g' in value && 'b' in value) return ConfigType.Color;
    return ConfigType.Object;
  }
  return ConfigType.String;
}

/** The layered configuration store. */
export class Config {
  constructor({ schema = null, name = 'Config', layers = DEFAULT_LAYER_ORDER } = {}) {
    this.name = name;
    this.schema = schema ?? new ConfigSchema();
    this.layerOrder = [...layers];
    /** @type {Map<string, Map<string, any>>} layer → key → value */
    this.layers = new Map();
    for (const layer of this.layerOrder) this.layers.set(layer, new Map());
    this.changeCount = 0;
    this.validationErrors = [];
    this.listeners = new Map();      // key → MulticastDelegate
  }

  static create(options) { return new Config(options); }

  // ------------------------------------------------------------------ schema
  define(key, definition) { this.schema.define(key, definition); return this; }
  defineMany(definitions) { this.schema.defineMany(definitions); return this; }

  // ------------------------------------------------------------------ reads
  /**
   * Resolves a key: highest-priority layer that defines it, else the schema default.
   * `config.origin('renderer.fov')` tells you which layer won.
   */
  get(key, fallback = undefined) {
    for (let i = this.layerOrder.length - 1; i >= 0; i--) {
      const layer = this.layers.get(this.layerOrder[i]);
      if (layer?.has(key)) return cloneConfigValue(layer.get(key));
    }
    const entry = this.schema.get(key);
    if (entry) return cloneConfigValue(entry.default);
    return fallback;
  }

  /** Which layer (and value) a key resolves to. */
  origin(key) {
    for (let i = this.layerOrder.length - 1; i >= 0; i--) {
      const name = this.layerOrder[i];
      const layer = this.layers.get(name);
      if (layer?.has(key)) return { layer: name, value: cloneConfigValue(layer.get(key)) };
    }
    const entry = this.schema.get(key);
    return entry ? { layer: ConfigLayer.Defaults, value: cloneConfigValue(entry.default) } : null;
  }

  has(key) { return this.layerOrder.some((layer) => this.layers.get(layer)?.has(key)) || this.schema.has(key); }

  /** Typed accessors (they coerce, so a config file with "90" still yields a number). */
  getNumber(key, fallback = 0) { const value = Number(this.get(key, fallback)); return Number.isFinite(value) ? value : fallback; }
  getInt(key, fallback = 0) { return Math.round(this.getNumber(key, fallback)); }
  getBool(key, fallback = false) { const value = this.get(key, fallback); return typeof value === 'string' ? value !== 'false' && value !== '0' : !!value; }
  getString(key, fallback = '') { const value = this.get(key, fallback); return value === null || value === undefined ? fallback : String(value); }

  /**
   * Reads a namespaced slice: `config.section('renderer')` returns every `renderer.*` key with the
   * prefix stripped. Handy for handing a whole group to a subsystem.
   */
  section(prefix, { includeSchema = true } = {}) {
    const out = {};
    if (includeSchema) {
      for (const entry of this.schema.all()) {
        if (!entry.key.startsWith(`${prefix}.`)) continue;
        out[entry.key.slice(prefix.length + 1)] = this.get(entry.key);
      }
    }
    for (const layer of this.layerOrder) {
      for (const [key, value] of this.layers.get(layer)) {
        if (!key.startsWith(`${prefix}.`)) continue;
        out[key.slice(prefix.length + 1)] = cloneConfigValue(value);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ writes
  /**
   * Sets a value in a layer (defaults to the runtime layer, which outranks file layers).
   * Validation is strict: an out-of-range or wrongly-typed value is rejected with a message that
   * names the layer and the key.
   */
  set(key, value, { layer = ConfigLayer.Runtime, silent = false } = {}) {
    if (!this.layers.has(layer)) { this.layers.set(layer, new Map()); }
    const entry = this.schema.get(key);
    let normalized = value;
    if (entry) {
      const result = coerceConfigValue(value, entry);
      if (result.error) {
        this.validationErrors.push({ key, layer, message: result.error });
        log.warn(`config ${key} (${layer}): ${result.error}`);
        return false;
      }
      normalized = result.value;
    }
    const previous = this.get(key);
    if (valuesEqual(previous, normalized)) return true;
    this.layers.get(layer).set(key, normalized);
    if (!silent) this._notify(key, normalized, previous, layer);
    else this.changeCount++;
    return true;
  }

  /** Sets many keys at once in one layer. */
  setMany(values, { layer = ConfigLayer.Runtime, silent = false } = {}) {
    let applied = 0;
    for (const [key, value] of Object.entries(values)) if (this.set(key, value, { layer, silent })) applied++;
    return applied;
  }

  /** Removes a key from a layer, revealing the value below it. */
  unset(key, { layer = ConfigLayer.Runtime } = {}) {
    const map = this.layers.get(layer);
    if (!map?.has(key)) return false;
    const previous = this.get(key);
    map.delete(key);
    this._notify(key, this.get(key), previous, layer);
    return true;
  }

  /** Restores a key (or the whole key set) to its schema default. */
  reset(key = null) {
    if (key) {
      for (const layer of this.layerOrder) this.layers.get(layer)?.delete(key);
      this._notify(key, this.get(key), undefined, 'reset');
      return this;
    }
    for (const layer of this.layerOrder) this.layers.get(layer)?.clear();
    configEvents.onReset.broadcast(this);
    return this;
  }

  // ------------------------------------------------------------------ change notification
  /**
   * Subscribes to one key (or a `prefix.*` pattern) without polling. Returns a disposer.
   * `config.on('renderer.fov', (value, previous, key) => …)`.
   */
  on(keyPattern, listener, options = {}) {
    if (!this.listeners.has(keyPattern)) this.listeners.set(keyPattern, new MulticastDelegate(`config:${keyPattern}`));
    const handle = this.listeners.get(keyPattern).add(listener, options);
    return () => handle.unbind();
  }

  _notify(key, value, previous, layer) {
    // Every mutation path (set, apply, unset, reset) notifies; counting here means `report().changes`
    // is the real number of value changes instead of "changes made through set()".
    this.changeCount++;
    configEvents.onChanged.broadcast({ key, value, previous, source: layer, config: this });
    for (const [pattern, delegate] of this.listeners) {
      if (pattern === key || (pattern.endsWith('.*') && key.startsWith(pattern.slice(0, -1)))) {
        delegate.broadcast(value, previous, key);
      }
    }
  }

  /** Binds an object's properties to a config prefix (subsystem settings without glue code). */
  bind(target, prefix, { twoWay = false } = {}) {
    const disposers = [];
    for (const entry of this.schema.all()) {
      if (!entry.key.startsWith(`${prefix}.`)) continue;
      const property = entry.key.slice(prefix.length + 1);
      this.set(entry.key, this.get(entry.key));
      if (property in target) target[property] = this.get(entry.key);
      disposers.push(this.on(entry.key, (value) => { if (property in target) target[property] = value; }));
      if (twoWay) disposers.push(watchProperty(target, property, (value) => this.set(entry.key, value, { silent: true })));
    }
    return () => { for (const dispose of disposers) dispose(); };
  }

  // ------------------------------------------------------------------ serialization
  /** Every key that is explicitly set (not schema defaults), optionally for one layer. */
  snapshot({ layer = null, includeDefaults = false } = {}) {
    const out = {};
    const layers = layer ? [layer] : this.layerOrder;
    for (const name of layers) {
      for (const [key, value] of this.layers.get(name) ?? []) out[key] = cloneConfigValue(value);
    }
    if (includeDefaults) for (const entry of this.schema.all()) if (!(entry.key in out)) out[entry.key] = cloneConfigValue(entry.default);
    return out;
  }

  toJSON({ layer = null, includeDefaults = false } = {}) { return this.snapshot({ layer, includeDefaults }); }

  /** Loads a plain object into a layer. Unknown keys are accepted (plugins add their own). */
  apply(values, { layer = ConfigLayer.User, silent = false } = {}) {
    let applied = 0;
    for (const [key, raw] of Object.entries(values ?? {})) {
      const value = coerceLayerValue(key, raw, this.schema.get(key));
      if (value === undefined) continue;
      const previous = this.get(key);
      this.layers.get(layer).set(key, value);
      applied++;
      if (!silent && !valuesEqual(previous, value)) this._notify(key, value, previous, layer);
    }
    configEvents.onLayerLoaded.broadcast(layer, values, this);
    return applied;
  }

  // ------------------------------------------------------------------ text format
  /**
   * INI-style text: `[section]` headers derived from dot prefixes, `key = value` lines, `#` comments.
   * Reads back through `parseText` — round-trippable, which keeps config files diffable in reviews.
   */
  toText({ layer = null, includeDefaults = false } = {}) {
    const values = this.snapshot({ layer, includeDefaults });
    const sections = new Map();
    for (const [key, value] of Object.entries(values)) {
      const dot = key.indexOf('.');
      const section = dot < 0 ? 'general' : key.slice(0, dot);
      const name = dot < 0 ? key : key.slice(dot + 1);
      if (!sections.has(section)) sections.set(section, []);
      sections.get(section).push([name, key, value]);
    }
    const lines = [`# OminX ${this.name} — ${new Date().toISOString()}`];
    for (const [section, entries] of [...sections.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push('', `[${section}]`);
      for (const [name, key, value] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
        const entry = this.schema.get(key);
        if (entry?.description) lines.push(`# ${entry.description}`);
        lines.push(`${name} = ${formatConfigValue(value)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  /** Parses INI-style text into `{ key: value }` (types resolved through the schema). */
  parseText(text) {
    const out = {};
    let section = '';
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      if (line.startsWith('[') && line.endsWith(']')) {
        section = line.slice(1, -1).trim();
        continue;
      }
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const name = line.slice(0, eq).trim();
      const raw = line.slice(eq + 1).trim();
      const key = section && section !== 'general' ? `${section}.${name}` : name;
      out[key] = parseConfigLiteral(raw, this.schema.get(key));
    }
    return out;
  }

  loadText(text, { layer = ConfigLayer.User, silent = false } = {}) {
    return this.apply(this.parseText(text), { layer, silent });
  }

  // ------------------------------------------------------------------ reporting
  /**
   * Every declared key with its resolved value, origin and schema — what the editor's settings
   * panels and the `config` console command render.
   */
  describe({ group = null } = {}) {
    const rows = [];
    for (const entry of this.schema.all()) {
      if (group && entry.group !== group) continue;
      const origin = this.origin(entry.key);
      rows.push({
        key: entry.key,
        value: entry.secret ? '••••' : origin?.value,
        source: origin?.layer ?? null,
        type: entry.type,
        group: entry.group,
        description: entry.description,
        requiresRestart: entry.requiresRestart,
        range: entry.min !== undefined || entry.max !== undefined ? [entry.min ?? null, entry.max ?? null] : null,
        enum: entry.enum,
      });
    }
    // Values set without a schema (plugin/CLI/unknown keys) still show up — unless the caller asked
    // for one group, in which case only that group is reported.
    if (!group || group === 'Unregistered') {
      for (const layer of this.layerOrder) {
        for (const key of this.layers.get(layer).keys()) {
          if (this.schema.has(key)) continue;
          rows.push({ key, value: this.get(key), source: layer, type: 'unknown', group: 'Unregistered' });
        }
      }
    }
    return rows;
  }

  format({ group = null } = {}) {
    const rows = this.describe({ group });
    const width = Math.max(8, ...rows.map((row) => row.key.length));
    const lines = [`  ${'key'.padEnd(width)} ${'value'.padEnd(24)} source`];
    for (const row of rows) {
      const value = typeof row.value === 'object' ? JSON.stringify(row.value) : String(row.value);
      lines.push(`  ${row.key.padEnd(width)} ${value.slice(0, 24).padEnd(24)} ${row.source}`);
    }
    lines.push('', `  ${rows.length} keys · ${this.changeCount} changes · ${this.validationErrors.length} rejected`);
    return lines.join('\n');
  }

  /** Change history + rejected values (debugging "why is this value wrong?"). */
  report() {
    return {
      name: this.name,
      changes: this.changeCount,
      layers: Object.fromEntries(this.layerOrder.map((layer) => [layer, this.layers.get(layer)?.size ?? 0])),
      rejected: this.validationErrors.slice(-20),
    };
  }
}

// ---------------------------------------------------------------------- helpers

function coerceConfigValue(value, entry) {
  const type = entry.type;
  try {
    switch (type) {
      case ConfigType.Boolean: {
        if (typeof value === 'boolean') return { value };
        if (typeof value === 'string') return { value: value !== 'false' && value !== '0' && value !== '' };
        if (typeof value === 'number') return { value: value !== 0 };
        return { error: `expected a boolean, got ${typeof value}` };
      }
      case ConfigType.Number:
      case ConfigType.Integer: {
        const number = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(number)) return { error: `expected a number, got "${value}"` };
        if (entry.min !== undefined && number < entry.min) return { error: `${number} is below the minimum ${entry.min}` };
        if (entry.max !== undefined && number > entry.max) return { error: `${number} is above the maximum ${entry.max}` };
        return { value: type === ConfigType.Integer ? Math.round(number) : number };
      }
      case ConfigType.Enum: {
        const list = entry.enum ?? entry.values ?? [];
        const normalized = typeof value === 'string' ? value : String(value);
        if (list.length && !list.includes(normalized)) return { error: `"${normalized}" is not one of ${list.join(', ')}` };
        return { value: normalized };
      }
      case ConfigType.String:
        return { value: String(value) };
      case ConfigType.Array: {
        if (Array.isArray(value)) return { value: value.slice() };
        if (typeof value === 'string') return { value: value.split(',').map((item) => item.trim()).filter(Boolean) };
        return { error: `expected an array, got ${typeof value}` };
      }
      case ConfigType.Object: {
        if (value && typeof value === 'object') return { value: { ...value } };
        return { error: `expected an object, got ${typeof value}` };
      }
      case ConfigType.Vector3: {
        if (value && typeof value === 'object' && 'x' in value) return { value: { x: Number(value.x) || 0, y: Number(value.y) || 0, z: Number(value.z) || 0 } };
        if (typeof value === 'string') {
          const [x, y, z] = value.split(/[, ]+/).map(Number);
          return { value: { x: x || 0, y: y || 0, z: z || 0 } };
        }
        return { error: 'expected { x, y, z }' };
      }
      case ConfigType.Color: {
        if (value && typeof value === 'object' && 'r' in value) {
          return { value: { r: Number(value.r) || 0, g: Number(value.g) || 0, b: Number(value.b) || 0, a: value.a === undefined ? 1 : Number(value.a) || 0 } };
        }
        if (typeof value === 'string' && value.startsWith('#')) return { value: hexToColor(value) };
        return { error: 'expected { r, g, b } or #rrggbb' };
      }
      default:
        return { value };
    }
  } catch (error) {
    return { error: error.message };
  }
}

function coerceLayerValue(key, raw, entry) {
  if (!entry) return raw;
  const result = coerceConfigValue(raw, entry);
  if (result.error) {
    log.warn(`config ${key}: ${result.error}`);
    return undefined;
  }
  return result.value;
}

function hexToColor(hex) {
  const value = hex.replace('#', '');
  const expand = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const int = parseInt(expand, 16);
  return {
    r: ((int >> 16) & 0xff) / 255,
    g: ((int >> 8) & 0xff) / 255,
    b: (int & 0xff) / 255,
    a: 1,
  };
}

function parseConfigLiteral(raw, entry) {
  const result = entry ? coerceConfigValue(raw, entry) : null;
  if (result && !result.error) return result.value;
  // Untyped keys fall back to the obvious JS literal.
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1).split(',').map((item) => item.trim()); }
  }
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try { return JSON.parse(raw); } catch { /* keep the string */ }
  }
  return raw.replace(/^"(.*)"$/, '$1');
}

function formatConfigValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') {
    if ('x' in value && 'y' in value && 'z' in value) return `${value.x}, ${value.y}, ${value.z}`;
    if ('r' in value && 'g' in value && 'b' in value) return `${value.r}, ${value.g}, ${value.b}${value.a === undefined || value.a === 1 ? '' : `, ${value.a}`}`;
    return JSON.stringify(value);
  }
  return String(value);
}

function cloneConfigValue(value) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') return { ...value };
  return value;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => item === b[index]);
  if (a && b && typeof a === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
  }
  return false;
}

function watchProperty(target, property, onChange) {
  let current = target[property];
  const timer = setInterval(() => {
    if (target[property] !== current) {
      const previous = current;
      current = target[property];
      onChange(current, previous);
    }
  }, 100);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

/**
 * Parses a command line into config overrides: `--renderer.fov 90 --mute --bots=8`.
 * Booleans without a value become `true`.
 */
export function parseCommandLine(argv = [], schema = null) {
  const out = {};
  const list = Array.isArray(argv) ? argv : String(argv).split(/\s+/);
  for (let i = 0; i < list.length; i++) {
    let arg = list[i];
    if (!arg.startsWith('--')) continue;
    arg = arg.slice(2);
    let value = true;
    const eq = arg.indexOf('=');
    if (eq >= 0) { value = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    else if (list[i + 1] !== undefined && !list[i + 1].startsWith('--')) { value = list[++i]; }
    const entry = schema?.get(arg);
    out[arg] = entry ? parseConfigLiteral(String(value), entry) : parseConfigLiteral(String(value), null);
  }
  return out;
}

export default Config;
