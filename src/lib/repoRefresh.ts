import type { RepoDataLevel, RepoSummary } from "./types";

const DEEP_ANALYZED_LEVELS: RepoDataLevel[] = ["L2", "L3", "L4"];

export function shouldAnalyzeDiscoveredRepo(input: {
  existing?: RepoSummary;
  existingDataLevel?: RepoDataLevel;
  next: RepoSummary;
}): { shouldAnalyze: boolean; reason: string } {
  const { existing, existingDataLevel, next } = input;
  if (!existing) {
    return { shouldAnalyze: true, reason: "new_repo" };
  }

  if (!existingDataLevel || !DEEP_ANALYZED_LEVELS.includes(existingDataLevel)) {
    return { shouldAnalyze: true, reason: "not_deep_analyzed" };
  }

  if (hasIdentityOrProfileChange(existing, next)) {
    return { shouldAnalyze: true, reason: "metadata_changed" };
  }

  const starDelta = next.stars - existing.stars;
  const forkDelta = next.forks - existing.forks;
  const starGrowthRatio = existing.stars > 0 ? starDelta / existing.stars : starDelta > 0 ? 1 : 0;
  if (starDelta >= 100 || starGrowthRatio >= 0.2 || forkDelta >= 50) {
    return { shouldAnalyze: true, reason: "growth_signal_changed" };
  }

  const pushedDeltaDays = daysBetween(existing.pushedAt, next.pushedAt);
  const updatedDeltaDays = daysBetween(existing.updatedAt, next.updatedAt);
  if (pushedDeltaDays >= 7 || updatedDeltaDays >= 14) {
    return { shouldAnalyze: true, reason: "activity_changed" };
  }

  return { shouldAnalyze: false, reason: "unchanged_snapshot_only" };
}

export function repoHasMaterialMetadataChanges(existing: RepoSummary, next: RepoSummary) {
  return (
    existing.githubId !== next.githubId ||
    existing.fullName !== next.fullName ||
    existing.owner !== next.owner ||
    existing.name !== next.name ||
    existing.htmlUrl !== next.htmlUrl ||
    existing.description !== next.description ||
    existing.primaryLanguage !== next.primaryLanguage ||
    JSON.stringify(existing.topics ?? []) !== JSON.stringify(next.topics ?? []) ||
    existing.stars !== next.stars ||
    existing.forks !== next.forks ||
    existing.openIssues !== next.openIssues ||
    existing.pushedAt !== next.pushedAt ||
    existing.updatedAt !== next.updatedAt ||
    existing.archived !== next.archived ||
    existing.fork !== next.fork
  );
}

function hasIdentityOrProfileChange(existing: RepoSummary, next: RepoSummary) {
  return (
    existing.fullName !== next.fullName ||
    existing.description !== next.description ||
    existing.primaryLanguage !== next.primaryLanguage ||
    JSON.stringify(existing.topics ?? []) !== JSON.stringify(next.topics ?? []) ||
    existing.archived !== next.archived ||
    existing.fork !== next.fork
  );
}

function daysBetween(previous?: string, next?: string) {
  const previousMs = previous ? new Date(previous).getTime() : NaN;
  const nextMs = next ? new Date(next).getTime() : NaN;
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs) || nextMs <= previousMs) {
    return 0;
  }

  return Math.floor((nextMs - previousMs) / (24 * 60 * 60 * 1000));
}
