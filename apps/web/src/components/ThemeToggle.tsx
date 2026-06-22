"use client";

import { useEffect, useSyncExternalStore } from "react";

// The `dark` class on <html> is the single source of truth (a pre-hydration
// FOUC script sets it before React mounts). Derive the toggle's state from it
// via useSyncExternalStore instead of mirroring it into React state in an
// effect — that avoids a setState-in-effect, and the server snapshot is a
// stable `false` so there's no hydration mismatch.
function subscribe(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const getSnapshot = () => document.documentElement.classList.contains("dark");

function SunGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M11.6 4.4l1.1-1.1M4.4 11.6l-1.1 1.1" />
    </svg>
  );
}

function MoonGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 9.5A6 6 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />
    </svg>
  );
}

export function ThemeToggle() {
  const isDark = useSyncExternalStore(subscribe, getSnapshot, () => false);

  // Live-follow OS preference if the user hasn't made an explicit choice. This
  // only toggles the <html> class; the store subscription above re-renders us.
  useEffect(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () =>
      document.documentElement.classList.toggle("dark", media.matches);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  function toggle() {
    const next = !isDark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  return (
    <button
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="relative inline-flex items-center w-14 h-7 rounded-full bg-gray-800 border border-gray-700 cursor-pointer transition-colors"
    >
      {/* Sun on left of track */}
      <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
        <SunGlyph />
      </span>
      {/* Moon on right of track */}
      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
        <MoonGlyph />
      </span>
      {/* Sliding thumb with active glyph */}
      <span
        className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-orange-500 shadow flex items-center justify-center transition-transform duration-200 ease-out ${
          isDark ? "translate-x-7" : ""
        }`}
        style={{ color: "var(--accent-fg)" }}
      >
        {isDark ? <MoonGlyph /> : <SunGlyph />}
      </span>
    </button>
  );
}
