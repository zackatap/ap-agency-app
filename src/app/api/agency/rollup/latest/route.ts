import { NextResponse } from "next/server";
import { buildAgencyRollupView } from "@/lib/agency-rollup-view";
import { getLatestCompleteSnapshot } from "@/lib/agency-rollup-store";
import {
  getDateRangeForPreset,
  getTodayLocal,
  isoToLocalDateString,
  shiftDateString,
  DATE_RANGE_LABELS,
  type DateRangePreset,
} from "@/lib/date-ranges";

/**
 * Exact day-counts for trailing presets, used only when `?anchor=snapshot` is
 * set (the Scorecard). Anchoring ends the window at the refresh date and makes
 * "last N days" exactly N days, so the Scorecard's date line matches the data
 * (which stops at the last refresh, not today).
 */
const TRAILING_DAYS: Partial<Record<DateRangePreset, number>> = {
  last_3: 3,
  last_7: 7,
  last_14: 14,
  last_30: 30,
  last_60: 60,
  last_90: 90,
};

const PRESETS: DateRangePreset[] = [
  "this_month",
  "last_month",
  "last_3",
  "last_7",
  "last_14",
  "last_30",
  "last_60",
  "last_90",
  "maximum",
  "custom",
];

function isPreset(v: string | null): v is DateRangePreset {
  return !!v && (PRESETS as string[]).includes(v);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const presetParam = url.searchParams.get("preset");
  const customFrom = url.searchParams.get("from") ?? undefined;
  const customTo = url.searchParams.get("to") ?? undefined;
  const clientDate = url.searchParams.get("clientDate") ?? undefined;
  const onTotalsParam = url.searchParams.get("onTotals");
  const onTotals = onTotalsParam !== "false" && onTotalsParam !== "0";

  const preset: DateRangePreset = isPreset(presetParam) ? presetParam : "last_30";

  // Anchor trailing windows to the snapshot's data date (the last refresh) so
  // "last N days" means the N days ending at the refresh, not today — the data
  // doesn't extend past the refresh, so a today-anchored window would show
  // empty/partial days and mismatch the labels.
  const anchorToSnapshot = url.searchParams.get("anchor") === "snapshot";
  // The viewer's tz, so the window ends on the same calendar date the "Last
  // refresh" line shows (a late-night refresh otherwise rolls into "tomorrow"
  // in the data tz and tacks on a partial day).
  const tz = url.searchParams.get("tz") ?? undefined;
  const trailingDays = TRAILING_DAYS[preset];
  let startDate: string;
  let endDate: string;
  if (anchorToSnapshot && trailingDays) {
    const snap = await getLatestCompleteSnapshot();
    const anchor = snap?.finishedAt
      ? isoToLocalDateString(snap.finishedAt, tz)
      : clientDate ?? getTodayLocal();
    endDate = anchor;
    startDate = shiftDateString(anchor, -(trailingDays - 1));
  } else {
    ({ startDate, endDate } = getDateRangeForPreset(
      preset,
      customFrom,
      customTo,
      clientDate
    ));
  }

  const view = await buildAgencyRollupView({
    onTotals,
    range: {
      preset,
      startDate,
      endDate,
      label: DATE_RANGE_LABELS[preset],
    },
  });

  if (!view) {
    return NextResponse.json(
      {
        snapshot: null,
        range: { preset, startDate, endDate, label: DATE_RANGE_LABELS[preset] },
        priorRange: null,
        onTotals,
        months: [],
        campaigns: [],
        message:
          "No rollup snapshot yet — click Refresh data to generate the first one.",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
