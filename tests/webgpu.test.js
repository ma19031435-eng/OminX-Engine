/**
 * WebGPU backend tests.
 *
 * These run the real device layer (no browser) against a recording mock of `navigator.gpu`. What
 * they cover:
 *
 *  1. **Program parity** — every GLSL program the renderer builds has a WGSL twin, and every
 *     non-sampler uniform the GLSL program declares also exists in the WGSL uniform struct, so a
 *     material or pass behaves identically on both backends.
 *  2. **Layout parity** — the CPU uniform writer's offsets are checked against `wgsl_reflect`
 *     (the reference WGSL parser) for every program and every feature permutation.
 *  3. **Recording parity** — pipelines, vertex buffer layouts, bind groups, padded texture uploads
 *     and draw calls, i.e. what would actually be submitted to the GPU.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';

import { WebGPUDevice } from '../engine/src/renderer/webgpu/WebGPUDevice.js';
import { WebGPUShader, resolveProgramDescriptor, PROGRAM_ALIASES, knownProgramNames } from '../engine/src/renderer/webgpu/WebGPUShader.js';
import { WebGPUTexture, WebGPURenderTarget, WebGPUGeometry, WebGPUInstanceBuffer } from '../engine/src/renderer/webgpu/WebGPUResources.js';
import { preprocessWGSL } from '../engine/src/renderer/wgsl/preprocess.js';
import { parseUniformLayout } from '../engine/src/renderer/wgsl/layout.js';
import { WGSL_PROGRAMS, DEFAULT_SHADER_DEFINES } from '../engine/src/renderer/wgsl/index.js';
import { GLSL_PROGRAMS } from '../engine/src/renderer/shaders/programs.js';
import { ShaderSources } from '../engine/src/renderer/shaders/index.js';
import { Matrix4 } from '../engine/src/math/Matrix4.js';
import { Vector3 } from '../engine/src/math/Vector3.js';
import { Color4 } from '../engine/src/math/Color4.js';
import { Mesh } from '../engine/src/geometry/Mesh.js';
import { Primitives } from '../engine/src/geometry/Primitives.js';
import { mockWebGPUDevice, mockMesh, installGPUGlobals } from './helpers/mock-gpu.js';

installGPUGlobals();

const FEATURE_DEFINES = [
  {}, { INSTANCED: true }, { SKINNED: true }, { SHADOW_CASCADES: true }, { ALPHA_TEST: true },
  { WIND: true }, { VERTEX_COLOR: true }, { EMISSIVE_MAP: true },
  { INSTANCED: true, SKINNED: true, SHADOW_CASCADES: true, ALPHA_TEST: true, WIND: true, VERTEX_COLOR: true, EMISSIVE_MAP: true },
];

/** The shader descriptors `Renderer`, `PostProcessing`, `Sky` and `Sprites` actually construct. */
const RENDERER_DESCRIPTORS = [
  { name: 'geometry', vertex: ShaderSources.GEOMETRY_VERTEX, fragment: ShaderSources.GEOMETRY_FRAGMENT },
  { name: 'shadow', vertex: ShaderSources.SHADOW_VERTEX, fragment: ShaderSources.SHADOW_FRAGMENT },
  { name: 'viewmodel', vertex: ShaderSources.VIEWMODEL_VERTEX, fragment: ShaderSources.VIEWMODEL_FRAGMENT },
  { name: 'decal', vertex: ShaderSources.DECAL_VERTEX, fragment: ShaderSources.DECAL_FRAGMENT },
  { name: 'particle', vertex: ShaderSources.PARTICLE_VERTEX, fragment: ShaderSources.PARTICLE_FRAGMENT },
  { name: 'sprite', vertex: ShaderSources.SPRITE_VERTEX, fragment: ShaderSources.SPRITE_FRAGMENT },
  { name: 'tracer', vertex: ShaderSources.TRACER_VERTEX, fragment: ShaderSources.TRACER_FRAGMENT },
  { name: 'editorGrid', vertex: ShaderSources.EDITOR_GRID_VERTEX, fragment: ShaderSources.EDITOR_GRID_FRAGMENT },
  { name: 'picking', vertex: ShaderSources.PICKING_VERTEX, fragment: ShaderSources.PICKING_FRAGMENT },
  { name: 'outline', vertex: ShaderSources.OUTLINE_VERTEX, fragment: ShaderSources.OUTLINE_FRAGMENT },
  { name: 'sky', vertex: ShaderSources.SKY_VERTEX, fragment: ShaderSources.SKY_FRAGMENT },
  { name: 'brightPass', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_BRIGHT_PASS },
  { name: 'blur', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_BLUR_PASS },
  { name: 'composite', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_COMPOSITE },
  { name: 'fxaa', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_FXAA },
  { name: 'ssao', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_SSAO },
  { name: 'ssaoApply', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_APPLY_SSAO },
  { name: 'normalFromDepth', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_NORMAL_FROM_DEPTH },
  { name: 'dof', vertex: ShaderSources.FULLSCREEN_VERTEX, fragment: ShaderSources.POST_DOF },
];

/** GLSL uniforms that intentionally have no WGSL uniform: they are hardware texture bindings. */
const SAMPLER_DECL = /\buniform\s+(?:lowp\s+|mediump\s+|highp\s+)?(?:sampler2D|samplerCube|sampler2DShadow|sampler2DArray|sampler3D|usampler2D|isampler2D)\s+([A-Za-z0-9_]+)/g;

function glslUniformNames(source) {
  const names = new Set();
  const samplerNames = new Set();
  let match;
  SAMPLER_DECL.lastIndex = 0;
  while ((match = SAMPLER_DECL.exec(source))) samplerNames.add(match[1]);
  const declared = [...source.matchAll(/\buniform\s+([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)(?:\[\s*([A-Za-z0-9_]+)\s*\])?/g)];
  for (const [, , name] of declared) names.add(name);
  // Usages inside conditional blocks (`#ifdef SHADOW_CASCADES`) count too.
  for (const [, name] of source.matchAll(/\b(u[A-Z][A-Za-z0-9_]*)\b/g)) {
    if (samplerNames.has(name)) continue;
    if (name === 'uvec4' || name === 'uvec3' || name === 'uvec2') continue;
    names.add(name);
  }
  return { names, samplerNames };
}

function stripArrayIndex(name) { return name.replace(/\[\s*\d*\s*\]$/, ''); }

test('every GLSL program has a WGSL twin and every renderer shader descriptor resolves', () => {
  for (const [key, glsl] of Object.entries(GLSL_PROGRAMS)) {
    assert.ok(WGSL_PROGRAMS[key], `missing WGSL program for GLSL program "${key}"`);
    assert.ok(glsl.vertex.length > 20 && glsl.fragment.length > 20, `program "${key}" is empty`);
  }
  for (const descriptor of RENDERER_DESCRIPTORS) {
    const program = resolveProgramDescriptor(descriptor);
    assert.ok(program, `descriptor "${descriptor.name}" did not resolve to a WGSL program`);
  }
  for (const [alias, target] of Object.entries(PROGRAM_ALIASES)) {
    assert.ok(WGSL_PROGRAMS[target], `alias "${alias}" points at unknown program "${target}"`);
  }
  assert.ok(knownProgramNames().length >= Object.keys(WGSL_PROGRAMS).length + Object.keys(PROGRAM_ALIASES).length);
});

test('uniform names match between the GLSL and WGSL versions of every program', () => {
  const gaps = [];
  for (const [key, glsl] of Object.entries(GLSL_PROGRAMS)) {
    const program = WGSL_PROGRAMS[key];
    if (!program) continue;
    const code = preprocessWGSL(program.code, { ...DEFAULT_SHADER_DEFINES, ...(program.defines ?? {}), SHADOW_CASCADES: true, INSTANCED: true, SKINNED: true, WIND: true, VERTEX_COLOR: true, EMISSIVE_MAP: true });
    const layout = parseUniformLayout(code);
    const { names, samplerNames } = glslUniformNames(`${glsl.vertex}\n${glsl.fragment}`);
    const missing = [];
    for (const name of names) {
      if (samplerNames.has(name)) continue;
      if (/^u(Bone|Shadow)Matrices$/.test(name)) {
        // uniform arrays: both sides declare them, the member name is what matters
        if (!layout.members.has(name)) missing.push(name);
        continue;
      }
      // GLSL helpers concatenate every program's helpers, so only flag a name the WGSL *file*
      // cannot serve at all: locals like `uWindStrength` are fine, `uvec*` types are filtered.
      if (!layout.members.has(name) && !program.optionalUniforms?.includes(name)) missing.push(name);
    }
    // A texture unit uniform (e.g. `uShadowMap0`) is a binding on WebGPU, not a uniform member.
    const filtered = missing.filter((name) => !(key === 'geometry' && /^uShadowMap[0-3]$/.test(name)));
    if (filtered.length) gaps.push(`${key}: ${filtered.join(', ')}`);
  }
  assert.deepEqual(gaps, [], `GLSL/WGSL uniform gaps:\n${gaps.join('\n')}`);
});

test('CPU uniform layout matches wgsl_reflect for every program and permutation', () => {
  const mismatches = [];
  for (const program of Object.values(WGSL_PROGRAMS)) {
    const permutations = program.featureAttributes && Object.keys(program.featureAttributes).length
      ? FEATURE_DEFINES
      : [{}];
    for (const flags of permutations) {
      const defines = { ...DEFAULT_SHADER_DEFINES, ...(program.defines ?? {}), ...flags };
      const code = preprocessWGSL(program.code, defines);
      const mine = parseUniformLayout(code);
      const reflect = new WgslReflect(code);
      const theirs = reflect.uniforms[0];
      const members = theirs?.type?.members ?? [];
      assert.ok(theirs, `${program.name} has no uniform block`);
      for (const name of mine.order) {
        const a = mine.members.get(name);
        const b = members.find((m) => m.name === name);
        assert.ok(b, `${program.name}: ${name} missing from wgsl_reflect`);
        if (a.offset !== b.offset || a.size !== b.size) {
          mismatches.push(`${program.name} [${Object.keys(flags).join('+') || 'base'}] ${name}: ${a.offset}/${a.size} vs ${b.offset}/${b.size}`);
        }
      }
      assert.equal(mine.order.length, members.length, `${program.name}: member count differs from wgsl_reflect`);
    }
  }
  assert.deepEqual(mismatches, [], `layout mismatches:\n${mismatches.join('\n')}`);
});

test('device creation wires context, uniform ring and caps', async () => {
  const { device, canvas, gpu, context } = mockWebGPUDevice(WebGPUDevice);
  assert.equal(device.backend, 'webgpu');
  assert.equal(device.gpu, gpu);
  assert.equal(device.context, context);
  assert.equal(device.uniformAlignment, 256);
  assert.equal(device.width, canvas.width);
  assert.equal(device.caps.shaderLanguage, 'wgsl');
  assert.equal(device.caps.isSoftware, false);
  assert.equal(device.getStats().backend, 'webgpu');
  // The context is configured by `WebGPUDevice.create`, and the ring buffer exists either way.
  assert.ok(device._uniformBuffer && device._uniformBuffer.size >= 1024);
});

test('shaders write uniforms into the slab at the WGSL member offsets', () => {
  const { device } = mockWebGPUDevice(WebGPUDevice);
  const shader = new WebGPUShader(device, { name: 'geometry', defines: { MAX_SHADOW_CASCADES: 4, MAX_BONES: 64 } });
  assert.equal(shader.programName, 'geometry');
  assert.ok(shader.layout.size >= 5000, `geometry uniform block unexpectedly small: ${shader.layout.size}`);
  const model = new Matrix4().makeTranslation(1, 2, 3);
  shader.use().apply('uModelMatrix', model);
  const member = shader.layout.members.get('uModelMatrix');
  const written = new Float32Array(shader.bytes.buffer, member.offset, 16);
  assert.equal(written[12], 1);
  assert.equal(written[13], 2);
  assert.equal(written[14], 3);
  shader.apply('uRoughness', 0.35);
  const roughness = new Float32Array(shader.bytes.buffer, shader.layout.members.get('uRoughness').offset, 1);
  assert.ok(Math.abs(roughness[0] - 0.35) < 1e-6);
  shader.apply('uTint', new Color4(1, 0.5, 0.25, 0.75));
  const tint = new Float32Array(shader.bytes.buffer, shader.layout.members.get('uTint').offset, 4);
  assert.deepEqual([...tint], [1, 0.5, 0.25, 0.75]);
  // Unknown uniforms are ignored, exactly like a GLSL program without that uniform.
  shader.apply('uDoesNotExist', 1);
  assert.equal(shader.validationErrors, 0);
  assert.deepEqual(shader.validateUniformNames(['uModelMatrix', 'uNope']), ['uNope']);
});

test('shader permutations materialise one variant per feature bitmask', () => {
  const { device, gpu } = mockWebGPUDevice(WebGPUDevice);
  const permutation = device.createShaderPermutation({
    name: 'geometry',
    defines: { MAX_SHADOW_CASCADES: 4, MAX_BONES: 64 },
    featureAttributes: { INSTANCED: [], SKINNED: [] },
  });
  const base = permutation.get(0);
  const instanced = permutation.get(1, () => ({ INSTANCED: true }));
  const skinned = permutation.get(2, () => ({ SKINNED: true }));
  assert.equal(base, permutation.get(0));
  assert.notEqual(base, instanced);
  assert.notEqual(instanced, skinned);
  assert.ok(instanced.code.includes('instanceMatrix0'));
  assert.ok(skinned.layout.members.has('uBoneMatrices'));
  assert.ok(gpu.createdBuffers.length > 0);
});

test('a full draw builds a pipeline, bind groups and vertex buffers', () => {
  const { device, gpu, context } = mockWebGPUDevice(WebGPUDevice);
  const shader = device.createShader({ name: 'geometry', defines: { MAX_SHADOW_CASCADES: 4, MAX_BONES: 64, SKINNED: true } });
  const mesh = new Mesh({ ...mockMesh(), skinIndices: new Uint16Array(4 * 4), skinWeights: new Float32Array(4 * 4) });
  const geometry = device.createGeometry(mesh);
  device.beginFrame();
  device.setDepthTest(true, 'lequal');
  device.setCullFace('back');
  shader.use().apply('uModelMatrix', new Matrix4());
  device.useProgram(shader);
  device.bindVertexArray(geometry);
  shader.bindTexture('uAlbedoMap', new WebGPUTexture(device, { width: 4, height: 4 }));
  device.setViewport(0, 0, 640, 360);
  device.drawIndexed(geometry.indexCount);
  device.endFrame();

  assert.equal(gpu.createdPipelines.length, 1);
  const pipeline = gpu.createdPipelines[0].desc;
  assert.equal(pipeline.vertex.entryPoint, 'vs_main');
  assert.equal(pipeline.fragment.entryPoint, 'fs_main');
  assert.equal(pipeline.primitive.topology, 'triangle-list');
  assert.equal(pipeline.primitive.cullMode, 'back');
  assert.equal(pipeline.depthStencil.format, device.depthFormat);
  assert.equal(pipeline.depthStencil.depthCompare, 'less-equal');
  assert.equal(pipeline.multisample.count, 1);
  const attributeLocations = pipeline.vertex.buffers.flatMap((b) => b.attributes.map((a) => a.shaderLocation));
  assert.deepEqual(attributeLocations.slice(0, 6), [0, 1, 2, 3, 4, 5]);
  assert.ok(attributeLocations.includes(6) && attributeLocations.includes(7), 'skinned attributes missing');

  const pass = gpu.encoders[0].passes[0];
  assert.ok(pass.ended, 'render pass was not ended by endFrame');
  assert.deepEqual(pass.draws, [{ kind: 'drawIndexed', count: 6, instances: 1, first: 0 }]);
  assert.equal(pass.indexBuffer.format, 'uint32');
  assert.ok(pass.bindGroups.some((g) => g.index === 0), 'uniform bind group not bound');
  assert.ok(pass.bindGroups.some((g) => g.index === 1), 'texture bind group not bound');
  assert.deepEqual(pass.viewport.slice(0, 4), [0, 0, 640, 360]);
  assert.equal(gpu.submitted.length, 1);
  assert.equal(context.currentTextureCount, 1, 'swapchain texture should be acquired once per frame');
  assert.equal(device.getStats().drawCalls, 1);
  const uniformWrite = gpu.bufferWrites.find((w) => w.buffer === device._uniformBuffer);
  assert.ok(uniformWrite, 'uniform slab was never copied into the ring buffer');
});

test('pipeline cache reuses identical state and invalidates on state change', () => {
  const { device, gpu } = mockWebGPUDevice(WebGPUDevice);
  const shader = device.createShader({ name: 'sky' });
  const mesh = new Mesh(mockMesh({ indexed: false }));
  const geometry = device.createGeometry(mesh);
  const drawOnce = () => {
    device.beginFrame();
    device.useProgram(shader);
    device.bindVertexArray(geometry);
    device.draw(3);
    device.endFrame();
  };
  drawOnce();
  drawOnce();
  assert.equal(gpu.createdPipelines.length, 1, 'identical state should hit the pipeline cache');
  device.setBlend('additive');
  drawOnce();
  assert.equal(gpu.createdPipelines.length, 2, 'blend change must produce a new pipeline');
  const blended = gpu.createdPipelines[1].desc.fragment.targets[0].blend;
  assert.deepEqual(blended.color, { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' });
  device.setBlend('alpha');
  device.setDepthWrite(false);
  device.setCullFace('none');
  drawOnce();
  const third = gpu.createdPipelines[2].desc;
  assert.equal(third.primitive.cullMode, 'none');
  assert.equal(third.depthStencil.depthWriteEnabled, false);
});

test('instanced draws bind a 64-byte instance buffer with four matrix columns', () => {
  const { device, gpu } = mockWebGPUDevice(WebGPUDevice);
  const shader = device.createShader({ name: 'geometry', defines: { INSTANCED: true, MAX_SHADOW_CASCADES: 4, MAX_BONES: 64 } });
  const mesh = new Mesh(mockMesh({ indexed: false }));
  const geometry = device.createGeometry(mesh);
  const instances = device.createInstanceBuffer(64);
  for (let i = 0; i < 3; i++) instances.set(i, new Matrix4().makeTranslation(i, 0, 0), new Color4(1, 1, 1, 1), [i, 0, 0, 0]);
  instances.upload(3);
  device.beginFrame();
  device.useProgram(shader);
  device.bindVertexArray({ geometry, instanceBuffer: instances });
  device.drawInstanced(mesh.vertexCount, 3);
  device.endFrame();

  const buffers = gpu.createdPipelines[0].desc.vertex.buffers;
  const instanceBuffer = buffers.find((b) => b.stepMode === 'instance' && b.arrayStride === 64);
  assert.ok(instanceBuffer, 'no 64-byte instance buffer in the vertex layout');
  assert.deepEqual(instanceBuffer.attributes.map((a) => a.offset), [0, 16, 32, 48]);
  assert.deepEqual(instanceBuffer.attributes.map((a) => a.shaderLocation), [8, 9, 10, 11]);
  assert.ok(buffers.some((b) => b.stepMode === 'instance' && b.arrayStride === 16), 'instanceColor/params buffer missing');
  const pass = gpu.encoders[0].passes[0];
  assert.deepEqual(pass.draws, [{ kind: 'draw', count: 4, instances: 3, first: 0 }]);
  const matrixWrites = gpu.bufferWrites.filter((w) => w.buffer === instances.matrixBuffer);
  assert.equal(matrixWrites.length, 1);
});

test('texture uploads pad rows to the 256-byte requirement and pick the right format', () => {
  const { device, gpu } = mockWebGPUDevice(WebGPUDevice);
  const rgba = new WebGPUTexture(device, { width: 3, height: 2, data: new Uint8Array(3 * 2 * 4), name: 'tiny' });
  assert.equal(rgba.format, 'rgba8unorm');
  const write = gpu.textureWrites.at(-1);
  assert.equal(write.layout.bytesPerRow, 256, 'rows must be 256-byte aligned');
  assert.equal(write.layout.rowsPerImage, 2);
  assert.equal(write.size.width, 3);
  const hdr = new WebGPUTexture(device, { width: 8, height: 8, format: 'rgba16f', generateMipmaps: false });
  assert.equal(hdr.format, 'rgba16float');
  assert.equal(hdr.mipLevelCount, 1);
  const depth = new WebGPUTexture(device, { width: 8, height: 8, format: 'depth' });
  assert.equal(depth.format, 'depth24plus');
  assert.equal(depth.generateMipmaps, false, 'depth textures never have a mip chain');
  const cube = new WebGPUTexture(device, { width: 4, height: 4, target: 'cube' });
  assert.equal(cube.cube, true);
  assert.equal(cube.texture.depthOrArrayLayers, 6);
  assert.equal(cube.view.desc.dimension, 'cube');
  const filtered = rgba.setFilter('nearest');
  assert.equal(filtered.filter, 'nearest');
  assert.equal(filtered.sampler.magFilter, 'nearest');
});

test('render targets expose colour/depth views, MSAA resolve and resize', () => {
  const { device, gpu } = mockWebGPUDevice(WebGPUDevice);
  const target = new WebGPURenderTarget(device, { width: 128, height: 64, format: 'rgba16f', depth: true, depthTexture: true, samples: 4 });
  assert.equal(target.samples, 1, 'readable depth forces 1 sample (WebGPU cannot resolve depth)');
  assert.equal(target.colors.length, 1);
  assert.equal(target.colorTexture.format, 'rgba16float');
  assert.ok(target.depthTexRef, 'depth texture view missing');
  device.beginFrame();
  target.bind(true, [0.1, 0.2, 0.3, 1]);
  device.clearDepth(1);
  const shader = device.createShader({ name: 'composite' });
  device.useProgram(shader);
  device.bindVertexArray({ buffers: new Map(), indexCount: 3 });
  device.draw(3);
  device.endFrame();
  const pass = gpu.encoders[0].passes[0];
  const colour = pass.descriptor.colorAttachments[0];
  assert.deepEqual(colour.clearValue, { r: 0.1, g: 0.2, b: 0.3, a: 1 });
  assert.equal(colour.loadOp, 'clear');
  assert.equal(colour.view.texture.format, 'rgba16float');
  assert.ok(pass.descriptor.depthStencilAttachment, 'depth attachment missing');
  target.resize(256, 128);
  assert.equal(target.width, 256);
  assert.equal(target.colorTexture.width, 256);
  const msaa = new WebGPURenderTarget(device, { width: 64, height: 64, samples: 4, depth: true });
  assert.equal(msaa.samples, 4);
  assert.ok(msaa.msaaView, 'MSAA colour texture missing');
  const quadShader = device.createShader({ name: 'composite' });
  device.beginFrame();
  msaa.bind(true, [0, 0, 0, 1]);
  device.useProgram(quadShader);
  device.bindVertexArray({ buffers: new Map(), indexCount: 3 });
  device.draw(3);
  device.endFrame();
  const msaaPass = gpu.encoders.at(-1).passes[0];
  assert.equal(msaaPass.descriptor.colorAttachments[0].resolveTarget.texture.sampleCount, 1);
  assert.equal(msaaPass.descriptor.colorAttachments[0].view.texture.sampleCount, 4);
});

test('geometry uploads one buffer per attribute and re-uploads on version change', () => {
  const { device, gpu } = mockWebGPUDevice(WebGPUDevice);
  const mesh = new Mesh(mockMesh());
  const geometry = new WebGPUGeometry(device, mesh);
  assert.ok(geometry.buffers.has('position'));
  assert.ok(geometry.buffers.has('normal'));
  assert.equal(geometry.indexCount, 6);
  assert.equal(geometry.indexFormat, 'uint32');
  const writes = gpu.bufferWrites.length;
  geometry.update();
  assert.equal(gpu.bufferWrites.length, writes, 'unchanged mesh must not re-upload');
  mesh.version = 2;
  geometry.update();
  assert.ok(gpu.bufferWrites.length > writes);
});

test('uniform ring grows instead of overwriting in-flight data', () => {
  const { device, gpu } = mockWebGPUDevice(WebGPUDevice, { uniformRingBytes: 1024 });
  const shader = device.createShader({ name: 'composite' });
  const geometry = { buffers: new Map(), indexCount: 3 };
  const buffersBefore = gpu.createdBuffers.length;
  // A single frame with far more uniform data than the ring holds must grow, not wrap.
  device.beginFrame();
  device.useProgram(shader);
  device.bindVertexArray(geometry);
  for (let i = 0; i < 128; i++) device.draw(3);
  device.endFrame();
  assert.ok(gpu.createdBuffers.length > buffersBefore, 'ring buffer should have grown mid-frame');
  assert.equal(device.getStats().drawCalls, 128);
  const offsets = gpu.bufferWrites.filter((w) => w.buffer === device._uniformBuffer).map((w) => w.bufferOffset);
  assert.ok(offsets.length > 0, 'no uniform writes recorded');
  assert.ok(offsets.every((offset) => offset % 256 === 0), 'uniform offsets must be 256-byte aligned');
  assert.equal(new Set(offsets).size, offsets.length, 'a frame must never overwrite earlier uniform slots');
  // Draw counters reset at the start of the next frame.
  device.beginFrame();
  assert.equal(device.getStats().drawCalls, 0);
});

test('device exposes the renderer compatibility surface', () => {
  const { device } = mockWebGPUDevice(WebGPUDevice);
  const required = [
    'useProgram', 'bindVertexArray', 'bindTexture', 'setBlend', 'setDepthWrite', 'setCullFace',
    'setDepthTest', 'setViewport', 'setScissor', 'setColorMask', 'draw', 'drawIndexed',
    'drawIndexedInstanced', 'drawInstanced', 'drawArraysMode', 'clear', 'clearDepth', 'beginFrame',
    'endFrame', 'bindFramebuffer', 'readPixel', 'toDataURL', 'resize', 'setRenderScale', 'onRestore',
    'getStats', 'createShader', 'createShaderPermutation', 'createTexture', 'createRenderTarget',
    'createGeometry', 'createInstanceBuffer', 'createDynamicBuffer', 'getSampler',
  ];
  for (const name of required) {
    assert.equal(typeof device[name], 'function', `device.${name} is missing`);
  }
  assert.ok(device._resources && typeof device._resources.textures === 'number');
  assert.ok(device.caps.renderer && 'maxSamples' in device.caps && 'supportsHalfFloat' in device.caps);
  assert.equal(device.aspect, 1280 / 720);
  device.resize(800, 600, 1);
  assert.equal(device.width, 800);
  assert.deepEqual(device.getState().viewport, [0, 0, 800, 600]);
  const buffer = device.createDynamicBuffer('array', 256);
  buffer.upload(new Float32Array([1, 2, 3]));
  assert.equal(buffer.byteLength, 12);
});

test('post-processing chain builds every pass against the shared fullscreen vertex stage', () => {
  const { device, gpu } = mockWebGPUDevice(WebGPUDevice);
  const quad = { buffers: new Map(), indexCount: 3 };
  const names = ['brightPass', 'blur', 'composite', 'fxaa', 'ssao', 'ssaoApply', 'normalFromDepth', 'dof', 'blit'];
  for (const name of names) {
    const descriptor = name === 'blit'
      ? { name, fragment: 'uniform sampler2D uTexture;\nuniform float uGamma;' }
      : RENDERER_DESCRIPTORS.find((d) => d.name === name);
    const shader = device.createShader(descriptor);
    assert.equal(shader.layout.vertexEntry, 'vs_fullscreen', `${name} must use the fullscreen vertex entry`);
    for (const [unit, texture] of [[0, new WebGPUTexture(device, { width: 4, height: 4 })], [1, new WebGPUTexture(device, { width: 4, height: 4 })], [2, new WebGPUTexture(device, { width: 4, height: 4 })]]) {
      device.bindTexture(texture, unit);
    }
    device.beginFrame();
    device.useProgram(shader);
    device.bindVertexArray(quad);
    device.setBlend(name === 'composite' ? 'none' : 'alpha');
    device.draw(3);
    device.endFrame();
  }
  assert.ok(gpu.createdPipelines.length >= names.length, 'each post pass should build at least one pipeline');
  assert.equal(gpu.createdPipelines.every((p) => p.desc.vertex.entryPoint === 'vs_fullscreen'), true);
  // Texture bind groups must contain one view + one sampler per declared slot.
  const groups = gpu.createdBindGroups.filter((g) => g.desc.label === 'textures');
  assert.ok(groups.length > 0);
  for (const group of groups) {
    const bindings = group.desc.entries.map((e) => e.binding);
    assert.equal(bindings.length % 2, 0, 'texture bind group must pair each texture with its sampler');
  }
});

test('the renderer descriptor set never needs a fallback program', () => {
  const { device } = mockWebGPUDevice(WebGPUDevice);
  for (const descriptor of RENDERER_DESCRIPTORS) {
    const shader = new WebGPUShader(device, descriptor);
    assert.ok(shader.code.length > 200, `${descriptor.name} produced no WGSL`);
    assert.ok(shader.layout.members.size > 0, `${descriptor.name} has an empty uniform block`);
    for (const input of shader.layout.vertexInputs) {
      assert.ok(input.location >= 0 && input.name, `${descriptor.name}: bad vertex input`);
    }
  }
});

test('unknown programs fail loudly with the list of known names', () => {
  const { device } = mockWebGPUDevice(WebGPUDevice);
  assert.throws(() => new WebGPUShader(device, { name: 'definitelyNotARealProgram' }), /no WGSL program/);
});

test('primitives and library meshes produce valid GPU geometry', () => {
  const { device } = mockWebGPUDevice(WebGPUDevice);
  const cube = Primitives.createBox(1, 1, 1);
  const geometry = device.createGeometry(cube);
  assert.ok(geometry.vertexCount > 0);
  assert.ok(geometry.indexCount >= 36, `box should have at least 36 indices, got ${geometry.indexCount}`);
  const sphere = device.createGeometry(Primitives.createSphere(0.5, 12, 8));
  assert.ok(sphere.vertexCount > 50);
  const instanceBuffer = new WebGPUInstanceBuffer(device, 4);
  instanceBuffer.set(0, new Matrix4());
  instanceBuffer.upload(1);
  assert.equal(instanceBuffer.count, 1);
  instanceBuffer.ensureCapacity(100);
  assert.ok(instanceBuffer.capacity >= 100);
  assert.ok(instanceBuffer.matrixData.length >= 100 * 16);
});

test('vertex attribute naming matches the mesh layout the engine uploads', () => {
  const { device, gpu } = mockWebGPUDevice(WebGPUDevice);
  const shader = device.createShader({ name: 'geometry', defines: { MAX_SHADOW_CASCADES: 4, MAX_BONES: 64, SKINNED: true } });
  const mesh = new Mesh({ ...mockMesh(), skinIndices: new Uint16Array([0, 1, 2, 3].flatMap((i) => [i, i, i, i])), skinWeights: new Float32Array(16) });
  const geometry = device.createGeometry(mesh);
  device.beginFrame();
  device.useProgram(shader);
  device.bindVertexArray(geometry);
  device.draw(3);
  device.endFrame();
  const attributes = gpu.createdPipelines[0].desc.vertex.buffers.flatMap((b) => b.attributes);
  const byLocation = new Map(attributes.map((a) => [a.shaderLocation, a.format]));
  assert.equal(byLocation.get(0), 'float32x3'); // position
  assert.equal(byLocation.get(1), 'float32x3'); // normal
  assert.equal(byLocation.get(2), 'float32x2'); // uv
  // WGSL has no 16-bit integers: bone indices are widened from the mesh's Uint16Array to uint32x4.
  assert.equal(byLocation.get(6), 'uint32x4');
  assert.equal(byLocation.get(7), 'float32x4'); // skinWeight
  void Vector3;
});
