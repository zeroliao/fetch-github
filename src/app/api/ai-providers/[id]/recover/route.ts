import { NextResponse } from "next/server";
import { classifyAiProviderFailure } from "@/server/aiProviderPolicy";
import { probeAiProvider } from "@/server/aiProviderProbe";
import { requireAuth } from "@/server/auth";
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
  if (!provider.enabled) {
    return NextResponse.json(
      { error: "请先启用该 AI 配置，再执行检测恢复。" },
      { status: 409 },
    );
  }

  await updateAiProviderAvailability(id, { status: "recovering" });
  try {
    const result = await probeAiProvider(provider);
    if (!result.ready) {
      throw new Error(
        result.reason === "api_key_missing"
          ? "Missing API key environment variable."
          : "Provider is disabled.",
      );
    }

    const recovered = await updateAiProviderAvailability(id, {
      status: "available",
      recovered: true,
    });
    return NextResponse.json({
      provider: recovered,
      message: "检测通过，模型已恢复为可用状态。",
    });
  } catch (error) {
    const failure = classifyAiProviderFailure(error, provider);
    const cooldownUntil = failure.cooldownSeconds
      ? new Date(Date.now() + failure.cooldownSeconds * 1000).toISOString()
      : undefined;
    const failed = await updateAiProviderAvailability(id, {
      status: failure.targetAvailabilityStatus ?? "invalid_config",
      code: failure.code,
      reason: failure.reason,
      recoverySuggestion: failure.recoverySuggestion,
      cooldownUntil,
    });
    return NextResponse.json(
      {
        error: failure.reason,
        recoverySuggestion: failure.recoverySuggestion,
        provider: failed,
      },
      { status: 409 },
    );
  }
}
