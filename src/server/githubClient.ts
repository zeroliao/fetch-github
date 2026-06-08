import type { RepoSummary } from "@/lib/types";

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepoItem[];
}

interface GitHubRepoItem {
  id: number;
  full_name: string;
  owner: {
    login: string;
  };
  name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  default_branch: string | null;
  created_at: string;
  pushed_at: string | null;
  updated_at: string;
  archived: boolean;
  fork: boolean;
  private: boolean;
}

interface GitHubReadmeResponse {
  html_url?: string;
  download_url?: string | null;
  content?: string;
  encoding?: string;
}

export interface SearchRepositoriesOptions {
  query: string;
  perPage: number;
  page: number;
  sort?: "stars" | "forks" | "updated";
  order?: "asc" | "desc";
}

export interface SearchRepositoriesResult {
  totalCount: number;
  incompleteResults: boolean;
  repos: RepoSummary[];
}

export interface GitHubUserProfile {
  login: string;
  id: number;
  name: string | null;
}

export async function searchRepositories(
  options: SearchRepositoriesOptions
): Promise<SearchRepositoriesResult> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", options.query);
  url.searchParams.set("per_page", String(Math.min(options.perPage, 100)));
  url.searchParams.set("page", String(options.page));
  url.searchParams.set("sort", options.sort ?? "stars");
  url.searchParams.set("order", options.order ?? "desc");

  const response = await fetch(url, { headers: buildGitHubHeaders() });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub search failed: ${response.status} ${response.statusText} ${body}`
    );
  }

  const data = (await response.json()) as GitHubSearchResponse;

  return {
    totalCount: data.total_count,
    incompleteResults: data.incomplete_results,
    repos: data.items.map(mapGitHubRepo)
  };
}

export async function fetchRepositoryReadme(repo: RepoSummary) {
  const response = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/readme`,
    { headers: buildGitHubHeaders() }
  );

  if (response.status === 404) {
    return {
      content: "",
      sourceUrl: `${repo.htmlUrl}#readme`
    };
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub README failed: ${response.status} ${response.statusText} ${body}`);
  }

  const data = (await response.json()) as GitHubReadmeResponse;
  let content = "";

  if (data.content && data.encoding === "base64") {
    content = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
  } else if (data.download_url) {
    const raw = await fetch(data.download_url, { headers: buildGitHubHeaders() });
    if (raw.ok) {
      content = await raw.text();
    }
  }

  return {
    content,
    sourceUrl: data.html_url ?? `${repo.htmlUrl}#readme`
  };
}

export async function getGitHubUserProfile(): Promise<GitHubUserProfile> {
  const response = await fetch("https://api.github.com/user", {
    headers: buildGitHubHeaders()
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub user lookup failed: ${response.status} ${response.statusText} ${body}`);
  }

  const data = (await response.json()) as GitHubUserProfile;
  return {
    login: data.login,
    id: data.id,
    name: data.name ?? null
  };
}

export async function listAuthenticatedRepositories(kind: "owned" | "starred") {
  const path =
    kind === "owned"
      ? "https://api.github.com/user/repos?affiliation=owner&visibility=all&sort=updated&direction=desc"
      : "https://api.github.com/user/starred";

  const repos: RepoSummary[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(path);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetch(url, { headers: buildGitHubHeaders() });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub ${kind} repository list failed: ${response.status} ${response.statusText} ${body}`);
    }

    const data = (await response.json()) as GitHubRepoItem[];
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    repos.push(...data.map(mapGitHubRepo));
    if (data.length < 100) {
      break;
    }
  }

  return repos;
}

function buildGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "fetchGithub"
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

function mapGitHubRepo(repo: GitHubRepoItem): RepoSummary {
  return {
    id: `github-${repo.id}`,
    githubId: repo.id,
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    htmlUrl: repo.html_url,
    description: repo.description ?? "",
    primaryLanguage: repo.language ?? "Unknown",
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    pushedAt: repo.pushed_at ?? repo.updated_at,
    updatedAt: repo.updated_at,
    archived: repo.archived,
    fork: repo.fork,
    private: repo.private
  };
}
