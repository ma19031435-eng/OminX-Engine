/**
 * OminX Engine — versioned serialization (the `FArchive` layer).
 *
 * Save files, replays, network snapshots, editor projects and cooked asset bundles all need the same
 * three things: a stable byte layout, a version number to migrate from, and a schema so the reader
 * does not depend on the writer's property order. This module provides exactly that, in two flavours
 * that share one schema:
 *
 *   - `BinaryArchive` — compact little-endian writer/reader with a string table (repeated names cost
 *     two bytes), used for save games, replays, network payloads and cooked bundles.
 *   - `JsonArchive` — the same schema as readable JSON, used for project files, fixtures and diffs.
 *
 * Schemas are declared once with `defineStruct('Transform', { position: 'vec3', … })` and both
 * archives read and write them, which is what makes it possible to diff a binary save against a
 * JSON one in a test. Field types cover everything the engine stores: primitives, vectors,
 * quaternions, colours, strings, byte blobs, enums, arrays, maps, nested structs and object
 * references (by id, with an optional resolver).
 *
 * **Versioning.** Every archive carries a format version and a user version. `ArchiveReader.migrate`
 * runs the registered upgrade chain (`migrateStruct('SaveGame', 3, (data) => …)`) so an old save keeps
 * loading after a schema change — the part that is always skipped until it is too late.
 *
 * @module engine/src/core/Archive
 */
import { createLogger } from './Logger.js';

const log = createLogger('Archive');

export const ARCHIVE_MAGIC = 0x4f4d4e58; // 'OMNX'
export const ARCHIVE_VERSION = 1;

/** Field kinds understood by both archives. */
export const FieldType = {
  Bool: 'bool',
  U8: 'u8',
  U16: 'u16',
  U32: 'u32',
  I8: 'i8',
  I16: 'i16',
  I32: 'i32',
  F32: 'f32',
  F64: 'f64',
  String: 'string',
  Bytes: 'bytes',
  Vec2: 'vec2',
  Vec3: 'vec3',
  Vec4: 'vec4',
  Quat: 'quat',
  Color: 'color',
  ObjectRef: 'object',
  Array: 'array',
  Map: 'map',
  Struct: 'struct',
};

const PRIMITIVE_WRITERS = {
  bool: (archive, value) => archive.writeBool(value),
  u8: (archive, value) => archive.writeUint8(value),
  u16: (archive, value) => archive.writeUint16(value),
  u32: (archive, value) => archive.writeUint32(value),
  i8: (archive, value) => archive.writeInt8(value),
  i16: (archive, value) => archive.writeInt16(value),
  i32: (archive, value) => archive.writeInt32(value),
  f32: (archive, value) => archive.writeFloat32(value),
  f64: (archive, value) => archive.writeFloat64(value),
  string: (archive, value) => archive.writeString(value ?? ''),
  bytes: (archive, value) => archive.writeBytes(value),
  vec2: (archive, value) => archive.writeVec2(value),
  vec3: (archive, value) => archive.writeVec3(value),
  vec4: (archive, value) => archive.writeVec4(value),
  quat: (archive, value) => archive.writeQuat(value),
  color: (archive, value) => archive.writeColor(value),
  object: (archive, value) => archive.writeObjectRef(value),
};

const PRIMITIVE_READERS = {
  bool: (archive) => archive.readBool(),
  u8: (archive) => archive.readUint8(),
  u16: (archive) => archive.readUint16(),
  u32: (archive) => archive.readUint32(),
  i8: (archive) => archive.readInt8(),
  i16: (archive) => archive.readInt16(),
  i32: (archive) => archive.readInt32(),
  f32: (archive) => archive.readFloat32(),
  f64: (archive) => archive.readFloat64(),
  string: (archive) => archive.readString(),
  bytes: (archive) => archive.readBytes(),
  vec2: (archive) => archive.readVec2(),
  vec3: (archive) => archive.readVec3(),
  vec4: (archive) => archive.readVec4(),
  quat: (archive) => archive.readQuat(),
  color: (archive) => archive.readColor(),
  object: (archive) => archive.readObjectRef(),
};

/** Parses `array:vec3`, `struct:Transform`, `map:string:f32` into `{ base, element, key }`. */
export function parseFieldType(type) {
  if (typeof type !== 'string') return { base: FieldType.Struct, struct: type };
  const colon = type.indexOf(':');
  if (colon < 0) return { base: type };
  const base = type.slice(0, colon);
  const rest = type.slice(colon + 1);
  if (base === 'array') return { base, element: parseFieldType(rest) };
  if (base === 'map') {
    const second = rest.indexOf(':');
    return { base, key: parseFieldType(rest.slice(0, second)), element: parseFieldType(rest.slice(second + 1)) };
  }
  if (base === 'struct') return { base, struct: rest };
  return { base, element: parseFieldType(rest) };
}

/** @type {Map<string, {name: string, fields: Array<{name: string, type: string}>, version: number}>} */
const STRUCT_REGISTRY = new Map();
/** @type {Map<string, Array<{version: number, migrate: Function}>>} */
const MIGRATIONS = new Map();

/**
 * Declares a struct layout. Field order is the binary layout; JSON archives write the field names,
 * which is why a JSON file stays readable and diffable while bytes stay compact.
 */
export function defineStruct(name, fields, { version = 1 } = {}) {
  const entries = Array.isArray(fields)
    ? fields.map((field) => (typeof field === 'string' ? { name: field, type: FieldType.F64 } : field))
    : Object.entries(fields).map(([fieldName, type]) => ({ name: fieldName, type }));
  const record = { name, fields: entries, version };
  STRUCT_REGISTRY.set(name, record);
  return record;
}

export function getStruct(name) { return STRUCT_REGISTRY.get(name) ?? null; }
export function listStructs() { return [...STRUCT_REGISTRY.values()].map((record) => ({ ...record })); }

/** Registers an upgrade step for a struct written by version `fromVersion`. */
export function migrateStruct(name, fromVersion, migrate) {
  if (!MIGRATIONS.has(name)) MIGRATIONS.set(name, []);
  MIGRATIONS.get(name).push({ version: fromVersion, migrate });
  MIGRATIONS.get(name).sort((a, b) => a.version - b.version);
  return migrate;
}

/** Runs the migration chain for a decoded plain object. */
export function applyMigrations(name, data, fromVersion) {
  const chain = MIGRATIONS.get(name) ?? [];
  let current = data;
  let version = fromVersion;
  for (const step of chain) {
    if (step.version < version) continue;
    current = step.migrate(current, version) ?? current;
    version = step.version + 1;
  }
  return current;
}

// ---------------------------------------------------------------------------
// binary archive
// ---------------------------------------------------------------------------

/**
 * Little-endian binary writer. Grows by doubling (writer) and keeps a string table so repeated
 * strings cost 2 bytes after the first occurrence.
 */
export class BinaryArchive {
  constructor({ capacity = 1024, stringTable = true } = {}) {
    this.buffer = new ArrayBuffer(capacity);
    this.view = new DataView(this.buffer);
    this.offset = 0;
    this.stringTable = stringTable;
    this._strings = new Map();
    this._stringList = [];
    this.stringTableWrites = 0;
    this.bytesWritten = 0;
  }

  get size() { return this.offset; }

  _ensure(bytes) {
    if (this.offset + bytes <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength * 2;
    while (capacity < this.offset + bytes) capacity *= 2;
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(new Uint8Array(this.buffer));
    this.buffer = next;
    this.view = new DataView(next);
  }

  writeUint8(value) { this._ensure(1); this.view.setUint8(this.offset, value & 0xff); this.offset += 1; return this; }
  writeInt8(value) { this._ensure(1); this.view.setInt8(this.offset, value | 0); this.offset += 1; return this; }
  writeBool(value) { return this.writeUint8(value ? 1 : 0); }
  writeUint16(value) { this._ensure(2); this.view.setUint16(this.offset, value & 0xffff, true); this.offset += 2; return this; }
  writeInt16(value) { this._ensure(2); this.view.setInt16(this.offset, value | 0, true); this.offset += 2; return this; }
  writeUint32(value) { this._ensure(4); this.view.setUint32(this.offset, value >>> 0, true); this.offset += 4; return this; }
  writeInt32(value) { this._ensure(4); this.view.setInt32(this.offset, value | 0, true); this.offset += 4; return this; }
  writeFloat32(value) { this._ensure(4); this.view.setFloat32(this.offset, Number(value) || 0, true); this.offset += 4; return this; }
  writeFloat64(value) { this._ensure(8); this.view.setFloat64(this.offset, Number(value) || 0, true); this.offset += 8; return this; }

  /** Length-prefixed UTF-8, deduplicated through the string table. */
  writeString(value) {
    const text = value ?? '';
    if (this.stringTable) {
      const known = this._strings.get(text);
      if (known !== undefined) { this.writeUint16(0xffff); this.writeUint16(known); return this; }
      this._strings.set(text, this._stringList.length);
      this._stringList.push(text);
      this.stringTableWrites++;
    }
    const bytes = utf8Encode(text);
    this.writeUint16(bytes.length);
    this._ensure(bytes.length);
    new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes);
    this.offset += bytes.length;
    return this;
  }

  writeBytes(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
    this.writeUint32(bytes.length);
    this._ensure(bytes.length);
    new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes);
    this.offset += bytes.length;
    return this;
  }

  writeVec2(v) { return this.writeFloat32(v?.x ?? 0).writeFloat32(v?.y ?? 0); }
  writeVec3(v) { return this.writeFloat32(v?.x ?? 0).writeFloat32(v?.y ?? 0).writeFloat32(v?.z ?? 0); }
  writeVec4(v) { return this.writeFloat32(v?.x ?? 0).writeFloat32(v?.y ?? 0).writeFloat32(v?.z ?? 0).writeFloat32(v?.w ?? 0); }
  writeQuat(q) { return this.writeFloat32(q?.x ?? 0).writeFloat32(q?.y ?? 0).writeFloat32(q?.z ?? 0).writeFloat32(q?.w ?? 1); }
  writeColor(c) { return this.writeFloat32(c?.r ?? 0).writeFloat32(c?.g ?? 0).writeFloat32(c?.b ?? 0).writeFloat32(c?.a ?? 1); }

  /** Object references travel as ids (`0` = null) and are resolved by the reader. */
  writeObjectRef(object) { return this.writeInt32(object?.id ?? 0); }

  /** Overwrites a previously reserved u32 (used to patch section lengths). */
  patchUint32(slot, value) {
    this.view.setUint32(slot, value >>> 0, true);
    return this;
  }

  /** Appends the deduplicated string table and returns the whole payload. */
  finishWithTable() {
    const tableOffset = this.offset;
    this.writeUint16(this._stringList.length);
    for (const text of this._stringList) {
      const bytes = utf8Encode(text);
      this.writeUint16(bytes.length);
      this._ensure(bytes.length);
      new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes);
      this.offset += bytes.length;
    }
    this.stringTableOffset = tableOffset;
    return this.finish();
  }

  /** Bytes written so far (no string table). */
  finish() {
    const out = this.buffer.slice(0, this.offset);
    this.bytesWritten = out.byteLength;
    return out;
  }

  toUint8Array() { return new Uint8Array(this.finish()); }
}

/** Reader that mirrors `BinaryArchive` and resolves the string table. */
export class BinaryArchiveReader {
  constructor(data) {
    const buffer = data instanceof ArrayBuffer
      ? data
      : data.buffer.slice(data.byteOffset ?? 0, (data.byteOffset ?? 0) + data.byteLength);
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.offset = 0;
    this._strings = null;
  }

  get remaining() { return this.buffer.byteLength - this.offset; }
  get size() { return this.buffer.byteLength; }

  readUint8() { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  readInt8() { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
  readBool() { return this.readUint8() === 1; }
  readUint16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  readInt16() { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  readUint32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  readInt32() { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  readFloat32() { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  readFloat64() { const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }

  readString() {
    const length = this.readUint16();
    if (length === 0xffff) {
      const index = this.readUint16();
      const table = this._readStringTable();
      return table[index] ?? '';
    }
    const bytes = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return utf8Decode(bytes);
  }

  readBytes() {
    const length = this.readUint32();
    const bytes = new Uint8Array(this.buffer.slice(this.offset, this.offset + length));
    this.offset += length;
    return bytes;
  }

  readVec2() { return { x: this.readFloat32(), y: this.readFloat32() }; }
  readVec3() { return { x: this.readFloat32(), y: this.readFloat32(), z: this.readFloat32() }; }
  readVec4() { return { x: this.readFloat32(), y: this.readFloat32(), z: this.readFloat32(), w: this.readFloat32() }; }
  readQuat() { return { x: this.readFloat32(), y: this.readFloat32(), z: this.readFloat32(), w: this.readFloat32() }; }
  readColor() { return { r: this.readFloat32(), g: this.readFloat32(), b: this.readFloat32(), a: this.readFloat32() }; }
  readObjectRef(resolver = null) {
    const id = this.readInt32();
    if (!id) return null;
    return resolver ? resolver(id) : { id };
  }

  /**
   * The payload's first u32 holds the offset of the string table, which the writer patches once the
   * payload is complete — the table itself is appended at the end. Self-describing, so the reader
   * never has to guess where the table starts.
   */
  _readStringTable() {
    if (this._strings) return this._strings;
    const table = [];
    this._strings = table;
    if (this.buffer.byteLength < 4) return table;
    const tableOffset = this.view.getUint32(0, true);
    if (tableOffset < 4 || tableOffset + 2 > this.buffer.byteLength) return table;
    try {
      const count = this.view.getUint16(tableOffset, true);
      let read = tableOffset + 2;
      for (let i = 0; i < count; i++) {
        const length = this.view.getUint16(read, true);
        read += 2;
        table.push(utf8Decode(new Uint8Array(this.buffer, read, length)));
        read += length;
      }
    } catch {
      table.length = 0;   // malformed table: inline strings still work
    }
    return table;
  }

  /** Raw slice of the payload, for lazy per-section decoding. */
  sliceFrom(offset, length) {
    return this.buffer.slice(offset, offset + length);
  }
}

function utf8Encode(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(bytes);
}

function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i++];
    if (byte < 0x80) out += String.fromCharCode(byte);
    else if (byte < 0xe0) out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else out += String.fromCharCode(((byte & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
  }
  return out;
}

// ---------------------------------------------------------------------------
// json archive
// ---------------------------------------------------------------------------

/** Readable counterpart of `BinaryArchive`: same schema, plain objects. */
export class JsonArchive {
  constructor() {
    this.data = {};
    this.stringTableWrites = 0;
    this.bytesWritten = 0;
  }

  writeBool(value) { return value; }
  writeUint8(value) { return value; }
  writeUint16(value) { return value; }
  writeUint32(value) { return value; }
  writeInt32(value) { return value; }
  writeFloat32(value) { return value; }
  writeFloat64(value) { return value; }
  writeString(value) { return value ?? ''; }
  writeBytes(value) { return value instanceof Uint8Array ? Array.from(value) : value; }
  writeVec2(v) { return { x: v?.x ?? 0, y: v?.y ?? 0 }; }
  writeVec3(v) { return { x: v?.x ?? 0, y: v?.y ?? 0, z: v?.z ?? 0 }; }
  writeVec4(v) { return this.writeVec3(v) && { x: v?.x ?? 0, y: v?.y ?? 0, z: v?.z ?? 0, w: v?.w ?? 0 }; }
  writeQuat(q) { return { x: q?.x ?? 0, y: q?.y ?? 0, z: q?.z ?? 0, w: q?.w ?? 1 }; }
  writeColor(c) { return { r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0, a: c?.a ?? 1 }; }
  writeObjectRef(object) { return object?.id ?? 0; }

  toJSON() { return this.data; }
  toString(space = 2) { return JSON.stringify(this.data, null, space); }
}

// ---------------------------------------------------------------------------
// schema-driven struct IO
// ---------------------------------------------------------------------------

function writeValue(archive, parsed, value) {
  const primitive = PRIMITIVE_WRITERS[parsed.base];
  if (primitive) return primitive(archive, value);
  if (parsed.base === FieldType.Array) {
    const items = Array.isArray(value) ? value : [];
    archive.writeUint32(items.length);
    for (const item of items) writeValue(archive, parsed.element, item);
    return archive;
  }
  if (parsed.base === FieldType.Map) {
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
    archive.writeUint32(entries.length);
    for (const [key, item] of entries) {
      writeValue(archive, parsed.key, key);
      writeValue(archive, parsed.element, item);
    }
    return archive;
  }
  if (parsed.base === FieldType.Struct) {
    const record = typeof parsed.struct === 'string' ? getStruct(parsed.struct) : parsed.struct;
    if (!record) throw new Error(`unknown struct "${parsed.struct}"`);
    return writeStruct(archive, record, value);
  }
  throw new Error(`unsupported field type "${parsed.base}"`);
}

function readValue(archive, parsed, resolver = null) {
  const primitive = PRIMITIVE_READERS[parsed.base];
  if (primitive) {
    if (parsed.base === FieldType.ObjectRef) return archive.readObjectRef(resolver);
    return primitive(archive);
  }
  if (parsed.base === FieldType.Array) {
    const count = archive.readUint32();
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = readValue(archive, parsed.element, resolver);
    return out;
  }
  if (parsed.base === FieldType.Map) {
    const count = archive.readUint32();
    const out = new Map();
    for (let i = 0; i < count; i++) out.set(readValue(archive, parsed.key, resolver), readValue(archive, parsed.element, resolver));
    return out;
  }
  if (parsed.base === FieldType.Struct) {
    const record = typeof parsed.struct === 'string' ? getStruct(parsed.struct) : parsed.struct;
    if (!record) throw new Error(`unknown struct "${parsed.struct}"`);
    return readStruct(archive, record, resolver);
  }
  throw new Error(`unsupported field type "${parsed.base}"`);
}

/** Writes a struct (declared via `defineStruct`) into either archive. */
export function writeStruct(archive, record, value) {
  const target = value ?? {};
  for (const field of record.fields) {
    const parsed = parseFieldType(field.type);
    writeValue(archive, parsed, target[field.name]);
  }
  return archive;
}

/** Reads a struct; unknown/missing fields fall back to `null` rather than throwing. */
export function readStruct(archive, record, resolver = null) {
  const out = {};
  for (const field of record.fields) {
    const parsed = parseFieldType(field.type);
    try {
      out[field.name] = readValue(archive, parsed, resolver);
    } catch (error) {
      log.warn(`failed reading ${record.name}.${field.name}: ${error.message}`);
      out[field.name] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

/** Payload kinds a save/bundle can contain; the kind is written into the header. */
export const PayloadKind = {
  Save: 'save',
  Replay: 'replay',
  Project: 'project',
  Bundle: 'bundle',
  Snapshot: 'snapshot',
  Custom: 'custom',
};

/**
 * A versioned archive payload: header (`magic`, format version, kind, user version) plus named
 * sections written with a schema. Sections are length-prefixed so an unknown section can be skipped
 * by a newer engine.
 */
export class ArchiveWriter {
  constructor({ kind = PayloadKind.Custom, version = 1, format = 'binary', capacity = 4096 } = {}) {
    this.kind = kind;
    this.version = version;
    this.format = format;
    this.sections = [];
    if (format === 'json') {
      this.archive = new JsonArchive();
      this.archive.data = { magic: 'OMNX', format: ARCHIVE_VERSION, kind, version, sections: {} };
      return;
    }
    this.archive = new BinaryArchive({ capacity });
    // First u32 is reserved for the string-table offset; the table is appended at `finish()`.
    this.archive.writeUint32(0);
  }

  /**
   * Writes a named section using a declared struct. The section name is what a reader asks for; the
   * struct name travels with it so the reader can use the right schema (and a newer engine can skip
   * sections it does not know).
   */
  section(name, structName, value) {
    const record = typeof structName === 'string' ? getStruct(structName) : structName;
    if (!record) throw new Error(`ArchiveWriter.section: unknown struct "${structName}"`);
    if (this.format === 'json') {
      this.archive.data.sections[name] = {
        struct: record.name,
        version: record.version,
        data: jsonStructValue(record, value),
      };
      this.sections.push({ name, struct: record.name, bytes: 0 });
      return this;
    }
    const archive = this.archive;
    archive.writeString(name);
    archive.writeString(record.name);
    archive.writeUint16(record.version);
    const lengthSlot = archive.offset;
    archive.writeUint32(0);
    const payloadStart = archive.offset;
    writeStruct(archive, record, value);
    const length = archive.offset - payloadStart;
    archive.patchUint32(lengthSlot, length);
    this.sections.push({ name, struct: record.name, bytes: length });
    return this;
  }

  /** Writes an ad-hoc section whose schema is inferred from the value (small payloads, settings). */
  sectionInferred(name, value) {
    const record = defineStruct(`__inferred_${name}`, inferFields(value), { version: 1 });
    return this.section(name, record, value);
  }

  /** Serializes: `Uint8Array` for binary, JSON text for `format: 'json'`. */
  finish() {
    if (this.format === 'json') return this.archive.toString();
    const archive = this.archive;
    const payload = archive.finishWithTable();
    archive.patchUint32(0, archive.stringTableOffset);
    const bytes = archive.finish();
    const header = new ArrayBuffer(12);
    const view = new DataView(header);
    view.setUint32(0, ARCHIVE_MAGIC, true);
    view.setUint16(4, ARCHIVE_VERSION, true);
    view.setUint16(6, this.version, true);
    view.setUint8(8, kindIndex(this.kind));
    view.setUint8(9, this.sections.length);
    const out = new Uint8Array(header.byteLength + bytes.byteLength);
    out.set(new Uint8Array(header), 0);
    out.set(new Uint8Array(bytes), header.byteLength);
    void payload;
    return out;
  }

  toUint8Array() { return this.finish(); }
  toString() { return this.format === 'json' ? this.finish() : new TextDecoder().decode(this.finish()); }
}

function kindIndex(kind) {
  const list = Object.values(PayloadKind);
  const index = list.indexOf(kind);
  return index < 0 ? 0xff : index;
}

function kindFromIndex(index) {
  return Object.values(PayloadKind)[index] ?? PayloadKind.Custom;
}

/**
 * Reads an archive written by `ArchiveWriter`. Sections are decoded on demand, so a reader that only
 * wants one section never pays for the rest, and object references can be resolved with a caller
 * supplied registry at the moment they are read.
 */
export class ArchiveReader {
  constructor(bytes) {
    /** @type {Map<string, {name: string, struct: string, version: number, data?: any, offset?: number, length?: number}>} */
    this.sections = new Map();
    this.readErrors = [];
    if (typeof bytes === 'string') {
      const parsed = JSON.parse(bytes);
      this.format = 'json';
      this.kind = parsed.kind ?? PayloadKind.Custom;
      this.version = parsed.version ?? 1;
      this.json = parsed;
      this.archive = null;
      for (const [name, section] of Object.entries(parsed.sections ?? {})) {
        this.sections.set(name, { name, struct: section.struct, version: section.version ?? 1, data: section.data });
      }
      return;
    }
    this.format = 'binary';
    const buffer = bytes.buffer ?? bytes;
    const byteOffset = bytes.byteOffset ?? 0;
    const view = new DataView(buffer, byteOffset, bytes.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== ARCHIVE_MAGIC) throw new Error('not an OminX archive (bad magic)');
    this.formatVersion = view.getUint16(4, true);
    this.version = view.getUint16(6, true);
    this.kind = kindFromIndex(view.getUint8(8));
    this.sectionCount = view.getUint8(9);
    const payloadStart = byteOffset + 12;
    this.archive = new BinaryArchiveReader(buffer.slice(payloadStart, payloadStart + (bytes.byteLength - 12)));
    // The payload opens with the string-table offset (4 bytes) reserved by the writer; section
    // data starts after it.
    this.archive.offset = 4;
    this._scanSections();
  }

  /** Walks the section directory (names, schemas, lengths) without decoding any payload. */
  _scanSections() {
    const archive = this.archive;
    const directory = [];
    for (let i = 0; i < (this.sectionCount ?? 0); i++) {
      try {
        const name = archive.readString();
        const struct = archive.readString();
        const version = archive.readUint16();
        const length = archive.readUint32();
        directory.push({ name, struct, version, offset: archive.offset, length });
        archive.offset += length;
      } catch (error) {
        this.readErrors.push(error);
        break;
      }
    }
    this.directory = directory;
    for (const entry of directory) this.sections.set(entry.name, entry);
  }

  /** Decoded data for a section by name (or by struct name when unambiguous). */
  read(name, { resolver = null } = {}) {
    let section = this.sections.get(name);
    if (!section) {
      const matches = [...this.sections.values()].filter((entry) => entry.struct === name);
      if (matches.length === 1) section = matches[0];
      else if (matches.length > 1) {
        // Several sections share a schema: return them all under the struct name.
        return matches.map((entry) => this._decode(entry, resolver));
      }
    }
    if (!section) return null;
    return this._decode(section, resolver);
  }

  /** Every section that uses a given struct — `readAll('ActorRecord')` for a roster. */
  readAll(structName, { resolver = null } = {}) {
    return [...this.sections.values()]
      .filter((entry) => entry.struct === structName)
      .map((entry) => this._decode(entry, resolver));
  }

  _decode(section, resolver = null) {
    if (section.data !== undefined) return section.data;
    if (this.format !== 'binary' || !section.length) return section.data ?? null;
    const record = getStruct(section.struct);
    if (!record) return null;
    const archive = new BinaryArchiveReader(this.archive.sliceFrom(section.offset, section.length));
    const data = readStruct(archive, record, resolver);
    const migrated = section.version < record.version ? applyMigrations(section.struct, data, section.version) : data;
    section.data = migrated;      // cache: repeated reads stay cheap
    return migrated;
  }

  has(name) { return this.sections.has(name); }
  list() { return [...this.sections.keys()]; }
  /** Section metadata without decoding (bundle browsers, save-file inspectors). */
  describe() {
    return {
      format: this.format,
      kind: this.kind,
      version: this.version,
      sections: [...this.sections.values()].map((entry) => ({
        name: entry.name, struct: entry.struct, version: entry.version, bytes: entry.length ?? null,
      })),
    };
  }
}

/** Convenience: write one struct into a one-section archive. */
export function encodeStruct(structName, value, { kind = PayloadKind.Custom, version = 1, section = 'main' } = {}) {
  const writer = new ArchiveWriter({ kind, version });
  writer.section(section, structName, value);
  return writer.finish();
}

/** Convenience: read that one section back. */
export function decodeStruct(structName, bytes, options = {}) {
  const reader = new ArchiveReader(bytes);
  return reader.read(options.section ?? 'main', options) ?? reader.read(structName, options);
}

/** JSON helpers used by the writer for readable section payloads. */
function jsonStructValue(record, value) {
  const out = {};
  for (const field of record.fields) out[field.name] = jsonValue(parseFieldType(field.type), value?.[field.name]);
  return out;
}

function inferFields(value) {
  const fields = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (typeof item === 'number') fields[key] = Number.isInteger(item) ? FieldType.F32 : FieldType.F32;
    else if (typeof item === 'boolean') fields[key] = FieldType.Bool;
    else if (typeof item === 'string') fields[key] = FieldType.String;
    else if (item && typeof item === 'object' && 'x' in item && 'y' in item && 'z' in item) fields[key] = FieldType.Vec3;
    else if (Array.isArray(item)) fields[key] = `array:${item.length && typeof item[0] === 'number' ? FieldType.F32 : FieldType.String}`;
    else if (item && typeof item === 'object') fields[key] = `array:string`;
    else fields[key] = FieldType.F32;
  }
  return fields;
}

function jsonValue(parsed, value) {
  switch (parsed.base) {
    case FieldType.Bool: return !!value;
    case FieldType.String: return value ?? '';
    case FieldType.Bytes: return value instanceof Uint8Array ? Array.from(value) : (value ?? []);
    case FieldType.Vec2: return { x: value?.x ?? 0, y: value?.y ?? 0 };
    case FieldType.Vec3: return { x: value?.x ?? 0, y: value?.y ?? 0, z: value?.z ?? 0 };
    case FieldType.Vec4: return { x: value?.x ?? 0, y: value?.y ?? 0, z: value?.z ?? 0, w: value?.w ?? 0 };
    case FieldType.Quat: return { x: value?.x ?? 0, y: value?.y ?? 0, z: value?.z ?? 0, w: value?.w ?? 1 };
    case FieldType.Color: return { r: value?.r ?? 0, g: value?.g ?? 0, b: value?.b ?? 0, a: value?.a ?? 1 };
    case FieldType.ObjectRef: return value?.id ?? 0;
    case FieldType.Array: return (Array.isArray(value) ? value : []).map((item) => jsonValue(parsed.element, item));
    case FieldType.Map: {
      const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
      return Object.fromEntries(entries.map(([key, item]) => [String(key), jsonValue(parsed.element, item)]));
    }
    case FieldType.Struct: {
      const record = typeof parsed.struct === 'string' ? getStruct(parsed.struct) : parsed.struct;
      return jsonStructValue(record, value);
    }
    default: return Number(value) || 0;
  }
}

export default ArchiveWriter;
