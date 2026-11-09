/**
 * OminX Engine — WGSL geometry, shadow and weapon-viewmodel programs.
 *
 * Direct ports of `shaders/index.js` (GLSL), with the same feature permutations. Keeping the two
 * libraries behaviourally identical is what lets `Renderer` stay backend-agnostic: it binds
 * materials, sets uniforms by name and draws, and the backend decides how that becomes API calls.
 *
 * Permutation define keys (identical to the GLSL ones):
 *   GEOMETRY  INSTANCED · SKINNED · SHADOW_CASCADES · ALPHA_TEST · WIND · VERTEX_COLOR · EMISSIVE_MAP
 *   SHADOW    INSTANCED · SKINNED · ALPHA_TEST
 * The numeric defines (MAX_BONES, MAX_POINT_LIGHTS, MAX_SHADOW_CASCADES) are preprocessor macros.
 *
 * @module engine/src/renderer/wgsl/geometry
 */
import { declareTextureSlots, textureSlot } from './common.js';

export const DEFAULT_SHADER_DEFINES = { MAX_BONES: 64, MAX_POINT_LIGHTS: 16, MAX_SHADOW_CASCADES: 4 };

/** Texture units used by the forward geometry pass (0 is reserved for the shadow comparison pair). */
export const GEOMETRY_TEXTURE_UNITS = { uAlbedoMap: 1, uNormalMap: 2, uRoughnessMap: 3, uMetalnessMap: 4, uAoMap: 5, uEmissiveMap: 6, uShadowMap0: 7, uShadowMap1: 8, uShadowMap2: 9, uShadowMap3: 10 };

const GEOMETRY_UNIFORMS = /* wgsl */`
struct Uniforms {
  uBoneMatrices: array<mat4x4f, MAX_BONES>,
  uModelMatrix: mat4x4f,
  uNormalMatrix: mat3x3f,
  uViewMatrix: mat4x4f,
  uProjectionMatrix: mat4x4f,
  uViewProjectionMatrix: mat4x4f,
  uTime: f32,
  uWindStrength: f32,
  uWindSpeed: f32,
  uWindDirection: vec3f,
  uCameraPosition: vec3f,
  uCameraForward: vec3f,
  uAlbedoColor: vec3f,
  uOpacity: f32,
  uRoughness: f32,
  uMetalness: f32,
  uReflectance: f32,
  uEmissive: vec3f,
  uAlphaCutoff: f32,
  uNormalStrength: f32,
  uUVScale: vec2f,
  uAoStrength: f32,
  uTint: vec4f,
  uUseVertexColor: f32,
  uSaturation: f32,
  uHasAlbedoMap: f32,
  uHasNormalMap: f32,
  uHasRoughnessMap: f32,
  uHasMetalnessMap: f32,
  uHasAoMap: f32,
  uHasEmissiveMap: f32,
  uSunDirection: vec3f,
  uSunColor: vec3f,
  uSunIntensity: f32,
  uAmbientSky: vec3f,
  uAmbientGround: vec3f,
  uAmbientIntensity: f32,
  uFogColor: vec3f,
  uFogDensity: f32,
  uFogStart: f32,
  uFogEnd: f32,
  uFogMode: f32,
  uSkyLuminance: f32,
  uPointLightCount: i32,
  uPointLightPositions: array<vec3f, MAX_POINT_LIGHTS>,
  uPointLightColors: array<vec3f, MAX_POINT_LIGHTS>,
  uPointLightRanges: array<f32, MAX_POINT_LIGHTS>,
  uPointLightIntensities: array<f32, MAX_POINT_LIGHTS>,
  // Arrays in the uniform address space are 16-byte aligned; every array is therefore placed at
  // a member boundary that is already 16-aligned (no implicit padding for the driver to guess).
  uShadowSplitDistances: array<f32, MAX_SHADOW_CASCADES>,
  uShadowMatrices: array<mat4x4f, MAX_SHADOW_CASCADES>,
  uShadowTexelSize: vec2f,
  uShadowBias: f32,
  uShadowSoftness: f32,
  uShadowCascadeFade: f32,
  uDamageFlash: f32,
  uUnderwaterTint: vec3f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
`;

const GEOMETRY_SURFACE = /* wgsl */`
struct SurfaceOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) color: vec4f,
  @location(5) tangent: vec3f,
  @location(6) bitangent: vec3f,
  @location(7) viewDepth: f32,
  @location(8) objectPos: vec3f,
#ifdef INSTANCED
  @location(9) @interpolate(flat) instanceParam0: f32,
#endif
#ifdef SHADOW_CASCADES
  @location(10) shadowCoords: array<vec4f, MAX_SHADOW_CASCADES>,
#endif
};

#ifdef SKINNED
fn skinLocalPosition(position: vec3f, normal: vec3f, skinIndex: vec4<u32>, skinWeight: vec4f) -> vec4f {
  var skinMatrix = mat4x4f(0.0);
  skinMatrix = skinMatrix + skinWeight.x * u.uBoneMatrices[skinIndex.x];
  skinMatrix = skinMatrix + skinWeight.y * u.uBoneMatrices[skinIndex.y];
  skinMatrix = skinMatrix + skinWeight.z * u.uBoneMatrices[skinIndex.z];
  skinMatrix = skinMatrix + skinWeight.w * u.uBoneMatrices[skinIndex.w];
  return skinMatrix * vec4f(position, 1.0);
}
fn skinNormal(skinMatrix: mat4x4f, normal: vec3f) -> vec3f {
  return normalize((skinMatrix * vec4f(normal, 0.0)).xyz);
}
#endif
`;

/**
 * Full geometry pass. The `#ifdef`s are resolved by the preprocessor into one variant per
 * feature mask, exactly like the GLSL permutations.
 */
export const GEOMETRY_WGSL = /* wgsl */`
${GEOMETRY_UNIFORMS}
${GEOMETRY_SURFACE}
${declareTextureSlots([1, 2, 3, 4, 5, 6], {})}
${declareTextureSlots([7, 8, 9, 10], { depth: [7, 8, 9, 10], comparison: [7, 8, 9, 10] })}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) color: vec4f,
  @location(5) tangent: vec4f,
#ifdef SKINNED
  @location(6) skinIndex: vec4<u32>,
  @location(7) skinWeight: vec4f,
#endif
#ifdef INSTANCED
  @location(8) instanceMatrix0: vec4f,
  @location(9) instanceMatrix1: vec4f,
  @location(10) instanceMatrix2: vec4f,
  @location(11) instanceMatrix3: vec4f,
  @location(12) instanceColor: vec4f,
  @location(13) instanceParams: vec4f,
#endif
) -> SurfaceOut {
  var out: SurfaceOut;
  var localPos = position;
  var localNormal = normal;

#ifdef SKINNED
  let skinMatrix = mat4x4f(0.0)
    + skinWeight.x * u.uBoneMatrices[skinIndex.x]
    + skinWeight.y * u.uBoneMatrices[skinIndex.y]
    + skinWeight.z * u.uBoneMatrices[skinIndex.z]
    + skinWeight.w * u.uBoneMatrices[skinIndex.w];
  localPos = (skinMatrix * vec4f(localPos, 1.0)).xyz;
  localNormal = normalize((skinMatrix * vec4f(localNormal, 0.0)).xyz);
#endif

#ifdef INSTANCED
  let instanceMatrix = mat4x4f(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  #ifdef WIND
  // Foliage and props bend per instance without any CPU cost.
  let swayPhase = instanceMatrix[3].x * 0.6 + instanceMatrix[3].z * 0.4;
  let heightFactor = max(localPos.y, 0.0);
  localPos.x = localPos.x + u.uWindDirection.x * sin(u.uTime * u.uWindSpeed + swayPhase) * u.uWindStrength * heightFactor * u.uWindStrength;
  localPos.z = localPos.z + u.uWindDirection.z * sin(u.uTime * u.uWindSpeed + swayPhase) * u.uWindStrength * heightFactor * u.uWindStrength;
  #endif
  let worldPos = instanceMatrix * vec4f(localPos, 1.0);
  out.instanceParam0 = instanceParams.x;
  out.normal = normalize((instanceMatrix * vec4f(localNormal, 0.0)).xyz);
  out.tangent = normalize((instanceMatrix * vec4f(tangent.xyz, 0.0)).xyz);
  out.color = color * instanceColor;
#else
  let worldPos = u.uModelMatrix * vec4f(localPos, 1.0);
  out.normal = normalize(u.uNormalMatrix * localNormal);
  out.tangent = normalize(u.uNormalMatrix * tangent.xyz);
  out.color = color;
#endif

  out.objectPos = position;
  out.worldPos = worldPos.xyz;
  out.bitangent = cross(out.normal, out.tangent) * select(-1.0, 1.0, tangent.w >= 0.0);
  out.uv = uv;
  out.uv1 = uv1;
  let viewPos = u.uViewMatrix * worldPos;
  out.viewDepth = -viewPos.z;
  out.position = u.uProjectionMatrix * viewPos;
#ifdef SHADOW_CASCADES
  var shadowCoords: array<vec4f, MAX_SHADOW_CASCADES>;
  for (var i = 0; i < MAX_SHADOW_CASCADES; i = i + 1) {
    shadowCoords[i] = u.uShadowMatrices[i] * worldPos;
  }
  out.shadowCoords = shadowCoords;
#endif
  return out;
}

fn sampleCascades(worldPos: vec3f, viewDepth: f32, shadowCoords: array<vec4f, MAX_SHADOW_CASCADES>) -> f32 {
#ifdef SHADOW_CASCADES
  var cascade = i32(MAX_SHADOW_CASCADES) - 1;
  for (var i = 0; i < MAX_SHADOW_CASCADES; i = i + 1) {
    if (viewDepth <= u.uShadowSplitDistances[i]) { cascade = i; break; }
  }
  let coord = shadowCoords[cascade];
  let proj = coord.xyz / coord.w * 0.5 + vec3f(0.5);
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) { return 1.0; }
  let bias = u.uShadowBias * (1.0 + viewDepth * 0.02);
  let uv = proj.xy;
  let seed = hash12(uv * 512.0);
  var shadow = 1.0;
  if (cascade == 0) {
    shadow = sampleShadowPoisson(uTexture7, uSampler7, uv, proj.z - bias, u.uShadowTexelSize, u.uShadowSoftness, seed);
  } else if (cascade == 1) {
    shadow = sampleShadowPoisson(uTexture8, uSampler8, uv, proj.z - bias, u.uShadowTexelSize, u.uShadowSoftness * 1.4, seed);
  } else if (cascade == 2) {
    shadow = sampleShadowPoisson(uTexture9, uSampler9, uv, proj.z - bias, u.uShadowTexelSize, u.uShadowSoftness * 1.8, seed);
  } else {
    shadow = sampleShadowPoisson(uTexture10, uSampler10, uv, proj.z - bias, u.uShadowTexelSize, u.uShadowSoftness * 2.1, seed);
  }
  // Fade the outermost cascade into unshadowed so distant geometry has no hard edge.
  let lastSplit = u.uShadowSplitDistances[MAX_SHADOW_CASCADES - 1];
  let fade = clamp((lastSplit - viewDepth) / max(u.uShadowCascadeFade, 0.001), 0.0, 1.0);
  return mix(1.0, shadow, select(1.0, fade, cascade == i32(MAX_SHADOW_CASCADES) - 1));
#else
  return 1.0;
#endif
}

@fragment
fn fs_main(in: SurfaceOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let uv = in.uv * u.uUVScale;
  var baseColor = vec4f(u.uAlbedoColor, u.uOpacity) * u.uTint;
  if (u.uUseVertexColor > 0.5) { baseColor = baseColor * in.color; }
  // Textures are sampled unconditionally (masking by the *has* flags) so the pass never breaks
  // WGSL's uniform-control-flow rules for implicit-derivative sampling.
  let albedoSample = textureSample(uTexture1, uSampler1, uv);
  baseColor = baseColor * select(vec4f(1.0), albedoSample, u.uHasAlbedoMap > 0.5);
  if (u.uAlphaCutoff > 0.0 && baseColor.a < u.uAlphaCutoff) { discard; }
  if (baseColor.a <= 0.001) { discard; }

  var N = normalize(in.normal);
  if (!frontFacing) { N = -N; }
  let normalSample = textureSample(uTexture2, uSampler2, uv).xyz;
  if (u.uHasNormalMap > 0.5) {
    N = perturbNormalFromSample(normalSample, N, normalize(in.tangent), normalize(in.bitangent), u.uNormalStrength);
  }

  var roughness = clamp(u.uRoughness, 0.045, 1.0);
  roughness = clamp(roughness * select(1.0, textureSample(uTexture3, uSampler3, uv).g, u.uHasRoughnessMap > 0.5), 0.045, 1.0);
  var metalness = clamp(u.uMetalness, 0.0, 1.0);
  metalness = clamp(metalness * select(1.0, textureSample(uTexture4, uSampler4, uv).b, u.uHasMetalnessMap > 0.5), 0.0, 1.0);
  var ao = 1.0;
  if (u.uHasAoMap > 0.5) { ao = mix(1.0, textureSample(uTexture5, uSampler5, uv).r, u.uAoStrength); }

  if (u.uDamageFlash > 0.001) {
    let luma = dot(baseColor.rgb, vec3f(0.2126, 0.7152, 0.0722));
    baseColor = vec4f(mix(baseColor.rgb, mix(vec3f(luma), vec3f(1.0, 0.15, 0.1), 0.65), u.uDamageFlash * 0.8), baseColor.a);
  }
  if (u.uSaturation < 0.999) {
    let luma = dot(baseColor.rgb, vec3f(0.2126, 0.7152, 0.0722));
    baseColor = vec4f(mix(vec3f(luma), baseColor.rgb, u.uSaturation), baseColor.a);
  }

  let V = normalize(u.uCameraPosition - in.worldPos);
  let F0 = mix(F0_DIELECTRIC * u.uReflectance, baseColor.rgb, metalness);

  let sunRadiance = u.uSunColor * u.uSunIntensity;
  let shadowFactor = sampleCascades(in.worldPos, in.viewDepth, in.shadowCoords);
  var color = computePBR(N, V, normalize(-u.uSunDirection), sunRadiance, baseColor.rgb, roughness, metalness, F0, ao) * shadowFactor;

  color = color + imageBasedApprox(N, V, roughness, F0, metalness, baseColor.rgb,
    u.uAmbientSky, u.uAmbientGround, u.uAmbientIntensity) * ao;

  // Point lights: muzzle flashes, lamps, explosions, objective beacons.
  for (var i = 0; i < MAX_POINT_LIGHTS; i = i + 1) {
    if (i >= u.uPointLightCount) { break; }
    let toLight = u.uPointLightPositions[i] - in.worldPos;
    let dist = length(toLight);
    let range = u.uPointLightRanges[i];
    if (dist <= range) {
      let L = toLight / max(dist, 0.0001);
      let attenuation = pow(clamp(1.0 - dist / range, 0.0, 1.0), 2.0) / (1.0 + dist * dist * 0.05);
      let radiance = u.uPointLightColors[i] * u.uPointLightIntensities[i] * attenuation;
      color = color + computePBR(N, V, L, radiance, baseColor.rgb, roughness, metalness, F0, 1.0);
    }
  }

  let emissiveSample = textureSample(uTexture6, uSampler6, uv).rgb;
  color = color + u.uEmissive * select(vec3f(1.0), emissiveSample, u.uHasEmissiveMap > 0.5);

  color = applyFog(color, in.viewDepth, u.uFogColor, u.uFogStart, u.uFogEnd, u.uFogDensity, u.uFogMode);
  let heightFog = exp(-max(in.worldPos.y, 0.0) * 0.06) * 0.12 * u.uSkyLuminance;
  color = mix(color, u.uFogColor, clamp(heightFog, 0.0, 0.4) * select(0.0, 1.0, u.uFogMode > 0.5));

  return vec4f(color, baseColor.a);
}
`;

export const SHADOW_WGSL = /* wgsl */`
struct Uniforms {
  uBoneMatrices: array<mat4x4f, MAX_BONES>,
  uModelMatrix: mat4x4f,
  uLightViewProjection: mat4x4f,
  uHasAlbedoMap: f32,
  uAlphaCutoff: f32,
  uTint: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([1])}

struct ShadowOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(2) uv: vec2f,
#ifdef INSTANCED
  @location(8) instanceMatrix0: vec4f,
  @location(9) instanceMatrix1: vec4f,
  @location(10) instanceMatrix2: vec4f,
  @location(11) instanceMatrix3: vec4f,
#endif
#ifdef SKINNED
  @location(6) skinIndex: vec4<u32>,
  @location(7) skinWeight: vec4f,
#endif
) -> ShadowOut {
  var out: ShadowOut;
  var localPos = position;
#ifdef SKINNED
  let skinMatrix = mat4x4f(0.0)
    + skinWeight.x * u.uBoneMatrices[skinIndex.x]
    + skinWeight.y * u.uBoneMatrices[skinIndex.y]
    + skinWeight.z * u.uBoneMatrices[skinIndex.z]
    + skinWeight.w * u.uBoneMatrices[skinIndex.w];
  localPos = (skinMatrix * vec4f(localPos, 1.0)).xyz;
#endif
#ifdef INSTANCED
  let instanceMatrix = mat4x4f(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  let worldPos = instanceMatrix * vec4f(localPos, 1.0);
#else
  let worldPos = u.uModelMatrix * vec4f(localPos, 1.0);
#endif
  out.uv = uv;
  out.position = u.uLightViewProjection * worldPos;
  return out;
}

@fragment
fn fs_main(in: ShadowOut) -> @location(0) vec4f {
#ifdef ALPHA_TEST
  var a = u.uTint.a;
  if (u.uHasAlbedoMap > 0.5) { a = a * textureSample(uTexture1, uSampler1, in.uv).a; }
  if (a < u.uAlphaCutoff) { discard; }
#endif
  return vec4f(1.0);
}
`;

export const VIEWMODEL_WGSL = /* wgsl */`
struct Uniforms {
  uModelMatrix: mat4x4f,
  uNormalMatrix: mat3x3f,
  uViewProjectionMatrix: mat4x4f,
  uTime: f32,
  uSwayOffset: vec3f,
  uWeaponBob: vec2f,
  uWeaponRotation: vec3f,
  uAdsBlend: f32,
  uAdsPosition: vec2f,
  uFovScale: f32,
  uAlbedoColor: vec3f,
  uHasAlbedoMap: f32,
  uHasNormalMap: f32,
  uRoughness: f32,
  uMetalness: f32,
  uSunDirection: vec3f,
  uSunColor: vec3f,
  uSunIntensity: f32,
  uAmbientSky: vec3f,
  uAmbientGround: vec3f,
  uAmbientIntensity: f32,
  uCameraPosition: vec3f,
  uTint: vec4f,
  uMuzzleFlashColor: vec3f,
  uMuzzleFlashIntensity: f32,
  uMuzzleFlashPosition: vec3f,
  uDamageFlash: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([1, 2])}

struct ViewModelOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec4f,
};

fn rotationMatrix(axisIn: vec3f, angle: f32) -> mat4x4f {
  let axis = normalize(axisIn);
  let s = sin(angle);
  let c = cos(angle);
  let oc = 1.0 - c;
  return mat4x4f(
    vec4f(oc * axis.x * axis.x + c, oc * axis.x * axis.y - axis.z * s, oc * axis.z * axis.x + axis.y * s, 0.0),
    vec4f(oc * axis.x * axis.y + axis.z * s, oc * axis.y * axis.y + c, oc * axis.y * axis.z - axis.x * s, 0.0),
    vec4f(oc * axis.z * axis.x - axis.y * s, oc * axis.y * axis.z + axis.x * s, oc * axis.z * axis.z + c, 0.0),
    vec4f(0.0, 0.0, 0.0, 1.0));
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(4) color: vec4f,
) -> ViewModelOut {
  var out: ViewModelOut;
  // ADS brings the sights to the centre of the screen; bob and sway are camera-space offsets.
  let adsPos = vec3f(u.uAdsPosition.x, u.uAdsPosition.y, 0.0);
  let offset = mix(vec3f(u.uWeaponBob.x, u.uWeaponBob.y, 0.0), adsPos, u.uAdsBlend) + u.uSwayOffset;
  let rot = rotationMatrix(vec3f(1.0, 0.0, 0.0), u.uWeaponRotation.x)
          * rotationMatrix(vec3f(0.0, 1.0, 0.0), u.uWeaponRotation.y)
          * rotationMatrix(vec3f(0.0, 0.0, 1.0), u.uWeaponRotation.z);
  let transformed = (rot * vec4f(position, 1.0)).xyz + offset;
  let worldPos = u.uModelMatrix * vec4f(transformed, 1.0);
  out.worldPos = worldPos.xyz;
  out.normal = normalize(u.uNormalMatrix * (rot * vec4f(normal, 0.0)).xyz);
  out.uv = uv;
  out.color = color;
  var clip = u.uViewProjectionMatrix * worldPos;
  // Slight depth pull so the weapon never clips through world geometry near the camera.
  clip.z = clip.z * 0.98;
  out.position = clip;
  return out;
}

@fragment
fn fs_main(in: ViewModelOut) -> @location(0) vec4f {
  let N = normalize(in.normal);
  let V = normalize(u.uCameraPosition - in.worldPos);
  var baseColor = u.uAlbedoColor * in.color.rgb * u.uTint.rgb;
  baseColor = baseColor * select(vec3f(1.0), textureSample(uTexture1, uSampler1, in.uv).rgb, u.uHasAlbedoMap > 0.5);

  let L = normalize(-u.uSunDirection);
  let NdotL = max(dot(N, L), 0.0);
  let H = normalize(V + L);
  let spec = pow(max(dot(N, H), 0.0), mix(8.0, 220.0, 1.0 - u.uRoughness)) * (1.0 - u.uRoughness);
  let diffuse = baseColor * (NdotL * u.uSunColor * u.uSunIntensity + mix(u.uAmbientGround, u.uAmbientSky, N.y * 0.5 + 0.5) * u.uAmbientIntensity);
  let specular = u.uSunColor * spec * u.uSunIntensity * mix(0.06, 0.35, 1.0 - u.uRoughness);
  var color = diffuse + specular;

  // The muzzle flash lights the weapon from the barrel — this is what makes night fights read.
  if (u.uMuzzleFlashIntensity > 0.001) {
    let toFlash = u.uMuzzleFlashPosition - in.worldPos;
    let d = length(toFlash);
    let fl = toFlash / max(d, 0.001);
    let falloff = 1.0 / (1.0 + d * d * 3.0);
    let lambert = max(dot(N, fl), 0.0);
    color = color + u.uMuzzleFlashColor * u.uMuzzleFlashIntensity * falloff * lambert * 3.0;
  }
  if (u.uDamageFlash > 0.001) { color = mix(color, vec3f(0.6, 0.05, 0.03), u.uDamageFlash * 0.5); }
  return vec4f(color, 1.0);
}
`;

/** WebGPU pipeline metadata for a program (attributes, targets, culling defaults). */
export const GEOMETRY_PROGRAM = {
  name: 'geometry',
  code: GEOMETRY_WGSL,
  vertexEntry: 'vs_main',
  fragmentEntry: 'fs_main',
  textures: GEOMETRY_TEXTURE_UNITS,
  depthTextures: ['uShadowMap0', 'uShadowMap1', 'uShadowMap2', 'uShadowMap3'],
  comparisonSamplers: ['uShadowMap0', 'uShadowMap1', 'uShadowMap2', 'uShadowMap3'],
  attributes: ['position', 'normal', 'uv', 'uv1', 'color', 'tangent'],
  featureAttributes: {
    INSTANCED: ['instanceMatrix0', 'instanceMatrix1', 'instanceMatrix2', 'instanceMatrix3', 'instanceColor', 'instanceParams'],
    SKINNED: ['skinIndex', 'skinWeight'],
  },
  defines: DEFAULT_SHADER_DEFINES,
};

export const SHADOW_PROGRAM = {
  name: 'shadow',
  code: SHADOW_WGSL,
  vertexEntry: 'vs_main',
  fragmentEntry: 'fs_main',
  textures: { uAlbedoMap: 1 },
  attributes: ['position', 'uv'],
  featureAttributes: {
    INSTANCED: ['instanceMatrix0', 'instanceMatrix1', 'instanceMatrix2', 'instanceMatrix3'],
    SKINNED: ['skinIndex', 'skinWeight'],
    ALPHA_TEST: [],
  },
  defines: DEFAULT_SHADER_DEFINES,
};

export const VIEWMODEL_PROGRAM = {
  name: 'viewmodel',
  code: VIEWMODEL_WGSL,
  vertexEntry: 'vs_main',
  fragmentEntry: 'fs_main',
  textures: { uAlbedoMap: 1, uNormalMap: 2 },
  attributes: ['position', 'normal', 'uv', 'color'],
  featureAttributes: {},
  defines: DEFAULT_SHADER_DEFINES,
};

void textureSlot;
