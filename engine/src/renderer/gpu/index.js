/**
 * OminX Engine — render backend seam.
 *
 * The renderer is written once against a *device contract* (bind program → set state → bind
 * geometry → draw) and never mentions an API. This module is the only place that knows both
 * backends exist: it creates a device (WebGPU when the browser has it, WebGL2 otherwise) and
 * hands out the right resource classes for whatever device it was given.
 *
 * Every constructor here returns the backend-appropriate object, and the GL classes' statics
 * (`Texture.create`, `RenderTarget.fromImage`, ...) are forwarded so existing call sites keep
 * working unchanged:
 *
 * ```js
 * import { Shader, Texture, GeometryBuffer } from './gpu/index.js';
 * const shader = new Shader(device, { name: 'geometry', vertex, fragment }); // GPU or GL, your call
 * ```
 *
 * @module engine/src/renderer/gpu
 */
import { GLDevice } from '../gl/GLDevice.js';
import { Shader as GLShader, ShaderPermutation as GLShaderPermutation } from '../gl/Shader.js';
import {
  GeometryBuffer as GLGeometryBuffer, InstanceBuffer as GLInstanceBuffer, DynamicBuffer as GLDynamicBuffer,
} from '../gl/GeometryBuffer.js';
import { Texture as GLTexture, RenderTarget as GLRenderTarget } from '../gl/Texture.js';
import { WebGPUDevice } from '../webgpu/WebGPUDevice.js';
import { WebGPUShader, WebGPUShaderPermutation } from '../webgpu/WebGPUShader.js';
import {
  WebGPUTexture, WebGPURenderTarget, WebGPUGeometry, WebGPUInstanceBuffer, WebGPUDynamicBuffer,
} from '../webgpu/WebGPUResources.js';

/** Backend identifiers stored on every device. */
export const RenderBackend = {
  WebGL: 'webgl',
  WebGPU: 'webgpu',
  Auto: 'auto',
};

/** True when a device speaks WebGPU. */
export function isGPU(device) { return device?.backend === RenderBackend.WebGPU; }

/** The backend a device is running on. */
export function backendOf(device) { return isGPU(device) ? RenderBackend.WebGPU : RenderBackend.WebGL; }

/** True when this browser exposes WebGPU at all. */
export function supportsWebGPU() {
  return typeof globalThis.navigator !== 'undefined' && !!globalThis.navigator.gpu;
}

/**
 * Creates the best available render device.
 *
 * `opts.backend`: `'auto'` (default) prefers WebGPU, `'webgpu'` requires it, `'webgl'` forces the
 * WebGL2 path (useful for regression testing and for machines with broken early WebGPU drivers).
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|null} canvas
 * @param {object} [opts] forwarded to the device constructor
 * @returns {Promise<import('../gl/GLDevice.js').GLDevice|import('../webgpu/WebGPUDevice.js').WebGPUDevice>}
 */
export async function createDevice(canvas, opts = {}) {
  const wanted = opts.backend ?? RenderBackend.Auto;
  if (wanted === RenderBackend.WebGPU || (wanted === RenderBackend.Auto && supportsWebGPU())) {
    try {
      const device = await WebGPUDevice.create(canvas, opts);
      if (device) return device;
      if (wanted === RenderBackend.WebGPU) throw new Error('WebGPU was requested but no adapter was available');
    } catch (error) {
      if (wanted === RenderBackend.WebGPU) throw error;
      // Auto mode: fall through to WebGL2 rather than leaving the player with a black screen.
      if (typeof console !== 'undefined') console.warn(`[gpu] WebGPU unavailable (${error.message}) — falling back to WebGL2`);
    }
  }
  return new GLDevice(canvas, opts);
}

/** Builds a shader (or shader permutation) for the device's backend. */
export function createShader(device, desc) { return isGPU(device) ? new WebGPUShader(device, desc) : new GLShader(device, desc); }
export function createShaderPermutation(device, desc) { return isGPU(device) ? new WebGPUShaderPermutation(device, desc) : new GLShaderPermutation(device, desc); }

/**
 * Copies a class's static methods onto a dispatching factory function, so both
 * `new Texture(device, opts)` and `Texture.create(device, opts)` work on either backend.
 */
function forwardStatics(factory, source) {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) Object.defineProperty(factory, key, descriptor);
  }
  return factory;
}

/**
 * Backend-agnostic resource constructors. These are plain functions called with `new` — using
 * `new` on a function that returns an object yields that object, which is exactly what the
 * renderer wants: `new GeometryBuffer(device, mesh)` works whether `device` is GL or WebGPU.
 */
export function Shader(device, desc) { return createShader(device, desc); }
export function ShaderPermutation(device, desc) { return createShaderPermutation(device, desc); }

export function Texture(device, opts) {
  return isGPU(device) ? new WebGPUTexture(device, opts) : new GLTexture(device, opts);
}
export function RenderTarget(device, opts) {
  return isGPU(device) ? new WebGPURenderTarget(device, opts) : new GLRenderTarget(device, opts);
}
export function GeometryBuffer(device, mesh) {
  return isGPU(device) ? new WebGPUGeometry(device, mesh) : new GLGeometryBuffer(device, mesh);
}
export function InstanceBuffer(device, capacity, layout) {
  return isGPU(device) ? new WebGPUInstanceBuffer(device, capacity, layout) : new GLInstanceBuffer(device, capacity, layout);
}
export function DynamicBuffer(device, target, bytes) {
  return isGPU(device) ? new WebGPUDynamicBuffer(device, target, bytes) : new GLDynamicBuffer(device, target, bytes);
}

forwardStatics(Texture, GLTexture);
forwardStatics(RenderTarget, GLRenderTarget);
forwardStatics(GeometryBuffer, GLGeometryBuffer);
forwardStatics(InstanceBuffer, GLInstanceBuffer);

export { GLDevice, WebGPUDevice };
export default createDevice;
