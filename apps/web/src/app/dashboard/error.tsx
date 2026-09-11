"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";

/**
 * What the athlete sees when the dashboard's server render throws.
 *
 * Before this existed there was no error boundary anywhere in the app, so any
 * throw inside the streamed <Suspense> subtree escaped to Next's built-in
 * handler — the unbranded "A server error occurred" screen, with no way back
 * other than the browser's reload button. Suspense catches pending promises,
 * not rejected ones; this file is what catches the rejection.
 *
 * It deliberately keeps the real header and the app's own palette, so a failed
 * data fetch reads as one broken panel inside TriLog rather than as the whole
 * site being down.
 */
export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // Server Component errors arrive here with their message stripped; the
    // digest is the only handle that ties this view to the CloudWatch line.
    console.error("dashboard render failed", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <h1 className="font-display font-bold text-xl text-white leading-none uppercase tracking-wide">
            Tri<span className="text-orange-500">Log</span>
          </h1>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-16">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 max-w-xl">
          <span className="inline-block rounded-full bg-orange-500/10 text-orange-400 text-xs font-medium px-3 py-1">
            Couldn&apos;t load your training data
          </span>

          <h2 className="font-display font-bold text-2xl mt-4 uppercase tracking-wide">
            Something went wrong
          </h2>

          <p className="text-gray-400 mt-3 leading-relaxed">
            This is usually Strava being briefly unavailable rather than a
            problem with your account or your data — nothing has been lost.
            Trying again in a moment normally works.
          </p>

          <div className="flex items-center gap-3 mt-6">
            <button
              onClick={() => unstable_retry()}
              className="cursor-pointer rounded-full bg-orange-500 hover:bg-orange-600 transition-colors text-white font-medium px-5 py-2"
            >
              Try again
            </button>
            <a
              href="https://status.strava.com"
              target="_blank"
              rel="noreferrer"
              className="cursor-pointer rounded-full border border-gray-700 hover:border-gray-600 transition-colors text-gray-300 font-medium px-5 py-2"
            >
              Strava status
            </a>
          </div>

          {error.digest && (
            <p className="text-xs text-gray-600 mt-6 font-mono">
              Reference: {error.digest}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
