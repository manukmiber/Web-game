# Graphics

How a frame is drawn, and what the settings behind **F7** actually change.

Two rules run through all of it. The editor and the game runtime must produce the *same* image,
so everything that decides what the image looks like lives in the engine, in one object
(`GraphicsSettings`), and the editor's panel is a view onto it. And the engine may not touch the
DOM, so nothing here reads `window`, `document` or `devicePixelRatio` — the one setting that
needs a global, the pixel-ratio cap, is applied by whoever owns the canvas.

## The frame

There are two paths, and which one runs depends on a single question: does antialiasing need an
offscreen buffer?

**Direct** — antialiasing off:

```
scene  ─┐
        ├─► canvas          Three tone maps and sRGB-encodes as it draws
overlay ┘
axis indicator ─► canvas
```

**Through the resolve chain** — MSAA or FXAA on:

```
scene  ─┐
        ├─► HDR linear buffer (multisampled) ─► resolve ─► [FXAA] ─► canvas
overlay ┘                                       tone map
                                                sRGB
axis indicator ─────────────────────────────────────────────────────► canvas
```

The overlay — grid, gizmo, selection outline, light and camera handles — shares the world pass's
depth buffer, which is what lets geometry occlude the grid while the selection outline draws over
everything. The axis indicator is drawn last, straight to the canvas, in both paths.

### Why the offscreen buffer exists

The obvious way to get MSAA in WebGL is `new WebGLRenderer({ antialias: true })`. It works, and
it is a dead end: the flag is fixed when the context is created. An antialiasing setting built on
it can only say *restart to apply*, and a restart drops every geometry, texture and shader the
editor has uploaded. Multisampling a **render target** instead makes the sample count an ordinary
runtime value — and hands us the intermediate image FXAA needs anyway.

So the context is created with `antialias: false`, permanently, and `off` in the settings means
exactly that.

### Why tone mapping happens in the resolve pass

Three applies `renderer.toneMapping` and the output colour-space encode **only when it is drawing
to the canvas**. `WebGLPrograms` forces `NoToneMapping` and the linear working colour space for
every render-target draw:

```js
if ( currentRenderTarget === null || currentRenderTarget.isXRRenderTarget === true ) {
  toneMapping = renderer.toneMapping;
}
```

That is the right call — an intermediate buffer should stay linear HDR — but it means that the
moment the scene goes through a render target, the last pass owns tone mapping. The resolve pass
does it by including Three's own `tonemapping_pars_fragment` chunk and calling the function the
mode names, rather than reimplementing the curves. The direct path and the resolve path therefore
run the same code and cannot drift apart. `graphics.test.ts` asserts every function name in the
table exists in that chunk, because a typo there is a shader compile error on the machine of
whoever picked that mode.

The scene buffer is half-float when a tone mapping curve is selected, so highlights survive to
be rolled off rather than clipping on the way in. If the driver has no `EXT_color_buffer_float`
it falls back to 8-bit: highlights clip earlier, which is a much smaller problem than a black
viewport.

### Colour space in custom shaders

Any `ShaderMaterial` in this codebase must end with:

```glsl
gl_FragColor = vec4(colour, alpha);
#include <tonemapping_fragment>
#include <colorspace_fragment>
```

`THREE.Color.set('#3f6fb5')` converts an authored sRGB value into the linear working space. A
shader that writes it out untouched hands the framebuffer linear numbers the display then reads
as sRGB — the result is visibly dark and desaturated, and the further a colour is from grey the
worse it looks. Three's built-in materials end with those two chunks; a `ShaderMaterial` gets
them only by asking. The sky dome and the ground grid were both missing them until v0.7.3.

Both includes resolve **per render target**, which is what makes them the right answer rather
than a hardcoded `pow(colour, 1.0/2.2)`: drawing to the canvas they tone map and encode, drawing
into the resolve buffer they compile away to nothing, because the resolve pass does it once for
the whole image. The sky matches the geometry beside it either way.

One trap: write these shaders in the GLSL 1 dialect. Everything is compiled as `#version 300 es`
regardless, and for a GLSL 1 source Three declares the fragment output *as* `gl_FragColor` —
which is the name those chunks are written against. Declaring `glslVersion: GLSL3` and your own
`out vec4` leaves the chunks unable to see it, and the only bridge is a `#define` of a
`gl_`-prefixed name, which the GLSL preprocessor spec reserves. Derivatives (`fwidth`) are core
in either dialect under WebGL 2.

## Settings

Defined in `src/engine/render/GraphicsSettings.ts`, applied by `RenderHost.applyGraphics()`.

| Field | Range | Notes |
| --- | --- | --- |
| `antialias` | `off` `fxaa` `msaa2` `msaa4` `msaa8` | FXAA and MSAA are alternatives, never both |
| `shadowQuality` | `off` `low` `medium` `high` `ultra` | 0 / 512 / 1024 / 2048 / 4096 |
| `shadowFilter` | `hard` `pcf` `soft` | Basic / PCF / VSM |
| `shadowDistance` | 5–500 m | Half-extent of the built-in sun's frustum |
| `toneMapping` | `none` `linear` `reinhard` `cineon` `neutral` `aces` | |
| `exposure` | 0.1–4 | Applied before the curve |
| `resolutionScale` | 0.25–1 | |
| `pixelRatioCap` | 1–3 | Applied by the canvas owner, not the host |
| `anisotropy` | 1–16, power of two | Clamped to `getMaxAnisotropy()` |

`normalizeGraphics()` is the only way in. Everything — a parsed localStorage blob, a config file,
a partial patch — goes through it, because these values feed straight into GPU resource
allocation: a resolution scale of zero is a zero-sized framebuffer and a lost context, not a
slightly odd frame.

`applyGraphics` is cheap to call with an unchanged object, so callers push the whole settings
object on any change rather than diffing first.

### Antialiasing

`off` is a direct draw. Cheapest path; geometry edges stair-step.

`fxaa` is a fullscreen post-process. It runs *after* tone mapping and the sRGB encode, on purpose:
it thresholds on luma, and luma computed from linear radiance under-detects edges in shadow and
over-detects them in highlights. That ordering costs one extra LDR buffer, allocated only when
FXAA is actually on. On a phone this is usually the right trade over even 2× MSAA — one pass, no
per-sample bandwidth.

`msaa2/4/8` multisample the scene buffer. Real geometric antialiasing, and it does nothing for
aliasing inside a texture or a shader.

### Shadows

Quality is the map resolution; filter is how the lookup is smoothed; distance is how much world
that map has to cover. The panel does the arithmetic for you, because the interesting number is
neither of the first two alone — it is centimetres per texel. **Halving the distance sharpens
shadows exactly as much as doubling the map, and costs no memory at all.** Reach for it first.

`soft` is variance shadow mapping. Three deprecated `PCFSoftShadowMap`, and `WebGLShadowMap` now
warns and rewrites the type to plain PCF on the first shadow render — so keeping it would have
been a menu entry that quietly did the same thing as the one above it. VSM blurs the depth
statistics rather than the comparison, giving a genuinely wide penumbra for a fixed cost; the
trade is light bleeding through thin geometry.

These settings drive the **built-in lighting rig** only. A scene that carries its own `Light`
components sets range, map size, bias and normal bias per light in the Inspector — because in a
scene with several casters, "how far do shadows reach" is a property of each light, not of the
renderer. The rig hides itself the moment a scene has a Light of its own.

Two bias dials, not one. Depth bias alone can only trade acne for peter-panning: push it far
enough to clean up a sphere and contact shadows detach from whatever is casting them. Normal bias
offsets the lookup along the surface normal, so the correction scales with how obliquely the light
hits — which is exactly where the error comes from.

### Resolution

Render scale is the strongest lever in a browser. Fill cost scales with its square, and fill is
what mobile GPUs run out of first. The pixel-ratio cap is the same lever from the other end: a 3×
phone screen renders nine times the pixels of a 1× one for a difference almost nobody can see,
and unlike render scale it costs nothing in sharpness until it actually bites.

Anisotropy is applied by the `AssetStore` rather than per material, and it is stored as well as
applied — textures arrive asynchronously, so a setting changed while one is still decoding has to
be waiting for it when it lands, or the scene ends up with a mix of levels that depends on network
timing.

## Where things live

| File | What |
| --- | --- |
| `engine/render/GraphicsSettings.ts` | The settings type, the tables, and `normalizeGraphics` |
| `engine/render/PostProcess.ts` | Offscreen buffers, the resolve pass and FXAA |
| `engine/render/RenderHost.ts` | The frame, the lighting rig, `applyGraphics` |
| `engine/render/RenderBridge.ts` | Scene data → Three objects, including per-light shadows |
| `editor/state/graphicsSettings.ts` | localStorage, per browser |
| `editor/panels/GraphicsPanel.tsx` | The panel. Holds no state of its own |

Settings persist per browser and never enter a scene file. How sharp your shadows are is a
property of the machine you are sitting at; what colour the sky is belongs to the scene, and lives
in the Environment component.
