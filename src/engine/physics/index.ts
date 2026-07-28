/**
 * Public surface of the physics engine.
 *
 * Everything here is free of Three.js and of the DOM, so the whole simulation can be lifted
 * into a Worker without a single import changing — see ARCHITECTURE.md §9.5.
 */
export * from './math';
export * from './shapes';
export * from './collision';
export * from './raycast';
export * from './PhysicsWorld';
export * from './PhysicsSystem';
