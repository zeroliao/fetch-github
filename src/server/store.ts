import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { seedSnapshot } from "@/lib/seed";
import { calculateFinalScore } from "@/lib/scoring";
import { normalizeDiscoverySources } from "@/lib/discoverySources";
import { normalizeOpportunityProfile } from "@/lib/opportunity";
import { cosineSimilarity, normalizeDiscoveryLimits } from "@/lib/semanticGate";
import {
  repoHasMaterialMetadataChanges,
  shouldAnalyzeDiscoveredRepo
} from "@/lib/repoRefresh";
import { normalizeAppSettings } from "@/lib/settings";
import { annotateRecommendationClusters } from "@/lib/repoCluster";
import {
  ensureChineseSummary,
  normalizeChineseLabels
} from "@/lib/recommendationText";
import type {
  AiProvider,
  AppSettings,
  CachedEmbedding,
  DashboardSnapshot,
  DiscoveryProfile,
  Feedback,
  FeedbackAction,
  PreferenceSignal,
  Recommendation,
  RepoDataLevel,
  RepoSummary,
  ResourceEvent,
  ScanCheckpoint,
  ScanJob,
  UpsertRepoStats,
  GithubAccount,
  KnowledgeSync,
  OperationsSnapshot,
  UserGitHubRepo
} from "@/lib/types";
import { buildRecommendation } from "./ranking";
import { isDatabaseAvailable } from "./db";
import * as postgresStore from "./postgresStore";

interface StoreState extends DashboardSnapshot {
  feedback: Feedback[];
  repos: RepoSummary[];
  repoDataLevels: Record<string, RepoDataLevel>;
  checkpoints: ScanCheckpoint[];
  resourceEvents: ResourceEvent[];
  repoDocuments: Array<{
    repoId: string;
    type: string;
    sourceUrl?: string;
    contentHash: string;
    rawContent: string;
    summary?: string;
  }>;
  repoEmbeddings: Array<{
    repoId: string;
    providerId: string;
    model: string;
    dimensions: number;
    contentHash: string;
    vector: number[];
    createdAt: string;
  }>;
  embeddingCache: Array<CachedEmbedding & { cacheKey: string }>;
  llmResults: Array<{
    repoId: string;
    jobType: string;
    providerId?: string;
    model?: string;
    promptVersion?: string;
    inputHash?: string;
    structured: Record<string, unknown>;
  }>;
  preferenceSignals: PreferenceSignal[];
  knowledgeSyncs: KnowledgeSync[];
  repoContextMatches: Array<{
    candidateRepoId: string;
    userRepoId: string;
    score: number;
    reasons: string[];
  }>;
}

let cache: StoreState | null = null;

const storePath = path.join(process.cwd(), "runtime", "dev-store.json");

function createInitialState(): StoreState {
  return {
    ...seedSnapshot,
    repos: seedSnapshot.recommendations.map((recommendation) => recommendation.repo),
    repoDataLevels: Object.fromEntries(
      seedSnapshot.recommendations.map((recommendation) => [recommendation.repo.id, "L3"])
    ),
    feedback: [],
    checkpoints: [],
    resourceEvents: [],
    repoDocuments: [],
    repoEmbeddings: [],
    embeddingCache: [],
    llmResults: [],
    preferenceSignals: [],
    knowledgeSyncs: [],
    repoContextMatches: []
  };
}

async function loadState(): Promise<StoreState> {
  if (cache) {
    return cache;
  }

  try {
    const raw = await readFile(storePath, "utf8");
    cache = normalizeState(JSON.parse(raw) as Partial<StoreState>);
  } catch {
    cache = createInitialState();
    await saveState(cache);
  }

  return cache;
}

function normalizeState(state: Partial<StoreState>): StoreState {
  const recommendations = state.recommendations ?? seedSnapshot.recommendations;

  return {
    settings: normalizeAppSettings(state.settings),
    profiles: normalizeProfiles(state.profiles ?? seedSnapshot.profiles),
    aiProviders: state.aiProviders ?? seedSnapshot.aiProviders,
    recommendations,
    jobs: normalizeScanJobs(state.jobs ?? seedSnapshot.jobs),
    githubRepos: state.githubRepos ?? seedSnapshot.githubRepos,
    queueStats: state.queueStats ?? [],
    githubAccounts: state.githubAccounts ?? seedSnapshot.githubAccounts ?? [],
    repos: state.repos ?? recommendations.map((recommendation) => recommendation.repo),
    repoDataLevels: state.repoDataLevels ?? {},
    feedback: state.feedback ?? [],
    checkpoints: state.checkpoints ?? [],
    resourceEvents: state.resourceEvents ?? [],
    repoDocuments: state.repoDocuments ?? [],
    repoEmbeddings: state.repoEmbeddings ?? [],
    embeddingCache: state.embeddingCache ?? [],
    llmResults: state.llmResults ?? [],
    preferenceSignals: state.preferenceSignals ?? [],
    knowledgeSyncs: state.knowledgeSyncs ?? seedSnapshot.knowledgeSyncs ?? [],
    repoContextMatches: state.repoContextMatches ?? [],
    operations: state.operations ?? seedSnapshot.operations
  };
}

function normalizeProfiles(profiles: DiscoveryProfile[]) {
  return profiles.map((profile) => ({
    ...profile,
      config: {
        ...profile.config,
        limits: normalizeDiscoveryLimits(profile.config.limits),
        opportunity: normalizeOpportunityProfile(profile.config.opportunity),
        sources: normalizeDiscoverySources(profile.config.sources)
      }
  }));
}

function normalizeScanJobs(jobs: ScanJob[]) {
  return jobs.map((job) => ({
    ...job,
    newRepoCount: job.newRepoCount ?? 0,
    updatedRepoCount: job.updatedRepoCount ?? 0,
    unchangedRepoCount: job.unchangedRepoCount ?? 0,
    candidateCount: job.candidateCount ?? job.processedCount ?? 0,
    failedCandidateCount: job.failedCandidateCount ?? 0
  }));
}

function findLocalRepo(repos: RepoSummary[], repo: RepoSummary) {
  return repos.find(
    (item) =>
      item.id === repo.id ||
      item.fullName === repo.fullName ||
      (repo.githubId !== undefined && item.githubId === repo.githubId)
  );
}

function repoHasMaterialChanges(existing: RepoSummary, next: RepoSummary) {
  return repoHasMaterialMetadataChanges(existing, next);
}

function mergeDataLevel(current: RepoDataLevel | undefined, next: RepoDataLevel) {
  const order: RepoDataLevel[] = ["L0", "L1", "L2", "L3", "L4"];
  const currentIndex = current ? order.indexOf(current) : 0;
  const nextIndex = order.indexOf(next);
  return order[Math.max(currentIndex, nextIndex)] ?? next;
}

async function saveState(state: StoreState): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(state, null, 2), "utf8");
  cache = state;
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  if (await isDatabaseAvailable()) {
    return postgresStore.getDashboardSnapshot();
  }

  const state = await loadState();

  return {
    settings: state.settings,
    profiles: state.profiles,
    aiProviders: state.aiProviders,
    recommendations: state.recommendations.map(withChineseDisplay),
    jobs: state.jobs,
    githubAccounts: state.githubAccounts,
    githubRepos: state.githubRepos,
    knowledgeSyncs: state.knowledgeSyncs,
    queueStats: state.queueStats,
    operations: buildLocalOperationsSnapshot(state)
  };
}

function buildLocalOperationsSnapshot(state: StoreState): OperationsSnapshot {
  return {
    resourceEvents: state.resourceEvents.slice(0, 80),
    aiJobs: [],
    repoTokenSummary: [],
    scanTokenSummary: [],
    aiCostSummary: {
      totalJobs: 0,
      unknownJobCount: 0,
      totalTokens: 0,
      estimatedCostUsd: 0
    }
  };
}

export async function getAppSettings(): Promise<AppSettings> {
  if (await isDatabaseAvailable()) {
    return postgresStore.getAppSettings();
  }

  return (await loadState()).settings;
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (await isDatabaseAvailable()) {
    return postgresStore.updateAppSettings(patch);
  }

  const state = await loadState();
  state.settings = normalizeAppSettings({
    ...state.settings,
    ...patch
  });
  await saveState(state);
  return state.settings;
}

export async function listProfiles(): Promise<DiscoveryProfile[]> {
  if (await isDatabaseAvailable()) {
    return postgresStore.listProfiles();
  }

  return (await loadState()).profiles;
}

export async function createProfile(
  input: Omit<DiscoveryProfile, "id" | "createdAt" | "updatedAt">
): Promise<DiscoveryProfile> {
  if (await isDatabaseAvailable()) {
    return postgresStore.createProfile(input);
  }

  const state = await loadState();
  const now = new Date().toISOString();
  const profile: DiscoveryProfile = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now
  };

  state.profiles.push(profile);
  await saveState(state);
  return profile;
}

export async function updateProfile(
  id: string,
  patch: Partial<Pick<DiscoveryProfile, "config" | "enabled" | "name">>
): Promise<DiscoveryProfile | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.updateProfile(id, patch);
  }

  const state = await loadState();
  let updated: DiscoveryProfile | undefined;
  state.profiles = state.profiles.map((profile) => {
    if (profile.id !== id) {
      return profile;
    }

    updated = {
      ...profile,
      ...patch,
      config: patch.config ?? profile.config,
      updatedAt: new Date().toISOString()
    };
    return updated;
  });

  await saveState(state);
  return updated;
}

export async function listAiProviders(): Promise<AiProvider[]> {
  if (await isDatabaseAvailable()) {
    return postgresStore.listAiProviders();
  }

  return (await loadState()).aiProviders;
}

export async function createAiProvider(
  input: Omit<AiProvider, "id" | "createdAt" | "updatedAt">
): Promise<AiProvider> {
  if (await isDatabaseAvailable()) {
    return postgresStore.createAiProvider(input);
  }

  const state = await loadState();
  const now = new Date().toISOString();
  const provider: AiProvider = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now
  };

  state.aiProviders.push(provider);
  await saveState(state);
  return provider;
}

export async function getAiProvider(id: string): Promise<AiProvider | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.getAiProvider(id);
  }

  const state = await loadState();
  return state.aiProviders.find((provider) => provider.id === id);
}

export async function updateAiProvider(
  id: string,
  patch: Partial<Omit<AiProvider, "id" | "kind" | "type" | "createdAt" | "updatedAt">>
): Promise<{ provider?: AiProvider; reason?: string }> {
  if (await isDatabaseAvailable()) {
    return postgresStore.updateAiProvider(id, patch);
  }

  const state = await loadState();
  if (patch.enabled === false) {
    const inUse = state.profiles.find(
      (profile) =>
        profile.config.ai.chatProviderId === id ||
        profile.config.ai.embeddingProviderId === id
    );

    if (inUse) {
      return {
        reason: `该 AI 配置正在被发现配置「${inUse.name}」使用，请先修改发现配置的 AI 绑定。`
      };
    }
  }

  let updated: AiProvider | undefined;
  state.aiProviders = state.aiProviders.map((provider) => {
    if (provider.id !== id) {
      return provider;
    }

    updated = {
      ...provider,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    return updated;
  });

  await saveState(state);
  return { provider: updated };
}

export async function deleteAiProvider(id: string): Promise<{
  deleted: boolean;
  reason?: string;
}> {
  if (await isDatabaseAvailable()) {
    return postgresStore.deleteAiProvider(id);
  }

  const state = await loadState();
  const inUse = state.profiles.find(
    (profile) =>
      profile.config.ai.chatProviderId === id ||
      profile.config.ai.embeddingProviderId === id
  );

  if (inUse) {
    return {
      deleted: false,
      reason: `该 AI 配置正在被发现配置「${inUse.name}」使用，不能删除。`
    };
  }

  state.aiProviders = state.aiProviders.filter((provider) => provider.id !== id);
  await saveState(state);
  return { deleted: true };
}

export async function listScanJobs(): Promise<ScanJob[]> {
  if (await isDatabaseAvailable()) {
    return postgresStore.listScanJobs();
  }

  const state = await loadState();
  return state.jobs
    .filter((job) => !job.archivedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getScanJob(jobId: string): Promise<ScanJob | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.getScanJob(jobId);
  }

  const state = await loadState();
  return state.jobs.find((job) => job.id === jobId);
}

export async function archiveScanJob(jobId: string): Promise<ScanJob | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.archiveScanJob(jobId);
  }

  const state = await loadState();
  let archived: ScanJob | undefined;

  state.jobs = state.jobs.map((job) => {
    if (job.id !== jobId || !["completed", "failed"].includes(job.status)) {
      return job;
    }

    archived = {
      ...job,
      archivedAt: new Date().toISOString()
    };
    return archived;
  });

  await saveState(state);
  return archived;
}

export async function completeScanJob(jobId: string): Promise<ScanJob | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.completeScanJob(jobId);
  }

  const state = await loadState();
  let completed: ScanJob | undefined;
  state.jobs = state.jobs.map((job) => {
    if (
      job.id !== jobId ||
      !["paused_by_user", "paused_by_memory", "paused_by_runtime", "retry_later"].includes(job.status)
    ) {
      return job;
    }

    completed = {
      ...job,
      status: "completed",
      stage: job.stage,
      statusReason: "已手动完成，后续不再继续扫描。",
      errorMessage: undefined,
      finishedAt: new Date().toISOString()
    };
    return completed;
  });

  await saveState(state);
  return completed;
}

export async function listRunnableScanJobs(limit = 1): Promise<ScanJob[]> {
  if (await isDatabaseAvailable()) {
    return postgresStore.listRunnableScanJobs(limit);
  }

  const state = await loadState();
  return state.jobs
    .filter((job) =>
      !job.archivedAt &&
      ["pending", "running", "throttled", "retry_later", "paused_by_memory", "paused_by_runtime"].includes(job.status)
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

export async function findActiveScanJobByProfile(profileId: string): Promise<ScanJob | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.findActiveScanJobByProfile(profileId);
  }

  const state = await loadState();
  return state.jobs
    .filter(
      (job) =>
        job.profileId === profileId &&
        !job.archivedAt &&
        [
          "pending",
          "running",
          "throttled",
          "retry_later",
          "paused_by_user",
          "paused_by_memory",
          "paused_by_runtime"
        ].includes(job.status)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export async function getScheduleState(profileId: string): Promise<
  | {
      lastCheckedAt?: string;
      lastScheduledAt?: string;
      lastJobId?: string;
    }
  | undefined
> {
  if (await isDatabaseAvailable()) {
    return postgresStore.getScheduleState(profileId);
  }

  void profileId;
  return undefined;
}

export async function touchScheduleState(input: {
  profileId: string;
  checkedAt: string;
  scheduledAt?: string;
  jobId?: string;
}) {
  if (await isDatabaseAvailable()) {
    return postgresStore.touchScheduleState(input);
  }

  void input;
}

export async function createScanJob(
  profileId: string,
  type: ScanJob["type"] = "manual_scan"
): Promise<ScanJob> {
  if (await isDatabaseAvailable()) {
    return postgresStore.createScanJob(profileId, type);
  }

  const state = await loadState();
  const profile = state.profiles.find((item) => item.id === profileId);
  const now = new Date().toISOString();
  const job: ScanJob = {
    id: crypto.randomUUID(),
    profileId,
    type,
    status: "pending",
    stage: "collect",
    maxCandidates: profile?.config.limits.maxCandidates ?? 0,
    fetchedCount: 0,
    processedCount: 0,
    analyzedCount: 0,
    newRepoCount: 0,
    updatedRepoCount: 0,
    unchangedRepoCount: 0,
    candidateCount: 0,
    failedCandidateCount: 0,
    createdAt: now
  };

  state.jobs.unshift(job);
  await saveState(state);
  return job;
}

export async function updateScanJob(
  jobId: string,
  patch: Partial<ScanJob>
): Promise<ScanJob | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.updateScanJob(jobId, patch);
  }

  const state = await loadState();
  let updated: ScanJob | undefined;

  state.jobs = state.jobs.map((job) => {
    if (job.id !== jobId) {
      return job;
    }

    const hasErrorPatch = Object.prototype.hasOwnProperty.call(patch, "errorMessage");
    const hasStatusReasonPatch = Object.prototype.hasOwnProperty.call(patch, "statusReason");
    updated = {
      ...job,
      ...patch,
      errorMessage: hasErrorPatch
        ? patch.errorMessage
        : hasStatusReasonPatch
          ? patch.statusReason
          : job.errorMessage,
      statusReason: hasStatusReasonPatch
        ? patch.statusReason
        : hasErrorPatch
          ? patch.errorMessage
          : job.statusReason
    };
    return updated;
  });

  await saveState(state);
  return updated;
}

export async function upsertRepos(
  repos: RepoSummary[],
  dataLevel: RepoDataLevel = "L1"
): Promise<UpsertRepoStats> {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertRepos(repos, dataLevel);
  }

  const state = await loadState();
  const byId = new Map(state.repos.map((repo) => [repo.id, repo]));
  const stats: UpsertRepoStats = {
    newCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    repos: []
  };

  for (const repo of repos) {
    const existing = findLocalRepo(state.repos, repo);
    const existingDataLevel = existing ? state.repoDataLevels[existing.id] ?? "L0" : undefined;
    const analysisDecision = shouldAnalyzeDiscoveredRepo({
      existing,
      existingDataLevel,
      next: repo
    });
    if (!existing) {
      stats.newCount += 1;
      stats.repos.push({
        repo,
        status: "new",
        shouldAnalyze: analysisDecision.shouldAnalyze,
        analyzeReason: analysisDecision.reason
      });
      state.repoDataLevels[repo.id] = mergeDataLevel(state.repoDataLevels[repo.id], dataLevel);
      byId.set(repo.id, repo);
      continue;
    }

    const status = repoHasMaterialChanges(existing, repo) ? "updated" : "unchanged";
    if (status === "updated") {
      stats.updatedCount += 1;
    } else {
      stats.unchangedCount += 1;
    }

    repo.id = existing.id;
    byId.set(existing.id, {
      ...existing,
      ...repo
    });
    stats.repos.push({
      repo,
      status,
      existingDataLevel,
      shouldAnalyze: analysisDecision.shouldAnalyze,
      analyzeReason: analysisDecision.reason
    });
    state.repoDataLevels[existing.id] = mergeDataLevel(existingDataLevel, dataLevel);
  }

  state.repos = [...byId.values()];
  await saveState(state);
  return stats;
}

export async function upsertRecommendations(
  recommendations: Recommendation[]
): Promise<void> {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertRecommendations(recommendations);
  }

  const state = await loadState();
  const byId = new Map(state.recommendations.map((item) => [item.id, item]));

  for (const recommendation of annotateRecommendationClusters(recommendations)) {
    const existing = byId.get(recommendation.id);
    const displayRecommendation = withChineseDisplay(recommendation);
    byId.set(recommendation.id, {
      ...displayRecommendation,
      status: existing?.status ?? recommendation.status,
      tags: existing?.tags ?? recommendation.tags ?? []
    });

    state.repoContextMatches = [
      ...state.repoContextMatches.filter(
        (item) => item.candidateRepoId !== recommendation.repo.id
      ),
      ...displayRecommendation.relatedUserRepos
        .filter((repo) => repo.userRepoId)
        .map((repo) => ({
          candidateRepoId: displayRecommendation.repo.id,
          userRepoId: repo.userRepoId as string,
          score: repo.score,
          reasons: [repo.reason]
        }))
    ];
  }

  state.recommendations = annotateRecommendationClusters(
    [...byId.values()].sort((a, b) => b.scores.final - a.scores.final)
  );

  await saveState(state);
}

export async function enqueueCandidates(
  jobId: string,
  candidates: Array<{ repo: RepoSummary; priorityScore: number; stage?: string }>
): Promise<void> {
  if (await isDatabaseAvailable()) {
    return postgresStore.enqueueCandidates(jobId, candidates);
  }

  void jobId;
  void candidates;
}

export async function upgradeRepoDataLevel(
  repos: RepoSummary[],
  dataLevel: RepoDataLevel
): Promise<void> {
  if (await isDatabaseAvailable()) {
    return postgresStore.upgradeRepoDataLevel(repos, dataLevel);
  }

  const state = await loadState();
  for (const repo of repos) {
    const existing = findLocalRepo(state.repos, repo);
    if (existing) {
      state.repoDataLevels[existing.id] = mergeDataLevel(state.repoDataLevels[existing.id], dataLevel);
      repo.id = existing.id;
    }
  }
  await saveState(state);
}

export async function upsertScanCheckpoint(
  checkpoint: Omit<ScanCheckpoint, "id" | "updatedAt">
): Promise<ScanCheckpoint> {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertScanCheckpoint(checkpoint);
  }

  const state = await loadState();
  const now = new Date().toISOString();
  const existing = state.checkpoints.find(
    (item) =>
      item.jobId === checkpoint.jobId &&
      item.source === checkpoint.source &&
      item.queryHash === checkpoint.queryHash &&
      item.stage === checkpoint.stage
  );
  const next: ScanCheckpoint = {
    id: existing?.id ?? crypto.randomUUID(),
    updatedAt: now,
    ...checkpoint
  };

  state.checkpoints = [
    next,
    ...state.checkpoints.filter((item) => item.id !== next.id)
  ];
  await saveState(state);
  return next;
}

export async function getScanCheckpoint(
  jobId: string,
  source: string,
  queryHash: string,
  stage: string
): Promise<ScanCheckpoint | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.getScanCheckpoint(jobId, source, queryHash, stage);
  }

  const state = await loadState();
  return state.checkpoints.find(
    (item) =>
      item.jobId === jobId &&
      item.source === source &&
      item.queryHash === queryHash &&
      item.stage === stage
  );
}

export async function listScanCheckpoints(jobId: string): Promise<ScanCheckpoint[]> {
  if (await isDatabaseAvailable()) {
    return postgresStore.listScanCheckpoints(jobId);
  }

  const state = await loadState();
  return state.checkpoints.filter((checkpoint) => checkpoint.jobId === jobId);
}

export async function listRecommendations() {
  if (await isDatabaseAvailable()) {
    return postgresStore.listRecommendations();
  }

  const state = await loadState();
  return state.recommendations.map(withChineseDisplay).sort((a, b) => a.rank - b.rank);
}

export async function updateRecommendationTags(
  id: string,
  tags: string[]
): Promise<Recommendation | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.updateRecommendationTags(id, tags);
  }

  const state = await loadState();
  const normalizedTags = normalizeTagInput(tags);
  let updated: Recommendation | undefined;
  state.recommendations = state.recommendations.map((recommendation) => {
    if (recommendation.id !== id) {
      return recommendation;
    }
    updated = {
      ...recommendation,
      tags: normalizedTags
    };
    return updated;
  });
  await saveState(state);

  return updated ? withChineseDisplay(updated) : undefined;
}

export async function listRecommendationTags(): Promise<string[]> {
  if (await isDatabaseAvailable()) {
    return postgresStore.listRecommendationTags();
  }

  const state = await loadState();
  return normalizeTagInput(state.recommendations.flatMap((recommendation) => recommendation.tags ?? []));
}

function withChineseDisplay(recommendation: Recommendation): Recommendation {
  const matchedPreferences = normalizeChineseLabels(recommendation.matchedPreferences);

  return {
    ...recommendation,
    tags: recommendation.tags ?? [],
    summaryZh: ensureChineseSummary(
      recommendation.summaryZh ?? recommendation.summary,
      recommendation.repo,
      matchedPreferences
    ),
    reasons: normalizeChineseLabels(recommendation.reasons),
    risks: normalizeChineseLabels(recommendation.risks),
    matchedPreferences,
    relatedUserRepos: recommendation.relatedUserRepos.map((repo) => ({
      ...repo,
      reason: normalizeChineseLabels([repo.reason])[0] ?? ""
    }))
  };
}

function normalizeTagInput(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

export async function recordFeedback(
  repoId: string,
  profileId: string,
  action: FeedbackAction,
  note?: string
): Promise<Feedback> {
  if (await isDatabaseAvailable()) {
    return postgresStore.recordFeedback(repoId, profileId, action, note);
  }

  const state = await loadState();
  const feedback: Feedback = {
    id: crypto.randomUUID(),
    repoId,
    profileId,
    action,
    note,
    createdAt: new Date().toISOString()
  };

  state.feedback.push(feedback);
  const repo =
    state.repos.find((item) => item.id === repoId) ??
    state.recommendations.find((item) => item.repo.id === repoId)?.repo;
  if (repo) {
    state.preferenceSignals.push(
      ...buildPreferenceSignals(repo, profileId, action).map((signal) => ({
        ...signal,
        id: crypto.randomUUID(),
        updatedAt: new Date().toISOString()
      }))
    );
  }
  state.recommendations = state.recommendations.map((recommendation) => {
    if (recommendation.repo.id !== repoId || recommendation.profileId !== profileId) {
      return recommendation;
    }

    const status =
      action === "save"
        ? "saved"
        : action === "like"
          ? "liked"
          : action === "dislike"
            ? "disliked"
            : action === "hide"
              ? "hidden"
              : action === "restore"
                ? "viewed"
                : action === "track"
                  ? "tracked"
                  : action === "to_validate"
                    ? "to_validate"
                    : action === "validating"
                      ? "validating"
                      : action === "monetization_ready"
                        ? "monetization_ready"
                        : action === "abandon"
                          ? "abandoned"
                          : recommendation.status;

    return {
      ...recommendation,
      status
    };
  });

  await saveState(state);
  return feedback;
}

export async function rebuildRecommendationScores(profileId: string) {
  if (await isDatabaseAvailable()) {
    const profile = (await listProfiles()).find((item) => item.id === profileId);
    if (!profile) {
      return;
    }
    const signals = await listPreferenceSignals(profileId);
    const userRepos = await listGithubRepos();
    const target = (await listRecommendations()).filter((item) => item.profileId === profileId);
    await upsertRecommendations(
      target.map((item, index) =>
        buildRecommendation(item.repo, profile, index + 1, undefined, signals, userRepos)
      )
    );
    return;
  }

  const state = await loadState();
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return;
  }
  const signals = state.preferenceSignals.filter((signal) => signal.profileId === profileId);
  state.recommendations = state.recommendations.map((recommendation) =>
    recommendation.profileId === profileId
      ? {
          ...buildRecommendation(
            recommendation.repo,
            profile,
            recommendation.rank,
            undefined,
            signals,
            state.githubRepos
          ),
          id: recommendation.id,
          status: recommendation.status,
          tags: recommendation.tags ?? [],
          createdAt: recommendation.createdAt
        }
      : recommendation
  );
  await saveState(state);
}

export async function listPreferenceSignals(profileId: string): Promise<PreferenceSignal[]> {
  if (await isDatabaseAvailable()) {
    return postgresStore.listPreferenceSignals(profileId);
  }

  const state = await loadState();
  return state.preferenceSignals.filter((signal) => signal.profileId === profileId);
}

export async function listGithubRepos() {
  if (await isDatabaseAvailable()) {
    return postgresStore.listGithubRepos();
  }

  const state = await loadState();
  return state.githubRepos;
}

export async function listGithubAccounts(): Promise<GithubAccount[]> {
  if (await isDatabaseAvailable()) {
    return postgresStore.listGithubAccounts();
  }

  const state = await loadState();
  return state.githubAccounts;
}

export async function upsertGithubAccount(input: {
  username: string;
  tokenRef?: string;
}): Promise<GithubAccount> {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertGithubAccount(input);
  }

  const state = await loadState();
  const existing = state.githubAccounts.find((item) => item.username === input.username);
  const account: GithubAccount = {
    id: existing?.id ?? crypto.randomUUID(),
    username: input.username,
    tokenRef: input.tokenRef,
    connectedAt: existing?.connectedAt ?? new Date().toISOString(),
    lastSyncedAt: new Date().toISOString()
  };

  state.githubAccounts = [
    account,
    ...state.githubAccounts.filter((item) => item.username !== input.username)
  ];
  await saveState(state);
  return account;
}

export async function replaceUserRepos(githubAccountId: string, repos: UserGitHubRepo[]) {
  if (await isDatabaseAvailable()) {
    return postgresStore.replaceUserRepos(githubAccountId, repos);
  }

  const state = await loadState();
  state.githubRepos = [
    ...state.githubRepos.filter((repo) => repo.githubAccountId !== githubAccountId),
    ...repos
  ];
  await saveState(state);
}

export async function updateGithubRepoContext(
  id: string,
  patch: Pick<UserGitHubRepo, "selectedForContext">
) {
  if (await isDatabaseAvailable()) {
    return postgresStore.updateGithubRepoContext(id, patch);
  }

  const state = await loadState();
  let updated: UserGitHubRepo | undefined;
  state.githubRepos = state.githubRepos.map((repo) => {
    if (repo.id !== id) {
      return repo;
    }

    updated = {
      ...repo,
      selectedForContext: patch.selectedForContext
    };
    return updated;
  });

  await saveState(state);
  return updated;
}

export async function listKnowledgeSyncs(): Promise<KnowledgeSync[]> {
  if (await isDatabaseAvailable()) {
    return postgresStore.listKnowledgeSyncs();
  }

  const state = await loadState();
  return state.knowledgeSyncs;
}

export async function upsertKnowledgeSync(input: {
  repoId: string;
  repoFullName?: string;
  target: string;
  datasetId?: string;
  externalDocId?: string;
  contentHash: string;
  status: KnowledgeSync["status"];
  syncedAt?: string;
  errorMessage?: string;
}): Promise<KnowledgeSync> {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertKnowledgeSync(input);
  }

  const state = await loadState();
  const existing = state.knowledgeSyncs.find(
    (item) =>
      item.repoId === input.repoId &&
      item.target === input.target &&
      (item.datasetId ?? "") === (input.datasetId ?? "") &&
      item.contentHash === input.contentHash
  );
  const sync: KnowledgeSync = {
    id: existing?.id ?? crypto.randomUUID(),
    repoId: input.repoId,
    repoFullName:
      input.repoFullName ??
      state.repos.find((repo) => repo.id === input.repoId)?.fullName ??
      existing?.repoFullName,
    target: input.target,
    datasetId: input.datasetId,
    externalDocId: input.externalDocId,
    contentHash: input.contentHash,
    status: input.status,
    syncedAt: input.syncedAt,
    errorMessage: input.errorMessage
  };

  state.knowledgeSyncs = [
    sync,
    ...state.knowledgeSyncs.filter((item) => item.id !== sync.id)
  ];
  await saveState(state);
  return sync;
}

export async function getQueueStats() {
  if (await isDatabaseAvailable()) {
    return postgresStore.getQueueStats();
  }

  return (await loadState()).queueStats;
}

export async function claimCandidateBatch(stage = "profile", limit = 10) {
  if (await isDatabaseAvailable()) {
    return postgresStore.claimCandidateBatch(stage, limit);
  }

  return [];
}

export async function getQueuedRepoBatch(
  jobId: string,
  stage = "profile",
  status = "pending",
  limit = 10
) {
  if (await isDatabaseAvailable()) {
    return postgresStore.getQueuedRepoBatch(jobId, stage, status, limit);
  }

  void jobId;
  void stage;
  void status;
  void limit;
  return [];
}

export async function claimQueuedRepoBatch(
  jobId: string,
  stage = "profile",
  limit = 10
) {
  if (await isDatabaseAvailable()) {
    return postgresStore.claimQueuedRepoBatch(jobId, stage, limit);
  }

  void jobId;
  void stage;
  void limit;
  return [];
}

export async function requeueRunningCandidates(jobId: string, stage?: string) {
  if (await isDatabaseAvailable()) {
    return postgresStore.requeueRunningCandidates(jobId, stage);
  }

  void jobId;
  void stage;
}

export async function requeueStaleRunningCandidates(staleAfterMinutes = 5) {
  if (await isDatabaseAvailable()) {
    return postgresStore.requeueStaleRunningCandidates(staleAfterMinutes);
  }

  void staleAfterMinutes;
  return [];
}

export async function getJobQueueCount(jobId: string, stage?: string, status?: string) {
  if (await isDatabaseAvailable()) {
    return postgresStore.getJobQueueCount(jobId, stage, status);
  }

  void jobId;
  void stage;
  void status;
  return 0;
}

export async function completeCandidate(id: string) {
  if (await isDatabaseAvailable()) {
    return postgresStore.completeCandidate(id);
  }
}

export async function retryCandidate(id: string, retryAfterSeconds: number) {
  if (await isDatabaseAvailable()) {
    return postgresStore.retryCandidate(id, retryAfterSeconds);
  }

  void id;
  void retryAfterSeconds;
}

export async function failCandidate(
  id: string,
  reason: string,
  retryAfterSeconds?: number
) {
  if (await isDatabaseAvailable()) {
    return postgresStore.failCandidate(id, reason, retryAfterSeconds);
  }

  void id;
  void reason;
  void retryAfterSeconds;
}

export async function recordResourceEvent(
  event: Omit<ResourceEvent, "id" | "createdAt">
): Promise<ResourceEvent> {
  if (await isDatabaseAvailable()) {
    return postgresStore.recordResourceEvent(event);
  }

  const state = await loadState();
  const resourceEvent: ResourceEvent = {
    ...event,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString()
  };

  state.resourceEvents.unshift(resourceEvent);
  await saveState(state);
  return resourceEvent;
}

export async function trimRecommendations(profileId: string, limit: number) {
  if (await isDatabaseAvailable()) {
    return postgresStore.trimRecommendations(profileId, limit);
  }

  const state = await loadState();
  state.recommendations = state.recommendations
    .filter((recommendation) => recommendation.profileId !== profileId)
    .concat(
      state.recommendations
        .filter((recommendation) => recommendation.profileId === profileId)
        .sort((a, b) => b.scores.final - a.scores.final)
        .slice(0, limit)
        .map((recommendation, index) => ({ ...recommendation, rank: index + 1 }))
    );
  await saveState(state);
}

export async function upsertRepoDocument(input: {
  repoId: string;
  type: string;
  sourceUrl?: string;
  contentHash: string;
  rawContent?: string;
  summary?: string;
  extractedKeywords?: string[];
}) {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertRepoDocument(input);
  }

  const state = await loadState();
  state.repoDocuments = [
    {
      repoId: input.repoId,
      type: input.type,
      sourceUrl: input.sourceUrl,
      contentHash: input.contentHash,
      rawContent: input.rawContent ?? "",
      summary: input.summary
    },
    ...state.repoDocuments.filter(
      (item) =>
        !(
          item.repoId === input.repoId &&
          item.type === input.type &&
          item.contentHash === input.contentHash
        )
    )
  ];
  await saveState(state);
  return input;
}

export async function getLatestRepoDocument(repoId: string, type: string) {
  if (await isDatabaseAvailable()) {
    return postgresStore.getLatestRepoDocument(repoId, type);
  }

  const state = await loadState();
  return state.repoDocuments.find((item) => item.repoId === repoId && item.type === type);
}

export async function upsertRepoEmbedding(input: {
  repoId: string;
  providerId: string;
  model: string;
  dimensions: number;
  contentHash: string;
  vector: number[];
}) {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertRepoEmbedding(input);
  }

  const state = await loadState();
  state.repoEmbeddings = [
    {
      ...input,
      createdAt: new Date().toISOString()
    },
    ...state.repoEmbeddings.filter(
      (item) =>
        !(
          item.repoId === input.repoId &&
          item.providerId === input.providerId &&
          item.contentHash === input.contentHash
        )
    )
  ];
  await saveState(state);
}

export async function getRepoEmbedding(input: {
  repoId: string;
  providerId: string;
  model: string;
  contentHash: string;
}) {
  if (await isDatabaseAvailable()) {
    return postgresStore.getRepoEmbedding(input);
  }

  const state = await loadState();
  return state.repoEmbeddings.find(
    (item) =>
      item.repoId === input.repoId &&
      item.providerId === input.providerId &&
      item.model === input.model &&
      item.contentHash === input.contentHash
  );
}

export async function getRepoEmbeddingVector(input: {
  repoId: string;
  providerId: string;
  model?: string;
  contentHash?: string;
}) {
  if (await isDatabaseAvailable()) {
    return postgresStore.getRepoEmbeddingVector(input);
  }

  const state = await loadState();
  return state.repoEmbeddings.find(
    (item) =>
      item.repoId === input.repoId &&
      item.providerId === input.providerId &&
      (!input.model || item.model === input.model) &&
      (!input.contentHash || item.contentHash === input.contentHash)
  );
}

export async function upsertCachedEmbedding(input: CachedEmbedding & { cacheKey: string }) {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertCachedEmbedding(input);
  }

  const state = await loadState();
  state.embeddingCache = [
    {
      ...input,
      createdAt: new Date().toISOString()
    },
    ...state.embeddingCache.filter((item) => item.cacheKey !== input.cacheKey)
  ];
  await saveState(state);
}

export async function getCachedEmbedding(input: {
  cacheKey: string;
  providerId: string;
  model: string;
  contentHash: string;
}): Promise<CachedEmbedding | undefined> {
  if (await isDatabaseAvailable()) {
    return postgresStore.getCachedEmbedding(input);
  }

  const state = await loadState();
  return state.embeddingCache.find(
    (item) =>
      item.cacheKey === input.cacheKey &&
      item.providerId === input.providerId &&
      item.model === input.model &&
      item.contentHash === input.contentHash
  );
}

export async function rerankRecommendationsWithSemanticFit(input: {
  profileId: string;
  providerId: string;
  queryVector: number[];
}) {
  if (await isDatabaseAvailable()) {
    return postgresStore.rerankRecommendationsWithSemanticFit(input);
  }

  const state = await loadState();
  const reranked = state.recommendations
    .filter((item) => item.profileId === input.profileId)
    .map((recommendation) => {
      const embedding = state.repoEmbeddings
        .filter(
          (item) =>
            item.repoId === recommendation.repo.id &&
            item.providerId === input.providerId
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const semanticFit = embedding
        ? cosineSimilarity(embedding.vector, input.queryVector)
        : undefined;

      if (semanticFit === undefined) {
        return recommendation;
      }

      return {
        ...recommendation,
        scores: {
          ...recommendation.scores,
          githubContextFit: Math.max(recommendation.scores.githubContextFit, semanticFit),
          final: calculateFinalScore({
            ruleScore: recommendation.scores.rule,
            githubContextFit: Math.max(recommendation.scores.githubContextFit, semanticFit),
            llmMatchScore: recommendation.scores.llmMatch,
            feedbackScore: recommendation.scores.feedback,
            opportunityScore: recommendation.scores.opportunity,
            monetizationScore: recommendation.scores.monetization,
            growthSignal: recommendation.scores.growth,
            executionFit: recommendation.scores.execution,
            differentiationSpace: recommendation.scores.differentiation,
            technicalQuality: recommendation.scores.technicalQuality
          })
        }
      };
    })
    .sort((a, b) => b.scores.final - a.scores.final)
    .map((recommendation, index) => ({
      ...recommendation,
      rank: index + 1
    }));

  await upsertRecommendations(reranked);
}

export async function createLlmJob(input: {
  repoId: string;
  jobId?: string;
  jobType: string;
  status: string;
  inputHash: string;
  providerId: string;
  model: string;
  promptVersion: string;
}) {
  if (await isDatabaseAvailable()) {
    return postgresStore.createLlmJob(input);
  }

  void input;
  return crypto.randomUUID();
}

export async function finishLlmJob(
  id: string,
  status: string,
  tokenUsage: Record<string, unknown> = {},
  errorMessage?: string
) {
  if (await isDatabaseAvailable()) {
    return postgresStore.finishLlmJob(id, status, tokenUsage, errorMessage);
  }

  void id;
  void status;
  void tokenUsage;
  void errorMessage;
}

export async function upsertLlmResult(input: {
  repoId: string;
  providerId: string;
  model: string;
  jobType: string;
  promptVersion: string;
  inputHash?: string;
  structured: Record<string, unknown>;
  rawResponse?: string;
}) {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertLlmResult(input);
  }

  const state = await loadState();
  state.llmResults.unshift({
    repoId: input.repoId,
    jobType: input.jobType,
    providerId: input.providerId,
    model: input.model,
    promptVersion: input.promptVersion,
    inputHash: input.inputHash,
    structured: input.structured
  });
  await saveState(state);
}

export async function getLatestLlmResult(
  repoId: string,
  jobType: string,
  options: {
    providerId?: string;
    model?: string;
    promptVersion?: string;
    inputHash?: string;
  } = {}
) {
  if (await isDatabaseAvailable()) {
    return postgresStore.getLatestLlmResult(repoId, jobType, options);
  }

  const state = await loadState();
  return state.llmResults.find((item) => {
    if (item.repoId !== repoId || item.jobType !== jobType) {
      return false;
    }
    if (options.providerId && item.providerId !== options.providerId) {
      return false;
    }
    if (options.model && item.model !== options.model) {
      return false;
    }
    if (options.promptVersion && item.promptVersion !== options.promptVersion) {
      return false;
    }
    if (options.inputHash && item.inputHash !== options.inputHash) {
      return false;
    }
    return true;
  })?.structured;
}

function buildPreferenceSignals(
  repo: RepoSummary,
  profileId: string,
  action: FeedbackAction
): Array<Omit<PreferenceSignal, "id" | "updatedAt">> {
  const delta =
    action === "save" ||
    action === "track" ||
    action === "to_validate" ||
    action === "validating" ||
    action === "monetization_ready"
      ? 0.18
      : action === "like"
        ? 0.1
        : action === "hide"
          ? -0.18
          : action === "dislike" || action === "abandon"
            ? -0.1
            : 0;

  if (!delta) return [];

  const signals: Array<Omit<PreferenceSignal, "id" | "updatedAt">> = [];
  if (repo.primaryLanguage && repo.primaryLanguage !== "Unknown") {
    signals.push({
      profileId,
      signalType: "language",
      value: repo.primaryLanguage,
      weight: delta,
      source: `feedback:${action}`
    });
  }
  for (const topic of repo.topics) {
    signals.push({
      profileId,
      signalType: "topic",
      value: topic.toLowerCase(),
      weight: delta,
      source: `feedback:${action}`
    });
  }

  return signals;
}
