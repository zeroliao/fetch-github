import crypto from "node:crypto";
import { cosineSimilarity, shouldDeferLlmBySemanticFit } from "@/lib/semanticGate";
import { compactMarkdownForAnalysis } from "@/lib/text";
import type { DiscoveryProfile, RepoSummary, ScanJob } from "@/lib/types";
import { buildGitHubSearchQueryPlans } from "@/server/githubSearch";
import { fetchRepositoryReadme, searchRepositories } from "@/server/githubClient";
import { buildRecommendation, repoPassesHardFilters, scoreRepo } from "@/server/ranking";
import { callEmbedding } from "./aiClient";
import {
  analyzeRepoWithLlmWithUsage,
  buildRepoDeltaAnalysisPrompt,
  buildRepoAnalysisPrompt,
  REPO_DELTA_ANALYSIS_PROMPT_VERSION,
  REPO_ANALYSIS_PROMPT_VERSION,
  type RepoAnalysisResult
} from "./llmAnalysis";
import { evaluateResourcePolicy, recordResourceDecision } from "./resourceGovernor";
import { buildSourceAdapterPlans, type SourceAdapterPlan } from "./sourceAdapters";
import {
  applyQualitySignalsToRecommendation,
  fetchRepoQualitySignals
} from "./qualitySignals";
import {
  claimQueuedRepoBatch,
  completeCandidate,
  createLlmJob,
  enqueueCandidates,
  failCandidate,
  finishLlmJob,
  getCachedEmbedding,
  getAppSettings,
  getAiProvider,
  getJobQueueCount,
  getLatestLlmResult,
  getLatestRepoDocument,
  getRepoEmbedding,
  getRepoEmbeddingVector,
  listGithubRepos,
  getScanCheckpoint,
  getScanJob,
  listPreferenceSignals,
  listProfiles,
  listRunnableScanJobs,
  requeueRunningCandidates,
  rerankRecommendationsWithSemanticFit,
  retryCandidate,
  trimRecommendations,
  upgradeRepoDataLevel,
  updateScanJob,
  upsertLlmResult,
  upsertRepoDocument,
  upsertRepoEmbedding,
  upsertCachedEmbedding,
  upsertRecommendations,
  upsertRepos,
  upsertScanCheckpoint
} from "./store";

const MAX_AI_CANDIDATE_ATTEMPTS = 3;

interface RunScanJobOptions {
  jobId: string;
  maxPages?: number;
  maxProfileBatches?: number;
}

export async function runNextScanJob(options: {
  maxPages?: number;
  maxProfileBatches?: number;
} = {}) {
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
    maxPages: options.maxPages,
    maxProfileBatches: options.maxProfileBatches
  });
}

export async function runScanJob(options: RunScanJobOptions): Promise<ScanJob | undefined> {
  return runScanJobInternal(options, false);
}

export async function resumeScanJob(options: RunScanJobOptions): Promise<ScanJob | undefined> {
  return runScanJobInternal(options, true);
}

async function runScanJobInternal(
  options: RunScanJobOptions,
  allowPaused: boolean
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
    (!allowPaused && job.status === "paused_by_user")
  ) {
    return job;
  }

  const profile = (await listProfiles()).find((item) => item.id === job.profileId);
  if (!profile) {
    return updateScanJob(job.id, {
      status: "failed",
      errorMessage: "发现配置不存在，扫描任务无法继续。",
      finishedAt: new Date().toISOString()
    });
  }

  if (!profile.enabled) {
    return updateScanJob(job.id, {
      status: "paused_by_runtime",
      statusReason: "发现配置已停用，扫描任务暂停。"
    });
  }

  const shouldResumeFromQueue = ["retry_later", "paused_by_memory", "paused_by_runtime"].includes(job.status);
  let current = shouldResumeFromQueue
    ? (await updateScanJob(job.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        statusReason: undefined,
        errorMessage: undefined
      })) ?? job
    : job.startedAt || job.status !== "pending"
      ? job
      : await updateScanJob(job.id, {
          status: "running",
          stage: "collect",
          startedAt: new Date().toISOString(),
          errorMessage: undefined
        });

  if (!current) {
    return undefined;
  }

  if (current.stage === "collect") {
    current = (await runCollectStage(current, profile, options.maxPages ?? 1)) ?? current;
  }

  if (current.status !== "running" && current.status !== "throttled") {
    return current;
  }

  if (current.stage === "profile") {
    current =
      (await runProfileStage(current, profile, options.maxProfileBatches ?? 1)) ?? current;
  }

  if (current.status !== "running" && current.status !== "throttled") {
    return current;
  }

  if (current.stage === "document") {
    current =
      (await runDocumentStage(current, profile, options.maxProfileBatches ?? 1)) ?? current;
  }

  if (current.status !== "running" && current.status !== "throttled") {
    return current;
  }

  if (current.stage === "embed") {
    current =
      (await runEmbedStage(current, profile, options.maxProfileBatches ?? 1)) ?? current;
  }

  if (current.status !== "running" && current.status !== "throttled") {
    return current;
  }

  if (current.stage === "llm") {
    current =
      (await runLlmStage(current, profile, options.maxProfileBatches ?? 1)) ?? current;
  }

  if (current.status !== "running" && current.status !== "throttled") {
    return current;
  }

  if (current.stage === "rank") {
    current = (await runRankStage(current, profile)) ?? current;
  }

  return current;
}

async function runCollectStage(
  job: ScanJob,
  profile: DiscoveryProfile,
  maxPages: number
): Promise<ScanJob | undefined> {
  const runtimePause = shouldPauseByRuntime(job, profile);
  if (runtimePause) {
    return updateScanJob(job.id, {
      status: "paused_by_runtime",
      statusReason: runtimePause
    });
  }

  const resource = evaluateResourcePolicy(profile, "collect");
  await recordResourceDecision(job.id, "collect", resource);
  if (resource.status === "paused_by_memory") {
    return updateScanJob(job.id, {
      status: "paused_by_memory",
      statusReason: resource.reason
    });
  }

  let currentJob = await updateScanJob(job.id, {
    status: resource.status === "throttled" ? "throttled" : "running",
    stage: "collect",
    statusReason: resource.status === "throttled" ? resource.reason : undefined
  });
  if (!currentJob) {
    return undefined;
  }

  const queryPlans = buildGitHubSearchQueryPlans(profile);
  const sourceAdapterPlans = buildSourceAdapterPlans(profile);
  const preferenceSignals = await listPreferenceSignals(profile.id);
  const perPage = Math.max(1, Math.min(profile.config.limits.sourceLimitPerQuery, 100));
  const pageLimit = Math.max(1, maxPages);
  let pagesProcessed = 0;

  for (const plan of sourceAdapterPlans) {
    if (pagesProcessed >= pageLimit || currentJob.candidateCount >= currentJob.maxCandidates) {
      break;
    }

    currentJob = (await runSourceAdapterCollect({
      job,
      currentJob,
      profile,
      plan,
      preferenceSignals,
      resourceStatus: resource.status,
      resourceReason: resource.reason
    })) ?? currentJob;
    pagesProcessed += 1;
  }

  for (const plan of queryPlans) {
    if (pagesProcessed >= pageLimit || currentJob.candidateCount >= currentJob.maxCandidates) {
      break;
    }

    const queryHash = hashQuery(`${plan.sourceId}:${plan.query}:${plan.sort}:${plan.order}`);
    const checkpoint = await getScanCheckpoint(job.id, plan.sourceId, queryHash, "collect");
    const nextPage = (checkpoint?.page ?? 0) + 1;
    const maxPagesForQuery = Math.max(
      1,
      Math.ceil(profile.config.limits.sourceLimitPerQuery / perPage)
    );
    if (nextPage > maxPagesForQuery) {
      continue;
    }

    const result = await searchRepositories({
      query: plan.query,
      perPage,
      page: nextPage,
      sort: plan.sort,
      order: plan.order
    });

    const remaining = Math.max(0, currentJob.maxCandidates - currentJob.candidateCount);
    const repos = result.repos;

    const repoStats = await upsertRepos(repos, "L0");
    const candidates = selectDeepAnalysisCandidates(repoStats, profile, remaining);
    await upgradeRepoDataLevel(candidates, "L1");
    await enqueueCandidates(
      job.id,
      candidates.map((repo) => ({
        repo,
        priorityScore: scoreRepo(repo, profile, preferenceSignals).finalScore * plan.weight,
        stage: "profile"
      }))
    );

    const fetchedCount: number = currentJob.fetchedCount + repos.length;
    const processedCount: number = currentJob.processedCount + candidates.length;
    const nextRepoStats = addRepoStats(currentJob, repoStats, candidates.length);
    await upsertScanCheckpoint({
      jobId: job.id,
      source: plan.sourceId,
      queryHash,
      page: nextPage,
      cursor: `${plan.sourceLabel}: ${plan.query}`,
      processedCount: fetchedCount,
      stage: "collect"
    });

    currentJob =
      (await updateScanJob(job.id, {
        status: resource.status === "throttled" ? "throttled" : "running",
        stage: "collect",
        fetchedCount,
        processedCount,
        ...nextRepoStats,
        statusReason: resource.status === "throttled" ? resource.reason : undefined
      })) ?? currentJob;
    pagesProcessed += 1;

    if (repos.length < perPage || result.totalCount <= nextPage * perPage) {
      await upsertScanCheckpoint({
        jobId: job.id,
        source: plan.sourceId,
        queryHash,
        page: maxPagesForQuery,
        cursor: `${plan.sourceLabel}: ${plan.query}`,
        processedCount: fetchedCount,
        stage: "collect"
      });
    }
  }

  if (currentJob.candidateCount >= currentJob.maxCandidates || (await isCollectComplete(job.id, profile))) {
    return updateScanJob(job.id, {
      status: "running",
      stage: "profile",
      statusReason: undefined
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
    "collect"
  );
  if ((checkpoint?.page ?? 0) >= 1) {
    return input.currentJob;
  }

  const limit = Math.min(
    input.profile.config.limits.sourceLimitPerQuery,
    Math.max(0, input.currentJob.maxCandidates - input.currentJob.candidateCount)
  );
  if (limit <= 0) {
    return input.currentJob;
  }

  const repos = await input.plan.fetchRepos(limit);

  const repoStats = await upsertRepos(repos, "L0");
  const candidates = selectDeepAnalysisCandidates(repoStats, input.profile, limit);
  await upgradeRepoDataLevel(candidates, "L1");
  await enqueueCandidates(
    input.job.id,
    candidates.map((repo) => ({
      repo,
      priorityScore:
        scoreRepo(repo, input.profile, input.preferenceSignals).finalScore * input.plan.weight,
      stage: "profile"
    }))
  );

  const fetchedCount = input.currentJob.fetchedCount + repos.length;
  const processedCount = input.currentJob.processedCount + candidates.length;
  const nextRepoStats = addRepoStats(input.currentJob, repoStats, candidates.length);
  await upsertScanCheckpoint({
    jobId: input.job.id,
    source: input.plan.sourceId,
    queryHash,
    page: 1,
    cursor: input.plan.cursor,
    processedCount: fetchedCount,
    stage: "collect"
  });

  return updateScanJob(input.job.id, {
    status: input.resourceStatus === "throttled" ? "throttled" : "running",
    stage: "collect",
    fetchedCount,
    processedCount,
    ...nextRepoStats,
    statusReason: input.resourceStatus === "throttled" ? input.resourceReason : undefined
  });
}

function selectDeepAnalysisCandidates(
  repoStats: Awaited<ReturnType<typeof upsertRepos>>,
  profile: DiscoveryProfile,
  limit: number
) {
  return repoStats.repos
    .filter((item) => item.shouldAnalyze)
    .map((item) => item.repo)
    .filter((repo) => repoPassesHardFilters(repo, profile))
    .slice(0, Math.max(0, limit));
}

function addRepoStats(
  job: ScanJob,
  stats: Awaited<ReturnType<typeof upsertRepos>>,
  candidateCount: number
): Pick<ScanJob, "newRepoCount" | "updatedRepoCount" | "unchangedRepoCount" | "candidateCount"> {
  return {
    newRepoCount: job.newRepoCount + stats.newCount,
    updatedRepoCount: job.updatedRepoCount + stats.updatedCount,
    unchangedRepoCount: job.unchangedRepoCount + stats.unchangedCount,
    candidateCount: job.candidateCount + candidateCount
  };
}

async function runProfileStage(
  job: ScanJob,
  profile: DiscoveryProfile,
  maxBatches: number
): Promise<ScanJob | undefined> {
  const runtimePause = shouldPauseByRuntime(job, profile);
  if (runtimePause) {
    await requeueRunningCandidates(job.id, "profile");
    return updateScanJob(job.id, {
      status: "paused_by_runtime",
      statusReason: runtimePause
    });
  }

  const resource = evaluateResourcePolicy(profile, "profile");
  await recordResourceDecision(job.id, "profile", resource);
  if (resource.status === "paused_by_memory") {
    await requeueRunningCandidates(job.id, "profile");
    return updateScanJob(job.id, {
      status: "paused_by_memory",
      statusReason: resource.reason
    });
  }

  let currentJob =
    (await updateScanJob(job.id, {
      status: resource.status === "throttled" ? "throttled" : "running",
      stage: "profile",
      statusReason: resource.status === "throttled" ? resource.reason : undefined
    })) ?? job;

  const batchLimit = Math.max(1, resource.batchSize || 1);
  const batches = Math.max(1, maxBatches);

  for (let batchIndex = 0; batchIndex < batches; batchIndex += 1) {
    const queued = await claimQueuedRepoBatch(job.id, "profile", batchLimit);
    if (queued.length === 0) {
      break;
    }

    await enqueueCandidates(
      job.id,
      queued
        .slice(0, Math.max(0, profile.config.limits.detailFetchTopK - currentJob.analyzedCount))
        .map((item) => ({
          repo: item.repo,
          priorityScore: item.priorityScore,
          stage: "document"
        }))
    );

    for (const item of queued) {
      await completeCandidate(item.queueId);
    }

    currentJob =
      (await updateScanJob(job.id, {
        analyzedCount: currentJob.analyzedCount + queued.length,
        stage: "profile",
        status: resource.status === "throttled" ? "throttled" : "running",
        statusReason: resource.status === "throttled" ? resource.reason : undefined
      })) ?? currentJob;
  }

  const remaining = await getJobQueueCount(job.id, "profile", "pending");
  const running = await getJobQueueCount(job.id, "profile", "running");
  if (remaining === 0 && running === 0) {
    return updateScanJob(job.id, {
      status: "running",
      stage: "document",
      analyzedCount: 0,
      statusReason: undefined
    });
  }

  return currentJob;
}

async function runDocumentStage(
  job: ScanJob,
  profile: DiscoveryProfile,
  maxBatches: number
): Promise<ScanJob | undefined> {
  const ready = await prepareStage(job, profile, "document");
  if (!ready.ok) {
    return ready.job;
  }

  let currentJob = ready.job;
  for (let batchIndex = 0; batchIndex < Math.max(1, maxBatches); batchIndex += 1) {
    const queued = await claimQueuedRepoBatch(job.id, "document", ready.batchSize);
    if (queued.length === 0) break;

    let embeddedEnqueued = 0;
    for (const item of queued) {
      const readme = await fetchRepositoryReadme(item.repo);
      const contentHash = hashText(readme.content || item.repo.description || item.repo.fullName);
      await upsertRepoDocument({
        repoId: item.repo.id,
        type: "readme",
        sourceUrl: readme.sourceUrl,
        contentHash,
        rawContent: readme.content,
        summary: readme.content.slice(0, 500)
      });
      await upgradeRepoDataLevel([item.repo], "L2");
      if (currentJob.analyzedCount + embeddedEnqueued < profile.config.limits.embeddingTopK) {
        await enqueueCandidates(job.id, [
          {
            repo: item.repo,
            priorityScore: item.priorityScore,
            stage: "embed"
          }
        ]);
        embeddedEnqueued += 1;
      }
      await completeCandidate(item.queueId);
    }

    currentJob =
      (await updateScanJob(job.id, {
        analyzedCount: currentJob.analyzedCount + queued.length,
        stage: "document",
        status: ready.status,
        statusReason: ready.reason
      })) ?? currentJob;
  }

  return moveWhenStageDrained(currentJob, "document", "embed");
}

async function runEmbedStage(
  job: ScanJob,
  profile: DiscoveryProfile,
  maxBatches: number
): Promise<ScanJob | undefined> {
  const provider = await getAiProvider(profile.config.ai.embeddingProviderId);
  if (!provider) {
    return updateScanJob(job.id, {
      status: "retry_later",
      statusReason: "Embedding 配置不存在，请先修复发现配置绑定。"
    });
  }

  const ready = await prepareStage(job, profile, "embed");
  if (!ready.ok) {
    return ready.job;
  }

  let currentJob = ready.job;
  for (let batchIndex = 0; batchIndex < Math.max(1, maxBatches); batchIndex += 1) {
    const queued = await claimQueuedRepoBatch(job.id, "embed", ready.batchSize);
    if (queued.length === 0) break;

    let succeeded = 0;
    let failed = 0;
    const embeddingInputs = [];
    for (const item of queued) {
      try {
        const document = await getLatestRepoDocument(item.repo.id, "readme");
        const text = buildEmbeddingInput(item.repo, document?.rawContent ?? "");
        const contentHash = document?.contentHash ?? hashText(text);
        const cached = await getRepoEmbedding({
          repoId: item.repo.id,
          providerId: provider.id,
          model: provider.model,
          contentHash
        });
        if (cached) {
          await enqueueCandidates(job.id, [
            {
              repo: item.repo,
              priorityScore: item.priorityScore,
              stage: "llm"
            }
          ]);
          await completeCandidate(item.queueId);
          succeeded += 1;
          continue;
        }

        embeddingInputs.push({
          item,
          text,
          contentHash
        });
      } catch (error) {
        const reason = normalizeAiStageError(error);
        if (shouldRetryAiCandidate(reason, item.attempts)) {
          await retryCandidate(item.queueId, retryDelaySeconds(item.attempts));
        } else {
          await failCandidate(item.queueId, reason);
          failed += 1;
        }
      }
    }

    if (embeddingInputs.length) {
      try {
        const vectors = await callEmbedding(provider, embeddingInputs.map((input) => input.text));
        for (const [index, input] of embeddingInputs.entries()) {
          const vector = vectors[index];
          if (!vector?.length) {
            throw new Error("Embedding provider returned an empty vector.");
          }
          await upsertRepoEmbedding({
            repoId: input.item.repo.id,
            providerId: provider.id,
            model: provider.model,
            dimensions: provider.dimensions ?? vector.length,
            contentHash: input.contentHash,
            vector
          });
          await enqueueCandidates(job.id, [
            {
              repo: input.item.repo,
              priorityScore: input.item.priorityScore,
              stage: "llm"
            }
          ]);
          await completeCandidate(input.item.queueId);
          succeeded += 1;
        }
      } catch (error) {
        const reason = normalizeAiStageError(error);
        for (const input of embeddingInputs) {
          if (shouldRetryAiCandidate(reason, input.item.attempts)) {
            await retryCandidate(input.item.queueId, retryDelaySeconds(input.item.attempts));
          } else {
            await failCandidate(input.item.queueId, reason);
            failed += 1;
          }
        }
      }
    }

    currentJob =
      (await updateScanJob(job.id, {
        analyzedCount: currentJob.analyzedCount + succeeded,
        stage: "embed",
        status: ready.status,
        statusReason: failed ? `Embedding 阶段跳过 ${failed} 个连续失败候选。` : ready.reason
      })) ?? currentJob;
  }

  return moveWhenStageDrained(currentJob, "embed", "llm");
}

async function runLlmStage(
  job: ScanJob,
  profile: DiscoveryProfile,
  maxBatches: number
): Promise<ScanJob | undefined> {
  const provider = await getAiProvider(profile.config.ai.chatProviderId);
  if (!provider) {
    return updateScanJob(job.id, {
      status: "retry_later",
      statusReason: "Chat 配置不存在，请先修复发现配置绑定。"
    });
  }

  const ready = await prepareStage(job, profile, "llm");
  if (!ready.ok) {
    return ready.job;
  }

  const preferenceSignals = await listPreferenceSignals(profile.id);
  const userRepos = await listGithubRepos();
  const embeddingProvider = await getAiProvider(profile.config.ai.embeddingProviderId);
  const profileVector = embeddingProvider
    ? await getProfileEmbeddingVector(embeddingProvider, profile).catch(() => [])
    : [];
  let currentJob = ready.job;
  for (let batchIndex = 0; batchIndex < Math.max(1, maxBatches); batchIndex += 1) {
    const queued = await claimQueuedRepoBatch(job.id, "llm", ready.batchSize);
    if (queued.length === 0) break;

    const recommendations = [];
    let llmSucceeded = 0;
    let failed = 0;
    let deferredByGate = 0;
    const llmCallsRemainingAtBatchStart = Math.max(
      0,
      profile.config.limits.llmAnalyzeTopK - currentJob.analyzedCount
    );
    let llmCallsRemaining = llmCallsRemainingAtBatchStart;
    let overLlmLimit = 0;

    for (const item of queued) {
      let llmJobId: string | undefined;
      try {
        let usedLlmCall = false;
        const document = await getLatestRepoDocument(item.repo.id, "readme");
        const readme = document?.rawContent ?? item.repo.description;
        const fullInputHash = buildLlmInputHash(item.repo, profile, readme);
        const fullCached = await getLatestLlmResult(item.repo.id, "repo_analysis", {
          providerId: provider.id,
          model: provider.model,
          promptVersion: REPO_ANALYSIS_PROMPT_VERSION,
          inputHash: fullInputHash
        });
        let analysis: RepoAnalysisResult;
        if (fullCached) {
          analysis = fullCached as unknown as RepoAnalysisResult;
        } else {
          const previousAnalysis = await getLatestLlmResult(item.repo.id, "repo_analysis", {
            providerId: provider.id,
            model: provider.model
          }) as RepoAnalysisResult | undefined;
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
                inputHash
              })
            : undefined;
          if (deltaCached) {
            analysis = deltaCached as unknown as RepoAnalysisResult;
          } else {
            const gate = await evaluateLlmGate({
              repo: item.repo,
              profile,
              embeddingProviderId: profile.config.ai.embeddingProviderId,
              embeddingModel: embeddingProvider?.model,
              profileVector,
              contentHash: document?.contentHash,
              priorityScore: item.priorityScore,
              preferenceSignals,
              userRepos
            });
            if (gate.defer) {
              await upgradeRepoDataLevel([item.repo], "L2");
              recommendations.push({
                ...gate.recommendation,
                rank: currentJob.analyzedCount + recommendations.length + 1,
                reasons: [
                  `语义相关度 ${Math.round((gate.semanticFit ?? 0) * 100)} 低于本轮 LLM 阈值 ${Math.round(gate.threshold * 100)}，已保留为普通候选，后续偏好变化或热度变化可重新进入 LLM。`,
                  ...gate.recommendation.reasons
                ]
              });
              await completeCandidate(item.queueId);
              deferredByGate += 1;
              continue;
            }
            if (llmCallsRemaining <= 0) {
              await retryCandidate(item.queueId, 24 * 60 * 60);
              overLlmLimit += 1;
              continue;
            }
            llmJobId = await createLlmJob({
              repoId: item.repo.id,
              jobId: job.id,
              jobType: "repo_analysis",
              status: "running",
              inputHash,
              providerId: provider.id,
              model: provider.model,
              promptVersion
            });
            const llmResult = await analyzeRepoWithLlmWithUsage({
              repo: item.repo,
              profile,
              readme,
              previousAnalysis,
              changeHint: previousAnalysis
                ? "仓库元数据、活跃度或 README 发生变化，本轮只需要重点复核变化对变现机会的影响。"
                : undefined
            });
            analysis = llmResult.analysis;
            usedLlmCall = true;
            await upsertLlmResult({
              repoId: item.repo.id,
              providerId: provider.id,
              model: provider.model,
              jobType: "repo_analysis",
              promptVersion,
              inputHash,
              structured: analysis as unknown as Record<string, unknown>,
              rawResponse: JSON.stringify(analysis)
            });
            await finishLlmJob(llmJobId, "completed", llmResult.tokenUsage);
          }
        }
        await upgradeRepoDataLevel([item.repo], "L3");
        recommendations.push(
          await buildRecommendationWithQualitySignals(
            item.repo,
            profile,
            currentJob.analyzedCount + recommendations.length + 1,
            analysis,
            preferenceSignals,
            userRepos
          )
        );
        await completeCandidate(item.queueId);
        if (usedLlmCall) {
          llmSucceeded += 1;
          llmCallsRemaining -= 1;
        }
      } catch (error) {
        const reason = normalizeAiStageError(error);
        if (llmJobId) {
          await finishLlmJob(llmJobId, "failed", {}, reason);
        }
        if (shouldRetryAiCandidate(reason, item.attempts)) {
          await retryCandidate(item.queueId, retryDelaySeconds(item.attempts));
        } else {
          await failCandidate(item.queueId, reason);
          failed += 1;
        }
      }
    }

    if (recommendations.length) {
      await upsertRecommendations(recommendations);
    }

    currentJob =
      (await updateScanJob(job.id, {
        analyzedCount: currentJob.analyzedCount + llmSucceeded,
        stage: "llm",
        status: ready.status,
        statusReason: failed
          ? `LLM 阶段跳过 ${failed} 个连续失败候选。`
          : deferredByGate
            ? `本批 ${deferredByGate} 个低语义相关候选已延后 LLM，仅保留普通推荐，未消耗 LLM token。`
            : overLlmLimit
              ? `LLM 名额已用尽，${overLlmLimit} 个候选已保留到后续继续分析。`
            : ready.reason
      })) ?? currentJob;

    if (overLlmLimit > 0 && llmCallsRemainingAtBatchStart === 0 && deferredByGate === 0) {
      return updateScanJob(job.id, {
        status: "retry_later",
        stage: "llm",
        statusReason: `LLM 分析数量已达到本轮上限 ${profile.config.limits.llmAnalyzeTopK}，候选已保留，后续可继续分析。`
      });
    }
  }

  return moveWhenStageDrained(currentJob, "llm", "rank");
}

async function runRankStage(job: ScanJob, profile: DiscoveryProfile) {
  const provider = await getAiProvider(profile.config.ai.embeddingProviderId);
  if (provider) {
    try {
      const queryVector = await getProfileEmbeddingVector(provider, profile);
      if (queryVector?.length) {
        await rerankRecommendationsWithSemanticFit({
          profileId: profile.id,
          providerId: provider.id,
          queryVector
        });
      }
    } catch (error) {
      await updateScanJob(job.id, {
        statusReason: `语义重排跳过：${normalizeAiStageError(error)}`
      });
    }
  }
  await trimRecommendations(profile.id, profile.config.limits.finalReportTopK);
  return updateScanJob(job.id, {
    status: "completed",
    stage: "rank",
    statusReason: undefined,
    finishedAt: new Date().toISOString()
  });
}

async function buildRecommendationWithQualitySignals(
  repo: RepoSummary,
  profile: DiscoveryProfile,
  rank: number,
  analysis: RepoAnalysisResult | undefined,
  preferenceSignals: Awaited<ReturnType<typeof listPreferenceSignals>>,
  userRepos: Awaited<ReturnType<typeof listGithubRepos>>
) {
  const recommendation = buildRecommendation(
    repo,
    profile,
    rank,
    analysis,
    preferenceSignals,
    userRepos
  );
  const qualitySignals = await fetchRepoQualitySignals(repo, profile);
  return applyQualitySignalsToRecommendation(recommendation, profile, qualitySignals);
}

async function evaluateLlmGate(input: {
  repo: RepoSummary;
  profile: DiscoveryProfile;
  embeddingProviderId: string;
  embeddingModel?: string;
  profileVector: number[];
  contentHash?: string;
  priorityScore: number;
  preferenceSignals: Awaited<ReturnType<typeof listPreferenceSignals>>;
  userRepos: Awaited<ReturnType<typeof listGithubRepos>>;
}) {
  const threshold = input.profile.config.limits.semanticFitThreshold ?? 0.42;
  const semanticFit = await getRepoSemanticFit({
    repoId: input.repo.id,
    providerId: input.embeddingProviderId,
    model: input.embeddingModel,
    contentHash: input.contentHash,
    profileVector: input.profileVector
  });
  const recommendation = await buildRecommendationWithQualitySignals(
    input.repo,
    input.profile,
    1,
    undefined,
    input.preferenceSignals,
    input.userRepos
  );

  return {
    threshold,
    semanticFit,
    recommendation,
    defer: shouldDeferLlmBySemanticFit({
      semanticFit,
      threshold,
      priorityScore: input.priorityScore,
      opportunityScore: recommendation.scores.opportunity,
      minOpportunityScore: input.profile.config.opportunity?.minOpportunityScore
    })
  };
}

async function getRepoSemanticFit(input: {
  repoId: string;
  providerId: string;
  model?: string;
  contentHash?: string;
  profileVector: number[];
}) {
  if (!input.profileVector.length) {
    return undefined;
  }

  const embedding = await getRepoEmbeddingVector({
    repoId: input.repoId,
    providerId: input.providerId,
    model: input.model,
    contentHash: input.contentHash
  });

  if (!embedding?.vector?.length) {
    return undefined;
  }

  return cosineSimilarity(embedding.vector, input.profileVector);
}

async function getProfileEmbeddingVector(
  provider: NonNullable<Awaited<ReturnType<typeof getAiProvider>>>,
  profile: DiscoveryProfile
) {
  const input = buildProfileEmbeddingInput(profile);
  const contentHash = hashText(
    JSON.stringify({
      providerId: provider.id,
      model: provider.model,
      input
    })
  );
  const cacheKey = `profile:${profile.id}:semantic-rerank`;
  const cached = await getCachedEmbedding({
    cacheKey,
    providerId: provider.id,
    model: provider.model,
    contentHash
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
    vector
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
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLlmInputHash(repo: RepoSummary, profile: DiscoveryProfile, readme: string) {
  const compactedReadme = compactMarkdownForAnalysis(readme, 7000);
  return hashText(
    buildRepoAnalysisPrompt({
      repo,
      profile,
      readme: compactedReadme,
      compressed: compactedReadme.length < readme.length
    })
  );
}

function buildDeltaLlmInputHash(
  repo: RepoSummary,
  profile: DiscoveryProfile,
  readme: string,
  previousAnalysis: RepoAnalysisResult
) {
  const compactedReadme = compactMarkdownForAnalysis(readme, 2600);
  return hashText(
    buildRepoDeltaAnalysisPrompt({
      repo,
      profile,
      readme: compactedReadme,
      compressed: compactedReadme.length < readme.length,
      previousAnalysis,
      changeHint: "仓库元数据、活跃度或 README 发生变化，本轮只需要重点复核变化对变现机会的影响。"
    })
  );
}

async function prepareStage(
  job: ScanJob,
  profile: DiscoveryProfile,
  stage: "document" | "embed" | "llm"
): Promise<
  | { ok: true; job: ScanJob; batchSize: number; status: "running" | "throttled"; reason?: string }
  | { ok: false; job: ScanJob | undefined }
> {
  const runtimePause = shouldPauseByRuntime(job, profile);
  if (runtimePause) {
    await requeueRunningCandidates(job.id, stage);
    return {
      ok: false,
      job: await updateScanJob(job.id, {
        status: "paused_by_runtime",
        statusReason: runtimePause
      })
    };
  }

  const resource = evaluateResourcePolicy(profile, stage);
  await recordResourceDecision(job.id, stage, resource);
  if (resource.status === "paused_by_memory") {
    await requeueRunningCandidates(job.id, stage);
    return {
      ok: false,
      job: await updateScanJob(job.id, {
        status: "paused_by_memory",
        statusReason: resource.reason
      })
    };
  }

  const status = resource.status === "throttled" ? "throttled" : "running";
  const current =
    (await updateScanJob(job.id, {
      status,
      stage,
      statusReason: resource.status === "throttled" ? resource.reason : undefined
    })) ?? job;

  return {
    ok: true,
    job: current,
    batchSize: Math.max(1, resource.batchSize || 1),
    status,
    reason: resource.status === "throttled" ? resource.reason : undefined
  };
}

async function moveWhenStageDrained(
  job: ScanJob,
  stage: "document" | "embed" | "llm",
  nextStage: ScanJob["stage"]
) {
  const remaining = await getJobQueueCount(job.id, stage, "pending");
  const running = await getJobQueueCount(job.id, stage, "running");
  const failed = await getJobQueueCount(job.id, stage, "failed");
  if (remaining === 0 && running === 0) {
    return updateScanJob(job.id, {
      status: "running",
      stage: nextStage,
      analyzedCount: 0,
      statusReason: failed > 0 ? `${stage} 阶段跳过 ${failed} 个失败候选。` : undefined
    });
  }

  if (remaining > 0 && running === 0) {
    return updateScanJob(job.id, {
      status: "retry_later",
      stage,
      statusReason: `${stage} 阶段有 ${remaining} 个候选等待退避后重试。`
    });
  }

  return job;
}

function retryDelaySeconds(attempts: number) {
  return Math.min(1800, 15 * 2 ** Math.max(0, attempts - 1));
}

function shouldRetryAiCandidate(reason: string, attempts: number) {
  return attempts < MAX_AI_CANDIDATE_ATTEMPTS || isTransientAiProviderError(reason);
}

export function isTransientAiProviderError(reason: string) {
  return /\b(429|500|502|503|504)\b/i.test(reason) ||
    /No available accounts|rate limit|temporarily unavailable|timeout|timed out|ECONNRESET|ETIMEDOUT/i.test(reason);
}

async function isCollectComplete(jobId: string, profile: DiscoveryProfile) {
  const queryPlans = buildGitHubSearchQueryPlans(profile);
  const sourceAdapterPlans = buildSourceAdapterPlans(profile);
  const perQuery = Math.max(1, Math.min(profile.config.limits.sourceLimitPerQuery, 100));
  const maxPagesForQuery = Math.max(
    1,
    Math.ceil(profile.config.limits.sourceLimitPerQuery / perQuery)
  );

  for (const plan of sourceAdapterPlans) {
    const checkpoint = await getScanCheckpoint(
      jobId,
      plan.sourceId,
      hashQuery(plan.queryHashKey),
      "collect"
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
      "collect"
    );
    if (!checkpoint || checkpoint.page < maxPagesForQuery) {
      return false;
    }
  }

  return true;
}

function shouldPauseByRuntime(job: ScanJob, profile: DiscoveryProfile) {
  if (!job.startedAt) {
    return null;
  }

  const maxRuntimeMs = profile.config.schedule.maxRuntimeMinutes * 60 * 1000;
  const startedAt = new Date(job.startedAt).getTime();
  if (!Number.isFinite(startedAt)) {
    return null;
  }

  if (Date.now() - startedAt > maxRuntimeMs) {
    return `扫描已达到最大运行时间 ${profile.config.schedule.maxRuntimeMinutes} 分钟，等待恢复。`;
  }

  return null;
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
    compactMarkdownForAnalysis(readme, 4000)
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
