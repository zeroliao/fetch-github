import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { resumeScanJob } from "@/server/scanRunner";
import { getScanJob, requeueRunningCandidates, updateScanJob } from "@/server/store";

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

  await requeueRunningCandidates(id);
  await updateScanJob(id, {
    status: "running",
    stage: existing.stage,
    statusReason: undefined,
    errorMessage: undefined,
    finishedAt: undefined
  });

  const job = await resumeScanJob({
    jobId: id,
    maxPages: 1,
    maxProfileBatches: 1
  });

  return NextResponse.json(job ?? existing);
}
