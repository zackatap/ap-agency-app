/**
 * GHL Marketplace webhook receiver.
 *
 * Subscribe in Marketplace → Advanced Settings → Webhooks to:
 *   - INSTALL     (fires per sub-account when your app becomes installed)
 *   - UNINSTALL   (fires when removed)
 *
 * INSTALL:  best-effort pre-warm the location's OAuth token so the first
 *           dashboard open is fast. Safe to skip — getToken() lazy-mints too.
 * UNINSTALL: drop any cached token(s) for that location/company so we don't
 *           serve stale data after revocation.
 *
 * Signature verification: GHL sends X-GHL-Signature (Ed25519, current) and
 * X-WH-Signature (RSA-SHA256, legacy, deprecating 2026-07-01). We verify both.
 *
 * Docs:
 *  - https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide
 *  - https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0 (App Install payload)
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  deleteToken,
  deleteAgencyToken,
  getAgencyToken,
  listAgencyTokens,
  setToken,
} from "@/lib/oauth-tokens";

const LEGACY_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

function verifyGhlEd25519(payload: string, signatureB64: string): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      GHL_ED25519_PUBLIC_KEY,
      Buffer.from(signatureB64, "base64")
    );
  } catch {
    return false;
  }
}

function verifyLegacyRsa(payload: string, signatureB64: string): boolean {
  try {
    const verifier = crypto.createVerify("SHA256");
    verifier.update(payload);
    return verifier.verify(LEGACY_RSA_PUBLIC_KEY, signatureB64, "base64");
  } catch {
    return false;
  }
}

interface GhlWebhookPayload {
  type?: string;
  webhookId?: string;
  installType?: "Location" | "Company" | string;
  locationId?: string;
  companyId?: string;
  appId?: string;
  timestamp?: string;
  isWhitelabelCompany?: boolean;
  [k: string]: unknown;
}

async function prewarmLocationToken(
  locationId: string,
  companyId: string | undefined
): Promise<void> {
  try {
    const agencies = companyId
      ? await getAgencyToken(companyId).then((t) => (t ? [t] : []))
      : await listAgencyTokens();
    for (const agency of agencies) {
      const res = await fetch(
        "https://services.leadconnectorhq.com/oauth/locationToken",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Bearer ${agency.access_token}`,
            Version: "2021-07-28",
          },
          body: new URLSearchParams({
            companyId: agency.companyId,
            locationId,
          }).toString(),
        }
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        locationId?: string;
        companyId?: string;
      };
      if (!data.access_token) continue;
      const expiresIn = data.expires_in ?? 86400;
      await setToken(locationId, {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? "",
        locationId: data.locationId ?? locationId,
        companyId: data.companyId ?? agency.companyId,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      });
      return;
    }
  } catch (err) {
    console.error("[ghl-webhook] prewarm failed", err);
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  const ghlSig = req.headers.get("x-ghl-signature");
  const legacySig = req.headers.get("x-wh-signature");

  const verified = ghlSig
    ? verifyGhlEd25519(raw, ghlSig)
    : legacySig
      ? verifyLegacyRsa(raw, legacySig)
      : false;

  // In development it's handy to bypass signature checks. Gate behind an env.
  const bypass = process.env.GHL_WEBHOOK_SKIP_SIGNATURE === "1";

  if (!verified && !bypass) {
    console.warn("[ghl-webhook] signature verification failed", {
      hasGhlSig: Boolean(ghlSig),
      hasLegacySig: Boolean(legacySig),
    });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let body: GhlWebhookPayload;
  try {
    body = JSON.parse(raw) as GhlWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { type, installType, locationId, companyId, webhookId } = body;

  console.info(
    "[ghl-webhook] received",
    JSON.stringify({
      type,
      installType,
      locationId,
      companyId,
      webhookId,
      verified,
    })
  );

  try {
    switch (type) {
      case "INSTALL": {
        if (installType === "Location" && locationId) {
          await prewarmLocationToken(locationId, companyId);
        }
        // Company-level INSTALL: nothing to pre-warm yet — locations trickle in
        // via per-location INSTALL events for bulk installs.
        break;
      }
      case "UNINSTALL": {
        if (installType === "Location" && locationId) {
          await deleteToken(locationId);
        } else if (installType === "Company" && companyId) {
          await deleteAgencyToken(companyId);
        }
        break;
      }
      default:
        // Ignore unsubscribed / unrelated events without erroring.
        break;
    }
  } catch (err) {
    console.error("[ghl-webhook] processing failed", err);
    // Always 200 so GHL doesn't endlessly retry on app bugs (they only retry 429).
  }

  return NextResponse.json({ ok: true });
}
