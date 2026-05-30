"use client";

import { useState } from "react";

export function PortalButton() {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else setLoading(false);
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="rounded-md border border-neutral-700 px-5 py-2.5 text-sm font-medium hover:border-neutral-500 transition disabled:opacity-50"
    >
      {loading ? "Abrindo..." : "Gerenciar assinatura"}
    </button>
  );
}
