import { beforeEach, describe, expect, it } from 'vitest';
import '../../components';
import { Scene } from '../../scene/Scene';
import { DirectSceneEditor } from '../SceneEditor';
import type { ToolContext } from '../ToolRegistry';
import '../tools';
import { McpServer } from './McpServer';
import { ErrorCode, JSONRPC_VERSION, MCP_PROTOCOL_VERSION } from './protocol';

let scene: Scene;
let server: McpServer;
let nextId = 0;

function request(method: string, params?: Record<string, unknown>) {
  nextId += 1;
  return server.handle({ jsonrpc: JSONRPC_VERSION, id: nextId, method, params });
}

function notify(method: string, params?: Record<string, unknown>) {
  return server.handle({ jsonrpc: JSONRPC_VERSION, method, params });
}

/** The text a tools/call result carries, which is all a client actually reads. */
function toolText(response: ReturnType<typeof request>): string {
  const result = response?.result as { content: { text: string }[] };
  return result.content[0]!.text;
}

beforeEach(() => {
  scene = new Scene();
  const context = (): ToolContext => ({
    editor: new DirectSceneEditor(scene),
    spawnPoint: () => [0, 0, 0],
  });
  server = new McpServer({ name: 'test-editor', version: '0.7.0', context });
});

describe('initialize', () => {
  it('reports capabilities and remembers the client', () => {
    const response = request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      clientInfo: { name: 'claude-code', version: '1.2.3' },
    });
    const result = response?.result as Record<string, unknown>;

    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.capabilities).toMatchObject({ tools: { listChanged: false } });
    expect(server.connectedClient).toEqual({ name: 'claude-code', version: '1.2.3' });
  });

  it('agrees to an older protocol revision it can speak', () => {
    const response = request('initialize', { protocolVersion: '2024-11-05' });
    expect((response?.result as Record<string, unknown>).protocolVersion).toBe('2024-11-05');
  });

  it('answers with its own revision when the client asks for one it does not know', () => {
    const response = request('initialize', { protocolVersion: '1999-01-01' });
    expect((response?.result as Record<string, unknown>).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });
});

describe('envelope handling', () => {
  it('says nothing at all in reply to a notification', () => {
    // JSON-RPC requires silence, not an empty response — a reply here would leave the client
    // matching an id it never sent.
    expect(notify('notifications/initialized')).toBeNull();
  });

  it('rejects a message that is not JSON-RPC', () => {
    const response = server.handle({ method: 'tools/list' });
    expect(response?.error?.code).toBe(ErrorCode.InvalidRequest);
  });

  it('reports an unknown method rather than throwing', () => {
    const response = request('prompts/list');
    expect(response?.error?.code).toBe(ErrorCode.MethodNotFound);
  });

  it('stays quiet about an unknown notification', () => {
    expect(notify('notifications/something-new')).toBeNull();
  });
});

describe('tools', () => {
  it('advertises every tool with a schema and a read-only hint', () => {
    const result = request('tools/list')?.result as {
      tools: { name: string; inputSchema: unknown; annotations: { readOnlyHint: boolean } }[];
    };

    expect(result.tools.length).toBeGreaterThan(10);
    const describe = result.tools.find((tool) => tool.name === 'describe_scene')!;
    expect(describe.annotations.readOnlyHint).toBe(true);
    expect(result.tools.find((tool) => tool.name === 'create_primitive')!.annotations.readOnlyHint).toBe(false);
    expect(describe.inputSchema).toMatchObject({ type: 'object' });
  });

  it('runs a tool and changes the scene', () => {
    const response = request('tools/call', {
      name: 'create_primitive',
      arguments: { kind: 'Box', name: 'Crate', position: [1, 2, 3] },
    });

    expect(response?.result).toMatchObject({ isError: false });
    expect(toolText(response)).toContain('Crate');
    expect(scene.size).toBe(1);
    expect(scene.all()[0]!.transform.position).toEqual([1, 2, 3]);
  });

  it('returns a bad argument as a tool error, not a protocol error', () => {
    // The model has to read this and correct itself; a JSON-RPC error would be swallowed by
    // the client instead of reaching it.
    const response = request('tools/call', { name: 'create_primitive', arguments: { kind: 'Blob' } });
    expect(response?.error).toBeUndefined();
    expect(response?.result).toMatchObject({ isError: true });
    expect(toolText(response)).toContain('not one of');
  });

  it('fails a call with no tool name', () => {
    expect(request('tools/call', {})?.error?.code).toBe(ErrorCode.InternalError);
  });
});

describe('resources', () => {
  it('serves the scene document as JSON', () => {
    request('tools/call', { name: 'create_primitive', arguments: { kind: 'Sphere' } });
    const result = request('resources/read', { uri: 'scene://current' })?.result as {
      contents: { text: string }[];
    };

    const parsed = JSON.parse(result.contents[0]!.text);
    expect(parsed.version).toBeGreaterThan(0);
    expect(parsed.chunks[0].entities[0].components[0].primitive).toBe('Sphere');
  });

  it('serves the capability report', () => {
    const result = request('resources/read', { uri: 'scene://capabilities' })?.result as {
      contents: { text: string }[];
    };
    expect(result.contents[0]!.text).toContain('PRIMITIVES');
  });

  it('names the resources it does have when asked for one it does not', () => {
    const response = request('resources/read', { uri: 'scene://nothing' });
    expect(response?.error?.message).toContain('scene://current');
  });

  it('reads the scene as it is now, not as it was when the server was made', () => {
    const before = request('resources/read', { uri: 'scene://current' })?.result as {
      contents: { text: string }[];
    };
    expect(JSON.parse(before.contents[0]!.text).chunks).toHaveLength(0);

    request('tools/call', { name: 'create_primitive', arguments: { kind: 'Box' } });
    const after = request('resources/read', { uri: 'scene://current' })?.result as {
      contents: { text: string }[];
    };
    expect(JSON.parse(after.contents[0]!.text).chunks).toHaveLength(1);
  });
});
