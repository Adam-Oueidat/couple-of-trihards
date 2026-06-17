import { getSession } from "@/lib/session";
import { getStravaAuthUrl } from "@/lib/strava";
import { redirect } from "next/navigation";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session.tokens) redirect("/dashboard");

  const { error } = await searchParams;
  const authUrl = getStravaAuthUrl();

  return (
    <main className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="max-w-md w-full mx-4">
        <div className="text-center mb-10">
          <h1 className="text-5xl font-black text-white tracking-tight mb-2">
            Couple of <span className="text-orange-500">Trihards</span>
          </h1>
          <p className="text-gray-400 text-lg">Triathlon training dashboard</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 shadow-2xl">
          <div className="flex justify-center mb-6">
            <div className="grid grid-cols-3 gap-4 text-center w-full">
              {[
                { label: "Swim", color: "text-cyan-400" },
                { label: "Ride", color: "text-blue-400" },
                { label: "Run", color: "text-green-400" },
              ].map(({ label, color }) => (
                <div key={label} className="bg-gray-800 rounded-xl py-4">
                  <div className={`text-sm font-bold ${color}`}>{label}</div>
                </div>
              ))}
            </div>
          </div>

          <p className="text-gray-300 text-center mb-6 text-sm leading-relaxed">
            Connect your Strava account to see weekly volume,
            training load trends, and performance insights across
            all three disciplines.
          </p>

          {error && (
            <div className="mb-4 px-4 py-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-sm text-center">
              {error === "access_denied"
                ? "Authorization was denied. Please try again."
                : "Authentication failed. Please try again."}
            </div>
          )}

          <a
            href={authUrl}
            className="block w-full py-3 px-6 bg-orange-500 hover:bg-orange-400 text-white font-bold text-center rounded-xl transition-colors duration-200 shadow-lg"
          >
            Connect with Strava
          </a>

          <p className="text-gray-600 text-xs text-center mt-4">
            Read-only access · Tokens stored in encrypted session cookie
          </p>
        </div>
      </div>
    </main>
  );
}
