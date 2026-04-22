"use client";

import { useEffect, useMemo, useState } from "react";
import "./pulse.css";

type Step = "welcome" | "rating" | "good" | "bad" | "done";
type IssueTag = "Quality" | "Quantity" | "Service" | "ROI";

const ISSUE_OPTIONS: { id: IssueTag; label: string; icon: string }[] = [
  { id: "Quality", label: "Quality", icon: "✨" },
  { id: "Quantity", label: "Quantity", icon: "📊" },
  { id: "Service", label: "Service", icon: "🤝" },
  { id: "ROI", label: "ROI", icon: "💰" },
];

/** Maps 0–10 to an emoji + descriptor + theme color. */
function moodFor(score: number) {
  if (score <= 1)
    return { emoji: "😡", label: "Furious", hue: 0, accent: "#ef4444" };
  if (score <= 3)
    return { emoji: "😠", label: "Frustrated", hue: 18, accent: "#f97316" };
  if (score <= 5)
    return { emoji: "😕", label: "Meh", hue: 42, accent: "#f59e0b" };
  if (score === 6)
    return { emoji: "🙂", label: "Okay", hue: 75, accent: "#a3e635" };
  if (score <= 8)
    return { emoji: "😄", label: "Happy", hue: 140, accent: "#22c55e" };
  if (score === 9)
    return { emoji: "😁", label: "Thrilled", hue: 160, accent: "#10b981" };
  return { emoji: "🤩", label: "Insanely Happy", hue: 180, accent: "#06b6d4" };
}

export default function PulseForm({
  initialClientName,
  locationId,
  cid,
}: {
  initialClientName: string;
  locationId: string;
  cid: string;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [clientName, setClientName] = useState(initialClientName);
  const [score, setScore] = useState(7);
  const [hasMoved, setHasMoved] = useState(false);
  const [wins, setWins] = useState("");
  const [issues, setIssues] = useState<IssueTag[]>([]);
  const [issueDetail, setIssueDetail] = useState("");
  const [wantsZoom, setWantsZoom] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const mood = useMemo(() => moodFor(score), [score]);
  const isGood = score >= 6;

  // Trigger a brief "bounce" each time the score changes by forcing a key.
  const [bouncer, setBouncer] = useState(0);
  useEffect(() => {
    setBouncer((b) => b + 1);
  }, [score]);

  // Enter advances steps. Inside a textarea, Enter stays a newline and
  // Cmd/Ctrl+Enter advances instead so free-form answers still work normally.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter") return;
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTextarea = tag === "TEXTAREA";
      const isButton =
        tag === "BUTTON" ||
        (target instanceof HTMLElement && target.getAttribute("role") === "button");
      // Let buttons handle their own Enter (native click on focused button).
      if (isButton) return;
      // In a textarea, only Cmd/Ctrl+Enter advances; plain Enter = newline.
      if (isTextarea && !(e.metaKey || e.ctrlKey)) return;

      e.preventDefault();
      if (step === "welcome") {
        setStep("rating");
      } else if (step === "rating") {
        setStep(score >= 6 ? "good" : "bad");
      } else if (step === "good" || step === "bad") {
        if (!submitting) void submit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `submit` is stable enough for this scope; we re-bind on relevant state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, score, submitting, isGood, clientName, wins, issues, issueDetail, wantsZoom]);

  function toggleIssue(tag: IssueTag) {
    setIssues((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/pulse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: clientName.trim() || null,
          locationId: locationId || null,
          cid: cid || null,
          score,
          sentiment: isGood ? "good" : "bad",
          wins: isGood ? wins.trim() || null : null,
          issues: isGood ? [] : issues,
          issueDetail: isGood ? null : issueDetail.trim() || null,
          wantsZoom: isGood ? false : wantsZoom,
          submittedAt: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      setStep("done");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Something went wrong"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="pulse-root"
      style={
        {
          // Background subtly shifts with mood once the user starts rating
          ["--pulse-accent" as string]:
            step === "welcome" ? "#8b5cf6" : mood.accent,
        } as React.CSSProperties
      }
    >
      {/* Floating background blobs */}
      <div className="pulse-blob pulse-blob-1" />
      <div className="pulse-blob pulse-blob-2" />
      <div className="pulse-blob pulse-blob-3" />

      <main className="pulse-main">
        <header className="pulse-header">
          <div className="pulse-badge">
            <span className="pulse-dot" /> Monthly Pulse
          </div>
          <ProgressDots step={step} />
        </header>

        {step === "welcome" && (
          <section className="pulse-card pulse-fade-in" key="welcome">
            <div className="pulse-hero-emoji">💜</div>
            <h1 className="pulse-title">How are we doing?</h1>
            <p className="pulse-subtitle">
              Your feedback shapes everything we do. This takes about 30
              seconds — we promise it&apos;s not boring.
            </p>
            <label className="pulse-label" htmlFor="clientName">
              Business name{" "}
              <span className="pulse-label-muted">(optional)</span>
            </label>
            <input
              id="clientName"
              type="text"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Your practice name"
              className="pulse-input"
            />
            <button
              type="button"
              onClick={() => setStep("rating")}
              className="pulse-primary"
            >
              Let&apos;s go <span aria-hidden>→</span>
            </button>
          </section>
        )}

        {step === "rating" && (
          <section className="pulse-card pulse-fade-in" key="rating">
            <h2 className="pulse-title">
              On a scale of 0–10, how happy are you this month?
            </h2>
            <p className="pulse-subtitle">
              Drag the slider. No wrong answers — we want the real thing.
            </p>

            <div className="pulse-mood-stage">
              <div className="pulse-mood-emoji" key={bouncer}>
                {mood.emoji}
              </div>
              <div className="pulse-mood-label" style={{ color: mood.accent }}>
                {mood.label}
              </div>
              <div className="pulse-mood-score" style={{ color: mood.accent }}>
                {score}
                <span className="pulse-mood-score-max">/10</span>
              </div>
            </div>

            <div className="pulse-slider-wrap">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={score}
                onChange={(e) => {
                  setScore(Number(e.target.value));
                  setHasMoved(true);
                }}
                className="pulse-slider"
                style={
                  {
                    ["--pulse-track-fill" as string]: `${(score / 10) * 100}%`,
                  } as React.CSSProperties
                }
                aria-label="Satisfaction score"
              />
              <div className="pulse-slider-ends">
                <span>😡 Extremely angry</span>
                <span>Insanely happy 🤩</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStep(isGood ? "good" : "bad")}
              className="pulse-primary"
              disabled={!hasMoved && score === 7}
              style={{ opacity: !hasMoved && score === 7 ? 0.7 : 1 }}
            >
              Continue <span aria-hidden>→</span>
            </button>
            <p className="pulse-hint">
              {hasMoved || score !== 7
                ? "Locked in? Hit continue — or press Enter."
                : "Move the slider when you're ready."}
            </p>
          </section>
        )}

        {step === "good" && (
          <section className="pulse-card pulse-fade-in" key="good">
            <div className="pulse-celebrate">
              <Confetti />
              <div className="pulse-hero-emoji">{mood.emoji}</div>
            </div>
            <h2 className="pulse-title">That&apos;s what we love to hear!</h2>
            <p className="pulse-subtitle">
              Help us keep the good stuff coming.
            </p>

            <label className="pulse-label" htmlFor="wins">
              Share wins or shout-outs
            </label>
            <p className="pulse-label-hint">
              Collections, a team member to highlight, or anything we can do
              even better?
            </p>
            <textarea
              id="wins"
              value={wins}
              onChange={(e) => setWins(e.target.value)}
              placeholder="e.g. Collections up 22% this month. Sarah on the team was amazing…"
              className="pulse-textarea"
              rows={5}
            />

            {submitError && <p className="pulse-error">{submitError}</p>}

            <div className="pulse-actions">
              <button
                type="button"
                onClick={() => setStep("rating")}
                className="pulse-ghost"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="pulse-primary"
              >
                {submitting ? "Sending…" : "Submit feedback"}
              </button>
            </div>
          </section>
        )}

        {step === "bad" && (
          <section className="pulse-card pulse-fade-in" key="bad">
            <div className="pulse-empathy">
              <RainDrops />
              <div className="pulse-hero-emoji pulse-emoji-sway">
                {mood.emoji}
              </div>
            </div>
            <h2 className="pulse-title">We hear you — let&apos;s fix it.</h2>
            <p className="pulse-subtitle">
              Tell us where we&apos;re falling short. Be as blunt as you want.
            </p>

            <label className="pulse-label">What&apos;s off?</label>
            <p className="pulse-label-hint">Select all that apply.</p>
            <div className="pulse-chip-grid">
              {ISSUE_OPTIONS.map((opt) => {
                const active = issues.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => toggleIssue(opt.id)}
                    className={`pulse-chip ${active ? "pulse-chip-active" : ""}`}
                    aria-pressed={active}
                  >
                    <span className="pulse-chip-icon" aria-hidden>
                      {opt.icon}
                    </span>
                    <span>{opt.label}</span>
                    {active && (
                      <span className="pulse-chip-check" aria-hidden>
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <label className="pulse-label" htmlFor="issueDetail">
              What&apos;s going on?
            </label>
            <textarea
              id="issueDetail"
              value={issueDetail}
              onChange={(e) => setIssueDetail(e.target.value)}
              placeholder="The more detail, the better we can fix it."
              className="pulse-textarea"
              rows={5}
            />

            <label className="pulse-check">
              <input
                type="checkbox"
                checked={wantsZoom}
                onChange={(e) => setWantsZoom(e.target.checked)}
              />
              <span className="pulse-check-box" aria-hidden>
                <span className="pulse-check-mark">✓</span>
              </span>
              <span className="pulse-check-label">
                Can we hop on Zoom to talk this through?
              </span>
            </label>

            {submitError && <p className="pulse-error">{submitError}</p>}

            <div className="pulse-actions">
              <button
                type="button"
                onClick={() => setStep("rating")}
                className="pulse-ghost"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="pulse-primary"
              >
                {submitting ? "Sending…" : "Submit feedback"}
              </button>
            </div>
          </section>
        )}

        {step === "done" && (
          <section className="pulse-card pulse-fade-in" key="done">
            {isGood && <Confetti />}
            <div className="pulse-hero-emoji pulse-emoji-pop">
              {isGood ? "🎉" : "🤝"}
            </div>
            <h2 className="pulse-title">
              {isGood ? "Thank you!" : "Got it — thank you."}
            </h2>
            <p className="pulse-subtitle">
              {isGood
                ? "We'll keep stacking wins. Talk soon."
                : wantsZoom
                  ? "Your account lead will reach out to schedule a Zoom."
                  : "Your account lead will review this personally."}
            </p>

            {isGood && (
              <>
                <div className="pulse-review-blurb">
                  <div className="pulse-review-icon" aria-hidden>
                    ⭐️
                  </div>
                  <div>
                    <div className="pulse-review-title">
                      One small favor — we love reviews
                    </div>
                    <p className="pulse-review-body">
                      If you haven&apos;t yet, a quick review means the world
                      to our team. It takes 30 seconds and helps more
                      practices find us.
                    </p>
                    <div className="pulse-review-buttons">
                      <a
                        className="pulse-review-button pulse-review-google"
                        href="https://g.page/r/CTRJsuGb6U7ZEBI/review"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span className="pulse-review-logo" aria-hidden>
                          <GoogleGlyph />
                        </span>
                        Review on Google
                      </a>
                      <a
                        className="pulse-review-button pulse-review-facebook"
                        href="https://www.facebook.com/automatedpractice/reviews"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span className="pulse-review-logo" aria-hidden>
                          <FacebookGlyph />
                        </span>
                        Review on Facebook
                      </a>
                    </div>
                  </div>
                </div>

                <div className="pulse-referral">
                  <div className="pulse-referral-badge">
                    <span aria-hidden>💸</span> Referral Program
                  </div>
                  <div className="pulse-referral-title">
                    Make your marketing free — or get paid to refer.
                  </div>
                  <p className="pulse-referral-body">
                    Love working with us? Send practices our way. Our top
                    referrer doesn&apos;t pay us a dime —{" "}
                    <strong>we pay him over $2,500/month</strong>. Earn
                    $150/mo per active client you refer, and they get $500 in
                    ad spend to start.
                  </p>
                  <a
                    className="pulse-referral-cta"
                    href="https://referralkit.com/join/automated-practice"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Join the referral program
                    <span aria-hidden>→</span>
                  </a>
                </div>
              </>
            )}
          </section>
        )}

        <footer className="pulse-footer">
          <span>Automated Practice · Monthly Pulse</span>
        </footer>
      </main>
    </div>
  );
}

function ProgressDots({ step }: { step: Step }) {
  const order: Step[] = ["welcome", "rating", "good", "done"];
  const badOrder: Step[] = ["welcome", "rating", "bad", "done"];
  const active = order.includes(step) ? order : badOrder;
  const idx = active.indexOf(step);
  return (
    <div className="pulse-progress" aria-hidden>
      {active.map((s, i) => (
        <span
          key={s}
          className={`pulse-progress-dot ${i <= idx ? "pulse-progress-active" : ""}`}
        />
      ))}
    </div>
  );
}

function Confetti() {
  const pieces = Array.from({ length: 40 });
  return (
    <div className="pulse-confetti" aria-hidden>
      {pieces.map((_, i) => (
        <span
          key={i}
          className="pulse-confetti-piece"
          style={
            {
              ["--c-left" as string]: `${Math.random() * 100}%`,
              ["--c-delay" as string]: `${Math.random() * 0.8}s`,
              ["--c-duration" as string]: `${1.6 + Math.random() * 1.4}s`,
              ["--c-rotate" as string]: `${Math.random() * 360}deg`,
              ["--c-bg" as string]: [
                "#f472b6",
                "#fbbf24",
                "#34d399",
                "#60a5fa",
                "#a78bfa",
                "#f87171",
              ][i % 6],
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function RainDrops() {
  const pieces = Array.from({ length: 14 });
  return (
    <div className="pulse-rain" aria-hidden>
      {pieces.map((_, i) => (
        <span
          key={i}
          className="pulse-rain-drop"
          style={
            {
              ["--r-left" as string]: `${Math.random() * 100}%`,
              ["--r-delay" as string]: `${Math.random() * 1.2}s`,
              ["--r-duration" as string]: `${1.2 + Math.random() * 0.8}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function FacebookGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#1877F2"
        d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.412c0-3.016 1.792-4.682 4.533-4.682 1.313 0 2.686.235 2.686.235v2.965h-1.513c-1.49 0-1.956.93-1.956 1.886v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"
      />
    </svg>
  );
}
