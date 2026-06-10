import { NextResponse } from "next/server";
import { z } from "zod";
import { loginAdmin, setSessionCookie } from "@/server/auth";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export async function POST(request: Request) {
  const parsed = loginSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid login request." }, { status: 400 });
  }

  const result = await loginAdmin(parsed.data.username, parsed.data.password);
  if (!result.ok) {
    const status = result.reason === "auth_not_configured" ? 503 : 401;
    return NextResponse.json({ error: result.reason }, { status });
  }

  const response = NextResponse.json({ ok: true });
  setSessionCookie(response, result.session);
  return response;
}
