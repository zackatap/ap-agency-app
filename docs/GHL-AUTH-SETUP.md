# GHL OAuth Setup (Agency Bulk + Sub-account)

This app uses the **GHL Marketplace App Distribution Model** — both agency-bulk
installation and per-sub-account installation work out of the box.

Architecture:
- **Agency install (recommended)**: one consent screen at the agency → token
  for the whole company → we mint per-sub-account Location tokens on demand
  via `POST /oauth/locationToken`. Covers all 655+ sub-accounts, current and
  future.
- **Sub-account install (legacy)**: a single sub-account admin installs the
  app just for their location. The OAuth callback stores a Location token
  directly, no exchange needed.

The OAuth callback auto-detects which case we're in based on the `userType`
returned by GHL's token endpoint.

## GHL Marketplace App Configuration

In [Developer Marketplace](https://marketplace.gohighlevel.com/) → your app →
**Advanced Settings → Auth**:

1. **Target User**: `Sub-account`
2. **Who can install**: `Agency & Sub-account` (max reach)
3. **Can this app be bulk-installed by agencies**: `Yes`
4. **Redirect URL**: `https://<your-domain>/api/auth/callback/ghl`
5. **Webhook URL** (Advanced Settings → Webhooks):
   `https://<your-domain>/api/webhooks/ghl` — subscribe to `INSTALL` and
   `UNINSTALL` events.
6. **Scopes** (minimum for dashboard features + bulk token exchange):
   - `opportunities.readonly`
   - `contacts.readonly`
   - `workflows.readonly`
   - `funnels/funnel.readonly`
   - `oauth.readonly`
   - `oauth.write`   ← required to mint location tokens from an agency token

## Custom Menu Link (required)

Each sub-account needs the app embedded as a GHL Custom Menu item:
- **Type**: Embedded Page (iFrame)
- **URL**: `https://<your-domain>/v2/location/{{location.id}}/dashboard`

GHL replaces `{{location.id}}` with the current location when the user opens
the menu item.

## Environment Variables

```env
GHL_CLIENT_ID=your-client-id
GHL_CLIENT_SECRET=your-client-secret
GHL_REDIRECT_URI=https://<your-domain>/api/auth/callback/ghl

# (Optional) Override the OAuth entry point.
# Default: https://marketplace.leadconnectorhq.com/oauth/chooselocation
# Use marketplace.gohighlevel.com only if your app is a non-whitelabel public app.
# Leave blank for white-label agencies (like app.automatedpractice.com).
# GHL_OAUTH_BASE=https://marketplace.leadconnectorhq.com/oauth/chooselocation

# (Optional) Skip webhook signature verification — DEV ONLY.
# GHL_WEBHOOK_SKIP_SIGNATURE=1
```

## Why the white-label URL matters

GHL hosts `chooselocation` on two domains:

| Host | Use case |
| --- | --- |
| `marketplace.gohighlevel.com` | Non-whitelabel public apps / vanilla gohighlevel.com users |
| `marketplace.leadconnectorhq.com` | **Whitelabel agencies** (cookie domain matches `leadconnectorhq.com`) |

If a whitelabel agency user is sent to `marketplace.gohighlevel.com`, their
session cookie isn't readable on that host and they see "Please login to
HighLevel to continue" even though they're logged in. The Login button then
opens `app.gohighlevel.com` (another foreign cookie domain), which is why
you'd end up bouncing between tabs/install-screens. We default to the
leadconnectorhq.com URL so WL and non-WL users both work.

## Full OAuth Flow

### Agency install path

1. Agency admin opens the app's marketplace listing (or clicks Connect from
   the dashboard).
2. Browser goes to `marketplace.leadconnectorhq.com/oauth/chooselocation`.
3. Admin picks their agency at the Select Account screen → grants scopes.
4. GHL redirects to `/api/auth/callback/ghl?code=...&state=...`.
5. Callback exchanges the code with `user_type=Company`. Response contains
   `userType: "Company"`, `isBulkInstallation: true`, `companyId`.
6. Agency token stored in `ghl_agency_tokens` keyed by `company_id`.
7. On first dashboard open for any sub-account: `getToken(locationId)` finds
   no cached location token, tries the agency token,
   `POST /oauth/locationToken` succeeds, we cache the minted token in
   `ghl_oauth_tokens` keyed by `location_id`.
8. `INSTALL` webhook (per location, fires during bulk install) lets us
   pre-warm location tokens so step 7 is free.

### Sub-account install path

1. Sub-account admin opens the app (marketplace or custom menu Connect).
2. Same OAuth entry point; picks their specific location.
3. GHL returns a code for `userType: Location`. Our callback tries Company
   first (fails), then Location (succeeds).
4. Location token stored directly. No exchange needed.

### Token refresh

Access tokens: ~24h. Refresh tokens: 1 year (or until used). `getToken()` /
`getAgencyToken()` auto-refresh when `expires_at` is within 1 hour.

### Uninstall

`UNINSTALL` webhooks fire per Location (and per Company). We delete cached
tokens in response so the next dashboard load correctly shows the Install
CTA again.

## Iframe Considerations

The dashboard runs inside a GHL iframe. OAuth must happen in the top window —
the Install link uses `target="_top"` to break out. After install, GHL
redirects the main window to `/v2/location/{id}/dashboard?connected=1`.

## Debug Tips

- `GET /api/debug/...` routes exist for token/pipeline diagnostics.
- Check `ghl_agency_tokens` and `ghl_oauth_tokens` rows in Postgres to see
  what's cached.
- `[oauth-callback]`, `[oauth-tokens]`, `[ghl-webhook]` log prefixes tag
  everything in Vercel logs.

## References

- [OAuth 2.0 Overview](https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0)
- [App Distribution Model](https://marketplace.gohighlevel.com/docs/oauth/AppDistribution)
- [Target User: Sub-Account](https://marketplace.gohighlevel.com/docs/Authorization/TargetUserSubAccount)
- [Get Access Token](https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token)
- [Get Location Token from Agency Token](https://marketplace.gohighlevel.com/docs/ghl/oauth/get-location-access-token)
- [Webhook Integration Guide](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide)
- [User Context / Shared Secret](https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps)
