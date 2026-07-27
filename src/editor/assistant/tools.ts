import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta';
import { executeTool, listTools, type ToolContext, type ToolResult } from '@engine/assistant/ToolRegistry';

export interface ToolCallRecord {
  name: string;
  input: unknown;
  result: ToolResult;
}

/**
 * Adapts the engine's tool registry to the shape the SDK's tool runner executes.
 *
 * The adaptation is deliberately thin — name, description, schema, run — because everything
 * worth getting right (argument validation, error text a model can act on, undo) already
 * happened one layer down. If this function ever grows a second responsibility, it means
 * something leaked out of `engine/assistant` that should not have.
 */
export function runnableTools(
  context: () => ToolContext,
  onCall: (record: ToolCallRecord) => void,
): BetaRunnableTool[] {
  return listTools().map((definition) => ({
    name: definition.name,
    description: definition.description,
    input_schema: definition.input as BetaTool['input_schema'],
    // The registry validates against the same schema the model was given, so there is nothing
    // left to parse here.
    parse: (input: unknown) => input,
    run: (input: unknown) => {
      const result = executeTool(definition.name, input, context());
      onCall({ name: definition.name, input, result });
      // Throwing is how the runner marks a tool result as an error, which is what tells the
      // model to try something else rather than treating the message as a success.
      if (result.isError) throw new Error(result.text);
      return result.text;
    },
  })) as BetaRunnableTool[];
}
