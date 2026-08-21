import { NextResponse } from "next/server";
import { profileSchema } from "@/lib/validation";
import { requireAuth } from "@/server/auth";
import { updateProfile } from "@/server/store";

const patchSchema = profileSchema.partial();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const parsed = patchSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { errors: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const profile = await updateProfile(id, parsed.data);
  if (!profile) {
    return NextResponse.json({ error: "发现配置不存在。" }, { status: 404 });
  }

  return NextResponse.json(profile);
}
