import { desc, eq } from "drizzle-orm";
import { getDb, licenses, users } from "@trihards/db";
import { GenerateLicensesForm } from "./GenerateLicensesForm";
import { RevokeLicenseButton } from "./RevokeLicenseButton";
import { pruneExpiredLicenses } from "./actions";

function expiresInText(expiresAt: number | null): string {
  if (expiresAt === null) return "—";
  const seconds = expiresAt - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "expired";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "green" | "amber" | "gray";
}) {
  const accentColor = {
    green: "text-green-400",
    amber: "text-amber-400",
    gray: "text-gray-300",
  }[accent];
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-gray-500">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold ${accentColor}`}>{value}</div>
    </div>
  );
}

export default async function AdminLicensesPage() {
  const db = getDb();
  await pruneExpiredLicenses(db);

  const rows = await db
    .select({
      id: licenses.id,
      keyPrefix: licenses.keyPrefix,
      boundUserId: licenses.boundUserId,
      expiresAt: licenses.expiresAt,
      createdAt: licenses.createdAt,
      boundAthleteId: users.stravaAthleteId,
      boundName: users.displayName,
    })
    .from(licenses)
    .leftJoin(users, eq(users.id, licenses.boundUserId))
    .orderBy(desc(licenses.createdAt));

  const bound = rows.filter((r) => r.boundUserId).length;
  const unredeemed = rows.length - bound;

  return (
    <section className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Licenses</h2>
          <p className="mt-1 max-w-xl text-sm text-gray-400">
            Unredeemed keys expire automatically. Bound keys are permanent
            until you revoke them. The plaintext is shown once at creation and
            never persisted to the database.
          </p>
        </div>
        <GenerateLicensesForm />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Bound users" value={bound} accent="green" />
        <StatCard label="Unredeemed" value={unredeemed} accent="amber" />
        <StatCard label="Total" value={rows.length} accent="gray" />
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        {rows.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="text-sm text-gray-400">No licenses yet.</p>
            <p className="mt-1 text-xs text-gray-600">
              Use &ldquo;Generate&rdquo; above to mint your first batch.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800 bg-gray-950/60">
              <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3 font-medium">Key</th>
                <th className="px-4 py-3 font-medium">Bound to</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Expires</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map((r) => {
                const isBound = !!r.boundUserId;
                return (
                  <tr
                    key={r.id}
                    className="transition-colors hover:bg-gray-800/40"
                  >
                    <td className="px-4 py-3 font-mono text-gray-200">
                      {r.keyPrefix}
                      <span className="text-gray-600">-…-…-…</span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      {isBound ? (
                        <>
                          <span className="text-white">
                            {r.boundName ?? "(unnamed)"}
                          </span>
                          <span className="ml-2 text-xs text-gray-500">
                            athlete {r.boundAthleteId}
                          </span>
                        </>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                          isBound
                            ? "border-green-500/30 bg-green-500/15 text-green-400"
                            : "border-amber-500/30 bg-amber-500/15 text-amber-400"
                        }`}
                      >
                        {isBound ? "in use" : "unredeemed"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {expiresInText(r.expiresAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RevokeLicenseButton
                        licenseId={r.id}
                        keyPrefix={r.keyPrefix}
                        boundLabel={
                          isBound
                            ? `${r.boundName ?? "(unnamed)"} (athlete ${r.boundAthleteId})`
                            : null
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
