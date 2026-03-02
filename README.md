# Automated Practice – AP Agency App

A GoHighLevel (GHL) embedded app for **Automated Practice**. It provides pipeline conversion metrics at the location level using OAuth.

## Setup

### 1. GHL Marketplace App

1. Create an app in [Developer Marketplace](https://marketplace.gohighlevel.com/)
2. In **Auth** settings, add your app's scopes (include **opportunities.readonly**)
3. Add redirect URL: `https://ap-agency-app.vercel.app/api/auth/callback/ghl`
4. Create a Client Key and copy **Client ID** and **Client Secret**

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

### 4. Embed in GHL

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
