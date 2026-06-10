import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { writeLocalEnvValue } from "@/server/envFile";

const tokenSchema = z.object({
  token: z.string().min(1)
});

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const parsed = tokenSchema.safeParse(await request.json().catch(() => ({})));

  if (!parsed.success) {
    return NextResponse.json({ error: "请填写 GitHub Token。" }, { status: 400 });
  }

  await writeLocalEnvValue("GITHUB_TOKEN", parsed.data.token);
  return NextResponse.json({ saved: true, tokenRef: "GITHUB_TOKEN" });
}
