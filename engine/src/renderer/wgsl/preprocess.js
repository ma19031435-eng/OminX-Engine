/**
 * OminX Engine — tiny WGSL preprocessor.
 *
 * WebGPU has no `#define`, so shader permutations are resolved in JS before the module is handed
 * to `createShaderModule`. This mirrors the subset of the C preprocessor the GLSL shaders use:
 * object-like macros, `#ifdef/#ifndef/#if/#elif/#else/#endif`, and nesting.
 *
 * Kept deliberately small and dependency-free: it runs once per permutation (cached afterwards),
 * and every generated source is parsed by `wgsl_reflect` in the test-suite so a macro can never
 * produce malformed WGSL silently.
 *
 * @module engine/src/renderer/wgsl/preprocess
 */

/**
 * @param {string} source WGSL source, may contain preprocessor directives
 * @param {Record<string, string|number|boolean>} [defines]
 * @returns {string} WGSL with directives resolved and object-like macros expanded
 */
export function preprocessWGSL(source, defines = {}) {
  const macros = new Map();
  for (const [key, value] of Object.entries(defines)) {
    if (value === false || value === undefined || value === null) continue;
    macros.set(key, value === true ? '1' : String(value));
  }
  const lines = source.split('\n');
  const out = [];
  /** @type {{taken: boolean, parentActive: boolean, active: boolean}[]} */
  const stack = [];
  let active = true;

  for (const rawLine of lines) {
    const directive = /^\s*#\s*([a-z]+)\s*(.*)$/i.exec(rawLine);
    if (!directive) {
      if (active) out.push(rawLine);
      continue;
    }
    const [, keyword, rest] = directive;
    switch (keyword) {
      case 'define': {
        if (!active) break;
        const [, name, value] = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/.exec(rest) ?? [];
        if (name) macros.set(name, value && value.trim() ? value.trim() : '1');
        break;
      }
      case 'undef': {
        if (active) macros.delete(rest.trim());
        break;
      }
      case 'ifdef':
      case 'ifndef': {
        const condition = macros.has(rest.trim()) === (keyword === 'ifdef');
        stack.push({ parentActive: active, taken: condition, active: active && condition });
        active = active && condition;
        break;
      }
      case 'if': {
        const condition = evaluate(rest, macros);
        stack.push({ parentActive: active, taken: condition, active: active && condition });
        active = active && condition;
        break;
      }
      case 'elif': {
        const frame = stack[stack.length - 1];
        if (!frame) break;
        const condition = !frame.taken && evaluate(rest, macros);
        frame.active = frame.parentActive && condition;
        frame.taken = frame.taken || condition;
        active = frame.active;
        break;
      }
      case 'else': {
        const frame = stack[stack.length - 1];
        if (!frame) break;
        frame.active = frame.parentActive && !frame.taken;
        frame.taken = true;
        active = frame.active;
        break;
      }
      case 'endif': {
        const frame = stack.pop();
        active = frame ? frame.parentActive : true;
        break;
      }
      default:
        // Unknown directive (e.g. `#version`): drop it, it has no WGSL meaning.
        break;
    }
  }

  let text = out.join('\n');
  // Object-like macro expansion, longest name first so FOO_BAR wins over FOO.
  const names = [...macros.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const value = macros.get(name);
    text = text.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), () => value);
  }
  return text;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Evaluates a `#if` expression. Supports `defined(X)`, numbers, comparisons, `!`, `&&`, `||`
 * and parentheses — enough for every permutation this engine generates.
 * @param {string} expression
 * @param {Map<string, string>} macros
 */
export function evaluate(expression, macros) {
  const tokens = tokenize(expression, macros);
  let index = 0;
  const peek = () => tokens[index];
  const eat = (value) => (peek() === value ? (index++, true) : false);

  const orExpr = () => {
    let left = andExpr();
    while (eat('||')) left = andExpr() || left;
    return left;
  };
  const andExpr = () => {
    let left = comparison();
    while (eat('&&')) left = comparison() && left;
    return left;
  };
  const comparison = () => {
    const left = unary();
    const op = peek();
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
      index++;
      const right = unary();
      switch (op) {
        case '==': return Number(left) === Number(right);
        case '!=': return Number(left) !== Number(right);
        case '<': return Number(left) < Number(right);
        case '>': return Number(left) > Number(right);
        case '<=': return Number(left) <= Number(right);
        default: return Number(left) >= Number(right);
      }
    }
    return left;
  };
  const unary = () => {
    if (eat('!')) return !unary();
    if (eat('(')) {
      const value = orExpr();
      eat(')');
      return value;
    }
    const token = tokens[index++];
    const numeric = Number(token);
    return Number.isNaN(numeric) ? !!token : numeric !== 0;
  };
  return !!orExpr();
}

function tokenize(expression, macros) {
  const replaced = expression.replace(/defined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, (_, name) => (macros.has(name) ? '1' : '0'));
  const tokens = [];
  const re = /\s*(<=|>=|==|!=|&&|\|\||[()!<>]|[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*)/g;
  let match;
  while ((match = re.exec(replaced))) {
    const token = match[1];
    if (/^[A-Za-z_]/.test(token)) {
      const value = macros.get(token);
      tokens.push(value === undefined ? token : value);
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

export default preprocessWGSL;
