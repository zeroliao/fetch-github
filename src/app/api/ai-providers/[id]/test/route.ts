import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { testProvider } from "@/server/aiClient";
import { classifyAiProviderFailure } from "@/server/aiProviderPolicy";
import { getAiProvider } from "@/server/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const provider = await getAiProvider(id);

  if (!provider) {
    return NextResponse.json({ error: "AI 配置不存在。" }, { status: 404 });
  }

  const test = await testProvider(provider).catch((error) => {
    const failure = classifyAiProviderFailure(error);
    return {
      ready: false,
      checked: true,
      reason: failure.reason,
      recoverySuggestion: failure.recoverySuggestion,
    };
  });

  return NextResponse.json({
    providerId: provider.id,
    kind: provider.kind,
    model: provider.model,
    ready: test.ready,
    checks: {
      enabled: provider.enabled,
      apiKeyEnv: provider.apiKeyEnv,
      apiKeyPresent: Boolean(process.env[provider.apiKeyEnv]),
      checked: test.checked,
      reason: "reason" in test ? test.reason : undefined,
      recoverySuggestion:
        "recoverySuggestion" in test ? test.recoverySuggestion : undefined,
    },
  });
}
