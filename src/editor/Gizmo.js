/**
 * OminX Engine — transform gizmos.
 *
 * Move / rotate / scale handles for the Studio viewport, drawn as real geometry in
 * `RenderLayer.Gizmo` so they share the renderer's materials, lighting and depth settings instead of
 * being a separate overlay canvas. Handles are screen-constant sized (the scale is derived from the
 * distance to the camera), snapping is a property of the tool, and every drag commits a single undo
 * step through `Editor.history`.
 *
 * @module src/editor/Gizmo
 */
import { Material } from '../../engine/src/renderer/Material.js';
import { RenderLayer } from '../../engine/src/renderer/RenderList.js';
import { createBox, createCone, createTorus, createCylinder } from '../../engine/src/geometry/Primitives.js';
import { Vector3 } from '../../engine/src/math/Vector3.js';
import { Quaternion } from '../../engine/src/math/Quaternion.js';
import { Matrix4 } from '../../engine/src/math/Matrix4.js';
import { clamp, clamp01, DEG2RAD, RAD2DEG } from '../../engine/src/math/MathUtils.js';
import { CollisionLayer } from '../../engine/src/world/Part.js';

export const GizmoMode = { Select: 'select', Move: 'move', Rotate: 'rotate', Scale: 'scale' };
export const GizmoSpace = { World: 'world', Local: 'local' };

const AXES = [
  { key: 'x', index: 0, dir: new Vector3(1, 0, 0), color: 0xff4d4d, name: 'X' },
  { key: 'y', index: 1, dir: new Vector3(0, 1, 0), color: 0x5ce65c, name: 'Y' },
  { key: 'z', index: 2, dir: new Vector3(0, 0, 1), color: 0x4d9dff, name: 'Z' },
];

export class Gizmo {
  /**
   * @param {import('./Editor.js').Editor} editor
   */
  constructor(editor) {
    this.editor = editor;
    this.mode = GizmoMode.Move;
    this.space = GizmoSpace.World;
    this.snap = true;
    this.snapMove = 0.5;
    this.snapRotate = 15;
    this.snapScale = 0.25;
    this.hovered = null;
    this.drag = null;
    this.visible = true;
    this.items = [];
    this.pivot = new Vector3();
    this.orientation = Quaternion.identity();
    this._meshes = null;
    this._materials = null;
  }

  setMode(mode) {
    if (this.mode === mode) return this;
    this.mode = mode;
    this._clear();
    return this;
  }

  setSpace(space) {
    if (this.space === space) return this;
    this.space = space;
    return this;
  }

  // ------------------------------------------------------------------ resources
  _ensureMeshes() {
    if (this._meshes) return this._meshes;
    this._meshes = {
      shaft: createBox(1, 1, 1), // unit box, scaled per axis
      tip: createCone(0.5, 1, 16),
      cube: createBox(1, 1, 1),
      ring: createTorus(1, 0.035, 10, 44),
      pivot: createCylinder(0.05, 0.05, 1, 10),
    };
    return this._meshes;
  }

  _ensureMaterials(renderer) {
    const make = (color, emissiveIntensity = 1.35) => new Material({
      name: `gizmo_${color.toString(16)}`,
      albedo: color,
      emissive: color,
      emissiveIntensity,
      roughness: 0.4,
      metalness: 0,
      castShadow: false,
      receiveShadow: false,
      queue: 900,
    });
    this._materials ??= {
      x: make(AXES[0].color), y: make(AXES[1].color), z: make(AXES[2].color),
      xHot: make(0xffd166, 2.4), yHot: make(0xffd166, 2.4), zHot: make(0xffd166, 2.4),
      center: make(0xf2f5fa, 1.6), centerHot: make(0xffd166, 2.6),
    };
    void renderer;
    return this._materials;
  }

  _clear() {
    const renderer = this.editor.engine.renderer;
    for (const item of this.items) renderer?.remove?.(item);
    this.items.length = 0;
    this._drawnFor = null;
  }

  // ------------------------------------------------------------------ drawing
  /** Rebuilds the handle geometry for the current selection (called every editor frame). */
  update(camera, selection) {
    this._clear();
    if (!this.visible || !selection?.length || this.mode === GizmoMode.Select) return this;
    if (this.editor.engine.mode === 'play') return this;

    const renderer = this.editor.engine.renderer;
    const meshes = this._ensureMeshes();
    const materials = this._ensureMaterials(renderer);

    // Pivot: centroid of the selection, orientation from the last part in local space.
    this.pivot.set(0, 0, 0);
    for (const instance of selection) {
      const world = instance.worldPosition ?? instance.Position;
      this.pivot.x += world.x / selection.length;
      this.pivot.y += world.y / selection.length;
      this.pivot.z += world.z / selection.length;
    }
    const primary = selection[selection.length - 1];
    this.orientation = this.space === GizmoSpace.Local && primary?.worldRotation
      ? Quaternion.new(primary.worldRotation.x, primary.worldRotation.y, primary.worldRotation.z, primary.worldRotation.w)
      : Quaternion.identity();

    const cameraPosition = camera.worldPosition;
    const distance = Math.max(cameraPosition.distanceTo(this.pivot), 1.2);
    const scale = distance * Math.tan(camera.fov * 0.5 * DEG2RAD) * 0.16;

    if (this.mode === GizmoMode.Move || this.mode === GizmoMode.Scale) {
      for (const axis of AXES) {
        const hot = this.hovered?.key === axis.key;
        const { direction, quaternion } = this._axisBasis(axis);
        const length = 1;
        // Shaft
        const shaftScale = new Vector3(0.055, 0.055, length * 0.8);
        const shaftMatrix = new Matrix4().compose(
          Vector3.new(0, 0, 0).addScaled(direction, length * 0.42),
          quaternion,
          shaftScale,
        );
        this.items.push(renderer.addMesh(meshes.shaft, hot ? materials[`${axis.key}Hot`] : materials[axis.key], shaftMatrix, {
          layer: RenderLayer.Gizmo, castShadow: false, receiveShadow: false, name: `gizmo_${this.mode}_${axis.key}`,
        }));
        // Head
        const headScale = this.mode === GizmoMode.Scale
          ? new Vector3(0.19, 0.19, 0.19)
          : new Vector3(0.15, 0.34, 0.15);
        const headMatrix = new Matrix4().compose(
          Vector3.new(0, 0, 0).addScaled(direction, length * 0.94),
          quaternion,
          headScale,
        );
        this.items.push(renderer.addMesh(this.mode === GizmoMode.Scale ? meshes.cube : meshes.tip, hot ? materials[`${axis.key}Hot`] : materials[axis.key], headMatrix, {
          layer: RenderLayer.Gizmo, castShadow: false, receiveShadow: false, name: `gizmo_head_${axis.key}`,
        }));
        this.items[this.items.length - 1].userData = { gizmo: { axis: axis.key, mode: this.mode } };
      }
      // Centre handle: screen-space free move / uniform scale.
      const centreScale = new Vector3(0.16, 0.16, 0.16);
      const centreMatrix = new Matrix4().compose(this.pivot.clone(), this.orientation, centreScale);
      const centreItem = renderer.addMesh(meshes.pivot, this.hovered?.key === 'center' ? materials.centerHot : materials.center, centreMatrix, {
        layer: RenderLayer.Gizmo, castShadow: false, receiveShadow: false, name: 'gizmo_center',
      });
      centreItem.userData = { gizmo: { axis: 'center', mode: this.mode } };
      this.items.push(centreItem);
    } else if (this.mode === GizmoMode.Rotate) {
      for (const axis of AXES) {
        const hot = this.hovered?.key === axis.key;
        // The torus mesh lies in the XZ plane (normal +Y): rotate so the ring's normal is the axis.
        const orient = this._axisBasis(axis).quaternion
          .clone()
          .premultiply(Quaternion.fromAxisAngle(Vector3.new(1, 0, 0), Math.PI / 2));
        const matrix = new Matrix4().compose(this.pivot.clone(), orient, new Vector3(0.9, 0.9, 0.9));
        const item = renderer.addMesh(meshes.ring, hot ? materials[`${axis.key}Hot`] : materials[axis.key], matrix, {
          layer: RenderLayer.Gizmo, castShadow: false, receiveShadow: false, name: `gizmo_rotate_${axis.key}`,
        });
        item.userData = { gizmo: { axis: axis.key, mode: GizmoMode.Rotate } };
        this.items.push(item);
      }
    }
    return this;
  }

  /** Axis direction + the rotation that points a `+Z` primitive down that axis. */
  _axisBasis(axis) {
    const direction = axis.dir.clone();
    if (this.space === GizmoSpace.Local) direction.applyQuaternion(this.orientation).normalize();
    const quaternion = Quaternion.fromToRotation(Vector3.new(0, 0, 1), direction);
    return { direction, quaternion };
  }

  // ------------------------------------------------------------------ picking
  /** Ray → handle hit test. `ray` is `{origin, direction}` in world space. */
  hitTest(ray) {
    if (!this.visible || this.mode === GizmoMode.Select) return null;
    const camera = this.editor.engine.camera;
    const distance = Math.max(camera.worldPosition.distanceTo(this.pivot), 1.2);
    const scale = distance * Math.tan(camera.fov * 0.5 * DEG2RAD) * 0.16;
    const tolerance = scale * 0.14;

    if (this.mode === GizmoMode.Rotate) {
      let best = null;
      for (const axis of AXES) {
        const { direction } = this._axisBasis(axis);
        const hit = intersectPlane(ray, this.pivot, direction);
        if (!hit) continue;
        const offset = Vector3.new(hit.x - this.pivot.x, hit.y - this.pivot.y, hit.z - this.pivot.z);
        const radial = offset.length();
        const target = 0.92 * scale;
        const error = Math.abs(radial - target);
        if (error > tolerance * 1.8) continue;
        if (!best || error < best.error) best = { axis: axis.key, mode: this.mode, point: hit, error };
      }
      return best ? { axis: best.axis, mode: this.mode, point: best.point } : null;
    }

    // Move/scale: closest approach between the camera ray and each axis segment + centre sphere.
    let best = null;
    const centreDistance = pointRayDistance(this.pivot, ray);
    if (centreDistance < tolerance * 1.6 && this.mode === GizmoMode.Move) {
      best = { axis: 'center', mode: this.mode, t: 0, error: centreDistance };
    }
    for (const axis of AXES) {
      const { direction } = this._axisBasis(axis);
      const result = closestAxisPoint(ray, this.pivot, direction, 0, scale * 1.05);
      if (!result) continue;
      if (result.distance > tolerance) continue;
      if (!best || result.distance < best.error) {
        best = { axis: axis.key, mode: this.mode, t: result.t, error: result.distance };
      }
    }
    return best ? { axis: best.axis, mode: this.mode } : null;
  }

  // ------------------------------------------------------------------ dragging
  /** Starts a drag. `selection` is the editor's current selection. */
  beginDrag(hit, ray, selection) {
    const editor = this.editor;
    editor.history.begin(editor.describeTransaction(`${this.mode} ${hit.axis}`));
    const parts = selection.filter((instance) => instance.Position && instance.worldPosition);
    const entries = parts.map((instance) => ({
      instance,
      startPosition: instance.worldPosition.clone(),
      startRotation: Quaternion.new(instance.worldRotation.x, instance.worldRotation.y, instance.worldRotation.z, instance.worldRotation.w),
      startSize: Vector3.new(instance.Size?.x ?? 1, instance.Size?.y ?? 1, instance.Size?.z ?? 1),
      startEuler: Vector3.new(instance.Rotation?.x ?? 0, instance.Rotation?.y ?? 0, instance.Rotation?.z ?? 0),
    }));
    const axis = hit.axis === 'center' ? null : AXES.find((candidate) => candidate.key === hit.axis);
    const direction = axis ? this._axisBasis(axis).direction : Vector3.new(0, 1, 0);
    this.drag = {
      axis: hit.axis,
      direction,
      start: ray ? this._dragValue(ray, direction) : { t: 0, angle: 0, point: null },
      entries,
      planeNormal: this.editor.engine.camera.forward.clone(),
    };
    return this.drag;
  }

  /** Applies the drag for the current pointer ray. */
  updateDrag(ray) {
    const drag = this.drag;
    if (!drag) return false;
    const value = this._dragValue(ray, drag.direction, drag);
    if (this.mode === GizmoMode.Rotate) {
      let delta = value.angle - drag.start.angle;
      if (this.snap) delta = Math.round(delta / (this.snapRotate * DEG2RAD)) * (this.snapRotate * DEG2RAD);
      const axisVector = drag.direction;
      const deltaQuat = Quaternion.fromAxisAngle(axisVector, delta);
      for (const entry of drag.entries) {
        const rotated = deltaQuat.clone().multiply(entry.startRotation).normalize();
        const order = entry.instance.RotationOrder ?? 'XYZ';
        const euler = rotated.toEuler({}, order);
        entry.instance.Rotation = new Vector3(euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG);
      }
      return true;
    }
    if (this.mode === GizmoMode.Scale) {
      let factor = drag.start.t === 0 ? 1 : value.t / drag.start.t;
      factor = clamp(factor, 0.02, 100);
      if (this.snap) factor = Math.max(0.25, Math.round(factor / this.snapScale) * this.snapScale);
      for (const entry of drag.entries) {
        const size = entry.startSize.clone();
        if (drag.axis === 'center' || drag.axis === null) size.scale(factor);
        else size[drag.axis] = Math.max(0.05, size[drag.axis] * factor);
        entry.instance.Size = size;
      }
      return true;
    }
    // Move
    let delta = Vector3.new(0, 0, 0);
    if (drag.axis === 'center') {
      const camera = this.editor.engine.camera;
      const perPixel = 2 * Math.tan(camera.fov * 0.5 * DEG2RAD) * Math.max(camera.worldPosition.distanceTo(this.pivot), 1.2) / (this.editor.engine.renderer.device.height || 800);
      delta.addScaled(Vector3.new(camera.right.x, camera.right.y, camera.right.z), (ray.screenDelta?.x ?? 0) * perPixel);
      delta.addScaled(Vector3.new(0, 1, 0), -(ray.screenDelta?.y ?? 0) * perPixel);
      if (this.snap) {
        delta.set(
          Math.round(delta.x / this.snapMove) * this.snapMove,
          Math.round(delta.y / this.snapMove) * this.snapMove,
          Math.round(delta.z / this.snapMove) * this.snapMove,
        );
      }
    } else {
      let amount = value.t - drag.start.t;
      if (this.snap) amount = Math.round(amount / this.snapMove) * this.snapMove;
      delta.addScaled(drag.direction, amount);
    }
    for (const entry of drag.entries) {
      const target = entry.startPosition.clone().add(delta);
      setWorldPosition(entry.instance, target);
    }
    return true;
  }

  /** Ends the drag and closes the undo transaction. */
  endDrag(commit = true) {
    if (!this.drag) return false;
    this.drag = null;
    this.editor.history.end(commit);
    return true;
  }

  /** Drag-space value: distance along the axis, or angle around it. */
  _dragValue(ray, direction, drag = this.drag) {
    if (this.mode === GizmoMode.Rotate) {
      const point = intersectPlane(ray, this.pivot, direction);
      if (!point) return { t: 0, angle: drag?.start?.angle ?? 0, point: null };
      const reference = Math.abs(direction.y) > 0.9 ? Vector3.new(1, 0, 0) : Vector3.new(0, 1, 0);
      const u = Vector3.new().crossVectors(direction, reference).normalize();
      const v = Vector3.new().crossVectors(direction, u).normalize();
      const offset = Vector3.new(point.x - this.pivot.x, point.y - this.pivot.y, point.z - this.pivot.z);
      const angle = Math.atan2(offset.dot(v), offset.dot(u));
      return { t: 0, angle, point };
    }
    const result = closestAxisPoint(ray, this.pivot, direction, -1e6, 1e6);
    return { t: result?.t ?? 0, angle: 0, point: null };
  }
}

// --------------------------------------------------------------------------- math helpers
/** Closest pair between an infinite axis (point + direction) and a ray; returns the axis parameter. */
function closestAxisPoint(ray, origin, direction, minT = -1e6, maxT = 1e6) {
  const w0 = Vector3.new(ray.origin.x - origin.x, ray.origin.y - origin.y, ray.origin.z - origin.z);
  const a = direction.dot(direction);
  const b = direction.dot(ray.direction);
  const c = ray.direction.dot(ray.direction);
  const d = direction.dot(w0);
  const e = ray.direction.dot(w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-8) return null; // parallel
  const t = clamp((b * e - c * d) / denom, minT, maxT);
  const closest = Vector3.new(origin.x, origin.y, origin.z).addScaled(direction, t);
  const rayT = Math.max((a * e - b * d) / denom, 0);
  const onRay = Vector3.new(ray.origin.x, ray.origin.y, ray.origin.z).addScaled(ray.direction, rayT);
  return { t, distance: closest.distanceTo(onRay), point: closest };
}

/** Ray/plane intersection. */
function intersectPlane(ray, point, normal) {
  const denominator = normal.dot(ray.direction);
  if (Math.abs(denominator) < 1e-6) return null;
  const offset = Vector3.new(point.x - ray.origin.x, point.y - ray.origin.y, point.z - ray.origin.z);
  const t = offset.dot(normal) / denominator;
  if (t < 0) return null;
  return Vector3.new(ray.origin.x, ray.origin.y, ray.origin.z).addScaled(ray.direction, t);
}

function pointRayDistance(point, ray) {
  const offset = Vector3.new(point.x - ray.origin.x, point.y - ray.origin.y, point.z - ray.origin.z);
  const t = Math.max(offset.dot(ray.direction), 0);
  const closest = Vector3.new(ray.origin.x, ray.origin.y, ray.origin.z).addScaled(ray.direction, t);
  return closest.distanceTo(point);
}

/** Writes a world position onto a part, converting through the parent transform when nested. */
export function setWorldPosition(part, world) {
  const parent = part.Parent;
  if (parent?.worldMatrix && parent.ClassName !== 'Scene') {
    const inverse = parent.worldMatrix.clone().invert();
    const local = world.clone().applyMatrix4(inverse);
    part.Position = local;
    return part;
  }
  part.Position = world.clone();
  return part;
}

export { AXES, closestAxisPoint, intersectPlane, pointRayDistance, clamp01, CollisionLayer };
export default Gizmo;
