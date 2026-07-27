# AI integration — tool calls and MCP

The editor can be driven by a model, two ways round, over one set of tools.

- **The Assistant panel** (F2) runs the tool-use loop in the page: you type, Claude calls the
  tools, the viewport updates.
- **An MCP server** publishes the same tools to an outside client — Claude Code, Claude Desktop,
  anything that speaks the Model Context Protocol — so the editor becomes something *your* agent
  can build in.

Both go through `engine/assistant`, which is the point: the tools, their schemas and their
validation exist once, and the two entry points are transport.

```
                          ┌──────────────────────────────┐
  Assistant panel ──────▶ │  engine/assistant            │
  (tool-use loop)         │    tools + JSON Schema       │ ──▶ SceneEditor ──▶ Scene
                          │    validation                │        │
  MCP client ───────────▶ │    McpServer                 │        └── editor: undo stack
  (stdio → dev server)    └──────────────────────────────┘            runtime: direct
```

---

## The tools

Nineteen of them, grouped by what they are for. `list_capabilities` is the one that keeps the
rest honest: it reads the component, modifier and primitive registries at call time, so a
component added tomorrow is discoverable without anything in this list changing.

| Tool | What it does |
| --- | --- |
| `describe_scene` | The hierarchy, indented, with ids, primitives and positions |
| `get_entity` | One entity in full, as JSON |
| `find_entities` | Filter by name fragment, component type or primitive |
| `list_capabilities` | Primitives and their parameters, prefabs, components, modifiers |
| `create_primitive` | One solid, 2D profile or Empty |
| `create_prefab` | Player, Zombie, Villager, Animal, Camera, lights, Environment, Game Logic |
| `duplicate_entity` | Copy a subtree, optionally n times with a cumulative offset |
| `delete_entities` | Remove entities and their children |
| `rename_entity` | Rename one |
| `set_transform` | Move, rotate, scale — absolute or relative |
| `reparent_entities` | Move under a new parent, or to the root |
| `select_entities` | Put the gizmo on something (editor only) |
| `add_component` / `remove_component` | Attach or detach a component |
| `set_component_property` | Write one field, on one or many entities |
| `set_script` | Source, name and props in one call |
| `add_modifier` / `remove_modifier` / `set_modifier_property` | Drive the modifier stack |

**Arguments are validated before anything is written.** A tool call is a model's guess about an
API it cannot see, so the guess meets a schema first (`engine/assistant/schema.ts`). A wrong one
comes back as a sentence naming the field and listing the valid values — `Box has no parameter
"size". It takes: width, height, depth, …` — which is a fix in the next turn rather than a
silently mis-sized box.

**Entity arguments take an id or an exact name.** A model that has just read `"Crate 1"` in a
scene listing will pass `"Crate 1"` back; an id-only API answers that with an error instead of a
crate. Ambiguous names are an error, not a coin flip.

---

## Everything lands on the undo stack

This is the load-bearing part. `engine/assistant` never touches the `Scene` directly — it goes
through a `SceneEditor` interface, and the editor's implementation
(`editor/assistant/CommandSceneEditor.ts`) turns each call into a command.

One tool call is one undo entry, however many steps it took. "Build a fence" is twelve boxes and
a group, and one Ctrl+Z. The alternative — an assistant whose edits cannot be taken back — makes
trying anything ambitious with it a bad bet, and a bad bet is not a feature.

The same interface has a `DirectSceneEditor` that writes straight to the scene, which is what
the tests use and what a headless runtime would use. Same tools, no undo, no editor.

---

## The Assistant panel

Press **F2**, or the button at the bottom right of the viewport.

It needs an Anthropic API key, entered in the panel (⚙) and kept in `localStorage`. There is no
backend to proxy through — the editor is a static site — so the key is the user's own and is
sent from the browser straight to the API. That is a fine trade for a developer tool and a bad
one for a shipped product; if this ever ships to people who are not you, the key belongs behind
a server. `VITE_ANTHROPIC_API_KEY` is honoured for local development and must not be set for a
deployed build.

Model defaults to `claude-opus-5`; Sonnet and Haiku are in the dropdown. Tool calls are printed
in the transcript rather than summarised away, for the same reason the script Console exists: an
assistant that says "I built the courtyard" and one that actually called `create_primitive`
eleven times read identically from the prose alone.

---

## Attaching an external MCP client

The editor's MCP server runs in the page, and nothing can dial into a browser tab. Vite's dev
server already holds a WebSocket open to that page for hot reload, and it carries arbitrary
custom events — so that is the pipe:

```
MCP client ──stdio──▶ tools/mcp-bridge.mjs ──HMR socket──▶ vite ──▶ editor tab
```

No second server, no second port, no WebSocket dependency. In exchange it is dev-only, which is
the honest scope: this is how you drive the editor while building something, not an endpoint a
deployed page should expose.

```bash
npm run dev                                        # terminal 1, with the editor open in a browser
claude mcp add scene-editor -- node tools/mcp-bridge.mjs   # terminal 2
```

Or, for a client with a JSON config:

```json
{
  "mcpServers": {
    "scene-editor": {
      "command": "node",
      "args": ["/absolute/path/to/Web-game/tools/mcp-bridge.mjs"]
    }
  }
}
```

The bridge needs Node 22+ (built-in `WebSocket`) and takes `VITE_DEV_URL` if the dev server is
not on `http://localhost:5173`. Everything it logs goes to stderr, because stdout is the
JSON-RPC channel.

**Keep one editor tab open.** The relay broadcasts, so two tabs means two answers to every
request.

### What the server exposes

- `initialize` negotiates the protocol revision — `2025-06-18`, `2025-03-26` and `2024-11-05`
  are accepted, and an unknown one gets ours back.
- `tools/list` and `tools/call` — the table above, with `readOnlyHint` set on the four read-only
  tools so a client can skip prompting for them.
- `resources/list` and `resources/read` — `scene://current` is the whole scene document as saved
  JSON, `scene://capabilities` is the capability report as text.
- `ping`.

A tool that rejects its arguments comes back as a normal result with `isError: true`, not a
JSON-RPC error. The model is meant to read the message and try again; a protocol error would be
handled by the client instead of reaching it.

### Embedding the editor instead

`?mcp=embed` turns on a `postMessage` transport that answers the frame that embedded the page —
`{ type: 'mcp:request', id, message }` in, `{ type: 'mcp:response', id, message }` back. It is
off by default and answers only `window.parent`: an iframe that quietly accepts scene edits from
any origin is not a feature.

---

## Adding a tool

One file, one import. Same shape as adding a component or a modifier:

```ts
// engine/assistant/tools/mine.ts
registerTool<{ entity: string; radius: number }>({
  name: 'my_tool',
  title: 'My tool',
  description: 'What it does, and when to reach for it.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or name.' },
      radius: { type: 'number', description: 'Metres.', minimum: 0.01, default: 1 },
    },
    required: ['entity'],
  },
  run({ entity, radius }, { editor }) {
    const target = resolveEntity(editor.scene, entity);
    return editor.batch('My tool', () => {
      // …mutate through `editor`, never through `editor.scene`, or it will not undo.
      return `Did the thing to ${target.name} at ${radius} m.`;
    });
  },
});
```

Add it to `engine/assistant/tools/index.ts` and it appears in the panel, in `tools/list`, and in
the MCP client's tool picker. Nothing else has to change.

Two rules worth stating outright:

- **Mutate through the `SceneEditor`, inside a `batch`.** Writing to `editor.scene` directly
  works and skips the undo stack, which is exactly the bug that is hardest to notice.
- **Throw, with a useful message.** Errors become tool results, so the throw is how you tell the
  model what to do differently. Name the field and list the valid values.

---

## What this deliberately is not

- **Not a sandbox.** The tools are the boundary — a model can only do what a tool exposes, and
  every tool is a scene edit. But scripts written via `set_script` run under the same guard-rail
  sandbox as hand-written ones (ARCHITECTURE.md §10.2), which stops accidents and does not
  contain hostile code. Scene JSON was already executable; an assistant writing it does not
  change that, and does not fix it either.
- **Not streaming.** Assistant turns arrive whole. Tool calls appear as they run, which is the
  progress that matters here; token-by-token prose in a 340px panel is not.
- **Not multi-tab.** One editor, one MCP client. The relay broadcasts and the transcript lives
  in one store.
- **Not a deployed endpoint.** The MCP channel is dev-server only, on purpose.
