"use client";

import { useState, useTransition } from "react";
import { revokeLicense } from "./actions";

interface Props {
  licenseId: string;
  keyPrefix: string;
  boundLabel: string | null;
}

export function RevokeLicenseButton({ licenseId, keyPrefix, boundLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        await revokeLicense(licenseId);
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Revoke failed");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer text-xs text-red-600 hover:underline"
      >
        Revoke
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close dialog"
            onClick={() => !pending && setOpen(false)}
            className="absolute inset-0 bg-black/60 cursor-default"
          />
          <div className="relative w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-900 p-6 text-white shadow-2xl">
            <h3 className="mb-2 text-base font-semibold">Revoke license?</h3>
            <p className="mb-1 text-sm text-gray-300">
              <span className="font-mono">{keyPrefix}-…</span>
            </p>
            <p className="mb-4 text-sm text-gray-400">
              {boundLabel
                ? `Currently bound to ${boundLabel}. They will lose access on their next request.`
                : "This key is unredeemed. Revoking it prevents anyone from claiming it."}{" "}
              The row will be deleted from the database. This cannot be undone.
            </p>

            {error ? (
              <p className="mb-3 text-xs text-red-400">{error}</p>
            ) : null}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className="flex-1 cursor-pointer rounded-lg border border-gray-700 py-2 text-sm text-gray-300 transition-colors hover:border-gray-500 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={pending}
                className="flex-1 cursor-pointer rounded-lg bg-red-600 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? "Revoking…" : "Revoke"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
