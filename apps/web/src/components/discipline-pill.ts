// Rounded pill styling per discipline, resolved through the palette tokens in
// globals.css (run=green, ride=blue, swim=cyan). Shared so the calendar, the
// plan card, and anything else that badges a discipline stay in step.
//
// Lives beside DisciplineGlyph rather than inside it: a module that exports
// both a component and plain values defeats React Fast Refresh, which can only
// hot-swap a module whose exports are all components.
export const DISCIPLINE_PILL: Record<string, string> = {
  run: "bg-green-500/15 text-green-400 border-green-500/30",
  ride: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  swim: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
};
