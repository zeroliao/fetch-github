import { NextResponse } from "next/server";
import { getScanJob } from "@/server/store";

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
