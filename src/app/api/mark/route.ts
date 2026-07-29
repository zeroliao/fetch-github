import { NextResponse } from "next/server";
import { markActionSchema } from "@/lib/mark";
import { requireAuth } from "@/server/auth";
import {
  applyMarkAction,
  listMarkWorkspace,
  MarkStoreError,
} from "@/server/markStore";

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  return NextResponse.json(await listMarkWorkspace(auth.user.id));
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const parsed = markActionSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "请求参数无效。" },
      { status: 400 },
    );
  }

  try {
    const result = await applyMarkAction(auth.user.id, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    return markErrorResponse(error);
  }
}

function markErrorResponse(error: unknown) {
  if (error instanceof MarkStoreError) {
    const status =
      error.code === "not_found" ? 404 : error.code === "too_large" ? 413 : 409;
    return NextResponse.json({ error: error.message }, { status });
  }
  console.error("Mark action failed", error);
  return NextResponse.json(
    { error: "操作失败，请稍后重试。" },
    { status: 500 },
  );
}
