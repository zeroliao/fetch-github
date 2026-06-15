import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getAppSettings, updateAppSettings } from "@/server/store";

const settingsPatchSchema = z.object({
  scanEnabled: z.boolean().optional(),
  githubAutoSyncEnabled: z.boolean().optional(),
  githubAutoSyncIntervalHours: z.number().int().min(1).max(24 * 30).optional()
});

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  return NextResponse.json(await getAppSettings());
}

export async function PATCH(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const parsed = settingsPatchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  return NextResponse.json(await updateAppSettings(parsed.data));
}
