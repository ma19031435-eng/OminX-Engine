/**
 * OminX Engine — shared reflected field types.
 *
 * One vocabulary for "what type is this value?" is used by saved-game schemas, data tables, config
 * columns and archive structs. Keeping it in one place is what makes a `u8` in a save slot mean
 * exactly the same thing as a `u8` in a CSV row, and lets a data table be validated without
 * importing a runtime service.
 *
 * Supported type strings: integer widths (`u8`…`u32`, `i8`…`i32`), `f32`/`f64`/`number`,
 * `string`/`name`/`text`, `bool`/`boolean`, `vec2`/`vec3`/`vec4`, `json`/`any`, `array:<type>`,
 * `struct:<Name>`, `enum:<A|B|C>`. Unknown types are **forward compatible**: validation never
 * rejects a value just because this build does not know its type.
 *
 * @module engine/src/core/Schema
 */

export const INTEGER_RANGES = Object.freeze({
  u8: Object.freeze([0, 255]),
  u16: Object.freeze([0, 65535]),
  u32: Object.freeze([0, 4294967295]),
  i8: Object.freeze([-128, 127]),
  i16: Object.freeze([-32768, 32767]),
  i32: Object.freeze([-2147483648, 2147483647]),
});

export const FIELD_TYPES = Object.freeze([
  'u8', 'u16', 'u32', 'i8', 'i16', 'i32', 'f32', 'f64', 'number', 'float',
  'string', 'name', 'text', 'bool', 'boolean', 'vec2', 'vec3', 'vec4',
  'json', 'any', 'array', 'struct', 'enum',
]);

/**
 * Returns a human-readable problem string, or `null` when a value matches its declared type.
 * `path` is used verbatim in the message (`progress.level`, `Row[3].health`, …).
 */
export function validateField(type, value, path = 'value') {
  const spec = String(type ?? '').toLowerCase();
  if (spec.startsWith('array:')) {
    if (!Array.isArray(value)) return `${path} should be an array of ${spec.slice(6)}`;
    for (let i = 0; i < value.length; i++) {
      const problem = validateField(spec.slice(6), value[i], `${path}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (spec === 'json' || spec === 'any' || spec.startsWith('struct:') || spec.startsWith('enum:')) return null;
  if (spec === 'vec2' || spec === 'vec3' || spec === 'vec4') {
    const size = Number(spec.slice(3));
    if (Array.isArray(value)) return value.length === size ? null : `${path} needs ${size} numbers`;
    return isPlainObject(value) && ['x', 'y', 'z', 'w'].slice(0, size).every((axis) => Number.isFinite(value[axis]))
      ? null : `${path} should be a vec${size}`;
  }
  if (INTEGER_RANGES[spec]) {
    const [min, max] = INTEGER_RANGES[spec];
    if (!Number.isInteger(value)) return `${path} should be an integer (${spec})`;
    return value >= min && value <= max ? null : `${path} is outside ${spec} [${min}, ${max}]`;
  }
  if (spec === 'f32' || spec === 'f64' || spec === 'number' || spec === 'float') {
    return Number.isFinite(value) ? null : `${path} should be a finite number`;
  }
  if (spec === 'string' || spec === 'name' || spec === 'text') return typeof value === 'string' ? null : `${path} should be a string`;
  if (spec === 'bool' || spec === 'boolean') return typeof value === 'boolean' ? null : `${path} should be a boolean`;
  return null; // unknown field types are forward-compatible: never reject a save over them
}

/**
 * Parses a textual value into its declared type — the CSV/INI import path. Returns `undefined`
 * for an unparseable value so a caller can report a precise row/column error instead of silently
 * storing a string where the game expects a number.
 */
export function coerceField(type, raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return raw;
  const spec = String(type ?? '').toLowerCase();
  const text = raw.trim();
  if (spec.startsWith('array:')) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { return undefined; }
    if (!Array.isArray(parsed)) return undefined;
    const inner = spec.slice(6);
    const out = [];
    for (const item of parsed) {
      const value = coerceField(inner, typeof item === 'string' ? item : JSON.stringify(item));
      if (value === undefined) return undefined;
      out.push(value);
    }
    return out;
  }
  if (spec === 'json' || spec === 'any' || spec.startsWith('struct:')) {
    try { return JSON.parse(text); } catch { return text.length ? text : null; }
  }
  if (spec.startsWith('enum:')) return text;
  if (spec === 'vec2' || spec === 'vec3' || spec === 'vec4') {
    const parts = text.startsWith('[') ? (() => { try { return JSON.parse(text); } catch { return null; } })() : text.split(',');
    if (!Array.isArray(parts)) return undefined;
    return parts.map((part) => Number(part));
  }
  if (INTEGER_RANGES[spec] || spec === 'f32' || spec === 'f64' || spec === 'number' || spec === 'float') {
    const number = Number(text);
    return Number.isFinite(number) ? number : undefined;
  }
  if (spec === 'bool' || spec === 'boolean') {
    if (['true', '1', 'yes', 'on'].includes(text.toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(text.toLowerCase())) return false;
    return undefined;
  }
  return raw;
}

/**
 * Validates a whole object against `{ field: type }`, returning every issue (never throws).
 * `allowMissing` is for partial updates; `pathPrefix` names the object in messages.
 */
export function validateObject(schema, value, { pathPrefix = '', allowMissing = false, allowExtra = true } = {}) {
  const issues = [];
  if (!isPlainObject(value)) return [`${pathPrefix || 'value'} should be an object`];
  for (const [field, type] of Object.entries(schema ?? {})) {
    const path = pathPrefix ? `${pathPrefix}.${field}` : field;
    if (!(field in value)) { if (!allowMissing) issues.push(`${path} is missing`); continue; }
    const problem = validateField(type, value[field], path);
    if (problem) issues.push(problem);
  }
  if (!allowExtra) {
    for (const field of Object.keys(value)) {
      if (!(field in (schema ?? {}))) issues.push(`${pathPrefix ? `${pathPrefix}.` : ''}${field} is not declared`);
    }
  }
  return issues;
}

/** Coerces every declared field of a plain object (used when importing text rows). */
export function coerceObject(schema, row) {
  const out = { ...row };
  const errors = [];
  for (const [field, type] of Object.entries(schema ?? {})) {
    if (!(field in row)) continue;
    const value = coerceField(type, row[field]);
    if (value === undefined) errors.push(`${field}: cannot parse \"${row[field]}\" as ${type}`);
    else out[field] = value;
  }
  return { value: out, errors };
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && !(value instanceof Map) && !(value instanceof Set) && !(value instanceof Uint8Array);
}

/** A short report for inspectors and console help. */
export function describeFieldTypes() {
  return { types: [...FIELD_TYPES], integerRanges: Object.fromEntries(Object.entries(INTEGER_RANGES).map(([key, range]) => [key, [...range]])) };
}

export default validateField;
