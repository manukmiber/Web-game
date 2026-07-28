# Scatter

Mass instancing: many copies of a few meshes, as one entity and one draw call per prototype.

This is the feature [ARCHITECTURE.md §9.3](../ARCHITECTURE.md) reserved a place for in Phase 1
and did not build. The reason for the gap was recorded at the time and still holds: a 25 km ×
25 km world has millions of trees, one entity each is not viable at any level, and a brush
written before the storage format was decided would have been a migration rather than a feature.
So the component existed from the start, with nothing reading it, until v0.7.2 added the parts
that do.

## Adding one

*Game ▾ → Scatter Layer* creates two entities: a **Scatter Source** (a cone, standing in for a
shrub) and a **Scatter Layer** already filled with copies of it. Both are ordinary entities.

Or add a `ScatterLayer` component to anything from the Inspector's *Add Component* menu, then
add prototypes to it.

## Prototypes are entities

A prototype names an entity in the scene, not an asset. That is deliberate, and it is what makes
the feature composable with everything else:

- Change the source object's **colour** and every instance changes.
- Push a **Bevel** or a **Subdivide** onto the source's modifier stack and every instance gets
  it, because the batch borrows geometry through the same refcounted cache an ordinary mesh does.
- Delete the source and the layer keeps drawing its other prototypes rather than disappearing.

Several prototypes carry relative **weights**, so a wood that is nine parts pine and one part
birch is two prototypes at 9 and 1. Weights are relative, not percentages — 9 and 1 is the same
distribution as 90 and 10.

The source object itself still renders as a normal object. It is a thing in the scene, not a
hidden template.

## The brush

Everything the brush needs lives on the component, which is why a layer is cheap on disk: a
forest is a seed and a dozen numbers until you re-roll it.

| Setting | Meaning |
| --- | --- |
| `shape` | `Rect` — `extentX` × `extentZ` half-extents. `Disc` — `extentX` is the radius |
| `density` | Instances per 100 m². 4 is a sparse wood, 40 is undergrowth |
| `maxInstances` | Cap applied after density, ceiling 200,000 |
| `seed` | Change it to re-roll the same settings into a different layout |
| `minScale` / `maxScale` | Per-instance uniform scale range |
| `randomYaw` | Random rotation about Y. Off for anything with a front |
| `groundHeight` | Local Y for every instance — there is no terrain to project onto yet |
| `visible`, `castShadow`, `receiveShadow` | Applied to every batch |

Three buttons under the settings: **Scatter** fills the layer, **Re-roll** bumps the seed and
refills, **Clear** empties it while keeping the prototypes and settings. Each is one undo entry,
including the buffers — a layer whose instance data and prototype list disagree would render
trees as rocks, so they are never restored separately.

The panel shows what the current settings *would* place next to what is already there. That
readout is not decoration: one keystroke in the density field is the difference between two
hundred instances and two hundred thousand, and finding out afterwards is expensive.

**Shadows are off by default.** Casting shadows from a hundred thousand instances is the single
fastest way to turn a forest into a slideshow. Turn it on deliberately, with the Performance panel (`F8`)
open.

## Generation is deterministic

The same brush always produces the same layer, on any machine. `generateScatter` is a pure
function of the settings, seeded with mulberry32 from `engine/core/random` — the same generator
the NPC wander uses, and for the same reason: a thing that cannot be reproduced cannot be tested
or reviewed.

One consequence worth knowing: every instance draws the same number of values from the sequence
whether or not `randomYaw` is on, so toggling it changes the rotations and leaves the positions
and scales exactly where they were.

## The stored format

Three fields on the component carry the instances:

```jsonc
{
  "type": "ScatterLayer",
  "prototypes": [{ "id": "p1", "sourceId": "e17", "weight": 9 }],
  "instances": "AAAAAAAAAAAAAAAA…",   // base64 Float32Array, 8 floats per instance
  "variants": "AAAAAA…",              // base64 Uint16Array, one prototype index per instance
  "instanceCount": 20
}
```

Eight floats per instance: `[x, y, z, qx, qy, qz, qw, uniformScale]`. Quaternions rather than
Euler angles because these are consumed by the GPU and never edited by hand; a single uniform
scale rather than three because a per-axis scale would cost two more floats to buy something
nobody paints.

**Why base64 rather than an array of numbers.** A scene is JSON. Ten thousand instances as
`[[1.2, 0, 3.4], …]` is roughly 400 KB of *text* and 80,000 JSON tokens; the same data as one
base64 string parses in one step. The array form also loses the thing that matters — these are
float32 on the way to the GPU, and round-tripping them through decimal text is both larger and
lossier.

**Little-endian, explicitly.** `new Float32Array(buffer)` reads in platform order, so a scene
authored on one machine would decode to garbage on a big-endian one. Nobody ships a big-endian
browser today; a save format that silently depends on that is still wrong.

**`instanceCount` is a convenience, not the authority.** The buffers are. A hand-edited scene
where the two disagree reads as the smaller of them, so a wrong count can never make the decoder
walk off the end of an array. A truncated payload decodes to whatever survived — a layer with
half its trees is recoverable, an exception during a scene load is not.

Adding scatter needed **no schema version bump**: the brush settings are additive fields on a
component that already round-tripped, and the buffers are strings.

## Rendering

`render/RenderBridge` builds one `THREE.InstancedMesh` per prototype that resolves to a mesh, and
writes a matrix per instance from the packed arrays. Nothing allocates per instance beyond the
buffer the GPU needs.

Batches rebuild when the layer's data changes — and also when a *source* entity changes, which
the layer's own component cannot see. Without that, editing the tree a forest was scattered from
would update the tree and none of the thousand copies of it.

Clicking any instance selects the **layer**. Three raycasts an `InstancedMesh` per instance, so
the click lands; there is no per-instance selection because instances are buffer entries rather
than objects, and inventing a selection model for them is a bigger change than it looks.

The wireframe shading mode skips scatter batches. One `WireframeGeometry` would draw at the
layer's origin rather than at each instance, which is worse than drawing nothing.

## From a script or a tool

The assistant and MCP clients use `scatter_instances`:

```jsonc
{
  "prototypes": ["Pine", "Birch"],
  "weights": [9, 1],
  "shape": "Disc",
  "extentX": 60,
  "density": 8,
  "seed": 3
}
```

Pass `layer` to refill an existing one in place instead of creating another. The tool exists
partly as a guardrail: a model asked to "fill the clearing with trees" would otherwise reach for
ten thousand `create_primitive` calls, and ten thousand entities is not a slow editor, it is a
dead tab.

In code, the same path is three calls:

```ts
import { createPrototype, refillLayer } from '@engine/scatter';
import { createScatterLayer } from '@engine/components/ScatterLayer';

const layer = createScatterLayer({
  prototypes: [createPrototype(pineId, 9), createPrototype(birchId, 1)],
  shape: 'Disc',
  extentX: 60,
  density: 8,
});
Object.assign(layer, refillLayer(layer));
```

`refillLayer` returns the three fields rather than mutating, because in the editor that result
has to become one undo entry — a function that had already written the component would leave
nothing to record.

## What it deliberately does not do yet

- **Stroke painting.** Dragging across the ground with instances appearing under the cursor
  writes into the same buffers through the same codec. What it needs beyond what is here is a
  surface to project onto, which arrives with the terrain heightfield work in §9.4. Area fill is
  the part that is useful without one.
- **Per-instance editing.** Moving one tree means a selection model over buffer entries, and an
  undo representation for buffer deltas. §9.3 says undo for the brush records deltas rather than
  entity add/remove; that machinery is still to write.
- **Chunking.** §9.3's unit is one draw call per prototype *per chunk*. Today it is one per
  prototype, full stop, which is correct until layers get big enough that culling half of one
  matters — and that arrives with the streaming system, not before.
- **LOD and imposters.** §9.4. The prototype list is the natural place to hang an LOD chain, and
  it is shaped for it.
- **Collision.** There is no physics yet, so you walk through the trees exactly as you walk
  through everything else.
