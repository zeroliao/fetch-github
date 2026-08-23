import crypto from "node:crypto";
import { compactMarkdownForAnalysis } from "@/lib/text";
import type {
  AiProvider,
  DiscoveryProfile,
  ProviderKind,
  RepoSummary,
  ScanJob,
} from "@/lib/types";
import { buildGitHubSearchQueryPlans } from "@/server/githubSearch";
import {
  fetchRepositoryReadme,
  GITHUB_SEARCH_MAX_PAGE_SIZE,
  GITHUB_SEARCH_MAX_RESULTS,
  isGitHubSearchPageComplete,
  searchRepositories,
} from "@/server/githubClient";
import {
  buildRecommendation,
  repoPassesHardFilters,
  scoreRepo,
} from "@/server/ranking";
import { AiProviderOutputSchemaError, callEmbedding } from "./aiClient";
import {
  analyzeRepoWithLlmWithUsage,
  buildRepoDeltaAnalysisPrompt,
  buildRepoAnalysisPrompt,
  REPO_DELTA_ANALYSIS_PROMPT_VERSION,
  REPO_ANALYSIS_PROMPT_VERSION,
  type RepoAnalysisResult,
} from "./llmAnalysis";
import {
  evaluateResourcePolicy,
  recordResourceDecision,
} from "./resourceGovernor";
import {
  classifyAiProviderFailure,
  orderEligibleProviders,
} from "./aiProviderPolicy";
import { resolveReadyAiProvider } from "./aiProviderResolver";
import {
  buildSourceAdapterPlans,
  type SourceAdapterPlan,
} from "./sourceAdapters";
import { classifyScanFailure } from "./scanFailure";
import {
  applyQualitySignalsToRecommendation,
  fetchRepoQualitySignals,
} from "./qualitySignals";
import {
  claimQueuedRepoBatch,
  claimRepoProcessing,
  completeCandidate,
  createLlmJob,
  enqueueCandidates,
  failCandidate,
  finishLlmJob,
  getCachedEmbedding,
  getAppSettings,
  getJobQueueCount,
  getLatestLlmResult,
  getLatestRepoDocument,
  getRepoEmbedding,
  listGithubRepos,
  getScanCheckpoint,
  getScanJob,
  listPreferenceSignals,
  listAiProviders,
  listProfiles,
  listRunnableScanJobs,
  listScanProviderStates,
  finishJobRepoProcessing,
  finishRepoProcessing,
  recordScanProviderFailure,
  recordScanProviderSuccess,
  requeueRunningCandidates,
  resetScanProviderFailures,
  rerankRecommendationsWithSemanticFit,
  retryCandidate,
  upgradeRepoDataLevel,
  updateScanJob,
  updateAiProviderAvailability,
  upsertLlmResult,
  upsertRepoDocument,
  upsertRepoEmbedding,
  upsertCachedEmbedding,
  upsertRecommendations,
  upsertRepos,
  upsertScanCheckpoint,
} from "./store";

const MAX_AI_CANDIDATE_ATTEMPTS = 3;
const MAX_TRANSIENT_PROVIDER_ATTEMPTS = 2;
const AI_PARSE_FAILURE_THRESHOLD = 3;
const SOURCE_LIMIT_PER_QUERY = GITHUB_SEARCH_MAX_PAGE_SIZE;
const GITHUB_SEARCH_MAX_PAGES =
  GITHUB_SEARCH_MAX_RESULTS / GITHUB_SEARCH_MAX_PAGE_SIZE;
const COMPLETE_CHECKPOINT_PREFIX = "complete:";

interface RunScanJobOptions {
  jobId: string;
}

export async function runNextScanJob() {
  const settings = await getAppSettings();
  if (!settings.scanEnabled) {
    return undefined;
  }

  const [job] = await listRunnableScanJobs(1);
  if (!job) {
    return undefined;
  }

  return runScanJob({
    jobId: job.id,
  });
}

export async function runScanJob(
  options: RunScanJobOptions,
): Promise<ScanJob | undefined> {
  return runScanJobInternal(options, false);
}

export async function resumeScanJob(
  options: RunScanJobOptions,
): Promise<ScanJob | undefined> {
  await resetScanProviderFailures(options.jobId);
  return runScanJobInternal(options, true);
}

async function runScanJobInternal(
  options: RunScanJobOptions,
  allowPaused: boolean,
): Promise<ScanJob | undefined> {
  const settings = await getAppSettings();
  if (!settings.scanEnabled) {
    return undefined;
  }

  const job = await getScanJob(options.jobId);
  if (!job) {
    return undefined;
  }
  if (
    ["completed", "failed"].includes(job.status) ||
    (!allowPaused && job.status === "exception") ||
    (!allowPaused && job.status === "paused_by_user")
  ) {
    return job;
  }

  const profile = (await listProfiles()).find(
    (item) => item.id === job.profileId,
  );
  if (!profile) {
    return updateScanJob(job.id, {
      status: "failed",
      errorMessage: "发现配置不存在，扫描任务无法继续。",
      errorCode: "unknown",
      errorResolution: "请恢复或重新创建有效的发现配置，然后重新发起扫描。",
      finishedAt: new Date().toISOString(),
    });
  }

  if (!profile.enabled) {
    return updateScanJob(job.id, {
      status: "paused_by_runtime",
      statusReason: "发现配置已停用，扫描任务暂停。",
    });
  }

  const shouldResumeFromQueue = [
    "retry_later",
    "paused_by_memory",
    "paused_by_runtime",
    "exception",
  ].includes(job.status);
  let current = shouldResumeFromQueue
    ? ((await updateScanJob(job.id, {
        status: "running",
        startedAt: job.startedAt ?? new Date().toISOString(),
        finishedAt: undefined,
        statusReason: undefined,
        errorMessage: undefined,
        errorCode: undefined,
        errorResolution: undefined,
      })) ?? job)
    : job.startedAt || job.status !== "pending"
      ? job
      : await updateScanJob(job.id, {
          status: "running",
          stage: "collect",
          startedAt: new Date().toISOString(),
          errorMessage: undefined,
        });

  if (!current) {
    return undefined;
  }

  try {
    if (current.stage === "collect") {
      current = (await runCollectStage(current, profile)) ?? current;
    }

    if (current.status !== "running" && current.status !== "throttled") {
      return current;
    }

    if (current.stage === "profile") {
      current = (await runProfileStage(current, profile)) ?? current;
    }

    if (current.status !== "running" && current.status !== "throttled") {
      return current;
    }

    if (current.stage === "document") {
      current = (await runDocumentStage(current, profile)) ?? current;
    }

    if (current.status !== "running" && current.status !== "throttled") {
      return current;
    }

    if (current.stage === "embed") {
      current = (await runEmbedStage(current, profile)) ?? current;
    }

    if (current.status !== "running" && current.status !== "throttled") {
      return current;
    }

    if (current.stage === "llm") {
      current = (await runLlmStage(current, profile)) ?? current;
    }

    if (current.status !== "running" && current.status !== "throttled") {
      return current;
    }

    if (current.stage === "rank") {
      current = (await runRankStage(current, profile)) ?? current;
    }

    return current;
  } catch (error) {
    const failure = classifyScanFailure(error);
    await finishJobRepoProcessing({
      jobId: job.id,
      status: "failed",
      errorCode: failure.code,
      errorMessage: failure.message,
    });
    return (
      (await updateScanJob(job.id, {
        status: "failed",
        stage: current.stage,
        statusReason: undefined,
        errorMessage: failure.message,
        errorCode: failure.code,
        errorResolution: failure.resolution,
        finishedAt: new Date().toISOString(),
      })) ?? {
        ...current,
        status: "failed",
        errorMessage: failure.message,
        errorCode: failure.code,
        errorResolution: failure.resolution,
        finishedAt: new Date().toISOString(),
      }
    );
  }
}

async function runCollectStage(
  job: ScanJob,
  profile: DiscoveryProfile,
): Promise<ScanJob | undefined> {
  const resource = evaluateResourcePolicy(profile, "collect");
  await recordResourceDecision(job.id, "collect", resource);
  if (resource.status === "paused_by_memory") {
    return updateScanJob(job.id, {
      status: "paused_by_memory",
      statusReason: resource.reason,
    });
  }

  let currentJob = await updateScanJob(job.id, {
    status: resource.status === "throttled" ? "throttled" : "running",
    stage: "collect",
    statusReason: resource.status === "throttled" ? resource.reason : undefined,
  });
  if (!currentJob) {
    return undefined;
  }

  const queryPlans = buildGitHubSearchQueryPlans(profile);
  const sourceAdapterPlans = buildSourceAdapterPlans(profile);
  const preferenceSignals = await listPreferenceSignals(profile.id);
  const workUnitLimit = Math.max(1, resource.batchSize);
  let workUnitsProcessed = 0;

  for (const plan of sourceAdapterPlans) {
    if (workUnitsProcessed >= workUnitLimit) {
      break;
    }

    const result = await runSourceAdapterCollect({
      job,
      currentJob,
      profile,
      plan,
      preferenceSignals,
      resourceStatus: resource.status,
      resourceReason: resource.reason,
    });
    currentJob = result.job ?? currentJob;
    if (result.didWork) workUnitsProcessed += 1;
  }

  for (const plan of queryPlans) {
    if (workUnitsProcessed >= workUnitLimit) {
      break;
    }

    const queryHash = hashQuery(
      `${plan.sourceId}:${plan.query}:${plan.sort}:${plan.order}`,
    );
    const checkpoint = await getScanCheckpoint(
      job.id,
      plan.sourceId,
      queryHash,
      "collect",
    );
    if (isCompletedCheckpoint(checkpoint)) {
      continue;
    }
    const nextPage = (checkpoint?.page ?? 0) + 1;
    if (nextPage > GITHUB_SEARCH_MAX_PAGES) {
      continue;
    }

    const result = await searchRepositories({
      query: plan.query,
      perPage: SOURCE_LIMIT_PER_QUERY,
      page: nextPage,
      sort: plan.sort,
      order: plan.order,
    });

    const repos = result.repos;

    const repoStats = await upsertRepos(repos, "L0");
    const candidates = await selectDeepAnalysisCandidates(
      repoStats,
      profile,
      job.id,
    );
    await upgradeRepoDataLevel(candidates, "L1");
    await enqueueCandidates(
      job.id,
      candidates.map((repo) => ({
        repo,
        priorityScore:
          scoreRepo(repo, profile, preferenceSignals).finalScore * plan.weight,
        stage: "profile",
      })),
    );

    const fetchedCount: number = currentJob.fetchedCount + repos.length;
    const processedCount: number =
      currentJob.processedCount + candidates.length;
    const nextRepoStats = addRepoStats(
      currentJob,
      repoStats,
      candidates.length,
    );
    const queryComplete = isGitHubSearchPageComplete({
      page: nextPage,
      perPage: SOURCE_LIMIT_PER_QUERY,
      returnedCount: repos.length,
      totalCount: result.totalCount,
    });
    await upsertScanCheckpoint({
      jobId: job.id,
      source: plan.sourceId,
      queryHash,
      page: nextPage,
      cursor: `${queryComplete ? COMPLETE_CHECKPOINT_PREFIX : ""}${plan.sourceLabel}: ${plan.query}`,
      processedCount: fetchedCount,
      stage: "collect",
    });

    currentJob =
      (await updateScanJob(job.id, {
        status: resource.status === "throttled" ? "throttled" : "running",
        stage: "collect",
        fetchedCount,
        processedCount,
        ...nextRepoStats,
        statusReason:
          resource.status === "throttled" ? resource.reason : undefined,
      })) ?? currentJob;
    workUnitsProcessed += 1;
  }

  if (await isCollectComplete(job.id, profile)) {
    return updateScanJob(job.id, {
      status: "running",
      stage: "profile",
      statusReason: undefined,
    });
  }

  return currentJob;
}

async function runSourceAdapterCollect(input: {
  job: ScanJob;
  currentJob: ScanJob;
  profile: DiscoveryProfile;
  plan: SourceAdapterPlan;
  preferenceSignals: Awaited<ReturnType<typeof listPreferenceSignals>>;
  resourceStatus: "running" | "throttled" | "paused_by_memory";
  resourceReason: string;
}) {
  const queryHash = hashQuery(input.plan.queryHashKey);
  const checkpoint = await getScanCheckpoint(
    input.job.id,
    input.plan.sourceId,
    queryHash,
    "collect",
  );
  if ((checkpoint?.page ?? 0) >= 1) {
    return { job: input.currentJob, didWork: false };
  }

  const repos = await input.plan.fetchRepos(SOURCE_LIMIT_PER_QUERY);

  const repoStats = await upsertRepos(repos, "L0");
  const candidates = await selectDeepAnalysisCandidates(
    repoStats,
    input.profile,
    input.job.id,
  );
  await upgradeRepoDataLevel(candidates, "L1");
  await enqueueCandidates(
    input.job.id,
    candidates.map((repo) => ({
      repo,
      priorityScore:
        scoreRepo(repo, input.profile, input.preferenceSignals).finalScore *
        input.plan.weight,
      stage: "profile",
    })),
  );

  const fetchedCount = input.currentJob.fetchedCount + repos.length;
  const processedCount = input.currentJob.processedCount + candidates.length;
  const nextRepoStats = addRepoStats(
    input.currentJob,
    repoStats,
    candidates.length,
  );
  await upsertScanCheckpoint({
    jobId: input.job.id,
    source: input.plan.sourceId,
    queryHash,
    page: 1,
    cursor: input.plan.cursor,
    processedCount: fetchedCount,
    stage: "collect",
  });

  return {
    job: await updateScanJob(input.job.id, {
      status: input.resourceStatus === "throttled" ? "throttled" : "running",
      stage: "collect",
      fetchedCount,
      processedCount,
      ...nextRepoStats,
      statusReason:
        input.resourceStatus === "throttled" ? input.resourceReason : undefined,
    }),
    didWork: true,
  };
}

async function selectDeepAnalysisCandidates(
  repoStats: Awaited<ReturnType<typeof upsertRepos>>,
  profile: DiscoveryProfile,
  jobId: string,
) {
  const candidates: RepoSummary[] = [];

  for (const item of repoStats.repos) {
    const claim = await claimRepoProcessing({ repo: item.repo, jobId });
    if (!claim.claimed) {
      continue;
    }

    if (!repoPassesHardFilters(item.repo, profile)) {
      await finishRepoProcessing({
        canonicalUrl: item.repo.htmlUrl,
        repoId: item.repo.id,
        jobId,
        status: "skipped",
        skipReasonCode: "hard_filter",
      });
      continue;
    }

    candidates.push(item.repo);
  }

  return candidates;
}

function addRepoStats(
  job: ScanJob,
  stats: Awaited<ReturnType<typeof upsertRepos>>,
  candidateCount: number,
): Pick<
  ScanJob,
  "newRepoCount" | "updatedRepoCount" | "unchangedRepoCount" | "candidateCount"
> {
  return {
    newRepoCount: job.newRepoCount + stats.newCount,
    updatedRepoCount: job.updatedRepoCount + stats.updatedCount,
    unchangedRepoCount: job.unchangedRepoCount + stats.unchangedCount,
    candidateCount: job.candidateCount + candidateCount,
  };
}

async function runProfileStage(
  job: ScanJob,
  profile: DiscoveryProfile,
): Promise<ScanJob | undefined> {
  const resource = evaluateResourcePolicy(profile, "profile");
  await recordResourceDecision(job.id, "profile", resource);
  if (resource.status === "paused_by_memory") {
    await requeueRunningCandidates(job.id, "profile");
    return updateScanJob(job.id, {
      status: "paused_by_memory",
      statusReason: resource.reason,
    });
  }

  let currentJob =
    (await updateScanJob(job.id, {
      status: resource.status === "throttled" ? "throttled" : "running",
      stage: "profile",
      statusReason:
        resource.status === "throttled" ? resource.reason : undefined,
    })) ?? job;

  const queued = await claimQueuedRepoBatch(
    job.id,
    "profile",
    Math.max(1, resource.batchSize),
  );
  if (queued.length) {
    await enqueueCandidates(
      job.id,
      queued.map((item) => ({
        repo: item.repo,
        priorityScore: item.priorityScore,
        stage: "document",
      })),
    );

    for (const item of queued) {
      await completeCandidate(item.queueId);
    }

    currentJob =
      (await updateScanJob(job.id, {
        analyzedCount: currentJob.analyzedCount + queued.length,
        stage: "profile",
        status: resource.status === "throttled" ? "throttled" : "running",
        statusReason:
          resource.status === "throttled" ? resource.reason : undefined,
      })) ?? currentJob;
  }

  const remaining = await getJobQueueCount(job.id, "profile", "pending");
  const running = await getJobQueueCount(job.id, "profile", "running");
  if (remaining === 0 && running === 0) {
    return updateScanJob(job.id, {
      status: "running",
      stage: "document",
      analyzedCount: 0,
      statusReason: undefined,
    });
  }

  return currentJob;
}

async function runDocumentStage(
  job: ScanJob,
  profile: DiscoveryProfile,
): Promise<ScanJob | undefined> {
  const ready = await prepareStage(job, profile, "document");
  if (!ready.ok) {
    return ready.job;
  }

  let currentJob = ready.job;
  const queued = await claimQueuedRepoBatch(
    job.id,
    "document",
    ready.batchSize,
  );
  if (queued.length) {
    let succeeded = 0;
    let failed = 0;
    for (const item of queued) {
      try {
        const readme = await fetchRepositoryReadme(item.repo);
        const contentHash = hashText(
          readme.content || item.repo.description || item.repo.fullName,
        );
        await upsertRepoDocument({
          repoId: item.repo.id,
          type: "readme",
          sourceUrl: readme.sourceUrl,
          contentHash,
          rawContent: readme.content,
          summary: readme.content.slice(0, 500),
        });
        await upgradeRepoDataLevel([item.repo], "L2");
        await enqueueCandidates(job.id, [
          {
            repo: item.repo,
            priorityScore: item.priorityScore,
            stage: "embed",
          },
        ]);
        await completeCandidate(item.queueId);
        succeeded += 1;
      } catch (error) {
        const reason = normalizeAiStageError(error);
        if (item.attempts < MAX_AI_CANDIDATE_ATTEMPTS) {
          await retryCandidate(item.queueId, retryDelaySeconds(item.attempts));
        } else {
          await failCandidate(item.queueId, reason);
          await finishRepoWithError(
            item.repo,
            job.id,
            "failed",
            "document_failed",
            reason,
          );
          failed += 1;
        }
      }
    }

    currentJob =
      (await updateScanJob(job.id, {
        analyzedCount: currentJob.analyzedCount + succeeded,
        stage: "document",
        status: ready.status,
        statusReason: failed
          ? `详情阶段跳过 ${failed} 个连续失败候选。`
          : ready.reason,
      })) ?? currentJob;
  }

  return moveWhenStageDrained(currentJob, "document", "embed");
}

async function runEmbedStage(
  job: ScanJob,
  profile: DiscoveryProfile,
): Promise<ScanJob | undefined> {
  const ready = await prepareStage(job, profile, "embed");
  if (!ready.ok) {
    return ready.job;
  }

  const provider = await resolveJobProvider(job.id, "embedding");
  if (!provider) {
    return handleUnavailableProviderPool(job, "embedding", "embed");
  }

  let currentJob = ready.job;
  const queued = await claimQueuedRepoBatch(job.id, "embed", ready.batchSize);
  if (queued.length === 0) {
    return moveWhenStageDrained(currentJob, "embed", "llm");
  }

  let succeeded = 0;
  let failed = 0;
  const embeddingInputs = [];
  for (const item of queued) {
    const document = await getLatestRepoDocument(item.repo.id, "readme");
    const text = buildEmbeddingInput(item.repo, document?.rawContent ?? "");
    const contentHash = document?.contentHash ?? hashText(text);
    const cached = await getRepoEmbedding({
      repoId: item.repo.id,
      providerId: provider.id,
      model: provider.model,
      contentHash,
    });
    if (cached) {
      await enqueueCandidates(job.id, [
        {
          repo: item.repo,
          priorityScore: item.priorityScore,
          stage: "llm",
        },
      ]);
      await completeCandidate(item.queueId);
      succeeded += 1;
      continue;
    }

    embeddingInputs.push({ item, text, contentHash });
  }

  if (embeddingInputs.length) {
    let vectors: number[][];
    try {
      vectors = await callEmbedding(
        provider,
        embeddingInputs.map((input) => input.text),
      );
      if (vectors.length !== embeddingInputs.length) {
        throw new AiProviderOutputSchemaError(
          `expected ${embeddingInputs.length} vectors, received ${vectors.length}`,
        );
      }
      await recordScanProviderSuccess({
        jobId: job.id,
        providerId: provider.id,
        kind: "embedding",
      });
    } catch (error) {
      const failure = await handleProviderFailure(
        job.id,
        provider,
        error,
        Math.max(...embeddingInputs.map((input) => input.item.attempts)),
      );
      for (const input of embeddingInputs) {
        if (failure.classified) {
          await retryCandidate(
            input.item.queueId,
            failure.exhausted ? 1 : failure.retryAfterSeconds,
          );
        } else if (input.item.attempts < MAX_AI_CANDIDATE_ATTEMPTS) {
          await retryCandidate(
            input.item.queueId,
            retryDelaySeconds(input.item.attempts),
          );
        } else {
          await failCandidate(input.item.queueId, failure.reason);
          await finishRepoWithError(
            input.item.repo,
            job.id,
            "failed",
            failure.code,
            failure.reason,
          );
          failed += 1;
        }
      }

      currentJob =
        (await updateScanJob(job.id, {
          analyzedCount: currentJob.analyzedCount + succeeded,
          stage: "embed",
          status: ready.status,
          statusReason: failure.reason,
        })) ?? currentJob;
      if (
        failure.exhausted &&
        !(await resolveJobProvider(job.id, "embedding"))
      ) {
        return handleUnavailableProviderPool(currentJob, "embedding", "embed");
      }
      return currentJob;
    }

    for (const [index, input] of embeddingInputs.entries()) {
      const vector = vectors[index];
      await upsertRepoEmbedding({
        repoId: input.item.repo.id,
        providerId: provider.id,
        model: provider.model,
        dimensions: provider.dimensions ?? vector.length,
        contentHash: input.contentHash,
        vector,
      });
      await enqueueCandidates(job.id, [
        {
          repo: input.item.repo,
          priorityScore: input.item.priorityScore,
          stage: "llm",
        },
      ]);
      await completeCandidate(input.item.queueId);
      succeeded += 1;
    }
  }

  currentJob =
    (await updateScanJob(job.id, {
      analyzedCount: currentJob.analyzedCount + succeeded,
      stage: "embed",
      status: ready.status,
      statusReason: failed
        ? `Embedding 阶段跳过 ${failed} 个连续失败候选。`
        : ready.reason,
    })) ?? currentJob;

  return moveWhenStageDrained(currentJob, "embed", "llm");
}

async function runLlmStage(
  job: ScanJob,
  profile: DiscoveryProfile,
): Promise<ScanJob | undefined> {
  const ready = await prepareStage(job, profile, "llm");
  if (!ready.ok) {
    return ready.job;
  }

  const provider = await resolveJobProvider(job.id, "chat");
  if (!provider) {
    return handleUnavailableProviderPool(job, "chat", "llm");
  }

  const preferenceSignals = await listPreferenceSignals(profile.id);
  const userRepos = await listGithubRepos();
  let currentJob = ready.job;
  const queued = await claimQueuedRepoBatch(job.id, "llm", ready.batchSize);
  if (queued.length === 0) {
    return moveWhenStageDrained(currentJob, "llm", "rank");
  }

  let analyzed = 0;
  let skipped = 0;
  let failed = 0;
  let providerUnavailable = false;

  for (const [itemIndex, item] of queued.entries()) {
    let llmJobId: string | undefined;
    try {
      const document = await getLatestRepoDocument(item.repo.id, "readme");
      const readme = document?.rawContent ?? item.repo.description;
      const fullInputHash = buildLlmInputHash(item.repo, profile, readme);
      const fullCached = await getLatestLlmResult(
        item.repo.id,
        "repo_analysis",
        {
          providerId: provider.id,
          model: provider.model,
          promptVersion: REPO_ANALYSIS_PROMPT_VERSION,
          inputHash: fullInputHash,
        },
      );
      let analysis: RepoAnalysisResult;

      if (fullCached) {
        analysis = fullCached as unknown as RepoAnalysisResult;
      } else {
        const previousAnalysis = (await getLatestLlmResult(
          item.repo.id,
          "repo_analysis",
          { providerId: provider.id, model: provider.model },
        )) as RepoAnalysisResult | undefined;
        const promptVersion = previousAnalysis
          ? REPO_DELTA_ANALYSIS_PROMPT_VERSION
          : REPO_ANALYSIS_PROMPT_VERSION;
        const inputHash = previousAnalysis
          ? buildDeltaLlmInputHash(item.repo, profile, readme, previousAnalysis)
          : fullInputHash;
        const deltaCached = previousAnalysis
          ? await getLatestLlmResult(item.repo.id, "repo_analysis", {
              providerId: provider.id,
              model: provider.model,
              promptVersion,
              inputHash,
            })
          : undefined;

        if (deltaCached) {
          analysis = deltaCached as unknown as RepoAnalysisResult;
        } else {
          llmJobId = await createLlmJob({
            repoId: item.repo.id,
            jobId: job.id,
            jobType: "repo_analysis",
            status: "running",
            inputHash,
            providerId: provider.id,
            model: provider.model,
            promptVersion,
          });

          let llmResult: Awaited<
            ReturnType<typeof analyzeRepoWithLlmWithUsage>
          >;
          try {
            llmResult = await analyzeRepoWithLlmWithUsage(
              {
                repo: item.repo,
                profile,
                readme,
                previousAnalysis,
                changeHint: previousAnalysis
                  ? "仓库元数据、活跃度或 README 发生变化，本轮只需要重点复核变化对变现机会的影响。"
                  : undefined,
              },
              provider,
            );
            await recordScanProviderSuccess({
              jobId: job.id,
              providerId: provider.id,
              kind: "chat",
            });
          } catch (error) {
            const failure = await handleProviderFailure(
              job.id,
              provider,
              error,
              item.attempts,
            );
            await finishLlmJob(llmJobId, "failed", {}, failure.reason);
            await retryCandidate(
              item.queueId,
              failure.classified
                ? failure.exhausted
                  ? 1
                  : failure.retryAfterSeconds
                : retryDelaySeconds(item.attempts),
            );

            if (failure.exhausted || failure.cooldown) {
              for (const remaining of queued.slice(itemIndex + 1)) {
                await retryCandidate(remaining.queueId, 1);
              }
              providerUnavailable = true;
            } else if (
              !failure.classified &&
              item.attempts >= MAX_AI_CANDIDATE_ATTEMPTS
            ) {
              await failCandidate(item.queueId, failure.reason);
              await finishRepoWithError(
                item.repo,
                job.id,
                "failed",
                failure.code,
                failure.reason,
              );
              failed += 1;
            }
            if (providerUnavailable) break;
            continue;
          }

          analysis = llmResult.analysis;
          await upsertLlmResult({
            repoId: item.repo.id,
            providerId: provider.id,
            model: provider.model,
            jobType: "repo_analysis",
            promptVersion,
            inputHash,
            structured: analysis as unknown as Record<string, unknown>,
            rawResponse: JSON.stringify(analysis),
          });
          await finishLlmJob(llmJobId, "completed", llmResult.tokenUsage);
        }
      }

      await upgradeRepoDataLevel([item.repo], "L3");
      analyzed += 1;

      const opportunityScore = analysis.opportunity?.score;
      const minOpportunityScore =
        profile.config.opportunity?.minOpportunityScore ?? 0;
      if (
        analysis.is_match &&
        typeof opportunityScore === "number" &&
        opportunityScore >= minOpportunityScore
      ) {
        const recommendation = await buildRecommendationWithQualitySignals(
          item.repo,
          profile,
          currentJob.analyzedCount + analyzed,
          analysis,
          preferenceSignals,
          userRepos,
        );
        await upsertRecommendations([recommendation]);
        await finishRepoProcessing({
          canonicalUrl: item.repo.htmlUrl,
          repoId: item.repo.id,
          jobId: job.id,
          status: "processed",
        });
      } else {
        await finishRepoProcessing({
          canonicalUrl: item.repo.htmlUrl,
          repoId: item.repo.id,
          jobId: job.id,
          status: "skipped",
          skipReasonCode: analysis.is_match
            ? "opportunity_score_below_threshold"
            : "llm_not_match",
        });
        skipped += 1;
      }
      await completeCandidate(item.queueId);
    } catch (error) {
      const reason = normalizeAiStageError(error);
      if (llmJobId) {
        await finishLlmJob(llmJobId, "failed", {}, reason);
      }
      if (item.attempts < MAX_AI_CANDIDATE_ATTEMPTS) {
        await retryCandidate(item.queueId, retryDelaySeconds(item.attempts));
      } else {
        await failCandidate(item.queueId, reason);
        await finishRepoWithError(
          item.repo,
          job.id,
          "failed",
          "llm_processing_failed",
          reason,
        );
        failed += 1;
      }
    }
  }

  currentJob =
    (await updateScanJob(job.id, {
      analyzedCount: currentJob.analyzedCount + analyzed,
      stage: "llm",
      status: ready.status,
      statusReason: providerUnavailable
        ? `模型 ${provider.name} 在当前任务中已不可用，下一批将自动轮换。`
        : failed
          ? `LLM 阶段跳过 ${failed} 个连续失败候选。`
          : skipped
            ? `本批 ${skipped} 个项目未满足推荐条件。`
            : ready.reason,
    })) ?? currentJob;

  if (providerUnavailable) {
    if (!(await resolveJobProvider(job.id, "chat"))) {
      return handleUnavailableProviderPool(currentJob, "chat", "llm");
    }
    return currentJob;
  }

  return moveWhenStageDrained(currentJob, "llm", "rank");
}

async function runRankStage(job: ScanJob, profile: DiscoveryProfile) {
  const resource = evaluateResourcePolicy(profile, "rank");
  await recordResourceDecision(job.id, "rank", resource);
  if (resource.status === "paused_by_memory") {
    return updateScanJob(job.id, {
      status: "paused_by_memory",
      statusReason: resource.reason,
    });
  }

  let provider = await resolveJobProvider(job.id, "embedding");
  let rankStatusReason: string | undefined;
  if (!provider) {
    return handleUnavailableProviderPool(job, "embedding", "rank");
  }
  while (provider) {
    let queryVector: number[];
    try {
      queryVector = await getProfileEmbeddingVector(provider, profile);
      await recordScanProviderSuccess({
        jobId: job.id,
        providerId: provider.id,
        kind: "embedding",
      });
    } catch (error) {
      const failure = await handleProviderFailure(job.id, provider, error, 1);
      rankStatusReason = `语义重排跳过：${failure.reason}`;
      const nextProvider = await resolveJobProvider(job.id, "embedding");
      if (!failure.exhausted && !failure.retryable) break;
      provider = nextProvider;
      if (!provider) {
        return handleUnavailableProviderPool(job, "embedding", "rank");
      }
      continue;
    }

    if (queryVector.length) {
      await rerankRecommendationsWithSemanticFit({
        profileId: profile.id,
        providerId: provider.id,
        queryVector,
      });
    }
    break;
  }
  return updateScanJob(job.id, {
    status: "completed",
    stage: "rank",
    statusReason: rankStatusReason,
    finishedAt: new Date().toISOString(),
  });
}

async function buildRecommendationWithQualitySignals(
  repo: RepoSummary,
  profile: DiscoveryProfile,
  rank: number,
  analysis: RepoAnalysisResult | undefined,
  preferenceSignals: Awaited<ReturnType<typeof listPreferenceSignals>>,
  userRepos: Awaited<ReturnType<typeof listGithubRepos>>,
) {
  const recommendation = buildRecommendation(
    repo,
    profile,
    rank,
    analysis,
    preferenceSignals,
    userRepos,
  );
  const qualitySignals = await fetchRepoQualitySignals(repo, profile);
  return applyQualitySignalsToRecommendation(
    recommendation,
    profile,
    qualitySignals,
  );
}

async function getProfileEmbeddingVector(
  provider: AiProvider,
  profile: DiscoveryProfile,
) {
  const input = buildProfileEmbeddingInput(profile);
  const contentHash = hashText(
    JSON.stringify({
      providerId: provider.id,
      model: provider.model,
      input,
    }),
  );
  const cacheKey = `profile:${profile.id}:semantic-rerank`;
  const cached = await getCachedEmbedding({
    cacheKey,
    providerId: provider.id,
    model: provider.model,
    contentHash,
  });
  if (cached) {
    return cached.vector;
  }

  const [vector] = await callEmbedding(provider, input);
  if (!vector?.length) {
    return [];
  }
  await upsertCachedEmbedding({
    cacheKey,
    providerId: provider.id,
    model: provider.model,
    dimensions: provider.dimensions ?? vector.length,
    contentHash,
    vector,
  });
  return vector;
}

function buildProfileEmbeddingInput(profile: DiscoveryProfile) {
  const { preferences } = profile.config;
  return [
    profile.name,
    preferences.keywords.join(", "),
    preferences.topics.join(", "),
    Object.entries(preferences.languages)
      .map(([language, weight]) => `${language}:${weight}`)
      .join(", "),
    preferences.excludeKeywords.length
      ? `exclude: ${preferences.excludeKeywords.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLlmInputHash(
  repo: RepoSummary,
  profile: DiscoveryProfile,
  readme: string,
) {
  const compactedReadme = compactMarkdownForAnalysis(readme, 7000);
  return hashText(
    buildRepoAnalysisPrompt({
      repo,
      profile,
      readme: compactedReadme,
      compressed: compactedReadme.length < readme.length,
    }),
  );
}

function buildDeltaLlmInputHash(
  repo: RepoSummary,
  profile: DiscoveryProfile,
  readme: string,
  previousAnalysis: RepoAnalysisResult,
) {
  const compactedReadme = compactMarkdownForAnalysis(readme, 2600);
  return hashText(
    buildRepoDeltaAnalysisPrompt({
      repo,
      profile,
      readme: compactedReadme,
      compressed: compactedReadme.length < readme.length,
      previousAnalysis,
      changeHint:
        "仓库元数据、活跃度或 README 发生变化，本轮只需要重点复核变化对变现机会的影响。",
    }),
  );
}

async function prepareStage(
  job: ScanJob,
  profile: DiscoveryProfile,
  stage: "document" | "embed" | "llm",
): Promise<
  | {
      ok: true;
      job: ScanJob;
      batchSize: number;
      status: "running" | "throttled";
      reason?: string;
    }
  | { ok: false; job: ScanJob | undefined }
> {
  const resource = evaluateResourcePolicy(profile, stage);
  await recordResourceDecision(job.id, stage, resource);
  if (resource.status === "paused_by_memory") {
    await requeueRunningCandidates(job.id, stage);
    return {
      ok: false,
      job: await updateScanJob(job.id, {
        status: "paused_by_memory",
        statusReason: resource.reason,
      }),
    };
  }

  const status = resource.status === "throttled" ? "throttled" : "running";
  const current =
    (await updateScanJob(job.id, {
      status,
      stage,
      statusReason:
        resource.status === "throttled" ? resource.reason : undefined,
    })) ?? job;

  return {
    ok: true,
    job: current,
    batchSize: Math.max(1, resource.batchSize || 1),
    status,
    reason: resource.status === "throttled" ? resource.reason : undefined,
  };
}

async function moveWhenStageDrained(
  job: ScanJob,
  stage: "document" | "embed" | "llm",
  nextStage: ScanJob["stage"],
) {
  const remaining = await getJobQueueCount(job.id, stage, "pending");
  const running = await getJobQueueCount(job.id, stage, "running");
  const failed = await getJobQueueCount(job.id, stage, "failed");
  if (remaining === 0 && running === 0) {
    return updateScanJob(job.id, {
      status: "running",
      stage: nextStage,
      analyzedCount: 0,
      statusReason:
        failed > 0 ? `${stage} 阶段跳过 ${failed} 个失败候选。` : undefined,
    });
  }

  if (remaining > 0 && running === 0) {
    return updateScanJob(job.id, {
      status: "retry_later",
      stage,
      statusReason: `${stage} 阶段有 ${remaining} 个候选等待退避后重试。`,
    });
  }

  return job;
}

async function resolveJobProvider(jobId: string, kind: ProviderKind) {
  const states = await listScanProviderStates(jobId, kind);
  const excludedIds = states
    .filter((state) => state.exhausted)
    .map((state) => state.providerId);
  return resolveReadyAiProvider(
    await listAiProviders(),
    kind,
    updateAiProviderAvailability,
    excludedIds,
  );
}

async function handleProviderFailure(
  jobId: string,
  provider: AiProvider,
  error: unknown,
  attempt: number,
) {
  const classification = classifyAiProviderFailure(error, provider);
  const transientFailure =
    classification.code === "network" ||
    classification.code === "timeout" ||
    classification.code === "server";
  const immediatelyExhausted =
    (classification.targetAvailabilityStatus !== undefined &&
      classification.targetAvailabilityStatus !== "cooldown") ||
    (classification.targetAvailabilityStatus === "cooldown" &&
      transientFailure &&
      attempt >= MAX_TRANSIENT_PROVIDER_ATTEMPTS);
  const retryAfterSeconds = Math.max(1, classification.cooldownSeconds ?? 15);
  const cooldownUntil = classification.cooldownSeconds
    ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
    : undefined;
  const state = await recordScanProviderFailure({
    jobId,
    providerId: provider.id,
    kind: provider.kind,
    code: classification.code,
    message: classification.reason,
    parseFailure: classification.parseFailure,
    parseFailureThreshold: AI_PARSE_FAILURE_THRESHOLD,
    immediatelyExhausted,
    availabilityStatus: classification.targetAvailabilityStatus,
    cooldownUntil,
    recoverySuggestion: classification.recoverySuggestion,
  });

  return {
    classified: classification.code !== "unknown",
    code: classification.code,
    reason: classification.reason,
    retryAfterSeconds,
    exhausted: state.exhausted,
    retryable: classification.retryable,
    cooldown: classification.targetAvailabilityStatus === "cooldown",
  };
}

async function handleUnavailableProviderPool(
  job: ScanJob,
  kind: ProviderKind,
  stage: "embed" | "llm" | "rank",
) {
  const [providers, states] = await Promise.all([
    listAiProviders(),
    listScanProviderStates(job.id, kind),
  ]);
  const exhaustedIds = new Set(
    states.filter((state) => state.exhausted).map((state) => state.providerId),
  );
  const temporarilyUnavailable = providers.filter(
    (provider) =>
      provider.kind === kind &&
      provider.enabled &&
      !provider.archivedAt &&
      !exhaustedIds.has(provider.id) &&
      (provider.availabilityStatus === "cooldown" ||
        provider.availabilityStatus === "recovering"),
  );

  if (temporarilyUnavailable.length > 0) {
    if (stage !== "rank") {
      await requeueRunningCandidates(job.id, stage);
    }
    const nextRetryAt = temporarilyUnavailable
      .map((provider) => provider.cooldownUntil)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    const label = kind === "chat" ? "Chat/LLM" : "Embedding";
    return updateScanJob(job.id, {
      status: "retry_later",
      stage,
      statusReason: nextRetryAt
        ? `${label} 模型暂时不可用，将在 ${new Date(nextRetryAt).toLocaleString("zh-CN")} 后自动重试。`
        : `${label} 模型正在恢复检测，稍后自动重试。`,
      errorMessage: undefined,
      errorCode: undefined,
      errorResolution: undefined,
      finishedAt: undefined,
    });
  }

  return markAiModelsExhausted(job, kind, stage);
}

async function markAiModelsExhausted(
  job: ScanJob,
  kind: ProviderKind,
  stage: "embed" | "llm" | "rank",
) {
  const label = kind === "chat" ? "Chat/LLM" : "Embedding";
  const message = `${label} 模型池已无可用模型，扫描已进入异常状态。`;
  if (stage !== "rank") {
    await requeueRunningCandidates(job.id, stage);
  }
  await finishJobRepoProcessing({
    jobId: job.id,
    status: "exception",
    errorCode: "ai_models_exhausted",
    errorMessage: message,
  });
  return updateScanJob(job.id, {
    status: "exception",
    stage,
    statusReason: message,
    errorMessage: message,
    errorCode: "ai_models_exhausted",
    errorResolution:
      "请检查模型输出或增加同类型模型；如模型已被阻断，先在 AI 配置中检测恢复，然后手动恢复该扫描任务。",
    finishedAt: new Date().toISOString(),
  });
}

async function finishRepoWithError(
  repo: RepoSummary,
  jobId: string,
  status: "failed" | "exception",
  errorCode: string,
  errorMessage: string,
) {
  return finishRepoProcessing({
    canonicalUrl: repo.htmlUrl,
    repoId: repo.id,
    jobId,
    status,
    errorCode,
    errorMessage,
  });
}

function retryDelaySeconds(attempts: number) {
  return Math.min(1800, 15 * 2 ** Math.max(0, attempts - 1));
}

export function isTransientAiProviderError(reason: string) {
  return (
    /\b(429|500|502|503|504)\b/i.test(reason) ||
    /No available accounts|rate limit|temporarily unavailable|timeout|timed out|ECONNRESET|ETIMEDOUT/i.test(
      reason,
    )
  );
}

async function isCollectComplete(jobId: string, profile: DiscoveryProfile) {
  const queryPlans = buildGitHubSearchQueryPlans(profile);
  const sourceAdapterPlans = buildSourceAdapterPlans(profile);

  for (const plan of sourceAdapterPlans) {
    const checkpoint = await getScanCheckpoint(
      jobId,
      plan.sourceId,
      hashQuery(plan.queryHashKey),
      "collect",
    );
    if (!checkpoint || checkpoint.page < 1) {
      return false;
    }
  }

  for (const plan of queryPlans) {
    const checkpoint = await getScanCheckpoint(
      jobId,
      plan.sourceId,
      hashQuery(`${plan.sourceId}:${plan.query}:${plan.sort}:${plan.order}`),
      "collect",
    );
    if (!checkpoint || !isCompletedCheckpoint(checkpoint)) {
      return false;
    }
  }

  return true;
}

function isCompletedCheckpoint(
  checkpoint: Awaited<ReturnType<typeof getScanCheckpoint>>,
) {
  return Boolean(
    checkpoint &&
    (checkpoint.cursor?.startsWith(COMPLETE_CHECKPOINT_PREFIX) ||
      checkpoint.page >= GITHUB_SEARCH_MAX_PAGES),
  );
}

function hashQuery(query: string) {
  return crypto.createHash("sha256").update(query).digest("hex").slice(0, 24);
}

function hashText(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function buildEmbeddingInput(repo: RepoSummary, readme: string) {
  return [
    repo.fullName,
    repo.description,
    repo.primaryLanguage,
    repo.topics.join(", "),
    compactMarkdownForAnalysis(readme, 4000),
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeAiStageError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Missing API key env")) {
    return `${message}。请先在 AI 配置页填写并保存 API Key。`;
  }
  if (message.includes("Provider is disabled")) {
    return "AI 配置已停用，请先启用或更换发现配置绑定。";
  }
  return message;
}
