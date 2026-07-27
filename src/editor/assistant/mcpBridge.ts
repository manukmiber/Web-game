import type { McpServer } from '@engine/assistant/mcp/McpServer';
import type { JsonRpcResponse } from '@engine/assistant/mcp/protocol';

/** One MCP message in flight, in whichever direction. */
interface Envelope {
  id: string;
  message: unknown;
}

export type McpChannel = 'dev-server' | 'embed';

export interface McpBridgeState {
  channels: McpChannel[];
  /** Name and version reported by whatever called `initialize`. */
  client: string | null;
  handled: number;
}

/**
 * Connects an `McpServer` to whatever this page can be reached on.
 *
 * The server itself is transport-free (`engine/assistant/mcp`), which leaves the awkward part
 * here: an MCP client is normally a process talking over stdio, and this server lives in a
 * browser tab that nothing can dial into. Two pipes solve it from opposite ends.
 *
 * **dev-server** — Vite's HMR socket already runs a bidirectional channel between the page and
 * the dev server, and it carries arbitrary custom events. `tools/mcp-bridge.mjs` speaks that
 * socket's wire format directly and relays stdio into it, so `claude mcp add` reaches the
 * running editor with no extra server, no extra port and no WebSocket dependency. Dev only,
 * which is the honest scope: this is how you drive the editor while building something.
 *
 * **embed** — `postMessage` from a parent frame, for a host page that embeds the editor. Off
 * unless the URL says `?mcp=embed`, and it answers only the frame that embedded us: a hidden
 * iframe that quietly accepts scene edits from any origin is not a feature.
 */
export function connectMcpBridge(server: McpServer, onChange: (state: McpBridgeState) => void): () => void {
  const state: McpBridgeState = { channels: [], client: null, handled: 0 };
  const teardown: (() => void)[] = [];

  const answer = (envelope: Envelope): { id: string; message: JsonRpcResponse | null } => {
    const message = server.handle(envelope.message);
    state.handled += 1;
    state.client = server.connectedClient
      ? `${server.connectedClient.name} ${server.connectedClient.version}`
      : state.client;
    onChange({ ...state });
    return { id: envelope.id, message };
  };

  if (import.meta.hot) {
    const hot = import.meta.hot;
    const onRequest = (data: Envelope) => {
      const response = answer(data);
      // A notification produces no response; sending nothing back is the protocol, and the
      // bridge is not waiting on an id it will never see.
      if (response.message) hot.send('mcp:response', response);
    };
    hot.on('mcp:request', onRequest);
    state.channels.push('dev-server');
    teardown.push(() => hot.off('mcp:request', onRequest));
  }

  const embedded = window.parent !== window;
  const invited = new URLSearchParams(window.location.search).get('mcp') === 'embed';
  if (embedded && invited) {
    const onMessage = (event: MessageEvent) => {
      // Only the frame that embedded us, and only messages that claim to be ours.
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown } & Envelope;
      if (data?.type !== 'mcp:request' || typeof data.id !== 'string') return;
      const response = answer(data);
      if (response.message) window.parent.postMessage({ type: 'mcp:response', ...response }, '*');
    };
    window.addEventListener('message', onMessage);
    state.channels.push('embed');
    teardown.push(() => window.removeEventListener('message', onMessage));
  }

  onChange({ ...state });
  return () => {
    for (const off of teardown) off();
  };
}
