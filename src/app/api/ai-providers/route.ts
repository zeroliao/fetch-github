import { NextResponse } from "next/server";
import { providerSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { writeLocalEnvValue } from "@/server/envFile";
import { createAiProvider, listAiProviders } from "@/server/store";

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  return NextResponse.json(await listAiProviders());
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const parsed = providerSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  const { apiKeyValue, ...providerInput } = parsed.data;

  if (providerInput.kind === "embedding" && !providerInput.dimensions) {
    return NextResponse.json(
      { error: "Embedding 配置必须填写向量维度。" },
      { status: 400 }
    );
  }

  if (apiKeyValue) {
    try {
      await writeLocalEnvValue(providerInput.apiKeyEnv, apiKeyValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : "API Key 写入失败。";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  const provider = await createAiProvider(providerInput);
  return NextResponse.json(provider, { status: 201 });
}
