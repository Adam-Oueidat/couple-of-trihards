"use client";

import Link from "next/link";
import type { RunThreshold } from "@trihards/core";
import { FitnessProfile } from "./FitnessProfile";
import { GoalsCard } from "./GoalsCard";
import { ThresholdsCard } from "./FeedTab";
import { LogoutButton } from "./LogoutButton";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  athlete: { firstname: string; lastname: string; profile: string };
  runThreshold: RunThreshold | null;
  isAdmin: boolean;
}

/**
 * Everything about the athlete rather than their training: the numbers the
 * sessions are pitched at, the physiology Strava holds, and what they are
 * aiming for. Account actions live here too, which keeps the sidebar to
 * navigation.
 */
export function ProfileTab({ athlete, runThreshold, isAdmin }: Props) {
  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-center gap-4 rounded-[14px] border border-gray-800 bg-gray-900 p-5">
        {athlete.profile ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={athlete.profile}
            alt=""
            className="h-14 w-14 rounded-full border-2 border-orange-500"
          />
        ) : (
          <span
            className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-orange-500 font-display text-2xl font-bold uppercase text-white"
            aria-hidden
          >
            {athlete.firstname[0]}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-display text-2xl font-bold uppercase leading-none tracking-wide text-white">
            {athlete.firstname} {athlete.lastname}
          </p>
          <p className="mt-1 text-sm text-gray-500">Connected with Strava</p>
        </div>
        <div className="flex items-center gap-3">
          {/* The sidebar carries the toggle on larger screens. */}
          <div className="md:hidden">
            <ThemeToggle />
          </div>
          {isAdmin && (
            <Link
              href="/admin/licenses"
              className="cursor-pointer rounded-[10px] border border-orange-500/40 bg-orange-500/10 px-3 py-1.5 text-sm font-medium text-orange-300 transition-colors hover:border-orange-500 hover:bg-orange-500/20"
            >
              Admin
            </Link>
          )}
          <LogoutButton />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <ThresholdsCard runThreshold={runThreshold} showWeight />
          <FitnessProfile bodyStats={false} />
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          <GoalsCard />
        </div>
      </div>
    </div>
  );
}
