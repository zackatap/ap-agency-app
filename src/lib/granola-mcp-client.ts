/**
 * Robust Granola MCP tool calls. The granola-api package returns on the first
 * SSE data line, but Granola often sends multiple events before the result.
 */

const MCP_URL = "https://mcp.granola.ai/mcp";
const MCP_PROTOCOL_VERSION = "2025-03-26";

type McpContent = { type: string; text: string };

type McpToolResult = {
  content: McpContent[];
  isError?: boolean;
};

function parseMcpSse(text: string, toolName: string): McpToolResult {
  let lastResult: McpToolResult | null = null;

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let parsed: {
      error?: { message?: string };
      result?: McpToolResult;
    };
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      continue;
    }

    if (parsed.error) {
      throw new Error(
        parsed.error.message ?? `MCP error calling ${toolName}`
      );
    }

    if (parsed.result?.content) {
      lastResult = parsed.result;
    }
  }

  if (!lastResult) {
    throw new Error(`No MCP result for ${toolName}`);
  }

  if (lastResult.isError) {
    const errText =
      lastResult.content?.map((c) => c.text).join(" ") ?? "unknown error";
    throw new Error(`Granola tool error (${toolName}): ${errText}`);
  }

  return lastResult;
}

let sessionCache = new Map<string, string | null>();
let requestId = 1;

async function initializeSession(accessToken: string): Promise<string | null> {
  const cached = sessionCache.get(accessToken);
  if (cached !== undefined) return cached;

  const initId = requestId++;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };

  const initRes = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "AP Agency Content Ideas", version: "1.0.0" },
      },
    }),
  });

  const sessionId = initRes.headers.get("mcp-session-id");
  await initRes.text();

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
    await fetch(MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }).then((r) => r.text());
  }

  sessionCache.set(accessToken, sessionId);
  return sessionId;
}

export async function callGranolaTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const sessionId = await initializeSession(accessToken);
  const id = requestId++;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (res.status === 404 || res.status === 410) {
    sessionCache.delete(accessToken);
    throw new Error("Granola session expired — try again");
  }

  if (!res.ok) {
    throw new Error(`Granola MCP HTTP ${res.status}: ${res.statusText}`);
  }

  const text = await res.text();
  const result = parseMcpSse(text, name);
  return result.content.map((c) => c.text).join("\n");
}
