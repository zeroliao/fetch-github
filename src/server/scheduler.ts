import type { DiscoveryProfile } from "@/lib/types";
import {
  createScanJob,
  findActiveScanJobByProfile,
  getScheduleState,
  listProfiles,
  touchScheduleState
} from "./store";

export async function scheduleDueScanJobs(now = new Date()) {
  const profiles = (await listProfiles()).filter((profile) => profile.enabled);
  const created = [];

  for (const profile of profiles) {
    const active = await findActiveScanJobByProfile(profile.id);
    if (active) {
      await touchScheduleState({
        profileId: profile.id,
        checkedAt: now.toISOString(),
        jobId: active.id
      });
      continue;
    }

    if (!(await isProfileDue(profile, now))) {
      await touchScheduleState({
        profileId: profile.id,
        checkedAt: now.toISOString()
      });
      continue;
    }

    const job = await createScanJob(profile.id, "scheduled_scan");
    await touchScheduleState({
      profileId: profile.id,
      checkedAt: now.toISOString(),
      scheduledAt: now.toISOString(),
      jobId: job.id
    });
    created.push(job);
  }

  return created;
}

async function isProfileDue(profile: DiscoveryProfile, now: Date) {
  const state = await getScheduleState(profile.id);
  const startAt = parseDate(profile.config.schedule.startAt);
  if (startAt && now.getTime() < startAt.getTime()) {
    return false;
  }

  if (!state?.lastScheduledAt) {
    return isInitialScheduleDue(profile, now, startAt);
  }

  const lastScheduledAt = new Date(state.lastScheduledAt);
  if (profile.config.schedule.type === "interval") {
    const hours = profile.config.schedule.intervalHours ?? 24;
    return now.getTime() - lastScheduledAt.getTime() >= hours * 60 * 60 * 1000;
  }

  const next = nextDailyCronTime(lastScheduledAt, profile);
  return Boolean(next && now.getTime() >= next.getTime());
}

function isInitialScheduleDue(profile: DiscoveryProfile, now: Date, startAt?: Date) {
  if (profile.config.schedule.type === "interval") {
    return !startAt || now.getTime() >= startAt.getTime();
  }

  const anchor = startAt ?? new Date(now);
  anchor.setHours(0, 0, 0, 0);
  const first = nextDailyCronTime(new Date(anchor.getTime() - 1000), profile);
  return Boolean(first && now.getTime() >= first.getTime());
}

function nextDailyCronTime(after: Date, profile: DiscoveryProfile) {
  const cron = profile.config.schedule.cron ?? "";
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) {
    return undefined;
  }

  const minute = parseCronNumber(parts[0], 0, 59);
  const hour = parseCronNumber(parts[1], 0, 23);
  if (minute === undefined || hour === undefined) {
    return undefined;
  }

  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setMinutes(minute);
  next.setHours(hour);
  if (next.getTime() <= after.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function parseCronNumber(value: string, min: number, max: number) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    return undefined;
  }
  return number;
}

function parseDate(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
