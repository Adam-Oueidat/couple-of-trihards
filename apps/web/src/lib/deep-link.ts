/**
 * The mobile app's deep-link scheme, used to hand the bearer token back after
 * Strava OAuth. `trilog` matches the product name, the ECR repository, and the
 * deployed artifact; the older `trihard` spelling survives only in internal
 * cookie and MIME names, which are invisible to users.
 *
 * Production reads this at request time, so the default below — not the
 * build-stage placeholders in the Dockerfile or CI — is what ships unless the
 * runtime environment sets it explicitly.
 */
export function expectedScheme(): string {
  return process.env.MOBILE_DEEP_LINK_SCHEME ?? "trilog";
}

export function isAllowedRedirect(redirect: string): boolean {
  // Allow only our mobile deep-link scheme — never an arbitrary URL.
  return redirect.startsWith(`${expectedScheme()}://`);
}
