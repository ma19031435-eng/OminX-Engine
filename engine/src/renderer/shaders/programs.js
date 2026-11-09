/**
 * OminX Engine — program registry.
 *
 * Passes ask a device for a *program* by name; the backend decides how that becomes an API
 * object. WebGL compiles the GLSL pair below, WebGPU builds the WGSL module from
 * `renderer/wgsl/index.js` with the same key. Keeping the two tables keyed identically is what
 * lets `Renderer`, `PostProcessing`, `Sky` and `Sprites` avoid any backend branching.
 *
 * @module engine/src/renderer/shaders/programs
 */
import {
  GEOMETRY_VERTEX, GEOMETRY_FRAGMENT, SHADOW_VERTEX, SHADOW_FRAGMENT,
  SKY_VERTEX, SKY_FRAGMENT, DECAL_VERTEX, DECAL_FRAGMENT,
  PARTICLE_VERTEX, PARTICLE_FRAGMENT, SPRITE_VERTEX, SPRITE_FRAGMENT,
  LINE_VERTEX, LINE_FRAGMENT, TRACER_VERTEX, TRACER_FRAGMENT,
  VIEWMODEL_VERTEX, VIEWMODEL_FRAGMENT, FULLSCREEN_VERTEX,
  POST_BRIGHT_PASS, POST_BLUR_PASS, POST_COMPOSITE, POST_FXAA,
  POST_DOF, POST_SSAO, POST_APPLY_SSAO, POST_NORMAL_FROM_DEPTH,
  EDITOR_GRID_VERTEX, EDITOR_GRID_FRAGMENT, PICKING_VERTEX, PICKING_FRAGMENT,
  OUTLINE_VERTEX, OUTLINE_FRAGMENT,
} from './index.js';

/** Program name → GLSL stages. Keys match `WGSL_PROGRAMS` exactly. */
export const GLSL_PROGRAMS = {
  geometry: { name: 'Geometry', vertex: GEOMETRY_VERTEX, fragment: GEOMETRY_FRAGMENT },
  shadow: { name: 'Shadow', vertex: SHADOW_VERTEX, fragment: SHADOW_FRAGMENT },
  viewmodel: { name: 'ViewModel', vertex: VIEWMODEL_VERTEX, fragment: VIEWMODEL_FRAGMENT },
  sky: { name: 'Sky', vertex: SKY_VERTEX, fragment: SKY_FRAGMENT },
  decal: { name: 'Decal', vertex: DECAL_VERTEX, fragment: DECAL_FRAGMENT },
  particle: { name: 'Particle', vertex: PARTICLE_VERTEX, fragment: PARTICLE_FRAGMENT },
  sprite: { name: 'Sprite', vertex: SPRITE_VERTEX, fragment: SPRITE_FRAGMENT },
  line: { name: 'Line', vertex: LINE_VERTEX, fragment: LINE_FRAGMENT },
  tracer: { name: 'Tracer', vertex: TRACER_VERTEX, fragment: TRACER_FRAGMENT },
  grid: { name: 'EditorGrid', vertex: EDITOR_GRID_VERTEX, fragment: EDITOR_GRID_FRAGMENT },
  picking: { name: 'Picking', vertex: PICKING_VERTEX, fragment: PICKING_FRAGMENT },
  outline: { name: 'Outline', vertex: OUTLINE_VERTEX, fragment: OUTLINE_FRAGMENT },
  bright: { name: 'BrightPass', vertex: FULLSCREEN_VERTEX, fragment: POST_BRIGHT_PASS },
  blur: { name: 'Blur', vertex: FULLSCREEN_VERTEX, fragment: POST_BLUR_PASS },
  composite: { name: 'Composite', vertex: FULLSCREEN_VERTEX, fragment: POST_COMPOSITE },
  fxaa: { name: 'FXAA', vertex: FULLSCREEN_VERTEX, fragment: POST_FXAA },
  dof: { name: 'DepthOfField', vertex: FULLSCREEN_VERTEX, fragment: POST_DOF },
  ssao: { name: 'SSAO', vertex: FULLSCREEN_VERTEX, fragment: POST_SSAO },
  applySsao: { name: 'ApplySSAO', vertex: FULLSCREEN_VERTEX, fragment: POST_APPLY_SSAO },
  normalFromDepth: { name: 'NormalFromDepth', vertex: FULLSCREEN_VERTEX, fragment: POST_NORMAL_FROM_DEPTH },
};

export default GLSL_PROGRAMS;
