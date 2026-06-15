export type ProviderKind = "chat" | "embedding";
export type JobStatus =
  | "pending"
  | "running"
  | "throttled"
  | "paused_by_user"
  | "paused_by_memory"
  | "paused_by_runtime"
  | "retry_later"
  | "completed"
  | "failed";

export type JobStage =
  | "collect"
  | "profile"
  | "document"
  | "embed"
  | "llm"
  | "rank"
  | "sync";

export type FeedbackAction =
  | "save"
  | "hide"
  | "like"
  | "dislike"
  | "track"
  | "to_validate"
  | "validating"
  | "monetization_ready"
  | "abandon";
export type RepoDataLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export type DiscoverySourceId =
  | "github_search_preferences"
  | "github_topics"
  | "github_search_stars"
  | "github_search_recent_growth"
  | "github_trending"
  | "github_explore"
  | "ossinsight_trending"
  | "gharchive_velocity"
  | "openssf_scorecard"
  | "ecosystems_usage";

export interface DiscoverySourceConfig {
  id: DiscoverySourceId;
  enabled: boolean;
  weight: number;
}

export interface AiProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  type: "openai_compatible" | "custom";
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  dimensions?: number;
  enabled: boolean;
  rateLimit?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
  };
  timeoutSeconds?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveryProfile {
  id: string;
  name: string;
  enabled: boolean;
  config: DiscoveryProfileConfig;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveryProfileConfig {
  schedule: {
    type: "cron" | "interval";
    cron?: string;
    intervalHours?: number;
    timezone: string;
    startAt?: string;
    maxRuntimeMinutes: number;
    missedRunPolicy: "skip" | "run_once" | "resume";
  };
  limits: {
    sourceLimitPerQuery: number;
    maxCandidates: number;
    ruleFilterTopK: number;
      detailFetchTopK: number;
      embeddingTopK: number;
      llmAnalyzeTopK: number;
      semanticFitThreshold?: number;
      finalReportTopK: number;
  };
  preferences: {
    keywords: string[];
    topics: string[];
    languages: Record<string, number>;
    excludeKeywords: string[];
    minStars: number;
    pushedWithinDays: number;
    excludeArchived: boolean;
    excludeForks: boolean;
  };
  opportunity?: OpportunityProfile;
  sources?: DiscoverySourceConfig[];
  resourcePolicy: {
    mode: "complete_low_memory" | "balanced" | "fast";
    memory: {
      targetAvailableMb: number;
      minAvailableMb: number;
      criticalAvailableMb: number;
    };
    execution: {
      batchSize: number;
      maxConcurrency: number;
      checkpointEveryItems: number;
      pauseOnPressure: boolean;
    };
  };
  ai: {
    chatProviderId: string;
    embeddingProviderId: string;
  };
}

export interface OpportunityProfile {
  goals: string[];
  targetCustomers: string[];
  monetizationChannels: string[];
  preferredAdvantages: string[];
  excludeSignals: string[];
  minOpportunityScore: number;
}

export interface RepoSummary {
  id: string;
  githubId?: number;
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
  description: string;
  primaryLanguage: string;
  topics: string[];
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string;
  updatedAt: string;
  archived: boolean;
  fork: boolean;
  private?: boolean;
}

export interface Recommendation {
  id: string;
  profileId: string;
  repo: RepoSummary;
  rank: number;
  scores: {
    rule: number;
    githubContextFit: number;
    llmMatch: number;
    feedback: number;
    opportunity?: number;
    monetization?: number;
    growth?: number;
    execution?: number;
    differentiation?: number;
    technicalQuality?: number;
    final: number;
    scoreVersion: string;
  };
  summary: string;
  summaryZh?: string;
  opportunity?: OpportunityAnalysis;
  reasons: string[];
  risks: string[];
  matchedPreferences: string[];
  relatedUserRepos: Array<{
    userRepoId?: string;
    fullName: string;
    reason: string;
    score: number;
  }>;
  cluster?: RecommendationCluster;
  status:
    | "new"
    | "viewed"
    | "saved"
    | "hidden"
    | "tracked"
    | "to_validate"
    | "validating"
    | "monetization_ready"
    | "abandoned";
  createdAt: string;
}

export interface RecommendationCluster {
  key: string;
  label: string;
  reason: string;
  representativeTerms: string[];
  size?: number;
  rankInCluster?: number;
}

export interface OpportunityAnalysis {
  type: string;
  score: number;
  monetizationScore: number;
  growthSignal: number;
  executionFit: number;
  differentiationSpace: number;
  technicalQuality: number;
  targetCustomers: string[];
  monetizationPaths: string[];
  validationSteps: string[];
  suggestedAction: "observe" | "track" | "validate" | "build" | "ignore";
  evidence: string[];
}

export interface ScanJob {
  id: string;
  profileId: string;
  type: "first_scan" | "scheduled_scan" | "manual_scan";
  status: JobStatus;
  stage: JobStage;
  maxCandidates: number;
  fetchedCount: number;
  processedCount: number;
  analyzedCount: number;
  newRepoCount: number;
  updatedRepoCount: number;
  unchangedRepoCount: number;
  candidateCount: number;
  statusReason?: string;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  archivedAt?: string;
  createdAt: string;
}

export interface ScanCheckpoint {
  id: string;
  jobId: string;
  source: string;
  queryHash: string;
  page: number;
  cursor?: string;
  processedCount: number;
  stage: JobStage;
  updatedAt: string;
}

export interface ResourceEvent {
  id: string;
  jobId: string;
  stage: JobStage;
  status: "running" | "throttled" | "paused_by_memory";
  availableMb: number;
  rssMb: number;
  heapUsedMb: number;
  totalMb: number;
  batchSize: number;
  reason: string;
  createdAt: string;
}

export interface AiJobMetric {
  id: string;
  repoId: string;
  repoFullName?: string;
  providerId: string;
  providerName?: string;
  model: string;
  jobType: string;
  status: string;
  promptVersion: string;
  attempts: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  createdAt: string;
  finishedAt?: string;
}

export interface OperationsSnapshot {
  resourceEvents: ResourceEvent[];
  aiJobs: AiJobMetric[];
  aiCostSummary: {
    totalJobs: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
}

export interface UserGitHubRepo {
  id: string;
  githubAccountId?: string;
  githubId?: number;
  fullName: string;
  description: string;
  primaryLanguage: string;
  topics: string[];
  visibility: "public" | "private";
  readmeSummary?: string;
  selectedForContext: boolean;
  lastSyncedAt?: string;
}

export interface GithubAccount {
  id: string;
  username: string;
  tokenRef?: string;
  connectedAt: string;
  lastSyncedAt?: string;
}

export interface KnowledgeSync {
  id: string;
  repoId: string;
  repoFullName?: string;
  target: string;
  datasetId?: string;
  externalDocId?: string;
  contentHash: string;
  status: "pending" | "synced" | "skipped" | "failed";
  syncedAt?: string;
  errorMessage?: string;
}

export interface Feedback {
  id: string;
  repoId: string;
  profileId: string;
  action: FeedbackAction;
  note?: string;
  createdAt: string;
}

export interface PreferenceSignal {
  id: string;
  profileId: string;
  signalType: "language" | "topic" | "keyword";
  value: string;
  weight: number;
  source: string;
  updatedAt: string;
}

export interface AppSettings {
  scanEnabled: boolean;
  githubAutoSyncEnabled: boolean;
  githubAutoSyncIntervalHours: number;
  githubLastAutoSyncedAt?: string;
  githubLastAutoSyncAttemptAt?: string;
}

export interface UpsertRepoStats {
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  repos: Array<{
    repo: RepoSummary;
    status: "new" | "updated" | "unchanged";
    existingDataLevel?: RepoDataLevel;
    shouldAnalyze: boolean;
    analyzeReason: string;
  }>;
}

export interface CachedEmbedding {
  providerId: string;
  model: string;
  dimensions: number;
  contentHash: string;
  vector: number[];
  createdAt?: string;
}

export interface DashboardSnapshot {
  settings: AppSettings;
  profiles: DiscoveryProfile[];
  aiProviders: AiProvider[];
  recommendations: Recommendation[];
  jobs: ScanJob[];
  githubAccounts: GithubAccount[];
  githubRepos: UserGitHubRepo[];
  knowledgeSyncs: KnowledgeSync[];
  queueStats: QueueStat[];
  operations: OperationsSnapshot;
}

export interface QueueStat {
  stage: string;
  status: string;
  count: number;
}
