"use client";

/**
 * Client-location map tab. Loads the list from /api/agency/client-locations,
 * lets the user filter by status, and hands the filtered pins to a
 * dynamically-imported Leaflet canvas (Leaflet cannot render during SSR).
 */
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type {
  ClientMapPin,
  ClientMapResponse,
} from "@/app/api/agency/client-locations/route";
import type { ProspectLookupResponse } from "@/app/api/agency/client-locations/lookup/route";
import type { ProspectPin } from "./client-map-canvas";

const ClientMapCanvas = dynamic(
  () => import("./client-map-canvas").then((m) => m.ClientMapCanvas),
  { ssr: false, loading: () => <MapSkeleton label="Loading map…" /> }
);

/** Great-circle distance between two lat/lng points, in miles. */
function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const EARTH_R_MILES = 3958.7613;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_MILES * Math.asin(Math.sqrt(h));
}

function MapSkeleton({ label }: { label: string }) {
  return (
    <div className="flex h-[560px] w-full items-center justify-center rounded-2xl border border-white/10 bg-slate-950/40 text-sm text-slate-400">
      {label}
    </div>
  );
}

/** Shape of the prefs we persist to localStorage so a reload restores the
 *  user's filter selection and coverage toggle. Keep this small and boring;
 *  anything map-viewport / prospect-related is intentionally NOT persisted. */
interface MapPrefs {
  statuses: string[];
  showCoverage: boolean;
}

const PREFS_STORAGE_KEY = "ap-agency:client-map-prefs:v1";

function readPrefs(): MapPrefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MapPrefs>;
    return {
      statuses: Array.isArray(parsed.statuses)
        ? parsed.statuses.filter((s): s is string => typeof s === "string")
        : [],
      showCoverage:
        typeof parsed.showCoverage === "boolean" ? parsed.showCoverage : true,
    };
  } catch {
    return null;
  }
}

function writePrefs(prefs: MapPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode / quota errors are non-fatal; the map still works.
  }
}

/** Preset filter selections surfaced as quick-access buttons. Values are
 *  compared case-insensitively against the status strings from the sheet. */
const STATUS_PRESETS: Array<{ label: string; statuses: string[] }> = [
  { label: "Only Active", statuses: ["ACTIVE"] },
  { label: "Active / Paused", statuses: ["ACTIVE", "PAUSED"] },
];

function statusSwatchColor(status: string): string {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "bg-emerald-400";
  if (s === "2ND CMPN" || s === "2ND CAMPAIGN") return "bg-indigo-400";
  if (s === "PAUSED" || s === "PAUSE") return "bg-amber-400";
  if (s === "CHURNED" || s === "CANCELLED" || s === "CANCELED") {
    return "bg-rose-400";
  }
  if (s === "PROSPECT" || s === "TRIAL" || s === "ONBOARDING") {
    return "bg-sky-400";
  }
  return "bg-slate-400";
}

export function ClientMap() {
  const [data, setData] = useState<ClientMapResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(
    new Set()
  );
  const [isGeocoding, setIsGeocoding] = useState<boolean>(false);
  const [showCoverage, setShowCoverage] = useState<boolean>(true);
  // `prefsLoaded` gates the "write prefs" effect so we don't clobber the
  // stored values with the initial React defaults before we've had a chance
  // to read them on mount.
  const [prefsLoaded, setPrefsLoaded] = useState<boolean>(false);

  // Prospective-client search state.
  const [prospectInput, setProspectInput] = useState<string>("");
  const [prospectRadiusInput, setProspectRadiusInput] = useState<string>("10");
  const [prospectLabelInput, setProspectLabelInput] = useState<string>("");
  const [prospect, setProspect] = useState<ProspectPin | null>(null);
  const [prospectError, setProspectError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState<boolean>(false);

  const load = async (opts: { maxNewGeocodes?: number; retryErrors?: boolean } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(
        "/api/agency/client-locations",
        window.location.origin
      );
      if (opts.maxNewGeocodes != null) {
        url.searchParams.set("maxNewGeocodes", String(opts.maxNewGeocodes));
      }
      if (opts.retryErrors) {
        url.searchParams.set("retryErrors", "1");
      }
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      const body = (await res.json()) as ClientMapResponse;
      setData(body);
      // If the user has no active selection yet (first load, no saved prefs),
      // default to "everything". An empty saved selection is treated the
      // same way so the user never lands on a blank map.
      if (body.statuses.length > 0) {
        setSelectedStatuses((prev) => {
          if (prev.size > 0) return prev;
          return new Set(body.statuses.map((s) => s.toUpperCase()));
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Hydrate prefs from localStorage on mount. Has to run in an effect
  // (not lazy-init state) because `window` isn't available during the
  // server render of this client component.
  useEffect(() => {
    const prefs = readPrefs();
    if (prefs) {
      if (prefs.statuses.length > 0) {
        setSelectedStatuses(new Set(prefs.statuses.map((s) => s.toUpperCase())));
      }
      setShowCoverage(prefs.showCoverage);
    }
    setPrefsLoaded(true);
  }, []);

  // Persist prefs any time the user changes them, but skip until after the
  // initial hydrate so we don't overwrite saved values with defaults.
  useEffect(() => {
    if (!prefsLoaded) return;
    writePrefs({
      statuses: [...selectedStatuses],
      showCoverage,
    });
  }, [selectedStatuses, showCoverage, prefsLoaded]);

  // Memoize the derived slices off `data` directly so the useMemo dep arrays
  // don't see a brand-new `[]` every render.
  const clients = useMemo<ClientMapPin[]>(
    () => data?.clients ?? [],
    [data]
  );
  const statuses = useMemo<string[]>(() => data?.statuses ?? [], [data]);

  const filtered = useMemo<ClientMapPin[]>(() => {
    if (selectedStatuses.size === 0) return clients;
    return clients.filter((c) => selectedStatuses.has(c.status.toUpperCase()));
  }, [clients, selectedStatuses]);

  const plotted = useMemo(
    () => filtered.filter((c) => c.lat != null && c.lng != null),
    [filtered]
  );

  const countsByStatus = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of clients) {
      const key = c.status.toUpperCase();
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [clients]);

  const toggleStatus = (status: string) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      const key = status.toUpperCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () =>
    setSelectedStatuses(new Set(statuses.map((s) => s.toUpperCase())));
  const clearAll = () => setSelectedStatuses(new Set());

  /** Apply a preset, intersecting its desired set with the statuses actually
   *  present in the response so a preset referring to a status the sheet
   *  doesn't have doesn't end up selecting "nothing". If none of the preset's
   *  statuses exist in the data, fall back to the raw preset list so the
   *  user still sees their intent reflected. */
  const applyPreset = (presetStatuses: string[]) => {
    const available = new Set(statuses.map((s) => s.toUpperCase()));
    const intersection = presetStatuses
      .map((s) => s.toUpperCase())
      .filter((s) => available.has(s));
    setSelectedStatuses(
      new Set(intersection.length > 0 ? intersection : presetStatuses.map((s) => s.toUpperCase()))
    );
  };

  const handleBackfill = async () => {
    setIsGeocoding(true);
    try {
      // Let the server pick its provider-appropriate default budget (500 for
      // Google, 25 for Nominatim). Always retry cached errors so one click
      // heals anything a previous bad call may have poisoned.
      await load({ retryErrors: true });
    } finally {
      setIsGeocoding(false);
    }
  };

  const handleProspectLookup = async () => {
    const address = prospectInput.trim();
    if (!address) {
      setProspectError("Enter an address to look up.");
      return;
    }
    const radiusNum = Number(prospectRadiusInput);
    const radiusMiles =
      Number.isFinite(radiusNum) && radiusNum > 0 ? radiusNum : 10;
    setIsLookingUp(true);
    setProspectError(null);
    try {
      const res = await fetch("/api/agency/client-locations/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
        cache: "no-store",
      });
      const body = (await res.json()) as ProspectLookupResponse;
      if (!res.ok || body.error || body.lat == null || body.lng == null) {
        setProspect(null);
        setProspectError(body.error ?? `Lookup failed (${res.status})`);
        return;
      }
      setProspect({
        label: prospectLabelInput.trim() || "Prospective client",
        address: body.address,
        lat: body.lat,
        lng: body.lng,
        radiusMiles,
      });
    } catch (err) {
      setProspect(null);
      setProspectError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLookingUp(false);
    }
  };

  const clearProspect = () => {
    setProspect(null);
    setProspectError(null);
    setProspectInput("");
    setProspectLabelInput("");
  };

  /** Clients that fall inside the prospect's service-area circle. Sorted by
   *  distance so the agency can see the closest overlap first. */
  const nearbyClients = useMemo(() => {
    if (!prospect) return [] as Array<{ pin: ClientMapPin; distance: number }>;
    const plotted = filtered.filter(
      (c): c is ClientMapPin & { lat: number; lng: number } =>
        c.lat != null && c.lng != null
    );
    return plotted
      .map((pin) => ({
        pin,
        distance: haversineMiles(
          { lat: prospect.lat, lng: prospect.lng },
          { lat: pin.lat, lng: pin.lng }
        ),
      }))
      .filter((r) => r.distance <= prospect.radiusMiles)
      .sort((a, b) => a.distance - b.distance);
  }, [prospect, filtered]);

  const handleClearErrors = async () => {
    if (
      !confirm(
        "Delete every cached geocoding error? They'll be retried next time the map loads."
      )
    ) {
      return;
    }
    setIsGeocoding(true);
    try {
      await fetch("/api/agency/client-locations/clear-errors", {
        method: "POST",
        cache: "no-store",
      });
      await load();
    } finally {
      setIsGeocoding(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/40 p-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">
            Client map
          </div>
          <div className="mt-1 text-lg font-semibold text-white">
            {data ? (
              <>
                {plotted.length} of {filtered.length} shown
              </>
            ) : loading ? (
              "Loading clients…"
            ) : (
              "—"
            )}
          </div>
          {data && (
            <div className="mt-1 text-xs text-slate-400">
              {data.stats.withCoords} geocoded ·{" "}
              {data.stats.missingAddress} missing address ·{" "}
              {data.stats.geocodeErrors} geocode errors
              {data.stats.pendingGeocode > 0 && (
                <>
                  {" · "}
                  <span className="text-amber-300">
                    {data.stats.pendingGeocode} pending
                  </span>
                </>
              )}
              {data.stats.newlyGeocoded > 0 && (
                <>
                  {" · "}
                  <span className="text-emerald-300">
                    {data.stats.newlyGeocoded} newly geocoded
                  </span>
                </>
              )}
              <span className="ml-2 rounded-full border border-white/10 bg-slate-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">
                {data.stats.provider === "google"
                  ? "Google Geocoding"
                  : "OSM Nominatim"}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg border border-white/10 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          {data &&
            (data.stats.pendingGeocode > 0 || data.stats.geocodeErrors > 0) && (
              <button
                type="button"
                onClick={handleBackfill}
                disabled={isGeocoding}
                className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                title={
                  data.stats.provider === "google"
                    ? "Geocode everything pending + retry failed addresses (Google, ~10s for a few hundred)"
                    : "Geocode pending + retry failed addresses (Nominatim throttles to 1 req/s, so this can take a few minutes)"
                }
              >
                {isGeocoding
                  ? data.stats.provider === "google"
                    ? "Geocoding…"
                    : "Geocoding… (up to ~2 min)"
                  : `Geocode / retry (${
                      data.stats.pendingGeocode + data.stats.geocodeErrors
                    })`}
              </button>
            )}
          {data && data.stats.geocodeErrors > 0 && (
            <button
              type="button"
              onClick={handleClearErrors}
              disabled={isGeocoding}
              className="rounded-lg border border-rose-400/30 bg-rose-500/5 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/15 disabled:opacity-50"
              title="Delete cached geocoding errors so they retry on the next load"
            >
              Clear cached errors ({data.stats.geocodeErrors})
            </button>
          )}
        </div>
      </div>

      {data?.addressConfigError && (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          {data.addressConfigError}
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-rose-400/40 bg-rose-500/10 p-4 text-sm text-rose-100">
          Could not load clients: {error}
        </div>
      )}

      <section className="grid grid-cols-1 gap-3 rounded-2xl border border-white/10 bg-slate-900/30 p-4 lg:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Prospective client lookup
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto_auto_auto] md:items-end">
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-slate-500">
              Business name
              <input
                type="text"
                value={prospectLabelInput}
                onChange={(e) => setProspectLabelInput(e.target.value)}
                placeholder="Optional label for the pin"
                className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-400/60 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-slate-500">
              Address
              <input
                type="text"
                value={prospectInput}
                onChange={(e) => setProspectInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleProspectLookup();
                  }
                }}
                placeholder="123 Main St, Springfield, IL"
                className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-400/60 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-slate-500">
              Radius (mi)
              <input
                type="number"
                min={1}
                max={500}
                step={1}
                value={prospectRadiusInput}
                onChange={(e) => setProspectRadiusInput(e.target.value)}
                className="w-24 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 focus:border-amber-400/60 focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleProspectLookup()}
              disabled={isLookingUp}
              className="rounded-lg border border-amber-400/40 bg-amber-500/20 px-4 py-2 text-sm font-medium text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
            >
              {isLookingUp ? "Looking up…" : "Look up"}
            </button>
            {prospect && (
              <button
                type="button"
                onClick={clearProspect}
                className="rounded-lg border border-white/10 bg-slate-800/60 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                Clear
              </button>
            )}
          </div>
          {prospectError && (
            <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
              {prospectError}
            </div>
          )}
          {prospect && (
            <div className="rounded-lg border border-amber-400/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-100">
              <span className="font-medium">{prospect.label}</span> — plotted
              at {prospect.lat.toFixed(4)}, {prospect.lng.toFixed(4)} with a{" "}
              {prospect.radiusMiles}mi radius.{" "}
              <span className="text-amber-200/80">
                {nearbyClients.length === 0
                  ? "No existing clients fall inside this radius."
                  : `${nearbyClients.length} existing client${
                      nearbyClients.length === 1 ? "" : "s"
                    } inside this radius.`}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-end justify-end">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-slate-800/50 px-3 py-2 text-xs text-slate-200">
            <input
              type="checkbox"
              checked={showCoverage}
              onChange={(e) => setShowCoverage(e.target.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
            Show coverage circles
          </label>
        </div>
      </section>

      {statuses.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-slate-900/30 p-3 text-xs">
          <span className="mr-1 font-semibold uppercase tracking-wide text-slate-400">
            Status
          </span>
          {statuses.map((status) => {
            const key = status.toUpperCase();
            const active = selectedStatuses.has(key);
            const count = countsByStatus.get(key) ?? 0;
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleStatus(status)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 transition-colors ${
                  active
                    ? "border-white/20 bg-slate-800 text-white"
                    : "border-white/5 bg-slate-900/60 text-slate-400 hover:text-slate-200"
                }`}
              >
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${statusSwatchColor(
                    status
                  )}`}
                />
                <span>{status}</span>
                <span className="text-slate-500">({count})</span>
              </button>
            );
          })}
          <span className="mx-2 h-5 w-px bg-white/10" />
          {STATUS_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset.statuses)}
              className="rounded-md border border-white/10 bg-slate-800/40 px-2 py-1 text-slate-300 hover:bg-slate-800 hover:text-white"
              title={`Show only ${preset.statuses.join(" + ")}`}
            >
              {preset.label}
            </button>
          ))}
          <span className="mx-2 h-5 w-px bg-white/10" />
          <button
            type="button"
            onClick={selectAll}
            className="rounded-md px-2 py-1 text-slate-300 hover:text-white"
          >
            All
          </button>
          <button
            type="button"
            onClick={clearAll}
            className="rounded-md px-2 py-1 text-slate-300 hover:text-white"
          >
            None
          </button>
        </div>
      )}

      <div className="h-[560px] overflow-hidden rounded-2xl border border-white/10">
        {loading && !data ? (
          <MapSkeleton label="Loading clients…" />
        ) : plotted.length === 0 && !prospect ? (
          <MapSkeleton
            label={
              clients.length === 0
                ? "No clients loaded yet."
                : filtered.length === 0
                  ? "No clients match the current status filter."
                  : "None of the filtered clients have been geocoded yet. Add a prospect lookup above to drop a pin regardless."
            }
          />
        ) : (
          <ClientMapCanvas
            pins={plotted}
            showCoverage={showCoverage}
            prospect={prospect}
          />
        )}
      </div>

      {prospect && nearbyClients.length > 0 && (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-500/5 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-200">
            Existing clients inside {prospect.radiusMiles}mi of{" "}
            {prospect.label}
          </div>
          <div className="mt-3 max-h-60 overflow-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-amber-200/70">
                <tr>
                  <th className="px-2 py-1">Distance</th>
                  <th className="px-2 py-1">Business</th>
                  <th className="px-2 py-1">Owner</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Radius</th>
                  <th className="px-2 py-1">Address</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-400/10 text-amber-50">
                {nearbyClients.map(({ pin, distance }) => (
                  <tr key={pin.clientKey}>
                    <td className="px-2 py-1 font-medium">
                      {distance.toFixed(1)} mi
                    </td>
                    <td className="px-2 py-1">
                      {pin.businessName ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-amber-100/80">
                      {pin.ownerName ?? "—"}
                    </td>
                    <td className="px-2 py-1">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${statusSwatchColor(
                            pin.status
                          )}`}
                        />
                        {pin.status}
                      </span>
                    </td>
                    <td className="px-2 py-1">{pin.radiusMiles} mi</td>
                    <td className="px-2 py-1 text-amber-100/70">
                      {pin.address ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <details className="rounded-2xl border border-white/10 bg-slate-900/30 p-4 text-xs text-slate-300">
          <summary className="cursor-pointer text-sm text-slate-200">
            Client list ({filtered.length})
          </summary>
          <div className="mt-3 max-h-80 overflow-auto">
            <table className="min-w-full text-left">
              <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-1">Business</th>
                  <th className="px-2 py-1">Owner</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Address</th>
                  <th className="px-2 py-1">Map</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filtered.map((c) => (
                  <tr key={c.clientKey}>
                    <td className="px-2 py-1 text-slate-100">
                      {c.businessName ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-slate-300">
                      {c.ownerName ?? "—"}
                    </td>
                    <td className="px-2 py-1">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${statusSwatchColor(
                            c.status
                          )}`}
                        />
                        {c.status}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-slate-400">
                      {c.address ?? (
                        <span className="text-amber-300">No address</span>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {c.lat != null && c.lng != null ? (
                        <span className="text-emerald-300">Plotted</span>
                      ) : c.geocodeError ? (
                        <span
                          className="text-amber-300"
                          title={c.geocodeError}
                        >
                          {c.geocodeError}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
