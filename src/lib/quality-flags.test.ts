/**
 * Lightweight assert suite for quality-flags — no test runner in this repo.
 * Usage: npx tsx src/lib/quality-flags.test.ts
 */
import { computeQualityFlag } from "./quality-flags";
import type { QualityMetrics } from "./quality-flags";

function base(over: Partial<QualityMetrics> = {}): QualityMetrics {
  return {
    businessName: "Test Clinic",
    appts30d: 0,
    showed30d: 0,
    noShow30d: 0,
    closed30d: 0,
    leads30d: 0,
    bookingRate30d: null,
    showRate30d: null,
    closeRate30d: null,
    showRate14d: null,
    showRate14dPrev: null,
    appts14d: 0,
    appts14dPrev: 0,
    ...over,
  };
}

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

assert("empty name → null", computeQualityFlag(base({ businessName: "  " })) === null);

{
  const flag = computeQualityFlag(
    base({ appts30d: 8, showed30d: 0, noShow30d: 0, closed30d: 0 })
  );
  assert("Q_DATA on zero outcomes", flag?.code === "Q_DATA");
  assert("Q_DATA urgency is 3", flag?.urgency === 3);
}

{
  // 2 resolved on 20 appts = 10% coverage → sparse hygiene, not a rate flag.
  const flag = computeQualityFlag(
    base({ appts30d: 20, showed30d: 1, noShow30d: 1, showRate30d: 5 })
  );
  assert("Q_DATA on sparse coverage", flag?.code === "Q_DATA");
}

assert(
  "no Q_DATA below appt floor",
  computeQualityFlag(base({ appts30d: 4, showed30d: 0, noShow30d: 0 })) === null
);

assert(
  "suppress rates when coverage under 40%",
  computeQualityFlag(
    base({
      appts30d: 20,
      showed30d: 5,
      noShow30d: 1, // 30% coverage
      showRate30d: 10,
      closeRate30d: 5,
    })
  ) === null
);

{
  // 12 showed + 4 no-show = 16/20 = 80% coverage, show 15% → red.
  const flag = computeQualityFlag(
    base({
      appts30d: 20,
      showed30d: 3,
      noShow30d: 13,
      showRate30d: 15,
      closeRate30d: 50,
    })
  );
  assert("Q_R1 low show rate", flag?.code === "Q_R1" && flag.urgency === 0, flag?.code);
}

{
  const flag = computeQualityFlag(
    base({
      appts30d: 20,
      showed30d: 12,
      noShow30d: 2,
      showRate30d: 60,
      closeRate30d: 10,
    })
  );
  assert("Q_R2 low sign-on rate", flag?.code === "Q_R2");
}

{
  const flag = computeQualityFlag(
    base({
      appts30d: 20,
      showed30d: 8,
      noShow30d: 10, // 50% no-show, 90% coverage
      showRate30d: 40,
      closeRate30d: 50,
    })
  );
  assert("Q_O1 high no-show rate", flag?.code === "Q_O1");
}

{
  const flag = computeQualityFlag(
    base({
      appts30d: 20,
      showed30d: 10,
      noShow30d: 2,
      showRate30d: 50,
      closeRate30d: 50,
      showRate14d: 45,
      showRate14dPrev: 65,
      appts14d: 10,
      appts14dPrev: 10,
    })
  );
  assert("Q_O2 show-rate drop with volume", flag?.code === "Q_O2");
}

assert(
  "Q_O2 suppressed on thin 14d volume",
  computeQualityFlag(
    base({
      appts30d: 20,
      showed30d: 10,
      noShow30d: 2,
      showRate30d: 50,
      closeRate30d: 50,
      showRate14d: 0,
      showRate14dPrev: 80,
      appts14d: 3,
      appts14dPrev: 4,
    })
  ) === null
);

{
  const flag = computeQualityFlag(
    base({
      appts30d: 20,
      showed30d: 10,
      noShow30d: 4,
      showRate30d: 25,
      closeRate30d: 50,
    })
  );
  assert("Q_O3 show under 30%", flag?.code === "Q_O3");
}

{
  const flag = computeQualityFlag(
    base({
      appts30d: 20,
      showed30d: 10,
      noShow30d: 2,
      showRate30d: 35,
      closeRate30d: 50,
    })
  );
  assert("Q_Y1 show under 40%", flag?.code === "Q_Y1");
}

{
  const flag = computeQualityFlag(
    base({
      appts30d: 8,
      showed30d: 6,
      noShow30d: 1,
      leads30d: 40,
      showRate30d: 75,
      closeRate30d: 50,
      bookingRate30d: 20,
    })
  );
  assert("Q_Y3 low booking rate", flag?.code === "Q_Y3");
}

assert(
  "healthy funnel → null",
  computeQualityFlag(
    base({
      appts30d: 20,
      showed30d: 14,
      noShow30d: 2,
      leads30d: 30,
      showRate30d: 70,
      closeRate30d: 45,
      bookingRate30d: 55,
      showRate14d: 70,
      showRate14dPrev: 68,
      appts14d: 12,
      appts14dPrev: 11,
    })
  ) === null
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
