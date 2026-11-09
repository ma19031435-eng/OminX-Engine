import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { parseUniformLayout } from '../../engine/src/renderer/wgsl/layout.js';
const src = `
struct VertexOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
struct Uniforms {
  uModelMatrix: mat4x4f,
  uNormalMatrix: mat3x3f,
  uTint: vec4f,
  uSunDirection: vec3f,
  uTime: f32,
  uBoneMatrices: array<mat4x4f, 4>,
  uPointLightPositions: array<vec3f, 3>,
  uShadowTexelSize: vec2f,
  uCount: i32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var uTexture1: texture_2d<f32>;
@group(1) @binding(1) var uSampler1: sampler;
@group(1) @binding(2) var uShadowMap0: texture_depth_2d;
@vertex fn vs_main(@location(0) position: vec3f, @location(2) uv: vec2f) -> VertexOut {
  var o: VertexOut; o.pos = vec4f(position, 1.0); o.uv = uv; return o;
}
@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return textureSample(uTexture1, uSampler1, in.uv) * u.uTint;
}
`;
const mine = parseUniformLayout(src);
const theirs = new WgslReflect(src);
const theirsMembers = theirs.uniforms[0].type.members;
console.log('my size', mine.size, 'reflect size', theirs.uniforms[0].type.size);
let bad = 0;
for (const name of mine.order) {
  const a = mine.members.get(name);
  const b = theirsMembers.find((x) => x.name === name);
  const ok = b && a.offset === b.offset && a.size === b.size;
  if (!ok) bad++;
  console.log(' ', (ok ? 'ok  ' : 'BAD '), name.padEnd(22), `mine off ${a.offset} size ${a.size}`, b ? `reflect off ${b.offset} size ${b.size}` : 'missing in reflect');
}
console.log('mismatches:', bad, '| structs:', [...mine.structs.keys()].join(','));
