/**
 * OminX Engine — plugins.
 *
 * A engine that ships every feature in one binary cannot be extended, tested in isolation, or
 * shipped in slices. A plugin is a self-describing unit of optional functionality with its own
 * content, settings, modules and subsystems — UE's `.uplugin`, applied to a web target where the
 * "binary" is an ES module and the "mount point" is a content path.
 *
 * ```
 * plugins.register({
 *   name: 'Arena',
 *   contentRoot: '/Game/Arena',
 *   modules: [{ name: 'arena', load: () => import('./ArenaModule.js') }],
 *   settings: { 'arena.roundTime': { default: 300 } },
 *   dependencies: [{ name: 'CoreWeapons', version: '>=1.0.0' }],
 * });
 * await plugins.loadAll({ engine });
 * ```
 *
 * Load order is a dependency graph, not a file order: a plugin that needs another plugin's weapons
 * is initialized after it, cycles are reported instead of deadlocking, and disabling a plugin
 * disables everything that depends on it — or explicitly refuses, depending on the policy. Content
 * is mounted under the plugin's own root so two plugins can both ship `Arena.map` without colliding.
 *
 * @module engine/src/core/Plugin
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Plugins');

export const PluginState = {
  Registered: 'registered',
  Loading: 'loading',
  Loaded: 'loaded',
  Started: 'started',
  Failed: 'failed',
  Disabled: 'disabled',
  Shutdown: 'shutdown',
};

export const PluginTarget = { Client: 'client', Server: 'server', Both: 'both', Editor: 'editor' };

export const pluginEvents = {
  onRegistered: new MulticastDelegate('plugins.onRegistered'),
  onEnabled: new MulticastDelegate('plugins.onEnabled'),
  onDisabled: new MulticastDelegate('plugins.onDisabled'),
  onLoaded: new MulticastDelegate('plugins.onLoaded'),
  onStarted: new MulticastDelegate('plugins.onStarted'),
  onFailed: new MulticastDelegate('plugins.onFailed'),
  onShutdown: new MulticastDelegate('plugins.onShutdown'),
};

/** The declaration half of a plugin: everything the engine needs to know without running any code. */
export class PluginDescriptor {
  constructor(options = {}) {
    if (!options.name) throw new Error('PluginDescriptor needs a name');
    this.name = options.name;
    this.friendlyName = options.friendlyName ?? options.name;
    this.version = options.version ?? '0.1.0';
    this.category = options.category ?? 'Gameplay';
    this.description = options.description ?? '';
    this.author = options.author ?? '';
    this.enabledByDefault = options.enabledByDefault !== false;
    this.target = options.target ?? PluginTarget.Both;
    this.dependencies = (options.dependencies ?? []).map((dependency) => (typeof dependency === 'string' ? { name: dependency } : dependency));
    /** Modules to register with the ModuleManager (each may be lazy and phase-tagged). */
    this.modules = options.modules ?? [];
    /** Subsystem classes to register with the SubsystemCollection. */
    this.subsystems = options.subsystems ?? [];
    /** Console commands contributed by the plugin. */
    this.commands = options.commands ?? [];
    /** Localization tables, shipped as plugin content. */
    this.stringTables = options.stringTables ?? {};
    /** Additional config keys, declared with the same schema format as the engine's own. */
    this.settings = options.settings ?? {};
    /**
     * The plugin's own code. `load`/`startup`/`shutdown` may be functions, or `module` may be an
     * ES module specifier (or a function returning one) that is imported on demand — a plugin that
     * is never enabled never costs a network request.
     */
    this.module = options.module ?? null;
    this.load = options.load ?? null;
    this.startup = options.startup ?? null;
    this.shutdown = options.shutdown ?? null;
    this.contentRoot = options.contentRoot ?? `/Plugin/${options.name}`;
    this.contentManifest = options.contentManifest ?? null;
    this.assetBundles = options.assetBundles ?? [];
    this.metadata = { ...(options.metadata ?? {}) };
    this.tags = new Set(options.tags ?? []);
    this.enabled = this.enabledByDefault;
    this.state = this.enabledByDefault ? PluginState.Registered : PluginState.Disabled;
    this.loadMs = 0;
    this.error = null;
    this.exports = null;
    this.hooks = null;
    this.mountedAssets = [];
  }

  get isLoaded() { return this.state === PluginState.Loaded || this.state === PluginState.Started; }
  get requiresClient() { return this.target === PluginTarget.Client || this.target === PluginTarget.Both; }

  /** True when this plugin should load for the running target. */
  supportsTarget(target) {
    if (this.target === PluginTarget.Both) return true;
    if (target === PluginTarget.Editor) return true;
    return this.target === target;
  }

  describe() {
    return {
      name: this.name, version: this.version, state: this.state, enabled: this.enabled,
      target: this.target, category: this.category, description: this.description,
      dependencies: this.dependencies.map((dependency) => dependency.name),
      modules: this.modules.map((module) => module.name ?? '(anonymous)'),
      subsystems: this.subsystems.map((subsystem) => subsystem.TypeName ?? subsystem.name),
      contentRoot: this.contentRoot, loadMs: Math.round(this.loadMs * 100) / 100,
      error: this.error?.message ?? null,
    };
  }
}

/**
 * Owns the plugin set: registration, dependency resolution, loading, content mounting and teardown.
 * The host supplies the engine; a manager without one still resolves and reports (tooling, CI).
 */
export class PluginManager {
  constructor({ engine = null, target = null, policy = 'cascade' } = {}) {
    this.engine = engine;
    this.target = target ?? engine?.modules?.target ?? PluginTarget.Client;
    /** `cascade` disables dependents with their dependency; `refuse` keeps them and reports. */
    this.policy = policy;
    /** @type {Map<string, PluginDescriptor>} */
    this.plugins = new Map();
    this.loadOrder = [];
    this.errors = [];
    this.warnings = [];
    this.loadedCount = 0;
  }

  static create(options) { return new PluginManager(options); }

  get count() { return this.plugins.size; }

  // ------------------------------------------------------------------ registration
  register(options) {
    const descriptor = options instanceof PluginDescriptor ? options : new PluginDescriptor(options);
    if (this.plugins.has(descriptor.name)) log.debug(`plugin "${descriptor.name}" redefined`);
    this.plugins.set(descriptor.name, descriptor);
    pluginEvents.onRegistered.broadcast(descriptor, this);
    return descriptor;
  }

  unregister(name) {
    const descriptor = this.plugins.get(name);
    if (!descriptor) return false;
    if (descriptor.isLoaded) this.unload(name);
    this.plugins.delete(name);
    return true;
  }

  get(name) { return this.plugins.get(name) ?? null; }
  has(name) { return this.plugins.has(name); }
  /** Plugins that should run on this target, enabled or not. */
  forTarget(target = this.target) { return [...this.plugins.values()].filter((plugin) => plugin.supportsTarget(target)); }

  // ------------------------------------------------------------------ enable / disable
  /**
   * Enables a plugin, enabling (or refusing, per policy) whatever it depends on first. Enabling is
   * declarative: it does not load anything, it only changes what `loadAll` will pick up.
   */
  setEnabled(name, enabled) {
    if (!this._enabling) this._enabling = new Set();
    return this._setEnabled(name, enabled, this._enabling);
  }

  _setEnabled(name, enabled, visiting) {
    const descriptor = this.plugins.get(name);
    if (!descriptor) return false;
    if (descriptor.enabled === enabled) return true;
    // Two plugins that (wrongly) depend on each other must not recurse forever while cascading.
    if (visiting.has(name)) return true;
    visiting.add(name);
    try {
      return this._applyEnabled(descriptor, name, enabled, visiting);
    } finally {
      visiting.delete(name);
    }
  }

  _applyEnabled(descriptor, name, enabled, visiting) {
    if (enabled) {
      for (const dependency of descriptor.dependencies) {
        const target = this.plugins.get(dependency.name);
        if (!target) {
          this.errors.push(`${name} requires missing plugin "${dependency.name}"`);
          log.error(`${name} requires missing plugin "${dependency.name}"`);
          return false;
        }
        if (!versionSatisfies(target.version, dependency.version)) {
          this.errors.push(`${name} requires ${dependency.name} ${dependency.version}, found ${target.version}`);
          return false;
        }
        if (!target.enabled && !this._setEnabled(target.name, true, visiting)) return false;
      }
    } else {
      const dependents = this.dependentsOf(name).filter((dependent) => dependent.enabled);
      if (dependents.length && this.policy === 'refuse') {
        this.errors.push(`cannot disable ${name}: required by ${dependents.map((plugin) => plugin.name).join(', ')}`);
        return false;
      }
      for (const dependent of dependents) {
        this.warnings.push(`disabling ${dependent.name} because it depends on ${name}`);
        this._setEnabled(dependent.name, false, visiting);
        if (dependent.isLoaded) void this.unload(dependent.name);
      }
      if (descriptor.isLoaded) this.unload(name);
    }
    descriptor.enabled = enabled;
    descriptor.state = enabled ? PluginState.Registered : PluginState.Disabled;
    (enabled ? pluginEvents.onEnabled : pluginEvents.onDisabled).broadcast(descriptor, this);
    return true;
  }

  enable(name) { return this.setEnabled(name, true); }
  disable(name) { return this.setEnabled(name, false); }

  /** Plugins that declared a dependency on this one. */
  dependentsOf(name) {
    return [...this.plugins.values()].filter((plugin) => plugin.dependencies.some((dependency) => dependency.name === name));
  }

  // ------------------------------------------------------------------ resolution
  /**
   * Dependency-ordered load order for the eligible plugins. Missing dependencies and cycles are
   * reported in `errors` and skipped instead of hanging the boot.
   */
  resolveOrder({ target = this.target, includeDisabled = false } = {}) {
    const eligible = [...this.plugins.values()].filter((plugin) => (includeDisabled || plugin.enabled) && plugin.supportsTarget(target));
    const order = [];
    const visiting = new Set();
    const visited = new Set();

    const visit = (plugin, trail) => {
      if (visited.has(plugin.name)) return;
      if (visiting.has(plugin.name)) {
        const cycle = [...trail, plugin.name].join(' → ');
        this.errors.push(`plugin dependency cycle: ${cycle}`);
        log.error(`plugin dependency cycle: ${cycle}`);
        return;
      }
      visiting.add(plugin.name);
      for (const dependency of plugin.dependencies) {
        const target_ = this.plugins.get(dependency.name);
        if (!target_) {
          if (!dependency.optional) this.errors.push(`${plugin.name} depends on missing plugin "${dependency.name}"`);
          continue;
        }
        if (!dependency.optional && !target_.enabled) {
          this.warnings.push(`${plugin.name} depends on disabled plugin "${dependency.name}"`);
          continue;
        }
        visit(target_, [...trail, plugin.name]);
      }
      visiting.delete(plugin.name);
      visited.add(plugin.name);
      order.push(plugin);
    };

    for (const plugin of eligible.sort((a, b) => a.name.localeCompare(b.name))) visit(plugin, []);
    this.loadOrder = order.map((plugin) => plugin.name);
    return order;
  }

  // ------------------------------------------------------------------ loading
  /**
   * Loads and starts every eligible plugin in dependency order: settings → content → modules →
   * subsystems → commands → `onLoad` → `onStartup`. A failing plugin is reported and skipped; the
   * rest of the engine boots regardless.
   */
  async loadAll(context = {}) {
    const engine = context.engine ?? this.engine;
    this.errors.length = 0;
    const order = this.resolveOrder({ target: context.target ?? this.target });
    const results = [];
    for (const descriptor of order) {
      // A plugin that cannot even resolve (missing or disabled dependency) is reported and skipped:
      // boot continues, and `describe()`/`errors` say exactly which plugin and why.
      try {
        results.push(await this.load(descriptor.name, { ...context, engine }));
      } catch (error) {
        descriptor.state = PluginState.Failed;
        descriptor.error = error;
        this.errors.push(`${descriptor.name}: ${error?.message ?? error}`);
        log.error(`plugin "${descriptor.name}" could not load: ${error?.message ?? error}`);
        pluginEvents.onFailed.broadcast(descriptor, error, this);
        results.push(descriptor);
      }
    }
    this.started = true;
    log.info(`plugins: ${this.loadedCount}/${order.length} loaded (${this.loadOrder.join(' → ') || 'none'})`);
    return results;
  }

  /**
   * Loads one plugin (and its dependencies on demand). Guarded against dependency cycles: a pair of
   * plugins that depend on each other reports one error instead of recursing until the stack dies.
   */
  async load(name, context = {}) {
    const descriptor = this.plugins.get(name);
    if (!descriptor) return null;
    const visiting = (context.visiting ??= new Set());
    if (visiting.has(name)) {
      const cycle = [...visiting, name].join(' → ');
      this.errors.push(`plugin dependency cycle while loading: ${cycle}`);
      log.error(`plugin dependency cycle while loading: ${cycle}`);
      return descriptor;
    }
    visiting.add(name);
    try {
      return await this._load(name, context);
    } finally {
      visiting.delete(name);
    }
  }

  async _load(name, context = {}) {
    const descriptor = this.plugins.get(name);
    if (!descriptor) return null;
    if (descriptor.isLoaded) return descriptor;
    // A failed plugin is not retried implicitly: its error is already reported, and re-running the
    // hook on every dependent's load would spam the log and hide the first failure. `reload()` is
    // the explicit retry.
    if (descriptor.state === PluginState.Failed) return descriptor;
    const engine = context.engine ?? this.engine;
    const startedAt = nowMs();

    for (const dependency of descriptor.dependencies) {
      const dependencyPlugin = this.plugins.get(dependency.name);
      if (!dependencyPlugin) throw new Error(`${name} requires missing plugin "${dependency.name}"`);
      if (dependencyPlugin.enabled && !dependencyPlugin.isLoaded && dependencyPlugin.state !== PluginState.Failed) {
        await this.load(dependencyPlugin.name, context);
      }
      // A dependent must never run on top of a broken dependency: that is how a plugin failure turns
      // into a confusing error three systems away.
      if (dependencyPlugin.state === PluginState.Failed) {
        descriptor.state = PluginState.Failed;
        descriptor.error = new Error(`dependency "${dependencyPlugin.name}" failed to load`);
        this.errors.push(`${name}: dependency "${dependencyPlugin.name}" failed to load`);
        log.error(`plugin "${name}" skipped — dependency "${dependencyPlugin.name}" failed`);
        pluginEvents.onFailed.broadcast(descriptor, descriptor.error, this);
        return descriptor;
      }
      if (!dependency.optional && !dependencyPlugin.enabled) {
        throw new Error(`${name} requires disabled plugin "${dependencyPlugin.name}"`);
      }
    }

    descriptor.state = PluginState.Loading;
    try {
      // 1. Settings: plugin config keys participate in the same layered config as the engine's.
      if (engine?.config && Object.keys(descriptor.settings).length) engine.config.defineMany(descriptor.settings);

      // 2. Content: the manifest is registered (metadata only) under the plugin's own root.
      if (engine?.assets) {
        const manifest = descriptor.contentManifest ?? [];
        for (const entry of manifest) {
          engine.assets.register(entry.path.startsWith('/') ? entry.path : `${descriptor.contentRoot}/${entry.path}`, {
            ...entry, source: `plugin:${descriptor.name}`, bundle: entry.bundle ?? `plugin:${descriptor.name}`,
          });
          descriptor.mountedAssets.push(entry.path);
        }
      }

      // 3. Modules: registered with the ModuleManager, so phases and hot reload still apply.
      if (engine?.modules) {
        for (const module of descriptor.modules) {
          engine.modules.register({
            ...module,
            name: module.name ?? descriptor.name,
            metadata: { ...(module.metadata ?? {}), plugin: descriptor.name },
          });
        }
      }

      // 4. Subsystems.
      if (engine?.subsystems) {
        for (const subsystem of descriptor.subsystems) engine.subsystems.register(subsystem, { plugin: descriptor.name });
      }

      // 5. Console commands (prefixed so `plugins` and `plugin` never collide).
      if (engine?.console) {
        for (const command of descriptor.commands) {
          engine.console.registerCommand({
            ...command,
            category: command.category ?? descriptor.category,
            execute: command.execute,
          });
        }
      }

      // 6. Localization tables.
      if (engine?.localization) {
        for (const [table, cultures] of Object.entries(descriptor.stringTables)) engine.localization.addTable(`${descriptor.name}/${table}`, cultures);
      }

      // 7. The plugin's own code: `load`/`startup`/`shutdown` hooks (dynamic imports welcome).
      const hooks = await resolveHooks(descriptor, context);
      descriptor.hooks = hooks;
      descriptor.exports = (await hooks?.load?.(createPluginContext(descriptor, engine, this))) ?? null;
      descriptor.state = PluginState.Loaded;
      descriptor.loadMs = nowMs() - startedAt;
      this.loadedCount++;
      pluginEvents.onLoaded.broadcast(descriptor, this);

      await hooks?.startup?.(createPluginContext(descriptor, engine, this), descriptor.exports);
      if (descriptor.state === PluginState.Loaded) descriptor.state = PluginState.Started;
      pluginEvents.onStarted.broadcast(descriptor, this);
      return descriptor;
    } catch (error) {
      descriptor.state = PluginState.Failed;
      descriptor.error = error;
      this.errors.push(`${name}: ${error?.message ?? error}`);
      log.error(`plugin "${name}" failed to load: ${error?.message ?? error}`);
      pluginEvents.onFailed.broadcast(descriptor, error, this);
      return descriptor;
    }
  }

  /** Starts a plugin that was loaded (startup is separated so load order can be inspected first). */
  async startup(name, context = {}) {
    const descriptor = this.plugins.get(name);
    if (!descriptor || !descriptor.isLoaded) return false;
    await descriptor.hooks?.startup?.(createPluginContext(descriptor, this.engine, this), descriptor.exports);
    descriptor.state = PluginState.Started;
    pluginEvents.onStarted.broadcast(descriptor, this);
    return true;
  }

  /** Unloads one plugin: content, modules and commands contributed by it are removed. */
  async unload(name, context = {}) {
    const descriptor = this.plugins.get(name);
    if (!descriptor || !descriptor.isLoaded) return false;
    // Dependents are unloaded first, and a cyclic dependency graph must not recurse forever.
    const visiting = (context.visiting ??= new Set());
    if (visiting.has(name)) return false;
    visiting.add(name);
    try {
      for (const dependent of this.dependentsOf(name)) {
        if (dependent.isLoaded) await this.unload(dependent.name, { visiting });
      }
    } finally {
      visiting.delete(name);
    }
    try {
      await descriptor.hooks?.shutdown?.(createPluginContext(descriptor, this.engine, this));
    } catch (error) {
      log.warn(`plugin "${name}" shutdown threw: ${error?.message ?? error}`);
    }
    const engine = this.engine;
    for (const module of descriptor.modules) engine?.modules?.unregister(module.name ?? descriptor.name);
    for (const command of descriptor.commands) engine?.console?.unregisterCommand(command.name);
    for (const path of descriptor.mountedAssets) {
      const assetPath = path.startsWith('/') ? path : `${descriptor.contentRoot}/${path}`;
      engine?.assets?.unload(assetPath);
      engine?.assets?.entries?.delete(assetPath);
    }
    descriptor.mountedAssets.length = 0;
    descriptor.state = PluginState.Shutdown;
    this.loadedCount = Math.max(0, this.loadedCount - 1);
    pluginEvents.onShutdown.broadcast(descriptor, this);
    return true;
  }

  /** Unloads everything in reverse load order (engine shutdown). */
  async shutdownAll() {
    for (let i = this.loadOrder.length - 1; i >= 0; i--) {
      const descriptor = this.plugins.get(this.loadOrder[i]);
      if (descriptor?.isLoaded) await this.unload(descriptor.name);
    }
    this.loadOrder = [];
    return this;
  }

  /**
   * Unload + load. This is also the *only* way to retry a failed plugin: `load()` deliberately
   * refuses to re-run a failed descriptor, so an editor's reload button and a `plugin.reload`
   * console command both come through here.
   */
  async reload(name, context = {}) {
    const descriptor = this.plugins.get(name);
    if (!descriptor) return null;
    await this.unload(name);
    descriptor.state = descriptor.enabled ? PluginState.Registered : PluginState.Disabled;
    descriptor.error = null;
    this.errors = this.errors.filter((entry) => !entry.startsWith(`${name}:`));
    return this.load(name, context);
  }

  // ------------------------------------------------------------------ reporting
  /** Boot report: state, dependencies and anything that went wrong. */
  describe() {
    return {
      target: this.target,
      policy: this.policy,
      count: this.count,
      loadOrder: [...this.loadOrder],
      plugins: [...this.plugins.values()].map((plugin) => plugin.describe()),
      errors: [...this.errors],
      warnings: [...this.warnings],
    };
  }

  format() {
    const lines = [`  ${this.count} plugins · target ${this.target} · ${this.loadedCount} loaded`, `  load order: ${this.loadOrder.join(' → ') || '(not resolved)'}`];
    for (const plugin of this.plugins.values()) {
      const state = plugin.enabled ? plugin.state : 'disabled';
      lines.push(`  ${plugin.name.padEnd(20)} ${plugin.version.padEnd(8)} ${state.padEnd(10)} ${plugin.modules.length} modules · ${plugin.mountedAssets.length} assets  ${plugin.description}`);
    }
    for (const warning of this.warnings) lines.push(`  ! ${warning}`);
    for (const error of this.errors) lines.push(`  ✗ ${error}`);
    return lines.join('\n');
  }

  /** Console commands to inspect and toggle plugins at runtime. */
  installConsoleCommands(console_) {
    const plugins = this;
    console_.registerCommand({
      name: 'plugins', category: 'Plugins', description: 'Lists plugins, their state and load order.',
      execute: () => plugins.format(),
    });
    console_.registerCommand({
      name: 'plugin.enable', category: 'Plugins', description: 'Enables a plugin (and its dependencies).',
      args: [{ name: 'name' }, { name: 'load', type: 'boolean', required: false, default: true }],
      execute: async (args) => {
        if (!plugins.enable(args.name)) return `could not enable "${args.name}": ${plugins.errors.at(-1) ?? 'unknown plugin'}`;
        if (args.load) await plugins.load(args.name, { engine: plugins.engine });
        return `${args.name} enabled (${plugins.get(args.name).state})`;
      },
    });
    console_.registerCommand({
      name: 'plugin.disable', category: 'Plugins', description: 'Disables a plugin and its dependents.',
      args: [{ name: 'name' }],
      execute: (args) => (plugins.disable(args.name) ? `${args.name} disabled` : `could not disable "${args.name}": ${plugins.errors.at(-1)}`),
    });
    console_.registerCommand({
      name: 'plugin.reload', category: 'Plugins', description: 'Unloads and reloads a plugin.',
      args: [{ name: 'name' }],
      execute: async (args) => { await plugins.reload(args.name, { engine: plugins.engine }); return `${args.name} reloaded (${plugins.get(args.name)?.state})`; },
    });
    console_.registerCommand({
      name: 'plugin.info', category: 'Plugins', description: 'Details for one plugin.',
      args: [{ name: 'name' }],
      execute: (args) => JSON.stringify(plugins.get(args.name)?.describe() ?? { error: `no plugin "${args.name}"` }, null, 2),
    });
    return console_;
  }
}

/** The context a plugin's own code receives: engine services plus its descriptor. */
export function createPluginContext(descriptor, engine, manager) {
  return {
    plugin: descriptor,
    engine,
    config: engine?.config ?? null,
    console: engine?.console ?? null,
    assets: engine?.assets ?? null,
    subsystems: engine?.subsystems ?? null,
    modules: engine?.modules ?? null,
    stats: engine?.stats ?? null,
    localization: engine?.localization ?? null,
    contentRoot: descriptor.contentRoot,
    log: createLogger(`Plugin.${descriptor.name}`),
    manager,
  };
}

/** Resolves a descriptor's hooks: inline functions, or a dynamic `import()` of the plugin module. */
async function resolveHooks(descriptor, context) {
  const hooks = {};
  if (descriptor.load) hooks.load = descriptor.load;
  if (descriptor.startup) hooks.startup = descriptor.startup;
  if (descriptor.shutdown) hooks.shutdown = descriptor.shutdown;
  if (descriptor.module) {
    const imported = await (typeof descriptor.module === 'function' ? descriptor.module(context) : import(descriptor.module));
    return {
      ...imported?.default ?? imported,
      ...hooks,
    };
  }
  return hooks;
}

/** Simple, predictable version comparison for dependency gates: `>=1.2`, `1.2.3`, `^1.0`. */
export function _versionSatisfies(version, requirement) {
  return versionSatisfies(version, requirement);
}

function versionSatisfies(version, requirement) {
  if (!requirement) return true;
  const parse = (text) => String(text).replace(/^[^\d]*/, '').split('.').map((part) => parseInt(part, 10) || 0);
  const [current, wanted] = [parse(version), parse(requirement)];
  const compare = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const left = a[i] ?? 0;
      const right = b[i] ?? 0;
      if (left !== right) return left > right ? 1 : -1;
    }
    return 0;
  };
  const operator = String(requirement).trim().match(/^(>=|<=|>|<|=|\^|~)?/)?.[1] ?? '';
  const diff = compare(current, wanted);
  switch (operator) {
    case '>=': return diff >= 0;
    case '<=': return diff <= 0;
    case '>': return diff > 0;
    case '<': return diff < 0;
    case '^': return diff >= 0 && current[0] === wanted[0];
    case '~': return diff >= 0 && current[0] === wanted[0] && (current[1] ?? 0) === (wanted[1] ?? 0);
    case '=': default: return diff === 0 || wanted.length === 0;
  }
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export default PluginManager;
