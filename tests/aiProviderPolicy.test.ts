import assert from "node:assert/strict";
import test from "node:test";
import type { AiProvider, ProviderAvailabilityStatus } from "../src/lib/types";
import {
  classifyAiProviderFailure,
  isManualRecoveryStatus,
  orderEligibleProviders,
  providerNeedsManualRecovery,
} from "../src/server/aiProviderPolicy";

function provider(id: string, overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id,
    name: id,
    kind: "chat",
    type: "openai_compatible",
    baseUrl: "https://example.test/v1",
    apiKeyEnv: "TEST_API_KEY",
    model: "test-model",
    priority: 100,
    enabled: true,
    availabilityStatus: "available",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("orders eligible providers by priority, creation time, and id", () => {
  const result = orderEligibleProviders(
    [
      provider("later", { priority: 20, createdAt: "2026-01-02T00:00:00Z" }),
      provider("z-id", { priority: 20 }),
      provider("disabled", { priority: 1, enabled: false }),
      provider("embedding", { priority: 1, kind: "embedding" }),
      provider("archived", { priority: 1, archivedAt: "2026-01-03T00:00:00Z" }),
      provider("excluded", { priority: 1 }),
      provider("a-id", { priority: 20 }),
      provider("first", { priority: 10 }),
    ],
    "chat",
    new Set(["excluded"]),
    new Date("2026-01-10T00:00:00Z"),
  );

  assert.deepEqual(
    result.map((item) => item.id),
    ["first", "a-id", "z-id", "later"],
  );
});

test("keeps active cooldowns out and returns expired cooldowns to selection", () => {
  const result = orderEligibleProviders(
    [
      provider("active", {
        availabilityStatus: "cooldown",
        cooldownUntil: "2026-01-10T00:01:00Z",
      }),
      provider("expired", {
        availabilityStatus: "cooldown",
        cooldownUntil: "2026-01-09T23:59:00Z",
      }),
      provider("missing-deadline", { availabilityStatus: "cooldown" }),
      provider("blocked", { availabilityStatus: "blocked_auth" }),
    ],
    "chat",
    [],
    "2026-01-10T00:00:00Z",
  );

  assert.deepEqual(
    result.map((item) => item.id),
    ["expired"],
  );
});

test("classifies authentication, permission, and invalid configuration as manual recovery", () => {
  const cases = [
    {
      error: { status: 401, message: "Unauthorized" },
      code: "auth",
      status: "blocked_auth",
    },
    {
      error: { response: { status: 403 }, message: "Forbidden" },
      code: "permission",
      status: "blocked_permission",
    },
    {
      error: new Error("Missing API key env: OPENAI_API_KEY"),
      code: "auth",
      status: "blocked_auth",
    },
    {
      error: new Error(
        "Chat provider failed: 400 unsupported parameter reasoning_effort",
      ),
      code: "invalid_config",
      status: "invalid_config",
    },
  ] as const;

  for (const item of cases) {
    const result = classifyAiProviderFailure(item.error);
    assert.equal(result.code, item.code);
    assert.equal(result.targetAvailabilityStatus, item.status);
    assert.equal(result.retryable, false);
    assert.equal(result.parseFailure, false);
    assert.equal(isManualRecoveryStatus(item.status), true);
  }
});

test("classifies rate limits and respects Retry-After", () => {
  const result = classifyAiProviderFailure({
    status: 429,
    headers: { "Retry-After": "120" },
    message: "Too many requests",
  });

  assert.equal(result.code, "rate_limit");
  assert.equal(result.retryable, true);
  assert.equal(result.parseFailure, false);
  assert.equal(result.targetAvailabilityStatus, "cooldown");
  assert.equal(result.cooldownSeconds, 120);
});

test("classifies timeout, network, and server failures as transient cooldowns", () => {
  const cases = [
    { error: new Error("request timed out"), code: "timeout" },
    { error: new Error("fetch failed: ECONNRESET"), code: "network" },
    {
      error: { statusCode: 503, message: "service unavailable" },
      code: "server",
    },
  ] as const;

  for (const item of cases) {
    const result = classifyAiProviderFailure(item.error);
    assert.equal(result.code, item.code);
    assert.equal(result.retryable, true);
    assert.equal(result.parseFailure, false);
    assert.equal(result.targetAvailabilityStatus, "cooldown");
    assert.equal(result.cooldownSeconds, 30);
  }
});

test("separates JSON parsing failures from schema failures", () => {
  const parseFailure = classifyAiProviderFailure(
    new SyntaxError("Unexpected token s in JSON at position 1"),
  );
  const schemaFailure = classifyAiProviderFailure(
    new Error("ZodError: required field summary is missing"),
  );

  assert.equal(parseFailure.code, "output_parse");
  assert.equal(parseFailure.parseFailure, true);
  assert.equal(parseFailure.targetAvailabilityStatus, undefined);
  assert.equal(schemaFailure.code, "output_schema");
  assert.equal(schemaFailure.parseFailure, true);
  assert.equal(schemaFailure.targetAvailabilityStatus, undefined);
});

test("never exposes provider secrets in user-safe output", () => {
  const secret = "sk-live-super-secret-value";
  const failures = [
    classifyAiProviderFailure(new Error(`invalid api_key=${secret}`)),
    classifyAiProviderFailure(new Error(`unknown failure Bearer ${secret}`)),
    classifyAiProviderFailure({
      status: 400,
      message: `password=${secret}; token=${secret}`,
    }),
  ];

  for (const failure of failures) {
    assert.doesNotMatch(failure.reason, /sk-live|super-secret|Bearer/i);
    assert.doesNotMatch(
      failure.recoverySuggestion,
      /sk-live|super-secret|Bearer/i,
    );
  }
});

test("manual recovery helpers only select persistent unavailable states", () => {
  const manual: ProviderAvailabilityStatus[] = [
    "blocked_auth",
    "blocked_permission",
    "invalid_config",
  ];
  const automatic: ProviderAvailabilityStatus[] = [
    "available",
    "cooldown",
    "recovering",
  ];

  for (const status of manual) {
    assert.equal(isManualRecoveryStatus(status), true);
    assert.equal(
      providerNeedsManualRecovery(
        provider(status, { availabilityStatus: status }),
      ),
      true,
    );
  }
  for (const status of automatic) {
    assert.equal(isManualRecoveryStatus(status), false);
    assert.equal(
      providerNeedsManualRecovery(
        provider(status, { availabilityStatus: status }),
      ),
      false,
    );
  }
});
