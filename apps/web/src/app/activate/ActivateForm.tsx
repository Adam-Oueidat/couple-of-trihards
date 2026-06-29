"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ActivateForm() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Activation failed");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        aria-label="License key"
        placeholder="LIC-XXXX-XXXX-XXXX"
        className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono uppercase tracking-wider"
        autoFocus
        required
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button
        type="submit"
        disabled={submitting || key.trim().length === 0}
        className="w-full cursor-pointer rounded-md bg-black px-3 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Activating…" : "Activate"}
      </button>
    </form>
  );
}
