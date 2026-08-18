import type { ScanFailureCode } from "@/lib/types";

export interface ScanFailure {
  code: ScanFailureCode;
  message: string;
  resolution: string;
}

export function classifyScanFailure(error: unknown): ScanFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = sanitizeFailureDetail(raw);

  if (isGithubAuthFailure(raw)) {
    return {
      code: "github_auth",
      message: "GitHub 认证失败：服务器上的 GitHub token 无效、过期或已撤销。",
      resolution:
        "请更新服务器配置中的 GITHUB_TOKEN，重启 fetchgithub-worker.service，然后恢复或重新发起扫描。",
    };
  }

  if (isGithubRateLimitFailure(raw)) {
    return {
      code: "github_rate_limit",
      message: "GitHub API 已触发限流，当前扫描无法继续请求仓库数据。",
      resolution:
        "请等待 GitHub 限流窗口恢复；同时确认使用有效 token 以获得更高配额，之后点击恢复扫描。",
    };
  }

  if (isGithubForbiddenFailure(raw)) {
    return {
      code: "github_forbidden",
      message: "GitHub 拒绝了当前请求，token 权限或资源访问范围不足。",
      resolution:
        "请检查 GitHub token 的 resource owner、仓库访问范围和 Metadata 读取权限，然后更新 token 并恢复扫描。",
    };
  }

  if (isTimeoutFailure(raw)) {
    return {
      code: raw.includes("GitHub") ? "github_timeout" : "ai_timeout",
      message: `${raw.includes("GitHub") ? "GitHub" : "外部 provider"} 请求超时，扫描暂时无法继续。`,
      resolution:
        "请检查服务器到外部服务的网络连通性和 provider 地址；确认服务恢复后再重试，避免连续点击启动。",
    };
  }

  if (isAiAuthFailure(raw)) {
    return {
      code: "ai_auth",
      message: `AI provider 认证失败：${detail}`,
      resolution:
        "请在 AI Providers 中检查 API key 环境变量名和密钥有效性，保存后再恢复扫描。",
    };
  }

  if (isAiRateLimitFailure(raw)) {
    return {
      code: "ai_rate_limit",
      message: `AI provider 触发限流：${detail}`,
      resolution:
        "请等待限流窗口恢复，或降低并发/请求频率并确认 provider 配额，然后恢复扫描。",
    };
  }

  if (isAiInvalidRequestFailure(raw)) {
    return {
      code: "ai_invalid_request",
      message: `AI provider 请求参数无效：${detail}`,
      resolution:
        "请检查 provider 的 Base URL、模型名、Embedding dimensions 和请求格式，保存配置后再恢复扫描。",
    };
  }

  if (isDatabaseFailure(raw)) {
    return {
      code: "database_unavailable",
      message: "扫描状态无法写入数据库，任务进度可能未被保存。",
      resolution:
        "请检查 PostgreSQL 服务、DATABASE_URL 和数据库连接数；确认数据库恢复后再检查任务状态并恢复扫描。",
    };
  }

  if (isNetworkFailure(raw)) {
    return {
      code: raw.includes("GitHub") ? "github_network" : "ai_network",
      message: `${raw.includes("GitHub") ? "GitHub" : "外部 provider"} 网络请求失败：${detail}`,
      resolution:
        "请检查服务器 DNS、出口网络、代理和 provider 地址；确认网络恢复后再恢复扫描。",
    };
  }

  return {
    code: "unknown",
    message: `扫描失败：${detail}`,
    resolution:
      "请先查看 worker 日志中的同一时间点错误；修复对应依赖或配置后，再恢复扫描。",
  };
}

function isGithubAuthFailure(raw: string) {
  return /GitHub[^\n]*(401|Bad credentials)|GitHub user lookup failed:\s*401/i.test(
    raw,
  );
}

function isGithubRateLimitFailure(raw: string) {
  return /GitHub[^\n]*(429|rate limit exceeded)|API rate limit exceeded/i.test(
    raw,
  );
}

function isGithubForbiddenFailure(raw: string) {
  return /GitHub[^\n]*\b403\b/i.test(raw) && !/rate limit/i.test(raw);
}

function isAiAuthFailure(raw: string) {
  return /(Chat|Embedding) provider failed:\s*401|INVALID_API_KEY|invalid api key/i.test(
    raw,
  );
}

function isAiRateLimitFailure(raw: string) {
  return /(Chat|Embedding) provider failed:\s*(429|503)|rate limit|No available accounts/i.test(
    raw,
  );
}

function isAiInvalidRequestFailure(raw: string) {
  return /(Chat|Embedding) provider failed:\s*400\b/i.test(raw);
}

function isTimeoutFailure(raw: string) {
  return /请求超过 \d+ 秒未响应|timed? ?out|ETIMEDOUT|AbortError/i.test(raw);
}

function isNetworkFailure(raw: string) {
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network error/i.test(
    raw,
  );
}

function isDatabaseFailure(raw: string) {
  return /postgres|database|connection terminated unexpectedly|too many clients/i.test(
    raw,
  );
}

function sanitizeFailureDetail(raw: string) {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /(?:github_pat|ghp|gho|ghs|ghu|sk-[A-Za-z0-9_-]+)[A-Za-z0-9_-]*/gi,
      "[REDACTED]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}
