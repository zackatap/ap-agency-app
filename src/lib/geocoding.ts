/**
 * Address geocoding with a Postgres (Neon) cache.
 *
 * Provider selection (first match wins):
 *   1. `GOOGLE_GEOCODING_API_KEY` — Google Geocoding API. Much higher
 *      throughput (~50 QPS) and much better US match rate than Nominatim,
 *      so we parallelize ~10 calls at a time and can finish hundreds of
 *      addresses in seconds. First 10k requests/month are free; after that
 *      it's $5/1k via Google Maps Platform.
 *   2. fallback — OpenStreetMap Nominatim. Free, no API key, but strictly
 *      1 req/sec per their usage policy and often returns "No match" on
 *      suite-level US addresses.
 *
 * Each call to `geocodeAddresses` looks up every address in the cache first
 * and only hits the provider for the misses, up to `maxNewGeocodes`. Failed
 * lookups are cached with a null lat/lng so we don't thrash on bad
 * addresses.
 */
import { neon } from "@neondatabase/serverless";

export type GeocodeProvider = "google" | "nominatim";

export interface GeocodeResult {
  address: string;
  lat: number | null;
  lng: number | null;
  /** Reason geocoding failed for this address (null when it succeeded). */
  error: string | null;
  source: "cache" | GeocodeProvider | "skipped";
}

export interface GeocodeBatchResult {
  results: Map<string, GeocodeResult>;
  newlyGeocoded: number;
  skipped: number;
  fromCache: number;
  /** The provider that handled the fresh (non-cache) lookups this call. */
  provider: GeocodeProvider;
}

// Must be ASCII-only: the Node fetch header validator rejects characters
// like em-dashes with a cryptic `TypeError: Invalid character in header
// content` and we lose the whole request. Any override via the env var is
// assumed to already be ASCII-safe.
const DEFAULT_USER_AGENT =
  "AP-Agency-App/1.0 (internal analytics dashboard, contact: ap-agency)";

/** Concurrent Google calls per batch. Google allows ~50 QPS; 10 keeps us
 *  well under that ceiling while still burning through the list quickly. */
const GOOGLE_CONCURRENCY = 10;

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

/** Which provider will be used for fresh (cache-miss) lookups? Exposed so
 *  the UI can tell the user which geocoder is active. */
export function getActiveGeocodeProvider(): GeocodeProvider {
  return process.env.GOOGLE_GEOCODING_API_KEY ? "google" : "nominatim";
}

/** Collapse whitespace / casing so "123 Main St " and "123 main st" hit the
 *  same cache row. */
export function normalizeAddress(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Strip any non-ASCII characters that would raise a `ByteString` error
 *  when Node's fetch validates outgoing headers. Defensive belt-and-braces
 *  so an innocent smart-quote in an env override doesn't kill every call. */
function asciiOnly(value: string): string {
  return value.replace(/[^\x00-\x7F]+/g, "");
}

type CallResult = { lat: number; lng: number } | { error: string };

async function callGoogle(address: string, apiKey: string): Promise<CallResult> {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", apiKey);
  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      return { error: `Google ${res.status}` };
    }
    const body = (await res.json()) as {
      status?: string;
      error_message?: string;
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
    const status = body.status ?? "UNKNOWN";
    if (status === "ZERO_RESULTS") {
      return { error: "No match" };
    }
    if (status !== "OK") {
      // OVER_QUERY_LIMIT / REQUEST_DENIED / INVALID_REQUEST / ...
      const msg = body.error_message ? `${status}: ${body.error_message}` : status;
      return { error: `Google ${msg}` };
    }
    const loc = body.results?.[0]?.geometry?.location;
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: "Google: malformed geometry" };
    }
    return { lat, lng };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[geocoding] Google fetch failed for", address, "-", msg);
    return { error: msg };
  }
}

async function callNominatim(address: string): Promise<CallResult> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "0");
  const userAgent = asciiOnly(
    process.env.GEOCODING_USER_AGENT ?? DEFAULT_USER_AGENT
  );
  try {
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json",
      },
      // Nominatim is rate-limited at 1 req/s; don't let Next cache the call.
      cache: "no-store",
    });
    if (!res.ok) {
      return { error: `Nominatim ${res.status}` };
    }
    const body = (await res.json()) as Array<{
      lat?: string;
      lon?: string;
    }>;
    if (!Array.isArray(body) || body.length === 0) {
      return { error: "No match" };
    }
    const lat = Number(body[0].lat);
    const lng = Number(body[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: "Invalid response" };
    }
    return { lat, lng };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[geocoding] Nominatim fetch failed for", address, "-", msg);
    return { error: msg };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Geocode every address, preferring the cache. Uncached addresses are
 * resolved via the active provider (Google if a key is set, else Nominatim)
 * and then written to the cache. Capped at `maxNewGeocodes` so a single
 * request never blocks indefinitely.
 */
export async function geocodeAddresses(
  addresses: string[],
  options: { maxNewGeocodes?: number; retryCachedErrors?: boolean } = {}
): Promise<GeocodeBatchResult> {
  const provider = getActiveGeocodeProvider();
  // Google is fast enough that we can burn through hundreds of addresses in
  // one call; Nominatim's throttle means we have to trickle them. Defaults
  // reflect those realities so callers rarely have to override.
  const defaultBudget = provider === "google" ? 500 : 25;
  const maxNewGeocodes = Math.max(
    0,
    options.maxNewGeocodes ?? defaultBudget
  );
  // When retry is on, rows previously cached with an error are treated as
  // uncached so a caller (e.g. the "Geocode pending" button) can heal a
  // poisoned cache without needing to clear rows by hand.
  const retryCachedErrors = options.retryCachedErrors ?? false;
  const results = new Map<string, GeocodeResult>();
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];

  const sql = getDb();
  if (!sql) {
    for (const addr of unique) {
      results.set(addr, {
        address: addr,
        lat: null,
        lng: null,
        error: "DATABASE_URL not configured (geocode cache unavailable)",
        source: "skipped",
      });
    }
    return {
      results,
      newlyGeocoded: 0,
      skipped: unique.length,
      fromCache: 0,
      provider,
    };
  }

  await sql`
    CREATE TABLE IF NOT EXISTS geocode_cache (
      address_key TEXT PRIMARY KEY,
      address_raw TEXT NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      error TEXT,
      geocoded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Scrub rows poisoned by known systemic bugs (the original bad em-dash
  // User-Agent produced `TypeError: Invalid character in header content` /
  // `Cannot convert ... ByteString ... greater than 255`). Deleting them
  // demotes the addresses back to "pending" so they'll retry normally.
  await sql`
    DELETE FROM geocode_cache
    WHERE error IS NOT NULL
      AND (
        error ILIKE '%ByteString%'
        OR error ILIKE '%greater than 255%'
        OR error ILIKE '%Invalid character in header%'
      )
  `;

  const keys = unique.map(normalizeAddress);
  const cachedRows = (keys.length === 0
    ? []
    : ((await sql`
        SELECT address_key, lat, lng, error
        FROM geocode_cache
        WHERE address_key = ANY(${keys})
      `) as Array<{
        address_key: string;
        lat: number | null;
        lng: number | null;
        error: string | null;
      }>));
  const cached = new Map<
    string,
    { lat: number | null; lng: number | null; error: string | null }
  >();
  for (const row of cachedRows) {
    cached.set(row.address_key, {
      lat: row.lat,
      lng: row.lng,
      error: row.error,
    });
  }

  const toGeocode: string[] = [];
  let fromCache = 0;
  for (const addr of unique) {
    const key = normalizeAddress(addr);
    const hit = cached.get(key);
    const isPoisoned =
      hit != null && hit.error != null && (hit.lat == null || hit.lng == null);
    if (hit && !(retryCachedErrors && isPoisoned)) {
      fromCache += 1;
      results.set(addr, {
        address: addr,
        lat: hit.lat,
        lng: hit.lng,
        error: hit.error,
        source: "cache",
      });
    } else {
      toGeocode.push(addr);
    }
  }

  // Respect the budget: anything beyond `maxNewGeocodes` is reported as
  // "skipped" and will be picked up on a follow-up call.
  const toProcess = toGeocode.slice(0, maxNewGeocodes);
  const toSkip = toGeocode.slice(maxNewGeocodes);
  for (const addr of toSkip) {
    results.set(addr, {
      address: addr,
      lat: null,
      lng: null,
      error: "Geocoding queued (refresh to fetch more)",
      source: "skipped",
    });
  }

  let newlyGeocoded = 0;

  if (provider === "google") {
    const apiKey = process.env.GOOGLE_GEOCODING_API_KEY as string;
    // Chunk the list into concurrent batches so we stay under Google's rate
    // limits while still getting the fan-out benefit.
    for (let i = 0; i < toProcess.length; i += GOOGLE_CONCURRENCY) {
      const chunk = toProcess.slice(i, i + GOOGLE_CONCURRENCY);
      // Resolve the whole chunk in parallel, then write to the cache inside
      // the same callbacks — the `sql` closure stays correctly typed this way.
      await Promise.all(
        chunk.map(async (addr) => {
          const resp = await callGoogle(addr, apiKey);
          const key = normalizeAddress(addr);
          const lat = "error" in resp ? null : resp.lat;
          const lng = "error" in resp ? null : resp.lng;
          const error = "error" in resp ? resp.error : null;
          await sql`
            INSERT INTO geocode_cache (address_key, address_raw, lat, lng, error, geocoded_at)
            VALUES (${key}, ${addr}, ${lat}, ${lng}, ${error}, NOW())
            ON CONFLICT (address_key) DO UPDATE SET
              address_raw = EXCLUDED.address_raw,
              lat = EXCLUDED.lat,
              lng = EXCLUDED.lng,
              error = EXCLUDED.error,
              geocoded_at = NOW()
          `;
          results.set(addr, {
            address: addr,
            lat,
            lng,
            error,
            source: "google",
          });
        })
      );
      newlyGeocoded += chunk.length;
    }
  } else {
    // Nominatim: one at a time with a 1.1s spacer to respect the policy.
    for (const addr of toProcess) {
      const resp = await callNominatim(addr);
      const key = normalizeAddress(addr);
      const lat = "error" in resp ? null : resp.lat;
      const lng = "error" in resp ? null : resp.lng;
      const error = "error" in resp ? resp.error : null;
      await sql`
        INSERT INTO geocode_cache (address_key, address_raw, lat, lng, error, geocoded_at)
        VALUES (${key}, ${addr}, ${lat}, ${lng}, ${error}, NOW())
        ON CONFLICT (address_key) DO UPDATE SET
          address_raw = EXCLUDED.address_raw,
          lat = EXCLUDED.lat,
          lng = EXCLUDED.lng,
          error = EXCLUDED.error,
          geocoded_at = NOW()
      `;
      results.set(addr, {
        address: addr,
        lat,
        lng,
        error,
        source: "nominatim",
      });
      newlyGeocoded += 1;
      await sleep(1100);
    }
  }

  return {
    results,
    newlyGeocoded,
    skipped: toSkip.length,
    fromCache,
    provider,
  };
}
