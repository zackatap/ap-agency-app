/**
 * MCP (Model Context Protocol) server for the AP Agency App.
 *
 * Exposes read-only client performance tools so the Gleap AI agent (Kai) can
 * pull GHL + Meta data when a support ticket is about performance, then draft a
 * reply for the team. The server returns FACTS + plain-English FINDINGS; the
 * Gleap agent writes the prose using the ticket context and our voice.
 *
 * Transport: Streamable HTTP. Connect Gleap → Add tool → Integrations →
 * Custom MCP with URL `https://my.automatedpractice.com/api/mcp/mcp` and an
 * `Authorization: Bearer <MCP_API_KEY>` header.
 * Do not use app.automatedpractice.com — that host is GHL/GCS, not this app.
 *
 * Tools:
 *   - find_client                 resolve a name/ID to a client + ad account
 *   - analyze_client_performance  current-vs-prior KPI diagnostic + findings
 *   - get_pipeline_status         lead-flow health ("are leads showing up?")
 *   - get_ad_performance          live per-ad Meta breakdown for recommendations
 *
 * Auth is enforced when MCP_API_KEY is set; the route returns 503 until it is,
 * so the tools are never exposed unauthenticated by accident.
 */

import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { resolveClient } from "@/lib/mcp/resolve-client";
import { analyzeClientPerformance, type AnalysisPreset } from "@/lib/mcp/analyze";
import { getPipelineStatus } from "@/lib/mcp/pipeline";
import { getAdPerformance, type AdPreset } from "@/lib/mcp/ads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ANALYSIS_PRESETS = [
  "last_7",
  "last_14",
  "last_30",
  "last_60",
  "last_90",
  "this_month",
  "last_month",
] as const;

const AD_PRESETS = ["last_7", "last_14", "last_30", "last_60", "last_90"] as const;

/**
 * Standard MCP tool result: a short human summary followed by the full JSON
 * payload, so the agent gets both readable findings and structured numbers.
 *
 * Also writes a compact line to Vercel Runtime Logs so you can watch Gleap
 * traffic without Gleap's UI: tool name, args, status, and the findings summary.
 */
function toolResult(
  tool: string,
  args: Record<string, unknown>,
  summary: string,
  payload: unknown
) {
  const status =
    payload && typeof payload === "object" && "status" in payload
      ? String((payload as { status: unknown }).status)
      : "ok";
  // Keep log lines under ~2KB so Vercel doesn't truncate the useful bit.
  const summaryOneLine = summary.replace(/\s+/g, " ").trim().slice(0, 500);
  console.log(
    `[mcp] tool=${tool} status=${status} args=${JSON.stringify(args)} summary=${summaryOneLine}`
  );
  const text = `${summary}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  return { content: [{ type: "text" as const, text }] };
}

function summarizeFindings(findings: string[] | undefined, fallback: string): string {
  if (!findings || findings.length === 0) return fallback;
  return findings.map((f) => `- ${f}`).join("\n");
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "find_client",
      "Resolve a client reference to the agency roster. Accepts business name, owner name, GHL location ID, CID, Meta campaign keyword, OWNER EMAIL, CLIENT REPORT EMAIL, or domain. For internal testing, the query may be prefixed with AP_TEST: (e.g. 'AP_TEST: drziayan@tcspinesport.com' or 'AP_TEST: Treasure Coast Spine'). Use this first when a ticket mentions a client and you're unsure which account it maps to. If the message contains an AP_TEST: line, pass that value (including the prefix is fine).",
      {
        query: z
          .string()
          .min(2)
          .describe(
            "Client name, email, or identifier. May include an AP_TEST: prefix for internal tests."
          ),
      },
      async ({ query }) => {
        const result = await resolveClient(query);
        if (result.status === "not_found") {
          return toolResult(
            "find_client",
            { query: result.query },
            `No client matched "${result.query}".`,
            { status: "not_found", query: result.query }
          );
        }
        const summary = result.matches
          .map(
            (m) =>
              `- ${m.businessName} (location ${m.locationId}, score ${m.score}, via ${m.matchedOn})`
          )
          .join("\n");
        return toolResult(
          "find_client",
          { query: result.query },
          `Found ${result.matches.length} match(es) for "${result.query}":\n${summary}`,
          { status: "ok", matches: result.matches }
        );
      }
    );

    server.tool(
      "analyze_client_performance",
      "Performance diagnostic for one client over a window vs the prior equal window. Use this for tickets about results ('I need more leads', 'leads are expensive', 'why did performance drop'). Returns leads, appointments, shows, closes, ad spend, CPL, cost per appointment, booking/show/close rates, and ROAS with current-vs-prior deltas, plus plain-English findings and data-quality signals. Data comes from the latest rollup snapshot (check snapshot.ageHours).",
      {
        client: z
          .string()
          .min(2)
          .describe("Client name or identifier from the ticket."),
        period: z
          .enum(ANALYSIS_PRESETS)
          .optional()
          .describe("Reporting window. Defaults to last_30 (last 30 days)."),
      },
      async ({ client, period }) => {
        const args = { client, period: period ?? "last_30" };
        const result = await analyzeClientPerformance({
          query: client,
          preset: period as AnalysisPreset | undefined,
        });
        if (result.status === "not_found") {
          return toolResult(
            "analyze_client_performance",
            args,
            `No client matched "${client}". Try find_client first.`,
            result
          );
        }
        if (result.status === "ambiguous") {
          return toolResult(
            "analyze_client_performance",
            args,
            `"${client}" matched multiple clients. Ask which one, or pass a locationId.`,
            result
          );
        }
        if (result.status === "no_snapshot") {
          return toolResult(
            "analyze_client_performance",
            args,
            "No rollup snapshot is available yet. Run an agency rollup refresh first.",
            result
          );
        }
        const summary = `${result.client.businessName} — ${result.window.label}\n${summarizeFindings(
          result.findings,
          "No notable findings."
        )}`;
        return toolResult("analyze_client_performance", args, summary, result);
      }
    );

    server.tool(
      "get_pipeline_status",
      "Lead-flow health for one client: a day-by-day lead count for the trailing window plus the open pipeline and stale-opportunity count. Use this for 'the leads aren't showing up' or 'we stopped getting leads' tickets to tell apart a real drop in volume, a tracking break (spend but no leads), or a GHL-hygiene problem (leads captured but not worked). Returns a daily series, days since last lead, and findings.",
      {
        client: z.string().min(2).describe("Client name or identifier from the ticket."),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Trailing window length in days. Defaults to 14."),
      },
      async ({ client, days }) => {
        const args = { client, days: days ?? 14 };
        const result = await getPipelineStatus({ query: client, days });
        if (result.status === "not_found") {
          return toolResult(
            "get_pipeline_status",
            args,
            `No client matched "${client}". Try find_client first.`,
            result
          );
        }
        if (result.status === "ambiguous") {
          return toolResult(
            "get_pipeline_status",
            args,
            `"${client}" matched multiple clients. Disambiguate first.`,
            result
          );
        }
        if (result.status === "no_snapshot") {
          return toolResult(
            "get_pipeline_status",
            args,
            "No rollup snapshot is available yet.",
            result
          );
        }
        const summary = `${result.client.businessName} — lead flow, last ${result.window.days} days\n${summarizeFindings(
          result.findings,
          "No notable findings."
        )}`;
        return toolResult("get_pipeline_status", args, summary, result);
      }
    );

    server.tool(
      "get_ad_performance",
      "Live Meta ad-level breakdown for one client, for recommending concrete ad changes. Use this after analyze_client_performance when a ticket needs ad recommendations ('which ads should we change?'). Returns per-ad spend, leads, CPL, CTR, frequency, ranked best and worst performers, and findings (scale winners, pause zero-lead spenders, refresh fatigued creative). This hits the Meta API live, so it's slower than the snapshot tools.",
      {
        client: z.string().min(2).describe("Client name or identifier from the ticket."),
        period: z
          .enum(AD_PRESETS)
          .optional()
          .describe("Reporting window. Defaults to last_30 (last 30 days)."),
      },
      async ({ client, period }) => {
        const args = { client, period: period ?? "last_30" };
        const result = await getAdPerformance({
          query: client,
          preset: period as AdPreset | undefined,
        });
        if (result.status === "not_found") {
          return toolResult(
            "get_ad_performance",
            args,
            `No client matched "${client}". Try find_client first.`,
            result
          );
        }
        if (result.status === "ambiguous") {
          return toolResult(
            "get_ad_performance",
            args,
            `"${client}" matched multiple clients. Disambiguate first.`,
            result
          );
        }
        if (result.status === "no_ad_account") {
          return toolResult(
            "get_ad_performance",
            args,
            "This client has no Meta ad account on file.",
            result
          );
        }
        if (result.status === "meta_error") {
          return toolResult(
            "get_ad_performance",
            args,
            `Meta API error: ${result.message}`,
            result
          );
        }
        const summary = `${result.client.businessName} — ad performance, ${result.window.label}\n${summarizeFindings(
          result.findings,
          "No notable findings."
        )}`;
        return toolResult("get_ad_performance", args, summary, result);
      }
    );
  },
  {
    serverInfo: { name: "ap-agency-app", version: "1.0.0" },
  },
  {
    basePath: "/api/mcp",
    maxDuration: 120,
    disableSse: true,
    // Protocol-level events (initialize, tools/list) also land in Vercel logs.
    verboseLogs: true,
    onEvent: (event) => {
      if (event.type === "REQUEST_COMPLETED") {
        console.log(
          `[mcp] rpc=${event.method} status=${event.status}${
            event.duration != null ? ` ${event.duration}ms` : ""
          }`
        );
      } else if (event.type === "ERROR") {
        console.error(`[mcp] error source=${event.source}:`, event.error);
      }
    },
  }
);

/** Shared-secret gate. Gleap sends `Authorization: Bearer <MCP_API_KEY>`. */
function withBearerAuth(
  inner: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    const logBase = `[mcp] ${req.method} ${url.pathname}`;

    const key = process.env.MCP_API_KEY?.trim();
    if (!key) {
      console.warn(`${logBase} → 503 (MCP_API_KEY not configured)`);
      return new Response(
        JSON.stringify({ error: "MCP_API_KEY is not configured on the server" }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    }
    const authHeader = req.headers.get("authorization") ?? "";
    const provided =
      authHeader.replace(/^Bearer\s+/i, "").trim() ||
      req.headers.get("x-api-key")?.trim() ||
      "";
    if (provided !== key) {
      // Never log the secret. Prefix + length are enough to spot a wrong/truncated key.
      const prefix = provided ? `${provided.slice(0, 6)}…(len=${provided.length})` : "(missing)";
      console.warn(
        `${logBase} → 401 (bad auth; got ${prefix}, expected len=${key.length}; hasAuthHeader=${Boolean(authHeader)})`
      );
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    console.log(`${logBase} → auth ok`);
    return inner(req);
  };
}

const authedHandler = withBearerAuth(handler);

export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
