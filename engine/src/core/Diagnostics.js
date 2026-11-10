/**
 * OminX Engine — assertions, error codes and crash reporting.
 *
 * UE has three distinct ways to say "this should never happen": `check` (fatal, stripped in
 * shipping), `ensure` (non-fatal, reported once per call site, keeps the game running) and `verify`
 * (fatal, expression always evaluated). A web engine needs the same distinction plus a place where
 * *every* failure lands, because a browser tab has no crash dump and a headless server has no
 * developer watching the console.
 *
 * This module gives the core:
 *   - **One error type** (`EngineError`) with a stable `code`, severity, context and stack.
 *   - **A bounded error hub** that deduplicates repeated failures by call site, keeps counts and
 *     the last N records, broadcasts them to telemetry, and lets a host install a fatal handler
 *     (crash overlay, log upload, process exit).
 *   - **Guards and scopes** so a subsystem can wrap a risky call without losing the error.
 *   - **An error-code registry** with descriptions, so `E_ASSET_MISSING` means one thing everywhere.
 *
 * ```
 * check(actor != null, 'spawn needs an actor');                   // throws
 * ensure(weapon.ammo >= 0, 'negative ammo', { weapon });          // reports once, returns false
 * const value = guard(() => JSON.parse(text), { code: 'E_PARSE', fallback: {} });
 * diagnostics.setFatalHandler((error) => showCrashOverlay(error));
 * ```
 *
 * @module engine/src/core/Diagnostics
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Diagnostics');

export const DiagnosticLevel = Object.freeze({
  Info: 'info', Warning: 'warning', Error: 'error', Fatal: 'fatal',
});

const LEVEL_RANK = Object.freeze({ info: 0, warning: 1, error: 2, fatal: 3 });

/** Observable diagnostics. Delegates isolate listener errors — telemetry cannot mask a crash. */
export const diagnosticEvents = {
  onReport: new MulticastDelegate('diag.onReport'),
  onEnsure: new MulticastDelegate('diag.onEnsure'),
  onFatal: new MulticastDelegate('diag.onFatal'),
  onCleared: new MulticastDelegate('diag.onCleared'),
};

/** Every diagnostic failure, with a stable machine code. */
export class EngineError extends Error {
  constructor(code, message, { severity = DiagnosticLevel.Error, context = null, cause = null } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = String(code ?? 'E_UNKNOWN');
    this.severity = severity;
    this.context = context ?? {};
    this.cause = cause ?? null;
    this.timestamp = Date.now();
  }

  describe() {
    return {
      name: this.name, code: this.code, message: this.message, severity: this.severity,
      context: this.context, cause: this.cause?.message ?? null, stack: this.stack ?? null,
    };
  }
}

/** Registry of project-wide error codes, so a code has one description and one default level. */
const CODE_REGISTRY = new Map();

export function registerErrorCode(code, { description = '', level = DiagnosticLevel.Error, help = '' } = {}) {
  CODE_REGISTRY.set(String(code), { code: String(code), description, level, help });
  return CODE_REGISTRY.get(String(code));
}

export function getErrorCode(code) { return CODE_REGISTRY.get(String(code)) ?? null; }
export function listErrorCodes() { return [...CODE_REGISTRY.values()]; }

for (const [code, description, level] of [
  ['E_CHECK', 'A `check()` invariant was false.', DiagnosticLevel.Fatal],
  ['E_VERIFY', 'A `verify()` invariant was false.', DiagnosticLevel.Fatal],
  ['E_ENSURE', 'An `ensure()` invariant was false; execution continued.', DiagnosticLevel.Warning],
  ['E_FATAL', 'An unrecoverable error was reported.', DiagnosticLevel.Fatal],
  ['E_GUARD', 'A guarded call threw.', DiagnosticLevel.Error],
  ['E_BUDGET', 'A scoped operation exceeded its time budget.', DiagnosticLevel.Warning],
  ['E_PARSE', 'Text could not be parsed.', DiagnosticLevel.Error],
  ['E_ASSERT_NEVER', 'An exhaustive switch reached an impossible value.', DiagnosticLevel.Fatal],
  ['E_TEST', 'A diagnostic was injected from the console.', DiagnosticLevel.Error],
]) registerErrorCode(code, { description, level });

/** Expands `{0}`, `{name}` and `{}` placeholders without evaluating user code. */
export function formatMessage(template, args = null) {
  let index = 0;
  const values = Array.isArray(args) ? args : [args ?? {}];
  const bag = Array.isArray(args) ? args : (args ?? {});
  return String(template ?? '').replace(/\{(\w*)\}/g, (_match, key) => {
    if (key === '') return Array.isArray(args) ? String(values[index++] ?? '') : '{}';
    if (/^\d+$/.test(key)) return String(bag[Number(key)] ?? '');
    return String(bag?.[key] ?? `{${key}}`);
  });
}

/** Normalizes anything thrown (including strings and plain objects) into a plain record. */
export function describeError(error) {
  if (error instanceof EngineError) return error.describe();
  if (error instanceof Error) {
    return { name: error.name, code: error.code ?? 'E_UNKNOWN', message: error.message, severity: DiagnosticLevel.Error, context: {}, cause: null, stack: error.stack ?? null };
  }
  return { name: 'ThrownValue', code: 'E_UNKNOWN', message: String(error), severity: DiagnosticLevel.Error, context: {}, cause: null, stack: null };
}

/** Finds the first stack frame outside this module — the call site of an assertion. */
function captureSource(stack) {
  const lines = String(stack ?? '').split('\n').slice(1);
  const external = lines.find((line) => line.trim() && !line.includes('Diagnostics.js'));
  // File + line is a call site; the column is not. Dropping it makes `ensure()` inside a loop
  // report once per call site instead of once per column, which is what UE's ensure does.
  return (external ?? lines[0] ?? 'unknown').trim().replace(/:(\d+):\d+\)?$/, ':$1');
}

/**
 * The bounded error hub. `diagnostics` is a shared instance, but a host can create its own
 * (`new DiagnosticHub()`) and inject it into the engine for isolated tests or multiple worlds.
 */
export class DiagnosticHub {
  constructor({ name = 'Diagnostics', capacity = 256, minLevel = DiagnosticLevel.Info } = {}) {
    this.name = name;
    this.capacity = Math.max(1, Math.floor(capacity));
    this.minLevel = minLevel;
    this.records = [];
    this.counts = { info: 0, warning: 0, error: 0, fatal: 0 };
    this.byCode = new Map();
    this.ensureSites = new Map();
    this.total = 0;
    this.suppressed = 0;
    this.fatalHandler = null;
    this.stats = null;
  }

  static create(options) { return new DiagnosticHub(options); }

  /** Installs a host handler for fatal errors (crash overlay, log upload, process exit). */
  setFatalHandler(fn) {
    this.fatalHandler = typeof fn === 'function' ? fn : null;
    return this;
  }

  setMinLevel(level) {
    if (level in LEVEL_RANK) this.minLevel = level;
    return this;
  }

  /**
   * Records a diagnostic. Repeated identical failures (same code + call site) increment a count
   * instead of filling the buffer. Returns the record, or `null` when filtered by `minLevel`.
   */
  report({ level = DiagnosticLevel.Error, code = 'E_UNKNOWN', message = '', context = null, error = null, source = null, fatal = false } = {}) {
    const severity = LEVEL_RANK[level] === undefined ? DiagnosticLevel.Error : level;
    if (LEVEL_RANK[severity] < LEVEL_RANK[this.minLevel]) return null;
    const site = source ?? captureSource(error?.stack ?? new Error().stack);
    const key = `${code}|${site}`;
    const existing = this.records.find((record) => record.key === key);
    if (existing) {
      existing.count++;
      existing.lastAt = Date.now();
      this.counts[severity]++;
      this.total++;
      this.suppressed++;
      this.byCode.set(code, (this.byCode.get(code) ?? 0) + 1);
      diagnosticEvents.onReport.broadcast(existing, this);
      return existing;
    }
    const definition = getErrorCode(code);
    const record = {
      key, code, message: String(message ?? ''), severity,
      level: definition?.level ?? severity,
      context: context ?? {}, source: site, count: 1,
      firstAt: Date.now(), lastAt: Date.now(),
      stack: error?.stack ?? null, fatal: fatal || severity === DiagnosticLevel.Fatal,
    };
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.shift();
    this.counts[severity]++;
    this.total++;
    this.byCode.set(code, (this.byCode.get(code) ?? 0) + 1);
    this.stats?.count(`Diagnostics/${severity}`);
    const prefix = severity === DiagnosticLevel.Fatal ? 'FATAL' : severity.toUpperCase();
    const method = severity === DiagnosticLevel.Info ? 'info' : (severity === DiagnosticLevel.Warning ? 'warn' : 'error');
    log[method](`[${prefix}] ${code}: ${record.message} @ ${site}`);
    diagnosticEvents.onReport.broadcast(record, this);
    if (record.fatal) diagnosticEvents.onFatal.broadcast(record, this);
    return record;
  }

  /** `check()` failure: record and throw. */
  checkFailed(message, context = null, code = 'E_CHECK') {
    const error = new EngineError(code, String(message ?? 'check failed'), { severity: DiagnosticLevel.Fatal, context });
    this.report({ level: DiagnosticLevel.Fatal, code, message: error.message, context, error, fatal: true });
    if (this.fatalHandler) {
      try { this.fatalHandler(error); } catch (handlerError) { log.error(`fatal handler threw: ${handlerError?.message ?? handlerError}`); }
    }
    throw error;
  }

  /** `ensure()` failure: report once per call site, never throw. Returns `false`. */
  ensureFailed(message, context = null, { always = false } = {}) {
    const site = captureSource(new Error().stack);
    if (!always && this.ensureSites.has(site)) {
      this.ensureSites.set(site, this.ensureSites.get(site) + 1);
      this.suppressed++;
      return false;
    }
    this.ensureSites.set(site, 1);
    const record = this.report({
      level: DiagnosticLevel.Warning, code: 'E_ENSURE', message: String(message ?? 'ensure failed'),
      context, source: site,
    });
    diagnosticEvents.onEnsure.broadcast(record, site, this);
    return false;
  }

  /** Wraps a call, reporting anything it throws and returning `fallback`. */
  guard(fn, { code = 'E_GUARD', level = DiagnosticLevel.Error, fallback = undefined, context = null, rethrow = false } = {}) {
    try { return fn(); }
    catch (error) {
      this.report({ level, code, message: error?.message ?? String(error), context, error });
      if (rethrow) throw error;
      return fallback;
    }
  }

  async guardAsync(fn, options = {}) {
    try { return await fn(); }
    catch (error) {
      this.report({ level: options.level ?? DiagnosticLevel.Error, code: options.code ?? 'E_GUARD', message: error?.message ?? String(error), context: options.context ?? null, error });
      if (options.rethrow) throw error;
      return options.fallback;
    }
  }

  /** Measures an operation and reports a warning when it overruns its budget. Returns the value. */
  scope(name, fn, { budgetMs = 0, code = 'E_BUDGET', context = null } = {}) {
    const started = nowMs();
    try { return fn(); }
    catch (error) {
      this.report({ level: DiagnosticLevel.Error, code, message: `${name} threw: ${error?.message ?? error}`, context, error });
      throw error;
    } finally {
      const elapsed = nowMs() - started;
      if (budgetMs > 0 && elapsed > budgetMs) {
        this.report({ level: DiagnosticLevel.Warning, code, message: `${name} took ${elapsed.toFixed(2)} ms (budget ${budgetMs} ms)`, context });
      }
      this.lastScope = { name, ms: round3(elapsed) };
    }
  }

  clear() {
    const count = this.records.length;
    this.records.length = 0;
    this.byCode.clear();
    this.ensureSites.clear();
    this.counts = { info: 0, warning: 0, error: 0, fatal: 0 };
    this.total = 0;
    this.suppressed = 0;
    diagnosticEvents.onCleared.broadcast(count, this);
    return count;
  }

  describe() {
    return {
      name: this.name, capacity: this.capacity, minLevel: this.minLevel,
      total: this.total, suppressed: this.suppressed, counts: { ...this.counts },
      byCode: Object.fromEntries(this.byCode),
      fatalHandler: this.fatalHandler ? 'installed' : 'default',
      ensureSites: this.ensureSites.size, lastScope: this.lastScope ?? null,
      records: this.records.slice(-8).map((record) => ({ ...record })),
    };
  }

  format({ limit = 8 } = {}) {
    const lines = [
      `  ${this.name} — ${this.records.length}/${this.capacity} records · ${this.total} reports · ${this.suppressed} deduplicated`,
      `  info ${this.counts.info} · warning ${this.counts.warning} · error ${this.counts.error} · fatal ${this.counts.fatal} · min level ${this.minLevel}`,
    ];
    for (const record of this.records.slice(-Math.max(1, limit))) {
      lines.push(`  ${record.severity.padEnd(8)} ${record.code.padEnd(16)} ×${record.count}  ${record.message}`);
    }
    if (!this.records.length) lines.push('  (no diagnostics)');
    return lines.join('\n');
  }

  installConsoleCommands(console_) {
    const hub = this;
    console_.registerCommand({
      name: 'diag', aliases: ['diag.list'], category: 'Diagnostics', description: 'Error hub state and recent records.',
      execute: () => hub.format(),
    });
    console_.registerCommand({
      name: 'diag.errors', category: 'Diagnostics', description: 'Recent diagnostics as JSON.',
      args: [{ name: 'limit', type: 'int', min: 1, max: 256, required: false, default: 8 }],
      execute: (args) => JSON.stringify(hub.records.slice(-args.limit).map((record) => ({ code: record.code, message: record.message, severity: record.severity, count: record.count, source: record.source })), null, 2),
    });
    console_.registerCommand({
      name: 'diag.codes', category: 'Diagnostics', description: 'Registered error codes.',
      execute: () => listErrorCodes().map((entry) => `${entry.code.padEnd(18)} ${entry.level.padEnd(8)} ${entry.description}`).join('\n'),
    });
    console_.registerCommand({
      name: 'diag.level', category: 'Diagnostics', description: 'Sets the minimum recorded level.',
      args: [{ name: 'level', type: 'enum', values: ['info', 'warning', 'error', 'fatal'] }],
      execute: (args) => { hub.setMinLevel(args.level); return `min level = ${hub.minLevel}`; },
    });
    console_.registerCommand({
      name: 'diag.clear', category: 'Diagnostics', description: 'Clears recorded diagnostics.',
      execute: () => `cleared ${hub.clear()} records`,
    });
    console_.registerCommand({
      name: 'diag.throw', category: 'Diagnostics', description: 'Injects a test diagnostic (does not throw out of the console).',
      args: [{ name: 'message', required: false, default: 'diagnostic test' }],
      execute: (args) => {
        hub.report({ level: DiagnosticLevel.Error, code: 'E_TEST', message: args.message });
        return `reported E_TEST: ${args.message}`;
      },
    });
    return console_;
  }
}

/** The shared hub used by module-level helpers and by the engine unless a host injects its own. */
export const diagnostics = new DiagnosticHub();

// ------------------------------------------------------------------ module-level helpers

/** Fatal invariant. Throws `EngineError('E_CHECK')` when false. */
export function check(condition, message = 'check failed', context = null) {
  return condition ? true : diagnostics.checkFailed(formatMessage(message, context), context);
}

/** Fatal invariant with a formatted message: `checkf(x > 0, 'x={x}', { x })`. */
export function checkf(condition, template, args = null, context = null) {
  return condition ? true : diagnostics.checkFailed(formatMessage(template, args), context ?? (args && !Array.isArray(args) ? args : null));
}

/** Non-fatal invariant: reported once per call site, execution continues. Returns the condition. */
export function ensure(condition, message = 'ensure failed', context = null) {
  return condition ? true : diagnostics.ensureFailed(formatMessage(message, context), context);
}

/** Like `ensure`, but reported on every occurrence (a hot path that must stay visible). */
export function ensureAlways(condition, message = 'ensure failed', context = null) {
  return condition ? true : diagnostics.ensureFailed(formatMessage(message, context), context, { always: true });
}

/** Fatal invariant whose expression is always evaluated (JS evaluates both forms identically). */
export function verify(condition, message = 'verify failed', context = null) {
  return condition ? true : diagnostics.checkFailed(formatMessage(message, context), context, 'E_VERIFY');
}

/** Reports and throws an unrecoverable error directly. */
export function fatal(message, context = null, code = 'E_FATAL') {
  return diagnostics.checkFailed(formatMessage(message, context), context, code);
}

/** Exhaustiveness guard for discriminated unions. */
export function assertNever(value, message = 'unexpected value') {
  return diagnostics.checkFailed(`${message}: ${String(value)}`, { value }, 'E_ASSERT_NEVER');
}

export function warn(code, message, context = null) {
  return diagnostics.report({ level: DiagnosticLevel.Warning, code, message: formatMessage(message, context), context });
}

export function error(code, message, context = null) {
  return diagnostics.report({ level: DiagnosticLevel.Error, code, message: formatMessage(message, context), context });
}

export function guard(fn, options = {}) { return diagnostics.guard(fn, options); }
export function guardAsync(fn, options = {}) { return diagnostics.guardAsync(fn, options); }
export function scope(name, fn, options = {}) { return diagnostics.scope(name, fn, options); }

function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }
function nowMs() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

export default DiagnosticHub;
