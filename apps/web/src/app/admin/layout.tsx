import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminAthlete, resolveSession } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const resolved = await resolveSession();
  if (!resolved) redirect("/");
  if (!isAdminAthlete(resolved.stravaAthleteId)) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard"
              className="text-gray-400 hover:text-white text-sm transition-colors cursor-pointer"
            >
              ← Dashboard
            </Link>
            <div className="h-5 w-px bg-gray-800" />
            <h1 className="font-black text-lg leading-none">
              <span className="text-orange-500">Admin</span> console
            </h1>
          </div>
          <span className="text-xs text-gray-500">
            Athlete {resolved.stravaAthleteId}
          </span>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
