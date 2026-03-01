import { NextResponse } from "next/server";
import { setToken } from "@/lib/oauth-tokens";

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/v2/error?msg=${encodeURIComponent(error)}`, req.url)
    );
  }
  if (!code) {
    return NextResponse.redirect(
      new URL("/v2/error?msg=Missing+authorization+code", req.url)
    );
  }

  let stateLocationId = "";
  if (state) {
    try {
      const decoded = JSON.parse(
        Buffer.from(state, "base64url").toString("utf-8")
      );
      stateLocationId = decoded.locationId ?? "";
    } catch {
      /* ignore */
    }
  }

  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const clientSecret = process.env.GHL_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GHL_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(
      new URL("/v2/error?msg=OAuth+not+configured", req.url)
    );
  }

  // Agency bulk install expects user_type "Company"; single location expects "Location".
  type TokenResponse = {
    access_token?: string;
    refresh_token?: string;
    locationId?: string;
    companyId?: string;
    expires_in?: number;
    userType?: string;
  };

  let tokenData: TokenResponse | null = null;
  let lastError = "";

  // Per GHL Get Access Token API: token exchange REQUIRES application/x-www-form-urlencoded
  // https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token
  for (const userType of ["Company", "Location"]) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      user_type: userType,
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch(`${GHL_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (tokenRes.ok) {
      tokenData = await tokenRes.json();
      break;
    }
    lastError = await tokenRes.text();
  }

  if (!tokenData?.access_token) {
    return NextResponse.redirect(
      new URL(`/v2/error?msg=${encodeURIComponent(`Token exchange failed: ${lastError.slice(0, 150)}`)}`, req.url)
    );
  }

  const base = new URL(req.url).origin;

  // Location token: we have locationId, store and redirect
  if (tokenData.locationId) {
    const expiresIn = tokenData.expires_in ?? 86400;
    await setToken(tokenData.locationId, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? "",
      locationId: tokenData.locationId,
      companyId: tokenData.companyId,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    });
    return NextResponse.redirect(
      `${base}/v2/location/${tokenData.locationId}/dashboard?connected=1`
    );
  }

  // Company token
  if (tokenData.companyId && tokenData.userType === "Company") {
    const fetchHeaders = {
      Accept: "application/json" as const,
      Authorization: `Bearer ${tokenData.access_token}`,
      Version: API_VERSION,
    };

    // User came from a specific location's Connect button — connect only that one and redirect back
    if (stateLocationId) {
      const locTokenRes = await fetch(`${GHL_BASE}/oauth/locationToken`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Version: API_VERSION,
          Authorization: `Bearer ${tokenData.access_token}`,
        },
        body: JSON.stringify({
          companyId: tokenData.companyId,
          locationId: stateLocationId,
        }),
      });
      if (locTokenRes.ok) {
        const locToken = await locTokenRes.json();
        const accessToken = locToken.access_token ?? locToken.locationAccessToken;
        if (accessToken) {
          const expiresIn = locToken.expires_in ?? 86400;
          await setToken(stateLocationId, {
            access_token: accessToken,
            refresh_token: locToken.refresh_token ?? "",
            locationId: stateLocationId,
            companyId: tokenData.companyId,
            expires_at: Math.floor(Date.now() / 1000) + expiresIn,
          });
          return NextResponse.redirect(
            `${base}/v2/location/${stateLocationId}/dashboard?connected=1`
          );
        }
      }
      return NextResponse.redirect(
        new URL(
          `/v2/error?msg=${encodeURIComponent(`Could not connect location ${stateLocationId}`)}`,
          req.url
        )
      );
    }

    // No stateLocationId: bulk install (marketplace, agency-level). Fetch locations and exchange for each.
    let locationIds: string[] = [];
    let sourceUsed = "";

    // 1) Try GET /locations/search - returns all sub-accounts under agency
    // Try companyId, company_id (snake_case), or no filter (token may imply company scope)
    for (const [companyKey, companyVal] of [
      ["companyId", tokenData.companyId],
      ["company_id", tokenData.companyId],
      [null, null],
    ] as const) {
      if (locationIds.length > 0) break;
      const searchUrl = new URL(`${GHL_BASE}/locations/search`);
      if (companyKey && companyVal) searchUrl.searchParams.set(companyKey, companyVal);
      searchUrl.searchParams.set("limit", "100");
      const searchRes = await fetch(searchUrl.toString(), { headers: fetchHeaders });

      // Debug: log what locations/search returns (shows in Vercel logs)
      console.log(`[GHL OAuth] locations/search ${companyKey ?? "no-filter"}: ${searchRes.status} ${searchRes.statusText}`);

      if (!searchRes.ok) {
        try {
          const errBody = await searchRes.text();
          console.warn(`[GHL OAuth] locations/search error body: ${errBody.slice(0, 200)}`);
        } catch {
          /* ignore */
        }
        continue;
      }
      const searchData = await searchRes.json();
      const searchLocations = searchData.locations ?? searchData.data ?? searchData;
      const items = Array.isArray(searchLocations) ? searchLocations : [];
      const ids = items.map((l: { id?: string; locationId?: string; _id?: string }) => l.id ?? l.locationId ?? l._id).filter((id: unknown): id is string => Boolean(id));
      locationIds.push(...ids);

      // Paginate with page/limit if supported
      let page = 2;
      const total = (searchData as { meta?: { total?: number }; total?: number }).meta?.total ?? (searchData as { meta?: { total?: number }; total?: number }).total;
      let lastBatch = ids;
      while (lastBatch.length >= 100 && (total == null || locationIds.length < total)) {
        searchUrl.searchParams.set("page", String(page));
        const nextRes = await fetch(searchUrl.toString(), { headers: fetchHeaders });
        if (!nextRes.ok) break;
        const nextData = await nextRes.json();
        const nextItems = Array.isArray(nextData.locations ?? nextData.data ?? nextData) ? (nextData.locations ?? nextData.data ?? nextData) : [];
        const nextIds = nextItems.map((l: { id?: string; locationId?: string; _id?: string }) => l.id ?? l.locationId ?? l._id).filter((id: unknown): id is string => Boolean(id));
        if (nextIds.length === 0) break;
        locationIds.push(...nextIds);
        lastBatch = nextIds;
        page++;
      }
      if (locationIds.length > 0) {
        sourceUsed = `locations/search ${companyKey ?? "no-filter"}`;
        console.log(`[GHL OAuth] ${sourceUsed} returned ${locationIds.length} locations`);
        break;
      }
    }

    // 2) Fallback: oauth/installedLocations (only locations where app was installed)
    if (locationIds.length === 0) {
      console.log("[GHL OAuth] locations/search returned 0, trying oauth/installedLocations");
      const appId = "69a2032af2f17e38db20dcad";
      let startAfterId: string | null = null;
      let hasMore = true;
      while (hasMore) {
        const locationsUrl = new URL(`${GHL_BASE}/oauth/installedLocations`);
        locationsUrl.searchParams.set("companyId", tokenData.companyId);
        locationsUrl.searchParams.set("appId", appId);
        if (startAfterId) {
          locationsUrl.searchParams.set("startAfterId", startAfterId);
          locationsUrl.searchParams.set("limit", "100");
        }
        const locationsRes = await fetch(locationsUrl.toString(), { headers: fetchHeaders });
        if (!locationsRes.ok) {
          const errBody = await locationsRes.text();
          console.warn(`[GHL OAuth] oauth/installedLocations ${locationsRes.status}: ${errBody.slice(0, 150)}`);
          break;
        }
        const locationsData = await locationsRes.json();
        const locations = locationsData.locations ?? locationsData.data ?? locationsData;
        const items = Array.isArray(locations) ? locations : [];
        const ids = items.map((l: { id?: string; locationId?: string; _id?: string }) => l.id ?? l.locationId ?? l._id).filter((id: unknown): id is string => Boolean(id));
        locationIds.push(...ids);
        const last = items[items.length - 1] as { _id?: string } | undefined;
        startAfterId = last?._id ?? null;
        hasMore = ids.length >= 20 && startAfterId != null;
      }
      if (locationIds.length > 0) sourceUsed = "oauth/installedLocations";
      console.log(`[GHL OAuth] oauth/installedLocations returned ${locationIds.length} locations`);
    }

    // 3) Last resort: saas/saas-locations (may require saas scope)
    if (locationIds.length === 0) {
      console.log("[GHL OAuth] installedLocations returned 0, trying saas/saas-locations");
      let saasPage = 1;
      let saasHasMore = true;
      while (saasHasMore) {
        const saasUrl = new URL(`${GHL_BASE}/saas/saas-locations/${tokenData.companyId}`);
        saasUrl.searchParams.set("limit", "100");
        saasUrl.searchParams.set("page", String(saasPage));
        const saasRes = await fetch(saasUrl.toString(), { headers: fetchHeaders });
        if (!saasRes.ok) {
          if (saasPage === 1) {
            const errBody = await saasRes.text();
            console.warn(`[GHL OAuth] saas/saas-locations ${saasRes.status}: ${errBody.slice(0, 150)}`);
          }
          break;
        }
        const saasData = await saasRes.json();
        const saasLocations = saasData.locations ?? saasData.data ?? saasData;
        const items = Array.isArray(saasLocations) ? saasLocations : [];
        const ids = items.map((l: { id?: string; locationId?: string; _id?: string }) => l.id ?? l.locationId ?? l._id).filter((id: unknown): id is string => Boolean(id));
        locationIds.push(...ids);
        saasHasMore = ids.length >= 100;
        saasPage++;
      }
      if (locationIds.length > 0) sourceUsed = "saas/saas-locations";
      console.log(`[GHL OAuth] saas/saas-locations returned ${locationIds.length} locations`);
    }

    console.log(`[GHL OAuth] Final: ${locationIds.length} locations from ${sourceUsed || "none"}`);

    if (locationIds.length === 0) {
      return NextResponse.redirect(
        new URL(`/v2/error?msg=${encodeURIComponent("No locations found for agency")}`, req.url)
      );
    }

    for (const locId of locationIds) {
      const locTokenRes = await fetch(`${GHL_BASE}/oauth/locationToken`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Version: API_VERSION,
          Authorization: `Bearer ${tokenData.access_token}`,
        },
        body: JSON.stringify({
          companyId: tokenData.companyId,
          locationId: locId,
        }),
      });
      if (locTokenRes.ok) {
        const locToken = await locTokenRes.json();
        const accessToken = locToken.access_token ?? locToken.locationAccessToken;
        if (accessToken) {
          const expiresIn = locToken.expires_in ?? 86400;
          await setToken(locId, {
            access_token: accessToken,
            refresh_token: locToken.refresh_token ?? "",
            locationId: locId,
            companyId: tokenData.companyId,
            expires_at: Math.floor(Date.now() / 1000) + expiresIn,
          });
        }
      }
    }

    const redirectLoc = stateLocationId && locationIds.includes(stateLocationId)
      ? stateLocationId
      : locationIds[0];
    if (redirectLoc) {
      const q = new URLSearchParams({
        connected: "1",
        source: sourceUsed || "unknown",
        count: String(locationIds.length),
      });
      return NextResponse.redirect(
        `${base}/v2/location/${redirectLoc}/dashboard?${q.toString()}`
      );
    }
  }

  return NextResponse.redirect(
    new URL(`/v2/error?msg=${encodeURIComponent(`Could not obtain location token. userType=${tokenData?.userType}, companyId=${tokenData?.companyId}, locationId=${tokenData?.locationId}, state=${state}, stateLocationId=${stateLocationId}`)}`, req.url)
  );
}
