import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { updateRecommendationTags } from "@/server/store";

const tagsSchema = z.object({
  tags: z.array(z.string()).max(20)
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const parsed = tagsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  const recommendation = await updateRecommendationTags(id, parsed.data.tags);
  if (!recommendation) {
    return NextResponse.json({ error: "推荐项目不存在。" }, { status: 404 });
  }

  return NextResponse.json(recommendation);
}
