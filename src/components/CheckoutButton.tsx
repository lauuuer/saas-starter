"use client";

import { useState } from "react";

export function CheckoutButton({ label = "Subscribe now" }: { label?: string }) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    const res = await fetch("/api/stripe/checkout", { method: "POST" });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else setLoading(false);
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="rounded-md bg-[var(--accent)] px-6 py-3 font-medium text-black hover:opacity-90 transition disabled:opacity-50"
    >
      {loading ? "Redirecting..." : label}
    </button>
  );
}
