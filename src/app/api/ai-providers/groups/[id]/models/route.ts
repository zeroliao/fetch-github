import { NextResponse } from "next/server";
import { providerModelSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { createAiProviderModel, listAiProviderGroups } from "@/server/store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const group = (await listAiProviderGroups()).find((item) => item.id === id);
  return group
    ? NextResponse.json(group.models)
    : NextResponse.json({ error: "Provider not found" }, { status: 404 });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
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
  const { id } = await context.params;
  const model = await createAiProviderModel(id, parsed.data);
  return model
    ? NextResponse.json(model, { status: 201 })
    : NextResponse.json({ error: "Provider not found" }, { status: 404 });
}
