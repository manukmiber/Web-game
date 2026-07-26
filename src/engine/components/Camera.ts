import type { Component, Entity } from '../scene/types';
import { registerComponent } from './registry';

export interface CameraComponent extends Component {
  type: 'Camera';
  /** Vertical field of view in degrees, matching Unity's and Three's convention. */
  fov: number;
  near: number;
  far: number;
  /**
   * The camera Play mode renders through. Exactly one wins: the first primary camera in scene
   * order, or the first camera of any kind if none is marked.
   *
   * A boolean per camera rather than one id on the scene, because a camera is a component and
   * the flag then survives duplicate/delete/undo with no extra bookkeeping — the same reason
   * the environment is a component rather than a scene field.
   */
  primary: boolean;
}

export function createCamera(overrides: Partial<CameraComponent> = {}): CameraComponent {
  return {
    type: 'Camera',
    fov: 60,
    near: 0.1,
    far: 2000,
    primary: true,
    ...overrides,
  };
}

/**
 * The camera Play mode renders through: the first primary one, else the first camera at all.
 *
 * Falling back to any camera rather than to nothing is deliberate — someone who adds a camera
 * and unticks Primary by accident should still see through it, not get a black screen with no
 * explanation.
 */
export function findPrimaryCamera(entities: Entity[]): Entity | null {
  let fallback: Entity | null = null;
  for (const entity of entities) {
    const camera = entity.components.find((c): c is CameraComponent => c.type === 'Camera');
    if (!camera) continue;
    if (camera.primary) return entity;
    fallback ??= entity;
  }
  return fallback;
}

registerComponent<CameraComponent>({
  type: 'Camera',
  label: 'Camera',
  create: createCamera,
  fields() {
    return [
      { kind: 'number', key: 'fov', label: 'Field of View', min: 1, max: 179, step: 1 },
      { kind: 'number', key: 'near', label: 'Near Clip', min: 0.001, step: 0.01 },
      { kind: 'number', key: 'far', label: 'Far Clip', min: 1, step: 10 },
      { kind: 'boolean', key: 'primary', label: 'Primary' },
    ];
  },
});
