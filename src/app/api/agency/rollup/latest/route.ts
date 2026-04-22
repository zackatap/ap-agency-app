import { NextResponse } from "next/server";
import { buildAgencyRollupView } from "@/lib/agency-rollup-view";
import {
  getDateRangeForPreset,
  DATE_RANGE_LABELS,
  type DateRangePreset,
} from "@/lib/date-ranges";

const PRESETS: DateRangePreset[] = [
  "this_month",
  "last_month",
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
  const { startDate, endDate } = getDateRangeForPreset(
    preset,
    customFrom,
    customTo,
    clientDate
  );

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
