import { NextResponse } from "next/server";
import { providerSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { writeLocalEnvValue } from "@/server/envFile";
import { providerNameToApiKeyEnv } from "@/server/providerApiKey";
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
    return NextResponse.json(
      { errors: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { apiKeyValue, ...input } = parsed.data;
  let apiKeyEnv: string;
  try {
    apiKeyEnv = providerNameToApiKeyEnv(input.name);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "模型名称必须可转换为 API Key 环境变量名。",
      },
      { status: 400 },
    );
  }

  const providerInput = {
    ...input,
    apiKeyEnv,
  };

  const existing = await listAiProviders();
  if (
    existing.some((provider) => provider.apiKeyEnv === providerInput.apiKeyEnv)
  ) {
    return NextResponse.json(
      { error: "模型名称对应的 API Key 名称已存在，请使用不同名称。" },
      { status: 409 },
    );
  }

  if (providerInput.kind === "embedding" && !providerInput.dimensions) {
    return NextResponse.json(
      { error: "Embedding 配置必须填写向量维度。" },
      { status: 400 },
    );
  }

  if (apiKeyValue) {
    try {
      await writeLocalEnvValue(providerInput.apiKeyEnv, apiKeyValue);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "API Key 写入失败。";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  const provider = await createAiProvider(providerInput);
  return NextResponse.json(provider, { status: 201 });
}
