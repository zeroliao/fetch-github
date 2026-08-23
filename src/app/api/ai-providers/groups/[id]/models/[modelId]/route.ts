import { NextResponse } from "next/server";
import { providerModelSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import {
  deleteAiProviderModel,
  listAiProviderGroups,
  updateAiProviderModel,
} from "@/server/store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; modelId: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const { id, modelId } = await context.params;
  const group = (await listAiProviderGroups()).find((item) => item.id === id);
  const model = group?.models.find((item) => item.id === modelId);
  return model
    ? NextResponse.json(model)
    : NextResponse.json({ error: "Model not found" }, { status: 404 });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; modelId: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const parsed = providerModelSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { errors: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { id, modelId } = await context.params;
  const model = await updateAiProviderModel(id, modelId, {
    ...parsed.data,
    id: modelId,
  });
  return model
    ? NextResponse.json(model)
    : NextResponse.json({ error: "Model not found" }, { status: 404 });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; modelId: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const { id, modelId } = await context.params;
  const result = await deleteAiProviderModel(id, modelId);
  return result.deleted
    ? NextResponse.json(result)
    : NextResponse.json({ error: result.reason }, { status: 409 });
}
