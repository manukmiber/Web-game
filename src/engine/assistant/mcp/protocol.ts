/**
 * The JSON-RPC 2.0 envelope the Model Context Protocol speaks, and the handful of MCP shapes
 * this server implements.
 *
 * Written out rather than pulled from a package because the whole surface is one envelope and
 * six methods, and the transport is the interesting part: this server has to run inside a
 * browser tab, driven by whatever the host can reach it with. A dependency that assumes stdio
 * and Node streams would have to be worked around on every axis that matters here.
 */

export const JSONRPC_VERSION = '2.0';

/**
 * The revision this server implements. `initialize` echoes back whatever the client asks for
 * when it is a version we can speak, and answers with this one otherwise, which is what the
 * specification's negotiation rule asks for.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  /** Absent on notifications, which get no reply. */
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** The subset of the standard codes this server can actually produce. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result: value };
}

export function failure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error: data === undefined ? { code, message } : { code, message, data } };
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === JSONRPC_VERSION && typeof candidate.method === 'string';
}
