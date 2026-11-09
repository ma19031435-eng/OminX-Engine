/**
 * OminX Engine — WGSL uniform layout.
 *
 * WebGPU has no `glGetUniformLocation`: a uniform buffer is a raw byte range and the shader's
 * `struct` defines the layout. This module reads the `struct Uniforms { … }` block out of a WGSL
 * program and computes member offsets with the WGSL *uniform address space* alignment rules, so
 * `WebGPUShader.apply('uModelMatrix', matrix)` can write straight into a Float32Array slab.
 *
 * Rules implemented (WGSL spec §address space layout constraints):
 *   scalar 4/4 · vec2 8/8 · vec3 16/12 · vec4 16/16 · matCxR = array<vecR, C>
 *   `array<E, N>`: align = roundUp(align(E), 16), stride = roundUp(size(E), align(E), 16)
 *   `struct`: align = roundUp(max member align, 16), size = roundUp(last offset + size, align)
 *
 * Every offset produced here is cross-checked against `wgsl_reflect` in `tests/webgpu.test.js`,
 * so a WGSL edit that changes the layout cannot silently desync the CPU-side writer.
 *
 * @module engine/src/renderer/wgsl/layout
 */

const SCALARS = {
  f32: { size: 4, align: 4 },
  i32: { size: 4, align: 4 },
  u32: { size: 4, align: 4 },
  f16: { size: 2, align: 2 },
  bool: { size: 4, align: 4 },
};

/** WGSL predeclared aliases → canonical names. */
const ALIASES = { float: 'f32', int: 'i32', uint: 'u32', vec2f: 'vec2<f32>', vec3f: 'vec3<f32>', vec4f: 'vec4<f32>', vec2i: 'vec2<i32>', vec3i: 'vec3<i32>', vec4i: 'vec4<i32>', vec2u: 'vec2<u32>', vec3u: 'vec3<u32>', vec4u: 'vec4<u32>', mat4x4f: 'mat4x4<f32>', mat3x3f: 'mat3x3<f32>', mat2x2f: 'mat2x2<f32>' };

/** Splits a struct body on top-level commas — `array<vec3f, 4>` must survive intact. */
export function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '<' || char === '(') depth++;
    else if (char === '>' || char === ')') depth = Math.max(0, depth - 1);
    if ((char === ',' || char === '\n') && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

export function roundUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

/** Normalises a WGSL type expression (`vec3<f32>`, `vec3f`, `array<mat4x4<f32>, 4>`). */
export function normalizeType(raw) {
  const text = String(raw).replace(/\s+/g, '');
  return ALIASES[text] ?? text;
}

/**
 * Computes size/align for a WGSL type inside the uniform address space.
 * @param {string} type
 * @param {Map<string, {size:number, align:number, members?:Map<string,{offset:number,size:number,align:number,type:string}>}>} [structs]
 */
export function measureType(type, structs = new Map()) {
  const t = normalizeType(type);
  if (SCALARS[t]) return { ...SCALARS[t], type: t };

  let m = /^vec([234])<(\w+)>$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const scalar = m[2];
    const base = SCALARS[scalar] ?? SCALARS.f32;
    // Alignment is the size of a 2-component vector for vec2, otherwise a full 4-lane vector.
    return { size: n * base.size, align: n === 2 ? 2 * base.align : 4 * base.align, type: t, components: n, scalar };
  }
  m = /^mat(\d)x(\d)<(\w+)>$/.exec(t);
  if (m) {
    const columns = Number(m[1]);
    const rows = Number(m[2]);
    const col = measureType(`vec${rows}<${m[3]}>`, structs);
    // A matrix is an array of `columns` column vectors, each padded to the column alignment:
    // mat3x3<f32> occupies 48 bytes (three 16-byte strides) even though only 36 hold data.
    const stride = roundUp(col.size, col.align);
    return { size: stride * columns, align: col.align, stride, type: t };
  }
  m = /^array<(.+),([A-Za-z0-9_]+)>$/.exec(t);
  if (m) {
    const element = measureType(m[1], structs);
    const count = Number(m[2]);
    const align = roundUp(element.align, 16);
    const stride = roundUp(element.size, element.align, 16);
    return { size: stride * count, align, stride, count, elementSize: element.size, elementAlign: element.align, type: t };
  }
  const struct = structs.get(t);
  if (struct) return { size: struct.size, align: struct.align, type: t, struct };
  // Unknown: treat as a vec4 so downstream maths does not explode.
  return { size: 16, align: 16, type: t, unknown: true };
}

/**
 * Parses a WGSL source and returns every struct it declares.
 * @returns {Map<string, {name:string, members:Map<string, object>, align:number, size:number}>}
 */
export function parseStructs(source) {
  const structs = new Map();
  const re = /struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    structs.set(m[1], { name: m[1], members: new Map(), align: 16, size: 0, order: [] });
  }
  // Two passes so structs can contain structs declared later in the file.
  for (let pass = 0; pass < 2; pass++) {
    for (const struct of structs.values()) {
      const body = new RegExp(`struct\\s+${struct.name}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
      struct.members.clear();
      struct.order = [];
      let offset = 0;
      let maxAlign = 1;
      for (const rawLine of splitTopLevel(body)) {
        const line = rawLine.replace(/\/\/.*$/, '').trim();
        if (!line) continue;
        const member = /^@?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(line);
        if (!member) continue;
        const [, name, typeRaw] = member;
        const type = typeRaw.trim();
        const info = measureType(type, structs);
        const memberOffset = roundUp(offset, info.align);
        struct.members.set(name, {
          name,
          type,
          offset: memberOffset,
          size: info.size,
          align: info.align,
          stride: info.stride ?? 0,
          count: info.count ?? 0,
          components: info.components ?? 0,
          scalar: info.scalar ?? null,
          elementSize: info.elementSize ?? 0,
        });
        struct.order.push(name);
        offset = memberOffset + info.size;
        maxAlign = Math.max(maxAlign, info.align);
      }
      struct.align = roundUp(maxAlign, 16);
      struct.size = roundUp(offset, struct.align);
    }
  }
  return structs;
}

/**
 * Computes the uniform block layout for a WGSL program.
 * @param {string} source complete WGSL source
 * @param {string} [structName]
 */
export function parseUniformLayout(source, structName = 'Uniforms') {
  const structs = parseStructs(source);
  const struct = structs.get(structName);
  if (!struct) return { name: structName, size: 0, align: 16, members: new Map(), order: [], missing: true };
  return { name: structName, size: struct.size, align: struct.align, members: struct.members, order: struct.order, structs };
}

/**
 * Reads `@group(g) @binding(b) var<…> name: type;` declarations.
 * @returns {{uniforms: object[], textures: object[], samplers: object[], storage: object[]}}
 */
export function parseBindings(source) {
  const uniforms = [];
  const textures = [];
  const samplers = [];
  const storage = [];
  const re = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([a-z_]+)>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(source))) {
    const entry = { group: Number(m[1]), binding: Number(m[2]), addressSpace: m[3] ?? 'handle', name: m[4], type: m[5].trim() };
    if (addressSpaceIsUniform(entry)) uniforms.push(entry);
    else if (entry.type.startsWith('texture_')) textures.push(entry);
    else if (entry.type.startsWith('sampler')) samplers.push(entry);
    else storage.push(entry);
  }
  return { uniforms, textures, samplers, storage };
}

function addressSpaceIsUniform(entry) {
  return entry.addressSpace === 'uniform' || entry.addressSpace === 'immediate';
}

/**
 * Describes the vertex inputs a program consumes, derived from its WGSL entry point, so the
 * device can build a `GPUVertexState` from the same attribute tables the GL backend uses.
 */
export function parseVertexInputs(source, entry = 'vs_main') {
  const inputs = [];
  const signature = findEntryParameters(source, '@vertex', entry);
  if (!signature) return inputs;
  for (const param of splitTopLevel(signature.body)) {
    const match = /@location\((\d+)\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>\s,]+)/.exec(param);
    if (!match) continue;
    inputs.push({ location: Number(match[1]), name: match[2], type: normalizeType(match[3].trim()) });
  }
  return inputs;
}

/**
 * Walks a shader stage entry point and returns its parameter list body.
 *
 * A plain regex cannot do this: parameters are annotated with `@location(0)`, so any `[^)]*`
 * capture stops at the annotation's own closing parenthesis. This scans with a depth counter,
 * which also survives multi-line signatures and trailing commas.
 *
 * @param {string} source WGSL
 * @param {string} stage '@vertex' | '@fragment' | '@compute'
 * @param {string} entry entry-point name
 * @returns {{body: string}|null}
 */
export function findEntryParameters(source, stage, entry) {
  const header = new RegExp(`${stage}\\s*\\n?\\s*fn\\s+${entry}\\s*\\(`, 'g').exec(source);
  if (!header) return null;
  let depth = 0;
  let start = header.index + header[0].length;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return { body: source.slice(start, i) };
      depth--;
    }
  }
  return null;
}

export default parseUniformLayout;
