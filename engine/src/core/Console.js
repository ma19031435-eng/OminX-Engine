/**
 * OminX Engine — the console.
 *
 * Every serious engine ships one, because it is the fastest interface ever built for a running
 * program: type a thing, see what happens, no recompile. This is the UE-style console — commands,
 * variables, help, completion, execution from a file, and output that both the developer and the
 * editor's log panel can read.
 *
 * Three kinds of entries:
 *   - **Command** — an action: `spawn Bot 4`, `stats dump`, `map load /Game/Maps/Arena`.
 *   - **Variable** — a value: `renderer.fov 110`. Variables *are* `Config` keys, so a console change
 *     and an editor change are the same change, and `config.onChanged` fires either way.
 *   - **Alias** — a saved command line, optionally with `$1..$9` argument substitution: aliases let a
 *     developer keep `fps` = `stats show frame; renderer.fov 110`.
 *
 * Statements are separated by `;`, so `map load arena; bots 8; stats show` works as one line.
 * Arguments may be quoted (`say "hello world"`), and `--flags` are collected into `args.flags`.
 *
 * Output goes to a ring buffer *and* to `consoleEvents.onOutput`, which is how the browser HUD,
 * an in-game console overlay, and the headless test harness all see the same stream.
 *
 * @module engine/src/core/Console
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';
import { RingBuffer } from './Containers.js';
import { ConfigLayer, ConfigType } from './Config.js';

const log = createLogger('Console');

export const consoleEvents = {
  onOutput: new MulticastDelegate('console.onOutput'),
  onCommandExecuted: new MulticastDelegate('console.onCommandExecuted'),
  onCommandFailed: new MulticastDelegate('console.onCommandFailed'),
  onCommandRegistered: new MulticastDelegate('console.onCommandRegistered'),
  onVariableChanged: new MulticastDelegate('console.onVariableChanged'),
};

export const OutputLevel = {
  Info: 'info',
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
  Command: 'command',
  Debug: 'debug',
};

/** A registered command. */
export class ConsoleCommand {
  constructor({ name, execute, description = '', usage = '', aliases = [], args = [], category = 'General', flags = [], hidden = false, cheat = false, requires = null }) {
    if (!name) throw new Error('ConsoleCommand needs a name');
    if (typeof execute !== 'function') throw new TypeError(`command "${name}" needs an execute function`);
    this.name = String(name).toLowerCase();
    this.execute = execute;
    this.description = description;
    this.usage = usage || `${this.name} ${args.map((arg) => (arg.required === false ? `[${arg.name}]` : `<${arg.name}>`)).join(' ')}`.trim();
    this.aliases = aliases.map((alias) => String(alias).toLowerCase());
    this.args = args.map((arg) => ({ type: 'string', required: true, ...arg }));
    this.category = category;
    this.flags = [...flags];
    this.hidden = hidden;
    this.cheat = cheat;
    this.requires = requires;
    this.calls = 0;
    this.lastMs = 0;
    this.totalMs = 0;
  }

  /** Validates and coerces positional arguments; returns `{ values, error }`. */
  coerce(rawArgs) {
    const values = {};
    const positional = this.args.filter((arg) => !arg.flag);
    let index = 0;
    for (const spec of positional) {
      const raw = rawArgs[index];
      if (raw === undefined) {
        if (spec.required === false || spec.default !== undefined) { values[spec.name] = spec.default ?? null; continue; }
        return { error: `missing argument <${spec.name}>` };
      }
      switch (spec.type) {
        case 'number': case 'float': {
          const number = Number(raw);
          if (!Number.isFinite(number)) return { error: `"${raw}" is not a number (for <${spec.name}>)` };
          if (spec.min !== undefined && number < spec.min) return { error: `<${spec.name}> ${number} is below ${spec.min}` };
          if (spec.max !== undefined && number > spec.max) return { error: `<${spec.name}> ${number} is above ${spec.max}` };
          values[spec.name] = number;
          break;
        }
        case 'int': {
          const number = Math.round(Number(raw));
          if (!Number.isFinite(number)) return { error: `"${raw}" is not an integer (for <${spec.name}>)` };
          if (spec.min !== undefined && number < spec.min) return { error: `<${spec.name}> ${number} is below ${spec.min}` };
          if (spec.max !== undefined && number > spec.max) return { error: `<${spec.name}> ${number} is above ${spec.max}` };
          values[spec.name] = number;
          break;
        }
        case 'boolean':
          values[spec.name] = raw !== 'false' && raw !== '0' && raw !== 'off';
          break;
        case 'enum': {
          const list = spec.values ?? [];
          if (list.length && !list.includes(raw)) return { error: `"${raw}" must be one of ${list.join(', ')}` };
          values[spec.name] = raw;
          break;
        }
        case 'string':
        default:
          values[spec.name] = raw;
          break;
      }
      index++;
    }
    if (rawArgs.length > index) values.rest = rawArgs.slice(index);
    return { values };
  }

  describe() {
    return {
      name: this.name, description: this.description, usage: this.usage, aliases: [...this.aliases],
      category: this.category, args: this.args.map((arg) => ({ ...arg })), hidden: this.hidden,
      cheat: this.cheat, calls: this.calls, averageMs: this.calls ? this.totalMs / this.calls : 0,
    };
  }
}

/** A saved command line, with `$1…$9` substitution. */
export class ConsoleAlias {
  constructor(name, command, { description = '' } = {}) {
    this.name = String(name).toLowerCase();
    this.command = command;
    this.description = description;
  }

  expand(args) {
    return this.command.replace(/\$(\d)/g, (_, index) => args[Number(index) - 1] ?? '');
  }
}

/** The console itself: parsing, dispatch, variables, history and output. */
export class Console {
  constructor({ config = null, historySize = 200, outputSize = 500, name = 'OminX', prompt = '> ' } = {}) {
    this.name = name;
    this.prompt = prompt;
    this.config = config;
    /** @type {Map<string, ConsoleCommand>} */
    this.commands = new Map();
    /** @type {Map<string, ConsoleAlias>} */
    this.aliases = new Map();
    /** @type {Map<string, { name: string, value: any, description: string, readonly: boolean, category: string }>} */
    this.variables = new Map();
    this.history = new RingBuffer(historySize);
    this.output = new RingBuffer(outputSize);
    this.variablesBound = new Set();
    this.externalSink = null;
    this.installBuiltIns();
    if (config) this.bindConfig(config);
  }

  static create(options) { return new Console(options); }

  // ------------------------------------------------------------------ registration
  registerCommand(options) {
    const command = options instanceof ConsoleCommand ? options : new ConsoleCommand(options);
    if (this.commands.has(command.name)) log.debug(`command "${command.name}" replaced`);
    this.commands.set(command.name, command);
    for (const alias of command.aliases) this.commands.set(alias, command);
    consoleEvents.onCommandRegistered.broadcast(command, this);
    return command;
  }

  unregisterCommand(name) {
    const command = this.commands.get(String(name).toLowerCase());
    if (!command) return false;
    this.commands.delete(command.name);
    for (const alias of command.aliases) this.commands.delete(alias);
    return true;
  }

  /** `console.alias('fps', 'stats show frame')`. */
  alias(name, command, options = {}) {
    const alias = new ConsoleAlias(name, command, options);
    this.aliases.set(alias.name, alias);
    return alias;
  }

  hasCommand(name) { return this.commands.has(String(name).toLowerCase()); }
  getCommand(name) { return this.commands.get(String(name).toLowerCase()) ?? null; }
  commandsList() { return [...new Set(this.commands.values())]; }

  /**
   * Registers an engine variable. When a `Config` is bound, `config` variables are exposed
   * automatically and this is only needed for non-config state.
   */
  registerVariable(name, value, { description = '', readonly = false, category = 'General' } = {}) {
    this.variables.set(name, { name, value, description, readonly, category });
    return this;
  }

  /** Makes every config key settable from the console (`renderer.fov 110`, `renderer.fov` reads). */
  bindConfig(config) {
    this.config = config;
    for (const entry of config.schema.all()) this.variablesBound.add(entry.key);
    return this;
  }

  // ------------------------------------------------------------------ variables
  getVariable(name) {
    const key = String(name);
    if (this.variables.has(key)) return this.variables.get(key).value;
    if (this.config && (this.config.schema.has(key) || this.config.has(key))) return this.config.get(key);
    return undefined;
  }

  setVariable(name, value) {
    const key = String(name);
    const variable = this.variables.get(key);
    if (variable) {
      if (variable.readonly) return { ok: false, error: `"${key}" is read-only` };
      const previous = variable.value;
      variable.value = value;
      consoleEvents.onVariableChanged.broadcast(key, value, previous, this);
      return { ok: true, previous };
    }
    if (this.config && (this.config.schema.has(key) || this.config.has(key))) {
      const proposed = String(value);
      const ok = this.config.set(key, proposed, { layer: ConfigLayer.Runtime });
      if (!ok) return { ok: false, error: this.config.validationErrors.at(-1)?.message ?? 'rejected' };
      consoleEvents.onVariableChanged.broadcast(key, this.config.get(key), undefined, this);
      return { ok: true, value: this.config.get(key) };
    }
    // Unknown bare word → treat as a new untyped variable (developer scratch space).
    this.registerVariable(key, value, { description: 'runtime variable', category: 'Runtime' });
    return { ok: true, created: true };
  }

  variableNames() {
    const names = new Set(this.variables.keys());
    if (this.config) for (const entry of this.config.schema.all()) names.add(entry.key);
    return [...names];
  }

  // ------------------------------------------------------------------ parsing
  /**
   * Splits a line into statements, honoring quotes and `;`. Quotes are *preserved* here: this pass
   * only decides where a statement ends, and `parseStatement()` is the single place that removes
   * them. Stripping in both passes used to eat the quotes of a quoted JSON argument twice, so
   * `save.write profile '{"progress":{"level":9}}'` arrived as `{progress:{level:9}}`.
   */
  parseStatements(line) {
    const statements = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        current += char;
        if (char === '\\' && i + 1 < line.length) { current += line[++i]; continue; }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; current += char; continue; }
      if (char === ';') { statements.push(current.trim()); current = ''; continue; }
      current += char;
    }
    if (current.trim()) statements.push(current.trim());
    return statements.filter(Boolean);
  }

  /** Splits one statement into `{ name, args, flags, raw }`. */
  parseStatement(statement) {
    const tokens = [];
    let token = '';
    let quote = null;
    for (let i = 0; i < statement.length; i++) {
      const char = statement[i];
      if (char === '\\' && quote) { token += statement[i + 1] ?? ''; i++; continue; }
      if (quote) {
        if (char === quote) quote = null;
        else token += char;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === ' ') {
        if (token) { tokens.push(token); token = ''; }
        continue;
      }
      token += char;
    }
    if (token) tokens.push(token);

    const flags = {};
    const args = [];
    for (const item of tokens) {
      if (item.startsWith('--')) {
        const eq = item.indexOf('=');
        if (eq >= 0) flags[item.slice(2, eq)] = item.slice(eq + 1);
        else flags[item.slice(2)] = true;
        continue;
      }
      if (item.startsWith('-') && item.length === 2) { flags[item.slice(1)] = true; continue; }
      args.push(item);
    }
    return { name: (args.shift() ?? '').toLowerCase(), args, flags, raw: statement };
  }

  /** Expands `$1…$9`, `$name` and environment-style variables inside a statement. */
  expandVariables(statement, args) {
    return statement.replace(/\$\{?([A-Za-z_][\w.]*|\d)\}?/g, (match, reference) => {
      if (/^\d$/.test(reference)) return args[Number(reference) - 1] ?? '';
      const value = this.getVariable(reference);
      return value === undefined ? match : String(value);
    });
  }

  // ------------------------------------------------------------------ execution
  /**
   * Executes a console line. Returns `{ ok, results, output, error }` — never throws, so a HUD
   * console or a bound key cannot crash the frame.
   */
  exec(line, { context = null, echo = true, silent = false } = {}) {
    const statements = this.parseStatements(String(line ?? ''));
    if (!statements.length) return { ok: true, results: [], output: '' };
    if (echo) this.history.push(String(line));
    const results = [];
    let ok = true;
    for (const statement of statements) {
      const result = this.execStatement(statement, { context });
      results.push(result);
      if (!result.ok) ok = false;
      if (!silent && result.output) this.print(result.output, result.ok ? OutputLevel.Command : OutputLevel.Error);
    }
    return { ok, results, output: results.map((result) => result.output).filter(Boolean).join('\n') };
  }

  /** Executes one parsed statement. Returns `{ ok, output, error, command, args }`. */
  execStatement(statement, { context = null } = {}) {
    const parsed = this.parseStatement(statement);
    if (!parsed.name) return { ok: true, output: '', command: null };
    const alias = this.aliases.get(parsed.name);
    if (alias) {
      const expanded = alias.expand(parsed.args);
      const result = this.exec(expanded, { context, echo: false, silent: true });
      return { ok: result.ok, output: result.output, command: `alias:${alias.name}`, args: parsed.args };
    }
    const command = this.commands.get(parsed.name);

    // Not a command: try variables (`renderer.fov 110` writes, `renderer.fov` reads).
    const variableNames = this.variableNames();
    const looksLikeVariable = this.variables.has(parsed.name) || this.config?.schema.has(parsed.name) || this.config?.has(parsed.name);
    if (!command && (looksLikeVariable || variableNames.includes(parsed.name))) {
      if (!parsed.args.length && !Object.keys(parsed.flags).length) {
        return { ok: true, output: `${parsed.name} = ${formatValue(this.getVariable(parsed.name))}`, command: 'variable:get' };
      }
      const result = this.setVariable(parsed.name, parsed.args.join(' '));
      return result.ok
        ? { ok: true, output: `${parsed.name} = ${formatValue(this.getVariable(parsed.name))}`, command: 'variable:set' }
        : { ok: false, output: result.error, error: result.error, command: 'variable:set' };
    }

    if (!command) {
      const suggestions = this.complete(parsed.name).slice(0, 5);
      const hint = suggestions.length ? ` — did you mean ${suggestions.join(', ')}?` : '';
      const output = `unknown command "${parsed.name}"${hint}`;
      consoleEvents.onCommandFailed.broadcast(parsed.name, output, this);
      return { ok: false, output, error: output, command: null };
    }

    if (command.requires && !command.requires(context) && !parsed.flags.force) {
      const output = `"${command.name}" is not available here (pass --force to override)`;
      consoleEvents.onCommandFailed.broadcast(command.name, output, this);
      return { ok: false, output, error: output, command: command.name };
    }

    const expanded = parsed.args.map((arg) => this.expandVariables(arg, parsed.args));
    const coerced = command.coerce(expanded);
    if (coerced.error) {
      const output = `${coerced.error}\nusage: ${command.usage}`;
      consoleEvents.onCommandFailed.broadcast(command.name, output, this);
      return { ok: false, output, error: coerced.error, command: command.name };
    }

    const startedAt = nowMs();
    try {
      const result = command.execute({ ...coerced.values, flags: parsed.flags }, { console: this, config: this.config, context, raw: statement });
      command.calls++;
      if (result && typeof result.then === 'function') {
        // Async commands (asset loads) report themselves when they settle.
        const pending = result
          .then((value) => ({ ok: true, output: stringifyResult(value), command: command.name }))
          .catch((error) => ({ ok: false, output: `"${command.name}" failed: ${error?.message ?? error}`, error: error?.message, command: command.name }));
        pending.then((settled) => {
          command.totalMs += nowMs() - startedAt;
          command.lastMs = nowMs() - startedAt;
          consoleEvents.onCommandExecuted.broadcast(command, settled, this);
          if (settled.output) this.print(settled.output, settled.ok ? OutputLevel.Command : OutputLevel.Error);
        });
        return { ok: true, output: `"${command.name}" running…`, command: command.name, pending: true };
      }
      const elapsed = nowMs() - startedAt;
      command.calls++;
      command.totalMs += elapsed;
      command.lastMs = elapsed;
      const result2 = { ok: true, output: stringifyResult(result), command: command.name, args: coerced.values, ms: elapsed };
      consoleEvents.onCommandExecuted.broadcast(command, result2, this);
      return result2;
    } catch (error) {
      command.calls++;
      const output = `"${command.name}" failed: ${error?.message ?? error}`;
      log.error(output);
      consoleEvents.onCommandFailed.broadcast(command.name, error, this);
      return { ok: false, output, error: error?.message ?? String(error), command: command.name };
    }
  }

  /** Runs a list of lines (a config/exec script). Stops at the first failure unless `continueOnError`. */
  execText(text, { context = null, continueOnError = true, echo = false } = {}) {
    const results = [];
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const result = this.exec(line, { context, echo, silent: true });
      results.push({ line, ...result });
      if (!result.ok && !continueOnError) break;
    }
    return { ok: results.every((result) => result.ok), results };
  }

  // ------------------------------------------------------------------ output
  /** Writes to the buffer and the event stream. `sink` lets a host mirror output (DOM, stdout). */
  print(message, level = OutputLevel.Info) {
    const text = String(message ?? '');
    if (!text) return text;
    const record = { level, message: text, at: Date.now() };
    this.output.push(record);
    if (this.sink) this.sink(record);
    this.externalSink?.(record);
    if (level === OutputLevel.Error) log.error(text);
    else if (level === OutputLevel.Warning) log.warn(text);
    consoleEvents.onOutput.broadcast(record, this);
    return text;
  }

  lines({ limit = 0, level = null } = {}) {
    const items = this.output.toArray().filter((record) => !level || record.level === level);
    return limit > 0 ? items.slice(-limit) : items;
  }

  /** Plain text transcript — what the headless harness and the log panel show. */
  transcript({ limit = 0 } = {}) {
    return this.lines({ limit }).map((record) => `${prefixFor(record.level)}${record.message}`).join('\n');
  }

  clear() { this.output.clear(); return this; }

  // ------------------------------------------------------------------ completion & help
  /**
   * Tab completion over commands, aliases and variables. Returns the sorted candidate list, so a DOM
   * console can render a menu and a simple console can insert the common prefix.
   */
  complete(partial = '') {
    const prefix = String(partial).toLowerCase();
    const candidates = new Set();
    for (const command of this.commandsList()) {
      if (command.hidden) continue;
      candidates.add(command.name);
    }
    for (const alias of this.aliases.values()) candidates.add(alias.name);
    for (const name of this.variableNames()) candidates.add(name);
    const matches = [...candidates].filter((name) => name.startsWith(prefix)).sort();
    if (matches.length === 1) {
      const command = this.commands.get(matches[0]);
      if (command?.args.length) return [matches[0], ...command.args.map((arg) => `<${arg.name}>`)];
    }
    return matches;
  }

  /** Longest common prefix of the completion set — what Tab inserts before showing a menu. */
  completionPrefix(partial = '') {
    const matches = this.complete(partial);
    if (!matches.length) return partial;
    let prefix = matches[0];
    for (const match of matches) {
      let index = 0;
      while (index < prefix.length && index < match.length && prefix[index] === match[index]) index++;
      prefix = prefix.slice(0, index);
    }
    return prefix;
  }

  help(name = null) {
    if (name) {
      const command = this.commands.get(String(name).toLowerCase());
      if (!command) {
        const variable = this.variableNames().includes(String(name));
        return variable ? `${name} = ${formatValue(this.getVariable(name))} (variable)` : `no command or variable named "${name}"`;
      }
      const lines = [`${command.name} — ${command.description}`, `  usage: ${command.usage}`];
      if (command.aliases.length) lines.push(`  aliases: ${command.aliases.join(', ')}`);
      if (command.args.length) {
        lines.push('  arguments:');
        for (const arg of command.args) {
          lines.push(`    ${arg.name.padEnd(12)} ${arg.type.padEnd(8)} ${arg.required === false ? '(optional)' : '(required)'} ${arg.description ?? ''}`);
        }
      }
      if (command.category) lines.push(`  category: ${command.category}`);
      return lines.join('\n');
    }
    const byCategory = new Map();
    for (const command of this.commandsList()) {
      if (command.hidden) continue;
      if (!byCategory.has(command.category)) byCategory.set(command.category, []);
      byCategory.get(command.category).push(command);
    }
    const lines = [`OminX console — ${this.commandsList().length} commands, ${this.variableNames().length} variables`];
    for (const [category, list] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push('', `[${category}]`);
      for (const command of list.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`  ${command.name.padEnd(22)} ${command.description}`);
      }
    }
    lines.push('', 'Variables: type a name to read it, `name value` to set it. `help <name>` for details.');
    return lines.join('\n');
  }

  describe() {
    return {
      commands: this.commandsList().map((command) => command.describe()),
      variables: this.variableNames().map((name) => ({ name, value: this.getVariable(name) })),
      aliases: [...this.aliases.values()].map((alias) => ({ name: alias.name, command: alias.command })),
      history: this.history.toArray(),
    };
  }

  // ------------------------------------------------------------------ built-ins
  installBuiltIns() {
    const console_ = this;
    this.registerCommand({
      name: 'help', category: 'Core', description: 'Lists commands, or explains one.',
      args: [{ name: 'command', required: false, description: 'command or variable name' }],
      execute: (args) => console_.help(args.command ?? null),
    });
    this.registerCommand({
      name: 'echo', category: 'Core', description: 'Prints its arguments.',
      args: [{ name: 'text', required: false, description: 'text to print' }],
      execute: (args) => [...(args.rest ?? []), args.text ?? ''].filter(Boolean).join(' '),
    });
    this.registerCommand({
      name: 'commands', aliases: ['cmd'], category: 'Core', description: 'Lists command names only.',
      execute: () => console_.commandsList().filter((command) => !command.hidden).map((command) => command.name).sort().join(' '),
    });
    this.registerCommand({
      name: 'vars', aliases: ['cvars'], category: 'Core', description: 'Lists variables and their values.',
      args: [{ name: 'filter', required: false, description: 'substring filter' }],
      execute: (args) => {
        const filter = args.filter ?? '';
        return console_.variableNames()
          .filter((name) => name.includes(filter))
          .sort()
          .map((name) => `${name} = ${formatValue(console_.getVariable(name))}`)
          .join('\n');
      },
    });
    this.registerCommand({
      name: 'clear', category: 'Core', description: 'Clears the console output buffer.',
      execute: () => { console_.output.clear(); return 'cleared'; },
    });
    this.registerCommand({
      name: 'history', category: 'Core', description: 'Shows recent command lines.',
      args: [{ name: 'count', type: 'int', required: false, default: 20 }],
      execute: (args) => console_.history.toArray().slice(-args.count).map((line, index) => `${String(index + 1).padStart(3)}  ${line}`).join('\n'),
    });
    this.registerCommand({
      name: 'alias', category: 'Core', description: 'Defines a command alias, with $1…$9 substitution.',
      args: [{ name: 'name' }, { name: 'command' }],
      execute: (args) => {
        const rest = args.rest ?? [];
        const command = [args.command, ...rest].join(' ');
        if (!command) return `usage: alias <name> <command>`;
        console_.alias(args.name, command);
        return `${args.name} → ${command}`;
      },
    });
    this.registerCommand({
      name: 'time', category: 'Core', description: 'Measures how long another command takes.',
      args: [{ name: 'command' }],
      execute: (args) => {
        const line = [args.command, ...(args.rest ?? [])].join(' ');
        const started = nowMs();
        const result = console_.exec(line, { echo: false, silent: true });
        const elapsed = nowMs() - started;
        return `${line}\n  → ${result.ok ? 'ok' : 'failed'} in ${elapsed.toFixed(3)} ms${result.output ? `\n${result.output}` : ''}`;
      },
    });
    this.registerCommand({
      name: 'repeat', category: 'Core', description: 'Runs a command N times (load/stress probes).',
      args: [{ name: 'times', type: 'int', min: 1, max: 100000 }, { name: 'command' }],
      execute: (args) => {
        const line = [args.command, ...(args.rest ?? [])].join(' ');
        const started = nowMs();
        let failures = 0;
        for (let i = 0; i < args.times; i++) if (!console_.exec(line, { echo: false, silent: true }).ok) failures++;
        return `${args.times}× "${line}" in ${(nowMs() - started).toFixed(2)} ms${failures ? ` (${failures} failed)` : ''}`;
      },
    });
    this.registerCommand({
      name: 'exec', category: 'Core', description: 'Runs a list of statements (or a file of them when an IO is set).',
      args: [{ name: 'statements' }],
      execute: (args) => {
        const text = [args.statements, ...(args.rest ?? [])].join(' ');
        const result = console_.exec(text, { echo: false, silent: true });
        return result.output || (result.ok ? 'ok' : 'failed');
      },
    });
    this.registerCommand({
      name: 'dump', category: 'Core', description: 'Prints state of everything registered (commands/vars/aliases).',
      execute: () => JSON.stringify(console_.describe(), null, 2),
    });
  }
}

function prefixFor(level) {
  switch (level) {
    case OutputLevel.Error: return '[error]   ';
    case OutputLevel.Warning: return '[warning] ';
    case OutputLevel.Success: return '[ok]      ';
    case OutputLevel.Command: return '[cmd]     ';
    case OutputLevel.Debug: return '[debug]   ';
    default: return '          ';
  }
}

function formatValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function stringifyResult(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyResult).join('\n');
  if (value instanceof Map) return [...value.entries()].map(([key, item]) => `${key} = ${formatValue(item)}`).join('\n');
  if (typeof value.toConsole === 'function') return value.toConsole();
  if (typeof value.format === 'function') return value.format();
  if (typeof value.describe === 'function') return JSON.stringify(value.describe(), null, 2);
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export default Console;
