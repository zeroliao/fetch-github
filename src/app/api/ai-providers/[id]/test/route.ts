import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { probeAiProvider } from "@/server/aiProviderProbe";
import { classifyAiProviderFailure } from "@/server/aiProviderPolicy";
import { getAiProvider, updateAiProviderAvailability } from "@/server/store";

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

  let checkedProvider = provider;
  const test = await probeAiProvider(provider).catch(async (error) => {
    const failure = classifyAiProviderFailure(error, provider);
    checkedProvider =
      (await updateAiProviderAvailability(provider.id, {
        status: failure.targetAvailabilityStatus ?? "error",
        code: failure.code,
        reason: failure.reason,
        recoverySuggestion: failure.recoverySuggestion,
        cooldownUntil: failure.cooldownSeconds
          ? new Date(Date.now() + failure.cooldownSeconds * 1000).toISOString()
          : undefined,
      })) ?? provider;
    return {
      ready: false,
      checked: true,
      reason: failure.reason,
      recoverySuggestion: failure.recoverySuggestion,
    };
  });

  const updatedProvider = test.ready
    ? await updateAiProviderAvailability(provider.id, {
        status: "available",
        recovered: true,
      })
    : checkedProvider;

  return NextResponse.json({
    providerId: provider.id,
    kind: provider.kind,
    model: provider.model,
    ready: test.ready,
    provider: updatedProvider ?? provider,
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
