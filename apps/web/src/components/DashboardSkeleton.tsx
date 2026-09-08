/**
 * What the athlete sees while the dashboard's data is still being fetched.
 *
 * The page used to send nothing at all until every query had come back, so the
 * browser sat on a blank tab for the whole server render. Auth is quick and
 * happens before this; everything slower is inside a Suspense boundary, which
 * lets the server flush this shell immediately and stream the real dashboard in
 * behind it. First paint stops depending on how long the database takes.
 *
 * It deliberately mirrors the real Overview layout — same card shapes, same
 * 240px chart heights, same grid — so the swap is a fill-in rather than a
 * re-layout. A skeleton that does not match its content just moves the jank.
 */
function Block({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-white/5 ${className}`} />;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">{children}</div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between max-sm:flex-wrap max-sm:gap-y-3">
          <div className="flex items-center gap-3">
            <Block className="h-9 w-9 rounded-full" />
            <div className="space-y-1.5">
              {/* The wordmark is static, so it can be real rather than a bar —
                  the header is identical in both states and never flickers. */}
              <h1 className="font-display font-bold text-xl text-white leading-none uppercase tracking-wide">
                Tri<span className="text-orange-500">Log</span>
              </h1>
              <Block className="h-3 w-24" />
            </div>
          </div>
          <div className="flex items-center gap-4 max-sm:w-full max-sm:gap-2">
            <Block className="h-9 w-[292px] rounded-lg max-sm:flex-1 max-sm:w-auto" />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6" aria-busy="true">
        <div className="mb-5 flex items-center justify-end gap-3">
          <Block className="h-7 w-24 rounded-full" />
        </div>

        <div className="space-y-6">
          <Block className="h-[268px] w-full rounded-2xl" />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <Block className="h-3 w-32" />
              <Block className="mt-4 h-[240px] w-full rounded-lg" />
            </Card>
            <Card>
              <Block className="h-3 w-48" />
              <Block className="mt-4 h-[240px] w-full rounded-lg" />
            </Card>
          </div>

          <Card>
            <Block className="h-3 w-20" />
            <Block className="mt-4 h-16 w-full rounded-lg" />
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <Card>
                <Block className="h-3 w-36" />
                <div className="mt-4 space-y-3">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Block key={i} className="h-12 w-full rounded-lg" />
                  ))}
                </div>
              </Card>
            </div>
            <Card>
              <Block className="h-3 w-28" />
              <Block className="mt-4 h-40 w-full rounded-lg" />
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
