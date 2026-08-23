import assert from "node:assert/strict";
import test from "node:test";
import type { AiProvider } from "../src/lib/types";
import {
  AiProviderHttpError,
  AiProviderOutputParseError,
  AiProviderOutputSchemaError,
  callChatJson,
} from "../src/server/aiClient";
import { probeAiProvider } from "../src/server/aiProviderProbe";
import { classifyAiProviderFailure } from "../src/server/aiProviderPolicy";
import { parseRepoAnalysisResult } from "../src/server/llmAnalysis";

const API_KEY_ENV = "FETCH_GITHUB_AI_INVOCATION_TEST_KEY";
const originalFetch = globalThis.fetch;
const originalApiKey = process.env[API_KEY_ENV];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env[API_KEY_ENV];
  } else {
    process.env[API_KEY_ENV] = originalApiKey;
  }
});

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: "chat-test",
    name: "Chat test",
    kind: "chat",
    type: "openai_compatible",
    baseUrl: "https://provider.example/v1",
    apiKeyEnv: API_KEY_ENV,
    model: "gpt-test",
    priority: 10,
    enabled: true,
    availabilityStatus: "available",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

function successfulChatResponse(content = '{"ok":true}') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("reasoning model sends reasoning_effort and omits temperature", async () => {
  process.env[API_KEY_ENV] = "test-secret";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return successfulChatResponse();
  };

  await callChatJson({
    provider: provider({ reasoningEffort: "high" }),
    messages: [{ role: "user", content: "return JSON" }],
    temperature: 0.9,
  });

  assert.equal(requestBody?.reasoning_effort, "high");
  assert.equal(Object.hasOwn(requestBody ?? {}, "temperature"), false);
});

test("default reasoning mode omits reasoning_effort and keeps temperature", async () => {
  process.env[API_KEY_ENV] = "test-secret";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return successfulChatResponse();
  };

  await callChatJson({
    provider: provider({ reasoningEffort: "default" }),
    messages: [{ role: "user", content: "return JSON" }],
    temperature: 0,
  });

  assert.equal(Object.hasOwn(requestBody ?? {}, "reasoning_effort"), false);
  assert.equal(requestBody?.temperature, 0);
});

test("disabled reasoning mode omits reasoning_effort and keeps temperature", async () => {
  process.env[API_KEY_ENV] = "test-secret";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return successfulChatResponse('{"ok":true}');
  };

  await callChatJson({
    provider: provider({ reasoningEffort: "none" }),
    messages: [{ role: "user", content: "return JSON" }],
  });

  assert.equal(Object.hasOwn(requestBody ?? {}, "reasoning_effort"), false);
  assert.equal(requestBody?.temperature, 0.2);
});

test("each provider resolves the API key from its own env name", async () => {
  const firstEnv = "FETCH_GITHUB_FIRST_PROVIDER_KEY";
  const secondEnv = "FETCH_GITHUB_SECOND_PROVIDER_KEY";
  const previousFirst = process.env[firstEnv];
  const previousSecond = process.env[secondEnv];
  process.env[firstEnv] = "first-secret";
  process.env[secondEnv] = "second-secret";
  const authorizationHeaders: string[] = [];
  globalThis.fetch = async (_input, init) => {
    authorizationHeaders.push(
      String(
        init?.headers instanceof Headers
          ? init.headers.get("authorization")
          : (init?.headers as Record<string, string>)?.Authorization,
      ),
    );
    return successfulChatResponse();
  };

  try {
    await callChatJson({
      provider: provider({ apiKeyEnv: firstEnv }),
      messages: [{ role: "user", content: "return JSON" }],
    });
    await callChatJson({
      provider: provider({ apiKeyEnv: secondEnv }),
      messages: [{ role: "user", content: "return JSON" }],
    });
  } finally {
    if (previousFirst === undefined) delete process.env[firstEnv];
    else process.env[firstEnv] = previousFirst;
    if (previousSecond === undefined) delete process.env[secondEnv];
    else process.env[secondEnv] = previousSecond;
  }

  assert.deepEqual(authorizationHeaders, [
    "Bearer first-secret",
    "Bearer second-secret",
  ]);
});

test("HTTP failures expose typed retry metadata without exposing credentials", async () => {
  const secret = "sk-live-super-secret-value";
  process.env[API_KEY_ENV] = secret;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: `No available accounts; Bearer ${secret}`,
          authorization: `Bearer ${secret}`,
          token: secret,
        },
      }),
      { status: 429, headers: { "retry-after": "120" } },
    );

  await assert.rejects(
    callChatJson({
      provider: provider(),
      messages: [{ role: "user", content: "return JSON" }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AiProviderHttpError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterSeconds, 120);
      assert.equal(error.headers?.["retry-after"], "120");
      assert.match(error.responseSummary ?? "", /No available accounts/);
      assert.doesNotMatch(
        `${error.message} ${error.responseSummary}`,
        /sk-live|super-secret|Bearer/i,
      );

      const classification = classifyAiProviderFailure(error);
      assert.equal(classification.code, "rate_limit");
      assert.equal(classification.cooldownSeconds, 120);
      return true;
    },
  );
});

test("invalid model JSON throws a classifiable output_parse error", async () => {
  process.env[API_KEY_ENV] = "test-secret";
  globalThis.fetch = async () => successfulChatResponse("not-json");

  await assert.rejects(
    callChatJson({
      provider: provider(),
      messages: [{ role: "user", content: "return JSON" }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AiProviderOutputParseError);
      assert.equal(error.name, "AiProviderOutputParseError");
      assert.equal(error.code, "output_parse");
      assert.equal(classifyAiProviderFailure(error).code, "output_parse");
      return true;
    },
  );
});

test("chat JSON extraction accepts a provider prefix and markdown fence", async () => {
  process.env[API_KEY_ENV] = "test-secret";
  globalThis.fetch = async () =>
    successfulChatResponse('分析如下：\n```json\n{"ok":true}\n```');

  assert.deepEqual(
    await callChatJson({
      provider: provider(),
      messages: [{ role: "user", content: "return JSON" }],
    }),
    { ok: true },
  );
});

test("provider probe validates minimal structured chat output", async () => {
  process.env[API_KEY_ENV] = "test-secret";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return successfulChatResponse('{"ok":true}');
  };

  const result = await probeAiProvider(provider());
  assert.equal(result.ready, true);

  const messages = requestBody?.messages as Array<Record<string, unknown>>;
  assert.match(String(messages?.[0]?.content), /ok/);
  assert.deepEqual(requestBody?.response_format, { type: "json_object" });
});

test("provider probe rejects non-probe structured chat output", async () => {
  process.env[API_KEY_ENV] = "test-secret";
  globalThis.fetch = async () => successfulChatResponse('{"ok":false}');

  await assert.rejects(probeAiProvider(provider()), (error: unknown) => {
    assert.ok(error instanceof AiProviderOutputSchemaError);
    assert.equal(error.code, "output_schema");
    return true;
  });
});

test("embedding provider probe validates batch cardinality", async () => {
  process.env[API_KEY_ENV] = "test-secret";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    probeAiProvider(
      provider({
        id: "embedding-test",
        kind: "embedding",
        model: "embedding-test",
        dimensions: 3,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AiProviderOutputSchemaError);
      assert.match(error.message, /expected 1 vectors, received 0/);
      return true;
    },
  );
});

const validAnalysis = {
  summary: "面向开发者的自动化工作流工具。",
  categories: ["developer-tools"],
  target_users: ["开发者"],
  core_features: ["workflow"],
  maturity: "growth",
  is_match: true,
  match_score: 0.82,
  confidence: 0.76,
  matched_preferences: ["automation"],
  risks: ["竞争激烈"],
  recommendation_reason: "可以验证托管服务需求。",
  opportunity: {
    type: "SaaS/工具机会",
    score: 0.8,
    monetizationScore: 0.75,
    growthSignal: 0.7,
    executionFit: 0.85,
    differentiationSpace: 0.6,
    technicalQuality: 0.8,
    targetCustomers: ["研发团队"],
    monetizationPaths: ["托管订阅"],
    validationSteps: ["访谈 5 个团队"],
    suggestedAction: "validate" as const,
    evidence: ["近期提交活跃"],
  },
};

test("repo analysis accepts the complete strict output schema", () => {
  assert.deepEqual(parseRepoAnalysisResult(validAnalysis), validAnalysis);
});

test("repo analysis rejects missing, invalid, and unknown output fields", () => {
  for (const invalid of [
    { ...validAnalysis, summary: undefined },
    { ...validAnalysis, extra: "unexpected" },
  ]) {
    assert.throws(
      () => parseRepoAnalysisResult(invalid),
      (error: unknown) => {
        assert.ok(error instanceof AiProviderOutputSchemaError);
        assert.equal(error.name, "AiProviderOutputSchemaError");
        assert.equal(error.code, "output_schema");
        assert.equal(classifyAiProviderFailure(error).code, "output_schema");
        return true;
      },
    );
  }
});

test("repo analysis normalizes compatible provider field representations", () => {
  const normalized = parseRepoAnalysisResult({
    ...validAnalysis,
    is_match: "true",
    match_score: "0.82",
    opportunity: {
      ...validAnalysis.opportunity,
      technicalQuality: null,
      suggestedAction: "monitor",
    },
  });

  assert.equal(normalized.is_match, true);
  assert.equal(normalized.match_score, 0.82);
  assert.equal(normalized.opportunity?.technicalQuality, 0.5);
  assert.equal(normalized.opportunity?.suggestedAction, "observe");
});
