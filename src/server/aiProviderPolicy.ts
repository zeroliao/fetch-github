import type {
  AiProvider,
  AiProviderFailureCode,
  ProviderAvailabilityStatus,
  ProviderKind,
} from "@/lib/types";

export type AiFailureCode = AiProviderFailureCode;

export interface AiProviderFailureClassification {
  code: AiFailureCode;
  parseFailure: boolean;
  retryable: boolean;
  targetAvailabilityStatus?: ProviderAvailabilityStatus;
  cooldownSeconds?: number;
  reason: string;
  recoverySuggestion: string;
}

const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 60;
const DEFAULT_TRANSIENT_COOLDOWN_SECONDS = 30;
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;

function classifyDefaultAiProviderFailure(
  error: unknown,
): AiProviderFailureClassification {
  const raw = collectErrorText(error);
  const status = extractHttpStatus(error, raw);

  if (status === 401 || isAuthenticationFailure(raw) || isMissingApiKey(raw)) {
    return classification({
      code: "auth",
      targetAvailabilityStatus: "blocked_auth",
      reason: "AI provider 认证失败，当前凭据无效或已失效。",
      recoverySuggestion: "请更新 API Key，并执行“检测并恢复”。",
    });
  }

  if (status === 403 || isPermissionFailure(raw)) {
    return classification({
      code: "permission",
      targetAvailabilityStatus: "blocked_permission",
      reason: "当前账号没有调用该模型或资源的权限。",
      recoverySuggestion:
        "请检查账号权限、区域和模型访问资格，然后执行“检测并恢复”。",
    });
  }

  if (status === 429 || isRateLimitFailure(raw)) {
    return classification({
      code: "rate_limit",
      retryable: true,
      targetAvailabilityStatus: "cooldown",
      cooldownSeconds:
        extractRetryAfterSeconds(error) ?? DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS,
      reason: "AI provider 当前已限流或配额暂时不可用。",
      recoverySuggestion:
        "系统将在冷却期结束后自动重试；也可以检查额度和请求频率。",
    });
  }

  if (status === 400 || isInvalidConfigurationFailure(raw)) {
    return classification({
      code: "invalid_config",
      targetAvailabilityStatus: "invalid_config",
      reason: "AI provider 配置或请求参数不受当前模型支持。",
      recoverySuggestion:
        "请检查 Base URL、模型名、推理程度、dimensions 和请求格式，然后执行“检测并恢复”。",
    });
  }

  if (status !== undefined && status >= 500 && status <= 599) {
    return transientClassification(
      "server",
      "AI provider 服务暂时不可用。",
      "系统将进行有限重试并在冷却后自动恢复。",
    );
  }

  if (isOutputSchemaFailure(raw)) {
    return classification({
      code: "output_schema",
      parseFailure: true,
      retryable: true,
      reason: "模型输出未通过结构化数据校验。",
      recoverySuggestion:
        "系统将按解析失败阈值重试，并在达到阈值后轮换同类型模型。",
    });
  }

  if (isOutputParseFailure(error, raw)) {
    return classification({
      code: "output_parse",
      parseFailure: true,
      retryable: true,
      reason: "模型输出不是有效的结构化数据。",
      recoverySuggestion:
        "系统将按解析失败阈值重试，并在达到阈值后轮换同类型模型。",
    });
  }

  if (isTimeoutFailure(error, raw)) {
    return transientClassification(
      "timeout",
      "AI provider 请求超时。",
      "系统将进行有限重试并在冷却后自动恢复；请检查超时设置和服务响应时间。",
    );
  }

  if (isNetworkFailure(raw)) {
    return transientClassification(
      "network",
      "无法连接到 AI provider。",
      "系统将进行有限重试并在冷却后自动恢复；请检查 DNS、网络和 Base URL。",
    );
  }

  return classification({
    code: "unknown",
    reason: "AI provider 返回了未识别的错误。",
    recoverySuggestion: "请查看已脱敏的服务端日志，确认原因后重新测试该模型。",
  });
}

export function classifyAiProviderFailure(
  error: unknown,
  provider?: Pick<AiProvider, "cooldownOn" | "cooldownSeconds">,
): AiProviderFailureClassification {
  const base = classifyDefaultAiProviderFailure(error);
  if (!provider?.cooldownOn) return base;

  const cooldownOn = new Set(provider.cooldownOn);
  if (cooldownOn.has(base.code)) {
    return {
      ...base,
      retryable: true,
      targetAvailabilityStatus: "cooldown",
      cooldownSeconds:
        provider.cooldownSeconds ??
        base.cooldownSeconds ??
        DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
    };
  }

  return {
    ...base,
    retryable: false,
    targetAvailabilityStatus: "error",
    cooldownSeconds: undefined,
  };
}

export function orderEligibleProviders(
  providers: readonly AiProvider[],
  kind: ProviderKind,
  excludedIds: Iterable<string> = [],
  now: Date | string | number = new Date(),
): AiProvider[] {
  const excluded = new Set(excludedIds);
  const nowMs = toEpoch(now);

  return providers
    .filter((provider) => {
      if (
        provider.kind !== kind ||
        !provider.enabled ||
        provider.groupEnabled === false ||
        provider.archivedAt ||
        excluded.has(provider.id)
      ) {
        return false;
      }

      if (provider.availabilityStatus === "available") {
        return true;
      }

      return false;
    })
    .sort((left, right) => {
      const priorityDifference =
        safePriority(left.priority) - safePriority(right.priority);
      if (priorityDifference !== 0) return priorityDifference;

      const createdAtDifference =
        sortableEpoch(left.createdAt) - sortableEpoch(right.createdAt);
      if (createdAtDifference !== 0) return createdAtDifference;

      return left.id.localeCompare(right.id);
    });
}

export function isManualRecoveryStatus(
  status: ProviderAvailabilityStatus,
): boolean {
  return (
    status === "error" ||
    status === "blocked_auth" ||
    status === "blocked_permission" ||
    status === "invalid_config"
  );
}

export function providerNeedsManualRecovery(
  provider: Pick<AiProvider, "availabilityStatus">,
): boolean {
  return isManualRecoveryStatus(provider.availabilityStatus);
}

function classification(
  input: Omit<AiProviderFailureClassification, "parseFailure" | "retryable"> &
    Partial<
      Pick<AiProviderFailureClassification, "parseFailure" | "retryable">
    >,
): AiProviderFailureClassification {
  return {
    parseFailure: false,
    retryable: false,
    ...input,
  };
}

function transientClassification(
  code: Extract<AiFailureCode, "timeout" | "server" | "network">,
  reason: string,
  recoverySuggestion: string,
): AiProviderFailureClassification {
  return classification({
    code,
    retryable: true,
    targetAvailabilityStatus: "cooldown",
    cooldownSeconds: DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
    reason,
    recoverySuggestion,
  });
}

function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object" || visited.has(value)) return;

    visited.add(value);
    const record = value as Record<string, unknown>;
    for (const key of [
      "name",
      "message",
      "code",
      "type",
      "error",
      "cause",
      "body",
      "data",
      "response",
    ]) {
      visit(record[key], depth + 1);
    }
  };

  visit(error, 0);
  if (parts.length === 0) parts.push(String(error));
  return parts.join(" ").slice(0, 8_000);
}

function extractHttpStatus(error: unknown, raw: string): number | undefined {
  const direct =
    readNumericField(error, "status") ?? readNumericField(error, "statusCode");
  if (direct !== undefined) return direct;

  if (isRecord(error)) {
    const response = error.response;
    const nested =
      readNumericField(response, "status") ??
      readNumericField(response, "statusCode");
    if (nested !== undefined) return nested;
  }

  const match = raw.match(
    /(?:http(?:\s+status)?|status(?:\s+code)?|provider\s+failed)\s*[:=]?\s*(\d{3})\b/i,
  );
  if (match) return Number(match[1]);

  const namedStatus = raw.match(
    /\b(400|401|403|429|5\d{2})\b\s*(?:bad request|unauthorized|forbidden|too many requests|server error)?/i,
  );
  return namedStatus ? Number(namedStatus[1]) : undefined;
}

function extractRetryAfterSeconds(error: unknown): number | undefined {
  const headerSources: unknown[] = [];
  if (isRecord(error)) {
    headerSources.push(error.headers);
    if (isRecord(error.response)) headerSources.push(error.response.headers);
  }

  for (const headers of headerSources) {
    const value = readHeader(headers, "retry-after");
    if (value === undefined) continue;

    const seconds = Number(value);
    if (Number.isFinite(seconds)) return clampCooldown(seconds);

    const retryAt = Date.parse(value);
    if (Number.isFinite(retryAt)) {
      return clampCooldown(Math.ceil((retryAt - Date.now()) / 1_000));
    }
  }

  return undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return typeof value === "string" ? value : undefined;
  }

  const record = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (
      key.toLowerCase() === name &&
      (typeof value === "string" || typeof value === "number")
    ) {
      return String(value);
    }
  }
  return undefined;
}

function clampCooldown(seconds: number): number {
  return Math.min(MAX_COOLDOWN_SECONDS, Math.max(1, Math.ceil(seconds)));
}

function isAuthenticationFailure(raw: string): boolean {
  return /invalid[_ -]?api[_ -]?key|incorrect api key|authentication failed|unauthorized/i.test(
    raw,
  );
}

function isMissingApiKey(raw: string): boolean {
  return /missing api key env|api[_ -]?key[^\n]*(?:missing|not configured|not set)|(?:missing|required)[^\n]*(?:api[_ -]?key|environment variable)/i.test(
    raw,
  );
}

function isPermissionFailure(raw: string): boolean {
  return /permission[_ -]?denied|access denied|does not have access|not allowed to use|forbidden/i.test(
    raw,
  );
}

function isRateLimitFailure(raw: string): boolean {
  return /rate[_ -]?limit|too many requests|quota (?:exceeded|temporarily unavailable)/i.test(
    raw,
  );
}

function isInvalidConfigurationFailure(raw: string): boolean {
  return /unsupported (?:parameter|model)|model[_ -]?not[_ -]?found|invalid (?:model|base url|request parameter)/i.test(
    raw,
  );
}

function isOutputSchemaFailure(raw: string): boolean {
  return /zoderror|schema (?:validation )?(?:failed|error)|failed (?:json )?schema|does not match (?:the )?schema|structured output[^\n]*(?:schema|validation)|required field[^\n]*(?:missing|invalid)|模型没有返回可用内容/i.test(
    raw,
  );
}

function isOutputParseFailure(error: unknown, raw: string): boolean {
  return (
    error instanceof SyntaxError ||
    /json(?:\.parse| parse| parsing)[^\n]*(?:failed|error|unexpected|invalid)|invalid json|unexpected (?:token|end of json input)|failed to parse (?:model|structured|json) output/i.test(
      raw,
    )
  );
}

function isTimeoutFailure(error: unknown, raw: string): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    /timed?\s*out|timeout|etimedout|aborterror|请求超过\s*\d+\s*秒未响应/i.test(
      raw,
    )
  );
}

function isNetworkFailure(raw: string): boolean {
  return /fetch failed|network error|econnreset|econnrefused|enotfound|eai_again|socket hang up|connection reset/i.test(
    raw,
  );
}

function readNumericField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  if (typeof candidate === "number" && Number.isInteger(candidate))
    return candidate;
  if (typeof candidate === "string" && /^\d{3}$/.test(candidate))
    return Number(candidate);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function safePriority(value: number): number {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function toEpoch(value: Date | string | number): number {
  const epoch =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : Date.now();
}

function sortableEpoch(value: string): number {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : Number.MAX_SAFE_INTEGER;
}

function isFiniteEpoch(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
