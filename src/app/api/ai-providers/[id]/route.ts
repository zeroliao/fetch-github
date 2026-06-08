import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteAiProvider, updateAiProvider } from "@/server/store";

const patchSchema = z.object({
  enabled: z.boolean().optional()
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const parsed = patchSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  const result = await updateAiProvider(id, parsed.data);
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
  const { id } = await context.params;
  const result = await deleteAiProvider(id);

  if (!result.deleted) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  return NextResponse.json({ deleted: true });
}
