import type { AppSettings } from "./types";

export const defaultAppSettings: AppSettings = {
  scanEnabled: true,
  githubAutoSyncEnabled: true,
  githubAutoSyncIntervalHours: 24
};

export function normalizeAppSettings(settings?: Partial<AppSettings> | null): AppSettings {
  return {
    ...defaultAppSettings,
    ...settings,
    githubAutoSyncIntervalHours: Math.max(
      1,
      Number(settings?.githubAutoSyncIntervalHours ?? defaultAppSettings.githubAutoSyncIntervalHours)
    ),
    githubLastAutoSyncedAt: normalizeOptionalIso(settings?.githubLastAutoSyncedAt),
    githubLastAutoSyncAttemptAt: normalizeOptionalIso(settings?.githubLastAutoSyncAttemptAt)
  };
}

function normalizeOptionalIso(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
