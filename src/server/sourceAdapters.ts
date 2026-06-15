import type { DiscoveryProfile, DiscoverySourceId, RepoSummary } from "@/lib/types";
import { normalizeDiscoverySources, sourceDefinition } from "@/lib/discoverySources";
import { fetchRepositoryDetails } from "./githubClient";

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
const GITHUB_TRENDING_URL = "https://github.com/trending";

export function buildSourceAdapterPlans(profile: DiscoveryProfile): SourceAdapterPlan[] {
  const sources = normalizeDiscoverySources(profile.config.sources);
  const plans: SourceAdapterPlan[] = [];
  const githubTrending = sources.find((source) => source.id === "github_trending");
  const ossInsight = sources.find((source) => source.id === "ossinsight_trending");

  if (githubTrending?.enabled) {
    plans.push({
      sourceId: "github_trending",
      sourceLabel: sourceDefinition("github_trending")?.label ?? "GitHub Trending",
      weight: githubTrending.weight,
      queryHashKey: "github_trending:daily:all",
      cursor: "GitHub Trending: daily / all languages",
      fetchRepos: (limit) => fetchGitHubTrendingRepos(limit)
    });
  }

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

export async function fetchGitHubTrendingRepos(limit: number): Promise<RepoSummary[]> {
  const url = new URL(GITHUB_TRENDING_URL);
  url.searchParams.set("since", "daily");

  const response = await fetchWithTimeout(url, "text/html");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub Trending failed: ${response.status} ${response.statusText} ${body}`
    );
  }

  const links = parseGitHubTrendingRepoLinks(await response.text()).slice(
    0,
    Math.max(1, limit)
  );
  const repos: RepoSummary[] = [];
  for (const link of links) {
    const repo = await fetchRepositoryDetails(link.owner, link.name);
    if (repo) {
      repos.push(repo);
    }
  }

  return repos;
}

export async function fetchOssInsightTrendingRepos(limit: number): Promise<RepoSummary[]> {
  const url = new URL(OSS_INSIGHT_TRENDING_URL);
  url.searchParams.set("period", "past_24_hours");
  url.searchParams.set("language", "All");

  const response = await fetchWithTimeout(url, "application/json");
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

export function parseGitHubTrendingRepoLinks(html: string) {
  const links: Array<{ owner: string; name: string }> = [];
  const seen = new Set<string>();
  const pattern = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href="\/([^/"#?]+)\/([^/"#?]+)"[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    const owner = decodeHtml(match[1]).trim();
    const name = decodeHtml(match[2]).trim();
    const key = `${owner}/${name}`.toLowerCase();
    if (!owner || !name || seen.has(key)) {
      continue;
    }

    seen.add(key);
    links.push({ owner, name });
  }

  return links;
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

async function fetchWithTimeout(input: string | URL, accept: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    return await fetch(input, {
      headers: {
        Accept: accept,
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

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function optionalNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function numberOrZero(value: unknown) {
  return optionalNumber(value) ?? 0;
}
