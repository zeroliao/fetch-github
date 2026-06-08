import { NextResponse } from "next/server";
import { testProvider } from "@/server/aiClient";
import { getAiProvider } from "@/server/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const provider = await getAiProvider(id);

  if (!provider) {
    return NextResponse.json({ error: "Provider not found." }, { status: 404 });
  }

  const test = await testProvider(provider).catch((error) => ({
    ready: false,
    checked: true,
    reason: error instanceof Error ? error.message : String(error)
  }));

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
      reason: "reason" in test ? test.reason : undefined
    }
  });
}
