import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { listProxyEnvEntries } from "@/server/envFile";
import { listAiProviders } from "@/server/store";
import { requestViaProxy } from "@/server/aiClient";

const payloadSchema = z.object({
  proxyEnv: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
  providerId: z.string().min(1),
});

function maskProxyValue(value: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "配置格式无效";
  }
}

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const entries = await listProxyEnvEntries();
  const providers = (await listAiProviders()).filter(
    (provider) => provider.enabled && provider.groupEnabled !== false,
  );
  return NextResponse.json(
    entries.map((entry) => ({
      name: entry.name,
      host: entry.host,
      port: entry.port,
      protocol: entry.protocol,
      address: maskProxyValue(entry.value),
      providers: providers
        .filter((provider) => provider.proxyUrlEnv === entry.name)
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          model: provider.model,
        })),
    })),
  );
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const parsed = payloadSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success)
    return NextResponse.json({ error: "代理环境变量名无效" }, { status: 400 });

  const entries = await listProxyEnvEntries();
  const selectedEntries = parsed.data.proxyEnv
    ? entries.filter((item) => item.name === parsed.data.proxyEnv)
    : entries;
  if (selectedEntries.length === 0)
    return NextResponse.json({ error: "代理环境变量不存在" }, { status: 404 });
  const providers = (await listAiProviders()).filter(
    (item) =>
      item.enabled &&
      item.groupEnabled !== false &&
      item.id === parsed.data.providerId,
  );
  if (providers.length === 0) {
    return NextResponse.json(
      { error: "代理未绑定到指定 Provider" },
      { status: 400 },
    );
  }
  const results = [];
  const provider = providers[0];
  for (const entry of selectedEntries) {
    const startedAt = Date.now();
    let connected = false;
    let statusCode: number | undefined;
    let error: string | undefined;
    try {
      const target = new URL(provider.baseUrl);
      target.pathname = "/";
      target.search = "";
      const response = await requestViaProxy(
        target.toString(),
        { method: "GET" },
        entry.value,
        Math.min(10, provider.timeoutSeconds ?? 10) * 1000,
      );
      statusCode = response.status;
      connected = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "网络连接失败";
    }
    results.push({
      proxyEnv: entry.name,
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
      connected,
      statusCode,
      elapsedMs: Date.now() - startedAt,
      error,
    });
  }
  return NextResponse.json({
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.baseUrl,
    results,
  });
}
