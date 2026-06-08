import { NextResponse } from "next/server";
import { requeueRunningCandidates, updateScanJob } from "@/server/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  await requeueRunningCandidates(id);
  const job = await updateScanJob(id, {
    status: "paused_by_user",
    statusReason: "用户手动暂停扫描任务。"
  });

  if (!job) {
    return NextResponse.json({ error: "扫描任务不存在。" }, { status: 404 });
  }

  return NextResponse.json(job);
}
