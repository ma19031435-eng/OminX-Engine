import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
const code = `
struct Uniforms {
  uModelMatrix: mat4x4f,
  uTint: vec4f,
  uTime: f32,
  uLights: array<vec4f, 4>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var uAlbedoMap: texture_2d<f32>;
@group(1) @binding(1) var uSampler0: sampler;
@vertex fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f { return vec4f(position, 1.0); }
@fragment fn fs_main() -> @location(0) vec4f { return textureSample(uAlbedoMap, uSampler0, vec2f(0.0)); }
`;
const r = new WgslReflect(code);
console.log('uniforms:', r.uniforms.map((u) => `${u.name} group${u.group} bind${u.binding} ${u.type.name}`).join(', '));
console.log('members:', r.uniforms[0].type.members.map((m) => `${m.name}@${m.offset}+${m.size}`).join(' '));
console.log('struct size:', r.uniforms[0].type.size, 'align', r.uniforms[0].type.align);
console.log('entry:', r.entry.vertex.map((v) => v.name), r.entry.fragment.map((f) => f.name));
console.log('vertex inputs:', r.entry.vertex[0].inputs.map((i) => `${i.name}@${i.location}`).join(' '));
try { new WgslReflect('struct Bad { x: vec4f, '); console.log('bad parse: NO ERROR (parser lenient)'); }
catch (e) { console.log('bad parse threw:', e.message.slice(0, 60)); }
