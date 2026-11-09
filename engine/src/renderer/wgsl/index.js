/**
 * OminX Engine — WGSL program registry.
 *
 * The WebGPU backend's mirror of `renderer/shaders/index.js`: one entry per pass, each describing
 * its WGSL source, entry points, vertex attributes, texture slots and default feature defines.
 * `Renderer` never mentions a backend; it asks the device for a program by name.
 *
 * @module engine/src/renderer/wgsl
 */
export * from './common.js';
export * from './layout.js';
export * from './preprocess.js';
export {
  GEOMETRY_WGSL, GEOMETRY_PROGRAM, SHADOW_WGSL, SHADOW_PROGRAM, VIEWMODEL_WGSL, VIEWMODEL_PROGRAM,
  DEFAULT_SHADER_DEFINES, GEOMETRY_TEXTURE_UNITS,
} from './geometry.js';
export {
  SKY_WGSL, SKY_PROGRAM, DECAL_WGSL, DECAL_PROGRAM, PARTICLE_WGSL, PARTICLE_PROGRAM,
  SPRITE_WGSL, SPRITE_PROGRAM, LINE_WGSL, LINE_PROGRAM, TRACER_WGSL, TRACER_PROGRAM,
  GRID_WGSL, GRID_PROGRAM, PICKING_WGSL, PICKING_PROGRAM, OUTLINE_WGSL, OUTLINE_PROGRAM,
} from './effects.js';
export {
  FULLSCREEN_VERTEX_WGSL, BRIGHT_WGSL, BRIGHT_PROGRAM, BLUR_WGSL, BLUR_PROGRAM,
  COMPOSITE_WGSL, COMPOSITE_PROGRAM, FXAA_WGSL, FXAA_PROGRAM, DOF_WGSL, DOF_PROGRAM,
  SSAO_WGSL, SSAO_PROGRAM, APPLY_SSAO_WGSL, APPLY_SSAO_PROGRAM, NORMAL_FROM_DEPTH_WGSL,
  NORMAL_FROM_DEPTH_PROGRAM, POST_FORMAT,
} from './post.js';
export {
  BLIT_WGSL, BLIT_PROGRAM, SKY_COLOR_WGSL, SKY_COLOR_PROGRAM,
  CUBEMAP_WGSL, CUBEMAP_PROGRAM, TEXT_WGSL, TEXT_PROGRAM,
} from './utility.js';

import { GEOMETRY_PROGRAM, SHADOW_PROGRAM, VIEWMODEL_PROGRAM } from './geometry.js';
import {
  SKY_PROGRAM, DECAL_PROGRAM, PARTICLE_PROGRAM, SPRITE_PROGRAM, LINE_PROGRAM,
  TRACER_PROGRAM, GRID_PROGRAM, PICKING_PROGRAM, OUTLINE_PROGRAM,
} from './effects.js';
import {
  BRIGHT_PROGRAM, BLUR_PROGRAM, COMPOSITE_PROGRAM, FXAA_PROGRAM, DOF_PROGRAM,
  SSAO_PROGRAM, APPLY_SSAO_PROGRAM, NORMAL_FROM_DEPTH_PROGRAM,
} from './post.js';
import { BLIT_PROGRAM, SKY_COLOR_PROGRAM, CUBEMAP_PROGRAM, TEXT_PROGRAM } from './utility.js';

/**
 * Every WGSL program the WebGPU backend can build, keyed by the same names the GLSL registry
 * uses so `device.getProgram(name)` works on both backends.
 */
export const WGSL_PROGRAMS = {
  geometry: GEOMETRY_PROGRAM,
  shadow: SHADOW_PROGRAM,
  viewmodel: VIEWMODEL_PROGRAM,
  sky: SKY_PROGRAM,
  decal: DECAL_PROGRAM,
  particle: PARTICLE_PROGRAM,
  sprite: SPRITE_PROGRAM,
  line: LINE_PROGRAM,
  tracer: TRACER_PROGRAM,
  grid: GRID_PROGRAM,
  picking: PICKING_PROGRAM,
  outline: OUTLINE_PROGRAM,
  bright: BRIGHT_PROGRAM,
  blur: BLUR_PROGRAM,
  composite: COMPOSITE_PROGRAM,
  fxaa: FXAA_PROGRAM,
  dof: DOF_PROGRAM,
  ssao: SSAO_PROGRAM,
  applySsao: APPLY_SSAO_PROGRAM,
  normalFromDepth: NORMAL_FROM_DEPTH_PROGRAM,
  blit: BLIT_PROGRAM,
  skyColor: SKY_COLOR_PROGRAM,
  cubemap: CUBEMAP_PROGRAM,
  text: TEXT_PROGRAM,
};

export default WGSL_PROGRAMS;
