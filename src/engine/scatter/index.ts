/**
 * Mass instancing — the scatter brush and the packed format it writes into.
 *
 * `codec` owns the bytes, `generate` owns the placement, and neither knows about Three.js: the
 * render side lives in `render/RenderBridge`, which is the only thing that turns a layer into
 * `InstancedMesh`es. That split is what keeps a headless runtime, a test and a future Worker
 * able to build a forest without a renderer in the room.
 */
export * from './codec';
export * from './generate';
export * from './layer';
