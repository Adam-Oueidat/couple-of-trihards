/**
 * What the athlete sees while the dashboard's data is still being fetched.
 *
 * The page used to send nothing at all until every query had come back, so the
 * browser sat on a blank tab for the whole server render. Auth is quick and
 * happens before this; everything slower is inside a Suspense boundary, which
 * lets the server flush this shell immediately and stream the real dashboard in
 * behind it. First paint stops depending on how long the database takes.
 *
 * It deliberately mirrors the real Feed layout — sidebar, week strip, the
 * suggestion card, activity cards and the side panel — so the swap is a
 * fill-in rather than a re-layout. A skeleton that does not match its content just moves the jank.
 */
function Block({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-white/5 ${className}`} />;
}

function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-[14px] border border-gray-800 bg-gray-900 p-5 ${className}`}>{children}</div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-gray-950 text-white md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col gap-1 border-r border-gray-800 px-3.5 py-6 md:flex">
        {/* The wordmark is static, so it can be real rather than a bar. */}
        <span className="mb-5 px-2.5 font-display text-2xl font-bold uppercase leading-none tracking-wide text-white">
          Tri<span className="text-orange-500">Log</span>
        </span>
        {[0, 1, 2, 3, 4].map((i) => (
          <Block key={i} className="mx-2.5 my-2 h-4 w-24" />
        ))}
      </aside>

      <div className="min-w-0">
        <header className="flex items-center border-b border-gray-800 px-4 py-3 md:hidden">
          <span className="font-display text-xl font-bold uppercase leading-none tracking-wide text-white">
            Tri<span className="text-orange-500">Log</span>
          </span>
        </header>

        <main
          className="mx-auto grid max-w-[1080px] gap-8 px-4 pb-44 pt-6 md:px-8 md:pb-28 md:pt-8 xl:grid-cols-[minmax(0,1fr)_300px]"
          aria-busy="true"
        >
          <div className="space-y-4">
            <Block className="h-9 w-40" />
            <Block className="h-2.5 w-full" />
            <Block className="h-3 w-56" />
            <Block className="mt-4 h-3 w-40" />
            <Card className="space-y-4">
              <Block className="h-5 w-32 rounded-full" />
              <Block className="h-9 w-3/4" />
              <Block className="h-24 w-full rounded-lg" />
            </Card>
            {[0, 1].map((i) => (
              <Card key={i} className="space-y-3">
                <Block className="h-5 w-14 rounded-full" />
                <Block className="h-5 w-1/2" />
                <Block className="h-4 w-2/3" />
              </Card>
            ))}
          </div>
          <div className="space-y-4">
            <Card>
              <Block className="h-3 w-16" />
              <Block className="mt-3 h-9 w-28" />
              <Block className="mt-4 h-20 w-full" />
            </Card>
            <Card>
              <Block className="h-3 w-24" />
              <Block className="mt-3 h-16 w-full" />
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
