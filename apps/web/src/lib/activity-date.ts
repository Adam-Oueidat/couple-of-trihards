// Strava's `start_date_local` is the athlete's wall-clock time but carries a
// misleading trailing "Z". Passing it straight to `new Date()` makes JS read it
// as UTC, and `toLocaleDateString` then re-applies the *browser's* offset —
// shifting an evening activity to the next day (a Sunday run shows as Monday).
//
// Anchor to the literal date part at local noon: this preserves the athlete's
// wall-clock calendar day regardless of the viewer's timezone, with noon keeping
// it clear of any midnight rollover.
export function activityLocalDate(startDateLocal: string): Date {
  const day = startDateLocal.split("T")[0];
  return new Date(`${day}T12:00:00`);
}
