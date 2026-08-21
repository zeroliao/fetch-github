import type { DiscoveryProfile } from "@/lib/types";
import {
  createScanJob,
  findActiveScanJobByProfile,
  getAppSettings,
  getScheduleState,
  listProfiles,
  touchScheduleState,
} from "./store";

export const INTERNAL_SCAN_INTERVAL_MS = 60_000;

type ScheduleStateLike = {
  lastScheduledAt?: string;
};

type SchedulePlan = {
  occurrences: Date[];
  cursorAt?: Date;
};

export async function scheduleDueScanJobs(now = new Date()) {
  const settings = await getAppSettings();
  if (!settings.scanEnabled) {
    return [];
  }

  const profiles = (await listProfiles()).filter((profile) => profile.enabled);
  const created = [];

  for (const profile of profiles) {
    const active = await findActiveScanJobByProfile(profile.id);
    if (active) {
      await touchScheduleState({
        profileId: profile.id,
        checkedAt: now.toISOString(),
        jobId: active.id,
      });
      continue;
    }

    const state = await getScheduleState(profile.id);
    const plan = buildSchedulePlan(profile, state, now);

    if (plan.occurrences.length === 0) {
      await touchScheduleState({
        profileId: profile.id,
        checkedAt: now.toISOString(),
        ...(plan.cursorAt ? { scheduledAt: plan.cursorAt.toISOString() } : {}),
      });
      continue;
    }

    const job = await createScanJob(profile.id, "scheduled_scan");
    created.push(job);
    await touchScheduleState({
      profileId: profile.id,
      checkedAt: now.toISOString(),
      scheduledAt: (plan.cursorAt ?? plan.occurrences[0]).toISOString(),
      jobId: job.id,
    });
  }

  return created;
}

export function buildSchedulePlan(
  profile: DiscoveryProfile,
  state: ScheduleStateLike | undefined,
  now = new Date(),
): SchedulePlan {
  const lastScheduledAt = parseDate(state?.lastScheduledAt);
  if (!lastScheduledAt) {
    return { occurrences: [now], cursorAt: now };
  }

  const firstDueAt = new Date(
    lastScheduledAt.getTime() + INTERNAL_SCAN_INTERVAL_MS,
  );
  if (firstDueAt.getTime() > now.getTime()) {
    return { occurrences: [] };
  }

  const elapsedIntervals = Math.floor(
    (now.getTime() - firstDueAt.getTime()) / INTERNAL_SCAN_INTERVAL_MS,
  );
  const latestDueAt = new Date(
    firstDueAt.getTime() + elapsedIntervals * INTERNAL_SCAN_INTERVAL_MS,
  );
  const hasMissedMoreThanOneCycle = elapsedIntervals > 0;

  switch (profile.config.schedule.missedRunPolicy) {
    case "skip":
      return hasMissedMoreThanOneCycle
        ? { occurrences: [], cursorAt: latestDueAt }
        : { occurrences: [firstDueAt], cursorAt: firstDueAt };
    case "run_once":
      return { occurrences: [latestDueAt], cursorAt: latestDueAt };
    case "resume":
      return { occurrences: [firstDueAt], cursorAt: firstDueAt };
  }
}

function parseDate(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
