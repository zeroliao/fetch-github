import assert from "node:assert/strict";
import test from "node:test";
import { classifyScanFailure } from "../src/server/scanFailure";

test("classifies GitHub authentication failures with an actionable resolution", () => {
  const failure = classifyScanFailure(
    'GitHub repository lookup failed: 401 Unauthorized {"message":"Bad credentials"}',
  );

  assert.equal(failure.code, "github_auth");
  assert.match(failure.message, /GitHub 认证失败/);
  assert.match(failure.resolution, /GITHUB_TOKEN/);
});

test("classifies AI provider parameter failures without exposing secrets", () => {
  const failure = classifyScanFailure(
    'Embedding provider failed: 400 {"message":"invalid api_key=sk-secret-value"}',
  );

  assert.equal(failure.code, "ai_invalid_request");
  assert.match(failure.message, /AI provider 请求参数无效/);
  assert.doesNotMatch(failure.message, /sk-secret-value/);
  assert.match(failure.resolution, /Base URL/);
});

test("classifies timeouts as retryable operational failures", () => {
  const failure = classifyScanFailure("GitHub 请求超过 30 秒未响应。");

  assert.equal(failure.code, "github_timeout");
  assert.match(failure.message, /请求超时/);
  assert.match(failure.resolution, /网络连通性/);
});
