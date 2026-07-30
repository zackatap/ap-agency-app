# Gleap MCP server setup

This app exposes a read-only MCP (Model Context Protocol) server so the Gleap AI
agent (Kai) can pull GHL + Meta performance data when a support ticket is about
results, then draft a reply for the team.

The server returns facts and plain-English findings. Gleap writes the actual
reply using the ticket context and your voice.

## How it fits together

```
Support ticket (performance) → Gleap agent decides it's perf-related
   → calls our MCP tool with the client name
   → MCP reads the rollup snapshot (GHL+Meta) / live Meta API
   → returns metrics + findings
   → Gleap drafts a reply for the team with real numbers + recommendations
```

## Endpoint

- URL: `https://my.automatedpractice.com/api/mcp/mcp`
  (also works: `https://ap-agency-app.vercel.app/api/mcp/mcp`)
- Transport: Streamable HTTP
- Auth: `Authorization: Bearer <MCP_API_KEY>`

**Do not use `app.automatedpractice.com`.** That host is GHL/GCS white-label
hosting and does **not** route `/api/mcp/*` to this Next.js app. Gleap will get
an XML `AuthenticationRequired` error from Google Storage, not our JSON 401.

`MCP_API_KEY` is required. Until it's set, the endpoint returns `503`, so the
tools can never be exposed unauthenticated by accident.

### 1. Set the secret

Generate a random key and add it to Vercel (Production + Preview) and your local
`.env.local`. The same value must be in Gleap's Authorization header.

```bash
openssl rand -hex 32
```

```
MCP_API_KEY=<the-generated-value>
```

Redeploy so production picks it up. Changing the env var on Vercel without a
redeploy leaves the old value live.

### 2. Connect it in Gleap

1. Open your agent → **Settings → Tools → Add tool**.
2. **Integrations** tab → **Custom MCP** ("Connect your own MCP tool server").
3. Server URL: `https://my.automatedpractice.com/api/mcp/mcp`
   - Must be `https://` (two slashes). A typo like `https:/` will fail.
4. Transport: **Streamable HTTP**.
5. Add a custom header: `Authorization` = `Bearer <MCP_API_KEY>`
   (same value as Vercel `MCP_API_KEY`, word `Bearer`, one space, then the key).
6. Save. The four tools below should appear.

### 3. Lock down access

These tools expose client revenue and ad spend, so keep them off public-facing
chat. In the agent's **Access** settings, restrict the tools to **Copilot / Kai
tasks** (internal), not the customer-facing main chat. The drafted reply is for
your team to review and send, not auto-sent to the client.

## Tools

| Tool | What it does | Source | Speed |
|------|--------------|--------|-------|
| `find_client` | Resolve a name/owner/email/locationId/CID/keyword (supports `AP_TEST:` prefix) | Roster + Client DB sheet | Fast |
| `analyze_client_performance` | KPI diagnostic (leads, appts, shows, closes, spend, CPL, cost/appt, booking/show/close rate, ROAS) current vs prior window, with findings | Rollup snapshot | Fast |
| `get_pipeline_status` | Day-by-day lead flow + open/stale pipeline. Answers "the leads aren't showing up" | Rollup snapshot | Fast |
| `get_ad_performance` | Live per-ad spend, leads, CPL, CTR, frequency; ranks winners/losers | Meta API (live) | Slower |

The snapshot tools read the latest agency rollup (the same data as the
Scorecard), so they're only as fresh as the last refresh. Each response includes
`snapshot.ageHours` so the agent can caveat if data is stale.

## Suggested agent instructions

Paste into the Gleap agent's system prompt / instructions:

> When a ticket is about marketing or sales performance (leads, cost per lead,
> appointments, show rate, "leads aren't coming in", "leads aren't showing up",
> "results dropped"), use the AP Agency MCP tools before replying.
>
> **Internal testing:** If the message contains a line like
> `AP_TEST: drziayan@tcspinesport.com` or `AP_TEST: Treasure Coast Spine`,
> treat that as the client identifier. Call `find_client` with that value
> (including the AP_TEST: prefix is fine), then run the performance tools on
> the matched client. Ignore that this isn't a real client ticket.
>
> 1. Identify the client from the ticket (or from `AP_TEST:`). If unsure, call
>    `find_client` and pick the best match. Emails resolve via OWNER EMAIL /
>    CLIENT REPORT EMAIL in the Client DB. If it's ambiguous, ask the teammate
>    which client.
> 2. Call `analyze_client_performance` for the overall picture (default last_30).
> 3. If the complaint is "leads aren't showing up / stopped coming in", also call
>    `get_pipeline_status` to separate a real volume drop from a tracking break
>    (spend but no leads) or a GHL-hygiene issue (leads captured but not worked).
> 4. If the ticket needs ad recommendations, call `get_ad_performance` to name
>    specific winning and losing ads.
> 5. Draft a reply for the team that quotes the real numbers (leads, CPL, booking
>    rate, etc.), states what changed vs the prior period, and gives 1-3 concrete
>    next actions. Use the `findings` from the tools as your evidence. If
>    `snapshot.ageHours` is large, note the data's freshness.
>
> Never invent numbers. If a tool returns `not_found`, `no_snapshot`, or a Meta
> error, say so plainly instead of guessing.

## How to test without a real client ticket

1. Open the agent in Gleap → use the **test chat** pane.
2. Send something like:

```
AP_TEST: drziayan@tcspinesport.com

I need more leads, and the leads that are coming in aren't showing up!
```

Or use a business name:

```
AP_TEST: Treasure Coast Spine

Why did CPL spike last week?
```

3. Watch Vercel Logs (`[mcp]`) for the tool calls and findings summary.
4. Or skip Gleap entirely and use MCP Inspector / curl (see below).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| XML `<Error><Code>AuthenticationRequired</Code>` | Hitting `app.automatedpractice.com` (GCS), not our app | Use `https://my.automatedpractice.com/api/mcp/mcp` |
| JSON `{"error":"Unauthorized"}` | Wrong/missing Bearer key | Match Gleap header to Vercel `MCP_API_KEY`, redeploy |
| JSON `{"error":"MCP_API_KEY is not configured…"}` | Env var missing on Vercel | Add `MCP_API_KEY` in Vercel → Redeploy |
| SSE fallback / 401 | Streamable HTTP failed, then SSE (we disable SSE) | Fix the Streamable HTTP URL/auth first |

Quick probe (expect JSON, not XML):

```bash
# Wrong host → XML from Google Storage (bad)
curl -s -X POST https://app.automatedpractice.com/api/mcp/mcp \
  -H "Authorization: Bearer anything" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'

# Right host, wrong key → {"error":"Unauthorized"}
curl -s -X POST https://my.automatedpractice.com/api/mcp/mcp \
  -H "Authorization: Bearer wrong" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'

# Right host + right key → SSE/JSON initialize result with serverInfo ap-agency-app
curl -s -X POST https://my.automatedpractice.com/api/mcp/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
```

## Seeing logs (Gleap won't show them)

Gleap only shows its own connection error. Our logs live on **Vercel**:

1. Vercel Dashboard → project → **Logs** (or Deployments → latest → Functions / Runtime Logs)
2. Filter for `/api/mcp` or `[mcp]`
3. What you'll see after a Gleap agent call:

```
[mcp] POST /api/mcp/mcp → auth ok
[mcp] rpc=tools/call status=success 812ms
[mcp] tool=analyze_client_performance status=ok args={"client":"Lam Clinic","period":"last_30"} summary=Lam Clinic Hawaii — Last 30 days - Leads up 55.9%...
```

Auth failures look like:

```
[mcp] POST /api/mcp/mcp → 401 (bad auth; got ef6d49…(len=64), expected len=64; hasAuthHeader=true)
```

The `summary=` field is the same findings text we send back to Gleap (truncated to 500 chars). Full JSON payloads are not dumped into logs to keep them readable.

For interactive testing without Gleap, use the MCP Inspector against local or prod:

```bash
npx @modelcontextprotocol/inspector
# Connect → Streamable HTTP → URL http://localhost:3000/api/mcp/mcp
# (or https://my.automatedpractice.com/api/mcp/mcp)
# Headers: Authorization = Bearer <MCP_API_KEY>
```

## Local testing

```bash
MCP_API_KEY=test-secret-123 npm run dev

# initialize
curl -s -X POST http://localhost:3000/api/mcp/mcp \
  -H "Authorization: Bearer test-secret-123" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# call a tool
curl -s -X POST http://localhost:3000/api/mcp/mcp \
  -H "Authorization: Bearer test-secret-123" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find_client","arguments":{"query":"clinic"}}}'
```

## Notes / future work

- The snapshot tools call `buildAgencyRollupView`, which loads the whole
  snapshot per request. Fine for per-ticket use; if volume grows, add a
  campaign-key-filtered day query for lower latency.
- Gleap's "Agent Context & Auth → Configure endpoint" can pass per-conversation
  context (e.g. the client tied to a ticket). If you wire ticket→client mapping
  there, the agent can skip `find_client`.
- All tools are read-only. No tool writes to GHL, Meta, or the database.
