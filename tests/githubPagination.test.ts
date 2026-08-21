import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_SEARCH_MAX_PAGE_SIZE,
  isGitHubSearchPageComplete,
} from "@/server/githubClient";

test("GitHub Search keeps paging while more reachable results remain", () => {
  assert.equal(
    isGitHubSearchPageComplete({
      page: 1,
      perPage: GITHUB_SEARCH_MAX_PAGE_SIZE,
      returnedCount: 100,
      totalCount: 550,
    }),
    false,
  );
});

test("GitHub Search stops on a partial final page", () => {
  assert.equal(
    isGitHubSearchPageComplete({
      page: 3,
      perPage: GITHUB_SEARCH_MAX_PAGE_SIZE,
      returnedCount: 17,
      totalCount: 217,
    }),
    true,
  );
});

test("GitHub Search stops at GitHub's 1000-result boundary", () => {
  assert.equal(
    isGitHubSearchPageComplete({
      page: 10,
      perPage: GITHUB_SEARCH_MAX_PAGE_SIZE,
      returnedCount: 100,
      totalCount: 20_000,
    }),
    true,
  );
});
