"use client";

import { useEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";
import { ZACK_AVATAR_DATA_URL } from "@/lib/zack-avatar";

const DEFAULT_INSTRUCTIONS = `Analyze this video ad. Break down the core marketing message into a minimum 5-slide carousel framework (1. Hook, 2. Problem Agitation, 3. Solution/Mechanism (this can be multiple slides if needed), 4. Social Proof, 5. CTA). Write punchy, concise copy for each slide.`;

const NAME = "Zack Herman";
const HANDLE = "@itszackherman";
const SLIDE_DIVIDER = "\n\n---\n\n";

const SYSTEM_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

type Background = "black" | "white";

type Block =
  | { type: "text"; text: string }
  | { type: "bullets"; items: string[] };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Split the combined script into individual slide bodies. */
function parseSlides(script: string): string[] {
  return script
    .split(/^[ \t]*---[ \t]*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;

/** Group a slide body into paragraph + bullet-list blocks. */
function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  for (const line of body.split("\n")) {
    const bullet = line.match(BULLET_RE);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last && last.type === "bullets") last.items.push(bullet[1]);
      else blocks.push({ type: "bullets", items: [bullet[1]] });
    } else {
      if (last && last.type === "text") last.text += "\n" + line;
      else blocks.push({ type: "text", text: line });
    }
  }
  return blocks.filter(
    (b) => (b.type === "text" ? b.text.trim() !== "" : b.items.length > 0)
  );
}

/** Render inline **bold** markup. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i} style={{ fontWeight: 700 }}>
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function fontSizeFor(body: string) {
  const plain = body.replace(/\*\*/g, "").replace(/^\s*[-*•]\s+/gm, "");
  const len = plain.length;
  if (len <= 70) return { main: 60, bullet: 50 };
  if (len <= 140) return { main: 52, bullet: 44 };
  if (len <= 220) return { main: 44, bullet: 38 };
  if (len <= 320) return { main: 38, bullet: 34 };
  return { main: 32, bullet: 30 };
}

/** Fixed 1080x1350 (4:5) card. Inline styles keep export deterministic. */
function SlideCard({ body, bg }: { body: string; bg: Background }) {
  const isBlack = bg === "black";
  const bgColor = isBlack ? "#000000" : "#ffffff";
  const textColor = isBlack ? "#ffffff" : "#0f1419";
  const handleColor = isBlack ? "#71767b" : "#536471";
  const ringColor = isBlack ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.1)";

  const blocks = parseBlocks(body);
  const { main, bullet } = fontSizeFor(body);

  return (
    <div
      style={{
        width: 1080,
        height: 1350,
        backgroundColor: bgColor,
        color: textColor,
        fontFamily: SYSTEM_FONT,
        boxSizing: "border-box",
        padding: "0 120px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={ZACK_AVATAR_DATA_URL}
          alt={NAME}
          width={112}
          height={112}
          style={{
            width: 112,
            height: 112,
            borderRadius: "50%",
            objectFit: "cover",
            border: `1px solid ${ringColor}`,
            flexShrink: 0,
            display: "block",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 40, fontWeight: 700, lineHeight: 1.1 }}>
              {NAME}
            </span>
            <VerifiedBadge size={34} />
          </div>
          <span
            style={{
              fontSize: 34,
              color: handleColor,
              lineHeight: 1.2,
              marginTop: 2,
            }}
          >
            {HANDLE}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 52 }}>
        {blocks.map((block, i) => {
          const spacing = i === blocks.length - 1 ? 0 : 32;
          if (block.type === "bullets") {
            return (
              <div key={i} style={{ marginBottom: spacing, paddingLeft: 44 }}>
                {block.items.map((item, j) => (
                  <div
                    key={j}
                    style={{
                      display: "flex",
                      gap: 24,
                      fontSize: bullet,
                      lineHeight: 1.35,
                      marginBottom: j === block.items.length - 1 ? 0 : 22,
                    }}
                  >
                    <span aria-hidden>•</span>
                    <span>
                      <RichText text={item} />
                    </span>
                  </div>
                ))}
              </div>
            );
          }
          return (
            <p
              key={i}
              style={{
                margin: 0,
                marginBottom: spacing,
                fontSize: main,
                lineHeight: 1.25,
                fontWeight: 400,
                whiteSpace: "pre-wrap",
              }}
            >
              <RichText text={block.text} />
            </p>
          );
        })}
      </div>
    </div>
  );
}

function VerifiedBadge({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 22 22"
      width={size}
      height={size}
      style={{ flexShrink: 0 }}
      aria-hidden
    >
      <path
        fill="#1d9bf0"
        d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816z"
      />
      <path
        fill="#ffffff"
        d="M9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"
      />
    </svg>
  );
}

/** Responsive, scaled-down preview of a full-size SlideCard. */
function SlidePreview({ body, bg }: { body: string; bg: Background }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = width > 0 ? width / 1080 : 0;

  return (
    <div
      ref={ref}
      style={{
        width: "100%",
        aspectRatio: "4 / 5",
        position: "relative",
        overflow: "hidden",
        borderRadius: 12,
      }}
      className="border border-neutral-800"
    >
      {scale > 0 && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            transformOrigin: "top left",
            transform: `scale(${scale})`,
          }}
        >
          <SlideCard body={body} bg={bg} />
        </div>
      )}
    </div>
  );
}

export default function CarouselGeneratorClient() {
  const [transcript, setTranscript] = useState("");
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [minSlides, setMinSlides] = useState(5);
  const [bg, setBg] = useState<Background>("black");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [script, setScript] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);

  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scriptRef = useRef<HTMLTextAreaElement>(null);
  const slides = parseSlides(script);

  function applyEdit(
    transform: (sel: { value: string; start: number; end: number }) => {
      value: string;
      selStart: number;
      selEnd: number;
    }
  ) {
    const el = scriptRef.current;
    if (!el) return;
    const { value, selStart, selEnd } = transform({
      value: script,
      start: el.selectionStart,
      end: el.selectionEnd,
    });
    setScript(value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  }

  function wrapBold() {
    applyEdit(({ value, start, end }) => {
      const sel = value.slice(start, end) || "bold";
      const v = value.slice(0, start) + "**" + sel + "**" + value.slice(end);
      return { value: v, selStart: start + 2, selEnd: start + 2 + sel.length };
    });
  }

  function addBullet() {
    applyEdit(({ value, start }) => {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const v = value.slice(0, lineStart) + "- " + value.slice(lineStart);
      return { value: v, selStart: start + 2, selEnd: start + 2 };
    });
  }

  function addSlideBreak() {
    applyEdit(({ value, end }) => {
      const ins = "\n\n---\n\n";
      const v = value.slice(0, end) + ins + value.slice(end);
      const pos = end + ins.length;
      return { value: v, selStart: pos, selEnd: pos };
    });
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!transcript.trim()) return;

    setLoading(true);
    setError(null);
    setScript("");

    try {
      const res = await fetch("/api/agency/carousel/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: transcript.trim(),
          instructions: instructions.trim(),
          minSlides,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      const list: string[] = data.slides ?? [];
      setScript(
        data.script ?? list.map((s) => s.trim()).join(SLIDE_DIVIDER)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  async function downloadOne(index: number) {
    const node = cardRefs.current[index];
    if (!node) return;
    const dataUrl = await toPng(node, {
      width: 1080,
      height: 1350,
      pixelRatio: 2,
      cacheBust: true,
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `carousel-slide-${index + 1}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function handleDownloadFirst() {
    setError(null);
    setDownloading("first");
    try {
      await downloadOne(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setDownloading(null);
    }
  }

  async function handleDownloadAll() {
    setError(null);
    setDownloading("all");
    try {
      for (let i = 0; i < slides.length; i++) {
        await downloadOne(i);
        await sleep(300);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleGenerate} className="space-y-4">
        <div>
          <label htmlFor="transcript" className="block text-sm text-neutral-400">
            Transcript
          </label>
          <textarea
            id="transcript"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Paste the video ad transcript here…"
            rows={7}
            className="mt-1.5 w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-3 text-base text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="minSlides" className="block text-sm text-neutral-400">
              Minimum slides
            </label>
            <select
              id="minSlides"
              value={minSlides}
              onChange={(e) => setMinSlides(Number(e.target.value))}
              className="mt-1.5 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-3 text-base text-neutral-100 focus:border-neutral-600 focus:outline-none"
            >
              {[5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="block text-sm text-neutral-400">Background</span>
            <div className="mt-1.5 flex rounded-lg border border-neutral-800 bg-neutral-900 p-1">
              {(["black", "white"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setBg(opt)}
                  className={`flex-1 rounded-md py-2 text-sm capitalize transition ${
                    bg === opt
                      ? "bg-neutral-100 text-neutral-950"
                      : "text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
            Edit breakdown prompt
          </summary>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={5}
            className="mt-2 w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-3 text-sm text-neutral-200 focus:border-neutral-600 focus:outline-none"
          />
        </details>

        <button
          type="submit"
          disabled={loading || !transcript.trim()}
          className="w-full rounded-lg bg-neutral-100 py-3.5 text-base font-medium text-neutral-950 disabled:opacity-40"
        >
          {loading ? "Breaking it down…" : "Break into slides"}
        </button>
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {slides.length > 0 && (
        <div className="space-y-8">
          {/* Copy editor — all slides in one place, focus on the words first. */}
          <div className="space-y-2 border-t border-neutral-800 pt-6">
            <div className="flex items-center justify-between">
              <label
                htmlFor="script"
                className="text-sm font-medium text-neutral-300"
              >
                Carousel copy
              </label>
              <span className="text-sm text-neutral-500">
                {slides.length} slides
              </span>
            </div>
            <p className="text-xs text-neutral-500">
              One slide per block. Select text and use the buttons, or type{" "}
              <code className="text-neutral-400">**bold**</code>,{" "}
              <code className="text-neutral-400">-</code> for bullets, and{" "}
              <code className="text-neutral-400">---</code> between slides.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={wrapBold}
                className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-neutral-800"
              >
                Bold
              </button>
              <button
                type="button"
                onClick={addBullet}
                className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
              >
                • Bullet
              </button>
              <button
                type="button"
                onClick={addSlideBreak}
                className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
              >
                + New slide
              </button>
            </div>
            <textarea
              id="script"
              ref={scriptRef}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={18}
              spellCheck
              className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-3 font-mono text-sm leading-relaxed text-neutral-100 focus:border-neutral-600 focus:outline-none"
            />
          </div>

          {/* Previews + export, kept separate so the copy stays the focus. */}
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-sm font-medium text-neutral-300">
                Preview
              </p>
              <button
                type="button"
                onClick={handleDownloadFirst}
                disabled={downloading !== null}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-900 disabled:opacity-40"
              >
                {downloading === "first" ? "Saving…" : "Download slide 1"}
              </button>
              <button
                type="button"
                onClick={handleDownloadAll}
                disabled={downloading !== null}
                className="rounded-lg bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-950 disabled:opacity-40"
              >
                {downloading === "all"
                  ? "Saving…"
                  : `Download all (${slides.length})`}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {slides.map((body, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-neutral-500">
                      Slide {i + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => downloadOne(i)}
                      disabled={downloading !== null}
                      className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline disabled:opacity-40"
                    >
                      Download
                    </button>
                  </div>
                  <SlidePreview body={body} bg={bg} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Offscreen full-size cards used for crisp PNG export. */}
      <div
        aria-hidden
        style={{ position: "fixed", top: 0, left: -100000, pointerEvents: "none" }}
      >
        {slides.map((body, i) => (
          <div
            key={i}
            ref={(el) => {
              cardRefs.current[i] = el;
            }}
          >
            <SlideCard body={body} bg={bg} />
          </div>
        ))}
      </div>
    </div>
  );
}
