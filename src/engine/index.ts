/**
 * Public surface of the core engine.
 *
 * This is the entire API the editor uses, and it is the entire API the Phase 3 game runtime
 * will use. Nothing below this line knows the editor exists.
 */
export * from './scene/types';
export * from './scene/Scene';
export * from './scene/primitives';
export * from './components';
export * from './serialization/schema';
export * from './serialization/serialize';
export * from './render/RenderBridge';
export * from './render/RenderHost';
export * from './render/geometry';
export * from './render/material';
export * from './render/ResourceCache';
export * from './assets/AssetStore';
export * from './perf/FrameStats';
export * from './loop/Engine';
export * from './core/Emitter';
