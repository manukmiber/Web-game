# Entity Component System

The scene has been entity-plus-components since Phase 1. What v0.7.6 adds is the two halves that
were missing: a way to *find* entities by what they carry, and a way for systems to declare when
they run instead of being ordered by hand.

Neither changes the data model. A component is still a plain object with a `type` on an entity's
`components` array, still serialised verbatim, still edited through the same undo commands. Nothing
saved by an older build reads differently, and nothing about scene JSON changed.

```
engine/ecs/
  ComponentIndex.ts   type -> entities, maintained off the Scene's events
  Query.ts            all / any / none, resolved against the index
  EcsWorld.ts         the façade systems use, with a query cache
  Schedule.ts         stage + after/before -> the order systems tick in
```

## Queries

Before this, every system opened the same way:

```ts
for (const entity of scene.all()) {
  const collider = entity.components.find((c) => c.type === 'Collider');
  if (!collider) continue;
  ...
}
```

That is O(entities × components) per system per frame. Five systems over a 10 000-entity scene walk
the same ten thousand entities five times to reach the eleven that have a collider — and each one
of them repeats the cast that `find` cannot express.

The index makes the question cheap, and a query makes it declarative:

```ts
const BODIES: QueryDescriptor = { all: ['Collider'] };

for (const entity of engine.ecs.entities(BODIES)) { ... }
```

Three terms, and they compose:

| Term   | Meaning                                     |
| ------ | ------------------------------------------- |
| `all`  | every one of these must be present          |
| `any`  | at least one of these must be present       |
| `none` | none of these may be present                |

`none` is the one that earns its place fastest. The NPC system wants "characters that are not
agents" — the player is a target for the agents but is not steered by them — and expressing that
without `none` means walking the scene and checking twice.

Three shapes cover everything the engine does:

```ts
world.entities(BODIES)                                   // iterate
world.each(BODIES, (entity, collider) => { ... })        // iterate with the component resolved
world.firstComponent<PhysicsComponent>('Physics')        // the scene-wide singleton
```

### What it costs

Results are cached against a revision counter that only moves when the index's *shape* changes —
an entity gained or lost a component type, or appeared or disappeared. A field edit does not bump
it, which matters more than it sounds: dragging a slider in the Inspector emits
`componentsChanged` sixty times a second, and invalidating every query on each of them would make
the cache a pure cost.

The `all` term with the fewest entities drives the iteration. That is the whole performance story
in one line: `{ all: ['MeshRenderer', 'NpcAgent'] }` in a large scene is either eleven checks or
ten thousand, depending on which set you walk.

Results come back in **scene order**, not the index's own order. The sets are hash sets and iterate
by insertion, which is not scene order once a component has been added to an old entity after a new
one — and a system that writes transforms has to visit entities in the same order across a save and
reload, or a scene whose behaviour depends on ordering changes for no visible reason.

### Why not archetypes

A "real" ECS packs components of the same shape into contiguous typed arrays, so a system iterates
memory linearly and the cache does the rest. That is a genuine second win on top of the lookup, and
this engine does not take it.

The reason is that components here are not the ECS's private storage. They are the *serialisation
format* (`serialization/schema.ts` reads them), the *Inspector's model* (field schemas describe
them), and the *undo system's unit of work* (`SetComponentProperty` writes through a dotted path
into one). Packing them into parallel arrays means every one of those grows a translation layer,
and unknown component types — which round-trip verbatim today so a scene from a newer build
survives an older one — have no shape to pack into at all.

The honest summary: the lookup is the factor-of-a-thousand and it costs 200 lines; the packing is a
constant factor and it costs the data model. When profiling says iteration cost is the frame's
problem, the packing is worth revisiting — and the query API above is exactly the seam that would
let it happen without touching a single system.

## Scheduling

Systems used to run in the order `installGameplaySystems` pushed them, documented by a numbered
comment above the pushes. The comment was correct, and it was also the only thing holding the frame
together: hardware has to be pumped before scripts read it, the solver has to step before scripts
are told what collided, agents have to run after the player moved. Insert one system in the wrong
place and every one of those breaks silently, in ways that look like a one-frame input lag rather
than like a scheduling bug.

Now a system declares where it belongs and the order is computed:

```ts
export class PhysicsSystem implements System {
  readonly name = 'PhysicsSystem';
  readonly stage: SystemStage = 'simulate';
}

export class NpcSystem implements System {
  readonly name = 'NpcSystem';
  readonly stage: SystemStage = 'resolve';
  readonly after = ['CharacterSystem'];
}
```

Five stages, each a boundary something actually depends on rather than a convenient label:

| Stage      | What belongs there                                            |
| ---------- | ------------------------------------------------------------- |
| `input`    | devices becoming this frame's snapshot                        |
| `simulate` | the authoritative world step — the solver, and anything moving bodies |
| `script`   | user code, which must see a stepped world and this frame's contacts |
| `resolve`  | things reacting to decisions made in `script`                 |
| `present`  | read-only consumers: cameras, HUD state, telemetry            |

`after` and `before` name systems, and cover the constraints stages cannot: the NPC system and the
character system both belong in `resolve`, and one of them still has to go first.

Three properties fall out that a hand-ordered list cannot give:

- A system added by a test or a headless setup lands in the right place without knowing the list.
- A dependency on a system that is not installed is **ignored**, not an error — so `after:
  ['PhysicsSystem']` does not make physics a hard requirement of a headless simulation.
- A contradiction is *reported*. Two systems each declaring `after` the other, or an `input` system
  asking to run after a `present` one, emits `scheduleConflicts` on the engine — which the editor
  console shows — and the frame still runs, in the order the systems were added. Throwing from the
  middle of a frame would turn a mis-ordered system into a blank viewport.

With no constraints at all the sort is stable and the order is exactly the order systems were added
in, which is what makes this change a refactor rather than a behavioural one.

## Reading it

The **Performance** panel (F8) lists the resolved tick order beside the per-system frame
breakdown. The breakdown is sorted by cost; the schedule is sorted by time. "Why does my system see
last frame's position" is answered by reading the second one.

## What it deliberately is not

- **Not a component store.** Entities own their components. This is a lookup.
- **Not a system base class.** `System` is still an interface with an `update`, and a system that
  wants to walk the scene itself still can.
- **Not parallel.** Systems run in sequence on the main thread. Moving physics and scripts into a
  Worker is the long-standing plan (ARCHITECTURE.md §9.5) and the schedule is a prerequisite for
  it, not a substitute: you cannot decide what may run concurrently until the dependencies are
  written down.
