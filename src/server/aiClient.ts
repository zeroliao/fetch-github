import type { AiProvider } from "@/lib/types";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { URL } from "node:url";

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
  if (
    reasoningEffort &&
    reasoningEffort !== "default" &&
    reasoningEffort !== "none"
  ) {
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

  const parsedContent = extractJsonContent(content);
  if (parsedContent === undefined) {
    throw new AiProviderOutputParseError();
  }

  return {
    data: parsedContent,
    usage: normalizeUsage(readRecord(data)?.usage),
  };
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

async function legacyTestProvider(provider: AiProvider) {
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

export async function testProvider(provider: AiProvider) {
  const { probeAiProvider } = await import("./aiProviderProbe");
  return probeAiProvider(provider);
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
  if (provider.groupEnabled === false) {
    throw new AiProviderConfigurationError("provider group is disabled");
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
    const proxyUrl = provider.proxyUrlEnv
      ? process.env[provider.proxyUrlEnv]
      : undefined;
    if (proxyUrl) {
      return await requestViaProxy(url, init, proxyUrl, timeoutMs);
    }
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof AiProviderConfigurationError) throw error;
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

async function requestViaProxy(
  targetUrl: string,
  init: RequestInit,
  proxyUrl: string,
  timeoutMs: number,
): Promise<Response> {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(proxy.protocol)) {
    throw new AiProviderConfigurationError(
      "出口代理仅支持 http、https、socks5 或 socks5h。",
    );
  }
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body =
    typeof init.body === "string" ? Buffer.from(init.body) : undefined;
  let socket = proxy.protocol.startsWith("socks5")
    ? await connectSocks5(proxy, target, timeoutMs)
    : await connectHttpProxy(proxy, target, timeoutMs);
  if (target.protocol === "https:") {
    socket = await secureSocket(socket, target.hostname, timeoutMs);
  }
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  const response = await new Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }>((resolve, reject) => {
    const request = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers,
        agent: false,
        createConnection: () => socket,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 502,
            headers: Object.fromEntries(
              Object.entries(incoming.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(", ") : String(value ?? ""),
              ]),
            ),
            body: Buffer.concat(chunks),
          }),
        );
        incoming.on("error", reject);
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error("ETIMEDOUT")),
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
  return new Response(new Uint8Array(response.body), {
    status: response.status,
    headers: response.headers,
  });
}

async function connectHttpProxy(
  proxy: URL,
  target: URL,
  timeoutMs: number,
): Promise<Socket> {
  const socket = await openSocket(
    proxy.hostname,
    Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
    timeoutMs,
    proxy.protocol === "https:",
  );
  await new Promise<void>((resolve, reject) => {
    const lines = [
      `CONNECT ${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)} HTTP/1.1`,
      `Host: ${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)}`,
    ];
    if (proxy.username || proxy.password)
      lines.push(
        `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
      );
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("latin1");
      if (!data.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const status = Number(data.split("\r\n", 1)[0]?.split(" ")[1]);
      if (status >= 200 && status < 300) resolve();
      else
        reject(
          new Error(
            `HTTP proxy CONNECT failed with ${status || "unknown status"}`,
          ),
        );
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
  return socket;
}

async function connectSocks5(
  proxy: URL,
  target: URL,
  timeoutMs: number,
): Promise<Socket> {
  const socket = await openSocket(
    proxy.hostname,
    Number(proxy.port || 1080),
    timeoutMs,
    false,
  );
  const username = proxy.username
    ? Buffer.from(decodeURIComponent(proxy.username))
    : undefined;
  const password = proxy.password
    ? Buffer.from(decodeURIComponent(proxy.password))
    : undefined;
  await writeAndRead(socket, Buffer.from([5, 1, username ? 2 : 0]), 2);
  if (username && password) {
    const auth = Buffer.concat([
      Buffer.from([1, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]);
    await writeAndRead(socket, auth, 2);
  }
  const host = Buffer.from(target.hostname);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const connect = Buffer.concat([
    Buffer.from([5, 1, 0, 3, host.length]),
    host,
    Buffer.from([port >> 8, port & 255]),
  ]);
  const reply = await writeAndRead(socket, connect, 4);
  if (reply[1] !== 0)
    throw new Error(`SOCKS5 proxy CONNECT failed with ${reply[1]}`);
  return socket;
}

async function openSocket(
  hostname: string,
  port: number,
  timeoutMs: number,
  tls: boolean,
): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = (
      tls
        ? tlsConnect({ host: hostname, port, servername: hostname })
        : netConnect({ host: hostname, port })
    ) as Socket;
    const timer = setTimeout(
      () => socket.destroy(new Error("ETIMEDOUT")),
      timeoutMs,
    );
    if (tls)
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
    else
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function secureSocket(
  socket: Socket,
  servername: string,
  timeoutMs: number,
): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername }) as Socket;
    const timer = setTimeout(
      () => secure.destroy(new Error("ETIMEDOUT")),
      timeoutMs,
    );
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function writeAndRead(
  socket: Socket,
  payload: Buffer,
  bytes: number,
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= bytes) {
        socket.off("data", onData);
        resolve(Buffer.concat(chunks).subarray(0, size));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(payload);
  });
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

/**
 * OpenAI-compatible gateways sometimes prepend a short explanation or wrap
 * JSON in a markdown fence despite response_format=json_object. Accept only
 * a complete JSON value, never arbitrary text, before schema validation.
 */
function extractJsonContent(content: string): unknown | undefined {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Continue with balanced-object extraction below.
  }

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (unfenced !== trimmed) {
    try {
      return JSON.parse(unfenced) as unknown;
    } catch {
      // Continue with balanced-object extraction below.
    }
  }

  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}" && --depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1)) as unknown;
        } catch {
          break;
        }
      }
    }
  }

  return undefined;
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
