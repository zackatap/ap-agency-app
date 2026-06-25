"use client";

import { useState } from "react";

export default function HooksGeneratorClient() {
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hooks, setHooks] = useState<string[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim()) return;

    setLoading(true);
    setError(null);
    setHooks([]);

    try {
      const res = await fetch("/api/agency/hooks/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim(), count }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      setHooks(data.hooks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  async function copyText(text: string, idx: number | null) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      setError("Could not copy — try selecting manually");
    }
  }

  const allHooksText = hooks.map((h, i) => `${i + 1}. ${h}`).join("\n\n");

  return (
    <div className="space-y-6">
      <form onSubmit={handleGenerate} className="space-y-4">
        <div>
          <label htmlFor="topic" className="block text-sm text-neutral-400">
            Topic
          </label>
          <input
            id="topic"
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. why raw video beats polished ads"
            className="mt-1.5 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-3 text-base text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            autoComplete="off"
            enterKeyHint="go"
          />
        </div>

        <div>
          <label htmlFor="count" className="block text-sm text-neutral-400">
            How many hooks
          </label>
          <select
            id="count"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="mt-1.5 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-3 text-base text-neutral-100 focus:border-neutral-600 focus:outline-none"
          >
            {[5, 10, 15, 20].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={loading || !topic.trim()}
          className="w-full rounded-lg bg-neutral-100 py-3.5 text-base font-medium text-neutral-950 disabled:opacity-40"
        >
          {loading ? "Generating…" : "Generate hooks"}
        </button>
      </form>

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {hooks.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-neutral-500">{hooks.length} hooks</p>
            <button
              type="button"
              onClick={() => copyText(allHooksText, -1)}
              className="text-sm text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
            >
              {copiedIdx === -1 ? "Copied" : "Copy all"}
            </button>
          </div>

          <ol className="divide-y divide-neutral-800 border-y border-neutral-800">
            {hooks.map((hook, i) => (
              <li key={i} className="py-4">
                <p className="text-[15px] leading-relaxed text-neutral-100">
                  {hook}
                </p>
                <button
                  type="button"
                  onClick={() => copyText(hook, i)}
                  className="mt-2 text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
                >
                  {copiedIdx === i ? "Copied" : "Copy"}
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      <details className="text-sm text-neutral-600">
        <summary className="cursor-pointer text-neutral-500 hover:text-neutral-400">
          Add to iPhone home screen
        </summary>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-neutral-500">
          <li>Open this page in Safari</li>
          <li>Tap Share → Add to Home Screen</li>
          <li>Name it &quot;Hooks&quot; (or AP Tools)</li>
        </ol>
      </details>
    </div>
  );
}
