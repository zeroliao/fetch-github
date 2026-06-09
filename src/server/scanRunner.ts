import crypto from "node:crypto";
import type { DiscoveryProfile, RepoSummary, ScanJob } from "@/lib/types";
import { buildGitHubSearchQueryPlans } from "@/server/githubSearch";
import { fetchRepositoryReadme, searchRepositories } from "@/server/githubClient";
import { buildRecommendation, repoPassesHardFilters, scoreRepo } from "@/server/ranking";
import { callEmbedding } from "./aiClient";
import { analyzeRepoWithLlm, REPO_ANALYSIS_PROMPT_VERSION, type RepoAnalysisResult } from "./llmAnalysis";
import { evaluateResourcePolicy, recordResourceDecision } from "./resourceGovernor";
import {
  claimQueuedRepoBatch,
  completeCandidate,
  createLlmJob,
  enqueueCandidates,
  failCandidate,
  finishLlmJob,
  getAiProvider,
  getJobQueueCount,
  getLatestLlmResult,
  getLatestRepoDocument,
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
  const job = await getScanJob(options.jobId);
  if (!job) {
    return undefined;
  }
  if (
    ["completed", "failed"].includes(job.status) ||
    (!allowPaused &&
      ["paused_by_user", "paused_by_runtime"].includes(job.status))
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

  const shouldResumeFromQueue = ["retry_later", "paused_by_memory"].includes(job.status);
  let current = shouldResumeFromQueue
    ? (await updateScanJob(job.id, {
        status: "running",
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
  const preferenceSignals = await listPreferenceSignals(profile.id);
  const perPage = Math.max(1, Math.min(profile.config.limits.sourceLimitPerQuery, 100));
  const pageLimit = Math.max(1, maxPages);
  let pagesProcessed = 0;

  for (const plan of queryPlans) {
    if (pagesProcessed >= pageLimit || currentJob.fetchedCount >= currentJob.maxCandidates) {
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

    const remaining = Math.max(0, currentJob.maxCandidates - currentJob.fetchedCount);
    const repos = result.repos.slice(0, remaining);
    const candidates = repos.filter((repo) => repoPassesHardFilters(repo, profile));

    await upsertRepos(repos, "L0");
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

  if (currentJob.fetchedCount >= currentJob.maxCandidates || (await isCollectComplete(job.id, profile))) {
    return updateScanJob(job.id, {
      status: "running",
      stage: "profile",
      statusReason: undefined
    });
  }

  return currentJob;
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
    for (const item of queued) {
      try {
        const document = await getLatestRepoDocument(item.repo.id, "readme");
        const text = buildEmbeddingInput(item.repo, document?.rawContent ?? "");
        const contentHash = document?.contentHash ?? hashText(text);
        const [vector] = await callEmbedding(provider, text);
        if (!vector?.length) {
          throw new Error("Embedding provider returned an empty vector.");
        }
        await upsertRepoEmbedding({
          repoId: item.repo.id,
          providerId: provider.id,
          model: provider.model,
          dimensions: provider.dimensions ?? vector.length,
          contentHash,
          vector
        });
        await enqueueCandidates(job.id, [
          {
            repo: item.repo,
            priorityScore: item.priorityScore,
            stage: "llm"
          }
        ]);
        await completeCandidate(item.queueId);
        succeeded += 1;
      } catch (error) {
        const reason = normalizeAiStageError(error);
        if (item.attempts < MAX_AI_CANDIDATE_ATTEMPTS) {
          await retryCandidate(item.queueId, retryDelaySeconds(item.attempts));
        } else {
          await failCandidate(item.queueId, reason);
          failed += 1;
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
  let currentJob = ready.job;
  for (let batchIndex = 0; batchIndex < Math.max(1, maxBatches); batchIndex += 1) {
    const queued = await claimQueuedRepoBatch(job.id, "llm", ready.batchSize);
    if (queued.length === 0) break;

    const recommendations = [];
    let succeeded = 0;
    let failed = 0;
    const allowed = Math.max(0, profile.config.limits.llmAnalyzeTopK - currentJob.analyzedCount);
    const selected = queued.slice(0, allowed);
    const overLimit = queued.slice(allowed);
    for (const item of overLimit) {
      await completeCandidate(item.queueId);
    }

    for (const item of selected) {
      let llmJobId: string | undefined;
      try {
        const document = await getLatestRepoDocument(item.repo.id, "readme");
        const readme = document?.rawContent ?? item.repo.description;
        const inputHash = hashText(`${item.repo.fullName}\n${readme}`);
        const cached = await getLatestLlmResult(item.repo.id, "repo_analysis", {
          providerId: provider.id,
          model: provider.model,
          promptVersion: REPO_ANALYSIS_PROMPT_VERSION,
          inputHash
        });
        let analysis: RepoAnalysisResult;
        if (cached) {
          analysis = cached as unknown as RepoAnalysisResult;
        } else {
          llmJobId = await createLlmJob({
            repoId: item.repo.id,
            jobType: "repo_analysis",
            status: "running",
            inputHash,
            providerId: provider.id,
            model: provider.model,
            promptVersion: REPO_ANALYSIS_PROMPT_VERSION
          });
          analysis = await analyzeRepoWithLlm({ repo: item.repo, profile, readme });
          await upsertLlmResult({
            repoId: item.repo.id,
            providerId: provider.id,
            model: provider.model,
            jobType: "repo_analysis",
            promptVersion: REPO_ANALYSIS_PROMPT_VERSION,
            structured: analysis as unknown as Record<string, unknown>,
            rawResponse: JSON.stringify(analysis)
          });
          await finishLlmJob(llmJobId, "completed");
        }
        await upgradeRepoDataLevel([item.repo], "L3");
        recommendations.push(
          buildRecommendation(
            item.repo,
            profile,
            currentJob.analyzedCount + recommendations.length + 1,
            analysis,
            preferenceSignals,
            userRepos
          )
        );
        await completeCandidate(item.queueId);
        succeeded += 1;
      } catch (error) {
        const reason = normalizeAiStageError(error);
        if (llmJobId) {
          await finishLlmJob(llmJobId, "failed");
        }
        if (item.attempts < MAX_AI_CANDIDATE_ATTEMPTS) {
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
        analyzedCount: currentJob.analyzedCount + succeeded,
        stage: "llm",
        status: ready.status,
        statusReason: failed ? `LLM 阶段跳过 ${failed} 个连续失败候选。` : ready.reason
      })) ?? currentJob;
  }

  return moveWhenStageDrained(currentJob, "llm", "rank");
}

async function runRankStage(job: ScanJob, profile: DiscoveryProfile) {
  const provider = await getAiProvider(profile.config.ai.embeddingProviderId);
  if (provider) {
    try {
      const [queryVector] = await callEmbedding(provider, buildProfileEmbeddingInput(profile));
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
  if (remaining === 0 && running === 0) {
    return updateScanJob(job.id, {
      status: "running",
      stage: nextStage,
      analyzedCount: 0,
      statusReason: undefined
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
  return Math.min(300, 15 * 2 ** Math.max(0, attempts - 1));
}

async function isCollectComplete(jobId: string, profile: DiscoveryProfile) {
  const queryPlans = buildGitHubSearchQueryPlans(profile);
  const perQuery = Math.max(1, Math.min(profile.config.limits.sourceLimitPerQuery, 100));
  const maxPagesForQuery = Math.max(
    1,
    Math.ceil(profile.config.limits.sourceLimitPerQuery / perQuery)
  );

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
    readme.slice(0, 12000)
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
