import type { UserGitHubRepo } from "@/lib/types";
import {
  getGitHubUserProfile,
  listAuthenticatedRepositories
} from "./githubClient";
import {
  listGithubRepos,
  listProfiles,
  getAppSettings,
  replaceUserRepos,
  rebuildRecommendationScores,
  updateAppSettings,
  upsertGithubAccount
} from "./store";

export interface SyncGitHubContextOptions {
  includeOwned?: boolean;
  includeStarred?: boolean;
}

export async function syncGitHubContext(options: SyncGitHubContextOptions = {}) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("缺少 GITHUB_TOKEN，请先在 .env.local 中配置 GitHub Personal Access Token。");
  }

  const includeOwned = options.includeOwned ?? true;
  const includeStarred = options.includeStarred ?? true;
  if (!includeOwned && !includeStarred) {
    throw new Error("至少需要选择 owned 或 starred 中的一类仓库。");
  }

  const [profile, existingRepos] = await Promise.all([
    getGitHubUserProfile(),
    listGithubRepos()
  ]);
  const account = await upsertGithubAccount({
    username: profile.login,
    tokenRef: "GITHUB_TOKEN"
  });
  const previousSelection = new Map(
    existingRepos
      .filter((repo) => repo.githubAccountId === account.id)
      .map((repo) => [repo.fullName, repo.selectedForContext])
  );

  const repoGroups = await Promise.all([
    includeOwned ? listAuthenticatedRepositories("owned") : Promise.resolve([]),
    includeStarred ? listAuthenticatedRepositories("starred") : Promise.resolve([])
  ]);
  const unique = new Map(repoGroups.flat().map((repo) => [repo.fullName, repo]));
  const repos: UserGitHubRepo[] = [...unique.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((repo) => ({
      id: `user-${account.id}-${repo.id}`,
      githubAccountId: account.id,
      githubId: repo.githubId,
      fullName: repo.fullName,
      description: repo.description,
      primaryLanguage: repo.primaryLanguage,
      topics: repo.topics,
      visibility: repo.private ? "private" : "public",
      selectedForContext: previousSelection.get(repo.fullName) ?? !repo.private,
      lastSyncedAt: new Date().toISOString()
    }));

  await replaceUserRepos(account.id, repos);
  const profiles = await listProfiles();
  await Promise.all(profiles.map((profile) => rebuildRecommendationScores(profile.id)));

  return {
    account,
    repos,
    syncedCount: repos.length,
    includeOwned,
    includeStarred
  };
}

export async function syncGitHubContextIfDue(now = new Date()) {
  const settings = await getAppSettings();
  if (!settings.githubAutoSyncEnabled) {
    return { skipped: true, reason: "disabled" };
  }
  if (!process.env.GITHUB_TOKEN) {
    await updateAppSettings({ githubLastAutoSyncAttemptAt: now.toISOString() });
    return { skipped: true, reason: "missing_github_token" };
  }

  const intervalMs = settings.githubAutoSyncIntervalHours * 60 * 60 * 1000;
  const lastSyncAt = parseOptionalDate(settings.githubLastAutoSyncedAt);
  const lastAttemptAt = parseOptionalDate(settings.githubLastAutoSyncAttemptAt);
  const lastRunAt = [lastSyncAt, lastAttemptAt]
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  if (lastRunAt && now.getTime() - lastRunAt.getTime() < intervalMs) {
    return { skipped: true, reason: "not_due" };
  }

  await updateAppSettings({ githubLastAutoSyncAttemptAt: now.toISOString() });
  const result = await syncGitHubContext();
  await updateAppSettings({
    githubLastAutoSyncedAt: now.toISOString(),
    githubLastAutoSyncAttemptAt: now.toISOString()
  });

  return {
    skipped: false,
    ...result
  };
}

function parseOptionalDate(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
