# Lighting

Five light types, colour temperature, physical intensity units and a shadow budget. Reworked in
**v0.7.5**; the renderer-wide image settings those lights are drawn through live in
[GRAPHICS.md](./GRAPHICS.md).

A scene with no `Light` component gets a built-in placeholder rig so nothing is ever invisible.
The moment a scene has one light of its own, the rig switches off entirely — a scene that had one
light and still got the built-in three would be impossible to light deliberately.

## The types

| Type | Direction | Shadows | Cost |
| --- | --- | --- | --- |
| `Directional` | Along local -Z, position irrelevant | yes | One shadow pass over the whole scene |
| `Point` | Everywhere | yes | Six shadow faces when casting |
| `Spot` | Along local -Z, within a cone | yes | One shadow pass |
| `Hemisphere` | Sky above, bounce below | no | Free |
| `Area` | Along local -Z, from a rectangle | no | No shadow support in Three |

Directional and spot lights point along the entity's **local -Z**, the same convention as a camera
and a character. Three's own default is to aim at the world origin, which makes a light's rotation
appear to do nothing — baffling the first time you rotate one and the shadows do not move.

**`Hemisphere` is the cheapest useful light in the engine.** No shadow pass, no falloff, and it
gives shaded sides a colour instead of black. An outdoor scene usually wants one of these plus one
directional light, and little else.

**`Area` (RectAreaLight)** is a softbox, a window, a strip light in a ceiling. It has `width` and
`height` in metres, produces genuinely soft falloff, and cannot cast a shadow — Three has no
implementation for it, so the checkbox is not offered rather than being a control that silently
does nothing.

## Colour temperature

Tick **Use Temperature** and the light is tinted by a blackbody curve at the given kelvin:

| K | Looks like |
| --- | --- |
| 1800 | Candle |
| 2700 | Warm bulb |
| 4000 | Fluorescent tube |
| 5600 | Midday sun |
| 7500 | Open shade |
| 10000 | Clear blue sky |

It *multiplies* `color` rather than replacing it, so a coloured gel over a warm bulb is
expressible — which is how it works in a studio.

The curve is normalised so its brightest channel is always 1. That matters more than the fit does:
the raw blackbody curve makes 2700 K roughly a third as bright as 6500 K, so dragging the
temperature slider would dim the lamp as a side effect and the fix would be to chase the intensity
slider in the opposite direction. Normalised, the slider does exactly one thing.

## Intensity units

Point, spot and area lights offer a **Units** choice.

- **Artistic** — a unitless dial. How this engine has always worked, and how most people light a
  stylised scene.
- **Physical** — **lumens** for point and spot lights, **nits** for area lights. What the number
  printed on the side of a real bulb says.

Both are offered because both are right for different jobs: matching a photographic reference wants
the physical one, and art-directing a dungeon does not.

The conversion is the interesting part. A point light radiates over the whole sphere, so its
candela is `lumens / 4π`. A spot only fills its cone, whose solid angle is `2π(1 − cos θ)`, so
**the same bulb in a tighter cone is genuinely brighter**. That relationship is the entire reason
to offer physical units: narrowing a spot in artistic mode changes nothing about its brightness,
which is not how a torch works.

Directional and hemisphere lights have no unit choice. A directional light's intensity is an
irradiance multiplier with no bulb behind it.

## Shadows and the budget

Per light: `castShadow`, `shadowMapSize`, `shadowBias`, `shadowNormalBias`, `shadowPriority`, and
`shadowRange` for directional lights.

**Every shadow-casting light is an extra render of the scene** from that light's point of view.
Four casters means five renders a frame. It is the fastest way there is to turn a comfortable frame
into an unplayable one, and the easiest to do by accident, because each light looks free when you
place it.

So the renderer caps them. **Graphics → Shadow lights** sets how many may cast at once (4 by
default, `-1` for no limit), and which ones get the budget is decided **per frame** from three
things, in this order:

1. **`shadowPriority`** — an author's explicit ranking, and it wins outright. The sun in a daylight
   scene wants a high number, so that walking near a torch never costs the scene its primary
   shadows.
2. **Brightness** — a dim light's shadow is barely visible anyway.
3. **Distance to the camera**, falling off with the square. A light behind you contributes a shadow
   nobody will see.

Directional lights get a large distance bonus: they have a position in the scene but their light
does not come from it, so treating one like a lamp would drop the sun the moment you walked away
from wherever its gizmo happens to sit.

The result is that a scene can hold thirty torches and still cost four shadow passes. The
**Statistics** panel (F10) reports "3 of 9" so a light losing its shadow is visible rather than
mysterious — which matters, because that is exactly the kind of change that otherwise reads as a
renderer bug.

### Bias, briefly

`shadowBias` is a depth offset and `shadowNormalBias` offsets the lookup along the surface normal.
The second is the one that actually fixes shadow acne on curved surfaces: depth bias alone can only
trade acne for peter-panning — push it far enough to clean up a sphere and contact shadows detach
from whatever is casting them. Offsetting along the normal scales the correction with how obliquely
the light hits, which is where the error comes from in the first place.

### Directional shadow range

`shadowRange` is the half-extent of the shadow frustum in metres, and it is the dial between "sharp
shadows near the player" and "shadows everywhere, all mushy". A single shadow map stretched over a
large area has no usable resolution anywhere. Halving the range sharpens shadows exactly as much as
doubling the map size, and costs no memory at all.

Cascades remove the trade-off and arrive with the streaming work
([ARCHITECTURE.md §9.4](../ARCHITECTURE.md)).

## Ambient light and the sky

Ambient fill, the background and fog belong to the `Environment` component, not to a light — see
its fields in the Inspector. A hemisphere light and ambient light do overlapping jobs; the
hemisphere one is directional enough to read as sky, so it is usually the better of the two if you
only want one.

## Recipes

**Daylight exterior.** One `Directional` light at 2–3 intensity, rotated down and to one side,
`shadowPriority` 10. One `Hemisphere` light, sky `#a8c8ff`, ground the colour of whatever the
scene is standing on, intensity 0.6–1. Nothing else.

**Torch-lit interior.** One `Hemisphere` at 0.15 so nothing is pure black. `Point` lights at
2700 K with a `range` of 8–12, using physical units if you want them to match a real bulb (a
60 W-equivalent LED is about 800 lumens). Leave the shadow cap at 4 and let the budget follow the
player.

**Product shot.** One `Area` light above and slightly in front, 2 × 1 m, plus a second smaller one
opposite it at a third of the intensity. No shadows from either — add one dim `Spot` behind the
camera if you need a contact shadow.
