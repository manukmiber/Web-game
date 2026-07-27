import { serializeScene } from '../../serialization/serialize';
import { executeTool, listTools, type ToolContext } from '../ToolRegistry';
import {
  ErrorCode,
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  failure,
  isJsonRpcRequest,
  result,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol';

export interface McpServerOptions {
  name: string;
  version: string;
  /**
   * Resolved per request rather than held, because the editor's scene, selection and camera
   * all move underneath a long-lived connection.
   */
  context(): ToolContext;
}

/** What `resources/list` advertises and `resources/read` serves. */
const RESOURCES = [
  {
    uri: 'scene://current',
    name: 'Current scene',
    description: 'The whole scene document as saved JSON — entities, components, modifiers, assets.',
    mimeType: 'application/json',
  },
  {
    uri: 'scene://capabilities',
    name: 'Engine capabilities',
    description: 'Primitive kinds, prefabs, component types and modifier types this build supports.',
    mimeType: 'text/plain',
  },
] as const;

/**
 * An MCP server over the scene, as a pure message-in/message-out object.
 *
 * Transport-free on purpose. The same server instance answers a `postMessage` from an
 * embedding page, a WebSocket from the dev-server relay, and a direct call from a test —
 * because the thing MCP standardises is the vocabulary, not the pipe. Wiring a pipe into this
 * class would have meant one implementation per host and no way to test any of them in Node.
 *
 * Session state is deliberately absent: every request is answered from the scene as it is
 * right now. A client that reconnects mid-conversation loses nothing.
 */
export class McpServer {
  /** Set by `initialize`; reported back so a host can show what connected. */
  private client: { name: string; version: string } | null = null;

  constructor(private readonly options: McpServerOptions) {}

  get connectedClient(): { name: string; version: string } | null {
    return this.client;
  }

  /**
   * Handles one message. Returns the response to send, or null for a notification — which by
   * the JSON-RPC rules gets no reply at all, not an empty one.
   */
  handle(message: unknown): JsonRpcResponse | null {
    if (!isJsonRpcRequest(message)) {
      return failure(null, ErrorCode.InvalidRequest, 'Not a JSON-RPC 2.0 request.');
    }
    const request = message;
    const id = request.id ?? null;
    const isNotification = request.id === undefined;

    try {
      const value = this.dispatch(request);
      if (value === undefined) {
        return isNotification ? null : failure(id, ErrorCode.MethodNotFound, `Unknown method "${request.method}".`);
      }
      return isNotification ? null : result(id, value);
    } catch (error) {
      if (isNotification) return null;
      return failure(id, ErrorCode.InternalError, (error as Error).message);
    }
  }

  /** Returns undefined for methods this server does not implement. */
  private dispatch(request: JsonRpcRequest): unknown {
    const params = request.params ?? {};

    switch (request.method) {
      case 'initialize':
        return this.initialize(params);

      // The client telling us it is ready. Nothing to do, but it must not be an error.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return {};

      case 'tools/list':
        return {
          tools: listTools().map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.input,
            annotations: {
              title: tool.title,
              readOnlyHint: tool.readOnly === true,
              // Nothing here reaches outside the scene document, and the editor keeps every
              // edit on the undo stack. Saying so lets a client skip prompting for reads.
              destructiveHint: tool.readOnly !== true,
              openWorldHint: false,
            },
          })),
        };

      case 'tools/call':
        return this.callTool(params);

      case 'resources/list':
        return { resources: RESOURCES };

      case 'resources/read':
        return this.readResource(params);

      default:
        return undefined;
    }
  }

  private initialize(params: Record<string, unknown>): unknown {
    const info = params.clientInfo as { name?: unknown; version?: unknown } | undefined;
    this.client = {
      name: typeof info?.name === 'string' ? info.name : 'unknown',
      version: typeof info?.version === 'string' ? info.version : '0',
    };

    const requested = params.protocolVersion;
    const agreed =
      typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;

    return {
      protocolVersion: agreed,
      capabilities: {
        // listChanged is false and stays false: the tool set is fixed at build time, so
        // advertising change notifications would promise an event that can never fire.
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: { name: this.options.name, version: this.options.version },
      instructions:
        'Authoring tools for a 3D scene editor. Call describe_scene first to see what exists ' +
        'and to get entity ids, and list_capabilities before naming a component, modifier or ' +
        'primitive parameter. Edits apply to the live editor and land on its undo stack.',
    };
  }

  private callTool(params: Record<string, unknown>): unknown {
    const name = params.name;
    if (typeof name !== 'string') {
      throw new Error('tools/call requires a "name".');
    }
    const outcome = executeTool(name, params.arguments ?? {}, this.options.context());
    // A tool that rejects its arguments is a normal result with isError set, not a protocol
    // error: the model is meant to read the message and try again, and a JSON-RPC error would
    // be handled by the client instead of reaching it.
    return { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError === true };
  }

  private readResource(params: Record<string, unknown>): unknown {
    const uri = params.uri;
    if (typeof uri !== 'string') throw new Error('resources/read requires a "uri".');

    if (uri === 'scene://current') {
      const scene = this.options.context().editor.scene;
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(serializeScene(scene), null, 2),
          },
        ],
      };
    }

    if (uri === 'scene://capabilities') {
      const outcome = executeTool('list_capabilities', { area: 'all' }, this.options.context());
      return { contents: [{ uri, mimeType: 'text/plain', text: outcome.text }] };
    }

    throw new Error(`Unknown resource "${uri}". Known: ${RESOURCES.map((entry) => entry.uri).join(', ')}.`);
  }
}
