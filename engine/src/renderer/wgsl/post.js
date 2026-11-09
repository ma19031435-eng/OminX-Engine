/**
 * OminX Engine — WGSL post-processing programs.
 *
 * The FPS feedback chain: bloom (bright-pass + separable blur), the composite that owns exposure,
 * tone mapping, colour grading, scope vignette, hit-direction blood, low-health pulse, film grain
 * and screen fades, plus FXAA, depth-of-field, SSAO and depth→normal reconstruction.
 *
 * Every post pass shares the fullscreen triangle vertex entry (`vs_fullscreen`) and samples its
 * inputs from group 1 slots, so the device can build one pipeline layout family for the chain.
 *
 * @module engine/src/renderer/wgsl/post
 */
import { declareTextureSlots } from './common.js';

/** Shared fullscreen vertex stage: `position.xy` is already in NDC (-1..1). */
export const FULLSCREEN_VERTEX_WGSL = /* wgsl */`
struct FullscreenOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_fullscreen(@location(0) position: vec3f, @location(2) uv: vec2f) -> FullscreenOut {
  var out: FullscreenOut;
  out.uv = uv;
  out.position = vec4f(position.xy, 0.0, 1.0);
  return out;
}
`;

export const BRIGHT_WGSL = /* wgsl */`
struct Uniforms {
  uThreshold: f32,
  uSoftKnee: f32,
  uIntensity: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}
${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_bright(in: FullscreenOut) -> @location(0) vec4f {
  let color = textureSample(uTexture0, uSampler0, in.uv).rgb * u.uIntensity;
  let brightness = max(color.r, max(color.g, color.b));
  let knee = u.uThreshold * u.uSoftKnee + 0.0001;
  var soft = clamp(brightness - u.uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  let contribution = max(soft, brightness - u.uThreshold) / max(brightness, 0.0001);
  return vec4f(color * contribution, 1.0);
}
`;

export const BLUR_WGSL = /* wgsl */`
struct Uniforms {
  uTexelSize: vec2f,
  uDirection: f32,
  uRadius: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}
${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_blur(in: FullscreenOut) -> @location(0) vec4f {
  // 9-tap Gaussian using linear-sampled taps (the classic 5-sample trick).
  let dir = select(vec2f(0.0, u.uTexelSize.y * u.uRadius), vec2f(u.uTexelSize.x * u.uRadius, 0.0), u.uDirection < 0.5);
  var result = textureSample(uTexture0, uSampler0, in.uv).rgb * 0.2270270270;
  result = result + textureSample(uTexture0, uSampler0, in.uv + dir * 1.3846153846).rgb * 0.3162162162;
  result = result + textureSample(uTexture0, uSampler0, in.uv - dir * 1.3846153846).rgb * 0.3162162162;
  result = result + textureSample(uTexture0, uSampler0, in.uv + dir * 3.2307692308).rgb * 0.0702702703;
  result = result + textureSample(uTexture0, uSampler0, in.uv - dir * 3.2307692308).rgb * 0.0702702703;
  return vec4f(result, 1.0);
}
`;

export const COMPOSITE_WGSL = /* wgsl */`
struct Uniforms {
  uBloomIntensity: f32,
  uExposure: f32,
  uToneMappingMode: f32,
  uVignetteStrength: f32,
  uVignetteRadius: f32,
  uChromaticAberration: f32,
  uSaturation: f32,
  uContrast: f32,
  uResolution: vec2f,
  uTime: f32,
  uGrainAmount: f32,
  uDamageVignette: f32,
  uHitDirectionAngle: f32,
  uHitFlash: f32,
  uAdsBlend: f32,
  uScopeBlend: f32,
  uLowHealthPulse: f32,
  uFadeAmount: f32,
  uFadeColor: vec3f,
  uNightVision: f32,
  uInvertedY: f32,
  uUnderwater: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0, 1, 2])}
${FULLSCREEN_VERTEX_WGSL}

fn sampleScene(uv: vec2f) -> vec3f {
  return textureSample(uTexture0, uSampler0, clamp(uv, vec2f(0.0005), vec2f(0.9995))).rgb;
}

@fragment
fn fs_composite(in: FullscreenOut) -> @location(0) vec4f {
  var uv = in.uv;
  if (u.uUnderwater > 0.5) {
    uv = uv + vec2f(sin(uv.y * 28.0 + u.uTime * 1.6), cos(uv.x * 24.0 + u.uTime * 1.3)) * 0.0035;
  }
  let distFromCenter = length(in.uv - vec2f(0.5));

  // Chromatic aberration: stronger at the edges, punches while aiming down sights.
  var color: vec3f;
  if (u.uChromaticAberration > 0.0001) {
    let dir = normalize(in.uv - vec2f(0.5) + vec2f(0.0001));
    let amount = u.uChromaticAberration * (0.35 + distFromCenter * 1.8);
    color = vec3f(sampleScene(uv + dir * amount).r, sampleScene(uv).g, sampleScene(uv - dir * amount).b);
  } else {
    color = sampleScene(uv);
  }

  if (u.uBloomIntensity > 0.0001) { color = color + textureSample(uTexture1, uSampler1, uv).rgb * u.uBloomIntensity; }

  // Sniper scope: hard black surround, lens vignette and a reticle.
  if (u.uScopeBlend > 0.001) {
    let r = distFromCenter * 2.0;
    let lens = 1.0 - smoothstep(0.44, 0.48, r);
    let ring = smoothstep(0.44, 0.47, r) * (1.0 - smoothstep(0.47, 0.5, r));
    var scope = color * lens;
    scope = scope + ring * vec3f(0.05, 0.06, 0.07);
    color = mix(color, scope, u.uScopeBlend);
    if (lens > 0.5 && r < 0.46) {
      let p = in.uv - vec2f(0.5);
      let crossH = smoothstep(0.0016, 0.0002, abs(p.x) * step(abs(p.y), 0.14)) +
                   smoothstep(0.0016, 0.0002, abs(p.y) * step(abs(p.x), 0.14));
      let gap = step(0.012, abs(p.x)) * step(0.012, abs(p.y));
      color = mix(color, vec3f(0.02), clamp(crossH * gap, 0.0, 1.0) * u.uScopeBlend * 0.9);
      color = color + vec3f(0.9, 0.1, 0.1) * smoothstep(0.0025, 0.0008, length(p)) * u.uScopeBlend;
    }
  }

  color = applyExposure(color, u.uExposure);
  if (u.uToneMappingMode < 0.5) {
    color = tonemapACES(color);
  } else if (u.uToneMappingMode < 1.5) {
    color = tonemapFilmic(color);
  } else if (u.uToneMappingMode < 2.5) {
    color = tonemapReinhard(color);
  } else {
    color = clamp(color, vec3f(0.0), vec3f(1.0));
  }

  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = mix(vec3f(luma), color, u.uSaturation);
  color = (color - vec3f(0.5)) * u.uContrast + vec3f(0.5);

  if (u.uNightVision > 0.5) {
    let g = dot(color, vec3f(0.3, 0.59, 0.11));
    color = vec3f(g * 0.25, g * 1.6, g * 0.35);
    color = color + vec3f((hash12(in.uv * u.uResolution + vec2f(u.uTime)) - 0.5) * 0.09);
    color = color * (1.0 - smoothstep(0.32, 0.52, distFromCenter) * 0.85);
  }

  let vig = smoothstep(u.uVignetteRadius, u.uVignetteRadius - 0.42, distFromCenter);
  color = color * mix(1.0, vig, u.uVignetteStrength);

  // Damage feedback: blood pulse from the hit direction plus a low-health heartbeat.
  if (u.uDamageVignette > 0.001 || u.uHitFlash > 0.001 || u.uLowHealthPulse > 0.001) {
    let dirToHit = vec2f(cos(u.uHitDirectionAngle), sin(u.uHitDirectionAngle));
    let pixelDir = normalize((in.uv - vec2f(0.5)) * vec2f(u.uResolution.x / u.uResolution.y, 1.0) + vec2f(0.0001));
    let directional = max(dot(pixelDir, dirToHit), 0.0);
    let edge = smoothstep(0.08, 0.62, distFromCenter);
    let bloodAmount = u.uDamageVignette * 2.2 + u.uHitFlash;
    color = mix(color, vec3f(0.42, 0.01, 0.01), clamp(edge * (0.35 + directional * 0.9) * bloodAmount, 0.0, 0.92));
    let pulse = (sin(u.uTime * 5.2) * 0.5 + 0.5) * u.uLowHealthPulse;
    color = mix(color, vec3f(0.35, 0.0, 0.0), clamp(edge * pulse * 0.7, 0.0, 0.6));
  }

  if (u.uGrainAmount > 0.0001) {
    let grain = hash12(in.uv * u.uResolution + vec2f(fract(u.uTime) * 1337.0)) - 0.5;
    color = color + vec3f(grain * u.uGrainAmount);
  }
  if (u.uFadeAmount > 0.001) { color = mix(color, u.uFadeColor, u.uFadeAmount); }

  return vec4f(linearToSRGB(clamp(color, vec3f(0.0), vec3f(1.0))), 1.0);
}
`;

export const FXAA_WGSL = /* wgsl */`
struct Uniforms {
  uTexelSize: vec2f,
  uEnabled: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}
${FULLSCREEN_VERTEX_WGSL}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

@fragment
fn fs_fxaa(in: FullscreenOut) -> @location(0) vec4f {
  if (u.uEnabled < 0.5) { return textureSample(uTexture0, uSampler0, in.uv); }
  let rgbM = textureSample(uTexture0, uSampler0, in.uv).rgb;
  let rgbNW = textureSample(uTexture0, uSampler0, in.uv + vec2f(-1.0, -1.0) * u.uTexelSize).rgb;
  let rgbNE = textureSample(uTexture0, uSampler0, in.uv + vec2f(1.0, -1.0) * u.uTexelSize).rgb;
  let rgbSW = textureSample(uTexture0, uSampler0, in.uv + vec2f(-1.0, 1.0) * u.uTexelSize).rgb;
  let rgbSE = textureSample(uTexture0, uSampler0, in.uv + vec2f(1.0, 1.0) * u.uTexelSize).rgb;
  let lNW = luma(rgbNW); let lNE = luma(rgbNE); let lSW = luma(rgbSW); let lSE = luma(rgbSE); let lM = luma(rgbM);
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  var dir = vec2f(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  let dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 0.0078125);
  let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2f(-8.0), vec2f(8.0)) * u.uTexelSize;
  let rgbA = 0.5 * (textureSample(uTexture0, uSampler0, in.uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                    textureSample(uTexture0, uSampler0, in.uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  let rgbB = rgbA * 0.5 + 0.25 * (textureSample(uTexture0, uSampler0, in.uv + dir * -0.5).rgb +
                                  textureSample(uTexture0, uSampler0, in.uv + dir * 0.5).rgb);
  let lB = luma(rgbB);
  if (lB < lMin || lB > lMax) { return vec4f(rgbA, 1.0); }
  return vec4f(rgbB, 1.0);
}
`;

export const DOF_WGSL = /* wgsl */`
struct Uniforms {
  uFocusDistance: f32,
  uFocusRange: f32,
  uNearPlane: f32,
  uFarPlane: f32,
  uMaxBlur: f32,
  uAdsBlend: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0, 1, 2])}
${FULLSCREEN_VERTEX_WGSL}

fn linearDepth(d: f32, near: f32, far: f32) -> f32 {
  let z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}

@fragment
fn fs_dof(in: FullscreenOut) -> @location(0) vec4f {
  let depth = linearDepth(textureSample(uTexture1, uSampler1, in.uv).r, u.uNearPlane, u.uFarPlane);
  var coc = clamp(abs(depth - u.uFocusDistance) / max(u.uFocusRange, 0.01), 0.0, 1.0) * u.uMaxBlur;
  coc = mix(coc, 0.0, u.uAdsBlend);   // no depth-of-field while aiming down sights
  let sharp = textureSample(uTexture0, uSampler0, in.uv).rgb;
  let blurred = textureSample(uTexture2, uSampler2, in.uv).rgb;
  return vec4f(mix(sharp, blurred, coc), 1.0);
}
`;

export const SSAO_WGSL = /* wgsl */`
struct Uniforms {
  uProjectionMatrix: mat4x4f,
  uInverseProjectionMatrix: mat4x4f,
  uViewMatrix: mat4x4f,
  uInverseViewMatrix: mat4x4f,
  uResolution: vec2f,
  uRadius: f32,
  uBias: f32,
  uIntensity: f32,
  uNearPlane: f32,
  uFarPlane: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0, 1])}
${FULLSCREEN_VERTEX_WGSL}

fn viewPosFromDepth(uv: vec2f, depth: f32) -> vec3f {
  let clip = vec4f(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  let view = u.uInverseProjectionMatrix * clip;
  return view.xyz / max(abs(view.w), EPSILON_F) * sign(view.w);
}

@fragment
fn fs_ssao(in: FullscreenOut) -> @location(0) vec4f {
  let depth = textureSample(uTexture0, uSampler0, in.uv).r;
  if (depth >= 0.99999) { return vec4f(1.0); }
  let viewPos = viewPosFromDepth(in.uv, depth);
  let normal = normalize(textureSample(uTexture1, uSampler1, in.uv).xyz * 2.0 - 1.0);
  let normalView = normalize((u.uViewMatrix * vec4f(normal, 0.0)).xyz);
  let viewZ = -viewPos.z;
  let radius = clamp(u.uRadius / max(viewZ, 1.0), 0.02, 1.0) * 2.0;

  var occlusion = 0.0;
  let samples = 12;
  let seed = hash12(in.uv * u.uResolution);
  for (var i = 0; i < 12; i = i + 1) {
    let offset = hash22(vec2f(f32(i) * 1.7, seed * 91.7)) * 2.0 - vec2f(1.0);
    let sampleUV = in.uv + offset * radius / u.uResolution * 24.0;
    if (sampleUV.x >= 0.0 && sampleUV.x <= 1.0 && sampleUV.y >= 0.0 && sampleUV.y <= 1.0) {
      let sampleDepth = textureSample(uTexture0, uSampler0, sampleUV).r;
      if (sampleDepth < 0.99999) {
        let samplePos = viewPosFromDepth(sampleUV, sampleDepth);
        let diff = samplePos - viewPos;
        let dist = length(diff);
        let rangeCheck = smoothstep(0.0, 1.0, u.uRadius / max(dist, 0.001));
        let ndl = max(0.0, dot(normalView, normalize(diff)) - u.uBias);
        occlusion = occlusion + ndl * rangeCheck;
      }
    }
  }
  occlusion = 1.0 - (occlusion / f32(samples)) * u.uIntensity;
  return vec4f(vec3f(clamp(occlusion, 0.0, 1.0)), 1.0);
}
`;

export const APPLY_SSAO_WGSL = /* wgsl */`
struct Uniforms {
  uEnabled: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0, 1])}
${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_apply_ssao(in: FullscreenOut) -> @location(0) vec4f {
  if (u.uEnabled < 0.5) { return textureSample(uTexture0, uSampler0, in.uv); }
  let color = textureSample(uTexture0, uSampler0, in.uv).rgb;
  let ao = textureSample(uTexture1, uSampler1, in.uv).r;
  return vec4f(color * ao, 1.0);
}
`;

export const NORMAL_FROM_DEPTH_WGSL = /* wgsl */`
struct Uniforms {
  uTexelSize: vec2f,
  uInverseProjectionMatrix: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}
${FULLSCREEN_VERTEX_WGSL}

fn viewPos(uv: vec2f) -> vec3f {
  let d = textureSample(uTexture0, uSampler0, uv).r;
  let clip = vec4f(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  let v = u.uInverseProjectionMatrix * clip;
  return v.xyz / max(abs(v.w), EPSILON_F) * sign(v.w);
}

@fragment
fn fs_normal_from_depth(in: FullscreenOut) -> @location(0) vec4f {
  let p = viewPos(in.uv);
  let dx = viewPos(in.uv + vec2f(u.uTexelSize.x, 0.0)) - p;
  let dy = viewPos(in.uv + vec2f(0.0, u.uTexelSize.y)) - p;
  var n = normalize(cross(dx, dy));
  if (dot(n, -normalize(p)) < 0.0) { n = -n; }
  return vec4f(n * 0.5 + vec3f(0.5), 1.0);
}
`;

/** Post-processing target format helper: the chain runs on `rgba16float` (bloom needs HDR). */
export const POST_FORMAT = 'rgba16float';

export const BRIGHT_PROGRAM = {
  name: 'bright', code: BRIGHT_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_bright',
  attributes: ['position', 'uv'], textures: { uSceneTexture: 0 }, featureAttributes: {},
};
export const BLUR_PROGRAM = {
  name: 'blur', code: BLUR_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_blur',
  attributes: ['position', 'uv'], textures: { uTexture: 0 }, featureAttributes: {},
};
export const COMPOSITE_PROGRAM = {
  name: 'composite', code: COMPOSITE_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_composite',
  attributes: ['position', 'uv'],
  textures: { uSceneTexture: 0, uBloomTexture: 1, uDepthTexture: 2 },
  featureAttributes: {},
};
export const FXAA_PROGRAM = {
  name: 'fxaa', code: FXAA_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_fxaa',
  attributes: ['position', 'uv'], textures: { uSceneTexture: 0 }, featureAttributes: {},
};
export const DOF_PROGRAM = {
  name: 'dof', code: DOF_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_dof',
  attributes: ['position', 'uv'],
  textures: { uSceneTexture: 0, uDepthTexture: 1, uBlurTexture: 2 },
  featureAttributes: {},
};
export const SSAO_PROGRAM = {
  name: 'ssao', code: SSAO_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_ssao',
  attributes: ['position', 'uv'],
  textures: { uDepthTexture: 0, uNormalTexture: 1 },
  featureAttributes: {},
};
export const APPLY_SSAO_PROGRAM = {
  name: 'applySsao', code: APPLY_SSAO_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_apply_ssao',
  attributes: ['position', 'uv'],
  textures: { uSceneTexture: 0, uAoTexture: 1 },
  featureAttributes: {},
};
export const NORMAL_FROM_DEPTH_PROGRAM = {
  name: 'normalFromDepth', code: NORMAL_FROM_DEPTH_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_normal_from_depth',
  attributes: ['position', 'uv'], textures: { uDepthTexture: 0 }, featureAttributes: {},
};
