import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy · TriLog",
  description: "What TriLog stores, why, who it shares it with, and the cookies it uses.",
};

// Who to write to about your data. Left unset until the owner of the app
// decides; the page says so rather than inventing an address.
const CONTACT_EMAIL: string | null = null;
const UPDATED = "9 November 2026";

/**
 * The privacy notice. Written from what the code does: if a table, cookie or
 * processor changes, this page changes with it.
 */
export default function PrivacyPage() {
  const contact = CONTACT_EMAIL ? (
    <a href={`mailto:${CONTACT_EMAIL}`} className="text-orange-400 underline-offset-2 hover:underline">
      {CONTACT_EMAIL}
    </a>
  ) : (
    <span>the person who gave you your license key</span>
  );

  return (
    <main className="min-h-screen bg-gray-950 px-4 py-12">
      <article className="mx-auto max-w-2xl text-[15px] leading-relaxed text-gray-300">
        <Link href="/" className="font-data text-[11px] uppercase tracking-[0.12em] text-gray-500 hover:text-white">
          ← TriLog
        </Link>
        <h1 className="mt-4 font-display text-5xl font-bold uppercase tracking-wide text-white">Privacy</h1>
        <p className="mt-2 font-data text-[12px] text-gray-500">Last updated {UPDATED}</p>

        <p className="mt-6">
          TriLog is an invite-only training coach for triathletes. To coach you it reads your training from
          Strava and keeps what you tell it. This page says what that is, why, who else sees it, and how to have
          it removed.
        </p>

        <Section title="What we store">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="text-white">Your Strava account and activities.</strong> Your Strava athlete id,
              name and profile photo link, and your activities with their heart rate, power, pace and cadence. We
              ask Strava for read access only (<code className="font-data text-[13px]">read</code>,{" "}
              <code className="font-data text-[13px]">activity:read_all</code>,{" "}
              <code className="font-data text-[13px]">profile:read_all</code>) and never post to it. Activities
              are cached so the app does not ask Strava for them on every page.
            </li>
            <li>
              <strong className="text-white">Strava access tokens</strong>, so the app can sync in the background.
              They are kept in our database and in your encrypted session cookie.
            </li>
            <li>
              <strong className="text-white">Your training plans</strong>: plans you upload (the document is read
              to pull out the sessions; the sessions are kept, not the file), plans the coach writes for you, and
              your moves, skips and edits to sessions.
            </li>
            <li>
              <strong className="text-white">What you tell the coach</strong>: your chats, your goals, and the
              notes the coach keeps from them, such as an injury, the days you can train or the kit you have. You
              can see those notes, and remove any of them, under{" "}
              <span className="text-white">Profile → What your coach remembers</span>.
            </li>
            <li>
              <strong className="text-white">What the app works out</strong>: activity analyses, training load,
              personal bests and training-quality reads.
            </li>
            <li>
              <strong className="text-white">Your license key</strong>, which ties your account to your invite.
            </li>
          </ul>
        </Section>

        <Section title="Health data">
          <p>
            Heart rate, injuries, illness and how training feels are health data. We use them for one thing: to
            coach you. We do not sell them, use them for advertising or share them beyond the services listed
            below. Connecting Strava and using the coach is how you choose to give them to us; if you would rather
            the coach did not keep something, remove the note or tell the coach it is no longer true.
          </p>
        </Section>

        <Section title="Who else handles it">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="text-white">Strava</strong>, where your activities come from.
            </li>
            <li>
              <strong className="text-white">Anthropic</strong>, whose Claude models power the coach. When you chat,
              ask for an analysis, or have a plan written or read, the relevant training data, notes and messages
              are sent to Anthropic&apos;s API to produce the answer.
            </li>
            <li>
              <strong className="text-white">Turso</strong>, which hosts the database.
            </li>
            <li>
              <strong className="text-white">Amazon Web Services</strong>, which runs the app, in its EU (Ireland)
              region.
            </li>
          </ul>
          <p className="mt-3">
            Profile photos are shown straight from Strava&apos;s image servers, so your browser loads them from
            Strava.
          </p>
        </Section>

        <Section title="Cookies and browser storage">
          <p>
            TriLog uses no analytics, advertising or tracking, and no third-party cookies. It keeps three things in
            your browser, each needed for something you asked for, which is why there is no consent banner:
          </p>
          <div className="mt-3 overflow-hidden rounded-[10px] border border-gray-800">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-gray-900 font-data text-[11px] uppercase tracking-[0.1em] text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-normal">Name</th>
                  <th className="px-3 py-2 font-normal">What it is for</th>
                  <th className="px-3 py-2 font-normal">Kept for</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                <tr>
                  <td className="px-3 py-2 font-data text-gray-200">trihard_session</td>
                  <td className="px-3 py-2">Keeps you signed in. Encrypted, and not readable by scripts.</td>
                  <td className="px-3 py-2">30 days, or until you sign out</td>
                </tr>
                <tr>
                  <td className="px-3 py-2 font-data text-gray-200">OAuth state</td>
                  <td className="px-3 py-2">Checks that a Strava sign-in was started by you.</td>
                  <td className="px-3 py-2">Removed as sign-in finishes</td>
                </tr>
                <tr>
                  <td className="px-3 py-2 font-data text-gray-200">theme</td>
                  <td className="px-3 py-2">Remembers light or dark mode, once you pick one (local storage, not a cookie).</td>
                  <td className="px-3 py-2">Until you clear it</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3">Fonts are served by TriLog itself, so pages do not contact Google.</p>
        </Section>

        <Section title="How long we keep it">
          <p>
            For as long as you have an account. Signing out ends your session but does not delete your data, and
            a coach note you remove is taken out of the coach&apos;s memory but kept in the database until your
            account is deleted.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            You can ask for a copy of your data, for something to be corrected, or for your account and everything
            in it to be deleted. There is no button for that yet; write to {contact} and it will be done. You can
            also revoke TriLog&apos;s access at any time from your Strava settings, under My Apps. If you are in the
            EU or UK you can complain to your data protection authority.
          </p>
        </Section>
      </article>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 font-display text-2xl font-bold uppercase tracking-wide text-white">{title}</h2>
      {children}
    </section>
  );
}
