/**
 * `rankproof mcp` — a Model Context Protocol server over stdio, so AI agents
 * can verify links instead of guessing what a page contains.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio).
 * stdout carries protocol messages only; diagnostics go to stderr.
 *
 * Tools are thin adapters over the same engine and contract as the HTTP API.
 * Results keep the honesty rules: `unverified` is a measurement gap, never a
 * missing link, and every claim is scoped to what was fetched.
 */
import { createInterface } from "node:readline";
import { CONTRACT_POLICY, parsePairTable, summarize, type VerifiedRow } from "./observe.ts";
import {
  MAX_VERIFY_ITEMS,
  readRenderMode,
  verifyBacklinks,
  type BacklinkObservation,
} from "./verify-api.server.ts";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const PAIR_SCHEMA = {
  type: "object",
  properties: {
    source_url: {
      type: "string",
      description: "Page that should contain the link (absolute http(s) URL).",
    },
    target_url: { type: "string", description: "Exact URL the link must point to." },
    expected_anchor: { type: "string", description: "Agreed anchor text (optional)." },
    expected_rel: { type: "string", enum: ["follow", "nofollow", "sponsored", "ugc"] },
    expected_placement: {
      type: "string",
      enum: ["content", "navigation", "footer", "sidebar", "comment"],
    },
  },
  required: ["source_url", "target_url"],
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: "verify_links",
    title: "Verify backlinks",
    description:
      "Fetch each source page now and check whether it links to the exact target URL, optionally against an agreed anchor, rel and placement. Returns one verdict per pair: meets (linked as agreed), deviates (linked, but a clause differs), missing (no such anchor in the fetched HTML; JavaScript-inserted links are not seen unless render is used) or unverified (the page could not be read — NOT evidence the link is missing). Each result has a SHA-256 of the HTML that was read. Up to 50 pairs per call; give either `pairs` or a CSV `table`.",
    inputSchema: {
      type: "object",
      properties: {
        pairs: { type: "array", items: PAIR_SCHEMA, maxItems: MAX_VERIFY_ITEMS },
        table: {
          type: "string",
          description:
            "Alternative to pairs: CSV/TSV text, one pair per line: source_url,target_url[,expected_anchor,expected_rel,expected_placement]. A header row is optional.",
        },
        render: {
          type: "string",
          enum: ["off", "fallback", "always"],
          description:
            "Also check pages in headless Chromium (only when the server was started with RANKPROOF_RENDER=1). fallback: only pages where the HTML had no link; always: every page, which also detects links hidden from visitors.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  },
  {
    name: "explain_verdicts",
    title: "Explain RankProof verdicts",
    description:
      "Return the exact meaning and limits of RankProof's verdicts and evidence fields, so an answer to a user does not overstate what was verified.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
] as const;

const EXPLANATION = `RankProof verdicts (contract policy ${CONTRACT_POLICY}):
- meets: an <a> element whose resolved href equals the exact target URL (fragment ignored; scheme, host, path, trailing slash and query significant) was found, and every stated clause (anchor, rel, placement, visibility when rendered) holds.
- deviates: linked, but at least one clause differs, e.g. rel "sponsored" where "follow" was agreed. A deviation from the agreement, not an SEO judgement.
- missing: the representation that was read has no such anchor. Scope matters: fetched_html (no JavaScript ran), rendered_dom (also absent after rendering) or http_resource (the source page returned 404/410). It is not proof the link never existed or is absent for every visitor.
- unverified: the page could not be read (timeout, block, challenge, non-HTML, robots). Never report this as a lost or missing link.
Evidence: response_hash is the SHA-256 of the exact text that was parsed; it shows the stored copy is unchanged, not that the publisher served it to everyone. near_matches lists links to the target site with a different URL (e.g. http vs https). mentions lists plain-text mentions without a link.`;

type Compact = {
  verdict: string;
  source_url: string;
  target_url: string;
  status: BacklinkObservation["status"];
  basis: string;
  anchor: string | null;
  rel: string | null;
  placement: string | null;
  notes: string[];
  reason: string | null;
  near_matches: { href: string; difference: string }[];
  mentioned: boolean;
  checked_at: string;
  response_hash: string | null;
};

function compact(item: BacklinkObservation): Compact {
  return {
    verdict: item.contract.verdict,
    source_url: item.source_url,
    target_url: item.target_url,
    status: item.status,
    basis: item.contract.basis,
    anchor: item.anchor,
    rel: item.rel,
    placement: item.placement,
    notes: item.contract.notes,
    reason: item.status === "confirmed" ? null : item.reason,
    near_matches: item.near_matches
      .slice(0, 3)
      .map((m) => ({ href: m.resolved_href, difference: m.difference })),
    mentioned: item.contract.mentioned,
    checked_at: item.checked_at,
    response_hash: item.response_hash,
  };
}

function textReport(results: Compact[], summary: ReturnType<typeof summarize>): string {
  const lines = [
    `${summary.total} pair(s): ${summary.meets} meet the contract, ${summary.deviates} deviate, ${summary.missing} missing in the fetched page, ${summary.unverified} unverified (could not be checked — not evidence of a missing link).`,
  ];
  for (const r of results) {
    lines.push(
      `- [${r.verdict}] ${r.source_url} → ${r.target_url}${r.anchor ? ` · anchor "${r.anchor}"` : ""}${r.rel !== null && r.status === "confirmed" ? ` · rel ${r.rel || "none"}` : ""}${r.notes[0] ? ` · ${r.notes[0]}` : r.reason ? ` · ${r.reason}` : ""}`,
    );
  }
  return lines.join("\n");
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === "explain_verdicts") {
    return { content: [{ type: "text", text: EXPLANATION }] };
  }
  if (name !== "verify_links") throw new RpcError(-32602, `Unknown tool: ${name}`);
  let items: unknown[];
  if (Array.isArray(args.pairs)) {
    items = args.pairs;
  } else if (typeof args.table === "string") {
    const table = parsePairTable(args.table);
    if (table.rows.length === 0) {
      return toolError(
        table.errors[0]
          ? `Line ${table.errors[0].line}: ${table.errors[0].message}`
          : "No pairs in the table.",
      );
    }
    items = table.rows.map(({ line: _line, ...row }) => row);
  } else {
    return toolError("Give `pairs` (array) or `table` (CSV text).");
  }
  if (items.length > MAX_VERIFY_ITEMS) {
    return toolError(`At most ${MAX_VERIFY_ITEMS} pairs per call; split the list.`);
  }
  try {
    const body = {
      items,
      ...(args.render && args.render !== "off" ? { render: args.render } : {}),
    };
    readRenderMode(body, process.env.RANKPROOF_RENDER === "1");
    const response = await verifyBacklinks(body, {
      allowRender: process.env.RANKPROOF_RENDER === "1",
    });
    const results = response.results.map(compact);
    const summary = summarize(response.results as unknown as VerifiedRow[]);
    return {
      content: [{ type: "text", text: textReport(results, summary) }],
      structuredContent: { summary, results },
    };
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Handles one JSON-RPC message; returns null for notifications. Exported for tests. */
export async function handleMessage(
  message: JsonRpcRequest,
  serverInfo: { name: string; version: string },
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  try {
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      throw new RpcError(-32600, "Invalid request.");
    }
    let result: unknown;
    switch (message.method) {
      case "initialize": {
        const requested = (message.params as { protocolVersion?: string } | undefined)
          ?.protocolVersion;
        result = {
          protocolVersion:
            requested && SUPPORTED_PROTOCOLS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions:
            "Use verify_links to check whether pages link to a URL. Report 'unverified' results as not checked, never as missing links. Call explain_verdicts before summarising results for a user if unsure.",
        };
        break;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== "string")
          throw new RpcError(-32602, "tools/call needs a tool name.");
        const args =
          params.arguments &&
          typeof params.arguments === "object" &&
          !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        result = await callTool(params.name, args);
        break;
      }
      default:
        throw new RpcError(-32601, `Method not found: ${message.method}`);
    }
    return isNotification ? null : { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (isNotification) return null;
    const code = error instanceof RpcError ? error.code : -32603;
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function runMcpStdio(serverInfo: { name: string; version: string }): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
      continue;
    }
    // Valid JSON that is not a request object (a string, an array, null) is an
    // Invalid Request — answered, never silently dropped as a "notification".
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
      continue;
    }
    // Requests run concurrently; responses carry their id.
    const job = handleMessage(message, serverInfo).then((response) => {
      if (response) write(response);
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }
  await Promise.all(pending);
}
