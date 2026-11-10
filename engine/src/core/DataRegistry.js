/**
 * OminX Engine — data tables and the data registry.
 *
 * A shooter is a pile of tuning data: weapon stats, damage falloff, bot difficulty, attachment
 * modifiers, map rotation, hit-location multipliers. Keeping those numbers in code means a rebuild
 * for every balance change; keeping them in loose JSON means no type checking and no fast lookup.
 * UE solves this with `UDataTable`/`DataRegistry`, and this is that shape for the web:
 *
 *   - **Tables** are keyed rows validated against a declared schema (`{ damage: 'f32', … }`) using
 *     the same field vocabulary as save slots and archive structs (`Schema.js`).
 *   - **CSV and JSON** are first-class import/export formats, so a designer can edit a spreadsheet
 *     and the engine can load the result without a code change.
 *   - **A registry** owns named tables, resolves lookups, tracks versions, and can load tables as
 *     assets from the `AssetRegistry` (streamable, deduplicated, collectible).
 *   - **Every change is observable** and every table exposes `describe()`/`format()` plus console
 *     commands, so a balance value can be inspected at runtime.
 *
 * ```
 * const weapons = registry.define('Weapons', { damage: 'f32', rpm: 'u16', name: 'string', tags: 'array:string' });
 * weapons.add('rifle', { damage: 24, rpm: 600, name: 'Rifle', tags: ['primary'] });
 * registry.lookup('Weapons', 'rifle').damage;      // → 24
 * registry.loadFromText('Weapons', csv, { format: 'csv' });
 * ```
 *
 * @module engine/src/core/DataRegistry
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';
import { validateObject, coerceObject, validateField, describeFieldTypes, isPlainObject } from './Schema.js';

const log = createLogger('Data');

export const dataEvents = {
  onTableRegistered: new MulticastDelegate('data.onTableRegistered'),
  onTableUnregistered: new MulticastDelegate('data.onTableUnregistered'),
  onTableChanged: new MulticastDelegate('data.onTableChanged'),
  onLoaded: new MulticastDelegate('data.onLoaded'),
  onError: new MulticastDelegate('data.onError'),
};

/** A keyed, schema-validated table of plain rows. */
export class DataTable {
  constructor({ name = 'Table', schema = {}, keyField = null, version = 1, metadata = null } = {}) {
    this.name = name;
    this.schema = Object.freeze({ ...schema });
    this.keyField = keyField;
    this.version = version;
    this.metadata = metadata ?? {};
    this.rows = new Map();
    this.lastErrors = [];
    this.changeCount = 0;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  static create(options) { return new DataTable(options); }

  get count() { return this.rows.size; }
  get columns() { return [this.keyField, ...Object.keys(this.schema)].filter(Boolean); }

  /** Adds or replaces one row. Returns the stored row, or `null` when validation fails. */
  add(key, data, { replace = true, validate = true } = {}) {
    const rowKey = String(key);
    if (!replace && this.rows.has(rowKey)) return null;
    const row = this.keyField ? { [this.keyField]: rowKey, ...data } : { ...data };
    if (validate) {
      const issues = validateObject(this.schema, row);
      if (issues.length) {
        this.lastErrors = issues.map((issue) => `${rowKey}: ${issue}`);
        log.warn(`table \"${this.name}\" rejected row \"${rowKey}\": ${issues[0]}`);
        dataEvents.onError.broadcast(this.name, this.lastErrors, this);
        return null;
      }
    }
    this.rows.set(rowKey, row);
    this.lastErrors = [];
    this.changeCount++;
    this.updatedAt = Date.now();
    dataEvents.onTableChanged.broadcast(this.name, { type: 'add', key: rowKey }, this);
    return row;
  }

  set(key, data, options = {}) { return this.add(key, data, options); }
  get(key) { return this.rows.get(String(key)) ?? null; }
  has(key) { return this.rows.has(String(key)); }
  remove(key) {
    const removed = this.rows.delete(String(key));
    if (removed) {
      this.changeCount++;
      dataEvents.onTableChanged.broadcast(this.name, { type: 'remove', key: String(key) }, this);
    }
    return removed;
  }
  keys() { return [...this.rows.keys()]; }
  all() { return [...this.rows.values()]; }

  /** Validates every row; returns `[]` when the table is clean. */
  validate() {
    const issues = [];
    for (const [key, row] of this.rows) {
      for (const issue of validateObject(this.schema, row)) issues.push(`${key}: ${issue}`);
    }
    this.lastErrors = issues;
    return issues;
  }

  /** `find(row => row.damage > 20)` — returns the first matching row. */
  find(predicate) {
    if (typeof predicate !== 'function') return null;
    for (const row of this.rows.values()) if (predicate(row)) return row;
    return null;
  }

  /**
   * `query({ where: { type: 'primary' }, sort: { field: 'damage', descending: true }, limit })`.
   * `where` may also be a predicate; `sort` may also be a comparator.
   */
  query({ where = null, sort = null, limit = Infinity, offset = 0 } = {}) {
    let rows = this.all();
    if (typeof where === 'function') rows = rows.filter(where);
    else if (isPlainObject(where)) rows = rows.filter((row) => Object.entries(where).every(([field, value]) => row[field] === value));
    if (typeof sort === 'function') rows.sort(sort);
    else if (isPlainObject(sort) && sort.field) {
      const direction = sort.descending ? -1 : 1;
      rows.sort((a, b) => compare(a[sort.field], b[sort.field]) * direction);
    }
    return rows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  }

  /** Structural diff against another table (`{ added, removed, changed }` key lists). */
  diff(other) {
    const added = [];
    const removed = [];
    const changed = [];
    for (const key of this.keys()) {
      if (!other.has(key)) { added.push(key); continue; }
      if (JSON.stringify(this.get(key)) !== JSON.stringify(other.get(key))) changed.push(key);
    }
    for (const key of other.keys()) if (!this.has(key)) removed.push(key);
    return { added, removed, changed };
  }

  clone(name = this.name) {
    const copy = new DataTable({ name, schema: this.schema, keyField: this.keyField, version: this.version, metadata: this.metadata });
    for (const [key, row] of this.rows) copy.rows.set(key, { ...row });
    return copy;
  }

  // ------------------------------------------------------------------ I/O
  toJSON() {
    return {
      format: 'ominx-table', name: this.name, version: this.version,
      keyField: this.keyField, schema: { ...this.schema }, metadata: { ...this.metadata },
      rows: this.rows.size ? Object.fromEntries(this.rows) : {},
    };
  }

  /** Loads a `toJSON()` object/string. `merge: false` replaces all rows. Returns `{ loaded, errors }`. */
  fromJSON(input, { merge = false } = {}) {
    let data;
    try { data = typeof input === 'string' ? JSON.parse(input) : input; }
    catch (error) { return this._fail(`invalid table JSON: ${error?.message ?? error}`); }
    if (data?.format !== 'ominx-table' || !isPlainObject(data.rows)) return this._fail('not an OminX table');
    if (!merge) this.rows.clear();
    if (data.schema && !merge) {
      // A table loaded with its own schema adopts it (row types travel with the data).
      this.schema = Object.freeze({ ...data.schema });
      this.keyField = data.keyField ?? null;
      this.version = data.version ?? this.version;
    }
    return this._loadRows(Object.entries(data.rows));
  }

  /** RFC-4180-ish CSV: quoted fields, escaped `""`, `#` comments, CRLF, one header row. */
  toCsv() {
    const columns = Object.keys(this.schema).length ? Object.keys(this.schema) : (this.all()[0] ? Object.keys(this.all()[0]) : []);
    const header = [this.keyField ?? 'key', ...columns.filter((column) => column !== this.keyField)];
    const lines = [header.join(',')];
    for (const [key, row] of this.rows) {
      lines.push(header.map((column) => csvEscape(column === (this.keyField ?? 'key') ? key : row[column])).join(','));
    }
    return lines.join('\n');
  }

  /** Imports CSV text, coercing every column through the schema. Returns `{ loaded, errors }`. */
  fromCsv(text, { merge = false, delimiter = ',' } = {}) {
    const grid = parseCsv(String(text ?? ''), delimiter);
    if (!grid.length) return this._fail('empty CSV');
    const header = grid[0].map((column) => column.trim());
    const keyColumn = this.keyField && header.includes(this.keyField) ? this.keyField : header[0];
    const columns = header.filter((column) => column !== keyColumn);
    if (!merge) this.rows.clear();
    let loaded = 0;
    const errors = [];
    for (let i = 1; i < grid.length; i++) {
      const cells = grid[i];
      if (!cells.length || (cells.length === 1 && !String(cells[0]).trim())) continue;
      const key = String(cells[header.indexOf(keyColumn)] ?? '').trim();
      if (!key) { errors.push(`row ${i + 1}: missing key`); continue; }
      const raw = {};
      columns.forEach((column, index) => { raw[column] = cells[header.indexOf(column)]; });
      const schemaForRow = {};
      for (const column of columns) schemaForRow[column] = this.schema[column] ?? 'json';
      const { value, errors: parseErrors } = coerceObject(schemaForRow, raw);
      if (parseErrors.length) { errors.push(`row ${i + 1} (${key}): ${parseErrors.join(', ')}`); continue; }
      const row = this.keyField ? { [this.keyField]: key, ...value } : value;
      const issues = validateObject(this.schema, row);
      if (issues.length) { errors.push(`row ${i + 1} (${key}): ${issues.join(', ')}`); continue; }
      this.rows.set(key, row);
      loaded++;
    }
    this.lastErrors = errors;
    this.changeCount++;
    this.updatedAt = Date.now();
    if (errors.length) { log.warn(`table \"${this.name}\" CSV import had ${errors.length} bad row(s)`); dataEvents.onError.broadcast(this.name, errors, this); }
    dataEvents.onTableChanged.broadcast(this.name, { type: 'csv', loaded }, this);
    dataEvents.onLoaded.broadcast(this.name, loaded, 'csv', this);
    return { loaded, errors };
  }

  _loadRows(entries) {
    let loaded = 0;
    const errors = [];
    for (const [key, row] of entries) {
      const candidate = this.keyField ? { [this.keyField]: key, ...row } : { ...row };
      const issues = validateObject(this.schema, candidate);
      if (issues.length) { errors.push(`${key}: ${issues.join(', ')}`); continue; }
      this.rows.set(String(key), candidate);
      loaded++;
    }
    this.lastErrors = errors;
    this.changeCount++;
    if (errors.length) dataEvents.onError.broadcast(this.name, errors, this);
    dataEvents.onTableChanged.broadcast(this.name, { type: 'json', loaded }, this);
    dataEvents.onLoaded.broadcast(this.name, loaded, 'json', this);
    return { loaded, errors };
  }

  _fail(message) {
    this.lastErrors = [message];
    log.error(`table \"${this.name}\": ${message}`);
    dataEvents.onError.broadcast(this.name, [message], this);
    return { loaded: 0, errors: [message] };
  }

  describe() {
    return {
      name: this.name, version: this.version, keyField: this.keyField,
      rows: this.rows.size, columns: Object.keys(this.schema), schema: { ...this.schema },
      changes: this.changeCount, updatedAt: this.updatedAt,
      issues: this.lastErrors.length,
    };
  }

  format({ limit = 8 } = {}) {
    const columns = Object.keys(this.schema);
    const lines = [`  ${this.name} — ${this.rows.size} rows · v${this.version} · ${columns.length} columns · ${this.changeCount} changes`];
    lines.push(`  ${(this.keyField ?? 'key').padEnd(16)} ${columns.join(' ')}`);
    for (const [key, row] of [...this.rows].slice(0, limit)) {
      lines.push(`  ${String(key).padEnd(16)} ${columns.map((column) => String(row[column] ?? '')).join(' ')}`);
    }
    if (!this.rows.size) lines.push('  (empty)');
    return lines.join('\n');
  }
}

/** Owns named tables, resolves lookups and loads table assets. */
export class DataRegistry {
  constructor({ name = 'Data', version = 1, assetRegistry = null } = {}) {
    this.name = name;
    this.version = version;
    this.assetRegistry = assetRegistry;
    this.tables = new Map();
    this.sources = new Map();
    this.loadedCount = 0;
    this.lastErrors = [];
  }

  static create(options) { return new DataRegistry(options); }

  get count() { return this.tables.size; }
  names() { return [...this.tables.keys()]; }

  /** Registers a `DataTable` or creates one from `{ schema, keyField, rows, csv, json }`. */
  register(name, tableOrOptions = {}) {
    let table;
    if (tableOrOptions instanceof DataTable) {
      table = tableOrOptions;
      table.name = String(name);
    } else {
      const { schema = {}, keyField = null, version = 1, rows = null, csv = null, json = null, metadata = null } = tableOrOptions;
      table = new DataTable({ name: String(name), schema, keyField, version, metadata });
      if (csv) table.fromCsv(csv);
      else if (json) table.fromJSON(json);
      else if (rows) for (const [key, row] of Object.entries(rows)) table.add(key, row);
    }
    const replaced = this.tables.has(String(name));
    this.tables.set(String(name), table);
    dataEvents.onTableRegistered.broadcast(String(name), table, replaced, this);
    return table;
  }

  /** Creates an empty typed table in one call. */
  define(name, schema, options = {}) { return this.register(name, { schema, ...options }); }

  unregister(name) {
    const removed = this.tables.delete(String(name));
    this.sources.delete(String(name));
    if (removed) dataEvents.onTableUnregistered.broadcast(String(name), this);
    return removed;
  }

  get(name) { return this.tables.get(String(name)) ?? null; }
  has(name) { return this.tables.has(String(name)); }

  lookup(tableName, key) {
    const table = this.get(tableName);
    return table ? table.get(key) : null;
  }

  query(tableName, query = {}) {
    const table = this.get(tableName);
    return table ? table.query(query) : [];
  }

  /** Registers a lazily-loaded table source (`loader` returns CSV/JSON text or a table object). */
  registerSource(name, { loader, format = 'csv', schema = null, keyField = null } = {}) {
    if (typeof loader !== 'function') throw new TypeError('registerSource() needs a loader function');
    this.sources.set(String(name), { name: String(name), loader, format, schema, keyField });
    return this;
  }

  /** Loads one registered source (or an asset path) and registers/replaces its table. */
  async load(name, { assetPath = null } = {}) {
    const source = this.sources.get(String(name));
    const format = source?.format ?? 'json';
    const loader = source?.loader ?? (assetPath && this.assetRegistry ? () => this.assetRegistry.load(assetPath) : null);
    if (!loader) { this.lastErrors = [`no source or asset for \"${name}\"`]; return null; }
    try {
      const content = await loader();
      // A string that does not open with `{` is CSV even when the host forgot to declare it.
      const resolved = typeof content === 'string' && !content.trim().startsWith('{') ? 'csv' : format;
      let table = this.get(name);
      if (content instanceof DataTable) table = this.register(name, content);
      else if (table) {
        if (resolved === 'csv') table.fromCsv(content);
        else table.fromJSON(content);
      } else {
        const parsed = typeof content === 'string' && resolved === 'json' ? JSON.parse(content) : content;
        table = this.register(name, {
          schema: source?.schema ?? parsed?.schema ?? {},
          keyField: source?.keyField ?? parsed?.keyField ?? null,
          json: resolved === 'json' ? parsed : null,
          csv: resolved === 'csv' ? content : null,
        });
      }
      this.loadedCount++;
      dataEvents.onLoaded.broadcast(String(name), table.count, resolved, this);
      return table;
    } catch (error) {
      this.lastErrors = [`load \"${name}\" failed: ${error?.message ?? error}`];
      log.error(this.lastErrors[0]);
      dataEvents.onError.broadcast(String(name), this.lastErrors, this);
      return null;
    }
  }

  /** Loads every registered source in insertion order. */
  async loadAll() {
    const results = [];
    for (const name of this.sources.keys()) results.push({ name, table: await this.load(name) });
    return results;
  }

  /** Imports text into a named table, creating it from a schema if needed. */
  loadFromText(name, text, { format = 'csv', schema = {}, keyField = null, merge = false } = {}) {
    let table = this.get(name);
    if (!table) table = this.register(name, { schema, keyField });
    const result = format === 'csv' ? table.fromCsv(text, { merge }) : table.fromJSON(text, { merge });
    this.loadedCount++;
    return result;
  }

  /** Validates every table: `{ total, byTable: { name: [issues] } }`. */
  validate() {
    const byTable = {};
    let total = 0;
    for (const [name, table] of this.tables) {
      const issues = table.validate();
      if (issues.length) { byTable[name] = issues; total += issues.length; }
    }
    return { total, byTable };
  }

  /** Portable export of every table; `importAll()` restores it. */
  exportAll() {
    return JSON.stringify({ format: 'ominx-data', version: this.version, tables: Object.fromEntries([...this.tables].map(([name, table]) => [name, table.toJSON()])) });
  }

  importAll(text, { merge = false } = {}) {
    let data;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; }
    catch (error) { this.lastErrors = [`invalid data export: ${error?.message ?? error}`]; return 0; }
    if (data?.format !== 'ominx-data') { this.lastErrors = ['not an OminX data export']; return 0; }
    let imported = 0;
    for (const [name, payload] of Object.entries(data.tables ?? {})) {
      const table = this.register(name, { schema: payload.schema ?? {}, keyField: payload.keyField ?? null, version: payload.version ?? 1 });
      table.fromJSON(payload, { merge });
      imported++;
    }
    return imported;
  }

  describe() {
    return {
      name: this.name, version: this.version, tables: this.names(),
      rows: [...this.tables.values()].reduce((sum, table) => sum + table.count, 0),
      sources: [...this.sources.keys()], loaded: this.loadedCount,
      assetRegistry: this.assetRegistry ? 'bound' : 'none',
      issues: this.validate().total, fieldTypes: describeFieldTypes().types.length,
    };
  }

  format() {
    const lines = [`  ${this.name} — ${this.tables.size} tables · ${[...this.tables.values()].reduce((sum, table) => sum + table.count, 0)} rows · ${this.loadedCount} loads`];
    for (const [name, table] of this.tables) {
      lines.push(`  ${name.padEnd(20)} ${String(table.count).padStart(5)} rows  v${table.version}  ${Object.keys(table.schema).length} columns`);
    }
    if (!this.tables.size) lines.push('  (no tables)');
    const issues = this.validate().total;
    if (issues) lines.push(`  ${issues} validation issue(s)`);
    return lines.join('\n');
  }

  installConsoleCommands(console_) {
    const registry = this;
    console_.registerCommand({
      name: 'data', aliases: ['data.tables'], category: 'Data', description: 'Data registry tables and row counts.',
      execute: () => registry.format(),
    });
    console_.registerCommand({
      name: 'data.get', category: 'Data', description: 'Reads one row (or all rows) as JSON.',
      args: [{ name: 'table' }, { name: 'key', required: false }],
      execute: (args) => {
        const table = registry.get(args.table);
        if (!table) return `no table \"${args.table}\"`;
        return JSON.stringify(args.key ? table.get(args.key) : table.all(), null, 2);
      },
    });
    console_.registerCommand({
      name: 'data.query', category: 'Data', description: 'Queries rows with field=value filters.',
      args: [{ name: 'table' }, { name: 'filter', required: false }],
      execute: (args) => {
        const table = registry.get(args.table);
        if (!table) return `no table \"${args.table}\"`;
        const where = {};
        for (const part of String(args.filter ?? '').split(',').filter(Boolean)) {
          const [field, value] = part.split('=');
          if (field) where[field] = coerceValue(value);
        }
        return JSON.stringify(table.query({ where }), null, 2);
      },
    });
    console_.registerCommand({
      name: 'data.csv', category: 'Data', description: 'Prints a table as CSV.',
      args: [{ name: 'table' }],
      execute: (args) => registry.get(args.table)?.toCsv() ?? `no table \"${args.table}\"`,
    });
    console_.registerCommand({
      name: 'data.validate', category: 'Data', description: 'Validates every table.',
      execute: () => {
        const report = registry.validate();
        return report.total ? JSON.stringify(report.byTable, null, 2) : `all ${registry.count} tables valid`;
      },
    });
    return console_;
  }
}

// ------------------------------------------------------------------ helpers

function compare(a, b) {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function coerceValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const number = Number(value);
  return value !== '' && Number.isFinite(number) ? number : value;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Minimal RFC-4180 parser: quotes, escaped quotes, CRLF, `#` comment lines. */
export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { row.push(cell); cell = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((entry) => entry.trim()) && !String(row[0]).trim().startsWith('#')) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((entry) => entry.trim()) && !String(row[0]).trim().startsWith('#')) rows.push(row);
  }
  return rows;
}

export { validateField };
export default DataRegistry;
