import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getMarkFile } from "@/server/markStore";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "文件 ID 无效。" }, { status: 400 });
  }
  const file = await getMarkFile(auth.user.id, id);
  if (!file)
    return NextResponse.json({ error: "文件不存在。" }, { status: 404 });
  return NextResponse.json(file);
}
