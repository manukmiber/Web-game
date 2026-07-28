import type { Component, Vec3 } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

export const COLLIDER_SHAPES = ['Box', 'Sphere', 'Capsule', 'Plane', 'Circle', 'Rect'] as const;
export type ColliderShape = (typeof COLLIDER_SHAPES)[number];

/**
 * The two shapes meant for a 2D scene.
 *
 * They are not a second collider type — `Circle` and `Rect` resolve to the same capsule and box
 * the 3D shapes do, extruded along the simulation plane's depth axis. See `physics/dimension`
 * for why 2D is a constraint on one solver rather than a solver of its own.
 */
export const SHAPES_2D: readonly ColliderShape[] = ['Circle', 'Rect'];

export function is2DShape(shape: ColliderShape): boolean {
  return SHAPES_2D.includes(shape);
}

/**
 * The volume an entity occupies as far as the solver is concerned.
 *
 * Separate from `MeshRenderer` on purpose, and the reason is worth stating because "just collide
 * with the mesh" is the obvious first idea. Colliding against rendered triangles means a
 * broadphase over a hundred thousand of them, no reliable inside/outside test for an open mesh,
 * and a collision shape that silently changes cost every time someone raises a segment count in
 * the Inspector. Every engine that ships — Unity, Godot, Unreal — separates the two, and the
 * cheap primitive is what makes a thousand bodies affordable.
 *
 * A collider with no `RigidBody` beside it is **static**: the world, not a thing in it. That is
 * the common case (a floor, a wall, a rock) and making it the default means the simple scene
 * needs one component rather than two.
 */
export interface ColliderComponent extends Component {
  type: 'Collider';
  shape: ColliderShape;
  /** Box full extents, in local units before the entity's scale. */
  size: Vec3;
  /** Sphere and Capsule radius. Scaled by the entity's largest scale component. */
  radius: number;
  /** Capsule total height, caps included — so a 2 m capsule of radius 0.5 has a 1 m barrel. */
  height: number;
  /**
   * Extrusion depth of a `Circle` or `Rect`, along the axis a 2D world does not simulate.
   *
   * A 2D shape has to have *some* depth or nothing would ever touch it in a world whose bodies
   * are only approximately coplanar. Ten metres of it means the Z a sprite happened to be
   * authored at stops mattering, which is the point: in a 2D scene, depth is not gameplay.
   */
  depth: number;
  /** Offset from the entity's origin, in local space. */
  center: Vec3;
  /**
   * Reports overlaps but never pushes anything.
   *
   * The whole of "you walked into the trigger zone" — checkpoints, pickups, damage volumes —
   * is this flag plus the `onTriggerEnter` script hook.
   */
  isTrigger: boolean;
  /** Bounciness, 0..1. 0 is a beanbag; 1 returns all the energy and never settles. */
  restitution: number;
  /** Coulomb friction coefficient. 0 is ice, 1 is rubber on rubber. */
  friction: number;
  /**
   * Collision layer this collider belongs to, and the layers it responds to.
   *
   * Names rather than a bitmask: a scene file that says `layer: "player"` survives someone
   * inserting a layer above it, and a bitmask in a text field is unreadable in the Inspector.
   * `mask` is a comma-separated list, or `*` for everything — which is the default, because a
   * collider that collides with nothing is a confusing thing to get by accident.
   */
  layer: string;
  mask: string;
}

export function createCollider(overrides: Partial<ColliderComponent> = {}): ColliderComponent {
  return {
    type: 'Collider',
    shape: 'Box',
    radius: 0.5,
    height: 2,
    depth: 10,
    isTrigger: false,
    restitution: 0,
    friction: 0.5,
    layer: 'default',
    mask: '*',
    ...overrides,
    size: overrides.size ? [...overrides.size] : [1, 1, 1],
    center: overrides.center ? [...overrides.center] : [0, 0, 0],
  };
}

/**
 * True when a collider on `layer` should respond to one whose mask is `mask`.
 *
 * Both directions are checked by the caller, so a pair only interacts when each side accepts
 * the other — the asymmetric alternative ("bullets hit walls but walls do not hit bullets")
 * produces contacts that resolve on one body and not the other, which reads as tunnelling.
 */
export function layerMatches(mask: string, layer: string): boolean {
  const trimmed = mask.trim();
  if (trimmed === '' || trimmed === '*') return true;
  for (const entry of trimmed.split(',')) {
    if (entry.trim() === layer) return true;
  }
  return false;
}

registerComponent<ColliderComponent>({
  type: 'Collider',
  label: 'Collider',
  create: createCollider,
  fields(component) {
    const fields: FieldSchema[] = [
      { kind: 'enum', key: 'shape', label: 'Shape', options: COLLIDER_SHAPES },
    ];

    if (component.shape === 'Box') {
      fields.push({ kind: 'vec3', key: 'size', label: 'Size', step: 0.1 });
    }
    if (component.shape === 'Rect') {
      // Only the first two components of `size` are read; the third is the plane's depth axis
      // and is governed by `depth` instead, so showing all three would invite editing a number
      // that does nothing.
      fields.push({ kind: 'vec2', key: 'size', label: 'Size', step: 0.1, labels: ['W', 'H'] });
    }
    if (component.shape === 'Sphere' || component.shape === 'Capsule' || component.shape === 'Circle') {
      fields.push({ kind: 'number', key: 'radius', label: 'Radius', min: 0.001, step: 0.05 });
    }
    if (component.shape === 'Capsule') {
      fields.push({ kind: 'number', key: 'height', label: 'Height', min: 0.002, step: 0.1 });
    }
    if (is2DShape(component.shape)) {
      fields.push({ kind: 'number', key: 'depth', label: 'Extrude Depth', min: 0.01, step: 0.5 });
    }
    // A Plane is infinite and faces local +Y, so it has no size and no centre worth showing —
    // the entity's transform is the whole of its definition.
    if (component.shape !== 'Plane') {
      fields.push({ kind: 'vec3', key: 'center', label: 'Center', step: 0.1 });
    }

    fields.push(
      { kind: 'boolean', key: 'isTrigger', label: 'Is Trigger' },
      { kind: 'number', key: 'restitution', label: 'Bounciness', min: 0, max: 1, step: 0.05 },
      { kind: 'number', key: 'friction', label: 'Friction', min: 0, max: 2, step: 0.05 },
      { kind: 'string', key: 'layer', label: 'Layer' },
      { kind: 'string', key: 'mask', label: 'Collides With' },
    );
    return fields;
  },
});
