import type { SessionWithStatus } from "@trihards/core";

// Locale and field order are carried over verbatim from the week list this was
// extracted from — the rows must keep formatting dates exactly as before.
const SESSION_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});

export function formatSessionDate(date: string): string {
  return SESSION_DATE_FMT.format(new Date(date + "T12:00:00"));
}

export const STATUS_STYLES: Record<
  SessionWithStatus["status"],
  { label: string; cls: string }
> = {
  completed: { label: "Done", cls: "bg-green-500/15 text-green-400 border-green-500/30" },
  partial: { label: "Partial", cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  missed: { label: "Missed", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  // Dashed and grey, not red: the athlete chose this one, so it must not read
  // like a failure sitting next to "Missed".
  skipped: {
    label: "Skipped",
    cls: "bg-gray-500/10 text-gray-400 border-dashed border-gray-500/50",
  },
  today: { label: "Today", cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  upcoming: { label: "Upcoming", cls: "bg-gray-500/15 text-gray-400 border-gray-500/30" },
};

/**
 * One graded session. Extracted from the week list so the "not done" view can
 * render identical rows — two hand-matched copies of this markup would drift,
 * and the status vocabulary (particularly missed vs skipped) is exactly the
 * thing that must stay consistent between the two places it appears.
 */
export function SessionRow({ session }: { session: SessionWithStatus }) {
  const style = STATUS_STYLES[session.status];
  return (
    <div className="flex items-center gap-4 p-3 rounded-lg border border-gray-800 bg-gray-950/50">
      <span
        className={`flex-shrink-0 w-20 py-1 text-center text-xs font-semibold rounded-full border ${style.cls}`}
      >
        {style.label}
      </span>
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm font-medium truncate ${
            session.status === "skipped" ? "text-gray-400 line-through" : "text-white"
          }`}
        >
          {session.name}
        </p>
        <p className="text-gray-500 text-xs">
          {formatSessionDate(session.date)} ·{" "}
          {session.isCustom ? session.discipline : session.type.replace("_", " ")}
          {session.status === "skipped" && ` · ${session.skipReason ?? "no reason given"}`}
        </p>
      </div>
      <div className="text-right flex-shrink-0">
        <p className="text-white text-sm font-semibold">
          {session.actualKm !== undefined
            ? `${session.actualKm} / ${session.km} km`
            : `${session.km} km`}
        </p>
      </div>
    </div>
  );
}
