import os from "node:os";
import type { DiscoveryProfile, JobStage, ResourceEvent } from "@/lib/types";
import { recordResourceEvent } from "./store";

const DEFAULT_MIN_AVAILABLE_MEMORY_MB = 512;

const STAGE_MEMORY_BUDGET: Record<
  JobStage,
  { estimatedMbPerItem: number; maxBatchSize: number }
> = {
  collect: { estimatedMbPerItem: 32, maxBatchSize: 4 },
  profile: { estimatedMbPerItem: 24, maxBatchSize: 64 },
  document: { estimatedMbPerItem: 64, maxBatchSize: 16 },
  embed: { estimatedMbPerItem: 96, maxBatchSize: 8 },
  llm: { estimatedMbPerItem: 128, maxBatchSize: 4 },
  rank: { estimatedMbPerItem: 32, maxBatchSize: 32 },
  sync: { estimatedMbPerItem: 48, maxBatchSize: 16 },
};

export interface ResourceDecision {
  status: ResourceEvent["status"];
  batchSize: number;
  availableMb: number;
  rssMb: number;
  heapUsedMb: number;
  totalMb: number;
  reason: string;
}

export function evaluateResourcePolicy(
  profile: DiscoveryProfile,
  stage: JobStage,
): ResourceDecision {
  const memoryUsage = process.memoryUsage();
  const totalMb = bytesToMb(os.totalmem());
  const availableMb = bytesToMb(os.freemem());
  const rssMb = bytesToMb(memoryUsage.rss);
  const heapUsedMb = bytesToMb(memoryUsage.heapUsed);
  const minAvailableMb = resolveMinAvailableMemoryMb(profile);

  if (availableMb <= minAvailableMb) {
    return {
      status: "paused_by_memory",
      batchSize: 0,
      availableMb,
      rssMb,
      heapUsedMb,
      totalMb,
      reason: `可用内存 ${availableMb}MB 不高于最低要求 ${minAvailableMb}MB，暂停 ${stage} 阶段；内存恢复后将自动继续。`,
    };
  }

  const batchSize = calculateDynamicBatchSize(
    availableMb,
    minAvailableMb,
    stage,
  );
  const maxBatchSize = STAGE_MEMORY_BUDGET[stage].maxBatchSize;
  const throttled = batchSize < maxBatchSize;

  return {
    status: throttled ? "throttled" : "running",
    batchSize,
    availableMb,
    rssMb,
    heapUsedMb,
    totalMb,
    reason: throttled
      ? `当前可用内存 ${availableMb}MB，${stage} 阶段动态批量为 ${batchSize}。`
      : `当前可用内存 ${availableMb}MB，${stage} 阶段按最大内部批量 ${batchSize} 运行。`,
  };
}

export function calculateDynamicBatchSize(
  availableMb: number,
  minAvailableMb: number,
  stage: JobStage,
) {
  if (availableMb <= minAvailableMb) {
    return 0;
  }

  const budget = STAGE_MEMORY_BUDGET[stage];
  const headroomMb = availableMb - minAvailableMb;
  return Math.max(
    1,
    Math.min(
      budget.maxBatchSize,
      Math.floor(headroomMb / budget.estimatedMbPerItem),
    ),
  );
}

export async function recordResourceDecision(
  jobId: string,
  stage: JobStage,
  decision: ResourceDecision,
) {
  return recordResourceEvent({
    jobId,
    stage,
    status: decision.status,
    availableMb: decision.availableMb,
    rssMb: decision.rssMb,
    heapUsedMb: decision.heapUsedMb,
    totalMb: decision.totalMb,
    batchSize: decision.batchSize,
    reason: decision.reason,
  });
}

function resolveMinAvailableMemoryMb(profile: DiscoveryProfile) {
  const configured = profile.config.resourcePolicy.minAvailableMemoryMb;
  if (configured && Number.isFinite(configured) && configured > 0) {
    return Math.round(configured);
  }

  const legacy = profile.config.resourcePolicy.memory?.minAvailableMb;
  if (legacy && Number.isFinite(legacy) && legacy > 0) {
    return Math.round(legacy);
  }

  return DEFAULT_MIN_AVAILABLE_MEMORY_MB;
}

function bytesToMb(value: number) {
  return Math.round(value / 1024 / 1024);
}
