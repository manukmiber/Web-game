import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Relays MCP traffic between the stdio bridge and the editor tab over Vite's own HMR socket.
 *
 * Vite already runs a bidirectional WebSocket between the dev server and the page, and it
 * carries arbitrary custom events — so an MCP client can reach the running editor without this
 * project standing up a second server, opening a second port, or taking a WebSocket
 * dependency. All the relay does is forward: requests arriving from `tools/mcp-bridge.mjs` go
 * out to the page, responses from the page go back.
 *
 * `send` broadcasts to every connected client, which is why the bridge and the editor each
 * ignore the direction that is not theirs — and why exactly one editor tab should be open when
 * an MCP client is attached. Serve only: there is no HMR socket in a production build, and an
 * MCP endpoint is not something a deployed page should have.
 */
function mcpRelay(): Plugin {
  return {
    name: 'mcp-relay',
    apply: 'serve',
    configureServer(server) {
      server.hot.on('mcp:request', (data) => server.hot.send('mcp:request', data));
      server.hot.on('mcp:response', (data) => server.hot.send('mcp:response', data));
    },
  };
}

export default defineConfig({
  plugins: [react(), mcpRelay()],
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
      '@editor': fileURLToPath(new URL('./src/editor', import.meta.url)),
    },
  },
});
