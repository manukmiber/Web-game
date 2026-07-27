/**
 * The machine-facing surface of the engine: a validated tool layer over the scene, and an MCP
 * server that publishes it.
 *
 * Importing this module registers the built-in tools, the same way `components/index.ts`
 * registers the built-in components.
 *
 * It lives in `engine/` rather than `editor/` because the tools operate on scene data and
 * nothing else — no React, no DOM, no undo stack. That is what lets the editor route them
 * through commands while a test or a headless build runs the identical tools straight against
 * a Scene, and it is why the MCP server can be exercised in Node with no browser at all.
 */
export * from './schema';
export * from './SceneEditor';
export * from './ToolRegistry';
export * from './tools';
export * from './mcp/protocol';
export * from './mcp/McpServer';
