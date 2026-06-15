import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { seedSnapshot } from "@/lib/seed";
import { normalizeDiscoverySources } from "@/lib/discoverySources";
import {
  ensureChineseSummary,
  normalizeChineseLabels
} from "@/lib/recommendationText";
import type {
  AiProvider,
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
  llmResults: Array<{
    repoId: string;
    jobType: string;
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
    feedback: [],
    checkpoints: [],
    resourceEvents: [],
    repoDocuments: [],
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
    profiles: normalizeProfiles(state.profiles ?? seedSnapshot.profiles),
    aiProviders: state.aiProviders ?? seedSnapshot.aiProviders,
    recommendations,
    jobs: state.jobs ?? seedSnapshot.jobs,
    githubRepos: state.githubRepos ?? seedSnapshot.githubRepos,
    queueStats: state.queueStats ?? [],
    githubAccounts: state.githubAccounts ?? seedSnapshot.githubAccounts ?? [],
    repos: state.repos ?? recommendations.map((recommendation) => recommendation.repo),
    feedback: state.feedback ?? [],
    checkpoints: state.checkpoints ?? [],
    resourceEvents: state.resourceEvents ?? [],
    repoDocuments: state.repoDocuments ?? [],
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
      sources: normalizeDiscoverySources(profile.config.sources)
    }
  }));
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
    aiCostSummary: {
      totalJobs: 0,
      totalTokens: 0,
      estimatedCostUsd: 0
    }
  };
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
  patch: Partial<Pick<AiProvider, "enabled">>
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
): Promise<void> {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertRepos(repos, dataLevel);
  }

  const state = await loadState();
  const byId = new Map(state.repos.map((repo) => [repo.id, repo]));

  for (const repo of repos) {
    byId.set(repo.id, {
      ...byId.get(repo.id),
      ...repo
    });
  }

  state.repos = [...byId.values()];
  await saveState(state);
}

export async function upsertRecommendations(
  recommendations: Recommendation[]
): Promise<void> {
  if (await isDatabaseAvailable()) {
    return postgresStore.upsertRecommendations(recommendations);
  }

  const state = await loadState();
  const byId = new Map(state.recommendations.map((item) => [item.id, item]));

  for (const recommendation of recommendations) {
    const existing = byId.get(recommendation.id);
    const displayRecommendation = withChineseDisplay(recommendation);
    byId.set(recommendation.id, {
      ...displayRecommendation,
      status: existing?.status ?? recommendation.status
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

  state.recommendations = [...byId.values()].sort((a, b) => b.scores.final - a.scores.final);
  state.recommendations = state.recommendations.map((item, index) => ({
    ...item,
    rank: index + 1
  }));

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

  void repos;
  void dataLevel;
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

function withChineseDisplay(recommendation: Recommendation): Recommendation {
  const matchedPreferences = normalizeChineseLabels(recommendation.matchedPreferences);

  return {
    ...recommendation,
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
        : action === "hide"
          ? "hidden"
          : action === "track"
            ? "tracked"
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

  void input;
}

export async function rerankRecommendationsWithSemanticFit(input: {
  profileId: string;
  providerId: string;
  queryVector: number[];
}) {
  if (await isDatabaseAvailable()) {
    return postgresStore.rerankRecommendationsWithSemanticFit(input);
  }

  void input;
}

export async function createLlmJob(input: {
  repoId: string;
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
  tokenUsage: Record<string, unknown> = {}
) {
  if (await isDatabaseAvailable()) {
    return postgresStore.finishLlmJob(id, status, tokenUsage);
  }

  void id;
  void status;
  void tokenUsage;
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
  return state.llmResults.find((item) => item.repoId === repoId && item.jobType === jobType)
    ?.structured;
}

function buildPreferenceSignals(
  repo: RepoSummary,
  profileId: string,
  action: FeedbackAction
): Array<Omit<PreferenceSignal, "id" | "updatedAt">> {
  const delta =
    action === "save" || action === "track"
      ? 0.18
      : action === "like"
        ? 0.1
        : action === "hide"
          ? -0.18
          : action === "dislike"
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
