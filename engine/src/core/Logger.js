/**
 * OminX Engine — logging with channels, ring buffer, and in-editor console support.
 * @module engine/core/Logger
 */
import { Signal } from './Signal.js';

export const LogLevel = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, NONE: 5 };
const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
const LEVEL_STYLE = ['#8a8f98', '#6ea8fe', '#7ee787', '#e3b341', '#ff7b72'];

export class Logger {
  constructor(name = 'OminX') {
    this.name = name;
    this.level = LogLevel.INFO;
    this.buffer = [];
    this.bufferLimit = 2000;
    this.onLog = new Signal('Logger.onLog');
    this.counts = [0, 0, 0, 0, 0];
    this.channels = new Map();
    this.timers = new Map();
  }
  child(name) {
    const l = new Logger(`${this.name}.${name}`);
    l.level = this.level;
    l.onLog = this.onLog;
    l.buffer = this.buffer;
    return l;
  }
  setLevel(level) {
    this.level = typeof level === 'string' ? LogLevel[level.toUpperCase()] ?? LogLevel.INFO : level;
    return this;
  }
  _record(level, args) {
    this.counts[level]++;
    if (level < this.level) return;
    const entry = { level, levelName: LEVEL_NAMES[level], channel: this.name, args, time: performance.now(), date: new Date() };
    this.buffer.push(entry);
    if (this.buffer.length > this.bufferLimit) this.buffer.splice(0, this.buffer.length - this.bufferLimit);
    this.onLog.emit(entry);
    const logger = typeof console !== 'undefined' ? console : null;
    if (!logger) return;
    const tag = `%c[${entry.levelName}] ${this.name}`;
    const style = `color:${LEVEL_STYLE[level]};font-weight:600`;
    if (level >= LogLevel.ERROR) logger.error(tag, style, ...args);
    else if (level === LogLevel.WARN) logger.warn(tag, style, ...args);
    else if (level === LogLevel.DEBUG || level === LogLevel.TRACE) logger.debug(tag, style, ...args);
    else logger.log(tag, style, ...args);
  }
  trace(...a) { this._record(LogLevel.TRACE, a); }
  debug(...a) { this._record(LogLevel.DEBUG, a); }
  info(...a) { this._record(LogLevel.INFO, a); }
  log(...a) { this.info(...a); }
  warn(...a) { this._record(LogLevel.WARN, a); }
  error(...a) { this._record(LogLevel.ERROR, a); }
  /** Convenience wrapper so errors always have a stack. */
  exception(err, context = '') {
    const msg = err instanceof Error ? `${context ? `${context}: ` : ''}${err.message}\n${err.stack}` : `${context}${String(err)}`;
    this._record(LogLevel.ERROR, [msg]);
    return err;
  }
  assert(condition, message) {
    if (!condition) this._record(LogLevel.ERROR, [`Assertion failed: ${message}`]);
    return condition;
  }
  group(label, fn) {
    this.debug(`▼ ${label}`);
    try { fn(); } finally { this.debug(`▲ ${label}`); }
  }
  /** Performance timing helper: start('physics') … end('physics') logs elapsed ms. */
  start(label) { this.timers.set(label, performance.now()); return this; }
  end(label) {
    const t0 = this.timers.get(label);
    if (t0 === undefined) return 0;
    const dt = performance.now() - t0;
    this.timers.delete(label);
    this.debug(`${label} took ${dt.toFixed(2)}ms`);
    return dt;
  }
  table(label, data) {
    this.info(label, data);
  }
  getStats() { return { counts: this.counts, bufferSize: this.buffer.length }; }
  clear() { this.buffer.length = 0; return this; }
  /** Export the console buffer as plain text (editor "Copy log" button). */
  dump() {
    return this.buffer.map((e) => `[${e.levelName}] [${e.channel}] ${e.args.map(fmtArg).join(' ')}`).join('\n');
  }
}

function fmtArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export const logger = new Logger('OminX');

/** Every channel handed out by `createLogger`, so a global level change reaches all of them. */
const channels = new Set();

export function createLogger(name) {
  const channel = logger.child(name);
  channels.add(channel);
  return channel;
}

/**
 * Sets the level for the root logger *and* every channel created so far. Children copy the level
 * at creation time, so setting only the root would leave already-imported modules chatty — which is
 * how `--quiet` ended up not being quiet, and how log lines polluted machine-readable stdout.
 */
/** Current root log level, as a lowercase name (Config seeds its `log.level` key from this). */
export function getLogLevel() {
  const name = Object.entries(LogLevel).find(([, value]) => value === logger.level)?.[0] ?? 'INFO';
  return name.toLowerCase();
}

export function setLogLevel(level) {
  logger.setLevel(level);
  for (const channel of channels) channel.setLevel(level);
  return logger;
}

export default logger;
