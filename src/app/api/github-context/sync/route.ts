import { NextResponse } from "next/server";
import { z } from "zod";
import { syncGitHubContext } from "@/server/githubSync";

const syncSchema = z.object({
  includeOwned: z.boolean().optional(),
  includeStarred: z.boolean().optional()
});

export async function POST(request: Request) {
  const parsed = syncSchema.safeParse(await request.json().catch(() => ({})));

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await syncGitHubContext(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      message.includes("GITHUB_TOKEN") || message.includes("401")
        ? 401
        : message.includes("403")
          ? 403
          : 500;
    return NextResponse.json({ error: normalizeGitHubSyncError(message) }, { status });
  }
}

function normalizeGitHubSyncError(message: string) {
  if (message.includes("401")) {
    return "GitHub Token 无效，请检查 .env.local 中的 GITHUB_TOKEN。";
  }
  if (message.includes("403")) {
    return "GitHub API 权限不足或触发限流，请检查 token scope 或稍后重试。";
  }

  return message;
}
