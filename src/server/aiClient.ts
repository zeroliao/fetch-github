import type { AiProvider } from "@/lib/types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatJsonOptions {
  provider: AiProvider;
  messages: ChatMessage[];
  temperature?: number;
}

export async function callChatJson(options: ChatJsonOptions) {
  assertProviderReady(options.provider, "chat");
  const response = await fetchWithTimeout(
    `${trimSlash(options.provider.baseUrl)}/chat/completions`,
    {
      method: "POST",
      headers: buildHeaders(options.provider),
      body: JSON.stringify({
        model: options.provider.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.2,
        response_format: { type: "json_object" }
      })
    },
    options.provider
  );

  if (!response.ok) {
    throw new Error(`Chat provider failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Chat 模型没有返回可用内容。");
  }

  return JSON.parse(content) as unknown;
}

export async function callEmbedding(provider: AiProvider, input: string | string[]) {
  assertProviderReady(provider, "embedding");
  const response = await fetchWithTimeout(
    `${trimSlash(provider.baseUrl)}/embeddings`,
    {
      method: "POST",
      headers: buildHeaders(provider),
      body: JSON.stringify({
        model: provider.model,
        input
      })
    },
    provider
  );

  if (!response.ok) {
    throw new Error(`Embedding provider failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data?.data?.map((item: { embedding: number[] }) => item.embedding) as number[][];
}

export async function testProvider(provider: AiProvider) {
  const apiKeyPresent = Boolean(process.env[provider.apiKeyEnv]);
  if (!provider.enabled || !apiKeyPresent) {
    return {
      ready: false,
      checked: false,
      reason: provider.enabled ? "api_key_missing" : "provider_disabled"
    };
  }

  if (provider.kind === "chat") {
    await callChatJson({
      provider,
      messages: [
        {
          role: "system",
          content: "只返回 JSON。"
        },
        {
          role: "user",
          content: "{\"ok\":true}"
        }
      ],
      temperature: 0
    });
  } else {
    await callEmbedding(provider, "fetchGithub provider test");
  }

  return {
    ready: true,
    checked: true
  };
}

function assertProviderReady(provider: AiProvider, kind: AiProvider["kind"]) {
  if (provider.kind !== kind) {
    throw new Error(`Expected ${kind} provider, got ${provider.kind}.`);
  }

  if (!provider.enabled) {
    throw new Error("Provider is disabled.");
  }

  if (!process.env[provider.apiKeyEnv]) {
    throw new Error(`Missing API key env: ${provider.apiKeyEnv}`);
  }
}

function buildHeaders(provider: AiProvider) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env[provider.apiKeyEnv]}`
  };
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  provider: AiProvider
) {
  const timeoutSeconds = provider.timeoutSeconds ?? (provider.kind === "chat" ? 60 : 30);
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(
        `${provider.kind === "chat" ? "Chat" : "Embedding"} 模型请求超过 ${timeoutSeconds} 秒未响应。`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
