import type { RepoProcessingStatus } from "./types";

export type { RepoProcessingStatus } from "./types";

const TERMINAL_REPO_PROCESSING_STATUSES = new Set<RepoProcessingStatus>([
  "processed",
  "skipped",
]);

const RETRYABLE_REPO_PROCESSING_STATUSES = new Set<RepoProcessingStatus>([
  "failed",
  "exception",
]);

export function canonicalizeGitHubRepoUrl(value: string): string | undefined {
  const input = value.trim();
  if (!input) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.hostname !== "github.com" && url.hostname !== "www.github.com") ||
    url.port ||
    url.username ||
    url.password
  ) {
    return undefined;
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/*$/);
  if (!match) {
    return undefined;
  }

  const owner = decodePathSegment(match[1]);
  const repositoryWithSuffix = decodePathSegment(match[2]);
  if (!owner || !repositoryWithSuffix) {
    return undefined;
  }

  const repository = repositoryWithSuffix.replace(/\.git$/i, "");
  if (!repository || repository === "." || repository === "..") {
    return undefined;
  }

  return `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

export function isTerminalRepoProcessingStatus(
  status: RepoProcessingStatus,
): boolean {
  return TERMINAL_REPO_PROCESSING_STATUSES.has(status);
}

export function isRetryableRepoProcessingStatus(
  status: RepoProcessingStatus,
): boolean {
  return RETRYABLE_REPO_PROCESSING_STATUSES.has(status);
}

function decodePathSegment(value: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }

  if (
    !decoded ||
    decoded === "." ||
    decoded === ".." ||
    /[\\/?#\s\u0000-\u001f\u007f]/.test(decoded)
  ) {
    return undefined;
  }

  return decoded;
}
