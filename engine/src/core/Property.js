/**
 * OminX Engine — property/type system.
 *
 * Every engine class declares its editable properties once. That single declaration
 * drives: the editor inspector (auto-generated widgets), serialization, undo/redo diffs,
 * and multiplayer replication. This is the backbone that makes the engine data-driven.
 *
 * @module engine/core/Property
 */
import { Vector2 } from '../math/Vector2.js';
import { Vector3 } from '../math/Vector3.js';
import { Vector4 } from '../math/Vector4.js';
import { Color3 } from '../math/Color3.js';
import { Color4 } from '../math/Color4.js';
import { Quaternion } from '../math/Quaternion.js';
import { CFrame } from '../math/CFrame.js';
import { Transform } from '../math/Transform.js';

export const PropertyType = {
  Number: 'number',
  Integer: 'integer',
  Boolean: 'boolean',
  String: 'string',
  Text: 'text',
  Color3: 'Color3',
  Color4: 'Color4',
  Vector2: 'Vector2',
  Vector3: 'Vector3',
  Vector4: 'Vector4',
  Quaternion: 'Quaternion',
  CFrame: 'CFrame',
  Transform: 'Transform',
  Enum: 'enum',
  Flags: 'flags',
  Instance: 'Instance',
  Array: 'array',
  Dictionary: 'dictionary',
  Asset: 'asset',
  Texture: 'texture',
  Material: 'Material',
  Mesh: 'Mesh',
  EntityClass: 'EntityClass',
  Callback: 'callback',
  Any: 'any',
};

/** Property categories shape the inspector's collapsible sections. */
export const PropertyCategory = {
  Appearance: 'Appearance',
  Transform: 'Transform',
  Behavior: 'Behavior',
  Physics: 'Physics',
  Rendering: 'Rendering',
  Audio: 'Audio',
  Gameplay: 'Gameplay',
  Networking: 'Networking',
  Data: 'Data',
  UI: 'UI',
  Debug: 'Debug',
};

const CLASS_PROPS = Symbol('ominx.classProperties');

function ensureStore(ctor) {
  if (!Object.prototype.hasOwnProperty.call(ctor, CLASS_PROPS)) {
    const inherited = Object.getPrototypeOf(ctor)?.[CLASS_PROPS];
    Object.defineProperty(ctor, CLASS_PROPS, {
      value: new Map(inherited ? [...inherited].map(([k, v]) => [k, { ...v, overridden: true }]) : []),
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return ctor[CLASS_PROPS];
}

/**
 * Declares a property on a class prototype.
 *
 * @param {Function} ctor class whose prototype receives the accessor
 * @param {string} name property name (PascalCase by convention in this engine)
 * @param {object} def
 * @param {string} [def.type='number']
 * @param {*} [def.default]
 * @param {string} [def.category='Behavior']
 * @param {object} [def.enum] map name → value for `enum` types
 * @param {number} [def.min]
 * @param {number} [def.max]
 * @param {number} [def.step]
 * @param {boolean} [def.replicated=true] include in network snapshots
 * @param {boolean} [def.serialize=true] include in saved scene files
 * @param {boolean} [def.hidden=false] hide from inspector
 * @param {boolean} [def.readonly=false]
 * @param {string} [def.tooltip]
 * @param {string} [def.unit]
 * @param {Function} [def.onChanged] (instance, value, oldValue) => void
 */
export function defineProperty(ctor, name, def = {}) {
  const store = ensureStore(ctor);
  const descriptor = {
    type: def.type ?? inferType(def.default),
    default: def.default,
    category: def.category ?? PropertyCategory.Behavior,
    label: def.label ?? name,
    tooltip: def.tooltip ?? '',
    min: def.min, max: def.max, step: def.step,
    enum: def.enum, options: def.options,
    replicated: def.replicated !== false,
    serialize: def.serialize !== false,
    hidden: def.hidden === true,
    readonly: def.readonly === true,
    unit: def.unit,
    multiline: def.multiline === true,
    assetKind: def.assetKind,
    clampMin: def.clampMin === true,
    clampMax: def.clampMax === true,
    onChanged: def.onChanged,
    order: def.order ?? store.size,
    name,
    owner: ctor,
  };
  store.set(name, descriptor);

  const key = `_${name}`;
  Object.defineProperty(ctor.prototype, name, {
    get() {
      const v = this[key];
      if (v !== undefined) return v;
      const d = descriptor.default;
      return typeof d === 'object' && d !== null ? cloneValue(d) : d;
    },
    set(value) {
      const old = this[key];
      const nv = coerceValue(value, descriptor);
      if (valuesEqual(old, nv, descriptor.type)) return;
      this[key] = nv;
      this._onPropertyChanged?.(name, nv, old, descriptor);
    },
    enumerable: true,
    configurable: true,
  });
  return descriptor;
}

/** Declares several properties at once: `defineProperties(Cls, { Name: {...}, ... })`. */
export function defineProperties(ctor, defs) {
  for (const [name, def] of Object.entries(defs)) defineProperty(ctor, name, def);
  return ctor;
}

/** Internal: called by instances when a tracked property changes. */
export function makePropertyTracker(instance) {
  return (name, value, oldValue, descriptor) => {
    instance._changedSignal.emit(name, value, oldValue);
    instance.getPropertyChangedSignal(name).emit(value, oldValue);
    instance._propertyChangedSignal.emit(instance, name, value, oldValue);
    descriptor?.onChanged?.(instance, value, oldValue);
  };
}

export function getPropertyDefinitions(ctor) {
  return ctor[CLASS_PROPS] ?? new Map();
}
export function getPropertyDefinition(ctor, name) {
  return (ctor[CLASS_PROPS] ?? new Map()).get(name);
}
export function hasProperty(ctor, name) {
  return (ctor[CLASS_PROPS] ?? new Map()).has(name);
}
/** Collects property names from a whole inheritance chain, ordered by declaration. */
export function listProperties(ctor, { includeHidden = false } = {}) {
  const defs = getPropertyDefinitions(ctor);
  const out = [];
  for (const [name, def] of defs) if (includeHidden || !def.hidden) out.push(def);
  return out.sort((a, b) => a.order - b.order);
}
/** Property values as a plain object — used by serialization and replication. */
export function collectPropertyValues(instance, { onlySerialized = true } = {}) {
  const defs = getPropertyDefinitions(instance.constructor);
  const out = {};
  for (const [name, def] of defs) {
    if (onlySerialized && !def.serialize) continue;
    if (def.readonly) continue;
    const v = instance[name];
    if (v === undefined) continue;
    out[name] = serializeValue(v, def.type);
  }
  return out;
}

export function inferType(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? PropertyType.Number : PropertyType.Number;
  if (typeof value === 'boolean') return PropertyType.Boolean;
  if (typeof value === 'string') return PropertyType.String;
  if (value instanceof Vector3) return PropertyType.Vector3;
  if (value instanceof Vector2) return PropertyType.Vector2;
  if (value instanceof Color3) return PropertyType.Color3;
  if (value instanceof Color4) return PropertyType.Color4;
  if (value instanceof Quaternion) return PropertyType.Quaternion;
  if (value instanceof CFrame) return PropertyType.CFrame;
  if (Array.isArray(value)) return PropertyType.Array;
  if (value && typeof value === 'object') return PropertyType.Dictionary;
  return PropertyType.Any;
}

// ---------------------------------------------------------------------------
// Coercion & cloning
// ---------------------------------------------------------------------------
export function coerceValue(value, def) {
  const t = def.type;
  switch (t) {
    case PropertyType.Number: {
      let n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) n = def.default ?? 0;
      if (def.clampMin && def.min !== undefined) n = Math.max(def.min, n);
      if (def.clampMax && def.max !== undefined) n = Math.min(def.max, n);
      return n;
    }
    case PropertyType.Integer: {
      let n = Math.round(typeof value === 'number' ? value : Number(value));
      if (!Number.isFinite(n)) n = def.default ?? 0;
      if (def.min !== undefined) n = Math.max(def.min, n);
      if (def.max !== undefined) n = Math.min(def.max, n);
      return n;
    }
    case PropertyType.Boolean: return !!value;
    case PropertyType.String:
    case PropertyType.Text: return value == null ? '' : String(value);
    case PropertyType.Vector2: return value instanceof Vector2 ? value : Vector2.from ? Vector2.from(value) : new Vector2(value?.x ?? 0, value?.y ?? 0);
    case PropertyType.Vector3: return value instanceof Vector3 ? value : Vector3.from(value);
    case PropertyType.Vector4: return value instanceof Vector4 ? value : Vector4.from ? Vector4.from(value) : new Vector4(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0, value?.w ?? 0);
    case PropertyType.Color3: return value instanceof Color3 ? value : Color3.fromArray(value);
    case PropertyType.Color4: return value instanceof Color4 ? value : Color4.fromArray(value);
    case PropertyType.Quaternion: return value instanceof Quaternion ? value : Quaternion.fromArray(value);
    case PropertyType.CFrame: {
      if (value instanceof CFrame) return value;
      if (typeof value === 'object' && value && value.p) return CFrame.fromJSON(value);
      return new CFrame();
    }
    case PropertyType.Transform: {
      if (value instanceof Transform) return value;
      const t2 = new Transform();
      if (value && typeof value === 'object') t2.fromJSON(value);
      return t2;
    }
    case PropertyType.Enum: {
      if (def.enum) {
        if (typeof value === 'string') return value;
        const found = Object.entries(def.enum).find(([, v]) => v === value);
        if (found) return found[0];
      }
      return value ?? def.default;
    }
    case PropertyType.Array: return Array.isArray(value) ? value : [value];
    case PropertyType.Dictionary: return value && typeof value === 'object' ? value : {};
    default: return value;
  }
}

export function cloneValue(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v.clone && typeof v.clone === 'function') return v.clone();
  if (Array.isArray(v)) return v.map(cloneValue);
  if (typeof v === 'object') {
    if (v.constructor === Object) {
      const o = {};
      for (const k in v) o[k] = cloneValue(v[k]);
      return o;
    }
    if (typeof v.toJSON === 'function') return v.toJSON();
  }
  return v;
}

export function serializeValue(v, type) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (type === PropertyType.Instance) return v.id ?? null;
  if (Array.isArray(v)) return v.map((x) => serializeValue(x, undefined));
  if (v instanceof Transform) {
    return { p: v.position.toJSON(), r: v.rotation.toJSON(), s: v.scale.toJSON() };
  }
  if (typeof v.toJSON === 'function') return v.toJSON();
  if (typeof v === 'object') {
    const o = {};
    for (const k in v) o[k] = serializeValue(v[k], undefined);
    return o;
  }
  return v;
}

export function deserializeValue(raw, type) {
  if (raw === null || raw === undefined) return raw;
  switch (type) {
    case PropertyType.Vector2: return Vector2.fromJSON ? Vector2.fromJSON(raw) : new Vector2(raw[0], raw[1]);
    case PropertyType.Vector3: return Array.isArray(raw) ? Vector3.fromJSON(raw) : Vector3.from(raw);
    case PropertyType.Vector4: return Array.isArray(raw) ? Vector4.fromJSON(raw) : raw;
    case PropertyType.Color3: return Array.isArray(raw) ? Color3.fromJSON(raw) : Color3.fromNamed(raw);
    case PropertyType.Color4: return Array.isArray(raw) ? Color4.fromJSON(raw) : raw;
    case PropertyType.Quaternion: return Quaternion.fromJSON(raw);
    case PropertyType.CFrame: return CFrame.fromJSON(raw);
    case PropertyType.Transform: { const t = new Transform(); return t.fromJSON(raw); }
    default: return raw;
  }
}

function valuesEqual(a, b, type) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  switch (type) {
    case PropertyType.Vector2:
    case PropertyType.Vector3:
    case PropertyType.Vector4:
    case PropertyType.Color3:
    case PropertyType.Color4:
    case PropertyType.Quaternion:
      return typeof a.equals === 'function' ? a.equals(b, 1e-6) : false;
    case PropertyType.CFrame: return a.equals?.(b, 1e-5) ?? false;
    default: return false;
  }
}

/** Human-readable one-line preview of a value (inspector rows, console prints). */
export function formatValue(v, def) {
  if (v === null || v === undefined) return 'nil';
  switch (def?.type) {
    case PropertyType.Number:
    case PropertyType.Integer: {
      const n = Number(v);
      const s = Math.abs(n) < 1e-6 ? '0' : (Math.round(n * 1000) / 1000).toString();
      return def.unit ? `${s} ${def.unit}` : s;
    }
    case PropertyType.Boolean: return v ? 'true' : 'false';
    case PropertyType.Color3:
    case PropertyType.Color4: return typeof v.toHex === 'function' ? v.toHex() : String(v);
    case PropertyType.Vector3: return typeof v.toString === 'function' ? v.toString().replace('Vector3', '') : String(v);
    default:
      if (typeof v === 'object' && typeof v.toString === 'function') return v.toString();
      return String(v);
  }
}
