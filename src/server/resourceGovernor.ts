import os from "node:os";
import type { DiscoveryProfile, JobStage, ResourceEvent } from "@/lib/types";
import { recordResourceEvent } from "./store";

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
  stage: JobStage
): ResourceDecision {
  const memoryUsage = process.memoryUsage();
  const totalMb = bytesToMb(os.totalmem());
  const availableMb = bytesToMb(os.freemem());
  const rssMb = bytesToMb(memoryUsage.rss);
  const heapUsedMb = bytesToMb(memoryUsage.heapUsed);
  const configuredBatch = profile.config.resourcePolicy.execution.batchSize;
  const { memory, execution, mode } = profile.config.resourcePolicy;

  if (execution.pauseOnPressure && availableMb <= memory.criticalAvailableMb) {
    return {
      status: "paused_by_memory",
      batchSize: 0,
      availableMb,
      rssMb,
      heapUsedMb,
      totalMb,
      reason: `可用内存 ${availableMb}MB 低于 critical ${memory.criticalAvailableMb}MB，暂停 ${stage} 阶段。`
    };
  }

  if (availableMb <= memory.minAvailableMb) {
    return {
      status: "throttled",
      batchSize: Math.max(1, Math.floor(configuredBatch / 4)),
      availableMb,
      rssMb,
      heapUsedMb,
      totalMb,
      reason: `可用内存 ${availableMb}MB 低于 min ${memory.minAvailableMb}MB，降低批量处理速度。`
    };
  }

  if (availableMb <= memory.targetAvailableMb || mode === "complete_low_memory") {
    return {
      status: availableMb <= memory.targetAvailableMb ? "throttled" : "running",
      batchSize: Math.max(1, Math.floor(configuredBatch / 2)),
      availableMb,
      rssMb,
      heapUsedMb,
      totalMb,
      reason:
        availableMb <= memory.targetAvailableMb
          ? `可用内存 ${availableMb}MB 低于 target ${memory.targetAvailableMb}MB，使用小批量。`
          : "complete_low_memory 模式使用小批量。"
    };
  }

  return {
    status: "running",
    batchSize: configuredBatch,
    availableMb,
    rssMb,
    heapUsedMb,
    totalMb,
    reason: "资源状态正常。"
  };
}

export async function recordResourceDecision(
  jobId: string,
  stage: JobStage,
  decision: ResourceDecision
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
    reason: decision.reason
  });
}

function bytesToMb(value: number) {
  return Math.round(value / 1024 / 1024);
}
