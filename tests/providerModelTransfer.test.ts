import test from "node:test";
import assert from "node:assert/strict";
import {
  createProviderModelsXlsx,
  modelsForTransfer,
  parseProviderModelsJson,
  parseProviderModelsXlsx,
} from "../src/server/providerModelTransfer";
import type { AiProviderFailureCode } from "../src/lib/types";
import { MAX_AI_PROVIDER_MODELS } from "../src/lib/types";

const model = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "TEST_PROVIDER",
  kind: "chat" as const,
  type: "openai_compatible" as const,
  baseUrl: "https://example.com/v1",
  apiKeyEnv: "TEST_PROVIDER_API_KEY",
  model: "gpt-test",
  priority: 10,
  enabled: true,
  availabilityStatus: "available" as const,
  cooldownSeconds: 300,
  cooldownOn: ["timeout", "server"] as AiProviderFailureCode[],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("JSON transfer validates version and normalizes model fields", () => {
  const parsed = parseProviderModelsJson(
    JSON.stringify({ version: 1, models: [modelsForTransfer([model])[0]] }),
  );
  assert.equal(parsed[0].model, "gpt-test");
  assert.equal(parsed[0].cooldownSeconds, 300);
  assert.throws(
    () => parseProviderModelsJson(JSON.stringify({ version: 2, models: [] })),
    /版本/,
  );
});

test("XLSX transfer round-trips portable model configuration", () => {
  const portable = modelsForTransfer([model]);
  const parsed = parseProviderModelsXlsx(createProviderModelsXlsx(portable));
  assert.deepEqual(parsed, portable);
});

test("transfer rejects duplicate models in one file", () => {
  const portable = modelsForTransfer([model]);
  assert.throws(
    () =>
      parseProviderModelsJson(
        JSON.stringify({ version: 1, models: [portable[0], portable[0]] }),
      ),
    /重复模型/,
  );
});

test("transfer accepts 500 models and rejects 501 models", () => {
  const portable = modelsForTransfer([model])[0];
  const models = Array.from({ length: MAX_AI_PROVIDER_MODELS }, (_, index) => ({
    ...portable,
    model: `gpt-test-${index + 1}`,
  }));
  assert.equal(
    parseProviderModelsJson(JSON.stringify({ version: 1, models })).length,
    MAX_AI_PROVIDER_MODELS,
  );
  assert.throws(
    () =>
      parseProviderModelsJson(
        JSON.stringify({
          version: 1,
          models: [...models, { ...portable, model: "gpt-test-501" }],
        }),
      ),
    /1-500/,
  );
});
