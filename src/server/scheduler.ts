import type { DiscoveryProfile } from "@/lib/types";
import {
  createScanJob,
  findActiveScanJobByProfile,
  getAppSettings,
  getScheduleState,
  listProfiles,
  touchScheduleState
} from "./store";

const MAX_RESUME_CATCH_UP = 100;

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
        jobId: active.id
      });
      continue;
    }

    const state = await getScheduleState(profile.id);
    const plan = buildSchedulePlan(profile, state, now);

    if (plan.occurrences.length === 0) {
      await touchScheduleState({
        profileId: profile.id,
        checkedAt: now.toISOString(),
        ...(plan.cursorAt ? { scheduledAt: plan.cursorAt.toISOString() } : {})
      });
      continue;
    }

    for (const _scheduledAt of plan.occurrences) {
      const job = await createScanJob(profile.id, "scheduled_scan");
      created.push(job);
    }

    const latest = plan.cursorAt ?? plan.occurrences[plan.occurrences.length - 1];
    const lastJob = created[created.length - 1];
    await touchScheduleState({
      profileId: profile.id,
      checkedAt: now.toISOString(),
      scheduledAt: latest.toISOString(),
      ...(lastJob ? { jobId: lastJob.id } : {})
    });
  }

  return created;
}

export function buildSchedulePlan(
  profile: DiscoveryProfile,
  state: ScheduleStateLike | undefined,
  now = new Date()
): SchedulePlan {
  const startAt = parseDate(profile.config.schedule.startAt);
  if (startAt && now.getTime() < startAt.getTime()) {
    return { occurrences: [] };
  }

  const dueOccurrences =
    profile.config.schedule.type === "interval"
      ? collectIntervalOccurrences(profile, state, now)
      : collectCronOccurrences(profile, state, now);

  if (dueOccurrences.length === 0) {
    return { occurrences: [] };
  }

  const latest = getLatestDueOccurrence(profile, state, now) ?? dueOccurrences[dueOccurrences.length - 1];
  switch (profile.config.schedule.missedRunPolicy) {
    case "skip":
      return dueOccurrences.length > 1
        ? { occurrences: [], cursorAt: latest }
        : { occurrences: dueOccurrences, cursorAt: latest };
    case "run_once":
      return { occurrences: [latest], cursorAt: latest };
    case "resume":
      return { occurrences: [dueOccurrences[0]], cursorAt: dueOccurrences[0] };
  }
}

function getLatestDueOccurrence(
  profile: DiscoveryProfile,
  state: ScheduleStateLike | undefined,
  now = new Date()
) {
  if (profile.config.schedule.type === "interval") {
    return getLatestIntervalOccurrence(profile, state, now);
  }

  return getLatestCronOccurrence(profile, state, now);
}

function collectIntervalOccurrences(
  profile: DiscoveryProfile,
  state: ScheduleStateLike | undefined,
  now: Date
) {
  const intervalHours = profile.config.schedule.intervalHours ?? 24;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const startAt = parseDate(profile.config.schedule.startAt);
  const lastScheduledAt = parseDate(state?.lastScheduledAt);
  const occurrences: Date[] = [];

  let next = lastScheduledAt
    ? new Date(lastScheduledAt.getTime() + intervalMs)
    : startAt
      ? new Date(startAt)
      : new Date(now);

  while (next.getTime() <= now.getTime() && occurrences.length < MAX_RESUME_CATCH_UP) {
    occurrences.push(new Date(next));
    next = new Date(next.getTime() + intervalMs);
  }

  return occurrences;
}

function getLatestIntervalOccurrence(
  profile: DiscoveryProfile,
  state: ScheduleStateLike | undefined,
  now: Date
) {
  const intervalHours = profile.config.schedule.intervalHours ?? 24;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const startAt = parseDate(profile.config.schedule.startAt);
  const lastScheduledAt = parseDate(state?.lastScheduledAt);
  const first = lastScheduledAt
    ? new Date(lastScheduledAt.getTime() + intervalMs)
    : startAt
      ? new Date(startAt)
      : new Date(now);

  if (first.getTime() > now.getTime()) {
    return undefined;
  }

  const elapsedIntervals = Math.floor((now.getTime() - first.getTime()) / intervalMs);
  return new Date(first.getTime() + elapsedIntervals * intervalMs);
}

function collectCronOccurrences(
  profile: DiscoveryProfile,
  state: ScheduleStateLike | undefined,
  now: Date
) {
  const timeZone = resolveTimeZone(profile.config.schedule.timezone);
  const startAt = parseDate(profile.config.schedule.startAt);
  const lastScheduledAt = parseDate(state?.lastScheduledAt);
  const anchor = lastScheduledAt
    ? lastScheduledAt
    : startAt
      ? new Date(startAt.getTime() - 1)
      : new Date(startOfDayInTimeZone(now, timeZone).getTime() - 1000);

  const occurrences: Date[] = [];
  let next = nextDailyCronTime(anchor, profile, timeZone);

  while (next && next.getTime() <= now.getTime() && occurrences.length < MAX_RESUME_CATCH_UP) {
    occurrences.push(next);
    next = nextDailyCronTime(next, profile, timeZone);
  }

  return occurrences;
}

function getLatestCronOccurrence(
  profile: DiscoveryProfile,
  state: ScheduleStateLike | undefined,
  now: Date
) {
  const timeZone = resolveTimeZone(profile.config.schedule.timezone);
  const startAt = parseDate(profile.config.schedule.startAt);
  const lastScheduledAt = parseDate(state?.lastScheduledAt);
  const lowerBound = lastScheduledAt ?? startAt;
  const candidate = currentOrPreviousDailyCronTime(now, profile, timeZone);

  if (!candidate) {
    return undefined;
  }
  if (candidate.getTime() > now.getTime()) {
    return undefined;
  }
  if (lowerBound && candidate.getTime() <= lowerBound.getTime()) {
    return undefined;
  }

  return candidate;
}

function nextDailyCronTime(after: Date, profile: DiscoveryProfile, timeZone: string) {
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

  const local = getZonedDateParts(after, timeZone);
  let next = createZonedDate(
    {
      year: local.year,
      month: local.month,
      day: local.day,
      hour,
      minute,
      second: 0
    },
    timeZone
  );

  if (next.getTime() <= after.getTime()) {
    next = createZonedDate(
      {
        year: local.year,
        month: local.month,
        day: local.day + 1,
        hour,
        minute,
        second: 0
      },
      timeZone
    );
  }

  return next;
}

function currentOrPreviousDailyCronTime(now: Date, profile: DiscoveryProfile, timeZone: string) {
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

  const local = getZonedDateParts(now, timeZone);
  const today = createZonedDate(
    {
      year: local.year,
      month: local.month,
      day: local.day,
      hour,
      minute,
      second: 0
    },
    timeZone
  );

  if (today.getTime() <= now.getTime()) {
    return today;
  }

  return createZonedDate(
    {
      year: local.year,
      month: local.month,
      day: local.day - 1,
      hour,
      minute,
      second: 0
    },
    timeZone
  );
}

function startOfDayInTimeZone(date: Date, timeZone: string) {
  const local = getZonedDateParts(date, timeZone);
  return createZonedDate(
    {
      year: local.year,
      month: local.month,
      day: local.day,
      hour: 0,
      minute: 0,
      second: 0
    },
    timeZone
  );
}

function createZonedDate(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
  timeZone: string
) {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );

  let candidate = utcGuess;
  for (let index = 0; index < 5; index += 1) {
    const offset = getTimeZoneOffsetMs(new Date(candidate), timeZone);
    const next = utcGuess - offset;
    if (Math.abs(next - candidate) < 1000) {
      candidate = next;
      break;
    }
    candidate = next;
  }

  return new Date(candidate);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const local = getZonedDateParts(date, timeZone);
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    0
  );
  return localAsUtc - date.getTime();
}

function getZonedDateParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second")
  };
}

function resolveTimeZone(value: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
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
