import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { listProfiles } from "@/server/store";
import {
  buildDiscoveryPreview,
  generateDiscoveryPreferences
} from "@/server/naturalLanguageDiscovery";

const requestSchema = z.object({
  prompt: z.string().min(4),
  mode: z.enum(["merge", "replace"]).default("merge")
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const profile = (await listProfiles()).find((item) => item.id === id);
  if (!profile) {
    return NextResponse.json({ error: "发现配置不存在。" }, { status: 404 });
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  const generated = await generateDiscoveryPreferences({
    prompt: parsed.data.prompt,
    profile
  });
  const preview = buildDiscoveryPreview({
    profile,
    generated,
    mode: parsed.data.mode
  });

  return NextResponse.json({
    generated,
    preview,
    mode: parsed.data.mode
  });
}
