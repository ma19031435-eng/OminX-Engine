import * as S from '../../engine/src/renderer/shaders/index.js';
const progs = {
  geometry: [S.GEOMETRY_VERTEX, S.GEOMETRY_FRAGMENT], shadow: [S.SHADOW_VERTEX, S.SHADOW_FRAGMENT],
  sky: [S.SKY_VERTEX, S.SKY_FRAGMENT], decal: [S.DECAL_VERTEX, S.DECAL_FRAGMENT],
  particle: [S.PARTICLE_VERTEX, S.PARTICLE_FRAGMENT], sprite: [S.SPRITE_VERTEX, S.SPRITE_FRAGMENT],
  line: [S.LINE_VERTEX, S.LINE_FRAGMENT], tracer: [S.TRACER_VERTEX, S.TRACER_FRAGMENT],
  viewmodel: [S.VIEWMODEL_VERTEX, S.VIEWMODEL_FRAGMENT], fullscreen: [S.FULLSCREEN_VERTEX, null],
  bright: [null, S.POST_BRIGHT_PASS], blur: [null, S.POST_BLUR_PASS], composite: [null, S.POST_COMPOSITE],
  fxaa: [null, S.POST_FXAA], dof: [null, S.POST_DOF], ssao: [null, S.POST_SSAO],
  applySsao: [null, S.POST_APPLY_SSAO], normalFromDepth: [null, S.POST_NORMAL_FROM_DEPTH],
  grid: [S.EDITOR_GRID_VERTEX, S.EDITOR_GRID_FRAGMENT], picking: [S.PICKING_VERTEX, S.PICKING_FRAGMENT],
  outline: [S.OUTLINE_VERTEX, S.OUTLINE_FRAGMENT],
};
let problems = 0;
for (const [name, [v, f]] of Object.entries(progs)) {
  const src = (v ?? '') + '\n' + (f ?? '');
  const declared = new Set([...src.matchAll(/uniform\s+[A-Za-z0-9_]+\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const body = src.replace(/^\s*uniform[^;]*;/gm, '');
  const used = new Set([...body.matchAll(/\b(u[A-Z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]));
  const undeclared = [...used].filter((n) => !declared.has(n));
  if (undeclared.length) { problems++; console.log(name, '→ UNDECLARED:', undeclared.join(' ')); }
}
console.log(problems ? `\n${problems} program(s) reference undeclared uniforms` : 'all programs clean');
