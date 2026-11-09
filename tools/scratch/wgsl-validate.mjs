import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { preprocessWGSL } from '../../engine/src/renderer/wgsl/preprocess.js';
import { WGSL_PROGRAMS } from '../../engine/src/renderer/wgsl/index.js';
import { parseUniformLayout, parseBindings } from '../../engine/src/renderer/wgsl/layout.js';

const { geometry: GEOMETRY_PROGRAM, shadow: SHADOW_PROGRAM, viewmodel: VIEWMODEL_PROGRAM } = WGSL_PROGRAMS;
const flagSets = [
  {},
  { INSTANCED: true },
  { SKINNED: true },
  { SHADOW_CASCADES: true },
  { ALPHA_TEST: true },
  { WIND: true },
  { VERTEX_COLOR: true },
  { EMISSIVE_MAP: true },
  { INSTANCED: true, SKINNED: true, SHADOW_CASCADES: true, ALPHA_TEST: true, WIND: true, VERTEX_COLOR: true, EMISSIVE_MAP: true },
];
const cases = [
  ...Object.values(WGSL_PROGRAMS).flatMap((program) =>
    (program.featureAttributes && Object.keys(program.featureAttributes).length
      ? (Object.keys(program.featureAttributes).includes('INSTANCED') ? flagSets : [{}, { ALPHA_TEST: true }])
      : [{}]
    ).map((flags) => [program, flags])),
];
const legacyCases = [
  [GEOMETRY_PROGRAM, { INSTANCED: true, SKINNED: true, SHADOW_CASCADES: true, ALPHA_TEST: true, WIND: true, VERTEX_COLOR: true, EMISSIVE_MAP: true }],
  [GEOMETRY_PROGRAM, {}],
  [GEOMETRY_PROGRAM, { INSTANCED: true }],
  [SHADOW_PROGRAM, { INSTANCED: true, SKINNED: true, ALPHA_TEST: true }],
  [SHADOW_PROGRAM, {}],
  [VIEWMODEL_PROGRAM, {}],
];
void legacyCases;
let failed = 0;
for (const [program, flags] of cases) {
  const defines = { ...(program.defines ?? {}), ...flags };
  const code = preprocessWGSL(program.code, defines);
  const label = `${program.name} [${Object.keys(flags).join('+') || 'base'}]`;
  try {
    const reflect = new WgslReflect(code);
    const mine = parseUniformLayout(code);
    const theirs = reflect.uniforms[0];
    const members = theirs?.type?.members ?? [];
    const bad = mine.order.filter((n) => {
      const a = mine.members.get(n);
      const b = members.find((m) => m.name === n);
      return !b || a.offset !== b.offset || a.size !== b.size;
    });
    const bindings = parseBindings(code);
    console.log(
      `${bad.length === 0 ? 'ok  ' : 'BAD '} ${label.padEnd(46)}`,
      `size ${mine.size}/${theirs?.type?.size}`,
      `members ${mine.order.length}`,
      `tex ${bindings.textures.length}`,
      `samp ${bindings.samplers.length}`,
      bad.length ? `mismatch: ${bad.join(',')}` : '',
    );
    if (bad.length) failed++;
  } catch (error) {
    failed++;
    console.log(`FAIL ${label}: ${error.message.split('\n')[0]}`);
  }
}
console.log(failed ? `${failed} failure(s)` : 'all WGSL variants parse + layout-match');
