import { NextResponse } from "next/server";
import { providerGroupSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { writeLocalEnvValue } from "@/server/envFile";
import { providerNameToApiKeyEnv } from "@/server/providerApiKey";
import {
  deleteAiProviderGroup,
  listAiProviderGroups,
  updateAiProviderGroup,
} from "@/server/store";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const parsed = providerGroupSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { errors: parsed.error.flatten() },
      { status: 400 },
    );
  const { id } = await context.params;
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
  const current = (await listAiProviderGroups()).find(
    (group) => group.id === id,
  );
  if (!current)
    return NextResponse.json({ error: "Provider 不存在。" }, { status: 404 });
  if (current.apiKeyEnv !== apiKeyEnv && !apiKeyValue) {
    return NextResponse.json(
      {
        error:
          "修改 Provider 名称会改变 API Key 环境变量，请同时重新填写 API Key。",
      },
      { status: 400 },
    );
  }
  if (
    (await listAiProviderGroups()).some(
      (group) => group.id !== id && group.apiKeyEnv === apiKeyEnv,
    )
  ) {
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
    const group = await updateAiProviderGroup(id, { ...input, apiKeyEnv });
    return group
      ? NextResponse.json(group)
      : NextResponse.json({ error: "Provider 不存在。" }, { status: 404 });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505"
    )
      return NextResponse.json(
        { error: "Provider 名称对应的 API Key 环境变量已存在。" },
        { status: 409 },
      );
    return NextResponse.json({ error: "Provider 保存失败。" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const deleted = await deleteAiProviderGroup(id);
  return deleted
    ? NextResponse.json({ deleted: true })
    : NextResponse.json({ error: "Provider 不存在。" }, { status: 404 });
}
