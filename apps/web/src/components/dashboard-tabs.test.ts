import { describe, expect, it } from "vitest";
import { DASHBOARD_TABS, pathForTab, tabFromPathname, tabFromSegments } from "./dashboard-tabs";

describe("dashboard addresses", () => {
  it("puts the feed at /dashboard and every other page one level below", () => {
    expect(tabFromSegments(undefined)).toBe("feed");
    expect(tabFromSegments([])).toBe("feed");
    expect(tabFromSegments(["plan"])).toBe("plan");
    expect(tabFromSegments(["profile"])).toBe("profile");
  });

  it("rejects addresses that are not a page", () => {
    expect(tabFromSegments(["feed"])).toBeNull();
    expect(tabFromSegments(["nope"])).toBeNull();
    expect(tabFromSegments(["plan", "extra"])).toBeNull();
  });

  it("round-trips every page through its path", () => {
    for (const tab of DASHBOARD_TABS) expect(tabFromPathname(pathForTab(tab))).toBe(tab);
    expect(tabFromPathname("/dashboard/")).toBe("feed");
  });
});
