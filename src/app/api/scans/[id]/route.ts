import { NextResponse } from "next/server";
import { archiveScanJob, getScanJob } from "@/server/store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const job = await getScanJob(id);

  if (!job) {
    return NextResponse.json({ error: "扫描任务不存在。" }, { status: 404 });
  }

  return NextResponse.json(job);
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const existing = await getScanJob(id);

  if (!existing) {
    return NextResponse.json({ error: "扫描任务不存在。" }, { status: 404 });
  }
  if (!["completed", "failed"].includes(existing.status)) {
    return NextResponse.json(
      { error: "只能归档已完成或失败的扫描任务；运行中的任务请先暂停或等待结束。" },
      { status: 409 }
    );
  }

  const archived = await archiveScanJob(id);
  if (!archived) {
    return NextResponse.json({ error: "扫描任务归档失败。" }, { status: 409 });
  }

  return NextResponse.json(archived);
}
