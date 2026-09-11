"use client"; // Error boundaries must be Client Components

/**
 * Last line of defence: a throw in the root layout itself, which the per-route
 * error.tsx files sit below and therefore cannot catch.
 *
 * This file REPLACES the root layout when it renders, so it has to supply its
 * own <html> and <body> — none of the fonts, theme script, or global CSS from
 * layout.tsx are available here. Styles are inline for that reason; a Tailwind
 * class would be a no-op if the failure were in the stylesheet itself.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#030712",
          color: "#fff",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
        }}
      >
        <div style={{ maxWidth: "32rem", padding: "2rem" }}>
          <h1
            style={{
              fontSize: "1.25rem",
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              margin: 0,
            }}
          >
            Tri<span style={{ color: "#f97316" }}>Log</span>
          </h1>

          <h2 style={{ fontSize: "1.5rem", marginTop: "1.5rem" }}>
            TriLog couldn&apos;t start
          </h2>

          <p style={{ color: "#9ca3af", lineHeight: 1.6 }}>
            Something failed before the page could render. Your training data is
            safe — this is a problem loading the app itself.
          </p>

          <button
            onClick={() => unstable_retry()}
            style={{
              cursor: "pointer",
              marginTop: "1.5rem",
              border: 0,
              borderRadius: "9999px",
              backgroundColor: "#f97316",
              color: "#fff",
              fontSize: "1rem",
              fontWeight: 500,
              padding: "0.5rem 1.25rem",
            }}
          >
            Try again
          </button>

          {error.digest && (
            <p
              style={{
                fontSize: "0.75rem",
                color: "#4b5563",
                marginTop: "1.5rem",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
