import { NextResponse } from "next/server";
import { providerSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { writeLocalEnvValue } from "@/server/envFile";
import { providerNameToApiKeyEnv } from "@/server/providerApiKey";
import {
  deleteAiProvider,
  getAiProvider,
  listAiProviders,
  updateAiProvider,
} from "@/server/store";

const patchSchema = providerSchema.partial().omit({ kind: true, type: true });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const payload = await request.json();
  const parsed = patchSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { errors: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { apiKeyValue, ...providerPatch } = parsed.data;
  for (const field of [
    "priority",
    "enabled",
    "cooldownSeconds",
    "cooldownOn",
  ] as const) {
    if (!(field in payload)) {
      delete providerPatch[field];
    }
  }
  const currentProvider = await getAiProvider(id);
  if (!currentProvider) {
    return NextResponse.json({ error: "AI 配置不存在。" }, { status: 404 });
  }

  const nextName = providerPatch.name ?? currentProvider.name;
  let nextApiKeyEnv: string;
  try {
    nextApiKeyEnv = providerNameToApiKeyEnv(nextName);
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
  const providers = await listAiProviders();
  if (
    providers.some(
      (provider) => provider.id !== id && provider.apiKeyEnv === nextApiKeyEnv,
    )
  ) {
    return NextResponse.json(
      { error: "模型名称对应的 API Key 名称已存在，请使用不同名称。" },
      { status: 409 },
    );
  }
  if (nextName !== currentProvider.name && !apiKeyValue) {
    return NextResponse.json(
      {
        error:
          "修改模型名称会改变 API Key 名称，请同时重新填写该模型的 API Key。",
      },
      { status: 400 },
    );
  }

  providerPatch.apiKeyEnv = nextApiKeyEnv;
  if (apiKeyValue) {
    try {
      await writeLocalEnvValue(nextApiKeyEnv, apiKeyValue);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "API Key 写入失败。";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  const result = await updateAiProvider(id, providerPatch);
  if (result.reason) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }
  if (!result.provider) {
    return NextResponse.json({ error: "AI 配置不存在。" }, { status: 404 });
  }

  return NextResponse.json(result.provider);
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  let result: Awaited<ReturnType<typeof deleteAiProvider>>;
  try {
    result = await deleteAiProvider(id);
  } catch (error) {
    console.error("ai_provider_delete_failed", {
      providerId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "AI 配置删除失败，请稍后重试。" },
      { status: 500 },
    );
  }

  if (!result.deleted) {
    return NextResponse.json(
      { error: result.reason ?? "AI 配置删除失败。" },
      { status: 409 },
    );
  }

  return NextResponse.json({ deleted: true });
}
