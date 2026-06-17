"use client";

import { useEffect, useState } from "react";

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
  const [isDark, setIsDark] = useState(false);

  // Sync UI with whatever the FOUC script applied
  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  // Live-follow OS preference if the user hasn't made an explicit choice
  useEffect(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const next = media.matches;
      setIsDark(next);
      document.documentElement.classList.toggle("dark", next);
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
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
