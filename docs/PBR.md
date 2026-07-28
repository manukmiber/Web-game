# Materials and PBR

The `Material` component describes a **physically based** surface: metal/rough parameterisation,
seven texture slots, four extension lobes, and an environment the whole thing reflects.

## Why metal/rough

The same parameterisation glTF, Unity, Unreal and Godot all settled on, and it is worth saying why
rather than treating it as inevitable.

The older specular/gloss form lets you author a physically impossible surface without noticing — a
dielectric with a coloured specular, a metal with a bright diffuse — and those surfaces then look
wrong the moment they are lit differently from how they were authored. Metal/rough has one fewer
degree of freedom, and the missing one is exactly the impossible one. `metalness` blends between
two ends:

- **0** — the base colour is *albedo*, and the reflection is white and weak (about 4%).
- **1** — the base colour *is* the reflection, and there is no diffuse term at all.

The consequence people trip over: **a metal with nothing to reflect renders black.** No number of
lights fixes it, because analytic lights only give a metal its highlight. The rest of a metal is
the environment — which is why the environment is part of this document.

## Fields

### Base

| Field                  | Notes                                                        |
| ---------------------- | ------------------------------------------------------------ |
| `color`                | Base colour. Albedo at `metalness` 0, reflectance at 1.       |
| `metalness`            | 0 dielectric, 1 metal. Values in between are almost always wrong for a real material — mix them with a map instead. |
| `roughness`            | 0 mirror, 1 fully diffuse. The single most expressive slider here. |
| `mode`, `alpha`, `cutoff` | Opaque / Transparent / Cutout, exactly as before.          |
| `doubleSided`          | Renders back faces. Needed for cards and single-sided planes. |
| `flatShading`          | Ignores vertex normals. Reads a low-poly mesh as deliberate.  |
| `wireframe`            | Per-material, so one object can be inspected without a mode. |

### Maps

Every slot is an asset id or null. Tiling and offset apply to all of them together.

| Slot               | Contents                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `map`              | Base colour, sRGB.                                                |
| `normalMap`        | Tangent-space normals. `normalScale` strengthens or flattens them. |
| `roughnessMap`     | Per-pixel roughness (green channel, glTF ORM convention).         |
| `metalnessMap`     | Per-pixel metalness (blue channel).                               |
| `aoMap`            | Baked occlusion (red channel). Darkens **ambient and environment** light only, never direct light. |
| `emissiveMap`      | Modulates `emissive`.                                             |
| `displacementMap`  | Displaces vertices along the normal — needs geometry dense enough to displace. |

`normalMap` is the single largest visual return of anything in this component: it changes how light
meets the surface at every pixel, which is what makes a flat quad read as brick.

### Emission

`emissive`, `emissiveIntensity` and `emissiveMap`. Emission is light the surface *shows*, not light
it *casts* — it illuminates nothing else. A glowing lamp still needs a Light component beside it.

### The four extension lobes

Each exists because the base cannot express a real material people ask for:

| Field                                  | The material it unlocks                     |
| -------------------------------------- | ------------------------------------------- |
| `clearcoat`, `clearcoatRoughness`      | Car paint, lacquered wood, a wet surface     |
| `sheen`, `sheenColor`, `sheenRoughness`| Cloth — velvet, satin, brushed fabric        |
| `transmission`, `thickness`, `ior`     | Glass, water, ice                            |
| `specularIntensity`                    | Dielectrics whose reflectance is not 4%      |

They cost a more expensive shader, so **they are opt-in and the engine notices**. A material with
all four at their defaults is built as a `MeshStandardMaterial`; touch any of them and it is built
as a `MeshPhysicalMaterial` instead, which compiles all four lobes into every fragment and — for
transmission — makes the renderer keep a copy of the framebuffer to refract through. A scene of
painted crates pays none of that, and nobody has to remember which shader to pick.

## Environment lighting

`Environment.ibl` prefilters the scene's own sky into an environment map and lights the scene with
it. On by default, because a new scene should show a believable metal rather than a debugging
exercise.

It is generated from the same three colours the sky dome is drawn with, so a scene's reflections
match its background because they *are* its background — no HDR file to load and keep in step. The
prefiltering (`PMREMGenerator`) is the part that matters: a rough metal has to reflect a blurred
environment, and one convolution per roughness level is what makes `roughness` behave across its
whole range instead of only at 0.

Regenerated only when the sky colours change. It is a handful of small render passes, and doing them
per frame would show up in the frame graph.

Turn it off for a stylised look, or for a scene whose lighting is entirely analytic.
`iblIntensity` scales its contribution; 0 is the same as off.

## Colour space, and why every map is a private view

`AssetStore` marks every texture it decodes as sRGB, because it has no idea what a texture will be
used for. That is right for a base colour map and **wrong for everything else**: a normal map
encodes directions, a roughness map encodes a number. Decoding a normal map as sRGB bends every
normal towards the surface, which reads as a bump map that is mysteriously weak in the mid-tones —
a bug that looks like an authoring problem and is not.

Tiling has the same shape of problem from the other direction: in Three, `repeat` and `offset` live
on the *texture*, not the material, so two materials tiling one asset differently cannot share a
texture object.

Both are solved the same way. Each material builds its own lightweight **view** of every asset it
references — a `Texture.clone()`, which shares the decoded image (Three refcounts sources, so the
pixels are uploaded once however many materials use them) and carries its own colour space and uv
transform. The views belong to the material and are disposed with it.

This is also what makes disposal safe. An earlier version disposed `material.map` when releasing a
material — which was the *store's* texture, shared with every other material using the same asset,
so releasing one material blanked that texture everywhere else it appeared. Owning views rather
than borrowing textures is what makes releasing a material a local operation.

One more consequence worth knowing: textures decode asynchronously, and materials are built once
and cached. `AssetStore.textureLoaded` now re-resolves the slots of any live material naming that
asset, so a material built while its image was still in flight picks it up — instead of staying
untextured until something happened to change its cache key.

## The occlusion map's second UV set

Three samples `aoMap` through `uv1`, not `uv` — the glTF convention, where a baked occlusion or
lightmap pass has its own atlas layout. The engine's primitives only ever generate one set, so the
render bridge aliases it: `uv1` is stored as a second name for the same buffer when a material has
an occlusion map. No extra memory, no extra upload, and without it an occlusion map samples an
attribute that does not exist and the mesh renders black.

## Sharing

Materials are cached by a key covering every field, so a thousand identical crates bind one
material. The key is JSON of a normalised component rather than a delimiter-joined string: with
eight fields a joined key was readable, and with thirty, one field inserted in the wrong position
silently shifts every value after it — which is the class of bug where materials come out wearing
another material's roughness.

Unknown fields from a newer build are dropped from the key, so a scene saved by a future version
does not fragment the cache into one material per entity.

## What is deliberately missing

- **Anisotropy and iridescence.** Three supports both; they are two more lobes and neither is
  blocking a scene anyone is trying to build.
- **A shader graph.** The field list is the surface. A node editor is a project of its own.
- **Texture channel packing in the editor.** The maps follow the glTF channel convention on
  *read*, but nothing here packs three greyscale images into one for you.
- **An asset browser.** Map slots are asset ids, and the Inspector still shows them read-only —
  the browser that fills them is Phase 2 work, not part of the material system.
