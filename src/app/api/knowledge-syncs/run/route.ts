import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { runKnowledgeSync } from "@/server/knowledgeSync";

const runSchema = z.object({
  target: z.string().min(1).optional(),
  datasetId: z.string().optional(),
  minScore: z.number().min(0).max(1).optional()
});

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const parsed = runSchema.safeParse(await request.json().catch(() => ({})));

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  const result = await runKnowledgeSync(parsed.data);
  return NextResponse.json(result);
}
