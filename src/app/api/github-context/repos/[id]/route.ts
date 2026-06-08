import { NextResponse } from "next/server";
import { z } from "zod";
import { updateGithubRepoContext } from "@/server/store";

const patchSchema = z.object({
  selectedForContext: z.boolean()
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

  const repo = await updateGithubRepoContext(id, parsed.data);
  if (!repo) {
    return NextResponse.json({ error: "GitHub 项目不存在。" }, { status: 404 });
  }

  return NextResponse.json(repo);
}
