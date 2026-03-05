# GHL Single-Location OAuth Setup

This app uses **single-location (sub-account) OAuth 2.0** only. No agency/bulk installation.

## GHL Marketplace App Configuration

1. **Developer Marketplace** → Your App → **Advanced Settings** → **Auth**

2. **Target User**: Set to **Sub-Account** (required for single-location tokens)

3. **Who Can Install**: **Everyone** (sub-account users connect from your app; agency users see a message to open from sub-account)

4. **Redirect URL**: Add your callback URL, e.g.
   - Production: `https://your-app.vercel.app/api/auth/callback/ghl`
   - Local: `http://localhost:3000/api/auth/callback/ghl`

5. **Scopes** (minimum; no `locations.readonly` for single-location flow):
   - `opportunities.readonly`
   - `contacts.readonly`
   - `oauth.readonly`
   - `oauth.write`

6. **Client credentials**: Copy Client ID and Client Secret

## Custom Menu Link (Required)

The app expects to be opened from a **GHL Custom Menu** at the location level. Create a custom menu item with:

- **Type**: Embedded Page (iFrame)
- **URL**: `https://your-app.com/v2/location/{{location.id}}/dashboard`

GHL replaces `{{location.id}}` with the current location when the user opens the menu item. This gives the app the `locationId` needed for OAuth.

## Environment Variables

```env
GHL_CLIENT_ID=your-client-id
GHL_CLIENT_SECRET=your-client-secret
GHL_REDIRECT_URI=https://your-app.com/api/auth/callback/ghl
```

Optional:
```env
# Override auth URL (default: https://marketplace.gohighlevel.com/oauth/chooselocation)
GHL_OAUTH_BASE=https://marketplace.gohighlevel.com/oauth/chooselocation
```

## OAuth Flow (Single Location)

1. User opens the app from GHL custom menu → URL includes `{{location.id}}` → we have `locationId`
2. App checks for stored token → if none, shows "Connect to GoHighLevel"
3. User clicks Connect → redirects to `/api/auth/ghl/authorize?locationId=X`
4. Authorize route redirects to GHL chooselocation with `state` containing `locationId`
5. User authorizes on GHL → redirected to our callback with `code` and `state`
6. Callback exchanges `code` for access token using `user_type=Location` (sub-account only)
7. Token stored per location in Postgres → redirect to dashboard

## Iframe Considerations

The app runs inside a GHL iframe. OAuth must happen in the **top window**:

- Connect link uses `target="_top"` to break out of iframe
- User authorizes in the main window, callback redirects to dashboard
- User can return to GHL and open the custom menu again to see the app with token in iframe

## Token Refresh

Access tokens expire in ~24 hours. Refresh tokens are valid ~1 year. The app automatically refreshes when `getToken()` finds an expired token and a valid refresh token.

## References

- [GHL OAuth 2.0](https://marketplace.gohighlevel.com/docs/ghl/oauth/o-auth-2-0)
- [Target User Sub-Account](https://marketplace.gohighlevel.com/docs/Authorization/TargetUserSubAccount)
- [Get Access Token](https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token)
- [User Context (postMessage for iframe)](https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps)
