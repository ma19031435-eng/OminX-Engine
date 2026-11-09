/**
 * OminX Engine — text and culture.
 *
 * Hard-coded strings are the single most expensive thing to remove later: they spread through
 * gameplay, HUD and error paths, and every one of them has to be found again by hand. This module
 * makes the localized path the *easy* path, UE style:
 *
 * ```
 * const { LOCTEXT, LT } = localization;
 * hud.setLabel(LOCTEXT('HUD', 'AmmoCounter', '{count} / {reserve}'));   // later: LT(text, { count: 24, reserve: 90 })
 * ```
 *
 *   - **Keys are structured**: namespace + key + the source text. The namespace keeps `Kills` in the
 *     scoreboard separate from `Kills` in a quest message, and the source text means an untranslated
 *     build still reads correctly in English instead of showing key names to players.
 *   - **Cultures with fallback**: `ar-AE → ar → en`. A translation gap degrades to the parent
 *     culture, then to the source text — never to an empty string.
 *   - **String tables**, loaded through the `AssetRegistry` (JSON or CSV), so content streaming,
 *     bundles and the GC all apply to text like any other asset.
 *   - **Plurals and selects** in a small ICU-compatible subset:
 *     `{count, plural, one {# kill} other {# kills}}`, `{gender, select, male {he} female {she} other {they}}`.
 *     Arabic plural rules are not English's, which is exactly why the rules live here and not in a
 *     `count === 1 ? … : …` at each call site.
 *   - **Culture-aware formatting** through `Intl` when the host has it, with a documented fallback
 *     for headless runs: numbers, percentages, dates, relative time, and list joining.
 *   - **Missing-key tracking** so a test can fail the build when a string is not translated, instead
 *     of a player finding it.
 *
 * @module engine/src/core/Localization
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Text');

export const localizationEvents = {
  onCultureChanged: new MulticastDelegate('loc.onCultureChanged'),
  onTableLoaded: new MulticastDelegate('loc.onTableLoaded'),
  onMissingText: new MulticastDelegate('loc.onMissingText'),
};

/** A localizable string: key + namespace + arguments. Immutable, cheap to hold in UI state. */
export class LocalizedText {
  constructor({ namespace = 'OminX', key, source = '', table = null, args = null, cultureInvariant = false } = {}) {
    if (!key) throw new Error('LocalizedText needs a key');
    this.namespace = namespace;
    this.key = key;
    this.source = source;
    this.table = table;
    this.args = args ? { ...args } : null;
    this.cultureInvariant = cultureInvariant;
    this.id = `${namespace}::${key}`;
  }

  /** A copy with different formatting arguments (`{count}` etc.). */
  withArgs(args) { return new LocalizedText({ ...this, args: { ...(this.args ?? {}), ...args } }); }

  /** The text as it should be displayed in the given language (defaults to the current culture). */
  toString(localization = LocalizedText.system) {
    if (this.cultureInvariant || !localization) return this.source;
    return localization.getText(this, this.args);
  }

  toJSON() {
    return { namespace: this.namespace, key: this.key, source: this.source, args: this.args, table: this.table };
  }

  static fromJSON(data) {
    return data instanceof LocalizedText ? data : new LocalizedText(data ?? {});
  }
}

/** Set by `createLocalization()` so `String(text)` works inside a renderer without plumbing. */
LocalizedText.system = null;

/** Shorthand used everywhere in the engine and gameplay: `LOCTEXT('HUD', 'Ammo', 'Ammo')`. */
export function LOCTEXT(namespace, key, source = '', args = null) {
  if (source && typeof source === 'object') { args = source; source = ''; }
  return new LocalizedText({ namespace, key, source: source ?? '', args });
}

/** Shorthand for table-driven text: `TABLE_TEXT('Weapons', 'Rifle.Name', 'Assault Rifle')`. */
export function TABLE_TEXT(table, key, source = '', args = null) {
  return new LocalizedText({ namespace: table, table, key, source, args });
}

/** Culture-invariant text (version strings, debug output) — never translated, never uppercase-mapped. */
export function INVARIANT_TEXT(text) {
  return new LocalizedText({ namespace: 'Invariant', key: `invariant:${text}`, source: String(text), cultureInvariant: true });
}

/** One language's strings for one namespace. `strings` maps key → translated text. */
export class StringTable {
  constructor(name, { cultures = {}, metadata = {} } = {}) {
    this.name = name;
    /** @type {Map<string, Map<string, string>>} culture → key → text */
    this.cultures = new Map();
    this.metadata = { ...metadata };
    this.loadedFrom = null;
    for (const [culture, entries] of Object.entries(cultures)) this.addCulture(culture, entries);
  }

  /** Adds/merges entries, which is also how a patch or DLC extends a shipped table. */
  addCulture(culture, entries) {
    if (!this.cultures.has(culture)) this.cultures.set(culture, new Map());
    const target = this.cultures.get(culture);
    for (const [key, value] of Object.entries(entries ?? {})) target.set(key, String(value));
    return this;
  }

  has(culture, key) { return this.cultures.get(culture)?.has(key) ?? false; }
  get(culture, key) { return this.cultures.get(culture)?.get(key) ?? null; }
  keys(culture = null) { return culture ? [...(this.cultures.get(culture)?.keys() ?? [])] : [...new Set([...this.cultures.values()].flatMap((entries) => [...entries.keys()]))]; }
  get cultureNames() { return [...this.cultures.keys()]; }

  /** Coverage report: per culture, how many keys are translated and which are missing. */
  coverage(keySet = null) {
    const keys = keySet ?? this.keys();
    const report = {};
    for (const [culture, entries] of this.cultures) {
      const missing = keys.filter((key) => !entries.has(key));
      report[culture] = { translated: keys.length - missing.length, total: keys.length, missing };
    }
    return report;
  }

  describe() { return { name: this.name, cultures: this.cultureNames, keys: this.keys().length }; }
}

/**
 * The localization system: culture management, string tables, lookups, formatting.
 */
export class Localization {
  constructor({ culture = 'en', fallbackCulture = 'en', name = 'Localization', assetRegistry = null, assetPath = '/Game/Localization' } = {}) {
    this.name = name;
    this.culture = culture;
    this.fallbackCulture = fallbackCulture;
    this.assets = assetRegistry;
    this.assetPath = assetPath;
    /** @type {Map<string, StringTable>} */
    this.tables = new Map();
    /** @type {Map<string, string>} inline overrides, keyed `namespace::key` (hot patch, tests) */
    this.overrides = new Map();
    this.missing = new Map();      // id → { key, namespace, culture, count }
    this.lookupCount = 0;
    this.hitCount = 0;
    this.registeredCultures = new Set([culture, fallbackCulture]);
    LocalizedText.system ??= this;
  }

  static create(options) { return new Localization(options); }

  // ------------------------------------------------------------------ cultures
  registerCulture(culture, { displayName = null, rightToLeft = null } = {}) {
    this.registeredCultures.add(culture);
    this.cultures ??= new Map();
    this.cultures.set(culture, { name: culture, displayName: displayName ?? culture, rightToLeft: rightToLeft ?? isRightToLeft(culture) });
    return this;
  }

  /** Culture metadata (display name, writing direction) — the UI reads this, not the tag. */
  cultureInfo(culture = this.culture) {
    this.cultures ??= new Map();
    return this.cultures.get(culture) ?? { name: culture, displayName: culture, rightToLeft: isRightToLeft(culture) };
  }

  get isRightToLeft() { return this.cultureInfo().rightToLeft; }
  get language() { return this.culture.split('-')[0]; }

  /** All cultures known to the system, including parents of registered ones. */
  get availableCultures() { return [...this.registeredCultures].sort(); }

  /**
   * Switches culture and tells the UI. `setCulture('ar-AE')` falls back to `ar`, then to the
   * fallback culture, then to source text.
   */
  setCulture(culture, { silent = false } = {}) {
    const next = normalizeCulture(culture);
    if (next === this.culture) return this;
    const previous = this.culture;
    this.culture = next;
    this.registeredCultures.add(next);
    if (!silent) localizationEvents.onCultureChanged.broadcast(next, previous, this);
    log.info(`culture ${previous} → ${next}`);
    return this;
  }

  /** The lookup chain: exact culture, parents, fallback culture, `en`. Duplicates removed. */
  cultureChain(culture = null) {
    const chain = [];
    let current = normalizeCulture(culture ?? this.culture);
    while (current) {
      if (!chain.includes(current)) chain.push(current);
      current = current.includes('-') ? current.slice(0, current.lastIndexOf('-')) : null;
    }
    for (const fallback of [this.fallbackCulture, 'en']) {
      if (fallback && !chain.includes(fallback)) chain.push(fallback);
    }
    return chain;
  }

  // ------------------------------------------------------------------ tables
  /** Registers (or extends) a string table. */
  addTable(name, cultures = {}, metadata = {}) {
    const table = this.tables.get(name) ?? new StringTable(name, { metadata });
    for (const [culture, entries] of Object.entries(cultures)) {
      // Entries may come pre-wrapped as `{ key: { text, comment } }` (a translator's tool export).
      const flat = {};
      for (const [key, value] of Object.entries(entries ?? {})) flat[key] = value && typeof value === 'object' ? (value.text ?? value.value ?? '') : value;
      table.addCulture(normalizeCulture(culture), flat);
    }
    this.tables.set(name, table);
    for (const culture of table.cultureNames) this.registeredCultures.add(culture);
    localizationEvents.onTableLoaded.broadcast(table, this);
    return table;
  }

  getTable(name) { return this.tables.get(name) ?? null; }

  /**
   * Loads a table through the asset registry (JSON `{ cultures: {...} }` or a CSV of
   * `key,culture,text`). This is the shipping path: tables stream like any other content.
   */
  async loadTable(name, { path = null } = {}) {
    if (!this.assets) return null;
    const assetPath = path ?? `${this.assetPath}/${name}.loc`;
    const data = await this.assets.load(assetPath);
    if (!data) return null;
    const parsed = parseTablePayload(data);
    const table = this.addTable(name, parsed.cultures, { source: assetPath, ...parsed.metadata });
    table.loadedFrom = assetPath;
    return table;
  }

  /** Registers a table from raw text (tests, embedded content, a CMS payload). */
  loadTableFromText(name, text) {
    const parsed = parseTablePayload(text);
    return this.addTable(name, parsed.cultures, parsed.metadata);
  }

  // ------------------------------------------------------------------ lookup
  /**
   * Resolves text: override → table (walking the culture chain) → source text. Every miss is
   * recorded, because "the player saw a key" must be a test failure, not a bug report.
   */
  resolve(text, args = null) {
    const localized = LocalizedText.fromJSON(text);
    if (localized.cultureInvariant) return localized.source;
    this.lookupCount++;
    const overrideKey = `${localized.namespace}::${localized.key}`;
    let template = this.overrides.get(overrideKey) ?? null;
    if (template === null) {
      const tables = localized.table ? [this.tables.get(localized.table)].filter(Boolean) : this.tablesForNamespace(localized.namespace);
      for (const culture of this.cultureChain()) {
        for (const table of tables) {
          const found = table.get(culture, localized.key);
          if (found !== null) { template = found; break; }
        }
        if (template !== null) break;
      }
    }
    if (template === null) {
      template = localized.source || null;
      this._recordMissing(localized);
    } else {
      this.hitCount++;
    }
    const withArgs = localized.args ?? args;
    return template === null ? '' : formatText(template, withArgs, this);
  }

  /** Systems that registered a namespace prefix get their tables searched (folders of tables). */
  tablesForNamespace(namespace) {
    const direct = this.tables.get(namespace);
    if (direct) return [direct];
    const prefixed = [...this.tables.values()].filter((table) => table.name.startsWith(`${namespace}/`) || table.name.startsWith(`${namespace}.`));
    return prefixed.length ? prefixed : [...this.tables.values()];
  }

  /** `localization.getText(text, { count: 3 })` — the same as resolve, spelled for readers. */
  getText(text, args = null) { return this.resolve(text, args); }

  /** Format a plain string with arguments (no lookup) — for text already resolved or invariant. */
  format(template, args = null) { return formatText(String(template), args, this); }

  /** Sets or clears a runtime override (live tweaking, tests, a community patch). */
  setOverride(namespace, key, text) {
    if (text === null || text === undefined) this.overrides.delete(`${namespace}::${key}`);
    else this.overrides.set(`${namespace}::${key}`, String(text));
    return this;
  }

  _recordMissing(localized) {
    const id = `${localized.namespace}::${localized.key}`;
    const entry = this.missing.get(id) ?? { key: localized.key, namespace: localized.namespace, culture: this.culture, count: 0, source: localized.source };
    entry.count++;
    this.missing.set(id, entry);
    localizationEvents.onMissingText.broadcast(localized, this);
    return entry;
  }

  // ------------------------------------------------------------------ formatting
  /** Culture-aware number formatting: `formatNumber(1234.5)` → "1,234.5" (or "١٬٢٣٤٫٥" in ar). */
  formatNumber(value, options = {}) {
    try { return new Intl.NumberFormat(this.culture, options).format(value); }
    catch { return String(value); }
  }

  formatPercent(value, options = {}) {
    try { return new Intl.NumberFormat(this.culture, { style: 'percent', ...options }).format(value); }
    catch { return `${Math.round(value * 100)}%`; }
  }

  formatDate(value, options = { dateStyle: 'medium' }) {
    try { return new Intl.DateTimeFormat(this.culture, options).format(value instanceof Date ? value : new Date(value)); }
    catch { return new Date(value).toISOString().slice(0, 10); }
  }

  /** "3 minutes ago" / "in 2 hours" — the scoreboard and kill feed use this. */
  formatRelative(value, unit = 'seconds', options = {}) {
    try {
      const formatter = new Intl.RelativeTimeFormat(this.culture, { numeric: 'auto' });
      return formatter.format(value, unit);
    } catch { return `${value} ${unit}`; }
  }

  /** Joins a list with the culture's conjunction ("a, b and c" / "a，b 和 c"). */
  formatList(items, options = { type: 'conjunction' }) {
    try { return new Intl.ListFormat(this.culture, options).format(items); }
    catch { return items.join(', '); }
  }

  // ------------------------------------------------------------------ helpers
  /** All strings currently resolved from source text rather than a translation. */
  missingReport({ limit = 0 } = {}) {
    const rows = [...this.missing.values()].sort((a, b) => b.count - a.count);
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  /** Per-table translation coverage for the current culture — the localization test gate. */
  coverageReport() {
    const report = {};
    for (const [name, table] of this.tables) {
      const coverage = table.coverage();
      report[name] = {
        keys: table.keys().length,
        cultures: Object.fromEntries(Object.entries(coverage).map(([culture, row]) => [culture, row.translated])),
        missingForCulture: coverage[this.culture]?.missing ?? coverage[this.fallbackCulture]?.missing ?? [],
      };
    }
    return report;
  }

  describe() {
    return {
      culture: this.culture,
      fallback: this.fallbackCulture,
      rightToLeft: this.isRightToLeft,
      cultures: this.availableCultures,
      tables: [...this.tables.values()].map((table) => table.describe()),
      lookups: this.lookupCount,
      hits: this.hitCount,
      hitRate: this.lookupCount ? Math.round((this.hitCount / this.lookupCount) * 100) : 100,
      missing: this.missing.size,
      overrides: this.overrides.size,
    };
  }

  format_report() { return this.formatReport(); }

  formatReport({ limit = 12 } = {}) {
    const report = this.describe();
    const lines = [
      `  culture ${report.culture} (${report.rightToLeft ? 'RTL' : 'LTR'}) · fallback ${report.fallback}`,
      `  ${report.tables.length} tables · ${report.lookups} lookups · ${report.hitRate}% translated · ${report.missing} missing`,
    ];
    for (const table of report.tables) lines.push(`  ${table.name.padEnd(24)} ${table.keys} keys · ${table.cultures.join(', ')}`);
    const missing = this.missingReport({ limit: 5 });
    if (missing.length) {
      lines.push('  untranslated (most used first):');
      for (const row of missing.slice(0, limit)) lines.push(`    ${row.namespace}::${row.key} ×${row.count}`);
    }
    return lines.join('\n');
  }

  /** Console commands: switch culture, inspect coverage, find untranslated strings. */
  installConsoleCommands(console_) {
    const loc = this;
    console_.registerCommand({
      name: 'loc', aliases: ['loc.report'], category: 'Text', description: 'Culture, tables, coverage and untranslated strings.',
      execute: () => loc.formatReport(),
    });
    console_.registerCommand({
      name: 'loc.culture', category: 'Text', description: 'Sets the display culture.',
      args: [{ name: 'tag', required: false }],
      execute: (args) => {
        if (!args.tag) return `${loc.culture} (available: ${loc.availableCultures.join(', ')})`;
        loc.setCulture(args.tag);
        return `culture = ${loc.culture}`;
      },
    });
    console_.registerCommand({
      name: 'loc.missing', category: 'Text', description: 'Lists strings falling back to source text.',
      args: [{ name: 'count', type: 'int', required: false, default: 20 }],
      execute: (args) => loc.missingReport({ limit: args.count }).map((row) => `${row.namespace}::${row.key} ×${row.count}`).join('\n') || 'nothing missing',
    });
    console_.registerCommand({
      name: 'loc.text', category: 'Text', description: 'Resolves a key (namespace::key).',
      args: [{ name: 'id' }],
      execute: (args) => {
        const [namespace, key] = args.id.includes('::') ? args.id.split('::') : ['OminX', args.id];
        return loc.resolve(LOCTEXT(namespace, key, '(source)'));
      },
    });
    console_.registerCommand({
      name: 'loc.tables', category: 'Text', description: 'Lists string tables and their cultures.',
      execute: () => [...loc.tables.values()].map((table) => `${table.name.padEnd(24)} ${table.keys().length} keys · ${table.cultureNames.join(', ')}`).join('\n') || 'no tables',
    });
    return console_;
  }
}

/** Creates a localization system and registers the common cultures. */
export function createLocalization(options = {}) {
  const localization = new Localization(options);
  for (const culture of options.cultures ?? ['en', 'en-GB', 'ar', 'ar-AE', 'fr', 'de', 'es', 'pt-BR', 'ru', 'zh-Hans', 'ja', 'ko', 'tr', 'pl', 'hi']) {
    localization.registerCulture(culture);
  }
  return localization;
}

// ------------------------------------------------------------------ parsing & formatting

function normalizeCulture(tag) {
  if (!tag) return 'en';
  const parts = String(tag).replace(/_/g, '-').split('-').filter(Boolean);
  if (!parts.length) return 'en';
  return [parts[0].toLowerCase(), ...parts.slice(1).map((part) => (part.length === 2 ? part.toUpperCase() : part))].join('-');
}

function isRightToLeft(culture) {
  const language = String(culture).split('-')[0].toLowerCase();
  return ['ar', 'he', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv'].includes(language);
}

/** Parses a table payload: JSON (`{ cultures: { en: { k: v } } }`) or CSV (`key,culture,text`). */
export function parseTablePayload(payload) {
  if (payload && typeof payload === 'object' && !(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload)) {
    return { cultures: payload.cultures ?? payload, metadata: payload.metadata ?? {} };
  }
  const text = payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)
    ? new TextDecoder().decode(payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload)
    : String(payload ?? '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return { cultures: parsed.cultures ?? parsed, metadata: parsed.metadata ?? {} };
    } catch (error) {
      log.error(`malformed JSON string table: ${error.message}`);
      return { cultures: {}, metadata: {} };
    }
  }
  // CSV: key, culture, text — plus an optional header row.
  const cultures = {};
  for (const [index, line] of trimmed.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    if (index === 0 && cells[0]?.toLowerCase() === 'key') continue;
    const [key, culture = 'en', ...rest] = cells;
    if (!key) continue;
    cultures[culture] ??= {};
    cultures[culture][key] = rest.length ? rest.join(',') : (cells[2] ?? '');
  }
  return { cultures, metadata: { format: 'csv' } };
}

function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { cells.push(cell); cell = ''; continue; }
    cell += char;
  }
  cells.push(cell);
  return cells.map((entry) => entry.trim());
}

/**
 * Substitutes `{name}` arguments and evaluates plural/select blocks:
 * `{count, plural, one {# kill} other {# kills}}`, `{gender, select, male {his} other {their}}`.
 *
 * A scanner rather than a regex: choice bodies contain braces and nested placeholders
 * (`other {{count} kills}`), which a non-greedy regex truncates at the first `}` — that is how a
 * plural rule ends up rendered to the player as literal text.
 */
export function formatText(template, args, localization = null) {
  if (!template || !template.includes('{')) return template;
  const values = args ?? {};
  let out = '';
  let index = 0;
  while (index < template.length) {
    const char = template[index];
    if (char === '\\' && template[index + 1] === '{') { out += '{'; index += 2; continue; }
    if (char !== '{') { out += char; index++; continue; }
    const block = readBalanced(template, index);
    if (!block) { out += char; index++; continue; }
    const placeholder = parsePlaceholder(template.slice(index + 1, block.end - 1));
    if (!placeholder) { out += template.slice(index, block.end); index = block.end; continue; }
    out += renderPlaceholder(placeholder, values, localization);
    index = block.end;
  }
  return out;
}

/** Finds the `}` matching the `{` at `start`, honoring nesting and backslash escapes. */
function readBalanced(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') { i++; continue; }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return { end: i + 1 };
    }
  }
  return null;
}

/** `{name}` → argument; `{name, plural, …}` → plural block; anything else → null (left as written). */
function parsePlaceholder(inner) {
  const trimmed = String(inner).trim();
  if (!trimmed) return null;
  const firstComma = indexOfAtDepth(trimmed, ',');
  if (firstComma < 0) return /^[\w.]+$/.test(trimmed) ? { name: trimmed, kind: 'argument', body: null } : null;
  const name = trimmed.slice(0, firstComma).trim();
  const rest = trimmed.slice(firstComma + 1);
  const secondComma = indexOfAtDepth(rest, ',');
  if (secondComma < 0) return null;
  const kind = rest.slice(0, secondComma).trim().toLowerCase();
  if (!/^[\w.]+$/.test(name)) return null;
  if (!['plural', 'select', 'selectordinal'].includes(kind)) return null;
  return { name, kind, body: rest.slice(secondComma + 1) };
}

/** First `needle` outside any braces. */
function indexOfAtDepth(text, needle) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') { i++; continue; }
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === needle && depth === 0) return i;
  }
  return -1;
}

function renderPlaceholder(placeholder, values, localization) {
  const value = values[placeholder.name];
  if (placeholder.kind === 'argument') {
    if (!(placeholder.name in values)) return `{${placeholder.name}}`;
    return stringifyArgument(value, localization);
  }
  const choices = parseChoices(placeholder.body ?? '');
  if (placeholder.kind !== 'plural') {
    return formatText(choices[String(value)] ?? choices.other ?? choices.male ?? '', values, localization);
  }
  // Inside a plural choice, `#` is the localized number.
  const count = Number(value ?? 0);
  const chosen = pickPlural(choices, count, localization);
  return formatText(chosen.replace(/#/g, formatNumberFor(count, localization)), values, localization);
}

function stringifyArgument(value, localization) {
  if (value === null || value === undefined) return '';
  if (value instanceof LocalizedText) return value.toString(localization);
  if (typeof value === 'number') return formatNumberFor(value, localization);
  if (value instanceof Date) return localization ? localization.formatDate(value) : value.toISOString();
  return String(value);
}

function formatNumberFor(value, localization) {
  if (typeof value !== 'number') return String(value);
  return localization ? localization.formatNumber(value) : String(value);
}

/**
 * Parses a plural/select body into `{ category: text }`. Choice bodies contain braces of their own,
 * so this walks the string instead of matching it with a regular expression.
 */
function parseChoices(body) {
  const text = String(body ?? '');
  const choices = {};
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /[\s,]/.test(text[index])) index++;
    let name = '';
    while (index < text.length && /[\w=]/.test(text[index])) name += text[index++];
    while (index < text.length && /\s/.test(text[index])) index++;
    if (text[index] !== '{') break;
    const block = readBalanced(text, index);
    if (!block) break;
    if (name) choices[name] = text.slice(index + 1, block.end - 1);
    index = block.end;
  }
  return choices;
}

/**
 * Plural categories. English has two forms; Arabic has six, Polish four — hard-coding
 * `count === 1` produces text that reads wrong in most of the world, so the rules live here.
 */
export function pickPlural(choices, count, localization = null) {
  const locale = localization?.culture ?? 'en';
  try {
    const rule = new Intl.PluralRules(locale).select(count);
    if (choices[rule] !== undefined) return choices[rule];
  } catch { /* fall through to the arithmetic rules below */ }
  const categories = pluralCategories(locale, count);
  for (const category of categories) if (choices[category] !== undefined) return choices[category];
  if (count === 1 && choices.one !== undefined) return choices.one;
  return choices.other ?? choices.many ?? choices.one ?? '';
}

/** Fallback plural rules for hosts without `Intl.PluralRules` (headless, older engines). */
function pluralCategories(locale, count) {
  const language = String(locale).split('-')[0];
  const n = Math.abs(count);
  const i = Math.floor(n);
  const v = String(n).includes('.') ? String(n).split('.')[1].length : 0;
  switch (language) {
    case 'ar':
      if (n === 0) return ['zero'];
      if (n === 1) return ['one'];
      if (n === 2) return ['two'];
      if (i % 100 >= 3 && i % 100 <= 10) return ['few'];
      return ['many'];
    case 'ru': case 'uk': case 'pl':
      if (i % 10 === 1 && i % 100 !== 11) return ['one'];
      if (i % 10 >= 2 && i % 10 <= 4 && (i % 100 < 12 || i % 100 > 14)) return ['few'];
      if (v === 0 && ((i % 10 === 0) || (i % 10 >= 5 && i % 10 <= 9) || (i % 100 >= 11 && i % 100 <= 14))) return ['many'];
      return ['other'];
    case 'fr': case 'pt':
      return n >= 0 && n < 2 ? ['one'] : ['other'];
    case 'ja': case 'ko': case 'zh': case 'th': case 'vi':
      return ['other'];
    default:
      return n === 1 ? ['one'] : ['other'];
  }
}

export default Localization;
