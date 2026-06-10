import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { runScanJob } from "@/server/scanRunner";
import {
  createScanJob,
  findActiveScanJobByProfile,
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
  await updateScanJob(job.id, {
    status: "running",
    stage: "collect",
    startedAt: new Date().toISOString()
  });

  try {
    const startedJob = await runScanJob({
      jobId: job.id,
      maxPages: 1,
      maxProfileBatches: 1
    });

    return NextResponse.json(startedJob ?? job, { status: 201 });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = normalizeScanError(rawMessage);
    const isRateLimit = message.toLowerCase().includes("rate limit");
    const failedJob = await updateScanJob(job.id, {
      status: isRateLimit ? "retry_later" : "failed",
      errorMessage: message,
      finishedAt: new Date().toISOString()
    });

    return NextResponse.json(failedJob ?? job, { status: isRateLimit ? 429 : 500 });
  }
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

function normalizeScanError(message: string) {
  if (message.includes("403") && message.toLowerCase().includes("rate limit")) {
    return "GitHub API rate limit exceeded. 请配置 GITHUB_TOKEN 或稍后重试。";
  }
  if (message.includes("401")) {
    return "GitHub token 无效，请检查 .env.local 中的 GITHUB_TOKEN。";
  }

  return message;
}
