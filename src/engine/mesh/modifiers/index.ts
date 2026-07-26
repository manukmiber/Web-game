/**
 * Importing this module registers the built-in modifiers. Adding a new one means a new file
 * and a line here — nothing in the Inspector, serializer or undo stack has to change.
 */
import './subdivide';
import './mirror';
import './array';
import './solidify';
import './deform';

export * from './registry';
export * from './subdivide';
export * from './mirror';
export * from './array';
export * from './solidify';
export * from './deform';
