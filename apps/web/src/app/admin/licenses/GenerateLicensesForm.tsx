"use client";

import { useState, useTransition } from "react";
import { generateLicenses } from "./actions";

const COUNT_OPTIONS = [1, 5, 10] as const;

export function GenerateLicensesForm() {
  const [count, setCount] = useState<number>(5);
  const [pending, startTransition] = useTransition();
  const [justMinted, setJustMinted] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  function onGenerate() {
    setCopied(false);
    startTransition(async () => {
      const keys = await generateLicenses(count);
      setJustMinted(keys);
    });
  }

  function onCopy() {
    navigator.clipboard.writeText(justMinted.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col items-end gap-3">
      <div className="flex items-stretch overflow-hidden rounded-md border border-gray-700">
        <div className="flex divide-x divide-gray-700">
          {COUNT_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setCount(n)}
              disabled={pending}
              className={`px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                count === n
                  ? "bg-orange-500 text-white"
                  : "bg-gray-900 text-gray-300 hover:bg-gray-800"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={pending}
          className="border-l border-gray-700 bg-gray-950 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
        >
          {pending ? "Generating…" : `Generate ${count === 1 ? "key" : "keys"}`}
        </button>
      </div>

      {justMinted.length > 0 ? (
        <div className="w-full min-w-[280px] max-w-md rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-semibold text-amber-300">
              Copy now — keys won&rsquo;t be shown again and expire in 5 minutes
              if unused.
            </p>
            <button
              type="button"
              onClick={onCopy}
              className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/10 cursor-pointer"
            >
              {copied ? "Copied" : "Copy all"}
            </button>
          </div>
          <ul className="mt-3 space-y-1 font-mono text-xs text-amber-100">
            {justMinted.map((k) => (
              <li
                key={k}
                className="select-all break-all rounded bg-amber-500/5 px-2 py-1"
              >
                {k}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
