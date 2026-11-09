/**
 * OminX Engine — WGSL effect programs.
 *
 * Sky, bullet decals, particles (smoke/sparks/blood/dust), sprites, tracer ribbons, debug lines
 * and the editor passes (grid, picking, selection outline). Ports of the GLSL programs in
 * `shaders/index.js`; the uniform names are identical so `Renderer` can set them by name on
 * either backend.
 *
 * @module engine/src/renderer/wgsl/effects
 */
import { declareTextureSlots } from './common.js';

export const SKY_WGSL = /* wgsl */`
struct Uniforms {
  uInverseViewProjection: mat4x4f,
  uCameraPosition: vec3f,
  uSkyZenithColor: vec3f,
  uSkyHorizonColor: vec3f,
  uSunDirection: vec3f,
  uSunColor: vec3f,
  uSunIntensity: f32,
  uGroundColor: vec3f,
  uTime: f32,
  uCloudCoverage: f32,
  uCloudDensity: f32,
  uCloudSpeed: f32,
  uStarIntensity: f32,
  uSkyExposure: f32,
  uMoonPhase: f32,
  uMoonDirection: vec3f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct SkyOut {
  @builtin(position) position: vec4f,
  @location(0) worldDirection: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f) -> SkyOut {
  var out: SkyOut;
  let worldPos = u.uInverseViewProjection * vec4f(position.xy, 1.0, 1.0);
  out.worldDirection = normalize(worldPos.xyz / worldPos.w - u.uCameraPosition);
  out.position = vec4f(position.xy, 0.999999, 1.0);
  return out;
}

fn cloudLayer(dir: vec3f, coverage: f32, density: f32, sharpness: f32, time: f32, cloudSpeed: f32) -> f32 {
  if (dir.y < 0.02) { return 0.0; }
  let p = dir / max(dir.y, 0.02);
  let uv = p.xz * 0.55;
  let t = time * cloudSpeed * 0.02;
  let q = vec3f(uv.x + t, uv.y + t * 0.6, t * 0.15);
  var f = fbm3(q * 1.6);
  f = f + 0.5 * fbm3(q * 3.7 + vec3f(11.3));
  f = f * 0.62 + 0.28;
  let mask = smoothstep(coverage, coverage + sharpness, f);
  let heightFade = smoothstep(0.02, 0.35, dir.y);
  return clamp(mask * heightFade * density, 0.0, 1.0);
}

@fragment
fn fs_main(in: SkyOut) -> @location(0) vec4f {
  let dir = normalize(in.worldDirection);
  let up = clamp(dir.y, -1.0, 1.0);
  let horizonBlend = pow(clamp(1.0 - abs(up), 0.0, 1.0), 3.2);
  var sky = mix(u.uSkyZenithColor, u.uSkyHorizonColor, horizonBlend);
  sky = mix(u.uGroundColor, sky, smoothstep(-0.12, 0.06, up));

  // Sun disc + limb glow.
  let sunDot = dot(dir, normalize(-u.uSunDirection));
  let sunDisc = smoothstep(0.9993, 0.99985, sunDot);
  let sunGlow = pow(clamp(sunDot, 0.0, 1.0), 220.0) * 0.85 + pow(clamp(sunDot, 0.0, 1.0), 8.0) * 0.22;
  sky = sky + u.uSunColor * u.uSunIntensity * (sunDisc * 14.0 + sunGlow);

  // Moon.
  let moonDot = dot(dir, normalize(-u.uMoonDirection));
  let moon = smoothstep(0.9990, 0.9997, moonDot);
  sky = sky + vec3f(0.85, 0.88, 0.95) * moon * (1.0 - u.uSunIntensity * 0.5) * u.uMoonPhase;
  sky = sky + vec3f(0.3, 0.35, 0.5) * pow(clamp(moonDot, 0.0, 1.0), 12.0) * u.uMoonPhase * 0.12;

  // Stars fade in as the sun goes down.
  let starMask = clamp(1.0 - u.uSunIntensity * 0.55, 0.0, 1.0) * u.uStarIntensity * smoothstep(0.0, 0.25, up);
  if (starMask > 0.001) {
    let sp = dir * 220.0;
    let star = hash13(floor(sp));
    let twinkle = 0.65 + 0.35 * sin(u.uTime * 2.0 + star * 40.0);
    sky = sky + vec3f(0.9, 0.94, 1.0) * smoothstep(0.9975, 0.99995, star) * starMask * twinkle * 4.0;
  }

  let clouds = cloudLayer(dir, u.uCloudCoverage, u.uCloudDensity, 0.16, u.uTime, u.uCloudSpeed);
  let cloudLit = mix(vec3f(0.42, 0.45, 0.5), u.uSunColor * 1.1 + vec3f(0.5), clamp(sunDot * 0.5 + 0.5, 0.0, 1.0));
  sky = mix(sky, cloudLit, clouds);

  return vec4f(sky * u.uSkyExposure, 1.0);
}
`;

export const DECAL_WGSL = /* wgsl */`
struct Uniforms {
  uViewProjectionMatrix: mat4x4f,
  uCameraPosition: vec3f,
  uFogColor: vec3f,
  uFogDensity: f32,
  uFogMode: f32,
  uFogStart: f32,
  uFogEnd: f32,
  uOpacity: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}

struct DecalOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) worldPos: vec3f,
};

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(2) uv: vec2f,
  @location(8) instanceMatrix0: vec4f,
  @location(9) instanceMatrix1: vec4f,
  @location(10) instanceMatrix2: vec4f,
  @location(11) instanceMatrix3: vec4f,
  @location(12) instanceColor: vec4f,
  @location(13) instanceParams: vec4f,
) -> DecalOut {
  var out: DecalOut;
  let instanceMatrix = mat4x4f(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  let worldPos = instanceMatrix * vec4f(position, 1.0);
  out.worldPos = worldPos.xyz;
  // Atlas tile + expansion is animated through instanceParams: xy = offset, z = scale, w = fade.
  out.uv = uv * instanceParams.z + instanceParams.xy;
  out.color = instanceColor;
  out.position = u.uViewProjectionMatrix * worldPos;
  return out;
}

@fragment
fn fs_main(in: DecalOut) -> @location(0) vec4f {
  let tex = textureSample(uTexture0, uSampler0, in.uv);
  let alpha = tex.a * in.color.a * u.uOpacity;
  if (alpha < 0.004) { discard; }
  var color = tex.rgb * in.color.rgb;
  let dist = distance(u.uCameraPosition, in.worldPos);
  color = mix(color, u.uFogColor, select(0.0, clamp((dist - u.uFogStart) / max(u.uFogEnd - u.uFogStart, 0.001), 0.0, 1.0) * 0.85, u.uFogMode > 0.5));
  return vec4f(color, alpha);
}
`;

export const PARTICLE_WGSL = /* wgsl */`
struct Uniforms {
  uViewProjectionMatrix: mat4x4f,
  uViewMatrix: mat4x4f,
  uCameraRight: vec3f,
  uCameraUp: vec3f,
  uCameraPosition: vec3f,
  uFogMode: f32,
  uFogColor: vec3f,
  uFogStart: f32,
  uFogEnd: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}

struct ParticleOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) localUV: vec2f,
  @location(3) softness: f32,
  @location(4) worldPos: vec3f,
};

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(2) uv: vec2f,
  @location(8) instanceMatrix0: vec4f,
  @location(9) instanceMatrix1: vec4f,
  @location(10) instanceMatrix2: vec4f,
  @location(11) instanceMatrix3: vec4f,
  @location(12) instanceColor: vec4f,
  @location(13) instanceParams: vec4f,
) -> ParticleOut {
  var out: ParticleOut;
  let center = instanceMatrix0.xyz;
  let size = instanceMatrix0.w;
  let rot = instanceParams.x;
  let atlas = instanceParams.y;
  let stretch = instanceParams.w;

  let quad = position.xy * size;
  let c = cos(rot);
  let s = sin(rot);
  var rotated = vec2f(quad.x * c - quad.y * s, quad.x * s + quad.y * c);

  var right = u.uCameraRight;
  var up = u.uCameraUp;
  if (stretch > 0.001) {
    // Motion-stretched billboard: the particle becomes a streak along its velocity.
    let velDir = normalize(instanceMatrix1.xyz + vec3f(0.0001));
    let toCam = normalize(u.uCameraPosition - center);
    right = normalize(cross(velDir, toCam));
    up = velDir;
    rotated = vec2f(rotated.x, rotated.y * stretch);
  }
  let worldPos = center + right * rotated.x + up * rotated.y;
  out.worldPos = worldPos;
  out.color = instanceColor;
  out.localUV = uv;
  out.softness = instanceParams.z;
  let tile = vec2f(mod(atlas, 4.0), floor(atlas / 4.0));
  out.uv = (uv + tile) * 0.25;
  out.position = u.uViewProjectionMatrix * vec4f(worldPos, 1.0);
  return out;
}

@fragment
fn fs_main(in: ParticleOut) -> @location(0) vec4f {
  let tex = textureSample(uTexture0, uSampler0, in.uv);
  let alpha = tex.a * in.color.a;
  if (alpha < 0.002) { discard; }
  var color = tex.rgb * in.color.rgb;
  let dist = distance(u.uCameraPosition, in.worldPos);
  color = mix(color, u.uFogColor, select(0.0, clamp((dist - u.uFogStart) / max(u.uFogEnd - u.uFogStart, 0.001), 0.0, 1.0) * 0.5, u.uFogMode > 0.5));
  return vec4f(color * alpha, alpha);
}
`;

export const SPRITE_WGSL = /* wgsl */`
struct Uniforms {
  uModelMatrix: mat4x4f,
  uViewProjectionMatrix: mat4x4f,
  uCameraPosition: vec3f,
  uSize: vec2f,
  uBillboard: f32,
  uUVOffset: vec4f,
  uColor: vec4f,
  uFogColor: vec3f,
  uFogMode: f32,
  uFogStart: f32,
  uFogEnd: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}

struct SpriteOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) worldPos: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(2) uv: vec2f) -> SpriteOut {
  var out: SpriteOut;
  var worldPos: vec3f;
  if (u.uBillboard > 0.5) {
    let right = normalize(vec3f(u.uViewProjectionMatrix[0][0], u.uViewProjectionMatrix[1][0], u.uViewProjectionMatrix[2][0]));
    let up = normalize(vec3f(u.uViewProjectionMatrix[0][1], u.uViewProjectionMatrix[1][1], u.uViewProjectionMatrix[2][1]));
    let center = u.uModelMatrix[3].xyz;
    worldPos = center + right * position.x * u.uSize.x + up * position.y * u.uSize.y;
  } else {
    worldPos = (u.uModelMatrix * vec4f(position.xy * u.uSize, position.z, 1.0)).xyz;
  }
  out.worldPos = worldPos;
  out.uv = uv * u.uUVOffset.zw + u.uUVOffset.xy;
  out.position = u.uViewProjectionMatrix * vec4f(worldPos, 1.0);
  return out;
}

@fragment
fn fs_main(in: SpriteOut) -> @location(0) vec4f {
  let tex = textureSample(uTexture0, uSampler0, in.uv);
  let c = tex * u.uColor;
  if (c.a < 0.003) { discard; }
  let dist = distance(u.uCameraPosition, in.worldPos);
  // Premultiplied output keeps additive and alpha blending consistent.
  let rgb = mix(c.rgb, u.uFogColor, select(0.0, clamp((dist - u.uFogStart) / max(u.uFogEnd - u.uFogStart, 0.001), 0.0, 1.0) * 0.6, u.uFogMode > 0.5));
  return vec4f(rgb * c.a, c.a);
}
`;

export const LINE_WGSL = /* wgsl */`
struct Uniforms {
  uViewProjectionMatrix: mat4x4f,
  uTint: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct LineOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(4) color: vec4f) -> LineOut {
  var out: LineOut;
  out.color = color;
  out.position = u.uViewProjectionMatrix * vec4f(position, 1.0);
  return out;
}

@fragment
fn fs_main(in: LineOut) -> @location(0) vec4f {
  return in.color * u.uTint;
}
`;

export const TRACER_WGSL = /* wgsl */`
struct Uniforms {
  uViewProjectionMatrix: mat4x4f,
  uCameraPosition: vec3f,
  uTime: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}

struct TracerOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(8) instanceMatrix0: vec4f,
  @location(9) instanceMatrix1: vec4f,
  @location(10) instanceMatrix2: vec4f,
  @location(11) instanceMatrix3: vec4f,
  @location(12) instanceColor: vec4f,
  @location(13) instanceParams: vec4f,
) -> TracerOut {
  var out: TracerOut;
  let start = instanceMatrix0.xyz;
  let end = instanceMatrix1.xyz;
  let center = mix(start, end, position.x);
  let dir = normalize(end - start + vec3f(0.00001));
  let toCam = normalize(u.uCameraPosition - center);
  let side = normalize(cross(dir, toCam));
  let width = instanceMatrix0.w * position.z;
  let worldPos = center + side * position.y * width;
  out.uv = vec2f(position.x, position.y * 0.5 + 0.5);
  out.color = vec4f(instanceMatrix2.rgb * instanceColor.rgb, instanceMatrix2.a * instanceColor.a * instanceMatrix1.w);
  out.position = u.uViewProjectionMatrix * vec4f(worldPos, 1.0);
  return out;
}

@fragment
fn fs_main(in: TracerOut) -> @location(0) vec4f {
  let core = smoothstep(0.0, 0.35, 1.0 - abs(in.uv.y * 2.0 - 1.0));
  let head = smoothstep(0.75, 1.0, in.uv.x);
  let tail = smoothstep(0.0, 0.45, in.uv.x);
  let alpha = in.color.a * core * tail * (1.0 + head * 1.6);
  if (alpha < 0.003) { discard; }
  let color = mix(in.color.rgb, vec3f(1.0), head * 0.7);
  return vec4f(color * alpha, alpha);
}
`;

export const GRID_WGSL = /* wgsl */`
struct Uniforms {
  uViewProjectionMatrix: mat4x4f,
  uCameraPosition: vec3f,
  uFadeDistance: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct GridOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) worldPos: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(4) color: vec4f) -> GridOut {
  var out: GridOut;
  out.color = color;
  out.worldPos = position;
  out.position = u.uViewProjectionMatrix * vec4f(position, 1.0);
  return out;
}

@fragment
fn fs_main(in: GridOut) -> @location(0) vec4f {
  let dist = distance(u.uCameraPosition, in.worldPos);
  let alpha = in.color.a * (1.0 - clamp((dist - u.uFadeDistance * 0.4) / (u.uFadeDistance * 0.6), 0.0, 1.0));
  if (alpha < 0.005) { discard; }
  return vec4f(in.color.rgb, alpha);
}
`;

export const PICKING_WGSL = /* wgsl */`
struct Uniforms {
  uModelMatrix: mat4x4f,
  uViewProjectionMatrix: mat4x4f,
  uPickColor: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs_main(@location(0) position: vec3f
#ifdef INSTANCED
  , @location(8) instanceMatrix0: vec4f
  , @location(9) instanceMatrix1: vec4f
  , @location(10) instanceMatrix2: vec4f
  , @location(11) instanceMatrix3: vec4f
#endif
) -> @builtin(position) vec4f {
#ifdef INSTANCED
  let instanceMatrix = mat4x4f(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  return u.uViewProjectionMatrix * instanceMatrix * vec4f(position, 1.0);
#else
  return u.uViewProjectionMatrix * u.uModelMatrix * vec4f(position, 1.0);
#endif
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return u.uPickColor;
}
`;

export const OUTLINE_WGSL = /* wgsl */`
struct Uniforms {
  uModelMatrix: mat4x4f,
  uViewProjectionMatrix: mat4x4f,
  uThickness: f32,
  uColor: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> @builtin(position) vec4f {
  let expanded = position + normal * u.uThickness;
  return u.uViewProjectionMatrix * u.uModelMatrix * vec4f(expanded, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return u.uColor;
}
`;

export const SKY_PROGRAM = {
  name: 'sky', code: SKY_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position'], textures: {}, featureAttributes: {},
};
export const DECAL_PROGRAM = {
  name: 'decal', code: DECAL_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position', 'uv'], textures: { uDecalAtlas: 0 },
  featureAttributes: { INSTANCED: [] }, instanced: true,
};
export const PARTICLE_PROGRAM = {
  name: 'particle', code: PARTICLE_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position', 'uv'], textures: { uParticleTexture: 0 },
  featureAttributes: { INSTANCED: [] }, instanced: true,
};
export const SPRITE_PROGRAM = {
  name: 'sprite', code: SPRITE_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position', 'uv'], textures: { uTexture: 0 }, featureAttributes: {},
};
export const LINE_PROGRAM = {
  name: 'line', code: LINE_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position', 'color'], textures: {}, featureAttributes: {},
};
export const TRACER_PROGRAM = {
  name: 'tracer', code: TRACER_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position'], textures: { uTexture: 0 },
  featureAttributes: { INSTANCED: [] }, instanced: true,
};
export const GRID_PROGRAM = {
  name: 'grid', code: GRID_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position', 'color'], textures: {}, featureAttributes: {},
};
export const PICKING_PROGRAM = {
  name: 'picking', code: PICKING_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position'], textures: {}, featureAttributes: { INSTANCED: [] },
  targets: [{ format: 'rgba8unorm' }],
};
export const OUTLINE_PROGRAM = {
  name: 'outline', code: OUTLINE_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position', 'normal'], textures: {}, featureAttributes: {},
};
