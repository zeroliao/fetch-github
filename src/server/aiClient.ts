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

export interface ChatJsonResult {
  data: unknown;
  usage: Record<string, unknown>;
}

export class AiProviderHttpError extends Error {
  readonly code = "http_error";
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly responseSummary?: string;
  readonly headers?: Record<string, string>;

  constructor(input: {
    providerKind: AiProvider["kind"];
    status: number;
    retryAfter?: string;
    responseSummary?: string;
  }) {
    const label = input.providerKind === "chat" ? "Chat" : "Embedding";
    super(
      `${label} provider failed with HTTP ${input.status}` +
        (input.responseSummary ? `: ${input.responseSummary}` : "."),
    );
    this.name = "AiProviderHttpError";
    this.status = input.status;
    this.retryAfterSeconds = parseRetryAfterSeconds(input.retryAfter);
    this.responseSummary = input.responseSummary;
    this.headers = input.retryAfter
      ? { "retry-after": input.retryAfter }
      : undefined;
  }
}

export class AiProviderConfigurationError extends Error {
  readonly code = "invalid_config";

  constructor(message: string) {
    super(`Invalid AI provider configuration: ${message}`);
    this.name = "AiProviderConfigurationError";
  }
}

export class AiProviderTransportError extends Error {
  readonly code: "timeout" | "network";

  constructor(
    code: "timeout" | "network",
    providerKind: AiProvider["kind"],
    timeoutSeconds?: number,
  ) {
    const label = providerKind === "chat" ? "Chat" : "Embedding";
    super(
      code === "timeout"
        ? `${label} provider request timed out after ${timeoutSeconds ?? 0} seconds.`
        : `${label} provider network error.`,
    );
    this.name =
      code === "timeout" ? "AiProviderTimeoutError" : "AiProviderNetworkError";
    this.code = code;
  }
}

export class AiProviderOutputParseError extends Error {
  readonly code = "output_parse";

  constructor(message = "Invalid JSON in AI provider output.") {
    super(message);
    this.name = "AiProviderOutputParseError";
  }
}

export class AiProviderOutputSchemaError extends Error {
  readonly code = "output_schema";

  constructor(detail?: string) {
    super(
      detail
        ? `Model output schema validation failed: ${detail}`
        : "Model output schema validation failed.",
    );
    this.name = "AiProviderOutputSchemaError";
  }
}

export async function callChatJson(options: ChatJsonOptions) {
  return (await callChatJsonWithUsage(options)).data;
}

export async function callChatJsonWithUsage(
  options: ChatJsonOptions,
): Promise<ChatJsonResult> {
  assertProviderReady(options.provider, "chat");
  const body: Record<string, unknown> = {
    model: options.provider.model,
    messages: options.messages,
    response_format: { type: "json_object" },
  };
  const reasoningEffort = options.provider.reasoningEffort;
  if (reasoningEffort && reasoningEffort !== "default") {
    body.reasoning_effort = reasoningEffort;
  } else {
    body.temperature = options.temperature ?? 0.2;
  }

  const response = await fetchWithTimeout(
    `${trimSlash(options.provider.baseUrl)}/chat/completions`,
    {
      method: "POST",
      headers: buildHeaders(options.provider),
      body: JSON.stringify(body),
    },
    options.provider,
  );

  await throwForProviderResponse(response, options.provider);
  const data = await parseResponseJson(response);
  const content = readChatContent(data);
  if (typeof content !== "string") {
    throw new AiProviderOutputSchemaError(
      "choices[0].message.content must be a string",
    );
  }

  try {
    return {
      data: JSON.parse(content) as unknown,
      usage: normalizeUsage(readRecord(data)?.usage),
    };
  } catch {
    throw new AiProviderOutputParseError();
  }
}

export async function callEmbedding(
  provider: AiProvider,
  input: string | string[],
) {
  assertProviderReady(provider, "embedding");
  const response = await fetchWithTimeout(
    `${trimSlash(provider.baseUrl)}/embeddings`,
    {
      method: "POST",
      headers: buildHeaders(provider),
      body: JSON.stringify({
        model: provider.model,
        input,
      }),
    },
    provider,
  );

  await throwForProviderResponse(response, provider);
  const data = readRecord(await parseResponseJson(response));
  const items = data?.data;
  if (!Array.isArray(items)) {
    throw new AiProviderOutputSchemaError("data must be an array");
  }

  return items.map((item, index) => {
    const embedding = readRecord(item)?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      !embedding.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      throw new AiProviderOutputSchemaError(
        `data[${index}].embedding must be a numeric array`,
      );
    }
    return embedding as number[];
  });
}

export async function testProvider(provider: AiProvider) {
  const apiKeyPresent = Boolean(process.env[provider.apiKeyEnv]);
  if (!provider.enabled || !apiKeyPresent) {
    return {
      ready: false,
      checked: false,
      reason: provider.enabled ? "api_key_missing" : "provider_disabled",
    };
  }

  if (provider.kind === "chat") {
    await callChatJson({
      provider,
      messages: [
        {
          role: "system",
          content: "只返回 JSON。",
        },
        {
          role: "user",
          content: '{"ok":true}',
        },
      ],
      temperature: 0,
    });
  } else {
    await callEmbedding(provider, "fetchGithub provider test");
  }

  return {
    ready: true,
    checked: true,
  };
}

function assertProviderReady(provider: AiProvider, kind: AiProvider["kind"]) {
  if (provider.kind !== kind) {
    throw new AiProviderConfigurationError(
      `expected ${kind} provider, got ${provider.kind}`,
    );
  }

  if (!provider.enabled) {
    throw new AiProviderConfigurationError("provider is disabled");
  }

  if (!process.env[provider.apiKeyEnv]) {
    throw new AiProviderConfigurationError(
      `Missing API key env: ${provider.apiKeyEnv}`,
    );
  }
}

function buildHeaders(provider: AiProvider) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env[provider.apiKeyEnv]}`,
  };
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeUsage(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  provider: AiProvider,
) {
  const timeoutSeconds =
    provider.timeoutSeconds ?? (provider.kind === "chat" ? 60 : 30);
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new AiProviderTransportError(
        "timeout",
        provider.kind,
        timeoutSeconds,
      );
    }
    throw new AiProviderTransportError("network", provider.kind);
  } finally {
    clearTimeout(timeout);
  }
}

async function throwForProviderResponse(
  response: Response,
  provider: AiProvider,
) {
  if (response.ok) return;

  const responseSummary = await readSafeResponseSummary(
    response,
    process.env[provider.apiKeyEnv],
  );
  throw new AiProviderHttpError({
    providerKind: provider.kind,
    status: response.status,
    retryAfter: response.headers.get("retry-after") ?? undefined,
    responseSummary,
  });
}

async function parseResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AiProviderOutputParseError(
      "Invalid JSON in AI provider response envelope.",
    );
  }
}

function readChatContent(value: unknown): unknown {
  const choices = readRecord(value)?.choices;
  if (!Array.isArray(choices)) return undefined;
  return readRecord(readRecord(choices[0])?.message)?.content;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readSafeResponseSummary(response: Response, apiKey?: string) {
  try {
    const text = await readLimitedResponseText(response, 4_096);
    return (
      sanitizeProviderText(extractProviderErrorText(text), apiKey).slice(
        0,
        500,
      ) || undefined
    );
  } catch {
    return undefined;
  }
}

function sanitizeProviderText(value: string, apiKey?: string) {
  let sanitized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (apiKey) {
    sanitized = sanitized.replace(
      new RegExp(escapeRegExp(apiKey), "g"),
      "[REDACTED]",
    );
  }

  return sanitized
    .replace(/\bBearer\s+[^\s"',;}\]]+/gi, "[REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    );
}

function extractProviderErrorText(value: string) {
  try {
    const body = readRecord(JSON.parse(value));
    if (!body) return "";

    const error = body.error;
    if (typeof error === "string") return error;
    const errorRecord = readRecord(error);
    const candidates = errorRecord
      ? [errorRecord.code, errorRecord.type, errorRecord.message]
      : [body.code, body.type, body.message];
    return candidates
      .filter(
        (item): item is string | number =>
          typeof item === "string" || typeof item === "number",
      )
      .map(String)
      .join(" ");
  } catch {
    return value;
  }
}

async function readLimitedResponseText(response: Response, maxBytes: number) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  let completed = false;
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }

      const remaining = maxBytes - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: true });
      bytesRead += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
    text += decoder.decode();
    return text;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRetryAfterSeconds(value?: string): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
