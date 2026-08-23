import { NextResponse } from "next/server";
import { providerGroupSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { writeLocalEnvValue } from "@/server/envFile";
import { providerNameToApiKeyEnv } from "@/server/providerApiKey";
import { createAiProviderGroup, listAiProviderGroups } from "@/server/store";

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  return NextResponse.json(await listAiProviderGroups());
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const parsed = providerGroupSchema.safeParse(await request.json());
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
      { error: error instanceof Error ? error.message : "Provider 名称无效。" },
      { status: 400 },
    );
  }
  const existing = await listAiProviderGroups();
  if (existing.some((group) => group.apiKeyEnv === apiKeyEnv)) {
    return NextResponse.json(
      { error: "Provider 名称对应的 API Key 环境变量已存在。" },
      { status: 409 },
    );
  }
  if (apiKeyValue) {
    try {
      await writeLocalEnvValue(apiKeyEnv, apiKeyValue);
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "API Key 写入失败。",
        },
        { status: 400 },
      );
    }
  }
  try {
    const group = await createAiProviderGroup({ ...input, apiKeyEnv });
    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "PROVIDER_NAME_CONFLICT") {
      return NextResponse.json(
        { error: "Provider 名称对应的 API Key 环境变量已存在。" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Provider 保存失败。" }, { status: 500 });
  }
}
