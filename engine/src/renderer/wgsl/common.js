/**
 * OminX Engine — shared WGSL snippets.
 *
 * The WebGPU backend mirrors the GLSL helper library one-for-one (`sRGB`, tone mapping, hashing,
 * value noise, octahedral encoding, depth packing, fog, normal mapping, PCF shadows, PBR), so a
 * material or pass behaves the same whichever backend is active. Snippets here are *pure*: they
 * take everything they need as parameters and never touch the uniform block, because each
 * program declares its own `Uniforms` struct.
 *
 * @module engine/src/renderer/wgsl/common
 */

export const WGSL_CONSTANTS = /* wgsl */`
const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;
const EPSILON_F: f32 = 1e-5;
const F0_DIELECTRIC: vec3f = vec3f(0.04);
`;

export const WGSL_SRGB = /* wgsl */`
fn sRGBToLinear(c: vec3f) -> vec3f {
  return mix(c / 12.92, pow((c + vec3f(0.055)) / 1.055, vec3f(2.4)), step(vec3f(0.04045), c));
}
fn linearToSRGB(c: vec3f) -> vec3f {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, step(vec3f(0.0031308), c));
}
`;

export const WGSL_TONE_MAPPING = /* wgsl */`
fn tonemapACES(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}
fn tonemapReinhard(x: vec3f) -> vec3f { return x / (x + vec3f(1.0)); }
fn tonemapFilmic(x: vec3f) -> vec3f {
  let y = max(vec3f(0.0), x - vec3f(0.004));
  return (y * (6.2 * y + 0.5)) / (y * (6.2 * y + 1.7) + 0.06);
}
fn applyExposure(c: vec3f, exposure: f32) -> vec3f { return c * exposure; }
`;

export const WGSL_RANDOM = /* wgsl */`
fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x = x * (x + 33.33);
  x = x * (x + x);
  return fract(x);
}
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, vec3f(p3.y, p3.z, p3.x) + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn hash13(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031);
  p3 = p3 + dot(p3, vec3f(p3.z, p3.y, p3.x) + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  p3 = p3 + dot(p3, vec3f(p3.y, p3.z, p3.x) + 33.33);
  return fract((vec2f(p3.x, p3.x) + vec2f(p3.y, p3.z)) * vec2f(p3.z, p3.y));
}
fn hash33(p: vec3f) -> vec3f {
  var p3 = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  p3 = p3 + dot(p3, vec3f(p3.y, p3.x, p3.z) + 33.33);
  return fract((vec3f(p3.x, p3.x, p3.y) + vec3f(p3.y, p3.x, p3.x)) * vec3f(p3.z, p3.y, p3.x));
}
`;

export const WGSL_NOISE = /* wgsl */`
fn valueNoise(p: vec3f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let n000 = hash13(i + vec3f(0.0, 0.0, 0.0));
  let n100 = hash13(i + vec3f(1.0, 0.0, 0.0));
  let n010 = hash13(i + vec3f(0.0, 1.0, 0.0));
  let n110 = hash13(i + vec3f(1.0, 1.0, 0.0));
  let n001 = hash13(i + vec3f(0.0, 0.0, 1.0));
  let n101 = hash13(i + vec3f(1.0, 0.0, 1.0));
  let n011 = hash13(i + vec3f(0.0, 1.0, 1.0));
  let n111 = hash13(i + vec3f(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
fn fbm3(p: vec3f) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 5; i = i + 1) {
    s = s + a * valueNoise(q);
    q = q * 2.02;
    a = a * 0.5;
  }
  return s;
}
`;

export const WGSL_OCTAHEDRAL = /* wgsl */`
fn unitVectorToOctahedron(n: vec3f) -> vec2f {
  let d = abs(n.x) + abs(n.y) + abs(n.z);
  let v = n / max(d, EPSILON_F);
  var uv = v.xy;
  if (v.z <= 0.0) {
    uv = (vec2f(1.0, 1.0) - abs(vec2f(v.y, v.x))) *
         vec2f(select(-1.0, 1.0, v.x >= 0.0), select(-1.0, 1.0, v.y >= 0.0));
  }
  return uv * 0.5 + 0.5;
}
fn octahedronToUnitVector(uvIn: vec2f) -> vec3f {
  let uv = uvIn * 2.0 - 1.0;
  var n = vec3f(uv, 1.0 - abs(uv.x) - abs(uv.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x >= 0.0);
  n.y = n.y + select(t, -t, n.y >= 0.0);
  return normalize(n);
}
`;

export const WGSL_PACKING = /* wgsl */`
fn packDepthToRGBA(depth: f32) -> vec4f {
  let bitSh = vec4f(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
  let bitMask = vec4f(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
  var res = fract(depth * bitSh);
  res = res - res.xxyz * bitMask;
  return res;
}
fn unpackDepthFromRGBA(rgba: vec4f) -> f32 {
  return dot(rgba, vec4f(1.0 / (256.0 * 256.0 * 256.0), 1.0 / (256.0 * 256.0), 1.0 / 256.0, 1.0));
}
`;

export const WGSL_FOG = /* wgsl */`
fn applyFog(color: vec3f, dist: f32, fogColor: vec3f, fogStart: f32, fogEnd: f32, density: f32, mode: f32) -> vec3f {
  if (mode < 0.5) { return color; }
  var factor: f32;
  if (mode < 1.5) {
    factor = clamp((dist - fogStart) / max(fogEnd - fogStart, 0.001), 0.0, 1.0);
  } else if (mode < 2.5) {
    factor = 1.0 - exp(-density * dist);
  } else {
    factor = 1.0 - exp(-pow(density * dist, 2.0));
  }
  return mix(color, fogColor, factor);
}
`;

export const WGSL_NORMAL_MAPPING = /* wgsl */`
fn perturbNormalFromSample(texN: vec3f, N: vec3f, T: vec3f, B: vec3f, strength: f32) -> vec3f {
  var n = texN * 2.0 - 1.0;
  n = vec3f(n.x * strength, n.y * strength, n.z);
  return normalize(mat3x3f(T, B, N) * normalize(n));
}
`;

export const WGSL_SHADOW_SAMPLING = /* wgsl */`
// WebGPU samples depth textures through a comparison sampler: the hardware returns 1.0 when the
// fragment is lit, matching the GLSL branch of sampleShadowPCF.
fn sampleShadowPCF(map: texture_depth_2d, samp: sampler_comparison, uv: vec2f, compare: f32, texelSize: vec2f, softness: f32) -> f32 {
  var shadow = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let offset = vec2f(f32(x), f32(y)) * texelSize * softness;
      shadow = shadow + textureSampleCompareLevel(map, samp, uv + offset, compare);
    }
  }
  return shadow / 9.0;
}
fn sampleShadowPoisson(map: texture_depth_2d, samp: sampler_comparison, uv: vec2f, compare: f32, texelSize: vec2f, softness: f32, seed: f32) -> f32 {
  let poisson = array<vec2f, 12>(
    vec2f(-0.326, -0.406), vec2f(-0.840, -0.074), vec2f(-0.696, 0.457), vec2f(-0.203, 0.621),
    vec2f(0.962, -0.195), vec2f(0.473, -0.480), vec2f(0.519, 0.767), vec2f(0.185, -0.893),
    vec2f(0.507, 0.064), vec2f(0.896, 0.412), vec2f(-0.322, -0.933), vec2f(-0.792, -0.598));
  let angle = seed * TAU;
  let s = sin(angle);
  let c = cos(angle);
  let rot = mat2x2f(c, -s, s, c);
  var shadow = 0.0;
  for (var i = 0; i < 12; i = i + 1) {
    let offset = rot * poisson[i] * texelSize * softness;
    shadow = shadow + textureSampleCompareLevel(map, samp, uv + offset, compare);
  }
  return shadow / 12.0;
}
`;

export const WGSL_PBR = /* wgsl */`
fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (vec3f(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}
fn distributionGGX(N: vec3f, H: vec3f, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH = max(dot(N, H), 0.0);
  let NdotH2 = NdotH * NdotH;
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 0.0001);
}
fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  let ggxV = NdotV / (NdotV * (1.0 - k) + k);
  let ggxL = NdotL / (NdotL * (1.0 - k) + k);
  return ggxV * ggxL;
}
fn computePBR(N: vec3f, V: vec3f, L: vec3f, radiance: vec3f, albedo: vec3f, roughness: f32, metalness: f32, F0: vec3f, ao: f32) -> vec3f {
  let H = normalize(V + L);
  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), 0.0001);
  if (NdotL <= 0.0) { return vec3f(0.0); }
  let F = fresnelSchlick(max(dot(H, V), 0.0), F0);
  let D = distributionGGX(N, H, roughness);
  let G = geometrySmith(NdotV, NdotL, roughness);
  let specular = (D * G * F) / max(4.0 * NdotV * NdotL, 0.0001);
  let kD = (vec3f(1.0) - F) * (1.0 - metalness);
  let diffuse = kD * albedo / PI;
  return (diffuse + specular) * radiance * NdotL * ao;
}
fn imageBasedApprox(N: vec3f, V: vec3f, roughness: f32, F0: vec3f, metalness: f32, albedo: vec3f,
                    ambientSky: vec3f, ambientGround: vec3f, ambientIntensity: f32) -> vec3f {
  let up = N.y * 0.5 + 0.5;
  let sky = mix(ambientGround, ambientSky, up);
  let R = reflect(-V, N);
  let rUp = R.y * 0.5 + 0.5;
  let reflected = mix(ambientGround, ambientSky * 1.35, rUp);
  let fresnel = pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 4.0);
  let specEnv = mix(reflected, reflected * 1.5, fresnel) * mix(1.0, 0.6, roughness);
  let diffEnv = sky * albedo * (1.0 - metalness);
  return (diffEnv + specEnv * mix(F0, albedo, metalness)) * ambientIntensity;
}
`;

export const WGSL_DEPTH_UTILS = /* wgsl */`
fn linearizeDepth(depth: f32, near: f32, far: f32) -> f32 {
  let z = depth;
  return (near * far) / (far - z * (far - near));
}
fn viewPositionFromDepth(uv: vec2f, depth: f32, inverseProjection: mat4x4f) -> vec3f {
  let ndc = vec4f(uv * 2.0 - 1.0, depth, 1.0);
  let view = inverseProjection * ndc;
  return view.xyz / max(abs(view.w), EPSILON_F) * sign(view.w);
}
`;

/** Everything a lit program needs, in the order the GLSL helpers were written. */
export const WGSL_COMMON = [
  WGSL_CONSTANTS, WGSL_SRGB, WGSL_TONE_MAPPING, WGSL_RANDOM, WGSL_NOISE,
  WGSL_OCTAHEDRAL, WGSL_PACKING, WGSL_FOG, WGSL_NORMAL_MAPPING,
  WGSL_SHADOW_SAMPLING, WGSL_PBR, WGSL_DEPTH_UTILS,
].join('\n');

/**
 * Texture slots shared by every program: unit `i` maps to a texture binding and its sampler.
 * GL used `glActiveTexture(GL_TEXTURE0 + unit)` + `uniform sampler2D`; WebGPU needs an explicit
 * pair, so the slot table is fixed and identical across programs.
 */
export function textureSlot(unit) {
  return {
    textureBinding: unit * 2,
    samplerBinding: unit * 2 + 1,
    textureName: `uTexture${unit}`,
    samplerName: `uSampler${unit}`,
  };
}

/**
 * Declares the texture/sampler pairs a program uses at group 1.
 *
 * @param {number[]} units texture units (unit `i` is texture binding `2i`, sampler `2i + 1`)
 * @param {{depth?: number[], comparison?: number[], cube?: number[], storage?: number[]}} [opts]
 */
export function declareTextureSlots(units, { depth = [], comparison = [], cube = [] } = {}) {
  return units.map((unit) => {
    const slot = textureSlot(unit);
    const isDepth = depth.includes(unit);
    const isCube = cube.includes(unit);
    const textureType = isDepth ? 'texture_depth_2d' : isCube ? 'texture_cube<f32>' : 'texture_2d<f32>';
    const samplerType = isDepth && comparison.includes(unit) ? 'sampler_comparison' : 'sampler';
    return [
      `@group(1) @binding(${slot.textureBinding}) var ${slot.textureName}: ${textureType};`,
      `@group(1) @binding(${slot.samplerBinding}) var ${slot.samplerName}: ${samplerType};`,
    ].join('\n');
  }).join('\n');
}
