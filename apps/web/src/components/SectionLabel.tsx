interface Props {
  children: React.ReactNode;
  /** Optional right-aligned content, e.g. a count or a control. */
  trailing?: React.ReactNode;
  className?: string;
}

// Shared section header: a short accent tick + a condensed, wide-tracked
// label. Used across the overview so every section reads from the same
// typographic system.
export function SectionLabel({ children, trailing, className = "" }: Props) {
  return (
    <div className={`flex items-center gap-2.5 mb-4 ${className}`}>
      <span
        className="h-3.5 w-[3px] rounded-full flex-shrink-0"
        style={{ background: "var(--accent)" }}
        aria-hidden
      />
      <h2 className="font-display uppercase tracking-[0.2em] text-[13px] leading-none text-gray-400">
        {children}
      </h2>
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}
