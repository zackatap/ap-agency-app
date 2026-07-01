/**
 * MCP (Model Context Protocol) server for the AP Agency App.
 *
 * Exposes read-only client performance tools so the Gleap AI agent (Kai) can
 * pull GHL + Meta data when a support ticket is about performance, then draft a
 * reply for the team. The server returns FACTS + plain-English FINDINGS; the
 * Gleap agent writes the prose using the ticket context and our voice.
 *
 * Transport: Streamable HTTP. Connect Gleap → Add tool → Integrations →
 * Custom MCP with URL `https://app.automatedpractice.com/api/mcp/mcp` and an
 * `Authorization: Bearer <MCP_API_KEY>` header.
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
 */
function toolResult(summary: string, payload: unknown) {
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
      "Resolve a client reference (business name, owner name, GHL location ID, CID, or Meta campaign keyword) to the agency's roster. Use this first when a ticket mentions a client and you're unsure which account it maps to, or to disambiguate between similarly named clients. Returns matches with locationId, ad account IDs, and a confidence score.",
      {
        query: z
          .string()
          .min(2)
          .describe("The client name or identifier mentioned in the ticket."),
      },
      async ({ query }) => {
        const result = await resolveClient(query);
        if (result.status === "not_found") {
          return toolResult(`No client matched "${query}".`, { status: "not_found", query });
        }
        const summary = result.matches
          .map((m) => `- ${m.businessName} (location ${m.locationId}, score ${m.score})`)
          .join("\n");
        return toolResult(`Found ${result.matches.length} match(es) for "${query}":\n${summary}`, {
          status: "ok",
          matches: result.matches,
        });
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
        const result = await analyzeClientPerformance({
          query: client,
          preset: period as AnalysisPreset | undefined,
        });
        if (result.status === "not_found") {
          return toolResult(`No client matched "${client}". Try find_client first.`, result);
        }
        if (result.status === "ambiguous") {
          return toolResult(
            `"${client}" matched multiple clients. Ask which one, or pass a locationId.`,
            result
          );
        }
        if (result.status === "no_snapshot") {
          return toolResult(
            "No rollup snapshot is available yet. Run an agency rollup refresh first.",
            result
          );
        }
        const summary = `${result.client.businessName} — ${result.window.label}\n${summarizeFindings(
          result.findings,
          "No notable findings."
        )}`;
        return toolResult(summary, result);
      }
    );

    server.tool(
      "get_pipeline_status",
      "Lead-flow health for one client: a day-by-day lead count for the trailing window plus the open pipeline and stale-opportunity count. Use this for 'the leads aren't showing up' or 'we stopped getting leads' tickets to tell apart a real drop in volume, a tracking break (spend but no leads), or a CRM-hygiene problem (leads captured but not worked). Returns a daily series, days since last lead, and findings.",
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
        const result = await getPipelineStatus({ query: client, days });
        if (result.status === "not_found") {
          return toolResult(`No client matched "${client}". Try find_client first.`, result);
        }
        if (result.status === "ambiguous") {
          return toolResult(`"${client}" matched multiple clients. Disambiguate first.`, result);
        }
        if (result.status === "no_snapshot") {
          return toolResult("No rollup snapshot is available yet.", result);
        }
        const summary = `${result.client.businessName} — lead flow, last ${result.window.days} days\n${summarizeFindings(
          result.findings,
          "No notable findings."
        )}`;
        return toolResult(summary, result);
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
        const result = await getAdPerformance({
          query: client,
          preset: period as AdPreset | undefined,
        });
        if (result.status === "not_found") {
          return toolResult(`No client matched "${client}". Try find_client first.`, result);
        }
        if (result.status === "ambiguous") {
          return toolResult(`"${client}" matched multiple clients. Disambiguate first.`, result);
        }
        if (result.status === "no_ad_account") {
          return toolResult("This client has no Meta ad account on file.", result);
        }
        if (result.status === "meta_error") {
          return toolResult(`Meta API error: ${result.message}`, result);
        }
        const summary = `${result.client.businessName} — ad performance, ${result.window.label}\n${summarizeFindings(
          result.findings,
          "No notable findings."
        )}`;
        return toolResult(summary, result);
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
    verboseLogs: process.env.NODE_ENV !== "production",
  }
);

/** Shared-secret gate. Gleap sends `Authorization: Bearer <MCP_API_KEY>`. */
function withBearerAuth(
  inner: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const key = process.env.MCP_API_KEY?.trim();
    if (!key) {
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
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return inner(req);
  };
}

const authedHandler = withBearerAuth(handler);

export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
