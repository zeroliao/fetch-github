import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, updateAdminPassword, verifyAdminPassword } from "@/server/auth";

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128)
});

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const parsed = passwordSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "新密码至少需要 8 位。", errors: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const valid = await verifyAdminPassword(parsed.data.currentPassword);
  if (!valid) {
    return NextResponse.json({ error: "当前密码不正确。" }, { status: 401 });
  }

  await updateAdminPassword(parsed.data.newPassword);
  return NextResponse.json({ ok: true });
}
