import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import {
  createScanJob,
  findActiveScanJobByProfile,
  getAppSettings,
  getAiProvider,
  listProfiles,
  listScanJobs,
  updateScanJob
} from "@/server/store";

const scanRequestSchema = z.object({
  profileId: z.string().min(1)
});

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  return NextResponse.json(await listScanJobs());
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;

  const parsed = scanRequestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }

  const settings = await getAppSettings();
  if (!settings.scanEnabled) {
    return NextResponse.json({ error: "全局扫描任务已关闭，当前不会启动扫描任务。" }, { status: 409 });
  }

  const profiles = await listProfiles();
  const profile = profiles.find((item) => item.id === parsed.data.profileId);

  if (!profile) {
    return NextResponse.json({ error: "发现配置不存在。" }, { status: 404 });
  }
  if (!profile.enabled) {
    return NextResponse.json({ error: "发现配置已停用，不能启动扫描。" }, { status: 409 });
  }

  const aiValidation = await validateScanAiProviders(profile.config.ai);
  if (aiValidation) {
    return NextResponse.json({ error: aiValidation }, { status: 409 });
  }

  const activeJob = await findActiveScanJobByProfile(parsed.data.profileId);
  if (activeJob) {
    return NextResponse.json(activeJob, { status: 200 });
  }

  const job = await createScanJob(parsed.data.profileId);
  const queuedJob = await updateScanJob(job.id, {
    status: "running",
    stage: "collect",
    startedAt: new Date().toISOString()
  });

  return NextResponse.json(queuedJob ?? job, { status: 202 });
}

async function validateScanAiProviders(ai: {
  chatProviderId: string;
  embeddingProviderId: string;
}) {
  const [chatProvider, embeddingProvider] = await Promise.all([
    getAiProvider(ai.chatProviderId),
    getAiProvider(ai.embeddingProviderId)
  ]);

  if (!chatProvider || !embeddingProvider) {
    return "发现配置绑定的 AI 配置不存在，请先修改 AI 绑定。";
  }
  if (!chatProvider.enabled || !embeddingProvider.enabled) {
    return "发现配置绑定的 AI 配置已停用，请先启用或更换 AI 配置。";
  }

  return null;
}
