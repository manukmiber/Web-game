#!/usr/bin/env node
/**
 * Connects an MCP client that speaks stdio — Claude Code, Claude Desktop, anything else — to
 * the scene editor running in a browser tab.
 *
 * The editor's MCP server lives in the page, which nothing can dial into. Vite's dev server
 * already holds a WebSocket open to that page for hot reload, and it carries arbitrary custom
 * events, so this bridge speaks that socket's wire format and pumps JSON-RPC through it:
 *
 *   MCP client ──stdio──▶ bridge ──HMR socket──▶ vite ──▶ editor tab
 *                                                            │
 *   MCP client ◀──stdio── bridge ◀──HMR socket── vite ◀──────┘
 *
 * Usage:
 *   npm run dev                       # in one terminal, with the editor open in a browser
 *   claude mcp add scene-editor -- node tools/mcp-bridge.mjs
 *
 * Environment:
 *   VITE_DEV_URL   dev server origin, default http://localhost:5173
 *
 * Requires Node 22+ for the built-in WebSocket client. Everything the bridge logs goes to
 * stderr, because stdout is the JSON-RPC channel and one stray line corrupts it.
 */

import { createInterface } from 'node:readline';

const DEV_URL = process.env.VITE_DEV_URL ?? 'http://localhost:5173';
const SOCKET_URL = `${DEV_URL.replace(/^http/, 'ws')}/`;
/** How long to wait for the tab to answer before telling the client the editor is not there. */
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 1_000;

if (typeof WebSocket !== 'function') {
  console.error('mcp-bridge: this needs Node 22 or newer (no global WebSocket).');
  process.exit(1);
}

/** Requests sent to the page and not yet answered, keyed by the id we gave them. */
const pending = new Map();
let socket = null;
let counter = 0;

function log(...args) {
  console.error('[mcp-bridge]', ...args);
}

function connect() {
  // 'vite-hmr' is the subprotocol Vite's own client uses; the dev server checks for it.
  const next = new WebSocket(SOCKET_URL, 'vite-hmr');

  next.addEventListener('open', () => {
    socket = next;
    log(`connected to ${SOCKET_URL}`);
  });

  next.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return; // HMR chatter that is not ours.
    }
    if (payload.type !== 'custom' || payload.event !== 'mcp:response') return;

    const entry = pending.get(payload.data?.id);
    if (!entry) return;
    pending.delete(payload.data.id);
    clearTimeout(entry.timer);
    entry.resolve(payload.data.message);
  });

  next.addEventListener('close', () => {
    if (socket === next) socket = null;
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  // Reconnect handles this; a dev server that is not up yet is the normal case, not an error.
  next.addEventListener('error', () => {});
}

/** Sends one JSON-RPC message to the page and waits for the matching reply. */
function forward(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`No editor connected. Is \`npm run dev\` running at ${DEV_URL}, with the editor open?`));
  }

  counter += 1;
  const id = `b${counter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The editor did not respond within 30s.'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    socket.send(JSON.stringify({ type: 'custom', event: 'mcp:request', data: { id, message } }));
  });
}

function write(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

connect();

// Newline-delimited JSON, which is what MCP's stdio transport specifies.
const lines = createInterface({ input: process.stdin });

lines.on('line', async (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (error) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    return;
  }

  try {
    const response = await forward(request);
    // Notifications get no reply from the page and must get none from us either.
    if (response) write(response);
  } catch (error) {
    // A transport failure still has to reach the client as a JSON-RPC error, or it sits
    // waiting on an id that will never come back.
    if (request.id !== undefined) {
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } });
    } else {
      log(error.message);
    }
  }
});

lines.on('close', () => process.exit(0));
