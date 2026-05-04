"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

type SlideKind = "welcome" | "leaders" | "timelineIntro" | "roadmap" | "split";

type Slide = {
  eyebrow: string;
  title: string;
  subtitle?: string;
  kind: SlideKind;
  phase?: string;
  accent: "teal" | "sky" | "amber" | "rose" | "slate";
  bullets?: {
    title: string;
    body?: string;
  }[];
  callout?: string;
};

const slides: Slide[] = [
  {
    eyebrow: "Welcome",
    title: "Welcome to Automated Practice",
    subtitle:
      "A clear path from kickoff to confident growth, built so your team knows exactly what happens next.",
    kind: "welcome",
    accent: "teal",
  },
  {
    eyebrow: "Proof",
    title: "SoftWave Marketing Leaders",
    subtitle:
      "The majority of SoftWave's elite trainers use Automated Practice for their own practices.",
    kind: "leaders",
    accent: "sky",
    bullets: [
      {
        title: "Trusted by trainers",
        body: "The people teaching the market are using the same growth system behind the scenes.",
      },
      {
        title: "Built for real practices",
        body: "Campaigns, follow-up, and systems are shaped around patient demand, clinic flow, and provider capacity.",
      },
    ],
  },
  {
    eyebrow: "Roadmap",
    title: "Your Practice's Timeline",
    subtitle:
      "From first email to ongoing growth, this is the path we walk together.",
    kind: "timelineIntro",
    accent: "teal",
  },
  {
    eyebrow: "Day 1",
    phase: "Welcome Email",
    title: "Kickoff starts with a clean handoff",
    subtitle:
      "We gather the essentials, assign your client ID, and make access simple.",
    kind: "roadmap",
    accent: "teal",
    bullets: [
      {
        title: "Client ID assigned",
        body: "Your account gets its internal tracking ID so every system points to the right practice.",
      },
      {
        title: "Onboarding form",
        body: "We dial in the offer, service mix, market, and any details your ads need to get right.",
      },
      {
        title: "Access made simple",
        body: "A guided tool helps you provide Meta access without a long technical back-and-forth.",
      },
      {
        title: "Video scripts",
        body: "We share high-converting scripts you can film if you are comfortable on camera.",
      },
      {
        title: "Bonus: chat widget",
        body: "We can add a lightweight site widget to capture more active interest.",
      },
    ],
  },
  {
    eyebrow: "Week 1",
    phase: "Onboarding Call",
    title: "A real strategy call with Gabriele",
    subtitle:
      "You meet with Gabriele here in our office, not an offshore rep reading from a script.",
    kind: "roadmap",
    accent: "sky",
    bullets: [
      {
        title: "Set expectations",
        body: "We clarify timelines, roles, approvals, and what a healthy launch should feel like.",
      },
      {
        title: "Train on the platform",
        body: "Your team sees where leads go, how follow-up works, and what to check after launch.",
      },
      {
        title: "Refine the offer",
        body: "We tighten the patient-facing promise before creative and landing pages are built.",
      },
    ],
  },
  {
    eyebrow: "Week 2-4",
    phase: "We Get To Work",
    title: "Our in-house team builds the growth system",
    subtitle:
      "This is where strategy turns into campaign assets, pages, automations, and launch prep.",
    kind: "roadmap",
    accent: "amber",
    bullets: [
      {
        title: "Video editing",
        body: "Full in-house editing turns raw footage into polished ads.",
      },
      {
        title: "Ad design",
        body: "We build creative that can be tested quickly without feeling cheap.",
      },
      {
        title: "Landing page",
        body: "The page is built around clarity, conversion, and patient fit.",
      },
      {
        title: "Ad strategy",
        body: "We plan audiences, angles, creative order, and first-round testing.",
      },
      {
        title: "Systems and automations",
        body: "Lead routing, reminders, and follow-up are installed before traffic begins.",
      },
    ],
  },
  {
    eyebrow: "Week 2-4",
    phase: "Reactivate",
    title: "Bring past patients back into the conversation",
    subtitle:
      "We run a campaign blast to reconnect with people who already know your practice.",
    kind: "roadmap",
    accent: "rose",
    bullets: [
      {
        title: "Past patient campaign",
        body: "A focused reactivation push gives warm patients a reason to raise their hand again.",
      },
      {
        title: "Fast feedback",
        body: "Early replies help us sharpen messaging before broader traffic starts.",
      },
    ],
  },
  {
    eyebrow: "Week 2-4",
    phase: "Review Ads",
    title: "Preview the full patient experience",
    subtitle:
      "You see the ads and the flow before patients do, then we refine and approve.",
    kind: "roadmap",
    accent: "sky",
    bullets: [
      {
        title: "Make sure it resonates",
        body: "The language should feel true to your practice, your offer, and your market.",
      },
      {
        title: "Know what patients see",
        body: "You will understand the path patients take before they come in.",
      },
      {
        title: "Refine and approve",
        body: "We make final adjustments before launch.",
      },
    ],
  },
  {
    eyebrow: "Week 2-4",
    phase: "Go Live",
    title: "Your ads are live",
    subtitle:
      "Ads are only one source of new patients, but launch is a clean milestone.",
    kind: "roadmap",
    accent: "teal",
    bullets: [
      {
        title: "Campaigns begin",
        body: "Traffic starts once assets, tracking, access, and automations are ready.",
      },
      {
        title: "First signals arrive",
        body: "We watch lead quality, response speed, and appointment flow from the start.",
      },
    ],
  },
  {
    eyebrow: "Month 2",
    phase: "Monitor and test",
    title: "We watch performance closely",
    subtitle:
      "The first month of data gives us the signals we need to test and adjust with confidence.",
    kind: "roadmap",
    accent: "amber",
    bullets: [
      {
        title: "Monitor performance",
        body: "We keep a close eye on cost, quality, bookings, and clinic feedback.",
      },
      {
        title: "Split test creative",
        body: "New hooks and visuals help us find what the local market responds to.",
      },
      {
        title: "Pivot early",
        body: "If the numbers tell us to adjust, we move quickly.",
      },
    ],
  },
  {
    eyebrow: "Month 3",
    phase: "Find winners",
    title: "Winners become the new baseline",
    subtitle:
      "By now, we are turning early lessons into a stronger operating rhythm.",
    kind: "roadmap",
    accent: "rose",
    bullets: [
      {
        title: "Find winning angles",
        body: "We identify which messages, offers, and creative are doing the heavy lifting.",
      },
      {
        title: "Fine tune systems",
        body: "We tighten the pieces around lead handling, reminders, and team workflow.",
      },
      {
        title: "Introduce ReferralKit",
        body: "When the foundation is ready, referrals help multiply patient flow.",
      },
    ],
  },
  {
    eyebrow: "Month 4+",
    phase: "Choose your lane",
    title: "Long-term growth splits by package",
    subtitle:
      "From here, support shifts based on whether you are on Accelerator or Platform.",
    kind: "split",
    accent: "slate",
    bullets: [
      {
        title: "Accelerator",
        body: "We continue managing ads, creating new videos and campaigns as needed, and giving hands-on support.",
      },
      {
        title: "Platform",
        body: "Your team gets clear winning ads, live Q&A calls, and technical support.",
      },
    ],
  },
];

const timelineSlideIndexes = slides
  .map((slide, index) =>
    slide.kind === "timelineIntro" ||
    slide.kind === "roadmap" ||
    slide.kind === "split"
      ? index
      : -1
  )
  .filter((index) => index >= 0);

const accentClasses: Record<Slide["accent"], string> = {
  teal: "from-teal-500 to-emerald-400 text-teal-950",
  sky: "from-sky-500 to-cyan-300 text-sky-950",
  amber: "from-amber-400 to-orange-300 text-amber-950",
  rose: "from-rose-400 to-pink-300 text-rose-950",
  slate: "from-slate-700 to-slate-500 text-white",
};

const trainerCards = [
  {
    name: "Dr. Elena Marrow",
    role: "SoftWave trainer",
    stat: "14 clinics coached",
    color: "from-teal-200 via-white to-sky-100",
  },
  {
    name: "Dr. Mateo Voss",
    role: "Practice mentor",
    stat: "6 launch playbooks",
    color: "from-amber-100 via-white to-teal-100",
  },
  {
    name: "Dr. Priya Callen",
    role: "Clinical educator",
    stat: "32 team trainings",
    color: "from-rose-100 via-white to-amber-100",
  },
  {
    name: "Dr. Nolan Pierce",
    role: "Market leader",
    stat: "4-city workshop loop",
    color: "from-sky-100 via-white to-slate-100",
  },
];

export function ClientRoadmapPresentation() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentSlide = slides[currentIndex];
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === slides.length - 1;
  const roadmapPosition = timelineSlideIndexes.indexOf(currentIndex);

  const progress = useMemo(
    () => ((currentIndex + 1) / slides.length) * 100,
    [currentIndex]
  );

  const goTo = (index: number) => {
    setCurrentIndex(Math.min(Math.max(index, 0), slides.length - 1));
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === " ") {
        event.preventDefault();
        setCurrentIndex((index) => Math.min(index + 1, slides.length - 1));
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setCurrentIndex((index) => Math.max(index - 1, 0));
      }

      if (event.key === "Home") {
        event.preventDefault();
        setCurrentIndex(0);
      }

      if (event.key === "End") {
        event.preventDefault();
        setCurrentIndex(slides.length - 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-[#f7fbf6] text-slate-950">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_12%,rgba(45,212,191,0.20),transparent_28%),radial-gradient(circle_at_88%_8%,rgba(125,211,252,0.22),transparent_30%),linear-gradient(135deg,rgba(255,255,255,0.85),rgba(240,253,250,0.55))]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-white/80 to-transparent" />

      <div className="relative mx-auto flex min-h-[100dvh] max-w-[1500px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <PresentationHeader
          currentIndex={currentIndex}
          progress={progress}
          onGoTo={goTo}
        />

        <section className="relative grid flex-1 place-items-center py-4">
          <div
            key={currentIndex}
            className="presentation-enter relative w-full overflow-hidden rounded-[2rem] border border-white/80 bg-white/[0.82] p-5 shadow-[0_30px_90px_-45px_rgba(15,23,42,0.45)] ring-1 ring-slate-950/5 backdrop-blur-xl sm:p-8 lg:min-h-[700px] lg:rounded-[2.75rem] lg:p-10"
          >
            {roadmapPosition >= 0 && (
              <RoadmapBackdrop activePosition={roadmapPosition} />
            )}

            <SlideFrame slide={currentSlide} roadmapPosition={roadmapPosition} />
          </div>
        </section>

        <PresentationControls
          currentIndex={currentIndex}
          isFirst={isFirst}
          isLast={isLast}
          onPrevious={() => goTo(currentIndex - 1)}
          onNext={() => goTo(currentIndex + 1)}
        />
      </div>

      <style>{`
        @keyframes presentation-enter {
          0% {
            opacity: 0;
            transform: translate3d(0, 18px, 0) scale(0.985);
          }
          100% {
            opacity: 1;
            transform: translate3d(0, 0, 0) scale(1);
          }
        }

        @keyframes road-dash {
          to {
            stroke-dashoffset: -44;
          }
        }

        @keyframes soft-float {
          0%, 100% {
            transform: translate3d(0, 0, 0);
          }
          50% {
            transform: translate3d(0, -10px, 0);
          }
        }

        .presentation-enter {
          animation: presentation-enter 520ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        .road-dash {
          animation: road-dash 2400ms linear infinite;
        }

        .soft-float {
          animation: soft-float 5200ms ease-in-out infinite;
        }
      `}</style>
    </main>
  );
}

function PresentationHeader({
  currentIndex,
  progress,
  onGoTo,
}: {
  currentIndex: number;
  progress: number;
  onGoTo: (index: number) => void;
}) {
  return (
    <header className="flex flex-col gap-4 rounded-[1.5rem] border border-white/75 bg-white/70 px-4 py-3 shadow-[0_18px_50px_-35px_rgba(15,23,42,0.5)] backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-2xl bg-slate-950 text-sm font-black tracking-tighter text-white">
          AP
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
            Automated Practice
          </p>
          <p className="text-sm font-semibold text-slate-800">
            Client roadmap presentation
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden items-center gap-1 md:flex">
          {slides.map((slide, index) => (
            <button
              key={slide.title}
              type="button"
              onClick={() => onGoTo(index)}
              aria-label={`Go to slide ${index + 1}: ${slide.eyebrow}`}
              className={`h-2.5 rounded-full transition-all duration-300 ${
                index === currentIndex
                  ? "w-9 bg-slate-950"
                  : "w-2.5 bg-slate-300 hover:bg-slate-500"
              }`}
            />
          ))}
        </div>
        <div className="w-32 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-2 rounded-full bg-slate-950 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </header>
  );
}

function SlideFrame({
  slide,
  roadmapPosition,
}: {
  slide: Slide;
  roadmapPosition: number;
}) {
  if (slide.kind === "welcome") {
    return <WelcomeSlide slide={slide} />;
  }

  if (slide.kind === "leaders") {
    return <LeadersSlide slide={slide} />;
  }

  if (slide.kind === "timelineIntro") {
    return <TimelineIntroSlide slide={slide} />;
  }

  if (slide.kind === "split") {
    return <SplitSlide slide={slide} roadmapPosition={roadmapPosition} />;
  }

  return <RoadmapSlide slide={slide} roadmapPosition={roadmapPosition} />;
}

function WelcomeSlide({ slide }: { slide: Slide }) {
  return (
    <div className="relative grid min-h-[620px] gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
      <div className="relative z-10 max-w-3xl">
        <SlideEyebrow slide={slide} />
        <h1 className="mt-6 text-5xl font-black leading-[0.92] tracking-[-0.06em] text-slate-950 sm:text-7xl lg:text-8xl">
          Welcome to Automated Practice
        </h1>
        <p className="mt-8 max-w-2xl text-xl leading-8 text-slate-600 sm:text-2xl sm:leading-9">
          {slide.subtitle}
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Pill>Zoom-ready walkthrough</Pill>
          <Pill>Clear launch path</Pill>
          <Pill>Built for your team</Pill>
        </div>
      </div>

      <div className="relative z-10 min-h-[420px]">
        <div className="soft-float absolute right-3 top-6 w-[78%] rounded-[2.25rem] border border-white bg-gradient-to-br from-teal-100 via-white to-sky-100 p-6 shadow-[0_30px_80px_-45px_rgba(15,23,42,0.55)]">
          <div className="aspect-[4/5] rounded-[1.75rem] bg-[linear-gradient(145deg,rgba(15,23,42,0.04),rgba(255,255,255,0.9)),radial-gradient(circle_at_30%_24%,rgba(20,184,166,0.30),transparent_34%),radial-gradient(circle_at_80%_68%,rgba(56,189,248,0.24),transparent_28%)] p-5">
            <div className="flex h-full flex-col justify-between rounded-[1.35rem] border border-white/70 bg-white/[0.64] p-5">
              <div className="flex items-center justify-between">
                <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-white">
                  Roadmap
                </span>
                <span className="text-sm font-semibold text-teal-700">01</span>
              </div>
              <div>
                <div className="mb-5 h-3 w-40 rounded-full bg-slate-900/80" />
                <div className="space-y-3">
                  <div className="h-3 w-full rounded-full bg-slate-300" />
                  <div className="h-3 w-10/12 rounded-full bg-slate-200" />
                  <div className="h-3 w-8/12 rounded-full bg-slate-200" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <MiniMetric label="Day 1" value="ID" />
                <MiniMetric label="Week 1" value="Call" />
                <MiniMetric label="Month 3" value="Scale" />
              </div>
            </div>
          </div>
        </div>
        <div className="absolute bottom-8 left-4 w-[64%] rounded-[2rem] border border-white bg-white/[0.78] p-5 shadow-[0_22px_70px_-48px_rgba(15,23,42,0.65)] backdrop-blur-xl">
          <div className="flex items-start gap-4">
            <div className="mt-1 size-3 rounded-full bg-teal-500 shadow-[0_0_0_8px_rgba(20,184,166,0.12)]" />
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-slate-500">
                Path ahead
              </p>
              <p className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                From first email to durable patient flow.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LeadersSlide({ slide }: { slide: Slide }) {
  return (
    <div className="relative grid min-h-[620px] gap-10 lg:grid-cols-[0.86fr_1.14fr] lg:items-center">
      <div className="relative z-10">
        <SlideEyebrow slide={slide} />
        <h1 className="mt-6 text-5xl font-black leading-[0.94] tracking-[-0.055em] text-slate-950 sm:text-6xl lg:text-7xl">
          {slide.title}
        </h1>
        <p className="mt-7 max-w-xl text-xl leading-8 text-slate-600">
          {slide.subtitle}
        </p>
        <div className="mt-8 space-y-4">
          {slide.bullets?.map((bullet) => (
            <FeatureLine key={bullet.title} title={bullet.title}>
              {bullet.body}
            </FeatureLine>
          ))}
        </div>
      </div>

      <div className="relative z-10 grid grid-cols-2 gap-4">
        {trainerCards.map((trainer, index) => (
          <div
            key={trainer.name}
            className={`rounded-[2rem] border border-white bg-gradient-to-br ${trainer.color} p-4 shadow-[0_24px_70px_-45px_rgba(15,23,42,0.6)] ${
              index % 2 === 1 ? "translate-y-8" : ""
            }`}
          >
            <div className="aspect-[4/5] rounded-[1.5rem] border border-white/70 bg-white/[0.62] p-4">
              <div className="flex h-full flex-col justify-between">
                <div className="flex items-center justify-between">
                  <div className="grid size-14 place-items-center rounded-2xl bg-slate-950 text-lg font-black text-white">
                    {initials(trainer.name)}
                  </div>
                  <span className="rounded-full bg-white/[0.78] px-3 py-1 text-xs font-bold uppercase tracking-[0.15em] text-slate-600">
                    Trainer
                  </span>
                </div>
                <div>
                  <p className="text-2xl font-black tracking-tight text-slate-950">
                    {trainer.name}
                  </p>
                  <p className="mt-1 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {trainer.role}
                  </p>
                  <p className="mt-4 rounded-2xl bg-white/[0.76] px-4 py-3 text-sm font-bold text-slate-700">
                    {trainer.stat}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TimelineIntroSlide({ slide }: { slide: Slide }) {
  return (
    <div className="relative grid min-h-[620px] place-items-center text-center">
      <div className="relative z-10 mx-auto max-w-4xl">
        <SlideEyebrow slide={slide} />
        <h1 className="mt-6 text-5xl font-black leading-[0.94] tracking-[-0.055em] text-slate-950 sm:text-7xl lg:text-8xl">
          {slide.title}
        </h1>
        <p className="mx-auto mt-7 max-w-2xl text-xl leading-8 text-slate-600 sm:text-2xl sm:leading-9">
          {slide.subtitle}
        </p>
        <div className="mx-auto mt-10 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
          {["Day 1", "Week 1", "Week 2-4", "Month 4+"].map((label) => (
            <div
              key={label}
              className="rounded-3xl border border-slate-200 bg-white/[0.76] px-5 py-4 shadow-[0_14px_40px_-32px_rgba(15,23,42,0.55)]"
            >
              <p className="text-sm font-black uppercase tracking-[0.18em] text-slate-500">
                {label}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RoadmapSlide({
  slide,
  roadmapPosition,
}: {
  slide: Slide;
  roadmapPosition: number;
}) {
  return (
    <div className="relative grid min-h-[620px] gap-8 lg:grid-cols-[0.92fr_1.08fr] lg:items-center">
      <RoadmapStageBadge slide={slide} roadmapPosition={roadmapPosition} />

      <div className="relative z-10 max-w-3xl">
        <SlideEyebrow slide={slide} />
        <p className="mt-6 text-2xl font-black uppercase tracking-[0.18em] text-slate-400">
          {slide.phase}
        </p>
        <h1 className="mt-3 text-5xl font-black leading-[0.94] tracking-[-0.055em] text-slate-950 sm:text-6xl lg:text-7xl">
          {slide.title}
        </h1>
        <p className="mt-7 max-w-2xl text-xl leading-8 text-slate-600">
          {slide.subtitle}
        </p>
      </div>

      <div className="relative z-10 grid gap-3 sm:grid-cols-2">
        {slide.bullets?.map((bullet, index) => (
          <MilestoneCard
            key={bullet.title}
            index={index + 1}
            title={bullet.title}
            accent={slide.accent}
          >
            {bullet.body}
          </MilestoneCard>
        ))}
      </div>
    </div>
  );
}

function SplitSlide({
  slide,
  roadmapPosition,
}: {
  slide: Slide;
  roadmapPosition: number;
}) {
  return (
    <div className="relative grid min-h-[620px] gap-8 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
      <RoadmapStageBadge slide={slide} roadmapPosition={roadmapPosition} />

      <div className="relative z-10">
        <SlideEyebrow slide={slide} />
        <p className="mt-6 text-2xl font-black uppercase tracking-[0.18em] text-slate-400">
          {slide.phase}
        </p>
        <h1 className="mt-3 text-5xl font-black leading-[0.94] tracking-[-0.055em] text-slate-950 sm:text-6xl lg:text-7xl">
          {slide.title}
        </h1>
        <p className="mt-7 max-w-xl text-xl leading-8 text-slate-600">
          {slide.subtitle}
        </p>
      </div>

      <div className="relative z-10 grid gap-4 md:grid-cols-2">
        {slide.bullets?.map((packageOption, index) => (
          <div
            key={packageOption.title}
            className={`rounded-[2rem] border p-6 shadow-[0_22px_60px_-42px_rgba(15,23,42,0.58)] ${
              index === 0
                ? "border-teal-200 bg-teal-50/86"
                : "border-slate-200 bg-white/[0.86]"
            }`}
          >
            <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-500">
              Package
            </p>
            <h2 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950">
              {packageOption.title}
            </h2>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              {packageOption.body}
            </p>
            <div className="mt-8 h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full rounded-full ${
                  index === 0 ? "w-11/12 bg-teal-500" : "w-8/12 bg-slate-500"
                }`}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoadmapBackdrop({ activePosition }: { activePosition: number }) {
  const points = [
    { x: 112, y: 374 },
    { x: 252, y: 258 },
    { x: 398, y: 342 },
    { x: 548, y: 212 },
    { x: 706, y: 326 },
    { x: 842, y: 234 },
    { x: 984, y: 340 },
    { x: 1124, y: 250 },
    { x: 1268, y: 330 },
    { x: 1378, y: 220 },
  ];

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        className="absolute inset-x-[-8%] top-[5%] h-[72%] w-[116%] opacity-80"
        viewBox="0 0 1500 560"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M60 400 C170 285 225 265 330 310 C445 360 475 210 595 238 C714 266 728 380 855 300 C980 220 1028 355 1160 302 C1290 250 1340 210 1452 250"
          stroke="rgba(15,23,42,0.14)"
          strokeWidth="34"
          strokeLinecap="round"
        />
        <path
          className="road-dash"
          d="M60 400 C170 285 225 265 330 310 C445 360 475 210 595 238 C714 266 728 380 855 300 C980 220 1028 355 1160 302 C1290 250 1340 210 1452 250"
          stroke="rgba(15,23,42,0.34)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray="2 28"
        />
        {points.map((point, index) => {
          const isActive = index === activePosition;
          const isPast = index < activePosition;

          return (
            <g key={`${point.x}-${point.y}`}>
              <circle
                cx={point.x}
                cy={point.y}
                r={isActive ? 26 : 16}
                fill={isActive ? "rgba(20,184,166,0.22)" : "rgba(255,255,255,0.72)"}
              />
              <circle
                cx={point.x}
                cy={point.y}
                r={isActive ? 11 : 7}
                fill={isActive ? "rgb(20,184,166)" : isPast ? "rgb(100,116,139)" : "rgb(203,213,225)"}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RoadmapStageBadge({
  slide,
  roadmapPosition,
}: {
  slide: Slide;
  roadmapPosition: number;
}) {
  return (
    <div className="pointer-events-none absolute right-6 top-6 z-10 hidden rounded-[1.5rem] border border-white/80 bg-white/[0.72] px-5 py-4 shadow-[0_18px_50px_-36px_rgba(15,23,42,0.55)] backdrop-blur-xl lg:block">
      <p className="text-xs font-black uppercase tracking-[0.22em] text-slate-500">
        Road marker
      </p>
      <p className="mt-1 text-2xl font-black tracking-tight text-slate-950">
        {String(roadmapPosition + 1).padStart(2, "0")}
      </p>
      <div
        className={`mt-3 h-2 w-28 rounded-full bg-gradient-to-r ${accentClasses[slide.accent]}`}
      />
    </div>
  );
}

function PresentationControls({
  currentIndex,
  isFirst,
  isLast,
  onPrevious,
  onNext,
}: {
  currentIndex: number;
  isFirst: boolean;
  isLast: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <footer className="flex flex-col gap-3 rounded-[1.5rem] border border-white/75 bg-white/70 px-4 py-3 shadow-[0_18px_50px_-35px_rgba(15,23,42,0.5)] backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-semibold text-slate-500">
        Slide {currentIndex + 1} of {slides.length} · Use arrow keys or space
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPrevious}
          disabled={isFirst}
          className="rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-black text-slate-700 shadow-[0_12px_28px_-24px_rgba(15,23,42,0.7)] transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={isLast}
          className="rounded-full bg-slate-950 px-6 py-3 text-sm font-black text-white shadow-[0_16px_35px_-22px_rgba(15,23,42,0.85)] transition duration-200 hover:-translate-y-0.5 active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
        >
          {isLast ? "Done" : "Next"}
        </button>
      </div>
    </footer>
  );
}

function SlideEyebrow({ slide }: { slide: Slide }) {
  return (
    <span
      className={`inline-flex rounded-full bg-gradient-to-r px-4 py-2 text-xs font-black uppercase tracking-[0.22em] shadow-[0_14px_35px_-28px_rgba(15,23,42,0.75)] ${accentClasses[slide.accent]}`}
    >
      {slide.eyebrow}
    </span>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-slate-200 bg-white/[0.76] px-4 py-2 text-sm font-bold text-slate-700 shadow-[0_12px_30px_-26px_rgba(15,23,42,0.7)]">
      {children}
    </span>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white/[0.72] p-3">
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-lg font-black tracking-tight text-slate-950">
        {value}
      </p>
    </div>
  );
}

function FeatureLine({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-[1.5rem] border border-slate-200 bg-white/70 p-5 shadow-[0_16px_50px_-38px_rgba(15,23,42,0.56)]">
      <p className="text-lg font-black tracking-tight text-slate-950">{title}</p>
      <p className="mt-2 text-base leading-7 text-slate-600">{children}</p>
    </div>
  );
}

function MilestoneCard({
  index,
  title,
  accent,
  children,
}: {
  index: number;
  title: string;
  accent: Slide["accent"];
  children: ReactNode;
}) {
  return (
    <div className="rounded-[1.5rem] border border-white/80 bg-white/[0.82] p-5 shadow-[0_18px_55px_-40px_rgba(15,23,42,0.62)] backdrop-blur-xl transition duration-300 hover:-translate-y-1 active:translate-y-[1px]">
      <div className="flex items-start gap-4">
        <div
          className={`grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-r text-sm font-black ${accentClasses[accent]}`}
        >
          {index}
        </div>
        <div>
          <p className="text-xl font-black tracking-tight text-slate-950">
            {title}
          </p>
          <p className="mt-2 text-base leading-7 text-slate-600">{children}</p>
        </div>
      </div>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
}
