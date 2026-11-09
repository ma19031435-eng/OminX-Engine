/**
 * OminX Engine — GLSL shader sources.
 *
 * One forward PBR pass handles opaque geometry (with CSM shadows, fog, emissive, alpha-test,
 * GPU instancing and skinning as compile-time variants). Extra passes handle the effects an
 * FPS lives on: weapon viewmodel, decals (bullet holes/blood), particles (smoke/sparks/dust),
 * tracers, sprites, sky, and the post chain (bloom, tonemap, FXAA, damage vignette).
 *
 * @module engine/renderer/shaders
 */
import { GLSL } from '../gl/Shader.js';

const VARYINGS = {
  worldPos: 'vWorldPos',
};
void VARYINGS;

// ---------------------------------------------------------------------------
// Shared vertex stage for opaque geometry
// ---------------------------------------------------------------------------
export const GEOMETRY_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
layout(location = 3) in vec2 uv1;
layout(location = 4) in vec4 color;
layout(location = 5) in vec4 tangent;
#ifdef INSTANCED
layout(location = 8) in vec4 instanceMatrix0;
layout(location = 9) in vec4 instanceMatrix1;
layout(location = 10) in vec4 instanceMatrix2;
layout(location = 11) in vec4 instanceMatrix3;
layout(location = 12) in vec4 instanceColor;
layout(location = 13) in vec4 instanceParams;
#endif
#ifdef SKINNED
layout(location = 6) in uvec4 skinIndex;
layout(location = 7) in vec4 skinWeight;
uniform mat4 uBoneMatrices[MAX_BONES];
#endif
uniform mat4 uModelMatrix;
uniform mat3 uNormalMatrix;
uniform mat4 uViewMatrix;
uniform mat4 uProjectionMatrix;
uniform mat4 uViewProjectionMatrix;
#ifdef SHADOW_CASCADES
uniform mat4 uShadowMatrices[MAX_SHADOW_CASCADES];
#endif
uniform float uTime;
#ifdef WIND
uniform float uWindStrength;
uniform float uWindSpeed;
uniform vec3 uWindDirection;
#endif

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;
out vec2 vUV1;
out vec4 vColor;
out vec3 vTangent;
out vec3 vBitangent;
out float vViewDepth;
out vec4 vShadowCoord[MAX_SHADOW_CASCADES];
out vec3 vObjectPos;
#ifdef INSTANCED
flat out float vInstanceParam0;
#endif

void main() {
  vec3 localPos = position;
  vec3 localNormal = normal;
#ifdef SKINNED
  mat4 skinMatrix = mat4(0.0);
  skinMatrix += skinWeight.x * uBoneMatrices[skinIndex.x];
  skinMatrix += skinWeight.y * uBoneMatrices[skinIndex.y];
  skinMatrix += skinWeight.z * uBoneMatrices[skinIndex.z];
  skinMatrix += skinWeight.w * uBoneMatrices[skinIndex.w];
  vec4 skinned = skinMatrix * vec4(localPos, 1.0);
  localPos = skinned.xyz;
  localNormal = normalize(mat3(skinMatrix) * localNormal);
#endif
  #ifdef INSTANCED
  mat4 instanceMatrix = mat4(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  // Per-instance sway: foliage/props bend in the wind without CPU cost.
  #ifdef WIND
  float swayPhase = instanceMatrix[3].x * 0.6 + instanceMatrix[3].z * 0.4;
  float heightFactor = max(localPos.y, 0.0);
  localPos.xz += uWindDirection.xz * sin(uTime * uWindSpeed + swayPhase) * uWindStrength * heightFactor * vInstanceParamScale;
  #endif
  vec4 worldPos = instanceMatrix * vec4(localPos, 1.0);
  vInstanceParam0 = instanceParams.x;
  #else
  vec4 worldPos = uModelMatrix * vec4(localPos, 1.0);
  #endif
  vObjectPos = position;
  vWorldPos = worldPos.xyz;
  #ifdef INSTANCED
  vNormal = normalize(mat3(instanceMatrix) * localNormal);
  vTangent = normalize(mat3(instanceMatrix) * tangent.xyz);
  vColor = color * instanceColor;
  #else
  vNormal = normalize(uNormalMatrix * localNormal);
  vTangent = normalize(uNormalMatrix * tangent.xyz);
  vColor = color;
  #endif
  vBitangent = cross(vNormal, vTangent) * (tangent.w >= 0.0 ? 1.0 : -1.0);
  vUV = uv;
  vUV1 = uv1;
  vec4 viewPos = uViewMatrix * worldPos;
  vViewDepth = -viewPos.z;
  gl_Position = uProjectionMatrix * viewPos;
  #ifdef SHADOW_CASCADES
  for (int i = 0; i < MAX_SHADOW_CASCADES; i++) {
    vShadowCoord[i] = uShadowMatrices[i] * worldPos;
  }
  #endif
}
`.replace('vInstanceParamScale', 'uWindStrength');

// ---------------------------------------------------------------------------
// PBR fragment stage
// ---------------------------------------------------------------------------
export const GEOMETRY_FRAGMENT = /* glsl */`
${GLSL.constants}
${GLSL.srgb}
${GLSL.fog}
${GLSL.normalMapping}
${GLSL.shadowSampling}
${GLSL.rand}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vUV1;
in vec4 vColor;
in vec3 vTangent;
in vec3 vBitangent;
in float vViewDepth;
in vec3 vObjectPos;
#ifdef SHADOW_CASCADES
in vec4 vShadowCoord[MAX_SHADOW_CASCADES];
#endif

uniform vec3 uCameraPosition;

// --- material
uniform vec3 uAlbedoColor;
uniform float uOpacity;
uniform float uRoughness;
uniform float uMetalness;
uniform float uReflectance;
uniform vec3 uEmissive;
uniform float uAlphaCutoff;
uniform float uNormalStrength;
uniform vec2 uUVScale;
uniform float uAoStrength;
uniform vec4 uTint;            // per-object tint (team colors, damage flashes)
uniform float uUseVertexColor;
uniform float uSaturation;

// --- textures
uniform sampler2D uAlbedoMap;
uniform sampler2D uNormalMap;
uniform sampler2D uRoughnessMap;
uniform sampler2D uMetalnessMap;
uniform sampler2D uAoMap;
uniform sampler2D uEmissiveMap;
uniform float uHasAlbedoMap;
uniform float uHasNormalMap;
uniform float uHasRoughnessMap;
uniform float uHasMetalnessMap;
uniform float uHasAoMap;
uniform float uHasEmissiveMap;

// --- lighting
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform float uAmbientIntensity;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uFogMode;
uniform float uSkyLuminance;
uniform vec3 uCameraForward;

#define MAX_POINT_LIGHTS 16
uniform int uPointLightCount;
uniform vec3 uPointLightPositions[MAX_POINT_LIGHTS];
uniform vec3 uPointLightColors[MAX_POINT_LIGHTS];
uniform float uPointLightRanges[MAX_POINT_LIGHTS];
uniform float uPointLightIntensities[MAX_POINT_LIGHTS];

uniform sampler2D uShadowMap0;
uniform sampler2D uShadowMap1;
uniform sampler2D uShadowMap2;
uniform sampler2D uShadowMap3;
uniform vec2 uShadowTexelSize;
uniform float uShadowBias;
uniform float uShadowSoftness;
uniform float uShadowCascadeFade;
uniform float uShadowSplitDistances[MAX_SHADOW_CASCADES];
uniform float uTime;
uniform float uDamageFlash;   // 0..1 white/red overlay on the victim's body
uniform vec3 uUnderwaterTint;

out vec4 fragColor;

const vec3 F0_DIELECTRIC = vec3(0.04);

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}
float distributionGGX(vec3 N, vec3 H, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float NdotH = max(dot(N, H), 0.0);
  float NdotH2 = NdotH * NdotH;
  float denom = (NdotH2 * (a2 - 1.0) + 1.0);
  return a2 / max(PI * denom * denom, 0.0001);
}
float geometrySmith(float NdotV, float NdotL, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) / 8.0;
  float ggxV = NdotV / (NdotV * (1.0 - k) + k);
  float ggxL = NdotL / (NdotL * (1.0 - k) + k);
  return ggxV * ggxL;
}
vec3 computePBR(vec3 N, vec3 V, vec3 L, vec3 radiance, vec3 albedo, float roughness, float metalness, vec3 F0, float ao) {
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 0.0001);
  if (NdotL <= 0.0) return vec3(0.0);
  vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
  float D = distributionGGX(N, H, roughness);
  float G = geometrySmith(NdotV, NdotL, roughness);
  vec3 specular = (D * G * F) / max(4.0 * NdotV * NdotL, 0.0001);
  vec3 kD = (vec3(1.0) - F) * (1.0 - metalness);
  vec3 diffuse = kD * albedo / PI;
  return (diffuse + specular) * radiance * NdotL * ao;
}
/** Cheap analytic environment: sky gradient + ground bounce. Sells outdoor FPS maps without IBL data. */
vec3 imageBasedApprox(vec3 N, vec3 V, float roughness, vec3 F0, float metalness, vec3 albedo) {
  float up = N.y * 0.5 + 0.5;
  vec3 sky = mix(uAmbientGround, uAmbientSky, up);
  vec3 R = reflect(-V, N);
  float rUp = R.y * 0.5 + 0.5;
  vec3 reflected = mix(uAmbientGround, uAmbientSky * 1.35, rUp);
  float fresnel = pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 4.0);
  vec3 specEnv = mix(reflected, reflected * 1.5, fresnel) * mix(1.0, 0.6, roughness);
  vec3 diffEnv = sky * albedo * (1.0 - metalness);
  return (diffEnv + specEnv * mix(F0, albedo, metalness)) * uAmbientIntensity;
}

float sampleCascades(vec3 worldPos, float viewDepth) {
#ifdef SHADOW_CASCADES
  int cascade = MAX_SHADOW_CASCADES - 1;
  for (int i = 0; i < MAX_SHADOW_CASCADES; i++) {
    if (viewDepth <= uShadowSplitDistances[i]) { cascade = i; break; }
  }
  vec4 coord;
  if (cascade == 0) coord = vShadowCoord[0];
  else if (cascade == 1) coord = vShadowCoord[1];
#if MAX_SHADOW_CASCADES > 2
  else if (cascade == 2) coord = vShadowCoord[2];
#endif
#if MAX_SHADOW_CASCADES > 3
  else coord = vShadowCoord[3];
#endif
  vec3 proj = coord.xyz / coord.w * 0.5 + 0.5;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;
  float bias = uShadowBias * (1.0 + viewDepth * 0.02);
  vec2 uv = proj.xy;
  float seed = hash12(uv * 512.0);
  float shadow;
  if (cascade == 0) shadow = sampleShadowPoisson(uShadowMap0, uv, proj.z - bias, uShadowTexelSize, uShadowSoftness, seed);
  else if (cascade == 1) shadow = sampleShadowPoisson(uShadowMap1, uv, proj.z - bias, uShadowTexelSize, uShadowSoftness * 1.4, seed);
#if MAX_SHADOW_CASCADES > 2
  else if (cascade == 2) shadow = sampleShadowPoisson(uShadowMap2, uv, proj.z - bias, uShadowTexelSize, uShadowSoftness * 1.8, seed);
#endif
#if MAX_SHADOW_CASCADES > 3
  else shadow = sampleShadowPoisson(uShadowMap3, uv, proj.z - bias, uShadowTexelSize, uShadowSoftness * 2.1, seed);
#endif
  else shadow = 1.0;
  // fade the outermost cascade into unshadowed to avoid a hard edge in the distance
  float lastSplit = uShadowSplitDistances[MAX_SHADOW_CASCADES - 1];
  float fade = clamp((lastSplit - viewDepth) / max(uShadowCascadeFade, 0.001), 0.0, 1.0);
  return mix(1.0, shadow, cascade == MAX_SHADOW_CASCADES - 1 ? fade : 1.0);
#else
  return 1.0;
#endif
}

void main() {
  vec2 uv = vUV * uUVScale;
  vec2 uvB = vUV1 * uUVScale;

  vec4 baseColor = vec4(uAlbedoColor, uOpacity) * uTint;
  if (uUseVertexColor > 0.5) baseColor *= vColor;
  if (uHasAlbedoMap > 0.5) baseColor *= texture(uAlbedoMap, uv);

  if (uAlphaCutoff > 0.0 && baseColor.a < uAlphaCutoff) discard;
  if (baseColor.a <= 0.001) discard;

  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  if (uHasNormalMap > 0.5) {
    N = perturbNormal(uNormalMap, uv, N, normalize(vTangent), normalize(vBitangent), uNormalStrength);
  }

  float roughness = clamp(uRoughness, 0.045, 1.0);
  if (uHasRoughnessMap > 0.5) roughness = clamp(roughness * texture(uRoughnessMap, uv).g, 0.045, 1.0);
  float metalness = clamp(uMetalness, 0.0, 1.0);
  if (uHasMetalnessMap > 0.5) metalness = clamp(metalness * texture(uMetalnessMap, uv).b, 0.0, 1.0);
  float ao = 1.0;
  if (uHasAoMap > 0.5) ao = mix(1.0, texture(uAoMap, uv).r, uAoStrength);

  // Desaturate for the damage/spectator flash without a second pass.
  if (uDamageFlash > 0.001) {
    float luma = dot(baseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    baseColor.rgb = mix(baseColor.rgb, mix(vec3(luma), vec3(1.0, 0.15, 0.1), 0.65), uDamageFlash * 0.8);
  }
  if (uSaturation < 0.999) {
    float luma = dot(baseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    baseColor.rgb = mix(vec3(luma), baseColor.rgb, uSaturation);
  }

  vec3 V = normalize(uCameraPosition - vWorldPos);
  vec3 F0 = mix(F0_DIELECTRIC * uReflectance, baseColor.rgb, metalness);

  // --- sun
  vec3 sunRadiance = uSunColor * uSunIntensity;
  float shadowFactor = sampleCascades(vWorldPos, vViewDepth);
  vec3 color = computePBR(N, V, normalize(-uSunDirection), sunRadiance, baseColor.rgb, roughness, metalness, F0, ao) * shadowFactor;

  // --- ambient / IBL approximation
  color += imageBasedApprox(N, V, roughness, F0, metalness, baseColor.rgb) * ao;

  // --- point lights (muzzle flashes, lamps, explosions, objective beacons)
  for (int i = 0; i < MAX_POINT_LIGHTS; i++) {
    if (i >= uPointLightCount) break;
    vec3 toLight = uPointLightPositions[i] - vWorldPos;
    float dist = length(toLight);
    float range = uPointLightRanges[i];
    if (dist > range) continue;
    vec3 L = toLight / max(dist, 0.0001);
    float attenuation = pow(clamp(1.0 - dist / range, 0.0, 1.0), 2.0) / (1.0 + dist * dist * 0.05);
    vec3 radiance = uPointLightColors[i] * uPointLightIntensities[i] * attenuation;
    color += computePBR(N, V, L, radiance, baseColor.rgb, roughness, metalness, F0, 1.0);
  }

  // --- emissive
  vec3 emissive = uEmissive;
  if (uHasEmissiveMap > 0.5) emissive *= texture(uEmissiveMap, uv).rgb;
  color += emissive;

  // --- fog (distance + optional height fog for low-lying mist on maps)
  color = applyFog(color, vViewDepth, uFogColor, uFogStart, uFogEnd, uFogDensity, uFogMode);
  float heightFog = exp(-max(vWorldPos.y, 0.0) * 0.06) * 0.12 * uSkyLuminance;
  color = mix(color, uFogColor, clamp(heightFog, 0.0, 0.4) * (uFogMode > 0.5 ? 1.0 : 0.0));

  fragColor = vec4(color, baseColor.a);
}
`;

/** Depth-only pass for shadow maps. Variants: INSTANCED, SKINNED, ALPHA_TEST. */
export const SHADOW_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 2) in vec2 uv;
layout(location = 4) in vec4 color;
#ifdef INSTANCED
layout(location = 8) in vec4 instanceMatrix0;
layout(location = 9) in vec4 instanceMatrix1;
layout(location = 10) in vec4 instanceMatrix2;
layout(location = 11) in vec4 instanceMatrix3;
layout(location = 12) in vec4 instanceColor;
layout(location = 13) in vec4 instanceParams;
#endif
#ifdef SKINNED
layout(location = 6) in uvec4 skinIndex;
layout(location = 7) in vec4 skinWeight;
uniform mat4 uBoneMatrices[MAX_BONES];
#endif
uniform mat4 uModelMatrix;
uniform mat4 uLightViewProjection;
out vec2 vUV;
out float vDepth;
void main() {
  vec3 localPos = position;
#ifdef SKINNED
  mat4 skinMatrix = mat4(0.0);
  skinMatrix += skinWeight.x * uBoneMatrices[skinIndex.x];
  skinMatrix += skinWeight.y * uBoneMatrices[skinIndex.y];
  skinMatrix += skinWeight.z * uBoneMatrices[skinIndex.z];
  skinMatrix += skinWeight.w * uBoneMatrices[skinIndex.w];
  localPos = (skinMatrix * vec4(localPos, 1.0)).xyz;
#endif
  #ifdef INSTANCED
  mat4 instanceMatrix = mat4(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  vec4 worldPos = instanceMatrix * vec4(localPos, 1.0);
  #else
  vec4 worldPos = uModelMatrix * vec4(localPos, 1.0);
  #endif
  vUV = uv;
  vDepth = worldPos.y;
  gl_Position = uLightViewProjection * worldPos;
}
`;

export const SHADOW_FRAGMENT = /* glsl */`
in vec2 vUV;
in float vDepth;
uniform sampler2D uAlbedoMap;
uniform float uHasAlbedoMap;
uniform float uAlphaCutoff;
uniform vec4 uTint;
out vec4 fragColor;
void main() {
  #ifdef ALPHA_TEST
  float a = uTint.a;
  if (uHasAlbedoMap > 0.5) a *= texture(uAlbedoMap, vUV).a;
  if (a < uAlphaCutoff) discard;
  #endif
  fragColor = vec4(1.0);
}
`;

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------
export const SKY_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
uniform mat4 uInverseViewProjection;
uniform vec3 uCameraPosition;
out vec3 vWorldDirection;
void main() {
  vec4 worldPos = uInverseViewProjection * vec4(position.xy, 1.0, 1.0);
  vWorldDirection = normalize(worldPos.xyz / worldPos.w - uCameraPosition);
  gl_Position = vec4(position.xy, 0.999999, 1.0);
}
`;

export const SKY_FRAGMENT = /* glsl */`
${GLSL.constants}
${GLSL.rand}
${GLSL.noise}
in vec3 vWorldDirection;
uniform vec3 uSkyZenithColor;
uniform vec3 uSkyHorizonColor;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uGroundColor;
uniform float uTime;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudSpeed;
uniform float uStarIntensity;
uniform float uSkyExposure;
uniform float uMoonPhase;
uniform vec3 uMoonDirection;
out vec4 fragColor;

float cloudLayer(vec3 dir, float coverage, float density, float sharpness) {
  if (dir.y < 0.02) return 0.0;
  vec3 p = dir / max(dir.y, 0.02);
  vec2 uv = p.xz * 0.55;
  float t = uTime * uCloudSpeed * 0.02;
  vec3 q = vec3(uv + vec2(t, t * 0.6), t * 0.15);
  float f = fbm3(q * 1.6);
  f += 0.5 * fbm3(q * 3.7 + 11.3);
  f = f * 0.62 + 0.28;
  float mask = smoothstep(coverage, coverage + sharpness, f);
  float heightFade = smoothstep(0.02, 0.35, dir.y);
  return clamp(mask * heightFade * density, 0.0, 1.0);
}

void main() {
  vec3 dir = normalize(vWorldDirection);
  float up = clamp(dir.y, -1.0, 1.0);
  float horizonBlend = pow(clamp(1.0 - abs(up), 0.0, 1.0), 3.2);
  vec3 sky = mix(uSkyZenithColor, uSkyHorizonColor, horizonBlend);
  sky = mix(uGroundColor, sky, smoothstep(-0.12, 0.06, up));

  // --- sun disc + limb glow
  float sunDot = dot(dir, normalize(-uSunDirection));
  float sunDisc = smoothstep(0.9993, 0.99985, sunDot);
  float sunGlow = pow(clamp(sunDot, 0.0, 1.0), 220.0) * 0.85 + pow(clamp(sunDot, 0.0, 1.0), 8.0) * 0.22;
  sky += uSunColor * uSunIntensity * (sunDisc * 14.0 + sunGlow);

  // --- moon
  float moonDot = dot(dir, normalize(-uMoonDirection));
  float moon = smoothstep(0.9990, 0.9997, moonDot);
  sky += vec3(0.85, 0.88, 0.95) * moon * (1.0 - uSunIntensity * 0.5) * uMoonPhase;
  sky += vec3(0.3, 0.35, 0.5) * pow(clamp(moonDot, 0.0, 1.0), 12.0) * uMoonPhase * 0.12;

  // --- stars (fade in as the sun goes down)
  float starMask = clamp(1.0 - uSunIntensity * 0.55, 0.0, 1.0) * uStarIntensity * smoothstep(0.0, 0.25, up);
  if (starMask > 0.001) {
    vec3 sp = dir * 220.0;
    float star = hash13(floor(sp));
    float twinkle = 0.65 + 0.35 * sin(uTime * 2.0 + star * 40.0);
    sky += vec3(0.9, 0.94, 1.0) * smoothstep(0.9975, 0.99995, star) * starMask * twinkle * 4.0;
  }

  // --- clouds
  float clouds = cloudLayer(dir, uCloudCoverage, uCloudDensity, 0.16);
  vec3 cloudLit = mix(vec3(0.42, 0.45, 0.5), uSunColor * 1.1 + vec3(0.5), clamp(sunDot * 0.5 + 0.5, 0.0, 1.0));
  sky = mix(sky, cloudLit, clouds);

  fragColor = vec4(sky * uSkyExposure, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Decals — bullet holes, blood, scorch marks projected onto world geometry
// ---------------------------------------------------------------------------
export const DECAL_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 2) in vec2 uv;
layout(location = 8) in vec4 instanceMatrix0;
layout(location = 9) in vec4 instanceMatrix1;
layout(location = 10) in vec4 instanceMatrix2;
layout(location = 11) in vec4 instanceMatrix3;
layout(location = 12) in vec4 instanceColor;
layout(location = 13) in vec4 instanceParams;
uniform mat4 uViewProjectionMatrix;
out vec2 vUV;
out vec4 vColor;
out vec3 vLocalPos;
out vec3 vWorldPos;
void main() {
  mat4 instanceMatrix = mat4(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  vec4 worldPos = instanceMatrix * vec4(position, 1.0);
  vLocalPos = position;
  vWorldPos = worldPos.xyz;
  // animate decal fade-out through instanceParams.y (0=alive, 1=garbage)
  vUV = uv * instanceParams.z + instanceParams.xy;
  vColor = instanceColor;
  gl_Position = uViewProjectionMatrix * worldPos;
}
`;

export const DECAL_FRAGMENT = /* glsl */`
in vec2 vUV;
in vec4 vColor;
in vec3 vWorldPos;
uniform sampler2D uDecalAtlas;
uniform vec3 uCameraPosition;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogMode;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uOpacity;
out vec4 fragColor;

void main() {
  vec4 tex = texture(uDecalAtlas, vUV);
  float alpha = tex.a * vColor.a * uOpacity;
  if (alpha < 0.004) discard;
  vec3 color = tex.rgb * vColor.rgb;
  float dist = distance(uCameraPosition, vWorldPos);
  color = applyFogSimple(color, dist);
  fragColor = vec4(color, alpha);
}
`.replace('color = applyFogSimple(color, dist);', 'color = mix(color, uFogColor, uFogMode > 0.5 ? clamp((dist - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0) * 0.85 : 0.0);');

// ---------------------------------------------------------------------------
// Particles — instanced camera-facing quads, used for smoke, sparks, blood, dust
// ---------------------------------------------------------------------------
export const PARTICLE_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 2) in vec2 uv;
layout(location = 8) in vec4 instanceMatrix0;   // particle world position + size packed
layout(location = 9) in vec4 instanceMatrix1;
layout(location = 10) in vec4 instanceMatrix2;
layout(location = 11) in vec4 instanceMatrix3;
layout(location = 12) in vec4 instanceColor;    // rgb tint + alpha
layout(location = 13) in vec4 instanceParams;   // x: rotation, y: atlasIndex, z: softness, w: motionStretch
uniform mat4 uViewProjectionMatrix;
uniform mat4 uViewMatrix;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform vec3 uCameraPosition;
out vec2 vUV;
out vec4 vColor;
out vec2 vLocalUV;
out float vSoftness;
out vec3 vWorldPos;
void main() {
  vec3 center = instanceMatrix0.xyz;
  float size = instanceMatrix0.w;
  float rot = instanceParams.x;
  float atlas = instanceParams.y;
  float stretch = instanceParams.w;

  vec2 quad = position.xy * size;
  float c = cos(rot), s = sin(rot);
  vec2 rotated = vec2(quad.x * c - quad.y * s, quad.x * s + quad.y * c);

  vec3 right = uCameraRight;
  vec3 up = uCameraUp;
  if (stretch > 0.001) {
    // Motion-stretched billboard: particles become streaks aligned to their velocity.
    vec3 velDir = normalize(instanceMatrix1.xyz + vec3(0.0001));
    vec3 toCam = normalize(uCameraPosition - center);
    vec3 side = normalize(cross(velDir, toCam));
    right = side;
    up = velDir;
    rotated.y *= stretch;
  }
  vec3 worldPos = center + right * rotated.x + up * rotated.y;
  vWorldPos = worldPos;
  vColor = instanceColor;
  vLocalUV = uv;
  vSoftness = instanceParams.z;
  vec2 tile = vec2(mod(atlas, 4.0), floor(atlas / 4.0));
  vUV = (uv + tile) * 0.25;
  gl_Position = uViewProjectionMatrix * vec4(worldPos, 1.0);
}
`;

export const PARTICLE_FRAGMENT = /* glsl */`
in vec2 vUV;
in vec4 vColor;
in vec2 vLocalUV;
in float vSoftness;
in vec3 vWorldPos;
uniform sampler2D uParticleTexture;
uniform vec3 uCameraPosition;
uniform float uFogMode;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
out vec4 fragColor;

void main() {
  vec4 tex = texture(uParticleTexture, vUV);
  float alpha = tex.a * vColor.a;
  if (alpha < 0.002) discard;
  vec3 color = tex.rgb * vColor.rgb;
  float dist = distance(uCameraPosition, vWorldPos);
  color = mix(color, uFogColor, uFogMode > 0.5 ? clamp((dist - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0) * 0.5 : 0.0);
  fragColor = vec4(color * alpha, alpha);
}
`;

// ---------------------------------------------------------------------------
// Sprites & tracers (unlit additive/alpha billboards in world space)
// ---------------------------------------------------------------------------
export const SPRITE_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 2) in vec2 uv;
uniform mat4 uModelMatrix;
uniform mat4 uViewProjectionMatrix;
uniform vec3 uCameraPosition;
uniform vec2 uSize;
uniform float uBillboard;    // 1 = face camera, 0 = use model matrix orientation
uniform vec4 uUVOffset;      // xy = tile offset, zw = scale
out vec2 vUV;
out vec3 vWorldPos;
void main() {
  vec3 worldPos;
  if (uBillboard > 0.5) {
    vec3 right = normalize(vec3(uViewProjectionMatrix[0][0], uViewProjectionMatrix[1][0], uViewProjectionMatrix[2][0]));
    vec3 up = normalize(vec3(uViewProjectionMatrix[0][1], uViewProjectionMatrix[1][1], uViewProjectionMatrix[2][1]));
    vec3 center = uModelMatrix[3].xyz;
    // For tracer streaks we orient along the ray instead of facing the camera.
    worldPos = center + right * position.x * uSize.x + up * position.y * uSize.y;
  } else {
    worldPos = (uModelMatrix * vec4(position.xy * uSize, position.z, 1.0)).xyz;
  }
  vWorldPos = worldPos;
  vUV = uv * uUVOffset.zw + uUVOffset.xy;
  gl_Position = uViewProjectionMatrix * vec4(worldPos, 1.0);
}
`;

export const SPRITE_FRAGMENT = /* glsl */`
in vec2 vUV;
in vec3 vWorldPos;
uniform sampler2D uTexture;
uniform vec4 uColor;
uniform vec3 uCameraPosition;
uniform vec3 uFogColor;
uniform float uFogMode;
uniform float uFogStart;
uniform float uFogEnd;
out vec4 fragColor;
void main() {
  vec4 tex = texture(uTexture, vUV);
  vec4 c = tex * uColor;
  if (c.a < 0.003) discard;
  float dist = distance(uCameraPosition, vWorldPos);
  c.rgb = mix(c.rgb, uFogColor, uFogMode > 0.5 ? clamp((dist - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0) * 0.6 : 0.0);
  // Premultiplied output keeps additive + alpha blending consistent.
  fragColor = vec4(c.rgb * c.a, c.a);
}
`;

// ---------------------------------------------------------------------------
// Lines (tracers, debug rays, bot navigation debug)
// ---------------------------------------------------------------------------
export const LINE_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 4) in vec4 color;
uniform mat4 uViewProjectionMatrix;
out vec4 vColor;
void main() {
  vColor = color;
  gl_Position = uViewProjectionMatrix * vec4(position, 1.0);
}
`;
export const LINE_FRAGMENT = /* glsl */`
in vec4 vColor;
uniform vec4 uTint;
out vec4 fragColor;
void main() { fragColor = vColor * uTint; }
`;

/** Thick 3D tracer: a camera-facing ribbon between two world points. */
export const TRACER_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;      // x:0..1 along the streak, y: side offset, z: width scale
layout(location = 8) in vec4 instanceMatrix0;  // start.xyz, width
layout(location = 9) in vec4 instanceMatrix1;  // end.xyz, intensity
layout(location = 10) in vec4 instanceMatrix2; // color.rgb, life
layout(location = 11) in vec4 instanceMatrix3; // unused
layout(location = 12) in vec4 instanceColor;
layout(location = 13) in vec4 instanceParams;
uniform mat4 uViewProjectionMatrix;
uniform vec3 uCameraPosition;
out vec2 vUV;
out vec4 vColor;
void main() {
  vec3 start = instanceMatrix0.xyz;
  vec3 end = instanceMatrix1.xyz;
  vec3 center = mix(start, end, position.x);
  vec3 dir = normalize(end - start + vec3(0.00001));
  vec3 toCam = normalize(uCameraPosition - center);
  vec3 side = normalize(cross(dir, toCam));
  float width = instanceMatrix0.w * position.z;
  vec3 worldPos = center + side * position.y * width;
  vUV = vec2(position.x, position.y * 0.5 + 0.5);
  vColor = vec4(instanceMatrix2.rgb * instanceColor.rgb, instanceMatrix2.a * instanceColor.a * instanceMatrix1.w);
  gl_Position = uViewProjectionMatrix * vec4(worldPos, 1.0);
}
`;

export const TRACER_FRAGMENT = /* glsl */`
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTexture;
uniform float uTime;
out vec4 fragColor;
void main() {
  float core = smoothstep(0.0, 0.35, 1.0 - abs(vUV.y * 2.0 - 1.0));
  float head = smoothstep(0.75, 1.0, vUV.x);
  float tail = smoothstep(0.0, 0.45, vUV.x);
  float alpha = vColor.a * core * tail * (1.0 + head * 1.6);
  if (alpha < 0.003) discard;
  vec3 color = mix(vColor.rgb, vec3(1.0), head * 0.7);
  fragColor = vec4(color * alpha, alpha);
}
`;

// ---------------------------------------------------------------------------
// Weapon viewmodel — separate camera, depth cleared, gets its own lighting + sway
// ---------------------------------------------------------------------------
export const VIEWMODEL_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
layout(location = 4) in vec4 color;
uniform mat4 uModelMatrix;
uniform mat3 uNormalMatrix;
uniform mat4 uViewProjectionMatrix;
uniform float uTime;
uniform vec3 uSwayOffset;
uniform vec2 uWeaponBob;
uniform vec3 uWeaponRotation;
uniform float uAdsBlend;
uniform vec2 uAdsPosition;
uniform float uFovScale;
out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;
out vec4 vColor;
mat4 rotationMatrix(vec3 axis, float angle) {
  axis = normalize(axis);
  float s = sin(angle); float c = cos(angle); float oc = 1.0 - c;
  return mat4(oc * axis.x * axis.x + c, oc * axis.x * axis.y - axis.z * s, oc * axis.z * axis.x + axis.y * s, 0.0,
              oc * axis.x * axis.y + axis.z * s, oc * axis.y * axis.y + c, oc * axis.y * axis.z - axis.x * s, 0.0,
              oc * axis.z * axis.x - axis.y * s, oc * axis.y * axis.z + axis.x * s, oc * axis.z * axis.z + c, 0.0,
              0.0, 0.0, 0.0, 1.0);
}
void main() {
  vec3 localPos = position;
  // ADS: bring the sights to the center of the screen.
  vec3 adsPos = vec3(uAdsPosition.x, uAdsPosition.y, 0.0);
  vec3 offset = mix(vec3(uWeaponBob.x, uWeaponBob.y, 0.0), adsPos, uAdsBlend) + uSwayOffset;
  mat4 rot = rotationMatrix(vec3(1.0, 0.0, 0.0), uWeaponRotation.x)
           * rotationMatrix(vec3(0.0, 1.0, 0.0), uWeaponRotation.y)
           * rotationMatrix(vec3(0.0, 0.0, 1.0), uWeaponRotation.z);
  vec3 transformed = (rot * vec4(localPos, 1.0)).xyz + offset;
  vec4 worldPos = uModelMatrix * vec4(transformed, 1.0);
  vWorldPos = worldPos.xyz;
  vNormal = normalize(uNormalMatrix * (rot * vec4(normal, 0.0)).xyz);
  vUV = uv;
  vColor = color;
  vec4 clip = uViewProjectionMatrix * worldPos;
  // Slight scale so the weapon mesh doesn't clip through world geometry near the camera.
  clip.z = clip.z * 0.98;
  gl_Position = clip;
}
`;

export const VIEWMODEL_FRAGMENT = /* glsl */`
${GLSL.constants}
${GLSL.fog}
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec4 vColor;
uniform vec3 uAlbedoColor;
uniform sampler2D uAlbedoMap;
uniform sampler2D uNormalMap;
uniform float uHasAlbedoMap;
uniform float uHasNormalMap;
uniform float uRoughness;
uniform float uMetalness;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform float uAmbientIntensity;
uniform vec3 uCameraPosition;
uniform vec4 uTint;
uniform vec3 uMuzzleFlashColor;
uniform float uMuzzleFlashIntensity;
uniform vec3 uMuzzleFlashPosition;
uniform float uDamageFlash;
out vec4 fragColor;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPosition - vWorldPos);
  vec3 baseColor = uAlbedoColor * vColor.rgb * uTint.rgb;
  if (uHasAlbedoMap > 0.5) baseColor *= texture(uAlbedoMap, vUV).rgb;

  vec3 L = normalize(-uSunDirection);
  float NdotL = max(dot(N, L), 0.0);
  vec3 H = normalize(V + L);
  float spec = pow(max(dot(N, H), 0.0), mix(8.0, 220.0, 1.0 - uRoughness)) * (1.0 - uRoughness);
  vec3 diffuse = baseColor * (NdotL * uSunColor * uSunIntensity + mix(uAmbientGround, uAmbientSky, N.y * 0.5 + 0.5) * uAmbientIntensity);
  vec3 specular = uSunColor * spec * uSunIntensity * mix(0.06, 0.35, 1.0 - uRoughness);
  vec3 color = diffuse + specular;

  // Muzzle flash lights the weapon from the barrel — reads as real flashes in the dark.
  if (uMuzzleFlashIntensity > 0.001) {
    vec3 toFlash = uMuzzleFlashPosition - vWorldPos;
    float d = length(toFlash);
    vec3 fl = toFlash / max(d, 0.001);
    float falloff = 1.0 / (1.0 + d * d * 3.0);
    float lambert = max(dot(N, fl), 0.0);
    color += uMuzzleFlashColor * uMuzzleFlashIntensity * falloff * lambert * 3.0;
  }
  if (uDamageFlash > 0.001) color = mix(color, vec3(0.6, 0.05, 0.03), uDamageFlash * 0.5);

  fragColor = vec4(color, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Post-processing passes
// ---------------------------------------------------------------------------
export const FULLSCREEN_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 2) in vec2 uv;
out vec2 vUV;
void main() {
  vUV = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const POST_BRIGHT_PASS = /* glsl */`
${GLSL.constants}
in vec2 vUV;
uniform sampler2D uSceneTexture;
uniform float uThreshold;
uniform float uSoftKnee;
uniform float uIntensity;
out vec4 fragColor;
void main() {
  vec3 color = texture(uSceneTexture, vUV).rgb * uIntensity;
  float brightness = max(color.r, max(color.g, color.b));
  float knee = uThreshold * uSoftKnee + 0.0001;
  float soft = clamp(brightness - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, brightness - uThreshold) / max(brightness, 0.0001);
  fragColor = vec4(color * contribution, 1.0);
}
`;

export const POST_BLUR_PASS = /* glsl */`
in vec2 vUV;
uniform sampler2D uTexture;
uniform vec2 uTexelSize;
uniform float uDirection; // 0 = horizontal, 1 = vertical
uniform float uRadius;
out vec4 fragColor;
void main() {
  vec2 dir = uDirection < 0.5 ? vec2(uTexelSize.x * uRadius, 0.0) : vec2(0.0, uTexelSize.y * uRadius);
  // 9-tap Gaussian (linear-sampled taps)
  vec3 result = texture(uTexture, vUV).rgb * 0.2270270270;
  result += texture(uTexture, vUV + dir * 1.3846153846).rgb * 0.3162162162;
  result += texture(uTexture, vUV - dir * 1.3846153846).rgb * 0.3162162162;
  result += texture(uTexture, vUV + dir * 3.2307692308).rgb * 0.0702702703;
  result += texture(uTexture, vUV - dir * 3.2307692308).rgb * 0.0702702703;
  fragColor = vec4(result, 1.0);
}
`;

export const POST_COMPOSITE = /* glsl */`
${GLSL.constants}
${GLSL.srgb}
${GLSL.toneMapping}
${GLSL.rand}
in vec2 vUV;
uniform sampler2D uSceneTexture;
uniform sampler2D uBloomTexture;
uniform sampler2D uDepthTexture;
uniform float uBloomIntensity;
uniform float uExposure;
uniform float uToneMappingMode;
uniform float uVignetteStrength;
uniform float uVignetteRadius;
uniform float uChromaticAberration;
uniform float uSaturation;
uniform float uContrast;
uniform vec2 uResolution;
uniform float uTime;
uniform float uGrainAmount;
uniform float uDamageVignette;   // red screen-edge pulse when hit
uniform float uHitDirectionAngle; // radians, points toward the damage source
uniform float uHitFlash;
uniform float uAdsBlend;
uniform float uScopeBlend;
uniform float uLowHealthPulse;
uniform float uFadeAmount;
uniform vec3 uFadeColor;
uniform float uNightVision;
uniform float uInvertedY;
uniform float uUnderwater;
out vec4 fragColor;

vec3 sampleScene(vec2 uv) { return texture(uSceneTexture, clamp(uv, vec2(0.0005), vec2(0.9995))).rgb; }

void main() {
  vec2 uv = vUV;
  if (uUnderwater > 0.5) {
    uv += vec2(sin(uv.y * 28.0 + uTime * 1.6), cos(uv.x * 24.0 + uTime * 1.3)) * 0.0035;
  }
  float distFromCenter = length(vUV - 0.5);

  // --- chromatic aberration (stronger at the edges, punches during ADS)
  vec3 color;
  if (uChromaticAberration > 0.0001) {
    vec2 dir = normalize(vUV - 0.5 + vec2(0.0001));
    float amount = uChromaticAberration * (0.35 + distFromCenter * 1.8);
    color.r = sampleScene(uv + dir * amount).r;
    color.g = sampleScene(uv).g;
    color.b = sampleScene(uv - dir * amount).b;
  } else {
    color = sampleScene(uv);
  }

  // --- bloom
  if (uBloomIntensity > 0.0001) color += texture(uBloomTexture, uv).rgb * uBloomIntensity;

  // --- scope vignette (sniper ADS): hard black surround + lens vignette
  if (uScopeBlend > 0.001) {
    float r = distFromCenter * 2.0;
    float lens = 1.0 - smoothstep(0.44, 0.48, r);
    float ring = smoothstep(0.44, 0.47, r) * (1.0 - smoothstep(0.47, 0.5, r));
    vec3 scope = color * lens;
    scope += ring * vec3(0.05, 0.06, 0.07);
    color = mix(color, scope, uScopeBlend);
    // crosshair reticle
    if (lens > 0.5 && r < 0.46) {
      vec2 p = vUV - 0.5;
      float cross = smoothstep(0.0016, 0.0002, abs(p.x) * (step(abs(p.y), 0.14) )) +
                    smoothstep(0.0016, 0.0002, abs(p.y) * (step(abs(p.x), 0.14)));
      float gap = step(0.012, abs(p.x)) * step(0.012, abs(p.y));
      color = mix(color, vec3(0.02), clamp(cross * gap, 0.0, 1.0) * uScopeBlend * 0.9);
      color += vec3(0.9, 0.1, 0.1) * smoothstep(0.0025, 0.0008, length(p)) * uScopeBlend;
    }
  }

  // --- exposure & tonemap
  color = applyExposure(color, uExposure);
  if (uToneMappingMode < 0.5) color = tonemapACES(color);
  else if (uToneMappingMode < 1.5) color = tonemapFilmic(color);
  else if (uToneMappingMode < 2.5) color = tonemapReinhard(color);
  else color = clamp(color, 0.0, 1.0);

  // --- color grading
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, uSaturation);
  color = (color - 0.5) * uContrast + 0.5;

  if (uNightVision > 0.5) {
    float g = dot(color, vec3(0.3, 0.59, 0.11));
    color = vec3(g * 0.25, g * 1.6, g * 0.35);
    color += (hash12(vUV * uResolution + uTime) - 0.5) * 0.09;
    color *= 1.0 - smoothstep(0.32, 0.52, distFromCenter) * 0.85;
  }

  // --- vignette
  float vig = smoothstep(uVignetteRadius, uVignetteRadius - 0.42, distFromCenter);
  color *= mix(1.0, vig, uVignetteStrength);

  // --- damage indicators: red pulse from the hit direction + low-health heartbeat
  if (uDamageVignette > 0.001 || uHitFlash > 0.001 || uLowHealthPulse > 0.001) {
    vec2 dirToHit = vec2(cos(uHitDirectionAngle), sin(uHitDirectionAngle));
    vec2 pixelDir = normalize((vUV - 0.5) * vec2(uResolution.x / uResolution.y, 1.0) + vec2(0.0001));
    float directional = max(dot(pixelDir, dirToHit), 0.0);
    float edge = smoothstep(0.08, 0.62, distFromCenter);
    float bloodAmount = uDamageVignette * 2.2 + uHitFlash;
    color = mix(color, vec3(0.42, 0.01, 0.01), clamp(edge * (0.35 + directional * 0.9) * bloodAmount, 0.0, 0.92));
    float pulse = (sin(uTime * 5.2) * 0.5 + 0.5) * uLowHealthPulse;
    color = mix(color, vec3(0.35, 0.0, 0.0), clamp(edge * pulse * 0.7, 0.0, 0.6));
  }

  // --- film grain (cheap, sells the "AAA" look at almost zero cost)
  if (uGrainAmount > 0.0001) {
    float grain = hash12(vUV * uResolution + fract(uTime) * 1337.0) - 0.5;
    color += grain * uGrainAmount;
  }

  // --- screen fade (spawn protection, death cam, round transitions)
  if (uFadeAmount > 0.001) color = mix(color, uFadeColor, uFadeAmount);

  fragColor = vec4(linearToSRGB(clamp(color, 0.0, 1.0)), 1.0);
}
`;

export const POST_FXAA = /* glsl */`
in vec2 vUV;
uniform sampler2D uSceneTexture;
uniform vec2 uTexelSize;
uniform float uEnabled;
out vec4 fragColor;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  if (uEnabled < 0.5) { fragColor = texture(uSceneTexture, vUV); return; }
  vec3 rgbM = texture(uSceneTexture, vUV).rgb;
  vec3 rgbNW = texture(uSceneTexture, vUV + vec2(-1.0, -1.0) * uTexelSize).rgb;
  vec3 rgbNE = texture(uSceneTexture, vUV + vec2(1.0, -1.0) * uTexelSize).rgb;
  vec3 rgbSW = texture(uSceneTexture, vUV + vec2(-1.0, 1.0) * uTexelSize).rgb;
  vec3 rgbSE = texture(uSceneTexture, vUV + vec2(1.0, 1.0) * uTexelSize).rgb;
  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, -8.0, 8.0) * uTexelSize;
  vec3 rgbA = 0.5 * (texture(uSceneTexture, vUV + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uSceneTexture, vUV + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(uSceneTexture, vUV + dir * -0.5).rgb + texture(uSceneTexture, vUV + dir * 0.5).rgb);
  float lB = luma(rgbB);
  fragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

export const POST_DOF = /* glsl */`
in vec2 vUV;
uniform sampler2D uSceneTexture;
uniform sampler2D uDepthTexture;
uniform sampler2D uBlurTexture;
uniform float uFocusDistance;
uniform float uFocusRange;
uniform float uNearPlane;
uniform float uFarPlane;
uniform float uMaxBlur;
uniform float uAdsBlend;
out vec4 fragColor;
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNearPlane * uFarPlane) / (uFarPlane + uNearPlane - z * (uFarPlane - uNearPlane));
}
void main() {
  float depth = linearDepth(texture(uDepthTexture, vUV).r);
  float coc = clamp(abs(depth - uFocusDistance) / max(uFocusRange, 0.01), 0.0, 1.0) * uMaxBlur;
  coc = mix(coc, 0.0, uAdsBlend); // no DOF when aiming down sights
  vec3 sharp = texture(uSceneTexture, vUV).rgb;
  vec3 blurred = texture(uBlurTexture, vUV).rgb;
  fragColor = vec4(mix(sharp, blurred, coc), 1.0);
}
`;

export const POST_SSAO = /* glsl */`
${GLSL.constants}
${GLSL.rand}
in vec2 vUV;
uniform sampler2D uDepthTexture;
uniform sampler2D uNormalTexture;
uniform mat4 uProjectionMatrix;
uniform mat4 uInverseProjectionMatrix;
uniform mat4 uViewMatrix;
uniform mat4 uInverseViewMatrix;
uniform vec2 uResolution;
uniform float uRadius;
uniform float uBias;
uniform float uIntensity;
uniform float uNearPlane;
uniform float uFarPlane;
out vec4 fragColor;

vec3 viewPosFromDepth(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInverseProjectionMatrix * clip;
  return view.xyz / view.w;
}
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNearPlane * uFarPlane) / (uFarPlane + uNearPlane - z * (uFarPlane - uNearPlane));
}
void main() {
  float depth = texture(uDepthTexture, vUV).r;
  if (depth >= 0.99999) { fragColor = vec4(1.0); return; }
  vec3 viewPos = viewPosFromDepth(vUV, depth);
  vec3 normal = normalize(texture(uNormalTexture, vUV).xyz * 2.0 - 1.0);
  vec3 normalView = normalize((uViewMatrix * vec4(normal, 0.0)).xyz);
  float viewZ = -viewPos.z;
  float radius = clamp(uRadius / max(viewZ, 1.0), 0.02, 1.0) * 2.0;

  float occlusion = 0.0;
  const int SAMPLES = 12;
  float seed = hash12(vUV * uResolution);
  for (int i = 0; i < SAMPLES; i++) {
    vec2 offset = (hash22(vec2(float(i) * 1.7, seed * 91.7)) * 2.0 - 1.0);
    vec2 sampleUV = vUV + offset * radius / uResolution * 24.0;
    if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) continue;
    float sampleDepth = texture(uDepthTexture, sampleUV).r;
    if (sampleDepth >= 0.99999) continue;
    vec3 samplePos = viewPosFromDepth(sampleUV, sampleDepth);
    vec3 diff = samplePos - viewPos;
    float dist = length(diff);
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(dist, 0.001));
    float ndl = max(0.0, dot(normalView, normalize(diff)) - uBias);
    occlusion += ndl * rangeCheck;
  }
  occlusion = 1.0 - (occlusion / float(SAMPLES)) * uIntensity;
  fragColor = vec4(vec3(clamp(occlusion, 0.0, 1.0)), 1.0);
}
`.replace('float radius = clamp(uRadius / max(viewZ, 1.0), 0.02, 1.0) * 2.0;', 'float radius = clamp(uRadius / max(viewZ, 1.0), 0.02, 1.0) * 2.0;\n  (void)linearDepth(depth);')
 .replace('  (void)linearDepth(depth);', '');

export const POST_APPLY_SSAO = /* glsl */`
in vec2 vUV;
uniform sampler2D uSceneTexture;
uniform sampler2D uAoTexture;
uniform float uEnabled;
out vec4 fragColor;
void main() {
  if (uEnabled < 0.5) { fragColor = texture(uSceneTexture, vUV); return; }
  vec3 color = texture(uSceneTexture, vUV).rgb;
  float ao = texture(uAoTexture, vUV).r;
  fragColor = vec4(color * ao, 1.0);
}
`;

/** Down-sampled depth→normal reconstruction used by SSAO (no G-buffer needed). */
export const POST_NORMAL_FROM_DEPTH = /* glsl */`
${GLSL.constants}
in vec2 vUV;
uniform sampler2D uDepthTexture;
uniform vec2 uTexelSize;
uniform mat4 uInverseProjectionMatrix;
out vec4 fragColor;
vec3 viewPos(vec2 uv) {
  float d = texture(uDepthTexture, uv).r;
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uInverseProjectionMatrix * clip;
  return v.xyz / v.w;
}
void main() {
  vec3 p = viewPos(vUV);
  vec3 dx = viewPos(vUV + vec2(uTexelSize.x, 0.0)) - p;
  vec3 dy = viewPos(vUV + vec2(0.0, uTexelSize.y)) - p;
  vec3 n = normalize(cross(dx, dy));
  if (dot(n, -normalize(p)) < 0.0) n = -n;
  fragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Editor helpers: grid, gizmos, picking
// ---------------------------------------------------------------------------
export const EDITOR_GRID_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 4) in vec4 color;
uniform mat4 uViewProjectionMatrix;
out vec4 vColor;
out vec3 vWorldPos;
void main() {
  vColor = color;
  vWorldPos = position;
  gl_Position = uViewProjectionMatrix * vec4(position, 1.0);
}
`;
export const EDITOR_GRID_FRAGMENT = /* glsl */`
in vec4 vColor;
in vec3 vWorldPos;
uniform vec3 uCameraPosition;
uniform float uFadeDistance;
out vec4 fragColor;
void main() {
  float dist = distance(uCameraPosition, vWorldPos);
  float alpha = vColor.a * (1.0 - clamp((dist - uFadeDistance * 0.4) / (uFadeDistance * 0.6), 0.0, 1.0));
  if (alpha < 0.005) discard;
  fragColor = vec4(vColor.rgb, alpha);
}
`;

/** ID-buffer pass used for click-to-select and hover highlights in the editor. */
export const PICKING_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
#ifdef INSTANCED
layout(location = 8) in vec4 instanceMatrix0;
layout(location = 9) in vec4 instanceMatrix1;
layout(location = 10) in vec4 instanceMatrix2;
layout(location = 11) in vec4 instanceMatrix3;
#endif
uniform mat4 uModelMatrix;
uniform mat4 uViewProjectionMatrix;
void main() {
  #ifdef INSTANCED
  mat4 instanceMatrix = mat4(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  gl_Position = uViewProjectionMatrix * instanceMatrix * vec4(position, 1.0);
  #else
  gl_Position = uViewProjectionMatrix * uModelMatrix * vec4(position, 1.0);
  #endif
}
`;
export const PICKING_FRAGMENT = /* glsl */`
uniform vec4 uPickColor;
out vec4 fragColor;
void main() { fragColor = uPickColor; }
`;

/** Selection outline: draws the selected object slightly scaled with front-face culling. */
export const OUTLINE_VERTEX = /* glsl */`
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
uniform mat4 uModelMatrix;
uniform mat4 uViewProjectionMatrix;
uniform float uThickness;
void main() {
  vec3 expanded = position + normal * uThickness;
  gl_Position = uViewProjectionMatrix * uModelMatrix * vec4(expanded, 1.0);
}
`;
export const OUTLINE_FRAGMENT = /* glsl */`
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }
`;

export const ShaderSources = {
  GEOMETRY_VERTEX, GEOMETRY_FRAGMENT, SHADOW_VERTEX, SHADOW_FRAGMENT,
  SKY_VERTEX, SKY_FRAGMENT, DECAL_VERTEX, DECAL_FRAGMENT,
  PARTICLE_VERTEX, PARTICLE_FRAGMENT, SPRITE_VERTEX, SPRITE_FRAGMENT,
  LINE_VERTEX, LINE_FRAGMENT, TRACER_VERTEX, TRACER_FRAGMENT,
  VIEWMODEL_VERTEX, VIEWMODEL_FRAGMENT, FULLSCREEN_VERTEX,
  POST_BRIGHT_PASS, POST_BLUR_PASS, POST_COMPOSITE, POST_FXAA, POST_DOF, POST_SSAO,
  POST_APPLY_SSAO, POST_NORMAL_FROM_DEPTH, EDITOR_GRID_VERTEX, EDITOR_GRID_FRAGMENT,
  PICKING_VERTEX, PICKING_FRAGMENT, OUTLINE_VERTEX, OUTLINE_FRAGMENT,
};
export default ShaderSources;
