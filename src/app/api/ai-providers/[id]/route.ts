import { NextResponse } from "next/server";
import { providerSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { writeLocalEnvValue } from "@/server/envFile";
import { deleteAiProvider, updateAiProvider } from "@/server/store";

const patchSchema = providerSchema.partial().omit({ kind: true, type: true });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const parsed = patchSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  const { apiKeyValue, ...providerPatch } = parsed.data;
  if (apiKeyValue && providerPatch.apiKeyEnv) {
    try {
      await writeLocalEnvValue(providerPatch.apiKeyEnv, apiKeyValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : "API Key 写入失败。";
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
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const result = await deleteAiProvider(id);

  if (!result.deleted) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  return NextResponse.json({ deleted: true });
}
