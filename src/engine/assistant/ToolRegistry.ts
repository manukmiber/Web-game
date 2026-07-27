import type { Vec3 } from '../scene/types';
import type { SceneEditor } from './SceneEditor';
import { validateInput, type ObjectSchema } from './schema';

export interface ToolContext {
  editor: SceneEditor;
  /**
   * Where objects land when the caller does not say. The editor passes the point the viewport
   * camera is looking at, which is what makes "add a crate" put one where you are looking
   * rather than at the world origin, half a kilometre away.
   */
  spawnPoint(): Vec3;
}

export interface ToolResult {
  /** What the caller — a model, or an MCP client — reads back. */
  text: string;
  isError?: boolean;
}

export interface ToolDefinition<Input = Record<string, unknown>> {
  /** snake_case: the convention every MCP client and tool-use example uses. */
  name: string;
  /** One line for menus and logs. */
  title: string;
  /** What the model reads to decide whether this is the right tool. */
  description: string;
  input: ObjectSchema;
  /** Read-only tools are safe to call speculatively and need no undo entry. */
  readOnly?: boolean;
  run(input: Input, context: ToolContext): ToolResult | string;
}

const definitions = new Map<string, ToolDefinition>();

export function registerTool<Input>(definition: ToolDefinition<Input>): void {
  definitions.set(definition.name, definition as ToolDefinition);
}

export function getTool(name: string): ToolDefinition | undefined {
  return definitions.get(name);
}

export function listTools(): ToolDefinition[] {
  // Sorted so the tool list is byte-identical between calls: an unstable order would rewrite
  // the cached prompt prefix on every request and throw away prompt caching.
  return [...definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Validates arguments, runs the tool, and turns anything that goes wrong into a result the
 * caller can read and correct.
 *
 * Nothing here throws. A tool call is a model's guess about an API it cannot see, and the
 * useful response to a wrong guess is a sentence saying which field was wrong and what the
 * valid values are — not an exception that stops the conversation. The one thing that must not
 * happen is a bad guess reaching the scene document, which is what the validation gate is for.
 */
export function executeTool(name: string, rawInput: unknown, context: ToolContext): ToolResult {
  const definition = definitions.get(name);
  if (!definition) {
    return {
      text: `Unknown tool "${name}". Available tools: ${listTools()
        .map((tool) => tool.name)
        .join(', ')}`,
      isError: true,
    };
  }

  const validated = validateInput(definition.input, rawInput);
  if (!validated.ok) {
    return { text: `Invalid arguments for ${name}:\n- ${validated.errors.join('\n- ')}`, isError: true };
  }

  try {
    const result = definition.run(validated.value, context);
    return typeof result === 'string' ? { text: result } : result;
  } catch (error) {
    return { text: `${name} failed: ${(error as Error).message}`, isError: true };
  }
}
