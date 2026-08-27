import test from "node:test";
import assert from "node:assert/strict";
import type { AiProvider } from "../src/lib/types";
import { mergeLocalProviderGroupModels } from "../src/server/store";

function provider(id: string, groupId: string, model: string): AiProvider {
  return {
    id,
    providerGroupId: groupId,
    groupEnabled: true,
    name: "TEST_PROVIDER",
    kind: "chat",
    type: "openai_compatible",
    baseUrl: "https://example.com/v1",
    apiKeyEnv: "TEST_PROVIDER_API_KEY",
    model,
    priority: 100,
    enabled: true,
    availabilityStatus: "available",
    cooldownSeconds: 300,
    cooldownOn: ["timeout"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("local provider group merge persists newly imported models", () => {
  const existing = provider("existing-model", "group-a", "gpt-existing");
  const unrelated = provider("unrelated-model", "group-b", "gpt-unrelated");
  const imported = provider("imported-model", "group-a", "gpt-imported");
  const updatedExisting = { ...existing, priority: 10 };

  const merged = mergeLocalProviderGroupModels(
    [existing, unrelated],
    "group-a",
    [updatedExisting, imported],
    "2026-08-28T00:00:00.000Z",
  );

  assert.equal(merged.length, 3);
  assert.equal(merged.find((item) => item.id === existing.id)?.priority, 10);
  assert.equal(
    merged.find((item) => item.id === imported.id)?.model,
    "gpt-imported",
  );
  assert.equal(
    merged.find((item) => item.id === unrelated.id),
    unrelated,
  );
});
