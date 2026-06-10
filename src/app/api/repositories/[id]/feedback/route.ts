import { NextResponse } from "next/server";
import { feedbackSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { recordFeedback, rebuildRecommendationScores } from "@/server/store";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const parsed = feedbackSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  const feedback = await recordFeedback(
    id,
    parsed.data.profileId,
    parsed.data.action,
    parsed.data.note
  );
  await rebuildRecommendationScores(parsed.data.profileId);

  return NextResponse.json(feedback, { status: 201 });
}
