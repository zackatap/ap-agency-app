# Automated Practice – AP Agency App

A GoHighLevel (GHL) embedded app for **Automated Practice**. It provides pipeline conversion metrics at the location level using OAuth.

## Setup

### 1. GHL Marketplace App (Single-Location OAuth)

1. Create an app in [Developer Marketplace](https://marketplace.gohighlevel.com/)
2. **Target User**: Set to **Sub-Account** (required for single-location flow)
3. In **Auth** settings, add scopes: `opportunities.readonly`, `contacts.readonly`, `oauth.readonly`, `oauth.write`
4. Add redirect URL: `https://your-app.vercel.app/api/auth/callback/ghl`
5. Create a Client Key and copy **Client ID** and **Client Secret**

See **[docs/GHL-AUTH-SETUP.md](docs/GHL-AUTH-SETUP.md)** for full OAuth setup and iframe notes.

### 2. Neon Database

1. In Vercel: **Project → Storage → Connect Database → Neon**
2. Create a new database (or connect existing) – `DATABASE_URL` is added automatically

### 3. Environment

Set these in Vercel (Neon adds `DATABASE_URL` when you connect it):

```
GHL_CLIENT_ID=your-client-id
GHL_CLIENT_SECRET=your-client-secret
GHL_REDIRECT_URI=https://ap-agency-app.vercel.app/api/auth/callback/ghl
```

### 4. Facebook Ad Spend (Month to Month tab)

To pull ad spend directly from Facebook instead of manual entry:

1. Create a [Meta Developer App](https://developers.facebook.com/apps/) and get App ID and App Secret.
2. Generate a long-lived access token with `ads_read` permission (via [Graph API Explorer](https://developers.facebook.com/tools/explorer/) or a System User in Business Manager).
3. Add to environment:

   ```
   META_APP_ID=your-app-id
   META_APP_SECRET=your-app-secret
   META_ACCESS_TOKEN=your-long-lived-token
   ```

4. On the Month to Month tab, enter the Facebook Ad Account ID (e.g. `act_123456789`), then select "All" or a specific campaign. Ad spend will be fetched from the Meta Marketing API.

### 5. Embed in GHL

1. In GoHighLevel, go to **Settings → Custom Menu** (or your location’s menu).
2. Add a custom menu link that opens at the **location** level.
3. Use this URL pattern:

   ```
   https://app.automatedpractice.com/v2/location/{{location.id}}/dashboard
   ```

   GHL will replace `{{location.id}}` with the current location ID when the link is opened (works on the Location sidebar when inside an account).

## Features

### Conversions Dashboard

- **Pipeline selection**: Choose any pipeline from a dropdown. Defaults to the first pipeline matching `"pain"` in the name.
- **Date range filtering**: Filter metrics by preset ranges or custom dates:
  - This month, Last month
  - Last 30, 60, or 90 days
  - Custom date range
- **Conversion metric**: `(Success / Showed Up) × 100`
  - **Showed Up** = opportunities in the "Showed Up" stage
  - **Success** = opportunities in the "Success" stage
- **Total counts**: Counts opportunities in each stage (including **won**), filtered by the selected date range.

## Routes

| Path | Description |
|------|-------------|
| `/` | Home |
| `/v2/location/[locationId]/dashboard` | Conversions Dashboard for a location |

## Development

```bash
npm install
npm run dev
```

Then visit:

- http://localhost:3000
- http://localhost:3000/v2/location/Yl8c8Rmoh5TsTfVN5q5F/dashboard

## API

- **GET /api/conversions/[locationId]** – Returns conversion metrics. Query params:
  - `pipelineId` – Pipeline to use (default: first pipeline matching "pain")
  - `dateRange` – `this_month` | `last_month` | `last_30` | `last_60` | `last_90` | `custom`
  - `dateFrom`, `dateTo` – Required when `dateRange=custom` (YYYY-MM-DD)
- **GET /api/pipelines/[locationId]** – Returns list of pipelines for the location.
