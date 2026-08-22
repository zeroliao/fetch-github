import assert from "node:assert/strict";
import test from "node:test";
import { providerNameToApiKeyEnv } from "../src/server/providerApiKey";

test("derives the API key env name directly from the provider name", () => {
  const chat = providerNameToApiKeyEnv("OpenAI GPT-5");
  const embedding = providerNameToApiKeyEnv("embedding_model");

  assert.equal(chat, "OPENAI_GPT_5");
  assert.equal(embedding, "EMBEDDING_MODEL");
  assert.throws(() => providerNameToApiKeyEnv("!!!"));
});
