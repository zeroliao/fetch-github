import { calculateFinalScore, clampScore } from "@/lib/scoring";
import type { DiscoveryProfile, Recommendation, RepoSummary } from "@/lib/types";
import { normalizeDiscoverySources, sourceDefinition } from "@/lib/discoverySources";

export interface RepoQualitySignals {
  openssf?: {
    score?: number;
    checks?: Array<{ name: string; score?: number; reason?: string }>;
  };
  ecosystems?: {
    dependentReposCount?: number;
    packagesCount?: number;
    dockerDownloadsCount?: number;
    score?: number;
  };
}

interface OpenSsfScorecardResponse {
  score?: number;
  checks?: Array<{
    name?: string;
    score?: number;
    reason?: string;
  }>;
}

interface EcosystemsRepoResponse {
  dependent_repos_count?: number;
  dependentReposCount?: number;
  packages_count?: number;
  packagesCount?: number;
  docker_downloads_count?: number;
  dockerDownloadsCount?: number;
}

const OPENSSF_API_BASE = "https://api.securityscorecards.dev";
const ECOSYSTEMS_REPOS_API_BASE = "https://repos.ecosyste.ms/api/v1";

export function enabledQualitySignalSources(profile: DiscoveryProfile) {
  const sources = normalizeDiscoverySources(profile.config.sources);
  return sources.filter(
    (source) =>
      source.enabled &&
      (source.id === "openssf_scorecard" || source.id === "ecosystems_usage")
  );
}

export async function fetchRepoQualitySignals(
  repo: RepoSummary,
  profile: DiscoveryProfile
): Promise<RepoQualitySignals> {
  const enabled = enabledQualitySignalSources(profile);
  if (enabled.length === 0) {
    return {};
  }

  const [openssf, ecosystems] = await Promise.all([
    enabled.some((source) => source.id === "openssf_scorecard")
      ? fetchOpenSsfScorecard(repo).catch(() => undefined)
      : undefined,
    enabled.some((source) => source.id === "ecosystems_usage")
      ? fetchEcosystemsUsage(repo).catch(() => undefined)
      : undefined
  ]);

  return {
    openssf,
    ecosystems
  };
}

export function applyQualitySignalsToRecommendation(
  recommendation: Recommendation,
  profile: DiscoveryProfile,
  signals: RepoQualitySignals
): Recommendation {
  const sources = enabledQualitySignalSources(profile);
  if (sources.length === 0 || (!signals.openssf && !signals.ecosystems)) {
    return recommendation;
  }

  const sourceWeight = (id: "openssf_scorecard" | "ecosystems_usage") =>
    sources.find((source) => source.id === id)?.weight ?? 1;
  const openssfScore = normalizeOpenSsfScore(signals.openssf?.score);
  const ecosystemsScore = signals.ecosystems?.score;
  const weightedQualitySignals = [
    openssfScore === undefined
      ? undefined
      : { score: openssfScore, weight: sourceWeight("openssf_scorecard") },
    ecosystemsScore === undefined
      ? undefined
      : { score: ecosystemsScore, weight: sourceWeight("ecosystems_usage") }
  ].filter((item): item is { score: number; weight: number } => Boolean(item));

  if (weightedQualitySignals.length === 0) {
    return recommendation;
  }

  const qualityScore = weightedAverage(weightedQualitySignals);
  const nextTechnicalQuality = clampScore(
    Math.max(recommendation.scores.technicalQuality ?? 0, qualityScore)
  );
  const nextGrowth = clampScore(
    Math.max(recommendation.scores.growth ?? 0, signals.ecosystems?.score ?? 0)
  );
  const scores = {
    ...recommendation.scores,
    technicalQuality: nextTechnicalQuality,
    growth: nextGrowth
  };
  scores.final = calculateFinalScore({
    ruleScore: scores.rule,
    githubContextFit: scores.githubContextFit,
    llmMatchScore: scores.llmMatch,
    feedbackScore: scores.feedback,
    opportunityScore: scores.opportunity,
    monetizationScore: scores.monetization,
    growthSignal: scores.growth,
    executionFit: scores.execution,
    differentiationSpace: scores.differentiation,
    technicalQuality: scores.technicalQuality
  });

  const signalReasons = buildQualitySignalReasons(signals);
  return {
    ...recommendation,
    scores,
    reasons: [...signalReasons, ...recommendation.reasons],
    opportunity: recommendation.opportunity
      ? {
          ...recommendation.opportunity,
          growthSignal: Math.max(recommendation.opportunity.growthSignal, nextGrowth),
          technicalQuality: Math.max(
            recommendation.opportunity.technicalQuality,
            nextTechnicalQuality
          ),
          evidence: [...signalReasons, ...recommendation.opportunity.evidence]
        }
      : recommendation.opportunity,
    qualitySignals: signals
  };
}

export function buildQualitySignalReasons(signals: RepoQualitySignals) {
  const reasons: string[] = [];
  if (signals.openssf?.score !== undefined) {
    reasons.push(`OpenSSF Scorecard 评分 ${signals.openssf.score.toFixed(1)}/10，作为安全与维护质量信号。`);
  }
  if (signals.ecosystems) {
    const usages = [
      signals.ecosystems.dependentReposCount
        ? `${signals.ecosystems.dependentReposCount.toLocaleString()} 个依赖仓库`
        : "",
      signals.ecosystems.packagesCount
        ? `${signals.ecosystems.packagesCount.toLocaleString()} 个关联包`
        : "",
      signals.ecosystems.dockerDownloadsCount
        ? `${signals.ecosystems.dockerDownloadsCount.toLocaleString()} 次 Docker 下载`
        : ""
    ].filter(Boolean);
    if (usages.length) {
      reasons.push(`ecosyste.ms 显示真实使用信号：${usages.join("，")}。`);
    }
  }

  return reasons;
}

export function qualitySignalSourceLabels(profile: DiscoveryProfile) {
  return enabledQualitySignalSources(profile).map(
    (source) => sourceDefinition(source.id)?.label ?? source.id
  );
}

async function fetchOpenSsfScorecard(repo: RepoSummary) {
  const response = await fetchWithTimeout(
    `${OPENSSF_API_BASE}/projects/github.com/${repo.owner}/${repo.name}`
  );
  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as OpenSsfScorecardResponse;
  return {
    score: optionalNumber(data.score),
    checks: (data.checks ?? [])
      .map((check) => ({
        name: String(check.name ?? ""),
        score: optionalNumber(check.score),
        reason: check.reason ? String(check.reason) : undefined
      }))
      .filter((check) => check.name)
      .slice(0, 12)
  };
}

async function fetchEcosystemsUsage(repo: RepoSummary) {
  const encodedFullName = encodeURIComponent(repo.fullName);
  const response = await fetchWithTimeout(
    `${ECOSYSTEMS_REPOS_API_BASE}/hosts/GitHub/repositories/${encodedFullName}`
  );
  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as EcosystemsRepoResponse;
  const dependentReposCount = optionalNumber(
    data.dependent_repos_count ?? data.dependentReposCount
  );
  const packagesCount = optionalNumber(data.packages_count ?? data.packagesCount);
  const dockerDownloadsCount = optionalNumber(
    data.docker_downloads_count ?? data.dockerDownloadsCount
  );

  return {
    dependentReposCount,
    packagesCount,
    dockerDownloadsCount,
    score: scoreEcosystemsUsage({
      dependentReposCount,
      packagesCount,
      dockerDownloadsCount
    })
  };
}

function scoreEcosystemsUsage(input: {
  dependentReposCount?: number;
  packagesCount?: number;
  dockerDownloadsCount?: number;
}) {
  return clampScore(
    logScore(input.dependentReposCount, 5) * 0.55 +
      logScore(input.packagesCount, 3) * 0.25 +
      logScore(input.dockerDownloadsCount, 7) * 0.2
  );
}

function logScore(value: number | undefined, divisor: number) {
  if (!value || value <= 0) {
    return 0;
  }

  return Math.min(1, Math.log10(value + 1) / divisor);
}

function normalizeOpenSsfScore(score: number | undefined) {
  return score === undefined ? undefined : clampScore(score / 10);
}

function weightedAverage(items: Array<{ score: number; weight: number }>) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }

  return items.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    return await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "fetchGithub"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function optionalNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
