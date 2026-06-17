import { redirect } from "next/navigation";
import { isAdminAthlete, resolveSession } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { getRecentActivities } from "@/lib/strava";
import { groupByWeek, calcTrainingLoad } from "@trihards/core";
import { DashboardClient } from "@/components/DashboardClient";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session.tokens) redirect("/");

  const resolved = await resolveSession();
  if (!resolved) redirect("/");
  if (!resolved.license) redirect("/activate");

  const activities = await getRecentActivities(12);
  const weeklyVolume = groupByWeek(activities);
  const trainingLoad = calcTrainingLoad(activities);

  return (
    <DashboardClient
      athlete={{
        firstname: session.tokens.athlete_firstname,
        lastname: session.tokens.athlete_lastname,
        profile: session.tokens.athlete_profile,
      }}
      activities={activities}
      weeklyVolume={weeklyVolume}
      trainingLoad={trainingLoad}
      isAdmin={isAdminAthlete(resolved.stravaAthleteId)}
    />
  );
}
