import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { resumeScanJob } from "@/server/scanRunner";
import {
  getAppSettings,
  getScanJob,
  requeueRunningCandidates,
  resolveAiProvider,
  updateScanJob,
} from "@/server/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const settings = await getAppSettings();
  if (!settings.scanEnabled) {
    return NextResponse.json(
      { error: "全局扫描任务已关闭，当前不能恢复扫描任务。" },
      { status: 409 },
    );
  }

  const existing = await getScanJob(id);
  if (!existing) {
    return NextResponse.json({ error: "扫描任务不存在。" }, { status: 404 });
  }
  if (existing.status === "completed") {
    return NextResponse.json(existing);
  }
  if (existing.status === "exception") {
    const requiredKind =
      existing.stage === "embed" || existing.stage === "rank"
        ? "embedding"
        : "chat";
    if (!(await resolveAiProvider(requiredKind))) {
      return NextResponse.json(
        {
          error:
            requiredKind === "chat"
              ? "没有可用的 Chat/LLM 模型。请先检测并恢复模型，再恢复扫描。"
              : "没有可用的 Embedding 模型。请先检测并恢复模型，再恢复扫描。",
        },
        { status: 409 },
      );
    }
  }

  await requeueRunningCandidates(id);
  await updateScanJob(id, {
    status: "running",
    stage: existing.stage,
    statusReason: undefined,
    errorMessage: undefined,
    errorCode: undefined,
    errorResolution: undefined,
    finishedAt: undefined,
  });

  const job = await resumeScanJob({ jobId: id });

  return NextResponse.json(job ?? existing);
}
