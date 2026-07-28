/**
 * Importing this module registers the built-in components. Both the editor and the future
 * runtime import it once at startup; nothing else should need to know the list.
 */
import '../mesh/modifiers';
import './MeshRenderer';
import './Material';
import './ScatterLayer';
import './Camera';
import './Light';
import './Environment';
import './Physics';
import './Collider';
import './RigidBody';
import './Script';
import './NpcAgent';
import './CharacterController';
import './HardwareInput';
import './HardwareOutput';

export * from './registry';
export * from './MeshRenderer';
export * from './Material';
export * from './ScatterLayer';
export * from './Camera';
export * from './Light';
export * from './Environment';
export * from './Physics';
export * from './Collider';
export * from './RigidBody';
export * from './Script';
export * from './NpcAgent';
export * from './CharacterController';
export * from './HardwareInput';
export * from './HardwareOutput';
