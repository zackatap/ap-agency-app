"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

function formatCurrency(value: number, fractionDigits = 0) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export default function OfferingsClient() {
  const [months, setMonths] = useState(12);
  const [ltv, setLtv] = useState(2000);
  const [adSpend, setAdSpend] = useState(2000);
  const [founderPricing, setFounderPricing] = useState(false);

  const calc = useMemo(() => {
    const buildoutFee = founderPricing ? 4995 : 7995;
    const platformMonths = Math.max(0, months - 2);

    const handsOnAgency = months * 1795;
    const handsOnAds = months * adSpend;
    const handsOnTotal = handsOnAgency + handsOnAds;

    const buildoutPlatform = platformMonths * 295;
    const buildoutAds = months * adSpend;
    const buildoutAgency = buildoutFee + buildoutPlatform;
    const buildoutTotal = buildoutAgency + buildoutAds;

    const patientsFor = (total: number, multiple: number) => {
      if (!ltv || !months) return 0;
      return (multiple * total) / (ltv * months);
    };

    return {
      handsOn: {
        agency: handsOnAgency,
        ads: handsOnAds,
        total: handsOnTotal,
        monthlyAvg: handsOnTotal / months,
        patients2x: patientsFor(handsOnTotal, 2),
        patients5x: patientsFor(handsOnTotal, 5),
      },
      buildout: {
        buildoutFee,
        platformMonths,
        platform: buildoutPlatform,
        ads: buildoutAds,
        agency: buildoutAgency,
        total: buildoutTotal,
        monthlyAvg: buildoutTotal / months,
        patients2x: patientsFor(buildoutTotal, 2),
        patients5x: patientsFor(buildoutTotal, 5),
      },
    };
  }, [months, ltv, adSpend, founderPricing]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(99,102,241,0.25),transparent_70%)]" />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 pt-8">
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight text-white/80 hover:text-white"
        >
          Automated Practice
        </Link>
        <a
          href="#calculator"
          className="rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium text-white/80 backdrop-blur hover:bg-white/10"
        >
          ROI Calculator ↓
        </a>
      </header>

      <section className="relative z-10 mx-auto max-w-6xl px-6 pt-16 pb-10 text-center">
        <span className="inline-flex items-center rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-medium uppercase tracking-widest text-indigo-200">
          Two ways to grow with us
        </span>
        <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          Predictable patient acquisition,{" "}
          <span className="bg-gradient-to-r from-indigo-300 via-fuchsia-300 to-emerald-300 bg-clip-text text-transparent">
            built for your practice.
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-slate-300">
          Whether you want a fully hands-on growth partner or your own
          high-converting system installed in-house, we have an offering that
          fits. Ad spend is always a separate investment that stays in your
          account.
        </p>
      </section>

      <section className="relative z-10 mx-auto grid max-w-6xl gap-6 px-6 pb-12 lg:grid-cols-2">
        <article className="group relative overflow-hidden rounded-3xl border border-indigo-400/30 bg-gradient-to-b from-indigo-500/15 to-slate-900/60 p-8 shadow-2xl shadow-indigo-950/40 backdrop-blur">
          <div className="absolute right-6 top-6 rounded-full bg-indigo-500/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-indigo-200">
            Most hands-on
          </div>
          <h2 className="text-sm font-medium uppercase tracking-widest text-indigo-200">
            Package A
          </h2>
          <p className="mt-2 text-3xl font-semibold tracking-tight">
            Managed Growth Partner
          </p>
          <p className="mt-2 text-sm text-slate-300">
            We run everything, month after month — proactive, not reactive.
          </p>

          <div className="mt-8 flex items-baseline gap-2">
            <span className="text-5xl font-semibold tracking-tight">
              $1,795
            </span>
            <span className="text-slate-400">/month</span>
          </div>
          <p className="mt-1 text-sm text-emerald-300">
            No setup fee · Ad spend separate
          </p>

          <ul className="mt-8 space-y-3 text-sm text-slate-200">
            {[
              "We manage and optimize your paid ads end-to-end",
              "Full in-house video editing team",
              "We send you scripts — you shoot, we edit",
              "Continuous creative testing & strategy pivots",
              "Proactive optimization (not reactive)",
              "Hands-on, week-over-week account management",
              "All assets & accounts stay in your possession",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-indigo-500/20 text-indigo-300">
                  ✓
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <a
            href="#calculator"
            className="mt-10 inline-flex w-full items-center justify-center rounded-2xl bg-indigo-500 px-6 py-3 text-sm font-semibold text-white transition hover:bg-indigo-400"
          >
            Calculate ROI for Package A
          </a>
        </article>

        <article className="group relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-white/5 to-slate-900/60 p-8 shadow-2xl shadow-slate-950/40 backdrop-blur">
          <div className="absolute right-6 top-6 rounded-full bg-emerald-500/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-emerald-200">
            Founder pricing
          </div>
          <h2 className="text-sm font-medium uppercase tracking-widest text-emerald-200">
            Package B
          </h2>
          <p className="mt-2 text-3xl font-semibold tracking-tight">
            Done-For-You System Buildout
          </p>
          <p className="mt-2 text-sm text-slate-300">
            We install the marketing system in your accounts — you own it.
          </p>

          <div className="mt-8 flex items-baseline gap-3">
            <span className="text-5xl font-semibold tracking-tight">
              $4,995
            </span>
            <span className="text-lg text-slate-500 line-through">$7,995</span>
          </div>
          <p className="mt-1 text-sm text-emerald-300">
            One-time buildout · then $295/mo platform &amp; support
          </p>

          <ul className="mt-8 space-y-3 text-sm text-slate-200">
            {[
              "Complete system installed within 30 days",
              "60 days of active optimization & management",
              "Live training session for your front desk",
              "Built in your ad accounts, CRM & GoHighLevel",
              "$295/mo platform & support after buildout",
              "Optional: 3-month DFY ad management — $3,500",
              "Optional: 6-month DFY ad management — $5,500",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
                  ✓
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <a
            href="#calculator"
            className="mt-10 inline-flex w-full items-center justify-center rounded-2xl border border-white/15 bg-white/10 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/20"
          >
            Calculate ROI for Package B
          </a>
        </article>
      </section>

      <section
        id="calculator"
        className="relative z-10 mx-auto max-w-6xl scroll-mt-6 px-6 pb-24"
      >
        <div className="rounded-3xl border border-white/10 bg-slate-950/60 p-6 shadow-2xl shadow-slate-950/40 backdrop-blur sm:p-10">
          <div className="flex flex-col gap-2 text-center">
            <span className="mx-auto inline-flex items-center rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-medium uppercase tracking-widest text-slate-300">
              ROI Calculator
            </span>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Dial in your numbers
            </h2>
            <p className="mx-auto max-w-2xl text-slate-400">
              Set how long you plan to work with us, your patient LTV, and your
              monthly ad spend. We&apos;ll show total investment and the
              patients per month needed for a 2× and 5× return.
            </p>
          </div>

          <div className="mt-10 space-y-8">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
                  Inputs
                </h3>
                <p className="text-xs text-slate-500">
                  Adjust any value to see both packages update live.
                </p>
              </div>

              <div className="mt-6 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                <Field
                  label="Months with us"
                  hint={`${months} month${months === 1 ? "" : "s"}`}
                >
                  <input
                    type="range"
                    min={3}
                    max={24}
                    step={1}
                    value={months}
                    onChange={(e) => setMonths(Number(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                  <div className="mt-2 flex justify-between text-[11px] text-slate-500">
                    <span>3 mo</span>
                    <span>12 mo</span>
                    <span>24 mo</span>
                  </div>
                </Field>

                <Field label="Patient LTV" hint={formatCurrency(ltv)}>
                  <CurrencyInput
                    value={ltv}
                    onChange={setLtv}
                    min={0}
                    step={100}
                  />
                </Field>

                <Field
                  label="Monthly ad spend"
                  hint={`${formatCurrency(adSpend)}/mo · stays in your account`}
                >
                  <CurrencyInput
                    value={adSpend}
                    onChange={setAdSpend}
                    min={0}
                    step={100}
                  />
                </Field>

                <Field label="Package B founder pricing">
                  <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={founderPricing}
                      onChange={(e) => setFounderPricing(e.target.checked)}
                      className="h-4 w-4 accent-emerald-500"
                    />
                    <span className="text-sm text-slate-200">
                      Apply $4,995 founder rate (vs. $7,995)
                    </span>
                  </label>
                </Field>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <ResultCard
                accent="indigo"
                title="Package A — Managed Growth Partner"
                total={calc.handsOn.total}
                months={months}
                monthlyAvg={calc.handsOn.monthlyAvg}
                patients2x={calc.handsOn.patients2x}
                patients5x={calc.handsOn.patients5x}
                ltv={ltv}
                lines={[
                  {
                    label: `Agency fee · ${months} × $1,795`,
                    value: calc.handsOn.agency,
                  },
                  {
                    label: `Ad spend · ${months} × ${formatCurrency(adSpend)}`,
                    value: calc.handsOn.ads,
                    muted: true,
                  },
                ]}
              />

              <ResultCard
                accent="emerald"
                title="Package B — DFY System Buildout"
                total={calc.buildout.total}
                months={months}
                monthlyAvg={calc.buildout.monthlyAvg}
                patients2x={calc.buildout.patients2x}
                patients5x={calc.buildout.patients5x}
                ltv={ltv}
                lines={[
                  {
                    label: `Buildout (${founderPricing ? "founder" : "standard"})`,
                    value: calc.buildout.buildoutFee,
                  },
                  {
                    label: `Platform · ${calc.buildout.platformMonths} × $295 (after 60-day buildout)`,
                    value: calc.buildout.platform,
                  },
                  {
                    label: `Ad spend · ${months} × ${formatCurrency(adSpend)}`,
                    value: calc.buildout.ads,
                    muted: true,
                  },
                ]}
              />
            </div>
          </div>

          <p className="mt-8 text-center text-xs text-slate-500">
            Estimates for planning only. Ad spend is paid to Meta / Google
            directly from your own accounts and is shown here so total outlay
            is clear.
          </p>
        </div>
      </section>

      <footer className="relative z-10 mx-auto max-w-6xl px-6 pb-10 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} Automated Practice. All systems remain in
        your possession.
      </footer>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex min-h-[2.5rem] flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <label className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          {label}
        </label>
        {hint ? (
          <span className="text-right text-xs text-slate-300">{hint}</span>
        ) : null}
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

function CurrencyInput({
  value,
  onChange,
  min = 0,
  step = 100,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <div className="flex items-center rounded-xl border border-white/10 bg-white/5 px-4 py-3 focus-within:border-indigo-400/60">
      <span className="mr-2 text-slate-400">$</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          onChange(Number.isFinite(parsed) ? parsed : 0);
        }}
        className="w-full bg-transparent text-base text-white outline-none placeholder:text-slate-500"
      />
    </div>
  );
}

type ResultLine = { label: string; value: number; muted?: boolean };

function ResultCard({
  accent,
  title,
  total,
  months,
  monthlyAvg,
  patients2x,
  patients5x,
  ltv,
  lines,
}: {
  accent: "indigo" | "emerald";
  title: string;
  total: number;
  months: number;
  monthlyAvg: number;
  patients2x: number;
  patients5x: number;
  ltv: number;
  lines: ResultLine[];
}) {
  const accentClasses = {
    indigo: {
      border: "border-indigo-400/30",
      bg: "from-indigo-500/15 to-slate-900/40",
      pill: "bg-indigo-500/20 text-indigo-200",
      chip: "text-indigo-200",
    },
    emerald: {
      border: "border-emerald-400/30",
      bg: "from-emerald-500/10 to-slate-900/40",
      pill: "bg-emerald-500/20 text-emerald-200",
      chip: "text-emerald-200",
    },
  }[accent];

  return (
    <div
      className={`rounded-2xl border ${accentClasses.border} bg-gradient-to-b ${accentClasses.bg} p-6 shadow-lg shadow-slate-950/30`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        <span
          className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-widest ${accentClasses.pill}`}
        >
          {months} mo plan
        </span>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
            Total investment
          </p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            {formatCurrency(total)}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            ~{formatCurrency(monthlyAvg)} avg / month
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
            Breakeven patients/mo
          </p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            {formatPatients(patients2x / 2)}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            at {formatCurrency(ltv)} LTV
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <TargetCard
          label="2× return"
          patients={patients2x}
          revenue={2 * total}
          accent={accentClasses.chip}
        />
        <TargetCard
          label="5× return"
          patients={patients5x}
          revenue={5 * total}
          accent={accentClasses.chip}
        />
      </div>

      <div className="mt-5 border-t border-white/10 pt-4">
        <ul className="space-y-2 text-sm">
          {lines.map((line) => (
            <li
              key={line.label}
              className={`flex items-center justify-between ${
                line.muted ? "text-slate-400" : "text-slate-200"
              }`}
            >
              <span>{line.label}</span>
              <span className="font-medium tabular-nums">
                {formatCurrency(line.value)}
              </span>
            </li>
          ))}
          <li className="flex items-center justify-between border-t border-white/10 pt-3 text-sm font-semibold">
            <span>Total investment ({months} mo)</span>
            <span className="tabular-nums">{formatCurrency(total)}</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function TargetCard({
  label,
  patients,
  revenue,
  accent,
}: {
  label: string;
  patients: number;
  revenue: number;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p
        className={`text-[11px] font-semibold uppercase tracking-widest ${accent}`}
      >
        {label}
      </p>
      <p className="mt-1 text-3xl font-semibold tracking-tight">
        {formatPatients(patients)}
      </p>
      <p className="mt-1 text-xs text-slate-400">
        patients/mo · {formatCurrency(revenue)} total revenue
      </p>
    </div>
  );
}

function formatPatients(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  return Math.ceil(n).toLocaleString("en-US");
}
