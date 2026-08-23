import { requestViaProxy } from "./aiClient";

export function resolveConfiguredProxyURL() {
  const direct = process.env.FETCHGITHUB_PROXY_URL?.trim();
  if (direct) return direct;

  const envName =
    process.env.FETCHGITHUB_PROXY_URL_ENV?.trim() ||
    process.env.GITHUB_PROXY_URL_ENV?.trim();
  if (envName) {
    const value = process.env[envName]?.trim();
    if (value) return value;
  }

  return process.env.SUB2API_PROXY_URL?.trim() || process.env.GITHUB_PROXY_URL?.trim();
}

export async function fetchConfiguredOutbound(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
) {
  const proxyURL = resolveConfiguredProxyURL();
  if (proxyURL) {
    return requestViaProxy(String(input), init, proxyURL, timeoutMs);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
