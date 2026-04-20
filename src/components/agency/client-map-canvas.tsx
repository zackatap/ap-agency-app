"use client";

/**
 * The actual Leaflet map. Lives in its own file so it can be dynamically
 * imported with `ssr: false` from `client-map.tsx` — Leaflet hard-requires
 * `window` on import and will crash during Next.js server rendering otherwise.
 */
import "leaflet/dist/leaflet.css";

import { useEffect, useMemo, useRef } from "react";
import {
  Circle,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import type { ClientMapPin } from "@/app/api/agency/client-locations/route";

/** 1 statute mile in meters — Leaflet's Circle takes radius in meters. */
const METERS_PER_MILE = 1609.344;

export interface ProspectPin {
  label: string;
  address: string;
  lat: number;
  lng: number;
  radiusMiles: number;
}

/** Status → ring color. Unknown statuses get the neutral fallback. */
function statusColor(status: string): string {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "#34d399"; // emerald-400
  if (s === "2ND CMPN" || s === "2ND CAMPAIGN") return "#818cf8"; // indigo-400
  if (s === "PAUSED" || s === "PAUSE") return "#fbbf24"; // amber-400
  if (s === "CHURNED" || s === "CANCELLED" || s === "CANCELED") {
    return "#f87171"; // rose-400
  }
  if (s === "PROSPECT" || s === "TRIAL" || s === "ONBOARDING") {
    return "#38bdf8"; // sky-400
  }
  return "#94a3b8"; // slate-400
}

/** Build a tiny colored-dot Leaflet icon without relying on bundled asset
 *  files. Keeps everything inline / CSS-defined so Next's bundler never has
 *  to resolve the default marker PNGs. */
function buildPinIcon(status: string): L.DivIcon {
  const color = statusColor(status);
  const html = `
    <div style="
      position: relative;
      width: 22px;
      height: 22px;
      border-radius: 9999px;
      background: ${color};
      box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.85), 0 2px 6px rgba(0,0,0,0.35);
      border: 2px solid rgba(255,255,255,0.9);
    "></div>`;
  return L.divIcon({
    html,
    className: "ap-client-pin",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -12],
  });
}

/** Distinct pulsing marker for the prospective-client search pin so it
 *  reads clearly against the existing status dots. */
function buildProspectIcon(): L.DivIcon {
  const html = `
    <div style="
      position: relative;
      width: 28px;
      height: 28px;
      border-radius: 9999px;
      background: rgba(250, 204, 21, 0.25);
      border: 2px solid #facc15;
      box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.85), 0 0 14px rgba(250,204,21,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
    ">
      <div style="
        width: 10px;
        height: 10px;
        border-radius: 9999px;
        background: #facc15;
      "></div>
    </div>`;
  return L.divIcon({
    html,
    className: "ap-prospect-pin",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

interface Props {
  pins: ClientMapPin[];
  /** When true, render each pin's service-area radius as a translucent circle. */
  showCoverage?: boolean;
  /** Optional prospective-client pin to display alongside the clients. */
  prospect?: ProspectPin | null;
}

/** Auto-fit the map bounds to all visible pins, but only ONCE — on the
 *  first render where pins are available. After that the user is in charge
 *  of pan/zoom; filtering the status list shouldn't jerk the viewport
 *  around. Prospect lookups get their own focus via `FocusProspect`. */
function FitBounds({
  pins,
  prospect,
}: {
  pins: ClientMapPin[];
  prospect?: ProspectPin | null;
}) {
  const map = useMap();
  const hasFitRef = useRef<boolean>(false);

  useEffect(() => {
    if (hasFitRef.current) return;
    const coords = pins
      .filter((p): p is ClientMapPin & { lat: number; lng: number } =>
        p.lat != null && p.lng != null
      )
      .map((p) => [p.lat, p.lng] as [number, number]);
    if (prospect) coords.push([prospect.lat, prospect.lng]);
    if (coords.length === 0) return;

    hasFitRef.current = true;
    if (coords.length === 1) {
      map.setView(coords[0], 9, { animate: true });
      return;
    }
    const bounds = L.latLngBounds(coords);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
  }, [pins, prospect, map]);

  return null;
}

/** When a prospect is newly set, pan/zoom to it specifically so the user's
 *  latest search is the focus of the view (FitBounds' "shape" heuristic won't
 *  re-trigger if only the prospect pin changes while clients stay stable). */
function FocusProspect({ prospect }: { prospect?: ProspectPin | null }) {
  const map = useMap();
  const key = prospect
    ? `${prospect.lat.toFixed(5)},${prospect.lng.toFixed(5)}:${prospect.radiusMiles}`
    : "";
  useEffect(() => {
    if (!prospect) return;
    // `L.circle(...).getBounds()` only works once the circle is attached to
    // a map (it needs the map's projection to convert meters → lat/lng). We
    // compute the bounding box directly from the lat/lng instead so this
    // runs safely before the circle mounts. `toBounds` takes the total edge
    // size in meters, so we pass the diameter (2 × radius).
    const radiusMeters = prospect.radiusMiles * METERS_PER_MILE;
    const bounds = L.latLng(prospect.lat, prospect.lng).toBounds(
      radiusMeters * 2
    );
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

export function ClientMapCanvas({ pins, showCoverage, prospect }: Props) {
  const plottable = useMemo(
    () =>
      pins.filter(
        (p): p is ClientMapPin & { lat: number; lng: number } =>
          p.lat != null && p.lng != null
      ),
    [pins]
  );

  return (
    <MapContainer
      // Default view — a wide US/CA shot. FitBounds immediately zooms in once
      // we have real coords, so this is only visible for a split second.
      center={[39.8283, -98.5795]}
      zoom={4}
      scrollWheelZoom
      style={{ height: "100%", width: "100%", background: "#0f172a" }}
    >
      <TileLayer
        // CartoDB Dark Matter — free, dark, fits the dashboard's palette. No
        // API key required, only attribution.
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains={["a", "b", "c", "d"]}
      />
      <FitBounds pins={plottable} prospect={prospect ?? null} />
      <FocusProspect prospect={prospect ?? null} />
      {showCoverage &&
        plottable.map((pin) => {
          const color = statusColor(pin.status);
          return (
            <Circle
              key={`coverage-${pin.clientKey}`}
              center={[pin.lat, pin.lng]}
              radius={pin.radiusMiles * METERS_PER_MILE}
              pathOptions={{
                color,
                weight: 1,
                opacity: 0.55,
                fillColor: color,
                fillOpacity: 0.08,
              }}
              // Markers need to stay clickable; circles should never hijack
              // clicks for what's underneath them.
              interactive={false}
            />
          );
        })}
      {prospect && (
        <Circle
          center={[prospect.lat, prospect.lng]}
          radius={prospect.radiusMiles * METERS_PER_MILE}
          pathOptions={{
            color: "#facc15",
            weight: 2,
            opacity: 0.9,
            fillColor: "#facc15",
            fillOpacity: 0.1,
            dashArray: "6 6",
          }}
          interactive={false}
        />
      )}
      {plottable.map((pin) => (
        <Marker
          key={pin.clientKey}
          position={[pin.lat, pin.lng]}
          icon={buildPinIcon(pin.status)}
        >
          <Popup>
            <div style={{ minWidth: 180 }}>
              <div style={{ fontWeight: 600, color: "#0f172a" }}>
                {pin.businessName ?? "(No business name)"}
              </div>
              {pin.ownerName && (
                <div style={{ color: "#334155", fontSize: 12 }}>
                  {pin.ownerName}
                </div>
              )}
              <div style={{ marginTop: 6 }}>
                <span
                  style={{
                    display: "inline-block",
                    padding: "2px 8px",
                    borderRadius: 9999,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#0f172a",
                    background: statusColor(pin.status),
                  }}
                >
                  {pin.status}
                </span>
                {pin.allStatuses.length > 1 && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 11,
                      color: "#475569",
                    }}
                  >
                    +{pin.allStatuses.length - 1} more
                  </span>
                )}
              </div>
              {pin.pipelines.length > 0 && (
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "#475569",
                  }}
                >
                  {pin.pipelines.length === 1 ? "Pipeline: " : "Pipelines: "}
                  <strong style={{ color: "#0f172a" }}>
                    {pin.pipelines.join(", ")}
                  </strong>
                </div>
              )}
              {pin.packages.length > 0 && (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: "#475569",
                  }}
                >
                  {pin.packages.length === 1 ? "Package: " : "Packages: "}
                  <strong style={{ color: "#0f172a" }}>
                    {pin.packages.join(", ")}
                  </strong>
                </div>
              )}
              {pin.address && (
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "#475569",
                  }}
                >
                  {pin.address}
                </div>
              )}
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: "#475569",
                }}
              >
                Radius: <strong>{pin.radiusMiles} mi</strong>
                {!pin.radiusFromSheet && (
                  <span style={{ color: "#94a3b8" }}> (default)</span>
                )}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
      {prospect && (
        <Marker
          position={[prospect.lat, prospect.lng]}
          icon={buildProspectIcon()}
          // Keep the prospect pin above the client dots so it doesn't get
          // visually buried in a dense metro cluster.
          zIndexOffset={1000}
        >
          <Popup>
            <div style={{ minWidth: 180 }}>
              <div
                style={{
                  fontWeight: 600,
                  color: "#0f172a",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: 9999,
                    background: "#facc15",
                  }}
                />
                Prospective client
              </div>
              <div style={{ color: "#334155", fontSize: 12, marginTop: 2 }}>
                {prospect.label}
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: "#475569",
                }}
              >
                {prospect.address}
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: "#475569",
                }}
              >
                Radius: <strong>{prospect.radiusMiles} mi</strong>
              </div>
            </div>
          </Popup>
        </Marker>
      )}
    </MapContainer>
  );
}
