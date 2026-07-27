import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta';
import type { ToolContext } from '@engine/assistant/ToolRegistry';
import { Emitter } from '@engine/core/Emitter';
import { runnableTools, type ToolCallRecord } from './tools';

/**
 * The SDK is loaded on first use, not on page load.
 *
 * It is a couple of hundred kilobytes that most sessions never need — the editor is a 3D tool
 * first, and the assistant is one panel behind F2. Everything above this line is types, which
 * cost nothing at runtime.
 */
let sdk: typeof import('@anthropic-ai/sdk') | null = null;

async function loadSdk(): Promise<typeof import('@anthropic-ai/sdk')> {
  sdk ??= await import('@anthropic-ai/sdk');
  return sdk;
}

/**
 * Models offered in the panel. Opus is the default because scene authoring is a planning
 * problem before it is a typing problem — the difference between "add a house" producing a box
 * and producing a building shows up in how the work is decomposed, not in the tool calls.
 */
export const ASSISTANT_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;
export type AssistantModel = (typeof ASSISTANT_MODELS)[number];

export const DEFAULT_MODEL: AssistantModel = 'claude-opus-5';

/**
 * Room for the tool-call chatter of a multi-step build. Non-streaming requests risk an HTTP
 * timeout much above this, and a scene edit is a short answer wrapped around a lot of tool use.
 */
const MAX_TOKENS = 16_000;

/** A wall of a hundred boxes is a lot of calls; a runaway loop is more. This is the ceiling. */
const MAX_ITERATIONS = 40;

const SYSTEM_PROMPT = `You are the built-in assistant of a browser 3D scene editor, and you author scenes by calling its tools.

The scene is a tree of entities. Each has a transform (position, Euler rotation in degrees, scale) and a list of components; geometry comes from a MeshRenderer whose primitive runs through a non-destructive modifier stack. Units are metres, Y is up, and -Z is forward for cameras, lights, characters and agents alike.

How to work:
- Call describe_scene before your first edit so you are working from real ids, not guesses.
- Call list_capabilities before you name a component type, a modifier or a primitive parameter. Do not guess field names; the tools will tell you the valid ones if you get it wrong.
- Prefer create_prefab over hand-assembling a character, camera or light rig.
- Build with the modifier stack rather than by hand where it fits: a Rectangle plus Extrude is a wall, a Circle plus Lathe is a vase, and both stay editable afterwards.
- Independent calls can go in one turn. Building twenty fence posts is duplicate_entity with a count and an offset, not twenty create_primitive calls.
- Finish by selecting what you made, so the user can see it.

Every edit lands on the editor's undo stack, so the user can take back anything you do with Ctrl+Z. Scripts you write run only when the user presses Play.

Keep replies short. Say what you built and what you would change next; the viewport already shows the result, so do not describe it back.`;

export interface AssistantEvents {
  /** Assistant prose, one event per assistant turn. */
  text: { text: string };
  toolCall: ToolCallRecord;
  /** Fired when a run finishes, successfully or not. */
  done: { stopReason: string | null; error: string | null };
  busy: { busy: boolean };
}

export interface AssistantOptions {
  apiKey: string;
  model: AssistantModel;
  context(): ToolContext;
}

/**
 * One conversation with the model, driving the editor through the tool layer.
 *
 * The SDK's tool runner owns the request → execute → repeat loop; what is left here is
 * conversation state and turning each iteration into something the panel can render. Writing
 * the loop by hand would have bought nothing — the interesting decisions (what a tool may do,
 * what a bad argument reports back, how an edit is undone) all live below this file.
 */
export class AssistantSession {
  readonly events = new Emitter<AssistantEvents>();

  private client: Anthropic | null = null;
  private messages: BetaMessageParam[] = [];
  private aborter: AbortController | null = null;

  constructor(private readonly options: AssistantOptions) {}

  private async connect(): Promise<Anthropic> {
    if (this.client) return this.client;
    const { default: Client } = await loadSdk();
    this.client = new Client({
      apiKey: this.options.apiKey,
      // The editor is a static site with no backend to proxy through, so the key is the
      // user's own and lives in their browser. The panel says so, and the README says so:
      // this is a developer tool, not a shipped product with a shared key.
      dangerouslyAllowBrowser: true,
    });
    return this.client;
  }

  get busy(): boolean {
    return this.aborter !== null;
  }

  get turns(): number {
    return this.messages.length;
  }

  /** Drops the conversation without touching the scene. */
  reset(): void {
    this.messages = [];
  }

  stop(): void {
    this.aborter?.abort();
  }

  async send(prompt: string): Promise<void> {
    if (this.aborter) throw new Error('The assistant is already working.');

    this.messages.push({ role: 'user', content: prompt });
    const aborter = new AbortController();
    this.aborter = aborter;
    this.events.emit('busy', { busy: true });

    let error: string | null = null;
    let stopReason: string | null = null;

    try {
      const client = await this.connect();
      const runner = client.beta.messages.toolRunner(
        {
          model: this.options.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: this.messages,
          tools: runnableTools(this.options.context, (record) => this.events.emit('toolCall', record)),
          max_iterations: MAX_ITERATIONS,
        },
        { signal: aborter.signal },
      );

      for await (const message of runner) {
        stopReason = message.stop_reason;
        // A refusal comes back as a normal 200 with empty or partial content, so it has to be
        // read off stop_reason rather than caught.
        if (message.stop_reason === 'refusal') {
          error = 'The model declined this request.';
          break;
        }
        const text = message.content
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (text) this.events.emit('text', { text });
      }

      // The runner mutates its own copy of the history; take it back so the next turn
      // continues the conversation rather than restarting it.
      this.messages = [...runner.params.messages];
    } catch (caught) {
      error = describeError(caught);
    } finally {
      this.aborter = null;
      this.events.emit('busy', { busy: false });
      this.events.emit('done', { stopReason, error });
    }
  }
}

function describeError(caught: unknown): string {
  // `sdk` is loaded by the time anything can throw from a request, but the check keeps this
  // honest for a failure during the import itself.
  if (sdk && caught instanceof sdk.APIError) {
    if (caught.status === 401) return 'The API key was rejected. Check it in the panel settings.';
    if (caught.status === 429) return 'Rate limited. Wait a moment and try again.';
    // A connection failure carries no status; "API error :" reads like a bug in the panel.
    return caught.status === undefined ? caught.message : `API error ${caught.status}: ${caught.message}`;
  }
  if (caught instanceof Error) {
    if (caught.name === 'AbortError') return 'Stopped.';
    return caught.message;
  }
  return String(caught);
}
