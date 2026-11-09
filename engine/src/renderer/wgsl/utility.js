/**
 * OminX Engine — WGSL utility programs.
 *
 * The four small passes that the renderer builds from inline GLSL rather than the shared shader
 * library: the debug blit, the flat sky colour, the skybox cubemap and the instanced 3D text
 * (world-space nametags, damage numbers and scoreboard markers). Keeping them in the WGSL
 * registry means `Renderer` can ask for them by name on either backend instead of branching.
 *
 * @module engine/src/renderer/wgsl/utility
 */
import { declareTextureSlots } from './common.js';
import { FULLSCREEN_VERTEX_WGSL } from './post.js';

/** Copy a colour texture to the screen, optionally applying gamma. */
export const BLIT_WGSL = /* wgsl */`
struct Uniforms {
  uGamma: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}

${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4f {
  let c = textureSample(uTexture0, uSampler0, in.uv);
  if (u.uGamma > 0.5) {
    return vec4f(linearToSRGB(c.rgb), c.a);
  }
  return c;
}
`;

/** Flat colour fill — the "solid colour" sky mode and the editor's clear pass. */
export const SKY_COLOR_WGSL = /* wgsl */`
struct Uniforms {
  uColor: vec3f,
  uExposure: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4f {
  return vec4f(u.uColor * u.uExposure, 1.0);
}
`;

/** Cubemap skybox: no lighting, no fog — the authored cubemap straight to the background. */
export const CUBEMAP_WGSL = /* wgsl */`
struct Uniforms {
  uModelMatrix: mat4x4f,
  uViewProjectionMatrix: mat4x4f,
  uExposure: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0], { cube: [0] })}

struct CubeOut {
  @builtin(position) position: vec4f,
  @location(0) direction: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f) -> CubeOut {
  var out: CubeOut;
  out.direction = position;
  out.position = u.uViewProjectionMatrix * u.uModelMatrix * vec4f(position, 1.0);
  return out;
}

@fragment
fn fs_main(in: CubeOut) -> @location(0) vec4f {
  let c = textureSample(uTexture0, uSampler0, normalize(in.direction));
  return vec4f(c.rgb * u.uExposure, 1.0);
}
`;

/**
 * Instanced glyph quads. One instance per glyph: world anchor + size (matrix0), glyph cell offset
 * + size (matrix1), colour (matrix2), atlas UV rect (matrix3). Screen-aligned so player nametags
 * and damage numbers always face the shooter.
 */
export const TEXT_WGSL = /* wgsl */`
struct Uniforms {
  uViewProjectionMatrix: mat4x4f,
  uCameraRight: vec3f,
  uCameraUp: vec3f,
  uOutlineColor: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
${declareTextureSlots([0])}

struct TextOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(2) uv: vec2f,
  @location(8) instanceMatrix0: vec4f,
  @location(9) instanceMatrix1: vec4f,
  @location(10) instanceMatrix2: vec4f,
  @location(11) instanceMatrix3: vec4f,
) -> TextOut {
  var out: TextOut;
  let center = instanceMatrix0.xyz;
  let size = instanceMatrix0.w;
  let cellOffset = instanceMatrix1.xy * size;
  let cellSize = instanceMatrix1.zw * size;
  let worldPos = center
    + u.uCameraRight * (cellOffset.x + position.x * cellSize.x)
    + u.uCameraUp * (cellOffset.y + position.y * cellSize.y);
  out.uv = instanceMatrix3.xy + uv * instanceMatrix3.zw;
  out.color = instanceMatrix2;
  out.position = u.uViewProjectionMatrix * vec4f(worldPos, 1.0);
  return out;
}

@fragment
fn fs_main(in: TextOut) -> @location(0) vec4f {
  let glyph = textureSample(uTexture0, uSampler0, in.uv);
  if (glyph.a < 0.02) { discard; }
  return vec4f(in.color.rgb, glyph.a * in.color.a);
}
`;

export const BLIT_PROGRAM = {
  name: 'blit', code: BLIT_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_main',
  attributes: ['position', 'uv'], textures: { uTexture: 0 }, featureAttributes: {},
};

export const SKY_COLOR_PROGRAM = {
  name: 'skyColor', code: SKY_COLOR_WGSL, vertexEntry: 'vs_fullscreen', fragmentEntry: 'fs_main',
  attributes: ['position', 'uv'], textures: {}, featureAttributes: {},
};

export const CUBEMAP_PROGRAM = {
  name: 'cubemap', code: CUBEMAP_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position'], textures: { uCubemap: 0 }, cubeTextures: ['uCubemap'], featureAttributes: {},
};

export const TEXT_PROGRAM = {
  name: 'text', code: TEXT_WGSL, vertexEntry: 'vs_main', fragmentEntry: 'fs_main',
  attributes: ['position', 'uv'], textures: { uFontAtlas: 0 },
  featureAttributes: { INSTANCED: ['instanceMatrix0', 'instanceMatrix1', 'instanceMatrix2', 'instanceMatrix3'] },
};
