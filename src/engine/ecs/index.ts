/**
 * The entity-component-system layer.
 *
 * Three things, none of which touches Three.js or the DOM: an index that answers "which entities
 * have this component" in constant time, queries built on it, and a scheduler that computes the
 * order systems run in from constraints they declare. See ARCHITECTURE.md §16.
 */
export * from './ComponentIndex';
export * from './Query';
export * from './EcsWorld';
export * from './Schedule';
