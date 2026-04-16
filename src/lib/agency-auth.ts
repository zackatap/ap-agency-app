/**
 * Password-based auth for the agency dashboard.
 *
 * - Password comes from `AGENCY_PASSWORD` env var (falls back to the shared
 *   default so the app works out of the box — rotate via env to override).
 * - Session = signed, httpOnly cookie `agency_session` with a 30-day expiry.
 * - Signature = HMAC-SHA256 using `AGENCY_SESSION_SECRET` (derived from
 *   AGENCY_PASSWORD if unset — changing the password invalidates old sessions).
 * - Everything here is edge-runtime safe (Web Crypto only) so the middleware
 *   can call `verifyAgencySessionCookie`.
 */

const DEFAULT_PASSWORD = "AP!zdp2026";
const COOKIE_NAME = "agency_session";
const SESSION_MAX_AGE_DAYS = 30;
const SESSION_MAX_AGE_SEC = SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

export const AGENCY_COOKIE_NAME = COOKIE_NAME;

function getPassword(): string {
  return process.env.AGENCY_PASSWORD?.trim() || DEFAULT_PASSWORD;
}

function getSecret(): string {
  const envSecret = process.env.AGENCY_SESSION_SECRET?.trim();
  if (envSecret) return envSecret;
  return `agency-session::${getPassword()}`;
}

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "="
  );
  const binary =
    typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64UrlEncode(sig);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function createAgencySessionCookie(): Promise<string> {
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC,
  };
  const body = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const sig = await hmacSha256(getSecret(), body);
  return `${body}.${sig}`;
}

export async function verifyAgencySessionCookie(
  value: string | undefined
): Promise<boolean> {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expected = await hmacSha256(getSecret(), body);
  if (!safeEqual(sig, expected)) return false;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(body))
    ) as { exp?: number };
    if (!payload.exp || payload.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export function isValidAgencyPassword(input: string): boolean {
  const password = getPassword();
  if (!input || input.length !== password.length) return false;
  return safeEqual(input, password);
}

export const AGENCY_COOKIE_ATTRS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_MAX_AGE_SEC,
  secure: process.env.NODE_ENV === "production",
};
