"use client";

import { useState } from "react";
import type { AcceleratorDiscount } from "@/lib/offerings-discounts";

export default function DiscountsClient({
  initialDiscounts,
}: {
  initialDiscounts: AcceleratorDiscount[];
}) {
  const [discounts, setDiscounts] = useState(initialDiscounts);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);

  const [slug, setSlug] = useState("");
  const [price, setPrice] = useState("");
  const [badge, setBadge] = useState("");

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug || !price || !badge) return;

    setLoading(true);
    try {
      const res = await fetch("/api/agency/discounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, acceleratorPrice: Number(price), badge }),
      });

      if (!res.ok) throw new Error(await res.text());

      const d: AcceleratorDiscount = {
        slug: slug.toLowerCase(),
        acceleratorPrice: Number(price),
        badge,
        createdAt: new Date().toISOString(),
      };

      setDiscounts((prev) => {
        const p = prev.filter((o) => o.slug !== d.slug);
        return [d, ...p].sort((a, b) =>
          (b.createdAt || "").localeCompare(a.createdAt || "")
        );
      });

      setAdding(false);
      setSlug("");
      setPrice("");
      setBadge("");
    } catch (err) {
      alert("Failed to save discount: " + String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (slug: string) => {
    if (!confirm(`Are you sure you want to delete /${slug}?`)) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/agency/discounts?slug=${slug}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());

      setDiscounts((prev) => prev.filter((o) => o.slug !== slug));
    } catch (err) {
      alert("Failed to delete discount: " + String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-white/10 pb-4">
        <h2 className="text-lg font-semibold tracking-tight text-white">
          Active Promos
        </h2>
        <button
          onClick={() => setAdding((p) => !p)}
          className="rounded-full bg-indigo-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-400"
        >
          {adding ? "Cancel" : "Add New URL"}
        </button>
      </div>

      {adding && (
        <form
          onSubmit={handleSave}
          className="grid gap-4 rounded-xl border border-indigo-400/30 bg-indigo-500/10 p-5 shadow-lg shadow-indigo-950/20"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                URL Slug
              </label>
              <div className="flex items-center rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm focus-within:border-indigo-400/50">
                <span className="text-slate-500">/</span>
                <input
                  required
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="liz"
                  className="w-full bg-transparent text-white outline-none placeholder:text-slate-600"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Discount Price
              </label>
              <div className="flex items-center rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm focus-within:border-indigo-400/50">
                <span className="text-slate-500">$</span>
                <input
                  required
                  type="number"
                  min="0"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="1000"
                  className="w-full bg-transparent text-white outline-none placeholder:text-slate-600"
                />
                <span className="text-slate-500">/mo</span>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Badge Text
              </label>
              <input
                required
                type="text"
                value={badge}
                onChange={(e) => setBadge(e.target.value)}
                placeholder="LIZ EXCLUSIVE"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-indigo-400/50 placeholder:text-slate-600"
              />
            </div>
          </div>
          <div className="mt-2 flex justify-end">
            <button
              disabled={loading}
              type="submit"
              className="rounded-lg bg-indigo-500 px-6 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
            >
              {loading ? "Saving..." : "Save Discount"}
            </button>
          </div>
        </form>
      )}

      {discounts.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          No active discount URLs.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {discounts.map((d) => (
            <div
              key={d.slug}
              className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-4 transition hover:bg-white/10"
            >
              <div>
                <a
                  href={`/${d.slug}`}
                  target="_blank"
                  className="font-mono text-sm font-medium text-emerald-300 hover:underline"
                >
                  /{d.slug}
                </a>
                <div className="mt-2 flex items-center gap-3 text-xs text-slate-400">
                  <span>${d.acceleratorPrice}/mo</span>
                  <span>·</span>
                  <span className="rounded bg-white/10 px-1.5 py-0.5 uppercase tracking-widest text-slate-300">
                    {d.badge}
                  </span>
                </div>
              </div>

              <button
                disabled={loading}
                onClick={() => handleDelete(d.slug)}
                className="rounded-full bg-rose-500/10 p-2 text-rose-400 transition hover:bg-rose-500/20 disabled:opacity-50"
                title="Delete discount"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
