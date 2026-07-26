/**
 * Importing this module registers the built-in components. Both the editor and the future
 * runtime import it once at startup; nothing else should need to know the list.
 */
import '../mesh/modifiers';
import './MeshRenderer';
import './Material';
import './ScatterLayer';

export * from './registry';
export * from './MeshRenderer';
export * from './Material';
export * from './ScatterLayer';
