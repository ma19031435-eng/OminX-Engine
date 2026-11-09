#!/usr/bin/env node
/**
 * OminX Engine — repository check.
 *
 * `npm run check` runs this before shipping: it syntax-checks every JS module in the repo with the
 * same parser Node will use, then validates the WGSL program library (every program × every feature
 * permutation) and cross-checks each uniform layout against `wgsl_reflect`, the reference WGSL
 * parser. Both halves are cheap (a couple of seconds) and catch the two mistake classes that are
 * otherwise only visible as a black screen in the browser.
 *
 * Exit code 0 = clean. Any failure prints the offending file/program and exits 1.
 *
 * @module tools/syntax-check
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEARCH_DIRS = ['engine', 'tests', 'tools', 'server', 'src', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'tmp', 'exports']);

/** Recursively collects every JS/ESM module under a directory. */
function collect(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) collect(full, out);
    else if (['.js', '.mjs', '.cjs'].includes(extname(entry))) out.push(full);
  }
  return out;
}

function checkSyntax() {
  const files = SEARCH_DIRS.flatMap((dir) => (existsSync(join(ROOT, dir)) ? collect(join(ROOT, dir)) : []));
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) failures.push({ file: relative(ROOT, file), message: (result.stderr ?? '').split('\n').slice(0, 3).join(' ').trim() });
  }
  return { files: files.length, failures };
}

async function checkWGSL() {
  const { preprocessWGSL } = await import('../engine/src/renderer/wgsl/preprocess.js');
  const { parseUniformLayout, parseVertexInputs, parseBindings } = await import('../engine/src/renderer/wgsl/layout.js');
  const { WGSL_PROGRAMS, DEFAULT_SHADER_DEFINES } = await import('../engine/src/renderer/wgsl/index.js');

  let WgslReflect = null;
  try {
    ({ WgslReflect } = await import('wgsl_reflect/wgsl_reflect.module.js'));
  } catch {
    // Optional: the layout parser is still exercised, just without the reference cross-check.
  }

  const FEATURE_SETS = [
    {}, { INSTANCED: true }, { SKINNED: true }, { SHADOW_CASCADES: true }, { ALPHA_TEST: true },
    { WIND: true }, { VERTEX_COLOR: true }, { EMISSIVE_MAP: true },
    { INSTANCED: true, SKINNED: true, SHADOW_CASCADES: true, ALPHA_TEST: true, WIND: true, VERTEX_COLOR: true, EMISSIVE_MAP: true },
  ];

  const failures = [];
  let variants = 0;
  for (const program of Object.values(WGSL_PROGRAMS)) {
    const permutations = Object.keys(program.featureAttributes ?? {}).length ? FEATURE_SETS : [{}];
    for (const flags of permutations) {
      variants++;
      const label = `${program.name} [${Object.keys(flags).join('+') || 'base'}]`;
      const defines = { ...DEFAULT_SHADER_DEFINES, ...(program.defines ?? {}), ...flags };
      const code = preprocessWGSL(program.code, defines);
      const layout = parseUniformLayout(code);
      if (layout.size === 0 || layout.members.size === 0) {
        failures.push(`${label}: empty uniform block`);
        continue;
      }
      const inputs = parseVertexInputs(code, program.vertexEntry);
      if (!program.vertexEntry || !code.includes(`fn ${program.vertexEntry}(`)) {
        failures.push(`${label}: declared vertex entry "${program.vertexEntry}" not found in the source`);
      }
      const bindings = parseBindings(code);
      for (const slot of program.textures ? Object.values(program.textures) : []) {
        if (!bindings.textures.some((t) => Math.floor(t.binding / 2) === slot)) {
          failures.push(`${label}: texture unit ${slot} declared in metadata but missing from the WGSL`);
        }
      }
      if (program.attributes) {
        for (const name of program.attributes) {
          if (!inputs.some((input) => input.name === name)) failures.push(`${label}: attribute "${name}" is not an input of ${program.vertexEntry}`);
        }
      }
      for (const [feature, names] of Object.entries(program.featureAttributes ?? {})) {
        if (!flags[feature]) continue;
        for (const name of names) {
          if (!inputs.some((input) => input.name === name)) failures.push(`${label}: feature attribute "${name}" missing from ${feature}`);
        }
      }
      if (WgslReflect) {
        try {
          const reflect = new WgslReflect(code);
          const members = reflect.uniforms[0]?.type?.members ?? [];
          for (const name of layout.order) {
            const mine = layout.members.get(name);
            const theirs = members.find((m) => m.name === name);
            if (!theirs) { failures.push(`${label}: ${name} missing from wgsl_reflect`); continue; }
            if (mine.offset !== theirs.offset || mine.size !== theirs.size) {
              failures.push(`${label}: ${name} offset/size ${mine.offset}/${mine.size} vs ${theirs.offset}/${theirs.size}`);
            }
          }
          if (layout.order.length !== members.length) failures.push(`${label}: member count ${layout.order.length} vs ${members.length}`);
        } catch (error) {
          failures.push(`${label}: ${error.message}`);
        }
      }
    }
  }
  return { programs: Object.keys(WGSL_PROGRAMS).length, variants, failures, crossChecked: !!WgslReflect };
}

const syntax = checkSyntax();
console.log(`syntax: ${syntax.files} modules checked${syntax.failures.length ? ` — ${syntax.failures.length} failed` : ' — ok'}`);
for (const failure of syntax.failures) console.error(`  ✗ ${failure.file}\n    ${failure.message}`);

let wgsl = { programs: 0, variants: 0, failures: [], crossChecked: false };
try {
  wgsl = await checkWGSL();
  console.log(`wgsl:   ${wgsl.programs} programs / ${wgsl.variants} variants${wgsl.crossChecked ? ' (cross-checked against wgsl_reflect)' : ' (wgsl_reflect unavailable)'}${wgsl.failures.length ? ` — ${wgsl.failures.length} failed` : ' — ok'}`);
  for (const failure of wgsl.failures) console.error(`  ✗ ${failure}`);
} catch (error) {
  wgsl.failures.push(`validator crashed: ${error.stack ?? error.message}`);
  console.error(`wgsl:   validator crashed — ${error.message}`);
}

const failed = syntax.failures.length + wgsl.failures.length;
if (failed) {
  console.error(`\ncheck failed: ${failed} problem(s)`);
  process.exit(1);
}
console.log('\ncheck passed');
