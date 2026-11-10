/**
 * OminX Engine — saved games and player state.
 *
 * "Save" is easy to add and expensive to get wrong: a slot written by a newer build, a write that
 * dies halfway, a profile that grows into an incompatibility, a player who quits during the save.
 * This is the small amount of machinery that avoids all four:
 *
 *   - **Slots** — named storage (a profile, a checkpoint, the last autosave), each written through
 *     a storage adapter (browser `localStorage` by default, in-memory in a test, anything else you
 *     plug in). Storage only has to be able to read, write, remove and list strings.
 *   - **Atomic writes** — a save goes to a staging key, is decoded back and verified (payload +
 *     checksum), then promoted, with the previous good value kept as a backup. A corrupt, partial
 *     or refused write leaves the previously saved value intact; a corrupt primary is recovered
 *     from the backup chain on load, so the worst case is "you lost the last few minutes".
 *   - **Versioned data with migrations** — the payload carries a version and a checksum; a save
 *     written by an older build is upgraded by registered migrations instead of failing.
 *   - **Autosave on the engine clock** — via `TimerManager`, so an autosave is a simulation event
 *     (pausable, rate-scaled, deterministic in a test) rather than a wall-clock cron. Rotated
 *     autosaves are re-headered with their own slot name, so every one of them is readable.
 *
 * ```
 * const saves = engine.saves;                       // or engine.createSaveSystem({ prefix: 'ominx' })
 * saves.defineSchema(3);
 * saves.registerSection('progress', { level: 'u8', score: 'u32', unlocked: 'array:string' });
 * saves.migrate(1, (save) => save.patch('progress', { level: 1 }));
 * saves.write('profile', { progress: { level: 4, score: 12900, unlocked: ['rifle'] } });
 * const progress = saves.readSlot('profile', 'progress');
 * saves.enableAutosave({ slot: 'auto', intervalSeconds: 60, collect: () => snapshotGame() });
 * ```
 *
 * @module engine/src/core/SaveGame
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';
import { ArchiveWriter, ArchiveReader, PayloadKind, defineStruct, getStruct } from './Archive.js';
import { validateField, isPlainObject } from './Schema.js';

const log = createLogger('Save');

/** Every observable save operation. Delegates isolate listener errors (a bad HUD cannot lose a save). */
export const saveEvents = {
  onSaved: new MulticastDelegate('save.onSaved'),
  onLoaded: new MulticastDelegate('save.onLoaded'),
  onDeleted: new MulticastDelegate('save.onDeleted'),
  onCorrupt: new MulticastDelegate('save.onCorrupt'),
  onMigrated: new MulticastDelegate('save.onMigrated'),
  onAutosave: new MulticastDelegate('save.onAutosave'),
};

/** The binary slot header. JSON slots carry the same fields as plain object keys. */
export const SaveSlotHeader = Object.freeze({
  slot: 'string', version: 'u16', savedAt: 'string', checksum: 'u32',
  player: 'string', map: 'string', playtime: 'f32', build: 'string',
  sections: 'string', payload: 'string',
});

/** Marker used when a binary record has to live in a string-only storage adapter. */
const BINARY_PREFIX = 'OMINXBIN1:';
const INTERNAL_KEY = /\.(bak|tmp)(\.\d+)?$/;
const HISTORY_KEY = /\.(\d+)$/;

/** A save in memory: header, sections, version and integrity data. */
export class SaveGame {
  constructor({ slot = 'default', version = 1, sections = {}, metadata = {} } = {}) {
    this.slot = slot;
    this.version = version;
    this.sections = { ...sections };
    this.metadata = { player: 'Player', map: 'unknown', playtimeSeconds: 0, build: '0.1.0', ...metadata };
    this.savedAt = null;
    this.checksum = 0;
    this.bytes = 0;
    /** Set when `read()` had to fall back to a backup. */
    this.recoveredFrom = null;
  }

  /** Adds or replaces a named section of game data. */
  set(name, data) { this.sections[name] = data; return this; }
  get(name, fallback = null) { return this.sections[name] ?? fallback; }
  has(name) { return Object.prototype.hasOwnProperty.call(this.sections, name); }
  remove(name) { delete this.sections[name]; return this; }

  /** Merges a nested patch into a section (progression updates that touch one field). */
  patch(name, changes) {
    this.sections[name] = { ...(this.sections[name] ?? {}), ...changes };
    return this;
  }

  describe() {
    return {
      slot: this.slot, version: this.version, savedAt: this.savedAt, bytes: this.bytes,
      checksum: this.checksum, sections: Object.keys(this.sections),
      metadata: { ...this.metadata }, recoveredFrom: this.recoveredFrom,
    };
  }

  format() {
    return [
      `  \"${this.slot}\" v${this.version} · ${this.bytes} B · ${this.savedAt ?? 'not saved'}`,
      `  player ${this.metadata.player ?? '?'} · map ${this.metadata.map ?? '?'} · ${this.metadata.playtimeSeconds ?? 0}s played`,
      `  sections: ${Object.keys(this.sections).join(', ') || '(none)'}`,
      this.recoveredFrom ? `  recovered from ${this.recoveredFrom}` : null,
    ].filter(Boolean).join('\n');
  }
}

/**
 * Storage adapters. The interface is four string operations: `read`, `write`, `remove`, `keys`.
 * Anything that can do those (localStorage, a Map, an HTTP API, a test double) works. `write`
 * returns `false` to refuse a write (quota exceeded, offline) — the save system treats that as a
 * failed write and leaves the previous slot untouched.
 */
export const SaveStorage = {
  /** Browser `localStorage` (falls back to memory when unavailable, e.g. a sandboxed iframe). */
  browser(storage = null) {
    const backing = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!backing) return SaveStorage.memory();
    return {
      name: 'localStorage',
      read: (key) => backing.getItem(key),
      write: (key, value) => {
        try { backing.setItem(key, typeof value === 'string' ? value : String(value)); return true; }
        catch { return false; }
      },
      remove: (key) => { backing.removeItem(key); return true; },
      keys: () => {
        if (typeof backing.key === 'function' && typeof backing.length === 'number') {
          const keys = [];
          for (let i = 0; i < backing.length; i++) { const key = backing.key(i); if (key != null) keys.push(key); }
          return keys;
        }
        return Object.keys(backing).filter((key) => typeof backing[key] === 'string');
      },
      snapshot: () => Object.fromEntries(
        Object.keys(backing).filter((key) => typeof backing[key] === 'string').map((key) => [key, backing.getItem(key)]),
      ),
    };
  },

  /** In-memory: tests, headless runs, a client with storage disabled. */
  memory(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
      name: 'memory',
      read: (key) => data.get(key) ?? null,
      write: (key, value) => { data.set(key, value); return true; },
      remove: (key) => data.delete(key),
      keys: () => [...data.keys()],
      snapshot: () => Object.fromEntries(data),
    };
  },
};

/**
 * Slot manager: read/write/list/delete, integrity checking, backups, migrations and autosave.
 * Owns the version rules for the project's save data.
 */
export class SaveSystem {
  constructor({
    storage = null, prefix = 'ominx', name = 'Saves', version = 1, backupSlots = 1,
    format = 'json', timerManager = null, autosave = null, strict = false,
  } = {}) {
    this.name = name;
    this.storage = storage ?? SaveStorage.browser();
    this.prefix = prefix;
    this.version = version;
    this.backupSlots = Math.max(0, Math.floor(backupSlots));
    /**
     * Record encoding. Deliberately *not* called `format`: `format()` is the human-readable report
     * every core service exposes, and an instance field with the same name shadows the method.
     */
    this.storageFormat = format === 'binary' ? 'binary' : 'json';
    this.strict = !!strict;
    this.timers = timerManager;
    /** @type {Map<number, (save: SaveGame, from: number) => void>} */
    this.migrations = new Map();
    /** Section schemas, used to validate typed sections before a write. */
    this.schemas = new Map();
    this.writeCount = 0;
    this.readCount = 0;
    this.corruptCount = 0;
    this.autosaveCount = 0;
    this.validationIssues = [];
    this.lastWriteMs = 0;
    this.lastError = null;
    this.autosaveTimer = null;
    this.autosaveOptions = autosave;
    this.ensureStructs();
    if (autosave) this.enableAutosave(autosave);
  }

  static create(options) { return new SaveSystem(options); }

  /** Declares the current data version. Saves older than this are upgraded by migrations. */
  defineSchema(version) { this.version = version; return this; }

  /** Registers a section's field layout: `{ level: 'u8', unlocked: 'array:string' }`. */
  registerSection(name, fields, { version = null } = {}) {
    this.schemas.set(name, { name, fields: { ...fields }, version });
    return this;
  }

  /** Registers an upgrade step: `saves.migrate(1, (save) => save.patch('progress', { level: 1 }))`. */
  migrate(fromVersion, fn) {
    this.migrations.set(fromVersion, fn);
    return this;
  }

  ensureStructs() {
    if (!getStruct('SaveSlotHeader')) defineStruct('SaveSlotHeader', SaveSlotHeader);
    return this;
  }

  // ------------------------------------------------------------------ keys
  keyFor(slot) { return `${this.prefix}.save.${slot}`; }
  backupKeyFor(slot, index = 0) { return index ? `${this.keyFor(slot)}.bak.${index}` : `${this.keyFor(slot)}.bak`; }
  stagingKeyFor(slot) { return `${this.keyFor(slot)}.tmp`; }
  /** Autosave history key: `<slot>.1`, `<slot>.2` … each holds a full, self-consistent record. */
  historyKeyFor(slot, index) { return `${this.keyFor(slot)}.${index}`; }

  /** Internal keys (staging + backups) never appear in a save-select list. */
  isInternalKey(key) { return INTERNAL_KEY.test(key); }
  isHistoryKey(key) { return !this.isInternalKey(key) && HISTORY_KEY.test(key); }

  /** All visible slot keys owned by this system, sorted. Rotated autosaves are visible too. */
  slotKeys() {
    const prefix = `${this.prefix}.save.`;
    return this.storage.keys()
      .filter((key) => key.startsWith(prefix) && !this.isInternalKey(key))
      .sort();
  }

  /** Storage is allowed to be string-only; binary records are wrapped in a marked binary string. */
  _encodeForStorage(raw) {
    if (!(raw instanceof Uint8Array)) return raw;
    return BINARY_PREFIX + Array.from(raw, (byte) => String.fromCharCode(byte)).join('');
  }

  _decodeFromStorage(raw) {
    if (typeof raw !== 'string' || !raw.startsWith(BINARY_PREFIX)) return raw;
    const text = raw.slice(BINARY_PREFIX.length);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }

  _store(key, raw) { return this.storage.write(key, this._encodeForStorage(raw)) !== false; }
  _load(key) { return this._decodeFromStorage(this.storage.read(key)); }

  // ------------------------------------------------------------------ writing
  /**
   * Writes a save to a slot. Sequence: resolve → validate → stage → verify → promote → back up.
   * A failure at any point leaves the previously saved value intact.
   *
   * `data` may be a `SaveGame`, a map of sections (`{ progress: {…} }`), or a single section's
   * value when `{ section: 'progress' }` is given.
   */
  write(slot, data, { metadata = null, section = null, validate = true } = {}) {
    const started = nowMs();
    let save;
    if (data instanceof SaveGame) {
      save = data;
      save.slot = slot;
      if (metadata) save.metadata = { ...save.metadata, ...metadata };
    } else {
      save = new SaveGame({ slot, version: this.version, metadata: metadata ?? {} });
      if (section) save.set(section, data ?? {});
      else if (isPlainObject(data)) save.sections = { ...data };
      else if (data != null) save.set('data', data);
    }

    try {
      if (validate) {
        const issues = this.validate(save.sections);
        this.validationIssues = issues;
        if (issues.length) {
          const message = `slot \"${slot}\" has ${issues.length} schema issue(s): ${issues[0]}`;
          if (this.strict) throw new Error(message);
          // Autosave writes the same shape every time; log the first occurrence of a problem, not
          // a warning per save for the lifetime of the process.
          const signature = `${slot}:${issues.join('|')}`;
          if (signature !== this._lastValidationKey) { this._lastValidationKey = signature; log.warn(message); }
        } else this._lastValidationKey = null;
      }
      const payload = this._serialize(save);
      save.checksum = checksumOf(payload);
      const record = {
        slot, version: save.version, savedAt: new Date().toISOString(), checksum: save.checksum,
        player: String(save.metadata.player ?? ''), map: String(save.metadata.map ?? ''),
        playtime: Number(save.metadata.playtimeSeconds ?? 0) || 0,
        build: String(save.metadata.build ?? ''),
        sections: JSON.stringify(Object.keys(save.sections)),
        payload,
      };
      const staged = this._encodeRecord(record);
      // `bytes` is the stored record size on both sides of a round-trip, not just the payload.
      save.bytes = typeof staged === 'string' ? staged.length : (staged.byteLength ?? 0);
      // Decode what we are about to promote. A truncated, refused or mis-typed write must not
      // replace a good save — this is the whole point of staging.
      const verified = this._decodeRecord(staged);
      if (verified.checksum !== record.checksum || verified.payload !== record.payload) {
        throw new Error('staged save failed verification');
      }
      if (!this._store(this.stagingKeyFor(slot), staged)) throw new Error('storage refused the staged write');

      // The primary write is the commit point. Everything before it is reversible; backups are
      // shifted *after* it succeeds, so a refused commit never damages the recovery chain.
      const previous = this._load(this.keyFor(slot));
      if (!this._store(this.keyFor(slot), staged)) throw new Error('storage refused the slot write');
      if (this.backupSlots > 0) this._backup(slot, previous, staged);
      this.storage.remove(this.stagingKeyFor(slot));

      save.savedAt = record.savedAt;
      this.writeCount++;
      this.lastWriteMs = nowMs() - started;
      this.lastError = null;
      saveEvents.onSaved.broadcast(save, record, this);
      log.debug(`saved \"${slot}\" — ${record.payload.length} B in ${this.lastWriteMs.toFixed(2)} ms`);
      return save;
    } catch (error) {
      this.lastError = error;
      log.error(`saving \"${slot}\" failed: ${error?.message ?? error}`);
      this.storage.remove(this.stagingKeyFor(slot));
      return null;
    }
  }

  /** Shifts the backup chain, then keeps the last known-good value at `.bak`. */
  _backup(slot, previous, staged) {
    // Only a *valid* previous value is worth keeping. On a first write (or when the primary was
    // already corrupt) the newly verified record becomes its own backup, so there is always a
    // recovery path after a single successful save.
    let candidate = staged;
    if (previous != null) {
      try {
        const record = this._decodeRecord(previous);
        if (record.payload != null && checksumOf(record.payload) === record.checksum) candidate = previous;
        else log.warn(`previous \"${slot}\" was invalid — keeping the new record as its backup`);
      } catch { log.warn(`previous \"${slot}\" was unreadable — keeping the new record as its backup`); }
    }
    for (let i = this.backupSlots - 1; i >= 1; i--) {
      const older = this._load(this.backupKeyFor(slot, i - 1));
      if (older != null) this._store(this.backupKeyFor(slot, i), older);
    }
    return this._store(this.backupKeyFor(slot), candidate);
  }

  // ------------------------------------------------------------------ reading
  /** Loads the record and its source without firing load events (used by `read`, `peek`, `exists`). */
  _loadRecord(slot, { quiet = false } = {}) {
    const primary = this._load(this.keyFor(slot));
    if (primary != null) {
      try {
        this._verifyRecord(primary, slot);
        return { raw: primary, source: 'primary' };
      } catch (error) {
        this.lastError = error;
        if (!quiet) {
          this.corruptCount++;
          log.error(`slot \"${slot}\" is corrupt (${error?.message ?? error}) — trying the backup`);
          saveEvents.onCorrupt.broadcast(slot, error, this);
        }
      }
    }
    for (let i = 0; i < this.backupSlots; i++) {
      const backup = this._load(this.backupKeyFor(slot, i));
      if (backup == null) continue;
      try {
        this._verifyRecord(backup, slot);
        if (!quiet) log.warn(`recovered \"${slot}\" from ${i ? `backup ${i}` : 'its backup'}`);
        return { raw: backup, source: i ? `backup.${i}` : 'backup' };
      } catch (error) {
        this.lastError = error;
        if (!quiet) {
          this.corruptCount++;
          log.error(`backup ${i} for \"${slot}\" is corrupt too: ${error?.message ?? error}`);
        }
      }
    }
    return null;
  }

  _decodeSafe(found, slot, { quiet = false } = {}) {
    try {
      const save = this._decode(found.raw, slot);
      save.recoveredFrom = found.source === 'primary' ? null : found.source;
      return save;
    } catch (error) {
      this.lastError = error;
      if (!quiet) {
        this.corruptCount++;
        log.error(`slot \"${slot}\" could not be decoded: ${error?.message ?? error}`);
        saveEvents.onCorrupt.broadcast(slot, error, this);
      }
      return null;
    }
  }

  /**
   * Reads a slot. Returns `null` when it does not exist; a corrupt slot falls back through the
   * backup chain and reports the corruption rather than returning half a profile.
   */
  read(slot) {
    const found = this._loadRecord(slot);
    if (!found) return null;
    const save = this._decodeSafe(found, slot);
    if (save) {
      this.readCount++;
      saveEvents.onLoaded.broadcast(save, this);
    }
    return save;
  }

  /** Reads without firing load events or incrementing the read counter (reports and save-select UI). */
  peek(slot) {
    const found = this._loadRecord(slot, { quiet: true });
    return found ? this._decodeSafe(found, slot, { quiet: true }) : null;
  }

  /** True when the slot exists and verifies (a "Continue" button). Does not fire load events. */
  exists(slot) { return this._loadRecord(slot) !== null; }

  /** Reads one section (with Maps/Sets revived), or `fallback` when the slot/section is absent. */
  readSlot(slot, name, fallback = null) {
    const save = this.read(slot);
    return save ? save.get(name, fallback) : fallback;
  }

  /** Patches one section of an existing slot and writes it back in one call. */
  writeSection(slot, name, data, { metadata = null } = {}) {
    const save = this.read(slot) ?? new SaveGame({ slot, version: this.version, metadata: metadata ?? {} });
    save.slot = slot;
    save.set(name, data);
    return this.write(slot, save, { metadata });
  }

  /** Deletes a slot, its staging key, its backup chain and (for a base slot) its autosave history. */
  remove(slot) {
    const existed = this._load(this.keyFor(slot)) != null;
    this.storage.remove(this.keyFor(slot));
    this.storage.remove(this.stagingKeyFor(slot));
    for (let i = 0; i < Math.max(1, this.backupSlots); i++) this.storage.remove(this.backupKeyFor(slot, i));
    if (!HISTORY_KEY.test(slot)) {
      const base = `${this.keyFor(slot)}.`;
      for (const key of this.storage.keys()) {
        if (key.startsWith(base) && (HISTORY_KEY.test(key) || INTERNAL_KEY.test(key))) this.storage.remove(key);
      }
    }
    if (existed) saveEvents.onDeleted.broadcast(slot, this);
    return existed;
  }

  /** Every save this system owns, newest first — a save-select screen's data. */
  list() {
    const prefix = `${this.prefix}.save.`;
    const rows = [];
    for (const key of this.slotKeys()) {
      const slot = key.slice(prefix.length);
      const save = this.peek(slot);
      const row = save
        ? { slot, exists: true, ...save.describe() }
        : { slot, exists: false, error: this.lastError?.message ?? 'unreadable' };
      row.history = this.isHistoryKey(key);
      rows.push(row);
    }
    return rows.sort((a, b) => String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')));
  }

  /** Verifies every slot without decoding game data — a startup integrity check. */
  verify() {
    const report = { checked: 0, ok: 0, corrupt: [] };
    const prefix = `${this.prefix}.save.`;
    for (const key of this.slotKeys()) {
      const slot = key.slice(prefix.length);
      report.checked++;
      try { this._verifyRecord(this._load(key), slot); report.ok++; }
      catch (error) { report.corrupt.push({ slot, error: error?.message ?? String(error) }); }
    }
    if (report.corrupt.length) log.warn(`save verification found ${report.corrupt.length} corrupt slot(s)`);
    return report;
  }

  // ------------------------------------------------------------------ schema validation
  /**
   * Checks a section map against `registerSection()` layouts. Returns human-readable issues; it
   * never throws. `strict: true` turns the first issue into a refused write.
   */
  validate(sections) {
    const issues = [];
    for (const [name, schema] of this.schemas) {
      const section = sections[name];
      if (section == null) { issues.push(`missing section \"${name}\"`); continue; }
      if (!isPlainObject(section)) { issues.push(`section \"${name}\" should be an object`); continue; }
      for (const [field, type] of Object.entries(schema.fields)) {
        if (!(field in section)) { issues.push(`${name}.${field} is missing`); continue; }
        const problem = validateField(type, section[field], `${name}.${field}`);
        if (problem) issues.push(problem);
      }
    }
    return issues;
  }

  // ------------------------------------------------------------------ migrations
  /** Upgrades a loaded save to the current version using the registered migrations. */
  applyMigrations(save) {
    if (save.version > this.version) {
      log.warn(`\"${save.slot}\" is v${save.version}, newer than this build's v${this.version} — loading read-only`);
      save.fromFuture = true;
      return save;
    }
    let version = save.version;
    const trail = [];
    while (version < this.version) {
      const migration = this.migrations.get(version);
      if (!migration) {
        log.warn(`no migration from version ${version} — the save stays at v${save.version}`);
        break;
      }
      migration(save, version);
      version++;
      trail.push(version);
    }
    if (trail.length) {
      save.version = version;
      saveEvents.onMigrated.broadcast(save, trail, this);
      log.info(`save \"${save.slot}\" migrated ${trail.join(' → ')}`);
    }
    return save;
  }

  // ------------------------------------------------------------------ autosave
  /** Whether an autosave timer is currently live. */
  get autosaveActive() { return !!this.autosaveTimer && (this.timers?.isActive(this.autosaveTimer) ?? false); }

  /**
   * Autosaves on the engine clock. `collect` returns a section map (or a `SaveGame`); the timer is
   * owned by the slot, so `stopAutosave()` is enough to stop it. `keep` rotated copies are kept as
   * `<slot>.1`, `<slot>.2` … each with its own slot header, so every one is readable.
   */
  enableAutosave({ slot = 'autosave', intervalSeconds = 60, collect = null, metadata = {}, keep = 3 } = {}) {
    if (!this.timers) {
      log.warn('autosave needs a TimerManager (engine.timers) — running without it');
      return null;
    }
    this.stopAutosave();
    this.autosaveOptions = { slot, intervalSeconds, collect, metadata, keep };
    this.autosaveTimer = this.timers.every(intervalSeconds, () => {
      const data = collect ? collect() : null;
      if (data == null) return;
      // Capture the previous value *before* the commit: history holds the saves this one replaced,
      // not a duplicate of the newest (which is what rotating after the write would produce).
      const previous = keep > 1 ? this._load(this.keyFor(slot)) : null;
      const save = this.writeSlot(slot, data, metadata);
      if (!save) return;
      if (keep > 1) this.rotate(slot, keep, previous);
      this.autosaveCount++;
      saveEvents.onAutosave.broadcast(slot, save, this);
    }, { name: `Autosave:${slot}`, category: 'save' });
    return this.autosaveTimer;
  }

  stopAutosave() {
    if (this.autosaveTimer) {
      this.autosaveTimer.clear();
      this.autosaveTimer = null;
    }
    if (this.autosaveOptions) this.autosaveOptions = { ...this.autosaveOptions, active: false };
    return this;
  }

  /**
   * Keeps `keep` previous autosaves as `<slot>.<index>`. `previous` is the record the newest
   * autosave replaced (pass `null` for a first write; omit it to rotate from the live primary).
   * Sources are read before any key is written (so shifting in place cannot overwrite a source),
   * and each copy is re-headered with its new slot name; otherwise `read('auto.1')` would reject
   * it as a slot mismatch.
   */
  rotate(slot, keep = 3, previous = undefined) {
    const count = Math.max(1, Math.floor(keep));
    const sources = new Map();
    sources.set(0, previous === undefined ? this._load(this.keyFor(slot)) : previous);
    for (let i = 1; i < count; i++) sources.set(i, this._load(this.historyKeyFor(slot, i)));
    // Drop history beyond the new limit.
    const base = `${this.keyFor(slot)}.`;
    for (const key of this.storage.keys()) {
      const match = key.startsWith(base) ? key.slice(base.length).match(/^(\d+)$/) : null;
      if (match && Number(match[1]) >= count) this.storage.remove(key);
    }
    for (let i = count - 1; i >= 1; i--) {
      const raw = sources.get(i - 1);
      if (raw == null) { this.storage.remove(this.historyKeyFor(slot, i)); continue; }
      try { this._store(this.historyKeyFor(slot, i), this._rekeyRecord(raw, `${slot}.${i}`)); }
      catch (error) { log.warn(`could not rotate \"${slot}\" to .${i}: ${error?.message ?? error}`); }
    }
    return this;
  }

  /** Writes a section map (or `SaveGame`) as a save in one call — the common path. */
  writeSlot(slot, sections, metadata = {}) {
    if (sections instanceof SaveGame) return this.write(slot, sections, { metadata });
    return this.write(slot, new SaveGame({ slot, version: this.version, sections, metadata }));
  }

  // ------------------------------------------------------------------ transfer
  /** Exports every visible slot as a portable JSON string (profile sync, bug reports). */
  exportAll() {
    const prefix = `${this.prefix}.save.`;
    const slots = [];
    for (const key of this.slotKeys()) {
      const raw = this._load(key);
      const slot = key.slice(prefix.length);
      try { this._verifyRecord(raw, slot); }
      catch { continue; } // a corrupt slot is never exported as if it were good
      slots.push({ slot, record: this._encodeForStorage(raw) });
    }
    return JSON.stringify({ format: 'ominx-saves', version: this.version, prefix: this.prefix, slots });
  }

  /** Imports slots produced by `exportAll()`; existing slots are kept unless `overwrite` is set. */
  importAll(text, { overwrite = false } = {}) {
    let data;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; }
    catch (error) { this.lastError = error; log.error(`save import failed: ${error?.message ?? error}`); return 0; }
    if (data?.format !== 'ominx-saves' || !Array.isArray(data.slots)) throw new Error('not an OminX save export');
    let imported = 0;
    for (const entry of data.slots) {
      if (!overwrite && this.exists(entry.slot)) continue;
      const raw = this._decodeFromStorage(entry.record);
      try { this._verifyRecord(raw, entry.slot); }
      catch (error) { log.warn(`skipping \"${entry.slot}\" in import: ${error?.message ?? error}`); continue; }
      if (this._store(this.keyFor(entry.slot), raw)) imported++;
    }
    return imported;
  }

  // ------------------------------------------------------------------ internals
  _serialize(save) {
    // Structured-clone-safe JSON: Maps and Sets become tagged objects so `read` restores them.
    return JSON.stringify({
      version: save.version,
      metadata: save.metadata,
      sections: save.sections,
    }, replacer);
  }

  _encodeRecord(record) {
    if (this.storageFormat === 'json') return JSON.stringify({ format: 'saveslot-json', ...record });
    this.ensureStructs();
    const writer = new ArchiveWriter({ kind: PayloadKind.Save, version: this.version });
    writer.section('slot', 'SaveSlotHeader', record);
    return writer.finish();
  }

  _decodeRecord(raw) {
    if (typeof raw === 'string' && raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      if (parsed.format !== 'saveslot-json') throw new Error('not a save slot');
      return parsed;
    }
    const reader = new ArchiveReader(raw);
    const record = reader.read('slot');
    if (!record) throw new Error('missing slot header');
    return record;
  }

  _verifyRecord(raw, slot) {
    if (raw == null) throw new Error('empty record');
    const record = this._decodeRecord(raw);
    if (record.slot && record.slot !== slot) throw new Error(`slot mismatch (${record.slot} vs ${slot})`);
    if (typeof record.payload !== 'string') throw new Error('missing payload');
    if (record.checksum && checksumOf(record.payload) !== record.checksum) {
      throw new Error(`checksum mismatch (stored ${record.checksum}, computed ${checksumOf(record.payload)})`);
    }
    return record;
  }

  /** Rewrites a record's slot header without touching the payload (used by autosave rotation). */
  _rekeyRecord(raw, slot) {
    const record = this._decodeRecord(raw);
    record.slot = slot;
    return this._encodeRecord(record);
  }

  _decode(raw, slot) {
    const record = this._verifyRecord(raw, slot);
    let data;
    try { data = JSON.parse(record.payload); }
    catch (error) { throw new Error(`payload is not valid JSON (${error?.message ?? error})`); }
    if (!isPlainObject(data)) throw new Error('payload root is not an object');
    const save = new SaveGame({
      slot,
      version: data.version ?? record.version ?? 1,
      sections: reviveSavedValue(data.sections ?? {}),
      metadata: { ...(reviveSavedValue(data.metadata ?? {})), playtimeSeconds: record.playtime ?? 0 },
    });
    save.savedAt = record.savedAt ?? null;
    save.checksum = record.checksum ?? 0;
    save.bytes = typeof raw === 'string' ? raw.length : (raw.byteLength ?? 0);
    if (save.version !== this.version) this.applyMigrations(save);
    return save;
  }

  describe() {
    return {
      name: this.name,
      storage: this.storage.name ?? 'custom',
      storageFormat: this.storageFormat,
      prefix: this.prefix,
      version: this.version,
      slots: this.list().map((row) => ({
        slot: row.slot, exists: row.exists, bytes: row.bytes, savedAt: row.savedAt,
        version: row.version, history: row.history,
      })),
      schemaSections: [...this.schemas.keys()],
      migrations: [...this.migrations.keys()],
      writes: this.writeCount,
      reads: this.readCount,
      corrupt: this.corruptCount,
      autosaves: this.autosaveCount,
      autosave: this.autosaveOptions ?? null,
      autosaveActive: this.autosaveActive,
      validationIssues: this.validationIssues.length,
      lastError: this.lastError?.message ?? null,
    };
  }

  /** Human-readable save list — the `save` console command. */
  format() {
    const rows = this.list();
    const lines = [`  ${this.name} (${this.storage.name ?? 'custom'}, ${this.storageFormat}, v${this.version}) — ${rows.length} slots · ${this.writeCount} writes · ${this.corruptCount} corrupt`];
    for (const row of rows) {
      const name = `${row.slot}${row.history ? ' (history)' : ''}`;
      lines.push(`  ${name.padEnd(24)} ${String(row.bytes ?? 0).padStart(8)} B  v${row.version ?? '?'}  ${row.savedAt ?? ''}  ${row.exists ? (row.metadata?.player ?? '') : `UNREADABLE: ${row.error}`}`);
    }
    if (!rows.length) lines.push('  (no saved games)');
    if (this.autosaveOptions && this.autosaveOptions.active !== false) {
      lines.push(`  autosave every ${this.autosaveOptions.intervalSeconds}s → \"${this.autosaveOptions.slot}\" · keep ${this.autosaveOptions.keep} · ${this.autosaveCount} written`);
    } else if (this.autosaveOptions) lines.push('  autosave off');
    if (this.lastError) lines.push(`  last error: ${this.lastError.message ?? this.lastError}`);
    return lines.join('\n');
  }

  /** Registers the save commands on a console. Called by the engine at boot or by a host directly. */
  installConsoleCommands(console_) {
    const saves = this;
    console_.registerCommand({
      name: 'save', aliases: ['save.list'], category: 'Saves',
      description: 'Saved-game slots with size, version, timestamp and integrity.',
      execute: () => saves.format(),
    });
    console_.registerCommand({
      name: 'save.write', category: 'Saves', description: 'Writes a slot from a JSON section map.',
      args: [{ name: 'slot' }, { name: 'json', required: false, default: '{}' }],
      execute: (args) => {
        let sections = {};
        try { sections = JSON.parse(args.json); } catch (error) { return `invalid json: ${error.message}`; }
        return saves.writeSlot(args.slot, sections) ? `wrote \"${args.slot}\"` : `write failed: ${saves.lastError?.message}`;
      },
    });
    console_.registerCommand({
      name: 'save.read', category: 'Saves', description: 'Reads a slot and prints its header.',
      args: [{ name: 'slot' }],
      execute: (args) => {
        const save = saves.read(args.slot);
        return save ? JSON.stringify(save.describe(), null, 2) : `no readable save in \"${args.slot}\"`;
      },
    });
    console_.registerCommand({
      name: 'save.delete', category: 'Saves', description: 'Deletes a slot, its backups and its history.',
      args: [{ name: 'slot' }],
      execute: (args) => (saves.remove(args.slot) ? `deleted \"${args.slot}\"` : `\"${args.slot}\" did not exist`),
    });
    console_.registerCommand({
      name: 'save.autosave', category: 'Saves', description: 'Starts or stops autosave (0 = off; needs a TimerManager).',
      args: [{ name: 'seconds', type: 'number', required: false, min: 0, max: 3600, default: 0 }],
      execute: (args) => {
        if (!args.seconds) { saves.stopAutosave(); return 'autosave off'; }
        const handle = saves.enableAutosave({
          slot: 'autosave', intervalSeconds: args.seconds,
          collect: () => ({ engine: { time: saves.timers?.time ?? 0 } }),
        });
        return handle ? `autosave every ${args.seconds}s` : 'autosave unavailable (no timer manager)';
      },
    });
    console_.registerCommand({
      name: 'save.verify', category: 'Saves', description: 'Checks every slot header and checksum.',
      execute: () => {
        const report = saves.verify();
        return `${report.ok}/${report.checked} slots ok${report.corrupt.length ? ` · corrupt: ${report.corrupt.map((row) => row.slot).join(', ')}` : ''}`;
      },
    });
    console_.registerCommand({
      name: 'save.export', category: 'Saves', description: 'Prints a portable JSON export of all valid slots.',
      execute: () => saves.exportAll(),
    });
    return console_;
  }
}

// ------------------------------------------------------------------ helpers

function replacer(key, value) {
  if (value instanceof Map) return { __type: 'Map', entries: [...value.entries()] };
  if (value instanceof Set) return { __type: 'Set', values: [...value.values()] };
  return value;
}

/** Restores Maps/Sets produced by `replacer` (used on every read, so a section is round-trip safe). */
export function reviveSavedValue(value) {
  if (value && typeof value === 'object') {
    if (value.__type === 'Map') return new Map(value.entries);
    if (value.__type === 'Set') return new Set(value.values);
    if (Array.isArray(value)) return value.map(reviveSavedValue);
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = reviveSavedValue(entry);
    return out;
  }
  return value;
}

/** FNV-1a over a string — cheap integrity, which is all a save needs (this is not security). */
export function checksumOf(text) {
  const value = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export default SaveSystem;
