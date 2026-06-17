import { redirect } from "next/navigation";
import { resolveSession } from "@/lib/auth";
import { ActivateForm } from "./ActivateForm";

export default async function ActivatePage() {
  const resolved = await resolveSession();
  if (!resolved) redirect("/");
  if (resolved.license) redirect("/dashboard");

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="mb-2 text-2xl font-semibold">Activate your access</h1>
      <p className="mb-6 text-sm text-gray-600">
        This app is invite-only. Paste the license key you were given to continue.
      </p>
      <ActivateForm />
    </main>
  );
}
