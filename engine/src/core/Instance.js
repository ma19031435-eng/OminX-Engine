/**
 * OminX Engine — Instance: the base object of the whole engine.
 *
 * Roblox-shaped API (`Name`, `Parent`, `GetChildren`, `FindFirstChild`, `Destroy`,
 * `GetAttribute`, `Changed`) so that anyone coming from Roblox Studio is instantly at home,
 * with the extra machinery a real engine needs: tags, components, replication flags,
 * selection/hierarchy signals, and a stable GUID for save files + netcode.
 *
 * @module engine/core/Instance
 */
import { Signal, SignalBag } from './Signal.js';
import { defineProperty, makePropertyTracker, getPropertyDefinitions, deserializeValue } from './Property.js';
import { createLogger } from './Logger.js';
import { Vector2 } from '../math/Vector2.js';
import { Vector3 } from '../math/Vector3.js';
import { Color3 } from '../math/Color3.js';

const log = createLogger('Instance');
let _idCounter = 0;

/** Escape hatch for hosts that need crypto-quality ids (network replication, save files). */
function genId(prefix = 'i') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}_${crypto.randomUUID().slice(0, 13).replace(/-/g, '')}`;
  _idCounter = (_idCounter + 1) % 0xffffff;
  return `${prefix}_${Date.now().toString(36)}${_idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export class Instance {
  /**
   * @param {string|object} [name] class name, or an options object (`new Part({ Name, Position, Size })`)
   * @param {object} [opts] same options object shape when the first argument is the name
   *
   * Options: `Name`, `Parent`, `Archivable`, `Locked`, `Tags[]`, `Attributes{}`, `Children[]`,
   * plus any registered property of the class (`Position`, `Size`, `Health`, …).
   */
  constructor(name, opts = {}) {
    if (name !== null && typeof name === 'object') { opts = { ...name, ...opts }; name = opts.Name ?? opts.name; }
    /** Stable unique id (never serialized as "the" identity for instances created at runtime by peers). */
    const isPlainInstance = this.constructor === Instance;
    if (isPlainInstance && typeof name === 'string') this._className = name;
    this.id = genId((this._className ?? this.constructor.ClassName ?? 'i').slice(0, 2).toLowerCase());
    this._name = name ?? this.constructor.ClassName ?? 'Instance';
    this._parent = null;
    this._children = [];
    this._attributes = new Map();
    this._tags = new Set();
    this._components = [];
    this._destroyed = false;
    /** Server-authoritative flag; the client mirrors these but never simulates them. */
    this.authority = 'server';
    this.replication = { mode: 'auto', ownerId: null, dirty: true };
    /** Free-form metadata (editor layout, comments, import source). */
    this.metadata = {};

    this._initializeOptions(opts);
    this._onPropertyChanged = makePropertyTracker(this);
    this._changedSignal = new Signal(`${this.constructor.ClassName}.Changed`);
    this._propertyChangedSignal = new Signal('PropertyChanged');
    this._propertySignals = new Map();
    this._childAdded = new Signal('ChildAdded');
    this._childRemoved = new Signal('ChildRemoved');
    this._descendantAdded = new Signal('DescendantAdded');
    this._descendantRemoving = new Signal('DescendantRemoving');
    this._attributeChanged = new Signal('AttributeChanged');
    this._ancestryChanged = new Signal('AncestryChanged');
    this._destroying = new Signal('Destroying');
    this._destroyedSignal = new Signal('Destroyed');
    if (this._pendingParent) { const p = this._pendingParent; this._pendingParent = null; this.setParent(p); }
    this._signals = new SignalBag();
    this._componentsChanged = new Signal('ComponentsChanged');
  }

  /** Applies a constructor options object; registered properties go through their setters. */
  _initializeOptions(opts) {
    if (!opts || typeof opts !== 'object') return;
    for (const [key, value] of Object.entries(opts)) {
      if (value === undefined) continue;
      switch (key) {
        case 'name': case 'Name':
          this._name = String(value);
          break;
        case 'Parent': case 'parent':
          this._pendingParent = value;      // applied after construction, once signals exist
          break;
        case 'Archivable': this.Archivable = !!value; break;
        case 'Locked': this.Locked = !!value; break;
        case 'Visible': this.Visible = !!value; break;
        case 'Tags': for (const tag of value) this._tags.add(String(tag)); break;
        case 'Attributes': for (const [k, v] of Object.entries(value)) this._attributes.set(k, v); break;
        case 'Children': for (const child of value) child.setParent(this); break;
        default:
          // Registered property setters (Position/Size/Health…) are picked up here.
          try { this[key] = value; } catch { /* unknown option — ignore */ }
          break;
      }
    }
  }

  static ClassName = 'Instance';

  /**
   * Studio-shaped factory: `Instance.new('Part', { Name: 'Wall', Position: v })`.
   * Subclass-aware: `Instance.new('Folder')` returns a real Folder.
   */
  static new(classNameOrOpts, opts = {}) {
    if (classNameOrOpts !== null && typeof classNameOrOpts === 'object') return new Instance(classNameOrOpts);
    const name = String(classNameOrOpts ?? 'Folder');
    const ctor = INSTANCE_REGISTRY.get(name);
    if (ctor && ctor !== Instance) return new ctor(opts);
    return new Instance(name, opts);
  }

  /** Inverse of `toJSON()` — rebuilds a tree from a serialized snapshot. */
  static fromJSON(json) { return Instance.deserialize(json); }

  /** Registers a class so `Instance.new('Part')` can construct it. */
  static register(ctor) {
    if (!ctor?.ClassName) throw new Error('Instance.register requires a class with a static ClassName');
    INSTANCE_REGISTRY.set(ctor.ClassName, ctor);
    return ctor;
  }
  /**
   * Roblox-style class name. `Instance.new('Part')` / `new Instance('Part')` create a plain
   * instance *of* that class name, while subclasses report their own class.
   */
  get ClassName() { return this._className ?? this.constructor.ClassName ?? this.constructor.name; }
  set ClassName(v) { this._className = String(v); }
  get className() { return this.ClassName; }

  // --------------------------------------------------------------- identity
  get Name() { return this._name; }
  set Name(v) {
    const nv = String(v ?? '');
    if (nv === this._name) return;
    const old = this._name;
    this._name = nv;
    this._changedSignal.emit('Name', nv, old);
  }
  get name() { return this._name; }
  set name(v) { this.Name = v; }

  /** Full path in the hierarchy, e.g. `Workspace.Map.Props.Crate_03`. */
  getFullName() {
    const parts = [];
    let node = this;
    while (node && node !== node._parent) {
      parts.unshift(node._name);
      node = node._parent;
    }
    return parts.join('.');
  }
  get FullName() { return this.getFullName(); }

  // --------------------------------------------------------------- hierarchy
  get Parent() { return this._parent; }
  set Parent(p) { this.setParent(p); }
  get parent() { return this._parent; }
  set parent(p) { this.setParent(p); }

  setParent(newParent, keepWorldTransform = false) {
    if (newParent === this._parent) return this;
    if (newParent === this) throw new Error('Cannot parent an instance to itself');
    if (newParent && this.isAncestorOf(newParent)) throw new Error('Cannot create a cyclic hierarchy');
    if (newParent && newParent._destroyed) throw new Error('Cannot parent to a destroyed instance');
    const old = this._parent;
    if (old) {
      const i = old._children.indexOf(this);
      if (i >= 0) old._children.splice(i, 1);
      old._childRemoved.emit(this);
      old._notifyAncestry(this, false);
    }
    this._parent = newParent ?? null;
    if (newParent) {
      newParent._children.push(this);
      newParent._childAdded.emit(this);
      newParent._notifyAncestry(this, true);
    }
    if (keepWorldTransform && this.transform && this.worldMatrix) {
      // preserve world transform by recomputing local matrix from old world matrix
      this._preserveWorldTransform?.();
    }
    this._ancestryChanged.emit(this, newParent);
    this.onAncestryChanged?.(newParent);
    return this;
  }

  _notifyAncestry(child, added) {
    if (added) this._descendantAdded.emit(child);
    else this._descendantRemoving.emit(child);
    this._parent?._notifyAncestry(child, added);
  }

  getChildren() { return this._children.slice(); }
  GetChildren() { return this.getChildren(); }
  get children() { return this._children; }
  get childCount() { return this._children.length; }
  get hasChildren() { return this._children.length > 0; }

  findFirstChild(name, recursive = false) {
    for (const c of this._children) {
      if (c._name === name) return c;
      if (recursive) { const r = c.findFirstChild(name, true); if (r) return r; }
    }
    return undefined;
  }
  FindFirstChild(name, recursive) { return this.findFirstChild(name, recursive); }
  /** Short alias for `findFirstChild` — used all over level and gameplay code. */
  Child(name) { return this.findFirstChild(name); }
  GetChild(name) { return this.findFirstChild(name); }
  FindFirstChildOfClass(className) { return this._children.find((c) => c.ClassName === className); }
  FindFirstChildWhichIsA(className, recursive = false) {
    for (const c of this._children) {
      if (c.isA(className)) return c;
      if (recursive) { const r = c.FindFirstChildWhichIsA(className, true); if (r) return r; }
    }
    return undefined;
  }
  FindFirstAncestor(name) {
    let p = this._parent;
    while (p) { if (!name || p._name === name) return p; p = p._parent; }
    return undefined;
  }
  FindFirstAncestorOfClass(className) {
    let p = this._parent;
    while (p) { if (p.isA(className)) return p; p = p._parent; }
    return undefined;
  }
  FindFirstAncestorWhichIsA(className) { return this.FindFirstAncestorOfClass(className); }
  findFirstChildOfClass(className) { return this.FindFirstChildOfClass(className); }
  /** All children matching a predicate/class/tag. */
  findAll(predicate) {
    const fn = typeof predicate === 'string' ? (c) => c.ClassName === predicate : predicate;
    return this._children.filter((c) => !fn || fn(c));
  }
  find(predicate) { return this.findAll(predicate); }
  getDescendants() {
    const out = [];
    const walk = (node) => {
      for (const c of node._children) { out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }
  GetDescendants() { return this.getDescendants(); }
  getAncestors() {
    const out = [];
    let p = this._parent;
    while (p) { out.push(p); p = p._parent; }
    return out;
  }
  isDescendantOf(other) {
    let p = this._parent;
    while (p) { if (p === other) return true; p = p._parent; }
    return false;
  }
  isAncestorOf(other) { return other.isDescendantOf(this); }
  isA(className) {
    let ctor = this.constructor;
    while (ctor) {
      if (ctor.ClassName === className || ctor.name === className) return true;
      ctor = Object.getPrototypeOf(ctor);
    }
    return className === 'Instance';
  }
  IsA(className) { return this.isA(className); }

  /** Finds a descendant by path: `world.findByPath('Props/Crates/Crate_01')`. */
  findByPath(path) {
    const parts = String(path).split(/[./]/).filter(Boolean);
    let node = this;
    for (const part of parts) {
      if (part === '..') { node = node._parent; continue; }
      const next = node?._children.find((c) => c._name === part);
      if (!next) return undefined;
      node = next;
    }
    return node;
  }
  get isDestroyed() { return this._destroyed; }
  get IsDestroyed() { return this._destroyed; }

  // --------------------------------------------------------------- mutation
  addChild(child, index = -1) {
    if (index >= 0 && index < this._children.length) {
      child.setParent(this);
      const cur = this._children.indexOf(child);
      if (cur >= 0) this._children.splice(cur, 1);
      this._children.splice(index, 0, child);
      return child;
    }
    child.setParent(this);
    return child;
  }
  clone(deep = true) {
    const copy = new this.constructor();
    copy._name = this._name;
    copy.Archivable = this.Archivable;
    copy.Visible = this.Visible;
    copy._attributes = new Map([...this._attributes].map(([k, v]) => [k, cloneAttr(v)]));
    copy._tags = new Set(this._tags);
    copy.metadata = { ...this.metadata };
    // copy declared properties
    const defs = getPropertyDefinitions(this.constructor);
    for (const [name, def] of defs) {
      if (def.readonly) continue;
      const v = this[name];
      if (v === undefined) continue;
      try { copy[name] = typeof v?.clone === 'function' ? v.clone() : v; } catch { /* non-cloneable */ }
    }
    copy.onAfterClone?.(this);
    if (deep) for (const c of this._children) copy.addChild(c.clone(true));
    return copy;
  }
  Clone() { return this.clone(true); }
  CloneChildren() { return this._children.map((c) => c.clone(true)); }

  destroy() {
    if (this._destroyed) return;
    this._destroying.emit(this);
    for (const child of this._children.slice()) child.destroy();
    for (const comp of this._components.slice()) this.removeComponent(comp);
    this._parent?.addChild ? (() => {
      const p = this._parent;
      if (p) {
        const i = p._children.indexOf(this);
        if (i >= 0) p._children.splice(i, 1);
        p._childRemoved.emit(this);
        p._notifyAncestry(this, false);
      }
    })() : null;
    this._parent = null;
    this._destroyed = true;
    this.onDestroy?.();
    this._signals.dispose();
    for (const s of [this._changedSignal, this._childAdded, this._childRemoved, this._descendantAdded,
      this._descendantRemoving, this._attributeChanged, this._ancestryChanged, this._propertyChangedSignal,
      this._componentsChanged]) {
      s.disconnectAll();
    }
    for (const s of this._propertySignals.values()) s.disconnectAll();
    this._propertySignals.clear();
    this._destroyedSignal.emit(this);
    this._destroyedSignal.disconnectAll();
  }
  Destroy() { return this.destroy(); }
  /** Removes from the tree but keeps the instance usable (Roblox `Parent = nil` plus cleanup). */
  detach() { this.setParent(null); return this; }

  // --------------------------------------------------------------- attributes
  setAttribute(name, value) {
    const old = this._attributes.get(name);
    if (value === undefined) this._attributes.delete(name);
    else this._attributes.set(name, value);
    if (old !== value) this._attributeChanged.emit(name, value, old);
    return this;
  }
  SetAttribute(name, value) { return this.setAttribute(name, value); }
  getAttribute(name) { return this._attributes.get(name); }
  GetAttribute(name) { return this.getAttribute(name); }
  GetAttributeChangedSignal(name) { return this.getAttributeSignal(name); }
  getAttributeSignal(name) {
    if (!this._attributeSignals) this._attributeSignals = new Map();
    let s = this._attributeSignals.get(name);
    if (!s) { s = new Signal(`AttributeChanged:${name}`); this._attributeSignals.set(name, s); }
    return s;
  }
  getAllAttributes() { return Object.fromEntries(this._attributes); }
  GetAttributes() { return this.getAllAttributes(); }
  removeAttribute(name) { return this.setAttribute(name, undefined); }

  // --------------------------------------------------------------- tags
  addTag(tag) {
    if (this._tags.has(tag)) return this;
    this._tags.add(tag);
    this._tagSignals?.[tag]?.emit(true);
    return this;
  }
  AddTag(tag) { return this.addTag(tag); }
  removeTag(tag) {
    if (!this._tags.delete(tag)) return this;
    this._tagSignals?.[tag]?.emit(false);
    return this;
  }
  RemoveTag(tag) { return this.removeTag(tag); }
  hasTag(tag) { return this._tags.has(tag); }
  HasTag(tag) { return this.hasTag(tag); }
  tags() { return [...this._tags]; }
  GetTags() { return this.tags(); }
  getTagSignal(tag) {
    this._tagSignals ??= {};
    this._tagSignals[tag] ??= new Signal(`Tag:${tag}`);
    return this._tagSignals[tag];
  }
  /** Finds all descendants carrying a tag — the fastest map-wide query in the engine. */
  findTaggedDescendants(tag, out = []) {
    for (const c of this._children) { if (c._tags.has(tag)) out.push(c); c.findTaggedDescendants(tag, out); }
    return out;
  }

  // --------------------------------------------------------------- components (Unity-style)
  addComponent(CompClassOrInstance, props = {}) {
    const comp = typeof CompClassOrInstance === 'function' ? new CompClassOrInstance() : CompClassOrInstance;
    comp.host = this;
    comp.instance = this;
    Object.assign(comp, props);
    this._components.push(comp);
    comp.onAttach?.(this);
    this._componentsChanged.emit('added', comp);
    this.onComponentAdded?.(comp);
    return comp;
  }
  /** @returns {object|null} the first component of that class (null when absent, never undefined). */
  getComponent(ClassOrName) {
    if (typeof ClassOrName === 'function') return this._components.find((c) => c instanceof ClassOrName) ?? null;
    return this._components.find((c) => c.constructor.ClassName === ClassOrName || c.constructor.name === ClassOrName) ?? null;
  }
  getComponents(ClassOrName) {
    if (!ClassOrName) return this._components.slice();
    if (typeof ClassOrName === 'function') return this._components.filter((c) => c instanceof ClassOrName);
    return this._components.filter((c) => c.constructor.ClassName === ClassOrName || c.constructor.name === ClassOrName);
  }
  getAllComponents() { return this._components.slice(); }
  GetComponents() { return this.getAllComponents(); }
  hasComponent(ClassOrName) { return !!this.getComponent(ClassOrName); }
  removeComponent(comp) {
    const c = typeof comp === 'string' ? this.getComponent(comp) : comp;
    if (!c) return false;
    const i = this._components.indexOf(c);
    if (i < 0) return false;
    this._components.splice(i, 1);
    c.onDetach?.(this);
    c.dispose?.();
    this._componentsChanged.emit('removed', c);
    this.onComponentRemoved?.(c);
    return true;
  }
  get components() { return this._components; }

  // --------------------------------------------------------------- signals
  get Changed() { return this._changedSignal; }
  get PropertyChanged() { return this._propertyChangedSignal; }
  GetPropertyChangedSignal(name) { return this.getPropertyChangedSignal(name); }
  getPropertyChangedSignal(name) {
    let s = this._propertySignals.get(name);
    if (!s) { s = new Signal(`${this.ClassName}.${name}Changed`); this._propertySignals.set(name, s); }
    return s;
  }
  get ChildAdded() { return this._childAdded; }
  get ChildRemoved() { return this._childRemoved; }
  get DescendantAdded() { return this._descendantAdded; }
  get DescendantRemoving() { return this._descendantRemoving; }
  get AttributeChanged() { return this._attributeChanged; }
  get AncestryChanged() { return this._ancestryChanged; }
  get Destroying() { return this._destroying; }
  get Destroyed() { return this._destroyedSignal; }
  get ComponentsChanged() { return this._componentsChanged; }
  /** Tracked connection bag — everything registered here dies with the instance. */
  get signals() { return this._signals; }
  /** Convenience: connect + auto-disconnect on destroy. */
  bind(signal, fn) { return this._signals.track(signal, fn); }

  // --------------------------------------------------------------- serialization
  /** Serializes this node and (optionally) all descendants. */
  serialize({ deep = true, includeHidden = false } = {}) {
    const defs = getPropertyDefinitions(this.constructor);
    const props = {};
    for (const [name, def] of defs) {
      if (!def.serialize || def.readonly || (def.hidden && !includeHidden)) continue;
      const v = this[name];
      if (v === undefined) continue;
      props[name] = serializeProp(v, def);
    }
    const out = {
      class: this.ClassName,
      id: this.id,
      name: this._name,
      props,
    };
    if (this._attributes.size) out.attributes = Object.fromEntries([...this._attributes].map(([k, v]) => [k, serializeAttr(v)]));
    if (this._tags.size) out.tags = [...this._tags];
    if (Object.keys(this.metadata).length) out.metadata = { ...this.metadata };
    if (this._components.length) {
      out.components = this._components
        .filter((c) => c.constructor.ClassName && c.serialize !== false)
        .map((c) => ({ class: c.constructor.ClassName, props: c.serializeProps?.() ?? {} }));
    }
    if (deep) {
      const kids = this._children.filter((c) => includeHidden || c.Archivable);
      if (kids.length) out.children = kids.map((c) => c.serialize({ deep: true, includeHidden }));
    }
    return out;
  }
  toJSON() { return this.serialize({ deep: true }); }

  static deserialize(data, registry) {
    // Prefer the caller's registry, then the global class registry (Part, MeshPart, …).
    const Ctor = registry?.get?.(data.class) ?? INSTANCE_REGISTRY.get(data.class) ?? Instance;
    const node = new Ctor(data.props?.Name ?? undefined);
    node.id = data.id ?? genId();
    node._name = data.name ?? Ctor.ClassName;
    if (data.props) {
      for (const [k, raw] of Object.entries(data.props)) {
        const def = getPropertyDefinitions(Ctor).get(k);
        try {
          node[k] = def ? deserializeProp(raw, def) : raw;
        } catch (err) {
          log.warn(`failed restoring ${Ctor.ClassName}.${k}`, err);
        }
      }
    }
    if (data.attributes) node._attributes = new Map(Object.entries(data.attributes).map(([k, v]) => [k, deserializeAttr(v)]));
    if (data.tags) node._tags = new Set(data.tags);
    if (data.metadata) node.metadata = { ...data.metadata };
    if (data.components && registry?.components) {
      for (const c of data.components) {
        const CompCtor = registry.components.get(c.class);
        if (CompCtor) { const comp = node.addComponent(CompCtor); comp.deserializeProps?.(c.props ?? {}); }
      }
    }
    if (data.children) for (const childData of data.children) node.addChild(Instance.deserialize(childData, registry));
    return node;
  }

  toString() { return `${this.ClassName}("${this._name}")`; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toString(); }
}

function serializeProp(v, def) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (def.type === 'Instance') return { ref: v.id, path: v.getFullName?.() };
  if (Array.isArray(v)) return v.map((x) => serializeProp(x, {}));
  if (typeof v.toJSON === 'function') return v.toJSON();
  if (t === 'object') {
    const o = {};
    for (const k in v) o[k] = serializeProp(v[k], {});
    return o;
  }
  return v;
}
function deserializeProp(raw, def) {
  if (raw === null || raw === undefined) return raw;
  return deserializeValue(raw, def.type);
}

function serializeAttr(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(serializeAttr);
  if (typeof v.toJSON === 'function') return { __t: v.constructor.name, v: v.toJSON() };
  const o = {};
  for (const k in v) o[k] = serializeAttr(v[k]);
  return o;
}
function deserializeAttr(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deserializeAttr);
  if (v.__t) return reviverAttr(v.__t, v.v);
  const o = {};
  for (const k in v) o[k] = deserializeAttr(v[k]);
  return o;
}
function reviverAttr(type, raw) {
  try {
    switch (type) {
      case 'Vector3': return Vector3.fromJSON(raw);
      case 'Vector2': return Vector2.fromJSON(raw);
      case 'Color3': return Color3.fromJSON(raw);
      default: return raw;
    }
  } catch { return raw; }
}

function cloneAttr(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.clone === 'function') return v.clone();
  if (Array.isArray(v)) return v.map(cloneAttr);
  return { ...v };
}

// ---------------------------------------------------------------------------
// A handful of leaf/utility classes that belong to the base object model
// ---------------------------------------------------------------------------
/** Non-visual container used by the editor tree (Roblox `Folder`). */
export class Folder extends Instance {}
Folder.ClassName = 'Folder';
// Declarative base-class properties: these drive the inspector, save files and replication
// for every instance in the engine (subclasses inherit the registry entry).
defineProperty(Instance, 'Archivable', { type: 'boolean', default: true, category: 'Data', tooltip: 'Include this instance when saving the scene.' });
defineProperty(Instance, 'Locked', { type: 'boolean', default: false, category: 'Editor', tooltip: 'Prevent selection and dragging in the editor.' });
defineProperty(Instance, 'Visible', { type: 'boolean', default: true, category: 'Appearance', tooltip: 'Hides this instance and its descendants.' });
defineProperty(Instance, 'DebugVisible', { type: 'boolean', default: true, category: 'Editor', hidden: true, replicated: false, serialize: false });

/** Thin wrapper that turns a plain callable into an Instance property (Roblox `BindableEvent`). */
export class BindableEvent extends Instance {
  constructor() {
    super('BindableEvent');
    this.Event = new Signal('BindableEvent.Event');
  }
  /** Roblox-shaped methods that forward to the underlying signal. */
  connect(fn, opts) { return this.Event.connect(fn, opts); }
  Connect(fn, opts) { return this.Event.connect(fn, opts); }
  fire(...args) { return this.Event.emit(...args); }
  Fire(...args) { return this.Event.emit(...args); }
  once(fn) { return this.Event.once(fn); }
  disconnectAll() { return this.Event.disconnectAll?.(); }
  Fire(...args) { this.Event.emit(...args); }
  fire(...args) { return this.Fire(...args); }
}
BindableEvent.ClassName = 'BindableEvent';

/** Global key/value store shared across scripts (Roblox `_G` equivalent, but scoped + observable). */
export class SharedStore extends Instance {
  constructor() {
    super('SharedStore');
    this._values = new Map();
    this.Changed = new Signal('SharedStore.Changed');
  }
  set(key, value) {
    const old = this._values.get(key);
    this._values.set(key, value);
    this.Changed.emit(key, value, old);
    return this;
  }
  get(key, fallback) { return this._values.has(key) ? this._values.get(key) : fallback; }
  has(key) { return this._values.has(key); }
  delete(key) { const had = this._values.delete(key); if (had) this.Changed.emit(key, undefined, undefined); return had; }
  keys() { return [...this._values.keys()]; }
  toJSON() { return Object.fromEntries(this._values); }
}
SharedStore.ClassName = 'SharedStore';

/** A marker node used by tests & tools to hold arbitrary data. */
export class DataNode extends Instance {
  constructor(name = 'DataNode') { super(name); this.Value = null; }
}
DataNode.ClassName = 'DataNode';
defineProperty(DataNode, 'Value', { type: 'any', default: null, category: 'Data' });

export { genId };
/** Class-name registry used by the Studio-style `Instance.new('Part')` factory. */
export const INSTANCE_REGISTRY = new Map([['Instance', Instance]]);
INSTANCE_REGISTRY.set('Folder', Folder);
INSTANCE_REGISTRY.set('BindableEvent', BindableEvent);
INSTANCE_REGISTRY.set('DataNode', DataNode);

export default Instance;
