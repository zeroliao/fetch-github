import type { AiProvider } from "@/lib/types";
import {
  AiProviderOutputSchemaError,
  callChatJson,
  callEmbedding,
} from "./aiClient";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function probeAiProvider(provider: AiProvider) {
  const apiKeyPresent = Boolean(process.env[provider.apiKeyEnv]);
  if (!provider.enabled || !apiKeyPresent) {
    return {
      ready: false,
      checked: false,
      reason: provider.enabled ? "api_key_missing" : "provider_disabled",
    };
  }

  if (provider.kind === "chat") {
    const result = await callChatJson({
      provider,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: 'Return only this JSON object: {"ok":true}.',
        },
        {
          role: "user",
          content: "Return the probe object now. Do not analyze a repository.",
        },
      ],
    });
    if (!isRecord(result) || result.ok !== true) {
      throw new AiProviderOutputSchemaError(
        "expected JSON object with ok=true",
      );
    }
  } else {
    const inputs = ["example/tool: developer workflow automation tool"];
    const vectors = await callEmbedding(provider, inputs);
    if (vectors.length !== inputs.length) {
      throw new AiProviderOutputSchemaError(
        `expected ${inputs.length} vectors, received ${vectors.length}`,
      );
    }
    if (
      provider.dimensions &&
      vectors.some((vector) => vector.length !== provider.dimensions)
    ) {
      throw new AiProviderOutputSchemaError(
        `embedding dimensions do not match configured ${provider.dimensions}`,
      );
    }
  }

  return {
    ready: true,
    checked: true,
  };
}
