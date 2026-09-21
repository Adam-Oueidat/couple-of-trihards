import type { SessionWithStatus } from "@trihards/core";
import { SessionRow } from "./SessionRow";

/**
 * Everything the athlete did not complete, in one list.
 *
 * The completion card answers "63 of 74" but not "which eleven", which is the
 * question worth acting on. Missed and skipped stay visually distinct and are
 * grouped apart: a skip is a decision the athlete already made and explained,
 * and lumping it in with sessions they simply did not do would misrepresent
 * their own record back to them — the same distinction the coach prompt keeps.
 */
export function MissedSessions({ sessions }: { sessions: SessionWithStatus[] }) {
  const missed = sessions.filter((s) => s.status === "missed");
  const skipped = sessions.filter((s) => s.status === "skipped");

  if (missed.length === 0 && skipped.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
        <p className="text-gray-400 text-sm font-medium">Nothing left undone</p>
        <p className="text-gray-600 text-xs mt-1">
          Every session in this plan was completed.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-6">
      {missed.length > 0 && (
        <section>
          <h3 className="font-display uppercase tracking-[0.2em] text-[13px] leading-none text-gray-400 mb-4">
            Missed · {missed.length}
          </h3>
          <div className="space-y-2">
            {missed.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        </section>
      )}

      {skipped.length > 0 && (
        <section>
          <h3 className="font-display uppercase tracking-[0.2em] text-[13px] leading-none text-gray-400 mb-2">
            Skipped on purpose · {skipped.length}
          </h3>
          <p className="text-gray-600 text-xs mb-4">
            You marked these as not happening, with your reason alongside.
          </p>
          <div className="space-y-2">
            {skipped.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
