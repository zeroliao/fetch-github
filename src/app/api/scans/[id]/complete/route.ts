import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { completeScanJob, getScanJob } from "@/server/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const existing = await getScanJob(id);
  if (!existing) {
    return NextResponse.json({ error: "扫描任务不存在。" }, { status: 404 });
  }
  if (existing.status === "completed") {
    return NextResponse.json(existing);
  }

  const completed = await completeScanJob(id);
  if (!completed) {
    return NextResponse.json(
      { error: "只有暂停、待重试或运行暂停状态的任务可以手动完成。" },
      { status: 409 }
    );
  }

  return NextResponse.json(completed);
}
