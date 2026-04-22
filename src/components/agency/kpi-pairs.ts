import type { DashboardKpiMetric } from "./data-quality";

/** Column headers for each metric in KPI pair cards (shown in uppercase). */
export const KPI_INLINE_LABEL: Record<DashboardKpiMetric, string> = {
  leads: "Leads",
  totalAppts: "Appts",
  showed: "Showed",
  closed: "Closed",
  bookingRate: "Booking rate",
  showRate: "Show rate",
  closeRate: "Close rate",
  roas: "ROAS",
  successValue: "Closed value",
  adSpend: "Ad spend",
  cpl: "CPL",
  cpClose: "Cost / close",
};

export type KpiPairConfig = {
  id: string;
  /** Accessible name for the pair (e.g. screen readers on agency dashboard). */
  cardTitle: string;
  a: DashboardKpiMetric;
  b: DashboardKpiMetric;
};

/** Grouped KPI pairs: Leads & Appointments, then Conversions (agency + benchmark). */
export const KPI_SECTIONS: Array<{
  id: string;
  title: string;
  subtitle: string;
  pairs: KpiPairConfig[];
}> = [
  {
    id: "leads-appointments",
    title: "Leads & Appointments",
    subtitle:
      "Lead and appointment volume, CPL, and funnel rates through the show stage.",
    pairs: [
      { id: "leads-cpl", cardTitle: "Leads & CPL", a: "leads", b: "cpl" },
      {
        id: "appts-booking",
        cardTitle: "Appts & booking rate",
        a: "totalAppts",
        b: "bookingRate",
      },
      {
        id: "showed-show",
        cardTitle: "Showed & show rate",
        a: "showed",
        b: "showRate",
      },
    ],
  },
  {
    id: "conversions",
    title: "Conversions",
    subtitle: "Closed deals, efficiency, revenue, and spend.",
    pairs: [
      {
        id: "closed-closerate",
        cardTitle: "Closed & close rate",
        a: "closed",
        b: "closeRate",
      },
      {
        id: "spend-roas",
        cardTitle: "Ad spend & ROAS",
        a: "adSpend",
        b: "roas",
      },
      {
        id: "value-cpclose",
        cardTitle: "Closed value & cost per close",
        a: "successValue",
        b: "cpClose",
      },
    ],
  },
];
