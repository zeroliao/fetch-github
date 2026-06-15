import type { DiscoveryProfile, DiscoverySourceId, RepoSummary } from "@/lib/types";
import { normalizeDiscoverySources, sourceDefinition } from "@/lib/discoverySources";

export interface SourceAdapterPlan {
  sourceId: DiscoverySourceId;
  sourceLabel: string;
  weight: number;
  queryHashKey: string;
  cursor: string;
  fetchRepos: (limit: number) => Promise<RepoSummary[]>;
}

interface OssInsightTrendingResponse {
  data?: {
    rows?: OssInsightTrendingRow[];
  };
}

interface OssInsightTrendingRow {
  repo_id?: string | number | null;
  repo_name?: string | null;
  primary_language?: string | null;
  description?: string | null;
  stars?: string | number | null;
  forks?: string | number | null;
  collection_names?: string | null;
}

const OSS_INSIGHT_TRENDING_URL = "https://api.ossinsight.io/v1/trends/repos/";

export function buildSourceAdapterPlans(profile: DiscoveryProfile): SourceAdapterPlan[] {
  const sources = normalizeDiscoverySources(profile.config.sources);
  const plans: SourceAdapterPlan[] = [];
  const ossInsight = sources.find((source) => source.id === "ossinsight_trending");

  if (ossInsight?.enabled) {
    plans.push({
      sourceId: "ossinsight_trending",
      sourceLabel: sourceDefinition("ossinsight_trending")?.label ?? "OSS Insight Trending",
      weight: ossInsight.weight,
      queryHashKey: "ossinsight_trending:past_24_hours:All",
      cursor: "OSS Insight Trending: past_24_hours / All",
      fetchRepos: (limit) => fetchOssInsightTrendingRepos(limit)
    });
  }

  return plans;
}

export async function fetchOssInsightTrendingRepos(limit: number): Promise<RepoSummary[]> {
  const url = new URL(OSS_INSIGHT_TRENDING_URL);
  url.searchParams.set("period", "past_24_hours");
  url.searchParams.set("language", "All");

  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OSS Insight Trending failed: ${response.status} ${response.statusText} ${body}`
    );
  }

  const data = (await response.json()) as OssInsightTrendingResponse;
  return mapOssInsightTrendingRows(data.data?.rows ?? [], new Date().toISOString()).slice(
    0,
    Math.max(1, limit)
  );
}

export function mapOssInsightTrendingRows(
  rows: OssInsightTrendingRow[],
  capturedAt: string
): RepoSummary[] {
  return rows
    .map((row) => mapOssInsightTrendingRow(row, capturedAt))
    .filter((repo): repo is RepoSummary => Boolean(repo));
}

function mapOssInsightTrendingRow(
  row: OssInsightTrendingRow,
  capturedAt: string
): RepoSummary | null {
  const fullName = String(row.repo_name ?? "").trim();
  const slash = fullName.indexOf("/");
  if (!fullName || slash <= 0 || slash >= fullName.length - 1) {
    return null;
  }

  const owner = fullName.slice(0, slash);
  const name = fullName.slice(slash + 1);
  const githubId = optionalNumber(row.repo_id);
  const topics = String(row.collection_names ?? "")
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);

  return {
    id: githubId ? `github-${githubId}` : `github-${owner}-${name}`,
    githubId,
    fullName,
    owner,
    name,
    htmlUrl: `https://github.com/${fullName}`,
    description: String(row.description ?? ""),
    primaryLanguage: String(row.primary_language ?? "").trim() || "Unknown",
    topics,
    stars: numberOrZero(row.stars),
    forks: numberOrZero(row.forks),
    openIssues: 0,
    pushedAt: capturedAt,
    updatedAt: capturedAt,
    archived: false,
    fork: false,
    private: false
  };
}

async function fetchWithTimeout(input: string | URL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    return await fetch(input, {
      headers: {
        Accept: "application/json",
        "User-Agent": "fetchGithub"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OSS Insight 请求超过 30 秒未响应。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function optionalNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function numberOrZero(value: unknown) {
  return optionalNumber(value) ?? 0;
}
