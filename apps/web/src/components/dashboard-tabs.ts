/**
 * The dashboard's pages and their addresses. Shared by the route, which
 * validates the URL, and the client, which switches pages without reloading:
 * /dashboard is the feed, /dashboard/<tab> each of the others.
 */
export const DASHBOARD_TABS = ["feed", "plan", "calendar", "activities", "recap", "profile"] as const;

export type Tab = (typeof DASHBOARD_TABS)[number];

export const TAB_TITLES: Record<Tab, string> = {
  feed: "Feed",
  plan: "Plan",
  calendar: "Calendar",
  activities: "Activities",
  recap: "Recap",
  profile: "Profile",
};

function isTab(value: string): value is Tab {
  return (DASHBOARD_TABS as readonly string[]).includes(value);
}

/** The route's catch-all segments to a page, or null when they name none. */
export function tabFromSegments(segments: string[] | undefined): Tab | null {
  if (!segments || segments.length === 0) return "feed";
  // The feed lives at /dashboard itself, so /dashboard/feed is not an address.
  if (segments.length === 1 && segments[0] !== "feed" && isTab(segments[0])) return segments[0];
  return null;
}

export function tabFromPathname(pathname: string): Tab {
  const rest = pathname.replace(/^\/dashboard\/?/, "");
  return tabFromSegments(rest ? rest.split("/") : undefined) ?? "feed";
}

export function pathForTab(tab: Tab): string {
  return tab === "feed" ? "/dashboard" : `/dashboard/${tab}`;
}
