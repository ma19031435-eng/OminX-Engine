/**
 * OminX Engine — assets.
 *
 * An FPS level is a fan-out of content: meshes, textures, materials, animation clips, audio, level
 * data, and weapon definitions that reference all of the above. Doing that ad hoc means loading the
 * same texture five times, unloading one the user is still looking at, and blocking the thread on a
 * 12 MB level file. The registry gives every asset one identity and one lifetime.
 *
 * The model, in UE terms:
 *   - **Paths are identity.** `/Game/Maps/Arena` — stable, serializable, human-readable. References
 *     in saved data use paths, never pointers, so a save file survives a process restart.
 *   - **Hard reference** = you are using it now (an `AssetHandle` you must release). A loaded asset
 *     with zero hard references is eligible for collection.
 *   - **Soft reference** = a string path you resolve when needed (`SoftAssetRef.get()`), which starts
 *     an async load. This is how a "next map" or an alternate weapon skin is referenced without
 *     paying for it up front.
 *   - **Registry metadata without loading.** `registry.scan(manifest)` makes every path queryable
 *     (type, size, dependencies, tags) while everything stays on disk; an editor browser or a
 *     streaming pass works from that metadata alone.
 *   - **Types own the loading.** A `AssetType` declares extensions and a loader; the engine itself
 *     has no idea what a `.gltf` is, so renderers, audio and gameplay register their own loaders.
 *   - **Derived data.** Expensive runtime derivatives (compressed textures, nav mesh, cooked physics)
 *     are cached per asset and invalidated by a content hash.
 *
 * Loads are deduplicated by path (`load()` of the same path twice returns the same promise),
 * reference counted, and streamed through a `WorkQueue` so a level can be brought in without
 * stalling the frame.
 *
 * @module engine/src/core/AssetRegistry
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';
import { WorkQueue } from './JobGraph.js';

const log = createLogger('Assets');

export const AssetState = {
  Unregistered: 'unregistered',
  Registered: 'registered',
  Loading: 'loading',
  Loaded: 'loaded',
  Failed: 'failed',
};

export const assetTypeCategory = {
  Map: 'map',
  Mesh: 'mesh',
  Texture: 'texture',
  Material: 'material',
  Animation: 'animation',
  Audio: 'audio',
  Data: 'data',
  Script: 'script',
  Folder: 'folder',
};

export const assetEvents = {
  onRegistered: new MulticastDelegate('assets.onRegistered'),
  onLoadStarted: new MulticastDelegate('assets.onLoadStarted'),
  onLoaded: new MulticastDelegate('assets.onLoaded'),
  onFailed: new MulticastDelegate('assets.onFailed'),
  onUnloaded: new MulticastDelegate('assets.onUnloaded'),
  onGarbageCollected: new MulticastDelegate('assets.onGarbageCollected'),
  onBundleLoaded: new MulticastDelegate('assets.onBundleLoaded'),
};

/** A content type: which extensions belong to it and how to load them. */
export class AssetType {
  constructor({ name, category = assetTypeCategory.Data, extensions = [], loader = null, priority = 0, compressible = true } = {}) {
    if (!name) throw new Error('AssetType needs a name');
    this.name = name;
    this.category = category;
    this.extensions = extensions.map(normalizeExtension);
    this.loader = loader;
    this.priority = priority;
    this.compressible = compressible;
    this.loadedCount = 0;
    this.failedCount = 0;
    this.totalBytes = 0;
  }

  matches(path) {
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    return this.extensions.includes(extension) || (!this.extensions.length && this.name === 'default');
  }

  async load(entry, context) {
    if (this.loader) return this.loader(entry, context);
    // Default: raw bytes (a loader is expected for anything interesting).
    return context.io(entry.path, { binary: true });
  }

  describe() {
    return {
      name: this.name, category: this.category, extensions: [...this.extensions],
      loaded: this.loadedCount, failed: this.failedCount, bytes: this.totalBytes,
      hasLoader: !!this.loader,
    };
  }
}

function normalizeExtension(extension) {
  const value = String(extension).toLowerCase();
  return value.startsWith('.') ? value : `.${value}`;
}

/** One entry in the registry: identity + metadata, whether or not the payload is in memory. */
export class AssetEntry {
  constructor(path, { type = 'default', size = 0, dependencies = [], tags = [], metadata = {}, bundle = 'default', source = 'scan' } = {}) {
    this.path = path;
    this.type = type;
    this.size = size;
    this.dependencies = [...dependencies];
    this.tags = new Set(tags);
    this.metadata = { ...metadata };
    this.bundle = bundle;
    this.source = source;
    this.state = AssetState.Registered;
    this.data = null;
    this.error = null;
    this.hardRefs = 0;
    this.promise = null;
    this.loadedAt = 0;
    this.loads = 0;
    this.derived = new Map();
    this.contentHash = 0;
  }

  get loaded() { return this.state === AssetState.Loaded; }
  get isReferenced() { return this.hardRefs > 0; }

  describe() {
    return {
      path: this.path, type: this.type, size: this.size, state: this.state,
      hardRefs: this.hardRefs, dependencies: this.dependencies.length,
      tags: [...this.tags], bundle: this.bundle, loads: this.loads,
      error: this.error?.message ?? null, derived: [...this.derived.keys()],
    };
  }
}

/**
 * A hard reference. Hold it while you use the asset; `release()` when done. This is what keeps the
 * collector from pulling a texture out from under a material.
 */
export class AssetHandle {
  constructor(registry, path) {
    this.registry = registry;
    this.path = path;
    this.released = false;
    this.acquiredAt = Date.now();
  }

  get() { return this.registry.peek(this.path); }
  get isValid() { return !this.released && this.registry.has(this.path); }
  /** Re-acquires an already-released handle (pooled/subscribed use), or null if it is gone. */
  retain() {
    if (this.released) { this.released = false; this.registry.retain(this.path); }
    return this;
  }

  release() {
    if (this.released) return false;
    this.released = true;
    return this.registry.release(this.path);
  }

  [Symbol.dispose]() { this.release(); }
}

/**
 * A soft reference: a path that can be resolved later. This is the form saved in data, exposed to
 * scripts and compared against objectives — cheap, serializable, no lifetime coupling.
 */
export class SoftAssetRef {
  constructor(registry, path, { allowMissing = true } = {}) {
    this.registry = registry;
    this.path = path;
    this.allowMissing = allowMissing;
  }

  get isLoaded() { return this.registry.isLoaded(this.path); }
  get entry() { return this.registry.get(this.path); }

  /** Resolves the asset, loading it if necessary. Returns `null` for a missing path. */
  async get({ signal = null } = {}) {
    if (this.isLoaded) return this.registry.peek(this.path);
    if (!this.registry.has(this.path)) {
      if (!this.allowMissing) throw new Error(`soft reference "${this.path}" is not registered`);
      return null;
    }
    return this.registry.load(this.path, { signal });
  }

  /** Keeps the asset alive (e.g. while a level that uses it is open). */
  retain() { return this.registry.retain(this.path); }
  release() { return this.registry.release(this.path); }
  toString() { return this.path; }
  toJSON() { return this.path; }
}

/** A named group of assets loaded/unloaded together (a level, a DLC pack, a menu). */
export class AssetBundle {
  constructor(registry, name, { assets = [], dependsOn = [] } = {}) {
    this.registry = registry;
    this.name = name;
    this.assets = new Set(assets);
    this.dependsOn = [...dependsOn];
    this.handles = [];
    this.state = 'unloaded';
  }

  add(path) { this.assets.add(path); return this; }

  /** Loads every asset in the bundle plus its parents, tracking handles so `unload()` is complete. */
  async load({ concurrency = 6, progress = null } = {}) {
    this.state = 'loading';
    const queue = new WorkQueue({ concurrency });
    let done = 0;
    const paths = this._resolvePaths();
    const total = paths.length || 1;
    for (const path of paths) {
      queue.push(async () => {
        const handle = await this.registry.loadHandle(path);
        if (handle) this.handles.push(handle);
        done++;
        progress?.(done / total, path);
      }, this.registry.get(path)?.size ?? 0);
    }
    await queue.drain();
    this.state = this.registry.isLoaded(this.handles.map((handle) => handle.path)) ? 'loaded' : 'partial';
    assetEvents.onBundleLoaded.broadcast(this);
    return this;
  }

  _resolvePaths() {
    const out = new Set();
    const visit = (bundle) => {
      for (const parent of bundle.dependsOn) visit(this.registry.bundle(parent));
      for (const path of bundle.assets) out.add(path);
    };
    visit(this);
    return [...out];
  }

  unload() {
    for (const handle of this.handles) handle.release();
    this.handles.length = 0;
    this.state = 'unloaded';
    return this;
  }

  get loadedCount() { return this.handles.filter((handle) => !handle.released).length; }
  describe() { return { name: this.name, assets: this.assets.size, state: this.state, loaded: this.loadedCount, dependsOn: [...this.dependsOn] }; }
}

/**
 * The registry. Owns identity, metadata, loading, lifetimes and the dependency graph.
 */
export class AssetRegistry {
  constructor({ io = defaultIO, concurrency = 4, stats = null, name = 'AssetRegistry' } = {}) {
    this.name = name;
    this.io = io;
    this.stats = stats;
    this.concurrency = concurrency;
    this.queue = new WorkQueue({ concurrency });
    /** @type {Map<string, AssetEntry>} */
    this.entries = new Map();
    /** @type {Map<string, AssetType>} */
    this.types = new Map();
    /** @type {Map<string, AssetBundle>} */
    this.bundles = new Map();
    /** @type {Map<string, Set<string>>} */
    this.dependents = new Map();
    this.loadedBytes = 0;
    this.peakLoadedBytes = 0;
    this.loadCount = 0;
    this.failedCount = 0;
    this.ioBytes = 0;
    this.missLog = [];
    this.bundle('default');
  }

  static create(options) { return new AssetRegistry(options); }

  // ------------------------------------------------------------------ types
  registerType(options) {
    const type = options instanceof AssetType ? options : new AssetType(options);
    this.types.set(type.name, type);
    return type;
  }

  typeFor(path) {
    const explicit = this.entries.get(path)?.type;
    if (explicit && this.types.has(explicit)) return this.types.get(explicit);
    for (const type of this.types.values()) if (type.extensions.length && type.matches(path)) return type;
    return this.types.get('default') ?? null;
  }

  typeNames() { return [...this.types.keys()]; }

  // ------------------------------------------------------------------ registration
  /**
   * Registers a path with metadata only — nothing is read from disk. `scan()` takes a manifest of
   * these and is what an editor's content browser or a streaming manifest is built from.
   */
  register(path, options = {}) {
    const existing = this.entries.get(path);
    if (existing) {
      // Re-scanning refreshes metadata but must not discard loaded data or references.
      Object.assign(existing.metadata, options.metadata ?? {});
      if (options.size !== undefined) existing.size = options.size;
      if (options.dependencies) existing.dependencies = [...options.dependencies];
      if (options.tags) for (const tag of options.tags) existing.tags.add(tag);
      if (options.bundle) existing.bundle = options.bundle;
      return existing;
    }
    const type = options.type ?? this.typeFor(path)?.name ?? 'default';
    const entry = new AssetEntry(normalizePath(path), { ...options, type });
    this.entries.set(entry.path, entry);
    for (const dependency of entry.dependencies) {
      if (!this.dependents.has(dependency)) this.dependents.set(dependency, new Set());
      this.dependents.get(dependency).add(entry.path);
    }
    if (entry.bundle !== 'default') this.bundle(entry.bundle).add(entry.path);
    assetEvents.onRegistered.broadcast(entry, this);
    return entry;
  }

  /** Bulk registration: `scan([{ path, size }, …])` or `scan({ '/Game/Maps': { … } })`. */
  scan(manifest) {
    const list = Array.isArray(manifest) ? manifest : Object.entries(manifest).map(([path, meta]) => ({ path, ...meta }));
    for (const item of list) this.register(item.path, item);
    log.debug(`scanned ${list.length} asset paths (${this.entries.size} total)`);
    return this;
  }

  /** Marks a bundle as a dependency of another, applied at load time. */
  bundle(name, { dependsOn = [] } = {}) {
    if (!this.bundles.has(name)) this.bundles.set(name, new AssetBundle(this, name, { dependsOn }));
    else if (dependsOn.length) this.bundles.get(name).dependsOn.push(...dependsOn);
    return this.bundles.get(name);
  }

  // ------------------------------------------------------------------ queries
  has(path) { return this.entries.has(normalizePath(path)); }
  get(path) { return this.entries.get(normalizePath(path)) ?? null; }
  isLoaded(path) { return this.entries.get(normalizePath(path))?.state === AssetState.Loaded; }
  /** The loaded payload (or null). Never starts a load. */
  peek(path) { const entry = this.entries.get(normalizePath(path)); return entry?.state === AssetState.Loaded ? entry.data : null; }
  paths() { return [...this.entries.keys()]; }
  count() { return this.entries.size; }
  loadedCount() { let n = 0; for (const entry of this.entries.values()) if (entry.loaded) n++; return n; }

  /** Registry-only search — the content browser and streaming passes both need this. */
  find({ type = null, tag = null, bundle = null, state = null, prefix = null, loaded = null } = {}) {
    const out = [];
    for (const entry of this.entries.values()) {
      if (type && entry.type !== type) continue;
      if (tag && !entry.tags.has(tag)) continue;
      if (bundle && entry.bundle !== bundle) continue;
      if (state && entry.state !== state) continue;
      if (prefix && !entry.path.startsWith(prefix)) continue;
      if (loaded !== null && entry.loaded !== loaded) continue;
      out.push(entry);
    }
    return out;
  }

  soft(path, options) { return new SoftAssetRef(this, normalizePath(path), options); }

  // ------------------------------------------------------------------ reference counting
  /** Adds a hard reference (loads nothing). Used by `loadHandle`. */
  retain(path) {
    const entry = this.entries.get(normalizePath(path));
    if (!entry) return 0;
    entry.hardRefs++;
    return entry.hardRefs;
  }

  release(path) {
    const entry = this.entries.get(normalizePath(path));
    if (!entry) return false;
    entry.hardRefs = Math.max(0, entry.hardRefs - 1);
    return true;
  }

  // ------------------------------------------------------------------ loading
  /**
   * Loads an asset, deduplicating concurrent requests for the same path. Returns the payload.
   * A failed load is remembered on the entry (`state: failed`) so a broken asset does not re-attempt
   * on every frame; `retry()` resets it.
   */
  async load(path, { force = false, signal = null, derived = null } = {}) {
    const entry = this.entries.get(normalizePath(path));
    if (!entry) {
      this.missLog.push({ path, at: Date.now() });
      if (this.missLog.length > 64) this.missLog.shift();
      return null;
    }
    if (entry.state === AssetState.Loaded && !force) return entry.data;
    if (entry.state === AssetState.Failed && !force) return null;
    if (entry.promise && !force) return entry.promise;

    const type = this.typeFor(entry.path);
    const loader = derived && type?.derivedLoaders?.[derived];
    entry.state = AssetState.Loading;
    assetEvents.onLoadStarted.broadcast(entry, this);
    this.stats?.count('Assets/LoadStarted');

    entry.promise = (async () => {
      const start = nowMs();
      try {
        const context = {
          io: this.io,
          registry: this,
          signal,
          log,
          report: (bytes) => this._trackBytes(bytes),
        };
        const data = loader ? await loader(entry, context) : await type.load(entry, context);
        entry.data = data;
        entry.state = AssetState.Loaded;
        entry.error = null;
        entry.loadedAt = Date.now();
        entry.loads++;
        entry.contentHash = hashString(`${entry.path}:${entry.size}:${entry.loads}`);
        this.loadCount++;
        type.loadedCount++;
        type.totalBytes += entry.size;
        this.loadedBytes += entry.size;
        this.peakLoadedBytes = Math.max(this.peakLoadedBytes, this.loadedBytes);
        // Dependencies of a loaded asset are loaded with it (materials need their textures).
        if (entry.dependencies.length) await this.loadDependencies(entry.path);
        this.stats?.count('Assets/Loaded');
        this.stats?.timing('Assets/LoadMs', nowMs() - start, { type: entry.type });
        if (this.stats?.gauge) this.stats.gauge('Assets/LoadedBytes', this.loadedBytes);
        assetEvents.onLoaded.broadcast(entry, this);
        return entry.data;
      } catch (error) {
        entry.state = AssetState.Failed;
        entry.error = error;
        this.failedCount++;
        type.failedCount++;
        this.stats?.count('Assets/LoadFailed');
        log.error(`failed to load ${entry.path}: ${error?.message ?? error}`);
        assetEvents.onFailed.broadcast(entry, error, this);
        return null;
      } finally {
        entry.promise = null;
      }
    })();
    return entry.promise;
  }

  /** Loads and returns a hard handle — the ergonomic path when you are going to hold the asset. */
  async loadHandle(path, options = {}) {
    if (!this.has(path)) return null;
    this.retain(path);
    const data = await this.load(path, options);
    if (data === null && this.get(path)?.state === AssetState.Failed) {
      this.release(path);
      return null;
    }
    return new AssetHandle(this, normalizePath(path));
  }

  /** Loads an asset's dependencies first (dependency-ordered load for a level bundle). */
  async loadDependencies(path, { recursive = true, seen = new Set() } = {}) {
    const entry = this.get(path);
    if (!entry) return [];
    const results = [];
    for (const dependency of entry.dependencies) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      results.push(await this.load(dependency));
      if (recursive) results.push(...(await this.loadDependencies(dependency, { recursive, seen })));
    }
    return results;
  }

  /** Loads every path in a bundle, honoring bundle dependencies and streaming through the queue. */
  async loadBundle(name, { concurrency = null, progress = null } = {}) {
    const bundle = this.bundles.get(name);
    if (!bundle) return null;
    if (concurrency !== null) this.queue.concurrency = Math.max(1, concurrency);
    return bundle.load({ concurrency: this.queue.concurrency, progress });
  }

  loadAll(paths, { concurrency = null, progress = null } = {}) {
    const bundle = new AssetBundle(this, `ad-hoc:${++adHocCounter}`, { assets: paths });
    if (concurrency !== null) this.queue.concurrency = Math.max(1, concurrency);
    return bundle.load({ concurrency: this.queue.concurrency, progress });
  }

  /**
   * Streams a set of paths in the background with a byte budget per call — the "load the next area
   * while the player looks at this one" pass. Call it once per frame from a job.
   */
  stream(paths, { byteBudget = 16 * 1024 * 1024, maxPerFrame = 8 } = {}) {
    let started = 0;
    let bytes = 0;
    for (const path of paths) {
      if (started >= maxPerFrame || bytes >= byteBudget) break;
      const entry = this.get(path);
      if (!entry || entry.state !== AssetState.Registered) continue;
      bytes += entry.size;
      started++;
      // Smaller assets first: the queue is max-priority, and a 2 MB texture finishing early is
      // worth more than a 40 MB one starting early.
      this.queue.push(() => this.load(path), -entry.size);
    }
    void this.queue.drain();
    return { started, bytes };
  }

  // ------------------------------------------------------------------ derived data
  /**
   * Caches a runtime derivative (compressed texture, cooked mesh, nav mesh) so it is computed once.
   * `registry.derive(path, 'navmesh', () => buildNav(...))`.
   */
  derive(path, key, factory) {
    const entry = this.get(path);
    if (!entry) return null;
    if (entry.derived.has(key)) return entry.derived.get(key);
    const value = factory(entry);
    entry.derived.set(key, value);
    return value;
  }

  invalidateDerived(path, key = null) {
    const entry = this.get(path);
    if (!entry) return false;
    if (key) return entry.derived.delete(key);
    entry.derived.clear();
    return true;
  }

  // ------------------------------------------------------------------ unloading
  /** Unloads one asset immediately (caller is responsible for having released its handles). */
  unload(path, { force = false } = {}) {
    const entry = this.get(path);
    if (!entry || entry.state !== AssetState.Loaded) return false;
    if (entry.hardRefs > 0 && !force) {
      log.warn(`refusing to unload referenced asset ${entry.path} (${entry.hardRefs} handles)`);
      return false;
    }
    entry.data = null;
    entry.state = AssetState.Registered;
    entry.derived.clear();
    this.loadedBytes = Math.max(0, this.loadedBytes - entry.size);
    this.stats?.count('Assets/Unloaded');
    assetEvents.onUnloaded.broadcast(entry, this);
    return true;
  }

  retry(path) {
    const entry = this.get(path);
    if (!entry) return false;
    if (entry.state === AssetState.Failed) { entry.state = AssetState.Registered; entry.error = null; }
    return true;
  }

  /**
   * Frees every loaded asset with no hard references. The engine core calls this from the garbage
   * collector's collection pass, so assets behave like objects: unused ones go away.
   */
  collectGarbage({ budgetBytes = Infinity } = {}) {
    const collected = [];
    let freed = 0;
    for (const entry of this.entries.values()) {
      if (!entry.loaded || entry.isReferenced) continue;
      if (freed + entry.size > budgetBytes) continue;
      if (this.unload(entry.path)) { collected.push(entry.path); freed += entry.size; }
    }
    const retained = this.entries.size - this.loadedCount();
    if (collected.length) assetEvents.onGarbageCollected.broadcast(collected, this);
    return { collected, freedBytes: freed, retained, loadedBytes: this.loadedBytes };
  }

  /** Everything loaded with a zero reference count — what the collector *could* free right now. */
  unreferenced() {
    return [...this.entries.values()].filter((entry) => entry.loaded && !entry.isReferenced).map((entry) => entry.path);
  }

  /** Transitively used-by index: which registered assets depend on this one. */
  dependentsOf(path, { recursive = false, seen = new Set() } = {}) {
    const direct = [...(this.dependents.get(normalizePath(path)) ?? [])];
    if (!recursive) return direct;
    const out = new Set(direct);
    for (const dependent of direct) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      for (const next of this.dependentsOf(dependent, { recursive, seen })) out.add(next);
    }
    return [...out];
  }

  /** Dependency closure of a path — everything needed to make it usable. */
  dependencyClosure(path, { seen = new Set() } = {}) {
    const out = new Set();
    const visit = (current) => {
      const entry = this.get(current);
      if (!entry) return;
      for (const dependency of entry.dependencies) {
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        out.add(dependency);
        visit(dependency);
      }
    };
    visit(path);
    return [...out];
  }

  _trackBytes(bytes) {
    if (Number.isFinite(bytes)) this.ioBytes += bytes;
  }

  get stats_() { return this.report(); }

  report() {
    const byType = {};
    for (const type of this.types.values()) byType[type.name] = { registered: 0, loaded: 0, bytes: 0 };
    let registered = 0;
    let loaded = 0;
    let unreferenced = 0;
    for (const entry of this.entries.values()) {
      registered++;
      const row = byType[entry.type] ?? (byType[entry.type] = { registered: 0, loaded: 0, bytes: 0 });
      row.registered++;
      if (entry.loaded) { loaded++; row.loaded++; row.bytes += entry.size; }
      if (entry.loaded && !entry.isReferenced) unreferenced++;
    }
    return {
      registered, loaded, unreferenced, failed: this.failedCount, loads: this.loadCount,
      loadedBytes: this.loadedBytes, peakLoadedBytes: this.peakLoadedBytes, ioBytes: this.ioBytes,
      bundles: [...this.bundles.values()].map((bundle) => bundle.describe()),
      byType,
      queue: this.queue.stats,
      misses: this.missLog.slice(-5),
    };
  }

  format() {
    const report = this.report();
    const lines = [
      `  ${this.name}: ${report.registered} registered · ${report.loaded} loaded (${formatBytes(report.loadedBytes)}) · ${report.unreferenced} unreferenced`,
      `  loads ${report.loads} · failures ${report.failed} · peak ${formatBytes(report.peakLoadedBytes)}`,
    ];
    for (const [name, row] of Object.entries(report.byType)) {
      if (!row.registered) continue;
      lines.push(`  ${name.padEnd(12)} ${String(row.loaded).padStart(4)}/${String(row.registered).padEnd(4)} ${formatBytes(row.bytes).padStart(9)}`);
    }
    return lines.join('\n');
  }

  /** Drops every asset and all metadata (engine shutdown, or a full content reload in the editor). */
  clear() {
    for (const entry of this.entries.values()) entry.data = null;
    this.entries.clear();
    this.dependents.clear();
    this.bundles.clear();
    this.bundle('default');
    this.loadedBytes = 0;
    return this;
  }
}

let adHocCounter = 0;

function normalizePath(path) {
  const value = String(path);
  return value.startsWith('/') ? value.replace(/\/+/g, '/') : `/${value}`;
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Default IO: `fetch` in the browser, `fs` in Node, and a deterministic "empty" fallback so a
 * headless test never reaches the network. Callers can pass any `(path, { binary }) => Promise` —
 * a CDN with manifest signatures, an encrypted pak reader, an in-memory test double.
 */
export async function defaultIO(path, { binary = true } = {}) {
  if (typeof fetch === 'function' && /^https?:|^\//.test(path)) {
    try {
      const response = await fetch(path);
      if (response.ok) return binary ? response.arrayBuffer() : response.text();
    } catch { /* fall through to the empty payload */ }
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      const { readFile } = await import('node:fs/promises');
      const buffer = await readFile(path);
      return binary ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer.toString('utf8');
    } catch { /* fall through */ }
  }
  return binary ? new ArrayBuffer(0) : '';
}

export default AssetRegistry;
