/**
 * OminX Engine — script runtime.
 *
 * The engine's "code editor" backend. Scripts are small JS modules with a lifecycle
 * (`onStart` / `onTick` / `onEvent` / `onStop`) that can be attached to an instance, to the whole
 * scene or to the match. They are compiled with `new Function` into a sandbox object whose globals
 * are a deliberately narrow API — `instance`, `scene`, `engine`, `input`, `time`, `emit`, `find`,
 * `spawn`, `destroy`, `math`, `log` — so a script can drive gameplay without touching DOM or
 * network primitives directly.
 *
 * Failures are isolated per script: a throwing tick is caught, reported to the Studio console and
 * disabled after a few strikes instead of killing the frame (or the match).
 *
 * @module src/scripting/ScriptRuntime
 */
import { createLogger } from '../../engine/src/core/Logger.js';
import { Vector3 } from '../../engine/src/math/Vector3.js';
import { Quaternion } from '../../engine/src/math/Quaternion.js';
import { Matrix4 } from '../../engine/src/math/Matrix4.js';
import { RNG } from '../../engine/src/math/Random.js';
import * as MathUtils from '../../engine/src/math/MathUtils.js';
import { clamp01 } from '../../engine/src/math/MathUtils.js';

const log = createLogger('ScriptRuntime');

export const ScriptState = { New: 'new', Running: 'running', Error: 'error', Disabled: 'disabled', Stopped: 'stopped' };

/** Default source for a freshly created script — a working example, not a placeholder. */
export const DEFAULT_SCRIPT_SOURCE = `// OminX script — attached to an instance (or the scene root).
// Globals: instance, scene, engine, input, time, dt, emit, find, spawn, destroy, math, rng, log
//
// Lifecycle hooks are optional; define the ones you need.

let spin = 0;

export function onStart() {
  log.info(\`\${instance.Name} script started\`);
}

export function onTick(dt) {
  spin += dt * 0.6;
  instance.Rotation = math.Vector3.new(0, (spin * 180) / Math.PI, 0);
}

export function onEvent(name, payload) {
  if (name === 'damage' && payload?.amount) emit('flash', { intensity: 0.5 });
}
`;

let _scriptId = 0;

export class Script {
  /**
   * @param {object} opts `{ name, source, instance, enabled, rate }`
   */
  constructor(opts = {}) {
    this.id = opts.id ?? `script_${++_scriptId}`;
    this.name = opts.name ?? 'Script';
    this.source = opts.source ?? DEFAULT_SCRIPT_SOURCE;
    this.instance = opts.instance ?? null;
    this.enabled = opts.enabled !== false;
    this.rate = opts.rate ?? 0; // 0 = every frame
    this.state = this.enabled ? ScriptState.New : ScriptState.Disabled;
    this.error = null;
    this.strikes = 0;
    this.time = 0;
    this.tickCount = 0;
    this.hooks = {};
    this.module = null;
  }

  toJSON() {
    return { id: this.id, name: this.name, source: this.source, enabled: this.enabled, rate: this.rate, instancePath: this.instance?.getFullName?.() ?? null };
  }
}

export class ScriptRuntime {
  /**
   * @param {import('../app/Engine.js').Engine} engine
   * @param {object} [opts] `{ onOutput }` — Studio console sink
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.scripts = new Map();
    this.onOutput = opts.onOutput ?? null;
    this.maxStrikes = opts.maxStrikes ?? 5;
    this.globalScope = this._buildScope(null);
    this.enabled = true;
    this.started = false;
  }

  // ------------------------------------------------------------------ authoring
  /**
   * Creates (or replaces) a script.
   * @param {object} opts `{ name, source, instance }`
   */
  create(opts = {}) {
    const script = new Script(opts);
    this.scripts.set(script.id, script);
    if (opts.run !== false && script.enabled) this.compile(script);
    return script;
  }

  remove(idOrScript) {
    const script = typeof idOrScript === 'string' ? this.scripts.get(idOrScript) : idOrScript;
    if (!script) return false;
    this._callHook(script, 'onStop', []);
    this.scripts.delete(script.id);
    script.state = ScriptState.Stopped;
    return true;
  }

  get(id) { return this.scripts.get(id) ?? null; }
  list() { return [...this.scripts.values()]; }

  /** Replaces a script's source and hot-reloads it (the editor's "Run" button). */
  updateSource(id, source) {
    const script = this.scripts.get(id);
    if (!script) return null;
    script.source = source;
    script.error = null;
    script.strikes = 0;
    this.compile(script);
    return script;
  }

  setEnabled(id, enabled) {
    const script = this.scripts.get(id);
    if (!script) return false;
    script.enabled = !!enabled;
    script.state = script.enabled ? ScriptState.New : ScriptState.Disabled;
    if (script.enabled) this.compile(script);
    return true;
  }

  // ------------------------------------------------------------------ compilation
  /**
   * Compiles a script into hook functions. The wrapper turns the script's `export function`
   * declarations into plain function declarations so it can be evaluated without a module loader.
   */
  compile(script) {
    const previous = script.module;
    try {
      const body = script.source
        .replace(/^\s*import[^;]+;?/gm, '')
        .replace(/^\s*export\s+default\s+/gm, 'module.exports.default = ')
        .replace(/^\s*export\s+(function|class|const|let|var)\s+/gm, '$1 ')
        .replace(/\bexport\s+\{([^}]*)\}\s*;?/g, '');
      const factory = new Function(
        'sandbox',
        `"use strict";
         const { instance, scene, engine, input, time, dt, emit, find, spawn, destroy, math, rng, log, Vector3, Quaternion, Matrix4 } = sandbox;
         const module = { exports: {} };
         ${body}
         return { hooks: { onStart: typeof onStart === 'function' ? onStart : null, onTick: typeof onTick === 'function' ? onTick : null, onEvent: typeof onEvent === 'function' ? onEvent : null, onStop: typeof onStop === 'function' ? onStop : null }, exports: module.exports };
        `,
      );
      script.module = factory(this._buildScope(script));
      script.hooks = script.module.hooks;
      script.state = ScriptState.Running;
      script.error = null;
      if (previous && this.started) this._callHook(script, 'onStart', []);
      return script;
    } catch (error) {
      script.state = ScriptState.Error;
      script.error = error;
      script.hooks = {};
      this._report('error', `${script.name}: compile failed — ${error.message}`);
      return script;
    }
  }

  /** The globals every script sees. Deliberately small and free of DOM/network access. */
  _buildScope(script) {
    const engine = this.engine;
    const runtime = this;
    return {
      instance: script?.instance ?? engine?.scene ?? null,
      scene: engine?.scene ?? null,
      engine,
      input: engine?.input ?? null,
      time: 0,
      dt: 0,
      Vector3,
      Quaternion,
      Matrix4,
      math: {
        ...MathUtils,
        Vector3, Quaternion, Matrix4,
        Vector3new: Vector3.new,
        clamp01,
      },
      rng: new RNG(1337),
      log: {
        info: (message, ...rest) => runtime._report('info', `${script?.name ?? 'script'}: ${message}`, rest),
        warn: (message, ...rest) => runtime._report('warn', `${script?.name ?? 'script'}: ${message}`, rest),
        error: (message, ...rest) => runtime._report('error', `${script?.name ?? 'script'}: ${message}`, rest),
      },
      emit: (name, payload) => runtime._emit(script, name, payload),
      find: (name) => engine?.scene?.findFirstChild?.(name, true) ?? engine?.scene?.Workspace?.findFirstChild?.(name, true) ?? null,
      spawn: (propName, position, opts) => engine?.spawnProp?.(propName, position, opts) ?? null,
      destroy: (target) => target?.destroy?.() ?? engine?.scene?.removePart?.(target),
    };
  }

  // ------------------------------------------------------------------ execution
  start() {
    this.started = true;
    for (const script of this.scripts.values()) {
      if (script.enabled) this._callHook(script, 'onStart', []);
    }
    return this;
  }

  stop() {
    for (const script of this.scripts.values()) this._callHook(script, 'onStop', []);
    this.started = false;
    return this;
  }

  /** Per-frame update: ticks every enabled script. */
  update(dt) {
    if (!this.enabled) return this;
    const scene = this.engine?.scene;
    for (const script of this.scripts.values()) {
      if (!script.enabled || script.state === ScriptState.Disabled) continue;
      if (!script.hooks.onTick) continue;
      script.time += dt;
      if (script.rate > 0 && script.time - (script._lastTick ?? -Infinity) < 1 / script.rate) continue;
      script._lastTick = script.time;
      const scope = this._buildScope(script);
      scope.time = scene?.time ?? 0;
      scope.dt = dt;
      this._invoke(script, script.hooks.onTick, [dt, scope]);
      script.tickCount++;
    }
    return this;
  }

  /** Delivers an event to every script that defines `onEvent`. */
  fireEvent(name, payload) {
    for (const script of this.scripts.values()) {
      if (!script.enabled || !script.hooks.onEvent) continue;
      this._invoke(script, script.hooks.onEvent, [name, payload, this._buildScope(script)]);
    }
    return this;
  }
  _emit(script, name, payload) {
    for (const other of this.scripts.values()) {
      if (other === script || !other.enabled || !other.hooks.onEvent) continue;
      this._invoke(other, other.hooks.onEvent, [name, payload, this._buildScope(other)]);
    }
    this.engine?.Notice?.emit?.({ text: name, sub: '' });
    return this;
  }

  _callHook(script, hook, args) {
    if (!script.hooks?.[hook]) return;
    this._invoke(script, script.hooks[hook], [...args, this._buildScope(script)]);
  }

  _invoke(script, fn, args) {
    try {
      fn(...args);
      script.strikes = Math.max(0, script.strikes - 1);
    } catch (error) {
      script.strikes++;
      script.error = error;
      this._report('error', `${script.name}: ${error.message}`);
      if (script.strikes >= this.maxStrikes) {
        script.enabled = false;
        script.state = ScriptState.Error;
        this._report('error', `${script.name} disabled after ${script.strikes} errors`);
      }
    }
  }

  _report(level, message, rest = null) {
    if (level === 'error') log.error(message, ...(rest ?? []));
    else if (level === 'warn') log.warn(message, ...(rest ?? []));
    else log.info(message, ...(rest ?? []));
    this.onOutput?.({ level, message });
    return this;
  }

  // ------------------------------------------------------------------ persistence
  serialize() {
    return [...this.scripts.values()].map((script) => ({ ...script.toJSON(), instanceName: script.instance?.Name ?? null }));
  }

  /** Loads scripts from a project file and re-binds them to instances by name. */
  load(entries = []) {
    this.scripts.clear();
    for (const entry of entries) {
      const instance = entry.instanceName ? this.engine?.scene?.findFirstChild?.(entry.instanceName, true) ?? null : null;
      this.scripts.set(entry.id ?? `script_${++_scriptId}`, new Script({ ...entry, instance }));
    }
    for (const script of this.scripts.values()) if (script.enabled) this.compile(script);
    if (this.started) this.start();
    return this;
  }
}

export default ScriptRuntime;
