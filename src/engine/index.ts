/**
 * Public surface of the core engine.
 *
 * This is the entire API the editor uses, and it is the entire API the Phase 3 game runtime
 * will use. Nothing below this line knows the editor exists.
 */
export * from './scene/types';
export * from './scene/Scene';
export * from './scene/paths';
export * from './scene/primitives';
export * from './scene/prefabs';
export * from './components';
export * from './mesh/MeshData';
export * from './mesh/generators';
export * from './mesh/modifiers';
export * from './serialization/schema';
export * from './serialization/serialize';
export * from './render/GraphicsSettings';
export * from './render/PostProcess';
export * from './render/RenderBridge';
export * from './render/RenderHost';
export * from './render/environment';
export * from './render/geometry';
export * from './render/material';
export * from './render/ResourceCache';
export * from './assets/AssetStore';
export * from './perf/FrameStats';
export * from './loop/Engine';
export * from './core/Emitter';
export * from './input/InputState';
export * from './gameplay/GameState';
export * from './gameplay/CharacterSystem';
export * from './gameplay/systems';
export * from './scripting/sandbox';
export * from './scripting/ScriptApi';
export * from './scripting/ScriptSystem';
export * from './hardware';
export * from './ai/steering';
export * from './ai/NpcSystem';
export * from './assistant';
