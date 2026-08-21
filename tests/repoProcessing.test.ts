import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeGitHubRepoUrl,
  isRetryableRepoProcessingStatus,
  isTerminalRepoProcessingStatus,
  type RepoProcessingStatus,
} from "../src/lib/repoProcessing";

test("GitHub repository URL variants produce one stable canonical key", () => {
  const variants = [
    "https://github.com/OpenAI/Codex",
    "http://github.com/openai/codex/",
    "https://www.github.com/OPENAI/CODEX.git",
    "https://github.com/OpenAI/Codex.git/?tab=readme#installation",
  ];

  const keys = variants.map(canonicalizeGitHubRepoUrl);
  assert.deepEqual(new Set(keys), new Set(["https://github.com/openai/codex"]));
});

test("canonical URL strips query, fragment, git suffix, and repeated trailing slashes", () => {
  assert.equal(
    canonicalizeGitHubRepoUrl(
      "  HTTPS://WWW.GITHUB.COM/Example/Repository.GIT///?tab=readme#usage  ",
    ),
    "https://github.com/example/repository",
  );
});

test("non-GitHub and non-repository URLs are rejected", () => {
  const invalidUrls = [
    "",
    "github.com/owner/repo",
    "ftp://github.com/owner/repo",
    "https://gitlab.com/owner/repo",
    "https://api.github.com/repos/owner/repo",
    "https://github.com/owner",
    "https://github.com/owner/repo/issues",
    "https://github.com/owner/repo/../../other",
    "https://github.com/owner%2Frepo/project",
    "https://user:secret@github.com/owner/repo",
    "https://github.com:8443/owner/repo",
  ];

  for (const url of invalidUrls) {
    assert.equal(canonicalizeGitHubRepoUrl(url), undefined, url);
  }
});

test("renamed repositories retain distinct canonical keys", () => {
  assert.notEqual(
    canonicalizeGitHubRepoUrl("https://github.com/example/original-name"),
    canonicalizeGitHubRepoUrl("https://github.com/example/renamed-project"),
  );
});

test("only processed and skipped statuses count as terminal processing", () => {
  const expected: Record<RepoProcessingStatus, boolean> = {
    pending: false,
    processing: false,
    processed: true,
    skipped: true,
    failed: false,
    exception: false,
  };

  for (const [status, terminal] of Object.entries(expected)) {
    assert.equal(
      isTerminalRepoProcessingStatus(status as RepoProcessingStatus),
      terminal,
    );
  }
});

test("failed and exception statuses are retryable", () => {
  assert.equal(isRetryableRepoProcessingStatus("failed"), true);
  assert.equal(isRetryableRepoProcessingStatus("exception"), true);
  assert.equal(isRetryableRepoProcessingStatus("processed"), false);
  assert.equal(isRetryableRepoProcessingStatus("skipped"), false);
  assert.equal(isRetryableRepoProcessingStatus("pending"), false);
  assert.equal(isRetryableRepoProcessingStatus("processing"), false);
});
