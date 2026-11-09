/**
 * OminX Engine — backend-neutral line geometry.
 *
 * Debug/editor drawing (nav paths, AI state, trajectories, the grid, gizmo helpers) needs one thing
 * from both backends: "here are N position/colour pairs, draw them as lines, update me every frame".
 * The two APIs could hardly be more different — WebGL wants a VAO plus `bufferSubData`, WebGPU wants
 * per-attribute buffers inside a geometry object bound by the pipeline — so this helper hides both
 * behind `update() / bind() / draw()`.
 *
 * @module engine/src/renderer/gpu/LineGeometry
 */

/**
 * Creates a dynamic line buffer set for a device.
 * @param {object} device GL or WebGPU device
 * @param {number} maxVertices how many vertices (2 per line) to allocate
 * @returns {{backend:string, update:Function, bind:Function, draw:Function, destroy:Function}}
 */
export function createLineGeometry(device, maxVertices) {
  if (device.backend === 'webgpu') return createWebGPULines(device, maxVertices);
  return createGLLines(device, maxVertices);
}

function createGLLines(device, maxVertices) {
  const gl = device.gl;
  const vao = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  const colorBuffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, maxVertices * 3 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, maxVertices * 4 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  return {
    backend: 'webgl',
    maxVertices,
    update(positions, colors, count) {
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions, 0, count * 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors, 0, count * 4);
    },
    bind() { device.bindVertexArray(vao); },
    draw(count) { device.drawLines(count); },
    destroy() {
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(colorBuffer);
      gl.deleteVertexArray(vao);
    },
  };
}

function createWebGPULines(device, maxVertices) {
  const usage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
  const positionBytes = maxVertices * 3 * 4;
  const colorBytes = maxVertices * 4 * 4;
  const buffers = {
    position: {
      buffer: device.createBuffer(positionBytes, usage, 'line_positions'),
      byteLength: positionBytes,
      size: positionBytes,
    },
    color: {
      buffer: device.createBuffer(colorBytes, usage, 'line_colors'),
      byteLength: colorBytes,
      size: colorBytes,
    },
  };
  // A geometry object the device can bind: keys match the shader's vertex inputs.
  const geometry = {
    buffers,
    vertexCount: maxVertices,
    indexCount: 0,
    isIndexed: false,
    vertexFormat: 'float32',
    instanceBuffer: null,
  };

  return {
    backend: 'webgpu',
    maxVertices,
    geometry,
    update(positions, colors, count) {
      device.gpu.queue.writeBuffer(buffers.position.buffer, 0, positions.buffer ?? positions, positions.byteOffset ?? 0, count * 3 * 4);
      device.gpu.queue.writeBuffer(buffers.color.buffer, 0, colors.buffer ?? colors, colors.byteOffset ?? 0, count * 4 * 4);
    },
    bind() { device.bindVertexArray(geometry); },
    draw(count) { device.drawLines(count); },
    destroy() {
      buffers.position.buffer.destroy();
      buffers.color.buffer.destroy();
    },
  };
}

export default createLineGeometry;
